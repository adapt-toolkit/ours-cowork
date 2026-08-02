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
  onNotify?: (roomId: string, event: string) => void;
  provisioningCheckpoint?: (stage: 'mkdir' | 'identity' | 'state' | 'identity_applied') => void;
  stagingName?: () => string;
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
  private readonly onNotify: (roomId: string, event: string) => void;
  private readonly provisioningCheckpoint: NonNullable<PacketRegistryOptions['provisioningCheckpoint']>;
  private readonly stagingName: () => string;

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
    this.onNotify = options.onNotify ?? (() => {});
    this.provisioningCheckpoint = options.provisioningCheckpoint ?? (() => {});
    this.stagingName = options.stagingName ?? (() => `live.staging-${randomBytes(16).toString('hex')}`);
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
    if (this.hasRestorableState(roomId)) {
      try {
        return await this.restore(roomId, undefined, identityName, bio);
      } catch (error) {
        this.log(`[${this.packetName(roomId)}] pending packet restore failed; reprovisioning:`, error);
      }
    }
    this.prepareProvisioningDirectory(roomId);

    let native: Packet | undefined;
    try {
      native = await this.host.createPacket(this.packetName(roomId), this.seed());
      let room!: HostedRoomPacket;
      room = new HostedRoomPacket(
        native,
        () => this.saveState(native!, liveDir),
        this.log,
        (event) => this.onNotify(roomId, event),
        () => { if (this.packets.get(roomId) === room) this.packets.delete(roomId); },
      );
      atomicWriteFileSync(this.identityPath(roomId), Buffer.from(exportSigningSecret(native), 'utf8'), this.persistence);
      this.provisioningCheckpoint('identity');
      this.saveState(native, liveDir);
      this.provisioningCheckpoint('state');
      this.packets.set(roomId, room);
      await room.setIdentity(identityName, bio);
      this.provisioningCheckpoint('identity_applied');
      return room;
    } catch (error) {
      if (native) {
        try { this.host.removePacket(native.cid); } catch { /* original error is authoritative */ }
      }
      this.packets.delete(roomId);
      // Preserve the durable provisioning boundary. A restart can restore a
      // complete packet, or safely replace an explicitly cowork-owned partial.
      throw error;
    }
  }

  async restore(
    roomId: string,
    expectedCid?: string,
    identityName?: string,
    bio?: string,
  ): Promise<RoomPacket> {
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
    let room!: HostedRoomPacket;
    room = new HostedRoomPacket(
      native,
      () => this.saveState(native, liveDir),
      this.log,
      (event) => this.onNotify(roomId, event),
      () => { if (this.packets.get(roomId) === room) this.packets.delete(roomId); },
    );
    try {
      await withScopeAsync(async (lifetime) => {
        const state = native.pw.packet.ParseValue(new Uint8Array(stateBytes)).Attach(lifetime);
        await native.mutatingTx('::actor::import_state', state, lifetime);
      });
      native.pw.refresh_identity_proof_document();
      if (identityName !== undefined && bio !== undefined) {
        await room.setIdentity(identityName, bio);
        this.provisioningCheckpoint('identity_applied');
      }
      atomicWriteFileSync(
        this.ownershipPath(roomId),
        Buffer.from(`${roomId}\n`, 'utf8'),
        this.persistence,
      );
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
    if (room) {
      this.host.removePacket(room.cid);
      this.packets.delete(roomId);
    }
    const liveDir = this.liveDir(roomId);
    let removalFailure: unknown;
    try {
      this.assertSafeRoomDirectory(roomId);
      this.fs.rmSync(liveDir, { recursive: true, force: true });
      this.fsyncDirectory(this.roomDir(roomId));
    } catch (error) {
      this.log(`[${room?.name ?? this.packetName(roomId)}] live-state removal failed:`, error);
      removalFailure = error;
    }
    const residue = this.residue(roomId);
    if (removalFailure !== undefined && residue.length === 0) {
      throw new PacketPersistenceError(
        `live-state removal durability is uncertain for room "${roomId}"`,
        { cause: removalFailure },
      );
    }
    return residue;
  }

  /** Unhost runtime packets while retaining every byte required for restart. */
  async unhostAll(): Promise<void> {
    const errors: unknown[] = [];
    for (const [roomId, room] of [...this.packets]) {
      try {
        this.host.removePacket(room.cid, new Error('cowork daemon is shutting down'));
        this.packets.delete(roomId);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, 'failed to unhost room packets');
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
    const liveDir = this.liveDir(roomId);
    try {
      this.fs.lstatSync(liveDir);
      return [liveDir];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  private packetName(roomId: string): string { return `cowork-room-${roomId}`; }
  private roomDir(roomId: string): string { return join(this.stateDir, 'rooms', roomId); }
  private liveDir(roomId: string): string { return join(this.roomDir(roomId), 'live'); }
  private identityPath(roomId: string): string { return join(this.liveDir(roomId), 'identity.key'); }
  private statePath(roomId: string): string { return join(this.liveDir(roomId), 'state_data.bin'); }
  private ownershipPath(roomId: string): string { return join(this.liveDir(roomId), '.cowork-provisioning-v1'); }
  private stagingJournalPath(roomId: string): string { return join(this.roomDir(roomId), '.cowork-provisioning-stage'); }
  private residuePath(roomId: string): string { return join(this.roomDir(roomId), 'provisioning-residue'); }

  private hasRestorableState(roomId: string): boolean {
    try {
      const secret = this.fs.readFileSync(this.identityPath(roomId), 'utf8').trim();
      return /^[0-9a-f]+$/i.test(secret)
        && secret.length % 2 === 0
        && this.fs.readFileSync(this.statePath(roomId)).length > 0;
    } catch {
      return false;
    }
  }

  private prepareProvisioningDirectory(roomId: string): void {
    const roomDir = this.roomDir(roomId);
    const liveDir = this.liveDir(roomId);
    if (!this.fs.existsSync(roomDir)) {
      this.fs.mkdirSync(roomDir, { recursive: true, mode: 0o700 });
      this.fs.chmodSync(roomDir, 0o700);
    }
    if (this.fs.existsSync(liveDir)) {
      let owned = false;
      try { owned = this.fs.readFileSync(this.ownershipPath(roomId), 'utf8') === `${roomId}\n`; } catch { /* uncertain */ }
      if (owned) {
        this.assertSafeRoomDirectory(roomId);
        this.fs.rmSync(liveDir, { recursive: true, force: true });
        this.fsyncDirectory(roomDir);
      } else {
        this.assertSafeRoomDirectory(roomId);
        const residue = this.residuePath(roomId);
        if (this.fs.existsSync(residue)) {
          throw new PacketPersistenceError(
            `room "${roomId}" has unknown live state and an existing provisioning residue; inspect both before retrying`,
          );
        }
        this.fs.renameSync(liveDir, residue);
        this.fs.chmodSync(residue, 0o700);
        this.fsyncDirectory(roomDir);
      }
    }
    this.cleanupOwnedStaging(roomId);
    const stagingName = this.stagingName();
    if (!/^live\.staging-[0-9a-f]{32}$/.test(stagingName)) {
      throw new PacketPersistenceError(`invalid provisioning staging name for room "${roomId}"`);
    }
    this.createStagingJournal(roomId, stagingName);
    const stagingDir = join(roomDir, stagingName);
    try {
      this.fs.mkdirSync(stagingDir, { recursive: false, mode: 0o700 });
    } catch (error) {
      // The exclusive journal belongs to this exact attempt. The colliding
      // path does not, so remove only the journal and leave the path untouched.
      try {
        this.fs.unlinkSync(this.stagingJournalPath(roomId));
        this.fsyncDirectory(roomDir);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], `provisioning staging collision cleanup failed for room "${roomId}"`);
      }
      throw new PacketPersistenceError(`provisioning staging collision for room "${roomId}"`, { cause: error });
    }
    this.fs.chmodSync(stagingDir, 0o700);
    atomicWriteFileSync(
      join(stagingDir, '.cowork-provisioning-v1'),
      Buffer.from(`${roomId}\n`, 'utf8'),
      this.persistence,
    );
    this.provisioningCheckpoint('mkdir');
    this.fs.renameSync(stagingDir, liveDir);
    this.fsyncDirectory(roomDir);
    this.fs.unlinkSync(this.stagingJournalPath(roomId));
    this.fsyncDirectory(roomDir);
  }

  private cleanupOwnedStaging(roomId: string): void {
    const journal = this.stagingJournalPath(roomId);
    let stagingName: string;
    try { stagingName = this.fs.readFileSync(journal, 'utf8').trim(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (!/^live\.staging-[0-9a-f]{32}$/.test(stagingName)) {
      throw new PacketPersistenceError(`invalid provisioning staging journal for room "${roomId}"`);
    }
    const stagingDir = join(this.roomDir(roomId), stagingName);
    if (this.fs.existsSync(stagingDir)) {
      const stat = this.fs.lstatSync(stagingDir);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new PacketPersistenceError(`unsafe provisioning staging path for room "${roomId}"`);
      }
      let owned = false;
      try {
        owned = this.fs.readFileSync(join(stagingDir, '.cowork-provisioning-v1'), 'utf8') === `${roomId}\n`;
      } catch { /* an unmarked staging path has uncertain ownership */ }
      if (!owned) {
        throw new PacketPersistenceError(
          `provisioning staging journal references an unowned path for room "${roomId}"`,
        );
      }
      this.fs.rmSync(stagingDir, { recursive: true, force: true });
      this.fsyncDirectory(this.roomDir(roomId));
    }
    this.fs.unlinkSync(journal);
    this.fsyncDirectory(this.roomDir(roomId));
  }

  private createStagingJournal(roomId: string, stagingName: string): void {
    const journal = this.stagingJournalPath(roomId);
    const bytes = Buffer.from(`${stagingName}\n`, 'utf8');
    let fd: number | undefined;
    let created = false;
    try {
      fd = this.persistence.openSync(
        journal,
        nodeFs.constants.O_CREAT | nodeFs.constants.O_EXCL | nodeFs.constants.O_WRONLY | (nodeFs.constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      created = true;
      this.persistence.fchmodSync(fd, 0o600);
      let offset = 0;
      while (offset < bytes.byteLength) {
        const written = this.persistence.writeSync(fd, bytes, offset, bytes.byteLength - offset, null);
        if (written <= 0) throw new Error(`short write while persisting ${journal}`);
        offset += written;
      }
      this.persistence.fsyncSync(fd);
      this.persistence.closeSync(fd);
      fd = undefined;
      this.fsyncDirectory(this.roomDir(roomId));
    } catch (error) {
      if (fd !== undefined) {
        try { this.persistence.closeSync(fd); } catch { /* original error is authoritative */ }
      }
      if (created) {
        try {
          this.fs.unlinkSync(journal);
          this.fsyncDirectory(this.roomDir(roomId));
        } catch { /* a partial exclusive journal remains a safe blocking residue */ }
      }
      throw new PacketPersistenceError(`failed to establish staging ownership for room "${roomId}"`, { cause: error });
    }
  }

  private assertSafeRoomDirectory(roomId: string): void {
    const roomDir = this.roomDir(roomId);
    const stat = this.fs.lstatSync(roomDir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`room directory for "${roomId}" is not a safe directory`);
    }
  }

  private fsyncDirectory(path: string): void {
    let fd: number | undefined;
    try {
      fd = this.fs.openSync(path, nodeFs.constants.O_RDONLY | (nodeFs.constants.O_NOFOLLOW ?? 0));
      this.fs.fsyncSync(fd);
    } finally {
      if (fd !== undefined) this.fs.closeSync(fd);
    }
  }
}

export class HostedRoomPacket implements RoomPacket {
  readonly name: string;
  readonly cid: string;
  private readonly packet: Packet;

  constructor(
    packet: Packet,
    saveState: () => void,
    log: (...parts: unknown[]) => void,
    onNotify: (event: string) => void = () => {},
    onTerminal: (error: Error) => void = () => {},
  ) {
    this.packet = packet;
    this.name = packet.name;
    this.cid = packet.cid;
    wireHandlers(packet, { onSaveState: saveState, onNotify: (event) => onNotify(event) }, log);
    packet.onTerminalClose?.(onTerminal);
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
        at: adaptTimeToRfc3339(origin.Reduce('at').Visualize()),
      }]));
    });
  }

  peekInbox(): InboxItem[] {
    return withScope((lifetime) => renderInbox(this.packet.readonlyTx('::actor::list_incoming_messages', lifetime))
      .filter((message) => message.status === 'unread')
      .map(({ status: _status, ...message }) => message));
  }

  async consumeInbox(expectedIds: number[]): Promise<{ consumed: number[]; deferred: number[] }> {
    return withScopeAsync(async (lifetime) => {
      const result = await this.packet.mutatingTx(
        '::actor::consume_messages',
        { expected_ids: expectedIds },
        lifetime,
      );
      return {
        consumed: renderIntegerArray(result.Reduce('consumed')),
        deferred: renderIntegerArray(result.Reduce('deferred')),
      };
    });
  }

  async send(contactCid: string, body: string): Promise<{ status: RelayStatus; wire_id?: string }> {
    return withScopeAsync(async (lifetime) => {
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
  }

  async removeContact(contactCid: string): Promise<{
    status: RelayStatus;
    notified: boolean;
    key_material_retained: true;
  }> {
    return withScopeAsync(async (lifetime) => {
      const result = await this.packet.mutatingTx(
        '::a2a_messaging::remove_contact',
        { contact: contactCid },
        lifetime,
      );
      const notified = strictBooleanValue(result.Reduce('notified'), 'remove_contact notified');
      const keyMaterialRetained = strictBooleanValue(
        result.Reduce('key_material_retained'),
        'remove_contact key_material_retained',
      );
      if (!keyMaterialRetained) {
        throw new Error('remove_contact key_material_retained must be true');
      }
      return {
        status: notified ? 'queued' as const : 'send_failed' as const,
        notified,
        key_material_retained: true as const,
      };
    });
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
      date: adaptTimeToRfc3339(message.Reduce('date').Visualize()),
      status: message.Reduce('status').Visualize(),
      wire_id: message.Reduce('wire_id').Visualize(),
    });
  }
  return output;
}

