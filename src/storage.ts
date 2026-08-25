import { randomBytes } from 'node:crypto';
import * as nodeFs from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { basename, dirname, join } from 'node:path';
import Database from 'better-sqlite3';

import {
  AppendRecordSchema,
  CommunicationRecordSchema,
  LowerCrockfordUlidSchema,
  RoomSchema,
  RoomV1Schema,
  migrateRoomV1,
  type AppendRecord,
  type CommunicationRecord,
  type Room,
} from './contracts.ts';
import { generateUlid } from './ulid.ts';

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const NO_FOLLOW = nodeFs.constants.O_NOFOLLOW ?? 0;
const SQLITE_SCHEMA_VERSION = 1;
const DEFAULT_WORK_BATCH_SIZE = 64;
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

export type CoworkFs = typeof nodeFs;

export interface CoworkStoreOptions {
  fs?: CoworkFs;
  /** Test seam for an injected failure after row writes but before COMMIT. */
  beforeRecordCommit?: () => void;
}
export interface ArchiveReadOptions { after?: number; limit?: number }

export interface ArchiveQueryOptions {
  after?: number;
  kind?: CommunicationRecord['kind'];
  messageId?: string;
  fileId?: string;
  sourceMsgId?: number;
  sourceFileId?: number;
  intentRecordId?: string;
  recipientIdentity?: string;
  category?: string;
  membershipEpoch?: number;
  unresolvedResultKind?: 'relay_result' | 'membership_result' | 'close_notice_result';
  descending?: boolean;
  limit?: number;
}

export interface RelayIntentWorkOptions { after?: number; limit?: number }
export interface BriefingDeliveryKey {
  category: 'briefing' | 'role_briefing';
  briefingRole?: string;
  briefingVersion: number;
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
    try { return await work(); } finally { release(); }
  }
}

export interface RoomMutex { runExclusive<T>(work: () => T | Promise<T>): Promise<T> }
interface LockOwnership { active: boolean; pending: Set<Promise<unknown>>; failures: unknown[] }
interface RecordRow { seq: number; payload_json: string; blob_path: string | null }

/**
 * SQLite crash boundary: every record becomes visible only after a FULL-sync WAL
 * commit. File blobs are written temp -> fsync -> atomic rename -> directory
 * fsync before the transaction that references them. A crash can therefore
 * leave an unreferenced immutable blob, never a committed row with partial
 * bytes. Room metadata retains its temp/fsync/rename/directory-fsync boundary.
 */
export class CoworkStore {
  readonly stateDir: string;
  private readonly fs: CoworkFs;
  private readonly beforeRecordCommit?: () => void;
  private readonly roomMutexes = new Map<string, RoomQueue>();
  private readonly lockOwnership = new AsyncLocalStorage<ReadonlyMap<string, LockOwnership>>();
  private readonly reconciledBlobRooms = new Set<string>();

  constructor(stateDir: string, options: CoworkStoreOptions = {}) {
    if (!stateDir) throw new CoworkStorageError('state directory is required');
    this.stateDir = stateDir;
    this.fs = options.fs ?? nodeFs;
    this.beforeRecordCommit = options.beforeRecordCommit;
  }

  mutex(roomId: string): RoomMutex;
  mutex<T>(roomId: string, work: () => T | Promise<T>): Promise<T>;
  mutex<T>(roomId: string, work?: () => T | Promise<T>): RoomMutex | Promise<T> {
    const id = this.roomId(roomId);
    if (work) return this.withRoomMutex(id, work);
    return { runExclusive: <R>(nested: () => R | Promise<R>) => this.withRoomMutex(id, nested) };
  }

