import { randomBytes } from 'node:crypto';
import * as nodeFs from 'node:fs';
import { dirname, join } from 'node:path';

import type { AdaptValue } from './adapt.ts';
import {
  AdaptHost,
  Packet,
  packInvite,
  wireHandlers,
  withScope,
  withScopeAsync,
} from './adapt.ts';

export type InviteMode = 'one_time' | 'public';
export type RelayStatus = 'queued' | 'send_failed';

export interface InboxItem {
  msg_id: number;
  sender_id: string;
  sender_name: string;
  text: string;
  date: string;
  wire_id: string;
}

export interface RoomPacket {
  readonly name: string;
  readonly cid: string;
  mintInvite(mode: InviteMode): Promise<{ blob: string; invite_id: string; reusable: boolean }>;
  revokeInvite(inviteId: string): Promise<{ revoked: boolean }>;
  listInvites(): Array<{ invite_id: string; mode: InviteMode }>;
  listContacts(): Array<{ name: string; container_id: string }>;
  listContactOrigins(): Record<string, { via: string; invite_id: string; at: string }>;
  peekInbox(): InboxItem[];
  consumeInbox(expectedIds: number[]): Promise<{ consumed: number[]; deferred: number[] }>;
  send(contactCid: string, body: string): Promise<{ status: RelayStatus; wire_id?: string }>;
  removeContact(contactCid: string): Promise<{
    status: RelayStatus;
    notified: boolean;
    key_material_retained: true;
  }>;
  sign(canonicalJson: string): Promise<string>;
}

export interface PacketPersistenceOps {
  openSync(path: nodeFs.PathLike, flags: nodeFs.OpenMode, mode?: nodeFs.Mode): number;
  fchmodSync(fd: number, mode: nodeFs.Mode): void;
  writeSync(fd: number, buffer: Uint8Array, offset?: number, length?: number, position?: number | null): number;
  fsyncSync(fd: number): void;
  closeSync(fd: number): void;
  renameSync(oldPath: nodeFs.PathLike, newPath: nodeFs.PathLike): void;
  chmodSync(path: nodeFs.PathLike, mode: nodeFs.Mode): void;
  rmSync(path: nodeFs.PathLike, options?: nodeFs.RmOptions): void;
}

export class PacketPersistenceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PacketPersistenceError';
  }
}

let temporarySequence = 0;

/** Synchronously replace one packet secret/state file at its crash boundary. */
export function atomicWriteFileSync(
  target: string,
  bytes: Uint8Array,
  ops: PacketPersistenceOps = nodeFs,
): void {
  const temp = `${target}.tmp-${process.pid}-${temporarySequence++}`;
  let fileFd: number | undefined;
  let directoryFd: number | undefined;
  try {
    fileFd = ops.openSync(temp, nodeFs.constants.O_CREAT | nodeFs.constants.O_TRUNC | nodeFs.constants.O_WRONLY, 0o600);
    ops.fchmodSync(fileFd, 0o600);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const written = ops.writeSync(fileFd, bytes, offset, bytes.byteLength - offset, null);
      if (written <= 0) throw new Error(`short write while persisting ${target}`);
      offset += written;
    }
    ops.fsyncSync(fileFd);
    ops.closeSync(fileFd);
    fileFd = undefined;
    ops.renameSync(temp, target);
    ops.chmodSync(target, 0o600);
    directoryFd = ops.openSync(dirname(target), nodeFs.constants.O_RDONLY);
    ops.fsyncSync(directoryFd);
    ops.closeSync(directoryFd);
    directoryFd = undefined;
  } catch (error) {
    if (fileFd !== undefined) {
      try { ops.closeSync(fileFd); } catch { /* retain the original failure */ }
    }
    if (directoryFd !== undefined) {
      try { ops.closeSync(directoryFd); } catch { /* retain the original failure */ }
    }
    try { ops.rmSync(temp, { force: true }); } catch { /* best-effort temp cleanup */ }
    throw new PacketPersistenceError(`failed to durably persist ${target}`, { cause: error });
  }
}

export interface PacketRegistryOptions {
  fs?: typeof nodeFs;
  persistence?: PacketPersistenceOps;
  log?: (...parts: unknown[]) => void;
  seed?: () => string;
  beforeExpose?: (packet: RoomPacket) => void | Promise<void>;
}

export class PacketRegistry {
  private readonly packets = new Map<string, HostedRoomPacket>();
  private readonly host: AdaptHost;
  private readonly stateDir: string;
  private readonly fs: typeof nodeFs;
  private readonly persistence: PacketPersistenceOps;
  private readonly log: (...parts: unknown[]) => void;
  private readonly seed: () => string;
  private readonly beforeExpose: (packet: RoomPacket) => void | Promise<void>;

