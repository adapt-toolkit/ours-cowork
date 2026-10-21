import { lstatSync, readdirSync, unlinkSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';

import { MANAGEMENT_SOCKET_NAME, type CoworkConfig } from './config.ts';
import { acquireDaemonLock } from './daemon-runtime.ts';
import { unixSocketIsLive } from './transports.ts';

// Absolute end assertion also excludes filenames with a trailing newline.
const RESIDUE_NAME = /^management\.sock\.(?:safe-residue-private-alias|replacement)-[1-9][0-9]*-[a-f0-9]{12}(?![\s\S])/;

/** Caller must keep its outer writer exclusion through the subsequent archive scan. */
export async function prepareStateForBackup(config: CoworkConfig): Promise<{ removed: number }> {
  const lock = acquireDaemonLock(config.stateDir);
  try {
    const { uid, gid } = userInfo();
    const residues: string[] = [];
    for (const name of readdirSync(config.stateDir)) {
      if (name !== MANAGEMENT_SOCKET_NAME && !RESIDUE_NAME.test(name)) continue;
      const path = join(config.stateDir, name);
      const value = lstatSync(path);
      if (!value.isSocket() || value.uid !== uid || value.gid !== gid
        || (value.mode & 0o7777) !== 0o600) {
        throw new Error('cowork socket residue is not an owned private Unix socket');
      }
      if (name === MANAGEMENT_SOCKET_NAME) {
        if (await unixSocketIsLive(path)) throw new Error('management socket is still in use');
        const current = lstatSync(path);
        if (!current.isSocket() || current.dev !== value.dev || current.ino !== value.ino
          || current.uid !== uid || current.gid !== gid || (current.mode & 0o7777) !== 0o600) {
          throw new Error('management socket changed during stopped-state preparation');
        }
      }
      residues.push(path);
    }
    // Validate every matching entry before removing stopped sockets and aliases.
    for (const path of residues) unlinkSync(path);
    return { removed: residues.length };
  } finally {
    lock.release();
  }
}