  private withRoomMutex<T>(roomId: string, work: () => T | Promise<T>): Promise<T> {
    const inherited = this.lockOwnership.getStore();
    const ownership = inherited?.get(roomId);
    if (ownership?.active) {
      const nested = Promise.resolve().then(work);
      ownership.pending.add(nested);
      void nested.then(() => ownership.pending.delete(nested), (error) => {
        ownership.pending.delete(nested); ownership.failures.push(error);
      });
      return nested;
    }
    let queue = this.roomMutexes.get(roomId);
    if (!queue) { queue = new RoomQueue(); this.roomMutexes.set(roomId, queue); }
    return queue.runExclusive(async () => {
      const acquired: LockOwnership = { active: true, pending: new Set(), failures: [] };
      const context = new Map(inherited ?? []); context.set(roomId, acquired);
      let result!: T; let rootFailure: unknown; let rootFailed = false;
      try {
        try { result = await this.lockOwnership.run(context, work); }
        catch (error) { rootFailed = true; rootFailure = error; }
        while (acquired.pending.size > 0) await Promise.allSettled([...acquired.pending]);
      } finally { acquired.active = false; }
      if (rootFailed) throw rootFailure;
      if (acquired.failures.length > 0) throw acquired.failures[0];
      return result;
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
      let created = false;
      try {
        this.fs.mkdirSync(roomDir, { mode: DIRECTORY_MODE }); created = true;
        this.fs.chmodSync(roomDir, DIRECTORY_MODE);
        this.fs.mkdirSync(this.blobsDirectory(room.room_id), { mode: DIRECTORY_MODE });
        this.fs.chmodSync(this.blobsDirectory(room.room_id), DIRECTORY_MODE);
        this.fsyncDirectory(roomDir); this.fsyncDirectory(this.roomsDirectory());
        this.withDatabase(room.room_id, () => undefined, true);
        this.atomicMetadataWrite(this.metadataPath(room.room_id), room);
        return room;
      } catch (error) {
        if (created) {
          try { this.fs.rmSync(roomDir, { recursive: true, force: true }); this.fsyncDirectory(this.roomsDirectory()); }
          catch { /* original error wins */ }
        }
        throw this.wrap(`failed to create room "${room.room_id}"`, error);
      }
    });
  }

  async load(roomId: string): Promise<Room> {
    const id = this.roomId(roomId);
    return this.mutex(id, () => this.loadUnlocked(id));
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
    const ids = this.fs.readdirSync(this.roomsDirectory(), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && LowerCrockfordUlidSchema.safeParse(entry.name).success)
      .map((entry) => entry.name).sort();
    const rooms: Room[] = [];
    for (const id of ids) rooms.push(await this.load(id));
    return rooms;
  }

