import { randomBytes } from 'node:crypto';
import * as nodeFs from 'node:fs';
import { dirname, join } from 'node:path';

import {
  AppendRecordSchema,
  CommunicationRecordSchema,
  LowerCrockfordUlidSchema,
  RoomSchema,
  type AppendRecord,
  type CommunicationRecord,
  type Room,
} from './contracts.ts';

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const NO_FOLLOW = nodeFs.constants.O_NOFOLLOW ?? 0;
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

export type CoworkFs = typeof nodeFs;

export interface CoworkStoreOptions {
  fs?: CoworkFs;
}

export interface ArchiveReadOptions {
  after?: number;
  limit?: number;
}

export class CoworkStorageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CoworkStorageError';
  }
}

export class RoomMutex {
  private tail: Promise<void> = Promise.resolve();

  async runExclusive<T>(work: () => T | Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    const turn = new Promise<void>((resolve) => { release = resolve; });
    this.tail = previous.then(() => turn, () => turn);
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }
}

interface ScanResult {
  records: CommunicationRecord[];
  nextSequence: number;
}

export class CoworkStore {
  readonly stateDir: string;
  private readonly fs: CoworkFs;
  // The standalone daemon is the sole writer. This is intentionally an
  // in-process room FIFO, not an on-disk lock with stale-owner recovery.
  private readonly roomMutexes = new Map<string, RoomMutex>();
  private readonly nextSequences = new Map<string, number>();

  constructor(stateDir: string, options: CoworkStoreOptions = {}) {
    if (!stateDir) throw new CoworkStorageError('state directory is required');
    this.stateDir = stateDir;
    this.fs = options.fs ?? nodeFs;
  }

  mutex(roomId: string): RoomMutex;
  mutex<T>(roomId: string, work: () => T | Promise<T>): Promise<T>;
  mutex<T>(roomId: string, work?: () => T | Promise<T>): RoomMutex | Promise<T> {
    const validRoomId = this.roomId(roomId);
    let mutex = this.roomMutexes.get(validRoomId);
    if (!mutex) {
      mutex = new RoomMutex();
      this.roomMutexes.set(validRoomId, mutex);
    }
    return work ? mutex.runExclusive(work) : mutex;
  }

  async create(input: Room): Promise<Room> {
    const room = RoomSchema.parse(input);
    return this.mutex(room.room_id, () => {
      this.ensureBaseDirectories();
      const roomDir = this.roomDirectory(room.room_id);
      if (this.fs.existsSync(roomDir)) {
        this.rejectSymlink(roomDir, 'room directory');
        throw new CoworkStorageError(`room "${room.room_id}" already exists`);
      }

      this.fs.mkdirSync(roomDir, { mode: DIRECTORY_MODE });
      this.fs.chmodSync(roomDir, DIRECTORY_MODE);
      try {
        this.createArchive(room.room_id);
        this.atomicMetadataWrite(this.metadataPath(room.room_id), room);
        this.nextSequences.set(room.room_id, 1);
        return room;
      } catch (error) {
        this.nextSequences.delete(room.room_id);
        try { this.fs.rmSync(roomDir, { recursive: true, force: true }); } catch { /* original failure wins */ }
        throw this.wrap(`failed to create room "${room.room_id}"`, error);
      }
    });
  }

  async load(roomId: string): Promise<Room> {
    const validRoomId = this.roomId(roomId);
    return this.mutex(validRoomId, () => this.loadUnlocked(validRoomId));
  }

  async save(input: Room): Promise<Room> {
    const room = RoomSchema.parse(input);
    return this.mutex(room.room_id, () => {
      this.assertRoomDirectory(room.room_id);
      this.atomicMetadataWrite(this.metadataPath(room.room_id), room);
      return room;
    });
  }

  async list(): Promise<Room[]> {
    this.ensureBaseDirectories();
    const roomIds = this.fs.readdirSync(this.roomsDirectory(), { withFileTypes: true })
      .filter((entry) => LowerCrockfordUlidSchema.safeParse(entry.name).success)
      .map((entry) => entry.name)
      .sort();
    const rooms: Room[] = [];
    for (const roomId of roomIds) rooms.push(await this.load(roomId));
    return rooms;
  }

