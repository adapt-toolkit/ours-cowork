import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { defaultConfig, ensureRuntimeState, loadConfig } from '../src/config.ts';

test('default configuration enables the loopback web host on port 3052', () => {
  assert.deepEqual(defaultConfig('/home/demo').rest, { enabled: true, port: 3052 });
});

test('runtime state does not create or expose a management token', (t) => {
  const stateDir = mkdtempSync(join(tmpdir(), 'cowork-runtime-no-token-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const config = { ...defaultConfig('/home/demo'), stateDir };

  const runtime = ensureRuntimeState(config);

  assert.equal('tokenPath' in runtime, false);
  assert.equal('token' in runtime, false);
  assert.equal(existsSync(join(stateDir, 'management-token')), false);
});

test('an explicitly disabled REST configuration remains disabled', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cowork-config-disabled-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify({
    version: 1,
    brokerUrl: 'ws://127.0.0.1:3000',
    stateDir: join(dir, 'state'),
    rest: { enabled: false, port: 3052 },
  }), { mode: 0o600 });

  const config = loadConfig({ OURS_COWORK_CONFIG: path });

  assert.deepEqual(config.rest, { enabled: false, port: 3052 });
});