  async append(roomId: string, input: AppendRecord): Promise<CommunicationRecord> {
    const id = this.roomId(roomId);
    const draft = AppendRecordSchema.parse(input);
    if (draft.room_id !== id) throw new CoworkStorageError(`record room_id "${draft.room_id}" does not match room "${id}"`);
    return this.mutex(id, () => {
      this.assertRoomDirectory(id);
      // On the first operation after restart, reconcile crash-left blobs
      // before placing any new pre-commit blob for this append.
      if (!this.reconciledBlobRooms.has(id)) this.withDatabase(id, () => undefined);
      let blob: { path: string; created: boolean } | undefined;
      let storedDraft: Record<string, unknown> = draft;
      if (draft.kind === 'file') {
        const bytes = Buffer.from(draft.data_base64, 'base64');
        blob = this.persistBlob(id, draft.sha256, bytes);
        const { data_base64: _bytes, ...withoutBytes } = draft;
        storedDraft = withoutBytes;
      }
      try {
        return this.withDatabase(id, (db) => {
          const transaction = db.transaction(() => {
            const next = (db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM records').get() as { next: number }).next;
            // AppendRecordSchema already validated the complete caller-controlled
            // payload once. Sequence and record ID are generated inside this
            // transaction, so adding them does not warrant a second payload pass.
            const record = { ...draft, seq: next, record_id: `${id}:${next}` } as CommunicationRecord;
            const stored = { ...storedDraft, seq: next, record_id: record.record_id };
            const values = this.indexValues(record);
            db.prepare(`INSERT INTO records
              (seq, record_id, kind, at, payload_json, blob_path, message_id, file_id, intent_record_id,
               recipient_identity, source_msg_id, source_file_id, category, briefing_role, briefing_version, membership_epoch)
              VALUES (@seq,@record_id,@kind,@at,@payload_json,@blob_path,@message_id,@file_id,@intent_record_id,
               @recipient_identity,@source_msg_id,@source_file_id,@category,@briefing_role,@briefing_version,@membership_epoch)`)
              .run({ ...values, payload_json: JSON.stringify(stored), blob_path: blob?.path ?? null });
            if (record.kind === 'message' || record.kind === 'file') {
              const insert = db.prepare(`INSERT INTO record_recipients
                (record_seq, recipient_identity, category, briefing_role, briefing_version)
                VALUES (?, ?, ?, ?, ?)`);
              const enqueue = db.prepare('INSERT INTO relay_intent_work(record_seq, recipient_identity) VALUES (?, ?)');
              for (const recipient of record.recipient_identities) {
                insert.run(
                  record.seq,
                  recipient,
                  record.kind === 'message' ? record.category : null,
                  record.kind === 'message' ? record.briefing_role ?? null : null,
                  record.kind === 'message' ? record.briefing_version ?? 1 : null,
                );
                enqueue.run(record.seq, recipient);
              }
            } else if (record.kind === 'relay_intent') {
              const sourceColumn = record.message_id === undefined ? 'file_id' : 'message_id';
              const sourceId = record.message_id ?? record.file_id;
              db.prepare(`DELETE FROM relay_intent_work
                WHERE recipient_identity = ? AND record_seq IN (
                  SELECT seq FROM records WHERE kind = ? AND ${sourceColumn} = ?
                )`).run(record.recipient_identity, record.message_id === undefined ? 'file' : 'message', sourceId);
            }
            this.beforeRecordCommit?.();
            return record;
          });
          return transaction.immediate();
        });
      } catch (error) {
        if (blob?.created) this.removeUnreferencedBlob(id, blob.path);
        throw this.wrap(`failed to append room "${id}" archive`, error);
      }
    });
  }

  async read(roomId: string, options: ArchiveReadOptions = {}): Promise<CommunicationRecord[]> {
    const id = this.roomId(roomId);
    const after = options.after ?? 0;
    const limit = options.limit ?? Number.MAX_SAFE_INTEGER;
    this.validatePage(after, limit);
    return this.mutex(id, () => {
      this.assertRoomDirectory(id);
      return this.withDatabase(id, (db) => this.decodeRows(id, db.prepare(
        'SELECT seq,payload_json,blob_path FROM records WHERE seq > ? ORDER BY seq ASC LIMIT ?',
      ).all(after, limit) as RecordRow[]));
    });
  }

  async query(roomId: string, options: ArchiveQueryOptions): Promise<CommunicationRecord[]> {
    const id = this.roomId(roomId);
    const limit = options.limit ?? Number.MAX_SAFE_INTEGER;
    if (!Number.isSafeInteger(limit) || limit < 1) throw new CoworkStorageError('limit must be a positive safe integer');
    return this.mutex(id, () => {
      this.assertRoomDirectory(id);
      return this.withDatabase(id, (db) => {
        const clauses: string[] = []; const values: unknown[] = [];
        const add = (column: string, value: unknown): void => { if (value !== undefined) { clauses.push(`r.${column} = ?`); values.push(value); } };
        add('kind', options.kind); add('message_id', options.messageId); add('file_id', options.fileId);
        add('source_msg_id', options.sourceMsgId); add('source_file_id', options.sourceFileId);
        add('intent_record_id', options.intentRecordId); add('recipient_identity', options.recipientIdentity);
        add('category', options.category); add('membership_epoch', options.membershipEpoch);
        if (options.after !== undefined) { clauses.push('r.seq > ?'); values.push(options.after); }
        if (options.unresolvedResultKind) {
          clauses.push('NOT EXISTS (SELECT 1 FROM records result WHERE result.kind = ? AND result.intent_record_id = r.record_id)');
          values.push(options.unresolvedResultKind);
        }
        values.push(limit);
        const sql = `SELECT r.seq,r.payload_json,r.blob_path FROM records r${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY r.seq ${options.descending ? 'DESC' : 'ASC'} LIMIT ?`;
        return this.decodeRows(id, db.prepare(sql).all(...values) as RecordRow[]);
      });
    });
  }

  async recipients(roomId: string, recordSeq: number): Promise<string[]> {
    const id = this.roomId(roomId);
    return this.mutex(id, () => this.withDatabase(id, (db) => (db.prepare(
      'SELECT recipient_identity FROM record_recipients WHERE record_seq = ? ORDER BY recipient_identity',
    ).all(recordSeq) as Array<{ recipient_identity: string }>).map((row) => row.recipient_identity)));
  }

  async recordsNeedingRelayIntents(
    roomId: string,
    options: RelayIntentWorkOptions = {},
  ): Promise<CommunicationRecord[]> {
    const id = this.roomId(roomId);
    const after = options.after ?? 0;
    const limit = options.limit ?? DEFAULT_WORK_BATCH_SIZE;
    this.validatePage(after, limit);
    return this.mutex(id, () => this.withDatabase(id, (db) => this.decodeRows(id, db.prepare(`
      SELECT source.seq,source.payload_json,source.blob_path
      FROM relay_intent_work work INDEXED BY relay_work_source
      JOIN records source ON source.seq = work.record_seq
      WHERE work.record_seq > ?
      GROUP BY source.seq
      ORDER BY source.seq ASC
      LIMIT ?
    `).all(after, limit) as RecordRow[])));
  }

  async relayRecipientsNeedingIntent(
    roomId: string,
    recordSeq: number,
    limit = DEFAULT_WORK_BATCH_SIZE,
  ): Promise<string[]> {
    const id = this.roomId(roomId);
    if (!Number.isSafeInteger(recordSeq) || recordSeq < 1) throw new CoworkStorageError('record sequence must be a positive safe integer');
    if (!Number.isSafeInteger(limit) || limit < 1) throw new CoworkStorageError('limit must be a positive safe integer');
    return this.mutex(id, () => this.withDatabase(id, (db) => (db.prepare(
      'SELECT recipient_identity FROM relay_intent_work WHERE record_seq = ? ORDER BY recipient_identity LIMIT ?',
    ).all(recordSeq, limit) as Array<{ recipient_identity: string }>).map((row) => row.recipient_identity)));
  }

  async briefingDeliveryTimes(
    roomId: string,
    key: BriefingDeliveryKey,
    recipientIdentities: string[],
  ): Promise<Map<string, string>> {
    const id = this.roomId(roomId);
    if (recipientIdentities.length === 0) return new Map();
    return this.mutex(id, () => this.withDatabase(id, (db) => {
      const lookup = db.prepare(`SELECT records.at FROM record_recipients recipients
        INDEXED BY recipients_briefing_delivery
        JOIN records ON records.seq = recipients.record_seq
        WHERE recipients.recipient_identity = ? AND recipients.category = ?
          AND recipients.briefing_role IS ? AND recipients.briefing_version = ?
        ORDER BY recipients.record_seq ASC LIMIT 1`);
      const deliveries = new Map<string, string>();
      for (const recipient of recipientIdentities) {
        const row = lookup.get(
          recipient, key.category, key.briefingRole ?? null, key.briefingVersion,
        ) as { at: string } | undefined;
        if (row) deliveries.set(recipient, row.at);
      }
      return deliveries;
    }));
  }

  async durability(roomId: string): Promise<{ journalMode: string; synchronous: number }> {
    const id = this.roomId(roomId);
    return this.mutex(id, () => this.withDatabase(id, (db) => ({
      journalMode: db.pragma('journal_mode', { simple: true }) as string,
      synchronous: db.pragma('synchronous', { simple: true }) as number,
    })));
  }

  async delete(roomId: string): Promise<void> {
    const id = this.roomId(roomId);
    await this.mutex(id, () => {
      this.ensureBaseDirectories();
      const roomDir = this.roomDirectory(id);
      if (!this.lstatIfPresent(roomDir)) { this.fsyncDirectory(this.roomsDirectory()); return; }
      this.ensurePrivateDirectory(roomDir, false, `room "${id}" directory`);
      const metadata = this.metadataPath(id);
      const metadataPresent = this.lstatIfPresent(metadata) !== undefined;
      const archivePresent = this.lstatIfPresent(this.archivePath(id)) !== undefined;
      const blobsPresent = this.lstatIfPresent(this.blobsDirectory(id)) !== undefined;
      if (metadataPresent) {
        const room = this.loadUnlocked(id);
        if (room.state !== 'closed') throw new CoworkStorageError(`room "${id}" must be closed before deletion`);
        this.removeProvisioningArtifacts(roomDir);
      } else if (archivePresent || blobsPresent) {
        // Deletion always removes the SQLite archive and blob directory before
        // metadata. Their presence without metadata is not a resumable stage.
        throw new CoworkStorageError(`room "${id}" has archive residue without deletion metadata`);
      }
      const expected = new Set(['archive.sqlite3','archive.sqlite3-wal','archive.sqlite3-shm','blobs','room.json','room.json.v1.bak']);
      const unexpected = this.fs.readdirSync(roomDir).filter((name) => !expected.has(name));
      if (unexpected.length) throw new CoworkStorageError(`room "${id}" contains live or unexpected residue: ${unexpected.join(', ')}`);
      for (const name of ['archive.sqlite3-wal','archive.sqlite3-shm','archive.sqlite3','room.json.v1.bak','room.json']) {
        const path = join(roomDir, name); if (this.lstatIfPresent(path)) { this.assertRegularFile(path, name); this.fs.unlinkSync(path); }
      }
      const blobs = this.blobsDirectory(id);
      if (this.lstatIfPresent(blobs)) this.fs.rmSync(blobs, { recursive: true, force: true });
      this.fsyncDirectory(roomDir); this.fs.rmdirSync(roomDir); this.fsyncDirectory(this.roomsDirectory());
    });
  }

  private withDatabase<T>(roomId: string, work: (db: Database.Database) => T, create = false): T {
    const path = this.archivePath(roomId);
    let guardFd: number | undefined;
    if (!create) {
      this.assertRegularFile(path, 'room archive database');
      guardFd = this.fs.openSync(path, nodeFs.constants.O_RDONLY | NO_FOLLOW);
      this.validateOpenPath(guardFd, path, 'room archive database', 'file', true);
    }
    let db: Database.Database | undefined;
    try {
      this.secureSqliteFiles(path);
      db = new Database(path, { fileMustExist: !create });
      if (guardFd !== undefined) this.validateOpenPath(guardFd, path, 'room archive database', 'file', true);
      this.fs.chmodSync(path, FILE_MODE);
      db.pragma('journal_mode = WAL');
      db.pragma('synchronous = FULL');
      db.pragma('foreign_keys = ON');
      db.pragma('busy_timeout = 5000');
      if (create) {
        db.exec(`CREATE TABLE records (
        seq INTEGER PRIMARY KEY, record_id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, at TEXT NOT NULL,
        payload_json TEXT NOT NULL, blob_path TEXT, message_id TEXT, file_id TEXT, intent_record_id TEXT,
        recipient_identity TEXT, source_msg_id INTEGER, source_file_id INTEGER, category TEXT,
        briefing_role TEXT, briefing_version INTEGER, membership_epoch INTEGER
      );
      CREATE TABLE record_recipients (
        record_seq INTEGER NOT NULL REFERENCES records(seq) ON DELETE CASCADE,
        recipient_identity TEXT NOT NULL, category TEXT, briefing_role TEXT,
        briefing_version INTEGER, PRIMARY KEY(record_seq, recipient_identity)
      );
      CREATE TABLE relay_intent_work (
        record_seq INTEGER NOT NULL REFERENCES records(seq) ON DELETE CASCADE,
        recipient_identity TEXT NOT NULL, PRIMARY KEY(record_seq, recipient_identity)
      );
      CREATE INDEX relay_work_source ON relay_intent_work(record_seq, recipient_identity);
      CREATE INDEX records_kind_seq ON records(kind, seq);
      CREATE INDEX records_message ON records(message_id, kind, seq);
      CREATE INDEX records_file ON records(file_id, kind, seq);
      CREATE INDEX records_intent_result ON records(intent_record_id, kind);
      CREATE INDEX records_relay_recipient ON records(kind, recipient_identity, seq);
      CREATE UNIQUE INDEX records_source_message ON records(source_msg_id) WHERE kind='message' AND source_msg_id IS NOT NULL;
      CREATE UNIQUE INDEX records_source_file ON records(source_file_id) WHERE kind='file' AND source_file_id IS NOT NULL;
      CREATE INDEX records_briefing ON records(category, briefing_role, briefing_version, seq);
      CREATE INDEX records_membership_epoch ON records(category, membership_epoch);
      CREATE INDEX recipients_identity ON record_recipients(recipient_identity, record_seq);
      CREATE INDEX recipients_briefing_delivery ON record_recipients
        (recipient_identity, category, briefing_role, briefing_version, record_seq);`);
        db.pragma(`user_version = ${SQLITE_SCHEMA_VERSION}`);
        this.reconciledBlobRooms.add(roomId);
      } else {
        const version = db.pragma('user_version', { simple: true }) as number;
        if (version !== SQLITE_SCHEMA_VERSION) {
          throw new CoworkStorageError(`unsupported room archive schema version ${version}`);
        }
        if (!this.reconciledBlobRooms.has(roomId)) {
          this.reconcileBlobDirectory(roomId, db);
          this.reconciledBlobRooms.add(roomId);
        }
      }
      this.secureSqliteFiles(path);
      const result = work(db);
      this.secureSqliteFiles(path);
      return result;
    } catch (error) { throw this.wrap(`failed to access room "${roomId}" SQLite archive`, error); }
    finally {
      try { db?.close(); } catch { /* preceding outcome wins */ }
      if (guardFd !== undefined) try { this.fs.closeSync(guardFd); } catch { /* preceding outcome wins */ }
      this.secureSqliteFiles(path);
    }
  }

  private indexValues(record: CommunicationRecord): Record<string, unknown> {
    const subject = record as CommunicationRecord & Record<string, unknown>;
    return {
      seq: record.seq, record_id: record.record_id, kind: record.kind, at: record.at,
      message_id: subject.message_id ?? null, file_id: subject.file_id ?? null,
      intent_record_id: subject.intent_record_id ?? null,
      recipient_identity: subject.recipient_identity ?? null,
      source_msg_id: subject.source_msg_id ?? null, source_file_id: subject.source_file_id ?? null,
      category: subject.category ?? null, briefing_role: subject.briefing_role ?? null,
      briefing_version: subject.briefing_version ?? null,
      membership_epoch: typeof subject.membership === 'object' && subject.membership !== null
        ? (subject.membership as { epoch?: unknown }).epoch ?? null : null,
    };
  }

  private decodeRows(roomId: string, rows: RecordRow[]): CommunicationRecord[] {
    return rows.map((row) => {
      let decoded: unknown;
      try { decoded = JSON.parse(row.payload_json); }
      catch (error) { throw new CoworkStorageError(`malformed JSON in room "${roomId}" archive at sequence ${row.seq}`, { cause: error }); }
      if (row.blob_path !== null) {
        const subject = decoded as { kind?: unknown; sha256?: unknown };
        const expectedPath = subject.kind === 'file' && typeof subject.sha256 === 'string'
          && /^[0-9a-f]{64}$/.test(subject.sha256) ? join('blobs', subject.sha256) : undefined;
        if (expectedPath === undefined || row.blob_path !== expectedPath) {
          throw new CoworkStorageError(`invalid blob reference in room "${roomId}" archive at sequence ${row.seq}`);
        }
        const bytes = this.readFileNoFollow(join(this.roomDirectory(roomId), expectedPath), 'room file blob');
        decoded = { ...(decoded as object), data_base64: bytes.toString('base64') };
      }
      try {
        const record = CommunicationRecordSchema.parse(decoded);
        if (record.room_id !== roomId || record.seq !== row.seq) throw new Error('indexed identity mismatch');
        return record;
      } catch (error) { throw new CoworkStorageError(`invalid record in room "${roomId}" archive at sequence ${row.seq}`, { cause: error }); }
    });
  }

  private persistBlob(roomId: string, digest: string, bytes: Buffer): { path: string; created: boolean } {
    // The sole AppendRecordSchema pass already decoded these bytes and bound
    // them to this digest; do not repeat the expensive hash on the write path.
    const directory = this.blobsDirectory(roomId); this.ensurePrivateDirectory(directory, true, 'room blobs directory');
    const final = join(directory, digest);
    if (this.lstatIfPresent(final)) {
      this.assertRegularFile(final, 'room file blob');
      if (this.readFileNoFollow(final, 'room file blob').equals(bytes)) return { path: join('blobs', digest), created: false };
      throw new CoworkStorageError(`immutable blob collision for ${digest}`);
    }
    const temp = join(directory, `.tmp-${process.pid}-${randomBytes(8).toString('hex')}`);
    let fd: number | undefined;
    try {
      fd = this.fs.openSync(temp, nodeFs.constants.O_CREAT | nodeFs.constants.O_EXCL | nodeFs.constants.O_WRONLY | NO_FOLLOW, FILE_MODE);
      this.writeAll(fd, bytes); this.fs.fsyncSync(fd); this.fs.closeSync(fd); fd = undefined;
      this.fs.renameSync(temp, final); this.fsyncDirectory(directory);
      this.fs.chmodSync(final, FILE_MODE);
      return { path: join('blobs', digest), created: true };
    } finally {
      if (fd !== undefined) try { this.fs.closeSync(fd); } catch {}
      if (this.lstatIfPresent(temp)) try { this.fs.unlinkSync(temp); } catch {}
    }
  }

  private removeUnreferencedBlob(roomId: string, relativePath: string): void {
    const absolute = join(this.roomDirectory(roomId), relativePath);
    try {
      const referenced = this.withDatabase(roomId, (db) => (db.prepare(
        'SELECT EXISTS(SELECT 1 FROM records WHERE blob_path = ?) AS found',
      ).get(relativePath) as { found: number }).found !== 0);
      if (referenced || !this.lstatIfPresent(absolute)) return;
      this.assertRegularFile(absolute, 'unreferenced room file blob');
      this.fs.unlinkSync(absolute);
      this.fsyncDirectory(dirname(absolute));
    } catch { /* the append error remains authoritative; uncertain blobs are retained */ }
  }

  private reconcileBlobDirectory(roomId: string, db: Database.Database): void {
    const directory = this.blobsDirectory(roomId);
    this.ensurePrivateDirectory(directory, true, 'room blobs directory');
    const referenced = new Set((db.prepare(
      'SELECT blob_path FROM records WHERE blob_path IS NOT NULL',
    ).all() as Array<{ blob_path: string }>).map((row) => basename(row.blob_path)));
    let changed = false;
    for (const entry of this.fs.readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (/^\.tmp-[0-9]+-[0-9a-f]{16}$/.test(entry.name)) {
        this.assertRegularFile(path, 'crash-left room blob temporary file');
        this.fs.unlinkSync(path);
        changed = true;
        continue;
      }
      if (!/^[0-9a-f]{64}$/.test(entry.name)) throw new CoworkStorageError(`unexpected room blob residue: ${entry.name}`);
      this.assertRegularFile(path, referenced.has(entry.name) ? 'room file blob' : 'unreferenced room file blob');
      this.fs.chmodSync(path, FILE_MODE);
      if (referenced.has(entry.name)) continue;
      this.fs.unlinkSync(path);
      changed = true;
    }
    if (changed) this.fsyncDirectory(directory);
  }

  private secureSqliteFiles(path: string): void {
    for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
      if (!this.lstatIfPresent(candidate)) continue;
      this.assertRegularFile(candidate, `SQLite file ${basename(candidate)}`);
      this.fs.chmodSync(candidate, FILE_MODE);
    }
  }

