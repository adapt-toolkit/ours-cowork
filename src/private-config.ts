import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, isAbsolute } from 'node:path';

/** Read bounded owner-only configuration without following the final symlink. */
export function readPrivateConfigFile(path: string, maximum: number): Buffer {
  if (!isAbsolute(path)) throw new Error('consumer configuration file paths must be absolute');
  const fd = fs.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())
      || stat.size > maximum) throw new Error('consumer configuration file must be bounded, owner-owned and mode 0600');
    const data = Buffer.alloc(maximum + 1);
    let offset = 0;
    for (;;) {
      const count = fs.readSync(fd, data, offset, data.length - offset, null);
      offset += count;
      if (offset > maximum) throw new Error('consumer configuration file exceeds its size limit');
      if (!count) return data.subarray(0, offset);
    }
  } finally { fs.closeSync(fd); }
}

/** Only a host-selected path in an owner-private directory can receive credentials. */
export function writePrivateConfigFile(path: string, data: string): void {
  if (!isAbsolute(path)) throw new Error('credential path must be absolute');
  const parent = dirname(path);
  const stat = fs.lstatSync(parent);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0
    || (process.getuid && stat.uid !== process.getuid())) throw new Error('credential directory must be owner-private');
  // Check an existing target before replacing it; never follow a final symlink.
  try { readPrivateConfigFile(path, 4096); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const temporary = join(parent, `.consumer-token-${randomUUID()}`);
  let renamed = false;
  const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  try {
    fs.writeFileSync(fd, data, 'utf8');
    fs.fsyncSync(fd);
    fs.renameSync(temporary, path);
    renamed = true;
    const directory = fs.openSync(parent, fs.constants.O_RDONLY);
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  } finally {
    fs.closeSync(fd);
    if (!renamed) fs.unlinkSync(temporary);
  }
}