function renderIntegerArray(value: AdaptValue): number[] {
  const output: number[] = [];
  if (value.IsNil()) return output;
  for (let index = 0; ; index += 1) {
    const item = value.Reduce(index);
    if (item.IsNil()) break;
    output.push(Number(item.Visualize()));
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

function strictBooleanValue(value: AdaptValue, label: string): boolean {
  if (value.IsNil()) throw new Error(`${label} must be a boolean`);
  let decoded: unknown;
  try {
    decoded = value.GetBoolean();
  } catch (error) {
    throw new Error(`${label} must be a boolean`, { cause: error });
  }
  if (typeof decoded !== 'boolean') throw new Error(`${label} must be a boolean`);
  return decoded;
}

function nilString(value: AdaptValue): string {
  return value.IsNil() ? '' : value.Visualize();
}

/** Normalize the SDK's native TIME visualization into the host storage contract. */
export function adaptTimeToRfc3339(value: string): string {
  const rfc3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (rfc3339) {
    const [, year, month, day, hour, minute, second, fraction = '', sign, offsetHour = '0', offsetMinute = '0'] = rfc3339;
    if (sign === '-' && offsetHour === '00' && offsetMinute === '00') return invalidAdaptTime(value);
    return canonicalUtcTime(value, year!, month!, day!, hour!, minute!, second!, fraction, sign, offsetHour, offsetMinute);
  }

  // Native SDK TIME values visualize exactly as documented here: a space
  // separator, optional 1..9 fractional digits, and UTC with an optional
  // unpadded whole-hour offset. RFC-shaped variants are intentionally refused.
  const native = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))? \(UTC(?:([+-])(0|[1-9]|1\d|2[0-3]))?\)$/.exec(value);
  if (!native) return invalidAdaptTime(value);
  const [, year, month, day, hour, minute, second, fraction = '', sign, offsetHour = '0'] = native;
  if (sign === '-' && offsetHour === '0') return invalidAdaptTime(value);
  return canonicalUtcTime(value, year!, month!, day!, hour!, minute!, second!, fraction, sign, offsetHour, '0');
}

