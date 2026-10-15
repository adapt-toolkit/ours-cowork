import { randomBytes } from 'node:crypto';
import * as nodeFs from 'node:fs';
import { join } from 'node:path';

const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const NO_FOLLOW = nodeFs.constants.O_NOFOLLOW ?? 0;

interface OwnerRecord {
  version: 1;
  room_id: string;
  daemon_instance_id: string;
  owner_instance_id: string;
}

/**
 * Durable V1 owner ID per room for one exact shared daemon instance.
 *
 * The SDK contract keeps one external owner ID across that owner's reconnects.
 * A room host that loses its supervisor and worker together never reports a
 * terminal event, so the daemon keeps its lease. Presenting the same recorded
 * ID is a reconnect of that owner; it infers nothing about another process.
 * The record is written before the ID is first attached and removed only after
 * the daemon acknowledged its terminal release.
 */
export class RoomOwnerLedger {
  readonly directory: string;
  private readonly stateDir: string;

  constructor(
    stateDir: string,
    private readonly daemonInstanceId: string,
    private readonly fs: typeof nodeFs = nodeFs,
  ) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(daemonInstanceId)) {
      throw new Error('room owner ledger requires the selected daemon instance UUID');
    }
    this.stateDir = stateDir;
    this.directory = join(stateDir, 'room-owners');
  }

  /** The recorded owner for this room on the selected daemon, if any. */
  recorded(roomId: string): string | undefined {
    const record = this.read(roomId);
    return record?.daemon_instance_id === this.daemonInstanceId ? record.owner_instance_id : undefined;
  }

  /** Durably replace this room's owner with a fresh ID before it is attached. */
  mint(roomId: string): string {
    this.prepareDirectory();
    const record: OwnerRecord = {
      version: 1,
      room_id: roomId,
      daemon_instance_id: this.daemonInstanceId,
      owner_instance_id: `cowork-${randomBytes(16).toString('hex')}`,
    };
    const temporary = join(this.directory, `.owner-${randomBytes(16).toString('hex')}.tmp`);
    let fd: number | undefined;
    try {
      fd = this.fs.openSync(temporary, nodeFs.constants.O_CREAT | nodeFs.constants.O_EXCL | nodeFs.constants.O_WRONLY | NO_FOLLOW, FILE_MODE);
      this.fs.writeFileSync(fd, JSON.stringify(record) + '\n');
      this.fs.fsyncSync(fd);
      this.fs.closeSync(fd); fd = undefined;
      this.fs.renameSync(temporary, this.path(roomId));
    } catch (error) {
      if (fd !== undefined) try { this.fs.closeSync(fd); } catch { /* original failure wins */ }
      try { this.fs.unlinkSync(temporary); } catch { /* original failure wins */ }
      throw error;
    }
    this.fsync(this.directory);
    return record.owner_instance_id;
  }

  /** Drop a terminally released owner; a later host must mint a distinct ID. */
  forget(roomId: string, ownerInstanceId: string): void {
    if (this.read(roomId)?.owner_instance_id !== ownerInstanceId) return;
    this.fs.unlinkSync(this.path(roomId));
    this.fsync(this.directory);
  }

  private path(roomId: string): string {
    if (!/^[0-7][0-9a-hjkmnp-tv-z]{25}$/.test(roomId)) throw new Error(`invalid room id "${roomId}"`);
    return join(this.directory, `${roomId}.json`);
  }

  private read(roomId: string): OwnerRecord | undefined {
    const path = this.path(roomId);
    if (!this.checkDirectory()) return undefined;
    let fd: number | undefined;
    try {
      fd = this.fs.openSync(path, nodeFs.constants.O_RDONLY | NO_FOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    try {
      const stat = this.fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== FILE_MODE || stat.size > 4096
        || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
        throw new Error('room owner record must be a private 0600 single-link regular file');
      }
      const value = JSON.parse(this.fs.readFileSync(fd, 'utf8')) as OwnerRecord;
      if (value.version !== 1 || value.room_id !== roomId
        || typeof value.daemon_instance_id !== 'string'
        || typeof value.owner_instance_id !== 'string'
        || !/^cowork-[0-9a-f]{32}$/.test(value.owner_instance_id)) {
        throw new Error('invalid room owner record');
      }
      return value;
    } finally { this.fs.closeSync(fd); }
  }

  private prepareDirectory(): void {
    try { this.fs.mkdirSync(this.directory, { mode: DIRECTORY_MODE }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    if (!this.checkDirectory()) throw new Error('room owner state directory disappeared');
    // Always confirm the directory entry itself: an earlier attempt may have
    // created it and then failed before this point.
    this.fsync(this.stateDir);
  }

  /** Fail closed on anything but a private owned directory; absent is empty. */
  private checkDirectory(): boolean {
    let stat: nodeFs.Stats;
    try { stat = this.fs.lstatSync(this.directory); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0
      || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
      throw new Error('room owner state must be private and owned by the current user');
    }
    return true;
  }

  private fsync(directory: string): void {
    let fd: number | undefined;
    try {
      fd = this.fs.openSync(directory, nodeFs.constants.O_RDONLY | NO_FOLLOW);
      this.fs.fsyncSync(fd);
    } finally { if (fd !== undefined) this.fs.closeSync(fd); }
  }
}
