import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { prepareStateForBackup } from '../src/state-maintenance.ts';

test('backup preparation retains a live primary socket and removes its stopped residue', async () => {
  const stateDir = fs.mkdtempSync(join(tmpdir(), 'cowork-backup-'));
  const path = join(stateDir, 'management.sock');
  const config = { version: 1, stateDir, rest: { enabled: false, port: 3052 } };
  const server = net.createServer(socket => socket.end());
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
    fs.chmodSync(path, 0o600);
    await assert.rejects(async () => prepareStateForBackup(config), /live|in use/);
    assert.ok(fs.lstatSync(path).isSocket());
    await new Promise(resolve => server.close(resolve));
    execFileSync(process.execPath, ['-e', "require('net').createServer().listen(process.argv[1],()=>process.exit(0))", path]);
    fs.chmodSync(path, 0o600);
    assert.equal((await prepareStateForBackup(config)).removed, 1);
    assert.equal(fs.existsSync(path), false);
    assert.equal((await prepareStateForBackup(config)).removed, 0);
  } finally {
    if (server.listening) await new Promise(resolve => server.close(resolve));
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