  async append(roomId: string, input: AppendRecord): Promise<CommunicationRecord> {
    const validRoomId = this.roomId(roomId);
    const draft = AppendRecordSchema.parse(input);
    if (draft.room_id !== validRoomId) {
      throw new CoworkStorageError(`record room_id "${draft.room_id}" does not match room "${validRoomId}"`);
    }

    return this.mutex(validRoomId, () => {
      this.assertRoomDirectory(validRoomId);
      const archivePath = this.archivePath(validRoomId);
      this.assertRegularFile(archivePath, 'room archive');
      let nextSequence = this.nextSequences.get(validRoomId);
      if (nextSequence === undefined) {
        nextSequence = this.scanArchive(validRoomId).nextSequence;
      }
      const record = CommunicationRecordSchema.parse({
        ...draft,
        seq: nextSequence,
        record_id: `${validRoomId}:${nextSequence}`,
      });
      const bytes = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');

      let fd: number | undefined;
      let originalSize = 0;
      try {
        fd = this.fs.openSync(
          archivePath,
          nodeFs.constants.O_WRONLY | nodeFs.constants.O_APPEND | NO_FOLLOW,
        );
        this.fs.fchmodSync(fd, FILE_MODE);
        originalSize = this.fs.fstatSync(fd).size;
        this.writeAll(fd, bytes);
        this.fs.fsyncSync(fd);
        this.nextSequences.set(validRoomId, nextSequence + 1);
        return record;
      } catch (error) {
        this.nextSequences.delete(validRoomId);
        if (fd !== undefined) {
          try {
            this.fs.ftruncateSync(fd, originalSize);
            this.fs.fsyncSync(fd);
          } catch { /* startup validation handles an interrupted rollback */ }
        }
        throw this.wrap(`failed to append room "${validRoomId}" archive`, error);
      } finally {
        if (fd !== undefined) {
          try { this.fs.closeSync(fd); } catch { /* the preceding result is authoritative */ }
        }
      }
    });
  }

  async read(roomId: string, options: ArchiveReadOptions = {}): Promise<CommunicationRecord[]> {
    const validRoomId = this.roomId(roomId);
    const after = options.after ?? 0;
    const limit = options.limit ?? Number.MAX_SAFE_INTEGER;
    if (!Number.isSafeInteger(after) || after < 0) throw new CoworkStorageError('after must be a non-negative safe integer');
    if (!Number.isSafeInteger(limit) || limit < 1) throw new CoworkStorageError('limit must be a positive safe integer');

    return this.mutex(validRoomId, () => {
      this.assertRoomDirectory(validRoomId);
      const scan = this.scanArchive(validRoomId);
      this.nextSequences.set(validRoomId, scan.nextSequence);
      return scan.records.filter((record) => record.seq > after).slice(0, limit);
    });
  }

  async delete(roomId: string): Promise<void> {
    const validRoomId = this.roomId(roomId);
    await this.mutex(validRoomId, () => {
      this.assertRoomDirectory(validRoomId);
      const roomDir = this.roomDirectory(validRoomId);
      const archivePath = this.archivePath(validRoomId);
      const metadataPath = this.metadataPath(validRoomId);
      this.assertRegularFile(archivePath, 'room archive');
      this.assertRegularFile(metadataPath, 'room metadata');
      const expected = new Set(['archive.jsonl', 'room.json']);
      const unexpected = this.fs.readdirSync(roomDir).filter((name) => !expected.has(name));
      if (unexpected.length > 0) {
        throw new CoworkStorageError(`room "${validRoomId}" contains live or unexpected residue: ${unexpected.join(', ')}`);
      }
      this.fs.unlinkSync(archivePath);
      this.fsyncDirectory(roomDir);
      this.fs.unlinkSync(metadataPath);
      this.fsyncDirectory(roomDir);
      this.fs.rmdirSync(roomDir);
      this.fsyncDirectory(this.roomsDirectory());
      this.nextSequences.delete(validRoomId);
    });
  }