  constructor(
    host: AdaptHost,
    stateDir: string,
    options: PacketRegistryOptions = {},
  ) {
    this.host = host;
    this.stateDir = stateDir;
    this.fs = options.fs ?? nodeFs;
    this.persistence = options.persistence ?? this.fs;
    this.log = options.log ?? (() => {});
    this.seed = options.seed ?? (() => randomBytes(24).toString('hex'));
    this.beforeExpose = options.beforeExpose ?? (() => {});
  }

  get size(): number {
    return this.packets.size;
  }

  get(roomId: string): RoomPacket | undefined {
    return this.packets.get(roomId);
  }

  async create(
    roomId: string,
    identityName = `cowork-room-${roomId}`,
    bio = `ours-cowork mission room ${roomId}`,
  ): Promise<RoomPacket> {
    validateRoomId(roomId);
    if (this.packets.has(roomId)) throw new Error(`room packet "${roomId}" is already hosted`);
    const liveDir = this.liveDir(roomId);
    if (this.fs.existsSync(liveDir)) throw new Error(`live packet state for room "${roomId}" already exists`);
    this.fs.mkdirSync(liveDir, { recursive: true, mode: 0o700 });
    this.fs.chmodSync(liveDir, 0o700);

    let native: Packet | undefined;
    try {
      native = await this.host.createPacket(this.packetName(roomId), this.seed());
      const room = new HostedRoomPacket(native, () => this.saveState(native!, liveDir), this.log);
      atomicWriteFileSync(this.identityPath(roomId), Buffer.from(exportSigningSecret(native), 'utf8'), this.persistence);
      this.saveState(native, liveDir);
      this.packets.set(roomId, room);
      await room.setIdentity(identityName, bio);
      return room;
    } catch (error) {
      if (native) {
        try { this.host.removePacket(native.cid); } catch { /* original error is authoritative */ }
      }
      this.packets.delete(roomId);
      try { this.fs.rmSync(liveDir, { recursive: true, force: true }); } catch { /* report the create failure */ }
      throw error;
    }
  }

  async restore(roomId: string, expectedCid?: string): Promise<RoomPacket> {
    validateRoomId(roomId);
    if (this.packets.has(roomId)) throw new Error(`room packet "${roomId}" is already hosted`);
    const liveDir = this.liveDir(roomId);
    const secret = this.fs.readFileSync(this.identityPath(roomId), 'utf8').trim();
    if (!/^[0-9a-f]+$/i.test(secret) || secret.length % 2 !== 0) {
      throw new Error(`invalid signing secret for room "${roomId}"`);
    }
    const stateBytes = this.fs.readFileSync(this.statePath(roomId));
    if (stateBytes.length === 0) throw new Error(`empty packet state for room "${roomId}"`);

    // Restore-before-exposure is an SDK 0.10.12 native facility: while this
    // packet is quarantined it has no local routing and no broker registration.
    // Early traffic therefore cannot execute against fresh packet state. Relay
    // retention is broker policy (the local 0.10.12 test broker drops it), so the
    // host makes no delivery claim for traffic sent while the CID is offline.
    const native = await this.host.createPacket(
      this.packetName(roomId),
      this.seed(),
      secret,
      { deferredExposure: true },
    );
    if (expectedCid !== undefined && native.cid !== expectedCid) {
      try { this.host.removePacket(native.cid); } catch { /* CID mismatch is authoritative */ }
      throw new Error(
        `restored room packet CID mismatch for "${roomId}": expected "${expectedCid}", found "${native.cid}"`,
      );
    }
    const room = new HostedRoomPacket(native, () => this.saveState(native, liveDir), this.log);
    try {
      await withScopeAsync(async (lifetime) => {
        const state = native.pw.packet.ParseValue(new Uint8Array(stateBytes)).Attach(lifetime);
        await native.mutatingTx('::actor::import_state', state, lifetime);
      });
      native.pw.refresh_identity_proof_document();
      await this.beforeExpose(room);
      this.host.exposePacket(native.cid);
      this.packets.set(roomId, room);
      return room;
    } catch (error) {
      try { this.host.removePacket(native.cid); } catch { /* original restore error is authoritative */ }
      throw error;
    }
  }

