import { randomBytes } from 'node:crypto';
import * as nodeFs from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
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

class RoomQueue {
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

export interface RoomMutex {
  runExclusive<T>(work: () => T | Promise<T>): Promise<T>;
}

interface LockOwnership {
  active: boolean;
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
  private readonly roomMutexes = new Map<string, RoomQueue>();
  private readonly lockOwnership = new AsyncLocalStorage<ReadonlyMap<string, LockOwnership>>();
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
    if (work) return this.withRoomMutex(validRoomId, work);
    return { runExclusive: <Result>(nested: () => Result | Promise<Result>) => this.withRoomMutex(validRoomId, nested) };
  }

  private withRoomMutex<T>(roomId: string, work: () => T | Promise<T>): Promise<T> {
    const inherited = this.lockOwnership.getStore();
    const ownership = inherited?.get(roomId);
    if (ownership?.active) return Promise.resolve().then(work);

    let queue = this.roomMutexes.get(roomId);
    if (!queue) {
      queue = new RoomQueue();
      this.roomMutexes.set(roomId, queue);
    }
    return queue.runExclusive(async () => {
      const acquired = { active: true };
      const context = new Map(inherited ?? []);
      context.set(roomId, acquired);
      try {
        return await this.lockOwnership.run(context, work);
      } finally {
        // Async resources spawned but not awaited by work retain the context.
        // Deactivation prevents them bypassing the FIFO after ownership ends.
        acquired.active = false;
      }
    });
  }

