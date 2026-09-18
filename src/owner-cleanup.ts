
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import { join } from 'node:path';
import type { AttachOursClientOptions, OursClient, OwnerTerminalObservation } from '@ours.network/sdk';

export interface OwnerSelection {
  endpoint: string;
  expectedInstanceId: string;
  credentialPath: string;
}
export interface OwnerCleanupOptions { stateDir: string; selection: OwnerSelection }
export interface OwnerContext extends OwnerCleanupOptions {
  process: OwnerTerminalObservation['process'];
}
interface TerminalRecord {
  version: 1;
  selection: OwnerSelection;
  observation: OwnerTerminalObservation;
}
type AttachClient = (options: AttachOursClientOptions) => Promise<OursClient>;
const attachClient: AttachClient = async (options) => {
  const { attachOursClient } = await import('@ours.network/sdk/client');
  return attachOursClient(options);
};

/** Fixed launch inputs; an IPC registration never selects a daemon. */
export function ownerSelection(env: NodeJS.ProcessEnv): OwnerSelection | undefined {
  const endpoint = env.OURS_DAEMON_URL;
  const expectedInstanceId = env.OURS_DAEMON_ID;
  const credentialPath = env.OURS_DAEMON_CREDENTIAL_PATH;
  if (endpoint === undefined && expectedInstanceId === undefined && credentialPath === undefined) return;
  if (!endpoint || !expectedInstanceId || !credentialPath) {
    throw new Error('V1 daemon selection requires OURS_DAEMON_URL, OURS_DAEMON_ID and OURS_DAEMON_CREDENTIAL_PATH');
  }
  return { endpoint, expectedInstanceId, credentialPath };
}

/**
 * Only already-observed terminal events live here. Active owner registration
 * belongs exclusively to the supervisor's memory, never this directory.
 */
export class OwnerCleanup {
  readonly directory: string;
  private replayWork?: Promise<void>;
  constructor(private readonly options: OwnerCleanupOptions, private readonly attach: AttachClient = attachClient) {
    this.directory = join(options.stateDir, 'owner-terminal');
  }

  publish(owners: Iterable<string>, reason: OwnerTerminalObservation['reason'],
    process: OwnerTerminalObservation['process']): void {
    this.prepareDirectory();
    for (const ownerInstanceId of owners) {
      const path = join(this.directory, this.name(ownerInstanceId));
      if (fs.existsSync(path)) { this.read(path); continue; }
      const record: TerminalRecord = {
        version: 1, selection: { ...this.options.selection },
        observation: { ownerInstanceId, reason, observedAt: Date.now(), process: { ...process } },
      };
      const temporary = join(this.directory, `.terminal-${randomBytes(16).toString('hex')}.tmp`);
      let fd: number | undefined;
      try {
        fd = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY
          | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
        fs.writeFileSync(fd, JSON.stringify(record) + '\n');
        fs.closeSync(fd); fd = undefined;
        // Publish a complete file without overwriting a concurrent first event.
        try { fs.linkSync(temporary, path); }
        catch (error) { if (!hasCode(error, 'EEXIST')) throw error; this.read(path); }
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
        try { fs.unlinkSync(temporary); } catch (error) { if (!hasCode(error, 'ENOENT')) throw error; }
      }
    }
  }

  replay(): Promise<void> {
    this.replayWork ??= this.replaySerial().finally(() => { this.replayWork = undefined; });
    return this.replayWork;
  }

  private async replaySerial(): Promise<void> {
    if (!fs.existsSync(this.directory)) return;
    this.checkPrivate(this.directory, true);
    for (const name of fs.readdirSync(this.directory).filter((value) => /^[a-f0-9]{64}\.json$/.test(value)).sort()) {
      const path = join(this.directory, name);
      let record: TerminalRecord;
      try { record = this.read(path); }
      catch (error) { if (hasCode(error, 'ENOENT')) continue; throw error; }
      if (this.name(record.observation.ownerInstanceId) !== name) throw new Error('invalid terminal owner record name');
      const client = await this.attach({
        ...record.selection, sessionMode: 'external', leaseToken: record.observation.ownerInstanceId, env: {},
      });
      try {
        // Public SDK observation delivery is bounded and rejects incomplete ACKs.
        await client.releaseLease({ observation: record.observation });
        try { fs.unlinkSync(path); } catch (error) { if (!hasCode(error, 'ENOENT')) throw error; }
      } finally { await client.close(); }
    }
  }

  private name(owner: string): string { return createHash('sha256').update(owner).digest('hex') + '.json'; }
  private prepareDirectory(): void {
    try { fs.mkdirSync(this.directory, { mode: 0o700 }); }
    catch (error) { if (!hasCode(error, 'EEXIST')) throw error; }
    this.checkPrivate(this.directory, true);
  }
  private checkPrivate(path: string, directory: boolean): void {
    const stat = fs.lstatSync(path);
    if ((directory ? !stat.isDirectory() : !stat.isFile()) || stat.isSymbolicLink()
      || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) {
      throw new Error('terminal owner state must be private and owned by the current user');
    }
  }
  private read(path: string): TerminalRecord {
    this.checkPrivate(path, false);
    const fd = fs.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      if (fs.fstatSync(fd).size > 16_384) throw new Error('invalid terminal owner record size');
      const value = JSON.parse(fs.readFileSync(fd, 'utf8')) as TerminalRecord;
      if (value.version !== 1 || !value.observation || typeof value.observation.ownerInstanceId !== 'string'
        || !value.selection || typeof value.selection.endpoint !== 'string'
        || typeof value.selection.expectedInstanceId !== 'string'
        || typeof value.selection.credentialPath !== 'string') throw new Error('invalid terminal owner record');
      return value;
    } finally { fs.closeSync(fd); }
  }
}
function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