  async destroy(roomId: string): Promise<string[]> {
    validateRoomId(roomId);
    const room = this.packets.get(roomId);
    if (!room) throw new Error(`room packet "${roomId}" is not hosted`);
    this.host.removePacket(room.cid);
    this.packets.delete(roomId);
    const liveDir = this.liveDir(roomId);
    try {
      this.fs.rmSync(liveDir, { recursive: true, force: true });
    } catch (error) {
      this.log(`[${room.name}] live-state removal failed:`, error);
    }
    return this.residue(roomId);
  }

  private saveState(packet: Packet, liveDir: string): void {
    try {
      const bytes = withScope((lifetime) =>
        Buffer.from(packet.readonlyTx('::actor::export_state', lifetime).Serialize()));
      atomicWriteFileSync(join(liveDir, 'state_data.bin'), bytes, this.persistence);
    } catch (error) {
      if (error instanceof PacketPersistenceError) throw error;
      throw new PacketPersistenceError(`failed to export state for packet "${packet.name}"`, { cause: error });
    }
  }

  private residue(roomId: string): string[] {
    const candidates = [this.identityPath(roomId), this.statePath(roomId), this.liveDir(roomId)];
    return candidates.filter((path) => this.fs.existsSync(path));
  }

  private packetName(roomId: string): string { return `cowork-room-${roomId}`; }
  private liveDir(roomId: string): string { return join(this.stateDir, 'rooms', roomId, 'live'); }
  private identityPath(roomId: string): string { return join(this.liveDir(roomId), 'identity.key'); }
  private statePath(roomId: string): string { return join(this.liveDir(roomId), 'state_data.bin'); }
}

class HostedRoomPacket implements RoomPacket {
  readonly name: string;
  readonly cid: string;
  private readonly packet: Packet;

  constructor(
    packet: Packet,
    saveState: () => void,
    log: (...parts: unknown[]) => void,
  ) {
    this.packet = packet;
    this.name = packet.name;
    this.cid = packet.cid;
    wireHandlers(packet, { onSaveState: saveState, onNotify: () => {} }, log);
  }

  async setIdentity(identityName: string, bio: string): Promise<void> {
    await withScopeAsync((lifetime) =>
      this.packet.mutatingTx('::a2a_messaging::set_my_name', { name: identityName }, lifetime));
    await withScopeAsync((lifetime) =>
      this.packet.mutatingTx('::a2a_messaging::set_my_bio', { bio }, lifetime));
  }

  async mintInvite(mode: InviteMode): Promise<{ blob: string; invite_id: string; reusable: boolean }> {
    return withScopeAsync(async (lifetime) => {
      const result = await this.packet.mutatingTx('::a2a_messaging::generate_invite', { mode }, lifetime);
      return {
        blob: packInvite(Buffer.from(result.Reduce('invite').GetBinary())),
        invite_id: result.Reduce('invite_id').Visualize(),
        reusable: booleanValue(result.Reduce('reusable')),
      };
    });
  }

  async revokeInvite(inviteId: string): Promise<{ revoked: boolean }> {
    return withScopeAsync(async (lifetime) => {
      const result = await this.packet.mutatingTx('::a2a_messaging::revoke_invite', { invite_id: inviteId }, lifetime);
      return { revoked: booleanValue(result.Reduce('revoked')) };
    });
  }

  listInvites(): Array<{ invite_id: string; mode: InviteMode }> {
    return withScope((lifetime) => {
      const value = this.packet.readonlyTx('::a2a_messaging::list_invites', lifetime);
      return dictionaryEntries(value).map(([inviteId, invite]) => ({
        invite_id: inviteId,
        mode: inviteMode(invite.Reduce('mode').Visualize()),
      }));
    });
  }

  listContacts(): Array<{ name: string; container_id: string }> {
    return withScope((lifetime) => {
      const value = this.packet.readonlyTx('::a2a_messaging::list_contacts', lifetime);
      return dictionaryEntries(value).map(([, contact]) => ({
        name: contact.Reduce('name').Visualize(),
        container_id: contact.Reduce('container_id').Visualize(),
      }));
    });
  }

  listContactOrigins(): Record<string, { via: string; invite_id: string; at: string }> {
    return withScope((lifetime) => {
      const value = this.packet.readonlyTx('::a2a_messaging::list_contact_origins', lifetime);
      return Object.fromEntries(dictionaryEntries(value).map(([cid, origin]) => [cid, {
        via: origin.Reduce('via').Visualize(),
        invite_id: nilString(origin.Reduce('invite_id')),
        at: origin.Reduce('at').Visualize(),
      }]));
    });
  }