function canonicalUtcTime(
  source: string,
  yearText: string,
  monthText: string,
  dayText: string,
  hourText: string,
  minuteText: string,
  secondText: string,
  fraction: string,
  offsetSign: string | undefined,
  offsetHourText: string,
  offsetMinuteText: string,
): string {
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = Number(offsetHourText);
  const offsetMinute = Number(offsetMinuteText);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > monthDays[month - 1]!
    || hour > 23 || minute > 59 || second > 59
    || offsetHour > 23 || offsetMinute > 59) return invalidAdaptTime(source);

  const milliseconds = Number(fraction.slice(0, 3).padEnd(3, '0'));
  const local = new Date(0);
  local.setUTCFullYear(year, month - 1, day);
  local.setUTCHours(hour, minute, second, milliseconds);
  if (local.getUTCFullYear() !== year || local.getUTCMonth() !== month - 1 || local.getUTCDate() !== day
    || local.getUTCHours() !== hour || local.getUTCMinutes() !== minute || local.getUTCSeconds() !== second) {
    return invalidAdaptTime(source);
  }
  const direction = offsetSign === '-' ? -1 : 1;
  const offsetMilliseconds = direction * ((offsetHour * 60) + offsetMinute) * 60_000;
  const canonical = new Date(local.getTime() - offsetMilliseconds).toISOString();
  if (!/^\d{4}-/.test(canonical)) return invalidAdaptTime(source);
  return canonical;
}

function invalidAdaptTime(value: string): never {
  throw new Error(`unexpected ADAPT time visualization: ${value}`);
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