  private loadUnlocked(roomId: string): Room {
    this.assertRoomDirectory(roomId);
    const path = this.metadataPath(roomId);
    this.assertRegularFile(path, 'room metadata');
    let bytes: Buffer;
    try {
      bytes = this.readFileNoFollow(path);
    } catch (error) {
      throw this.wrap(`failed to read room "${roomId}" metadata`, error);
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(utf8Decoder.decode(bytes));
    } catch (error) {
      throw this.wrap(`malformed metadata for room "${roomId}"`, error);
    }
    const room = RoomSchema.parse(decoded);
    if (room.room_id !== roomId) throw new CoworkStorageError(`metadata room_id does not match room "${roomId}"`);
    return room;
  }

  private scanArchive(roomId: string): ScanResult {
    const path = this.archivePath(roomId);
    this.assertRegularFile(path, 'room archive');
    let bytes: Buffer;
    try {
      bytes = this.readFileNoFollow(path);
    } catch (error) {
      throw this.wrap(`failed to read room "${roomId}" archive`, error);
    }
    const records: CommunicationRecord[] = [];
    let byteOffset = 0;
    let expectedSequence = 1;
    while (byteOffset < bytes.byteLength) {
      const newline = bytes.indexOf(0x0a, byteOffset);
      if (newline === -1) {
        throw new CoworkStorageError(`partial JSON record in room "${roomId}" archive at byte offset ${byteOffset}`);
      }
      const line = bytes.subarray(byteOffset, newline);
      let decoded: unknown;
      try {
        decoded = JSON.parse(utf8Decoder.decode(line));
      } catch (error) {
        throw new CoworkStorageError(
          `malformed JSON in room "${roomId}" archive at byte offset ${byteOffset}`,
          { cause: error },
        );
      }
      const observedSequence = typeof decoded === 'object' && decoded !== null && 'seq' in decoded
        ? (decoded as { seq?: unknown }).seq
        : undefined;
      if (observedSequence !== expectedSequence) {
        throw new CoworkStorageError(
          `non-monotonic sequence in room "${roomId}" archive at byte offset ${byteOffset}: expected ${expectedSequence}, found ${String(observedSequence)}`,
        );
      }
      let record: CommunicationRecord;
      try {
        record = CommunicationRecordSchema.parse(decoded);
      } catch (error) {
        throw new CoworkStorageError(
          `invalid record in room "${roomId}" archive at byte offset ${byteOffset}`,
          { cause: error },
        );
      }
      if (record.room_id !== roomId) {
        throw new CoworkStorageError(
          `record room_id mismatch in room "${roomId}" archive at byte offset ${byteOffset}`,
        );
      }
      records.push(record);
      expectedSequence += 1;
      byteOffset = newline + 1;
    }
    return { records, nextSequence: expectedSequence };
  }

  private ensureBaseDirectories(): void {
    this.ensurePrivateDirectory(this.stateDir, true, 'state directory');
    this.ensurePrivateDirectory(this.roomsDirectory(), true, 'rooms directory');
  }

  private ensurePrivateDirectory(path: string, create: boolean, label: string): void {
    if (!this.fs.existsSync(path)) {
      if (!create) throw new CoworkStorageError(`${label} does not exist`);
      this.fs.mkdirSync(path, { recursive: true, mode: DIRECTORY_MODE });
    }
    this.rejectSymlink(path, label);
    const stat = this.fs.lstatSync(path);
    if (!stat.isDirectory()) throw new CoworkStorageError(`${label} is not a directory`);
    this.fs.chmodSync(path, DIRECTORY_MODE);
  }

  private assertRoomDirectory(roomId: string): void {
    this.ensureBaseDirectories();
    this.ensurePrivateDirectory(this.roomDirectory(roomId), false, `room "${roomId}" directory`);
  }

  private rejectSymlink(path: string, label: string): void {
    if (this.fs.lstatSync(path).isSymbolicLink()) {
      throw new CoworkStorageError(`${label} must not be a symbolic link (symlink)`);
    }
  }