  peekInbox(): InboxItem[] {
    return withScope((lifetime) => renderInbox(this.packet.readonlyTx('::actor::list_incoming_messages', lifetime))
      .filter((message) => message.status === 'unread')
      .map(({ status: _status, ...message }) => message));
  }

  async consumeInbox(expectedIds: number[]): Promise<{ consumed: number[]; deferred: number[] }> {
    const expected = new Set(expectedIds);
    const drained = await withScopeAsync(async (lifetime) => {
      const result = await this.packet.mutatingTx('::actor::get_messages', {}, lifetime);
      return renderInbox(result.Reduce('messages'));
    });
    const consumed = drained.filter((message) => expected.has(message.msg_id)).map((message) => message.msg_id);
    const deferred = drained.filter((message) => !expected.has(message.msg_id)).map((message) => message.msg_id);
    if (deferred.length > 0) {
      await withScopeAsync((lifetime) =>
        this.packet.mutatingTx('::actor::defer_messages', { msg_ids: deferred }, lifetime));
    }
    return { consumed, deferred };
  }

  async send(contactCid: string, body: string): Promise<{ status: RelayStatus; wire_id?: string }> {
    try {
      return await withScopeAsync(async (lifetime) => {
        const result = await this.packet.mutatingTx(
          '::a2a_messaging::send_message',
          { contact: contactCid, text: body },
          lifetime,
        );
        const refused = !result.Reduce('downgrade_refused').IsNil();
        return refused
          ? { status: 'send_failed' as const }
          : { status: 'queued' as const, wire_id: nilString(result.Reduce('wire_id')) || undefined };
      });
    } catch (error) {
      if (error instanceof PacketPersistenceError) throw error;
      return { status: 'send_failed' };
    }
  }

  async removeContact(contactCid: string): Promise<{
    status: RelayStatus;
    notified: boolean;
    key_material_retained: true;
  }> {
    try {
      return await withScopeAsync(async (lifetime) => {
        const result = await this.packet.mutatingTx(
          '::a2a_messaging::remove_contact',
          { contact: contactCid },
          lifetime,
        );
        return {
          status: 'queued' as const,
          notified: booleanValue(result.Reduce('notified')),
          key_material_retained: true as const,
        };
      });
    } catch (error) {
      if (error instanceof PacketPersistenceError) throw error;
      return { status: 'send_failed', notified: false, key_material_retained: true };
    }
  }

  async sign(canonicalJson: string): Promise<string> {
    return withScopeAsync(async (lifetime) => {
      const result = await this.packet.mutatingTx(
        '::actor::sign_app_envelope',
        { canonical_json: canonicalJson },
        lifetime,
      );
      return Buffer.from(result.Reduce('signature').GetBinary()).toString('base64url');
    });
  }
}

type RenderedInbox = InboxItem & { status: string };

function renderInbox(value: AdaptValue): RenderedInbox[] {
  const output: RenderedInbox[] = [];
  if (value.IsNil()) return output;
  for (let index = 0; ; index += 1) {
    const message = value.Reduce(index);
    if (message.IsNil()) break;
    output.push({
      msg_id: Number(message.Reduce('msg_id').Visualize()),
      sender_id: message.Reduce('sender_id').Visualize(),
      sender_name: message.Reduce('sender_name').Visualize(),
      text: message.Reduce('text').Visualize(),
      date: message.Reduce('date').Visualize(),
      status: message.Reduce('status').Visualize(),
      wire_id: message.Reduce('wire_id').Visualize(),
    });
  }
  return output;
}

function dictionaryEntries(value: AdaptValue): Array<[string, AdaptValue]> {
  if (value.IsNil()) return [];
  return value.GetKeys().map((key) => [key.Visualize(), value.Reduce(key)]);
}

function booleanValue(value: AdaptValue): boolean {
  if (value.IsNil()) return false;
  try { return value.GetBoolean(); } catch { return /true/i.test(value.Visualize()); }
}

function nilString(value: AdaptValue): string {
  return value.IsNil() ? '' : value.Visualize();
}

function inviteMode(value: string): InviteMode {
  const normalized = value.replace(/^\$/, '');
  if (normalized === 'one_time' || normalized === 'public') return normalized;
  throw new Error(`unexpected invite mode: ${value}`);
}

function exportSigningSecret(packet: Packet): string {
  return withScope((lifetime) =>
    Buffer.from(packet.readonlyTx('::actor::export_signing_secret', lifetime).Serialize()).toString('hex'));
}

function validateRoomId(roomId: string): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(roomId)) throw new Error(`invalid room id: ${roomId}`);
}
