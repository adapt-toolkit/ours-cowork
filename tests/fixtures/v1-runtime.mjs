// Bounded versions of the process/port helpers in external-e2e.test.mjs.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, connect } from 'node:net';

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
export async function waitFor(check, description, timeout = 30000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { const result = await check(); if (result) return result; }
    catch (error) { last = error; }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${description}: ${last?.message ?? 'not ready'}`);
}
export const waitForPort = port => waitFor(() => new Promise(resolve => {
  const socket = connect({host: '127.0.0.1', port});
  socket.once('connect', () => { socket.destroy(); resolve(true); });
  socket.once('error', () => { socket.destroy(); resolve(false); });
}), `local broker ${port}`);

export function startProcess(args, env, cwd) {
  const child = spawn(process.execPath, args, {env, cwd, stdio: ['ignore', 'pipe', 'pipe']});
  const result = {child, stdout: '', stderr: ''};
  child.stdout.on('data', data => { result.stdout = (result.stdout + data).slice(-24000); });
  child.stderr.on('data', data => { result.stderr = (result.stderr + data).slice(-24000); });
  result.exited = new Promise(resolve => {
    child.once('error', error => resolve({error}));
    child.once('exit', (code, signal) => resolve({code, signal}));
  });
  return result;
}
export async function stopProcess(process, signal = 'SIGTERM') {
  if (!process || process.child.exitCode !== null || process.child.signalCode !== null) return;
  process.child.kill(signal);
  let timer;
  const outcome = await Promise.race([
    process.exited,
    new Promise(resolve => { timer = setTimeout(() => resolve(null), 8000); }),
  ]);
  clearTimeout(timer);
  if (outcome === null) {
    process.child.kill('SIGKILL');
    await process.exited;
    if (signal !== 'SIGKILL') throw new Error('Fixture process exceeded graceful shutdown bound');
  }
}
export async function command(args, env, cwd, timeout = 45000) {
  const process = startProcess(args, env, cwd);
  let timer;
  const outcome = await Promise.race([
    process.exited,
    new Promise(resolve => { timer = setTimeout(() => resolve(null), timeout); }),
  ]);
  clearTimeout(timer);
  if (outcome === null) {
    await stopProcess(process, 'SIGKILL');
    throw new Error(`Command timed out: ${args.join(' ')}\n${process.stderr}`);
  }
  if (outcome.error) throw outcome.error;
  assert.equal(outcome.code, 0, `Command ${args.join(' ')}\n${process.stdout}\n${process.stderr}`);
  return process.stdout;
}