  private assertRegularFile(path: string, label: string): void {
    this.rejectSymlink(path, label);
    const stat = this.fs.lstatSync(path);
    if (!stat.isFile()) throw new CoworkStorageError(`${label} is not a regular file`);
  }

  private createArchive(roomId: string): void {
    const path = this.archivePath(roomId);
    let fd: number | undefined;
    try {
      fd = this.fs.openSync(
        path,
        nodeFs.constants.O_CREAT | nodeFs.constants.O_EXCL | nodeFs.constants.O_WRONLY | NO_FOLLOW,
        FILE_MODE,
      );
      this.fs.fchmodSync(fd, FILE_MODE);
      this.fs.fsyncSync(fd);
    } finally {
      if (fd !== undefined) this.fs.closeSync(fd);
    }
    this.fsyncDirectory(dirname(path));
  }

  private atomicMetadataWrite(path: string, room: Room): void {
    if (this.fs.existsSync(path)) this.assertRegularFile(path, 'room metadata');
    const temp = `${path}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;
    const bytes = Buffer.from(`${JSON.stringify(room)}\n`, 'utf8');
    let fd: number | undefined;
    try {
      fd = this.fs.openSync(
        temp,
        nodeFs.constants.O_CREAT | nodeFs.constants.O_EXCL | nodeFs.constants.O_WRONLY | NO_FOLLOW,
        FILE_MODE,
      );
      this.fs.fchmodSync(fd, FILE_MODE);
      this.writeAll(fd, bytes);
      this.fs.fsyncSync(fd);
      this.fs.closeSync(fd);
      fd = undefined;
      this.fs.renameSync(temp, path);
      this.fs.chmodSync(path, FILE_MODE);
      this.fsyncDirectory(dirname(path));
    } catch (error) {
      if (fd !== undefined) {
        try { this.fs.closeSync(fd); } catch { /* original failure wins */ }
      }
      try { this.fs.rmSync(temp, { force: true }); } catch { /* best effort */ }
      throw this.wrap(`failed to atomically persist ${path}`, error);
    }
  }

  private writeAll(fd: number, bytes: Uint8Array): void {
    let offset = 0;
    while (offset < bytes.byteLength) {
      const written = this.fs.writeSync(fd, bytes, offset, bytes.byteLength - offset, null);
      if (written <= 0) throw new CoworkStorageError('write made no progress');
      offset += written;
    }
  }

  private readFileNoFollow(path: string): Buffer {
    let fd: number | undefined;
    try {
      fd = this.fs.openSync(path, nodeFs.constants.O_RDONLY | NO_FOLLOW);
      return this.fs.readFileSync(fd);
    } finally {
      if (fd !== undefined) this.fs.closeSync(fd);
    }
  }

  private fsyncDirectory(path: string): void {
    let fd: number | undefined;
    try {
      fd = this.fs.openSync(path, nodeFs.constants.O_RDONLY | NO_FOLLOW);
      this.fs.fsyncSync(fd);
    } finally {
      if (fd !== undefined) this.fs.closeSync(fd);
    }
  }

  private roomId(input: string): string {
    const parsed = LowerCrockfordUlidSchema.safeParse(input);
    if (!parsed.success) throw new CoworkStorageError(`invalid room_id "${input}"`);
    return parsed.data;
  }

  private roomsDirectory(): string {
    return join(this.stateDir, 'rooms');
  }

  private roomDirectory(roomId: string): string {
    return join(this.roomsDirectory(), roomId);
  }

  private metadataPath(roomId: string): string {
    return join(this.roomDirectory(roomId), 'room.json');
  }

  private archivePath(roomId: string): string {
    return join(this.roomDirectory(roomId), 'archive.jsonl');
  }

  private wrap(message: string, error: unknown): CoworkStorageError {
    return error instanceof CoworkStorageError
      ? new CoworkStorageError(`${message}: ${error.message}`, { cause: error })
      : new CoworkStorageError(`${message}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}