  private validatePage(after: number, limit: number): void {
    if (!Number.isSafeInteger(after) || after < 0) throw new CoworkStorageError('after must be a non-negative safe integer');
    if (!Number.isSafeInteger(limit) || limit < 1) throw new CoworkStorageError('limit must be a positive safe integer');
  }

  private loadUnlocked(roomId: string): Room {
    this.assertRoomDirectory(roomId);
    const path = this.metadataPath(roomId); this.assertRegularFile(path, 'room metadata');
    let decoded: unknown; let bytes: Buffer;
    try { bytes = this.readFileNoFollow(path, 'room metadata'); decoded = JSON.parse(utf8Decoder.decode(bytes)); }
    catch (error) { throw this.wrap(`malformed metadata for room "${roomId}"`, error); }
    const room = this.isVersion1(decoded) ? this.migrateUnlocked(roomId, decoded, bytes) : RoomSchema.parse(decoded);
    if (!this.isVersion1(decoded) && this.persistedRoomName(decoded) !== room.room_name) this.atomicMetadataWrite(path, room);
    if (room.room_id !== roomId) throw new CoworkStorageError(`metadata room_id does not match room "${roomId}"`);
    return room;
  }

  private isVersion1(decoded: unknown): boolean { return typeof decoded === 'object' && decoded !== null && (decoded as { version?: unknown }).version === 1; }
  private persistedRoomName(decoded: unknown): unknown { return typeof decoded === 'object' && decoded !== null ? (decoded as { room_name?: unknown }).room_name : undefined; }
  private migrateUnlocked(roomId: string, decoded: unknown, original: Buffer): Room {
    const v1 = RoomV1Schema.parse(decoded);
    if (v1.room_id !== roomId) throw new CoworkStorageError(`metadata room_id does not match room "${roomId}"`);
    const migrated = migrateRoomV1(v1, generateUlid); const backup = `${this.metadataPath(roomId)}.v1.bak`;
    if (!this.hasIntactV1Backup(backup)) this.atomicBytesWrite(backup, original, 'room metadata v1 backup');
    this.atomicMetadataWrite(this.metadataPath(roomId), migrated); return migrated;
  }
  private hasIntactV1Backup(path: string): boolean {
    if (!this.lstatIfPresent(path)) return false;
    try { return this.isVersion1(JSON.parse(utf8Decoder.decode(this.readFileNoFollow(path, 'room metadata v1 backup')))); } catch { return false; }
  }

