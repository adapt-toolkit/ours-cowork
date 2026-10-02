import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CoworkDaemon } from '../src/daemon-runtime.ts';

const A = '01jz6y7n8p9q0r1s2t3v4w5x6y';
const B = '01jz6y7n8p9q0r1s2t3v4w5x6z';
const tick = () => new Promise(resolve => setImmediate(resolve));
function gate() { let release; const work = new Promise(resolve => { release = resolve; }); return { work, release }; }
function rpc(path, method, params = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(path);
    let bytes = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(JSON.stringify({ version: 1, id: method, method, params }) + '\n'));
    socket.on('data', chunk => { bytes += chunk; if (bytes.includes('\n')) socket.end(); });
    socket.on('end', () => resolve(JSON.parse(bytes)));
    socket.on('error', reject);
  });
}
function fixture(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cowork-fairness-'));
  const events = [];
  const socketPath = join(dir, 'management.sock');
  const service = {
    async recoverPacket(id) { events.push(`restore:${id}`); },
    async reconcileRoom(id) { events.push(`reconcile:${id}`); },
    async closeRoom(id) { events.push(`close:${id}`); },
    async resumePending(id) { events.push(`fanout:${id}`); },
    async notifyRoom(id) { events.push(`notify:${id}`); },
    async listRooms() { events.push('rooms.mutated'); return []; },
    async createInvite() { events.push('invite.mutated'); return {}; },
    beginShutdown() { events.push('intake.stop'); },
    async drain() { events.push('service.drain'); },
    ...overrides,
  };
  const daemon = new CoworkDaemon({
    config: { version: 1, stateDir: dir, rest: { enabled: false, port: 3010 } },
    prepare: () => ({ socketPath }), lock: () => ({ release() { events.push('lock.release'); } }),
    host: { async boot() {}, close() { events.push('host.close'); } },
    store: { async list() { return [A, B].map(room_id => ({ room_id, state: 'active' })); } },
    registry: { async unhostAll() { events.push('unhost'); }, async unhost() {} },
    service, writePid() { events.push('pid'); }, removePid() {},
  });
  return { dir, events, daemon, socketPath };
}

test('recovery management is available during blocked restore and gates public/private room routes', async () => {
  const restore = gate(); const entered = gate();
  const f = fixture({ async recoverPacket() { entered.release(); await restore.work; } });
  const boot = f.daemon.boot();
  try {
    await entered.work;
    assert.equal(existsSync(f.socketPath), true, 'management must listen before blocked room restore');
    const status = await rpc(f.socketPath, 'daemon.recovery');
    assert.equal(status.result.ready, false);
    assert.equal(status.result.phase, 'restore');
    assert.equal(JSON.stringify(status).includes(A), false, 'status must contain no room identity');
    for (const method of ['room.list', 'room.invite', 'room.accept']) {
      const result = await rpc(f.socketPath, method, { room_id: A });
      assert.match(result.error.message, /recover/i, `${method} must reject during recovery before service validation/effects`);
    }
    assert.equal(f.events.includes('invite.mutated'), false);
    assert.equal(f.events.includes('rooms.mutated'), false);
  } finally {
    restore.release(); await boot; await f.daemon.shutdown(); rmSync(f.dir, { recursive: true, force: true });
  }
});

test('blocked fanout does not delay another recovered room, readiness, or management; cleanup waits it', async () => {
  const fanout = gate(); const entered = gate();
  const f = fixture({ async resumePending(id) { f.events.push(`fanout:${id}`); if (id === A) { entered.release(); await fanout.work; f.events.push('A.completed'); } } });
  const boot = f.daemon.boot();
  let bootDone = false; void boot.then(() => { bootDone = true; });
  try {
    await entered.work; await tick();
    assert.equal(f.events.includes(`fanout:${B}`), true, 'room B must start without waiting for blocked A');
    assert.equal(bootDone, true, 'boot must not await queued fanout');
    assert.equal(f.events.includes('pid'), true);
    const status = await rpc(f.socketPath, 'daemon.recovery');
    assert.equal(status.result.ready, true);
    assert.equal(status.result.phase, 'fanout');
    const stopping = f.daemon.shutdown(); await tick();
    assert.equal(f.events.includes('unhost'), false, 'cleanup must wait startup work even if service.drain is a fake no-op');
    fanout.release(); await stopping;
    assert.ok(f.events.indexOf('A.completed') < f.events.indexOf('unhost'));
  } finally {
    fanout.release(); await boot; await f.daemon.shutdown(); rmSync(f.dir, { recursive: true, force: true });
  }
});

test('shutdown during early recovery never publishes readiness or starts fanout', async () => {
  const restore = gate(); const entered = gate();
  const f = fixture({ async recoverPacket() { entered.release(); await restore.work; } });
  const boot = f.daemon.boot();
  const rejected = assert.rejects(boot, /cancel|shutdown/);
  try {
    await entered.work;
    const stop = f.daemon.shutdown(); restore.release();
    await rejected; await stop;
    assert.equal(f.events.includes('pid'), false);
    assert.equal(f.events.some(event => event.startsWith('fanout:')), false);
    assert.equal(existsSync(f.socketPath), false);
  } finally { restore.release(); await f.daemon.shutdown(); rmSync(f.dir, { recursive: true, force: true }); }
});