  async create(input: Room): Promise<Room> {
    const room = RoomSchema.parse(input);
    return this.mutex(room.room_id, () => {
      this.ensureBaseDirectories();
      const roomDir = this.roomDirectory(room.room_id);
      if (this.lstatIfPresent(roomDir)) {
        this.rejectSymlink(roomDir, 'room directory');
        throw new CoworkStorageError(`room "${room.room_id}" already exists`);
      }

      let roomCreated = false;
      try {
        this.fs.mkdirSync(roomDir, { mode: DIRECTORY_MODE });
        roomCreated = true;
        this.fs.chmodSync(roomDir, DIRECTORY_MODE);
        this.fsyncDirectory(roomDir);
        this.fsyncDirectory(this.roomsDirectory());
        this.createArchive(room.room_id);
        this.atomicMetadataWrite(this.metadataPath(room.room_id), room);
        this.nextSequences.set(room.room_id, 1);
        return room;
      } catch (error) {
        this.nextSequences.delete(room.room_id);
        const residue = this.lstatIfPresent(roomDir);
        if (roomCreated || (residue?.isDirectory() && !residue.isSymbolicLink())) {
          try {
            this.fs.rmSync(roomDir, { recursive: true, force: true });
            this.fsyncDirectory(this.roomsDirectory());
          } catch { /* original failure wins */ }
        }
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
      let originalSize: number | undefined;
      let writeStarted = false;
      try {
        fd = this.fs.openSync(
          archivePath,
          nodeFs.constants.O_WRONLY | nodeFs.constants.O_APPEND | NO_FOLLOW,
        );
        const opened = this.validateOpenPath(fd, archivePath, 'room archive', 'file', true);
        originalSize = opened.size;
        this.fs.fchmodSync(fd, FILE_MODE);
        writeStarted = true;
        this.writeAll(fd, bytes);
        this.fs.fsyncSync(fd);
        this.nextSequences.set(validRoomId, nextSequence + 1);
        return record;
      } catch (error) {
        this.nextSequences.delete(validRoomId);
        if (fd !== undefined && originalSize !== undefined && writeStarted) {
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
      this.ensureBaseDirectories();
      const roomDir = this.roomDirectory(validRoomId);
      if (!this.lstatIfPresent(roomDir)) {
        // A prior attempt may have removed the directory and crashed before
        // persisting that removal in its parent.
        this.fsyncDirectory(this.roomsDirectory());
        this.nextSequences.delete(validRoomId);
        return;
      }
      this.ensurePrivateDirectory(roomDir, false, `room "${validRoomId}" directory`);
      const archivePath = this.archivePath(validRoomId);
      const metadataPath = this.metadataPath(validRoomId);
      const expected = new Set(['archive.jsonl', 'room.json']);
      const unexpected = this.fs.readdirSync(roomDir).filter((name) => !expected.has(name));
      if (unexpected.length > 0) {
        throw new CoworkStorageError(`room "${validRoomId}" contains live or unexpected residue: ${unexpected.join(', ')}`);
      }
      if (this.lstatIfPresent(archivePath)) {
        this.assertRegularFile(archivePath, 'room archive');
        this.fs.unlinkSync(archivePath);
        this.fsyncDirectory(roomDir);
      }
      if (this.lstatIfPresent(metadataPath)) {
        this.assertRegularFile(metadataPath, 'room metadata');
        this.fs.unlinkSync(metadataPath);
        this.fsyncDirectory(roomDir);
      }
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
      bytes = this.readFileNoFollow(path, 'room metadata');
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
      bytes = this.readFileNoFollow(path, 'room archive');
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
    let stat = this.lstatIfPresent(path);
    const created = stat === undefined;
    if (created) {
      if (!create) throw new CoworkStorageError(`${label} does not exist`);
      this.createPrivateDirectoryTree(path, label);
      stat = this.fs.lstatSync(path);
    }
    const current = stat!;
    if (current.isSymbolicLink()) throw new CoworkStorageError(`${label} must not be a symbolic link (symlink)`);
    if (!current.isDirectory()) throw new CoworkStorageError(`${label} is not a directory`);
    this.fs.chmodSync(path, DIRECTORY_MODE);
  }

  private createPrivateDirectoryTree(path: string, label: string): void {
    const missing: string[] = [];
    let cursor = path;
    for (;;) {
      const existing = this.lstatIfPresent(cursor);
      if (existing) {
        if (existing.isSymbolicLink()) throw new CoworkStorageError(`${label} parent must not be a symbolic link (symlink)`);
        if (!existing.isDirectory()) throw new CoworkStorageError(`${label} parent is not a directory`);
        break;
      }
      missing.push(cursor);
      const parent = dirname(cursor);
      if (parent === cursor) throw new CoworkStorageError(`cannot find existing parent for ${label}`);
      cursor = parent;
    }
    const created: string[] = [];
    try {
      for (const directory of missing.reverse()) {
        this.fs.mkdirSync(directory, { mode: DIRECTORY_MODE });
        created.push(directory);
        this.fs.chmodSync(directory, DIRECTORY_MODE);
        this.fsyncDirectory(directory);
        this.fsyncDirectory(dirname(directory));
      }
    } catch (error) {
      for (const directory of created.reverse()) {
        try {
          this.fs.rmdirSync(directory);
          this.fsyncDirectory(dirname(directory));
        } catch { /* original creation failure wins */ }
      }
      throw error;
    }
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
    if (stat.nlink !== 1) throw new CoworkStorageError(`${label} has unsafe hardlink link count ${stat.nlink}`);
  }

  private lstatIfPresent(path: string): nodeFs.Stats | undefined {
    try {
      return this.fs.lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  private validateOpenPath(
    fd: number,
    path: string,
    label: string,
    kind: 'file' | 'directory',
    requireSingleLink: boolean,
  ): nodeFs.Stats {
    const opened = this.fs.fstatSync(fd);
    const validKind = kind === 'file' ? opened.isFile() : opened.isDirectory();
    if (!validKind) throw new CoworkStorageError(`${label} open descriptor is not a regular ${kind}`);
    if (requireSingleLink && opened.nlink !== 1) {
      throw new CoworkStorageError(`${label} has unsafe hardlink link count ${opened.nlink}`);
    }
    const current = this.fs.lstatSync(path);
    if (current.isSymbolicLink()) throw new CoworkStorageError(`${label} must not be a symbolic link (symlink)`);
    if (current.dev !== opened.dev || current.ino !== opened.ino) {
      throw new CoworkStorageError(`${label} inode changed during open`);
    }
    return opened;
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
      this.validateOpenPath(fd, path, 'room archive', 'file', true);
      this.fs.fchmodSync(fd, FILE_MODE);
      this.fs.fsyncSync(fd);
    } finally {
      if (fd !== undefined) this.fs.closeSync(fd);
    }
    this.fsyncDirectory(dirname(path));
  }

  private atomicMetadataWrite(path: string, room: Room): void {
    if (this.lstatIfPresent(path)) this.assertRegularFile(path, 'room metadata');
    const temp = `${path}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;
    const bytes = Buffer.from(`${JSON.stringify(room)}\n`, 'utf8');
    let fd: number | undefined;
    try {
      fd = this.fs.openSync(
        temp,
        nodeFs.constants.O_CREAT | nodeFs.constants.O_EXCL | nodeFs.constants.O_WRONLY | NO_FOLLOW,
        FILE_MODE,
      );
      this.validateOpenPath(fd, temp, 'temporary room metadata', 'file', true);
      this.fs.fchmodSync(fd, FILE_MODE);
      this.writeAll(fd, bytes);
      this.fs.fsyncSync(fd);
      this.fs.closeSync(fd);
      fd = undefined;
      this.fs.renameSync(temp, path);
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

  private readFileNoFollow(path: string, label: string): Buffer {
    let fd: number | undefined;
    try {
      fd = this.fs.openSync(path, nodeFs.constants.O_RDONLY | NO_FOLLOW);
      this.validateOpenPath(fd, path, label, 'file', true);
      return this.fs.readFileSync(fd);
    } finally {
      if (fd !== undefined) this.fs.closeSync(fd);
    }
  }

  private fsyncDirectory(path: string): void {
    let fd: number | undefined;
    try {
      fd = this.fs.openSync(path, nodeFs.constants.O_RDONLY | NO_FOLLOW);
      this.validateOpenPath(fd, path, 'directory fsync target', 'directory', false);
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