  private removeProvisioningArtifacts(roomDir: string): void {
    const journal = join(roomDir, '.cowork-provisioning-stage');
    const targets = [join(roomDir, 'live'), join(roomDir, 'provisioning-residue')];
    if (this.lstatIfPresent(journal)) {
      this.assertRegularFile(journal, 'provisioning staging journal');
      const name = this.fs.readFileSync(journal, 'utf8').trim();
      if (!/^live\.staging-[0-9a-f]{32}$/.test(name)) throw new CoworkStorageError('invalid provisioning staging journal');
      targets.push(join(roomDir, name));
    }
    for (const target of targets) {
      const stat = this.lstatIfPresent(target); if (!stat) continue;
      if (stat.isSymbolicLink() || !stat.isDirectory()) this.fs.unlinkSync(target); else this.fs.rmSync(target, { recursive: true, force: true });
      this.fsyncDirectory(roomDir);
    }
    if (this.lstatIfPresent(journal)) { this.fs.unlinkSync(journal); this.fsyncDirectory(roomDir); }
  }

  private atomicMetadataWrite(path: string, room: Room): void { this.atomicBytesWrite(path, Buffer.from(`${JSON.stringify(room)}\n`), 'room metadata'); }
  private atomicBytesWrite(path: string, bytes: Buffer, label: string): void {
    if (this.lstatIfPresent(path)) this.assertRegularFile(path, label);
    const temp = `${path}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`; let fd: number | undefined;
    try {
      fd = this.fs.openSync(temp, nodeFs.constants.O_CREAT | nodeFs.constants.O_EXCL | nodeFs.constants.O_WRONLY | NO_FOLLOW, FILE_MODE);
      this.writeAll(fd, bytes); this.fs.fsyncSync(fd); this.fs.closeSync(fd); fd = undefined;
      this.fs.renameSync(temp, path); this.fsyncDirectory(dirname(path));
    } catch (error) {
      if (fd !== undefined) try { this.fs.closeSync(fd); } catch {}
      try { this.fs.rmSync(temp, { force: true }); } catch {}
      throw this.wrap(`failed to write ${label} at ${path}`, error);
    }
  }

