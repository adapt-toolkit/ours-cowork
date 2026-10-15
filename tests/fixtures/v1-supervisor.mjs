// Test-only access to the exact child; production DaemonSupervisor owns IPC and cleanup.
import { fork } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const bundle = resolve(root, 'dist/daemon.js');
const { DaemonSupervisor } = await import(pathToFileURL(bundle));
const env = {...process.env, OURS_COWORK_DAEMON_WORKER: '1', OURS_COWORK_SUPERVISOR_PID: String(process.pid)};
delete env.NODE_OPTIONS;
const child = fork(bundle, [], {
  env, execArgv: [], detached: process.platform !== 'win32',
  stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
});
const send = message => { if (process.connected) process.send?.(message, () => {}); };
send({workerPid: child.pid});
child.once('exit', (code, signal) => send({workerExit: {code, signal}}));
const config = JSON.parse(readFileSync(process.env.OURS_COWORK_CONFIG, 'utf8'));
const ownerCleanup = {stateDir: config.stateDir, selection: {
  endpoint: process.env.OURS_DAEMON_URL,
  expectedInstanceId: process.env.OURS_DAEMON_ID,
  credentialPath: process.env.OURS_DAEMON_CREDENTIAL_PATH,
}};
const supervisor = new DaemonSupervisor({child, ownerCleanup, onStage: stage => send({stage})});
process.on('message', message => {
  if (message?.command === 'kill-exact-worker') child.kill('SIGKILL');
});
process.on('disconnect', () => supervisor.requestShutdown('SIGTERM'));
supervisor.start();
const result = await supervisor.done;
if (result.error) console.error(result.error.message);
if (process.connected) await new Promise(resolveSend => process.send({supervisorResult: {code: result.code, signal: result.signal, error: result.error?.message}}, resolveSend));
process.disconnect?.();
process.exitCode = result.error ? 1 : result.signal === 'SIGKILL' ? 0 : (result.code ?? 1);