  private ensureBaseDirectories(): void { this.ensurePrivateDirectory(this.stateDir, true, 'state directory'); this.ensurePrivateDirectory(this.roomsDirectory(), true, 'rooms directory'); }
  private assertRoomDirectory(roomId: string): void {
    this.ensureBaseDirectories();
    this.ensurePrivateDirectory(this.roomDirectory(roomId), false, `room "${roomId}" directory`);
  }
  private ensurePrivateDirectory(path: string, create: boolean, label: string): void {
    let stat = this.lstatIfPresent(path);
    if (!stat) { if (!create) throw new CoworkStorageError(`${label} does not exist`); this.createPrivateDirectoryTree(path, label); stat = this.fs.lstatSync(path); }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new CoworkStorageError(`${label} is not a private directory`);
    this.fs.chmodSync(path, DIRECTORY_MODE);
  }
  private createPrivateDirectoryTree(path: string, label: string): void {
    const missing: string[] = []; let cursor = path;
    for (;;) { const stat = this.lstatIfPresent(cursor); if (stat) { if (stat.isSymbolicLink() || !stat.isDirectory()) throw new CoworkStorageError(`${label} parent is unsafe`); break; } missing.push(cursor); const parent = dirname(cursor); if (parent === cursor) throw new CoworkStorageError(`cannot find existing parent for ${label}`); cursor = parent; }
    for (const directory of missing.reverse()) { this.fs.mkdirSync(directory, { mode: DIRECTORY_MODE }); this.fs.chmodSync(directory, DIRECTORY_MODE); this.fsyncDirectory(directory); this.fsyncDirectory(dirname(directory)); }
  }
  private rejectSymlink(path: string, label: string): void { if (this.fs.lstatSync(path).isSymbolicLink()) throw new CoworkStorageError(`${label} must not be a symbolic link (symlink)`); }
  private assertRegularFile(path: string, label: string): void { this.rejectSymlink(path, label); const stat = this.fs.lstatSync(path); if (!stat.isFile() || stat.nlink !== 1) throw new CoworkStorageError(`${label} is not a safe regular file`); }
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
    if (requireSingleLink && opened.nlink !== 1) throw new CoworkStorageError(`${label} has unsafe hardlink link count ${opened.nlink}`);
    const current = this.fs.lstatSync(path);
    if (current.isSymbolicLink()) throw new CoworkStorageError(`${label} must not be a symbolic link (symlink)`);
    if (current.dev !== opened.dev || current.ino !== opened.ino) throw new CoworkStorageError(`${label} inode changed during open`);
    return opened;
  }
  private lstatIfPresent(path: string): nodeFs.Stats | undefined { try { return this.fs.lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; } }
  private writeAll(fd: number, bytes: Uint8Array): void { let offset = 0; while (offset < bytes.length) { const n = this.fs.writeSync(fd, bytes, offset, bytes.length - offset, null); if (n <= 0) throw new CoworkStorageError('write made no progress'); offset += n; } }
  private readFileNoFollow(path: string, label: string): Buffer { let fd: number | undefined; try { fd = this.fs.openSync(path, nodeFs.constants.O_RDONLY | NO_FOLLOW); this.validateOpenPath(fd, path, label, 'file', true); return this.fs.readFileSync(fd); } finally { if (fd !== undefined) this.fs.closeSync(fd); } }
  private fsyncDirectory(path: string): void { let fd: number | undefined; try { fd = this.fs.openSync(path, nodeFs.constants.O_RDONLY | NO_FOLLOW); this.validateOpenPath(fd, path, 'directory fsync target', 'directory', false); this.fs.fsyncSync(fd); } finally { if (fd !== undefined) this.fs.closeSync(fd); } }
  private roomId(input: string): string { const parsed = LowerCrockfordUlidSchema.safeParse(input); if (!parsed.success) throw new CoworkStorageError(`invalid room_id "${input}"`); return parsed.data; }
  private roomsDirectory(): string { return join(this.stateDir, 'rooms'); }
  private roomDirectory(roomId: string): string { return join(this.roomsDirectory(), roomId); }
  private metadataPath(roomId: string): string { return join(this.roomDirectory(roomId), 'room.json'); }
  private archivePath(roomId: string): string { return join(this.roomDirectory(roomId), 'archive.sqlite3'); }
  private blobsDirectory(roomId: string): string { return join(this.roomDirectory(roomId), 'blobs'); }
  private wrap(message: string, error: unknown): CoworkStorageError { return new CoworkStorageError(`${message}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
}
