// One contender process: spin until the shared start file appears, then try once.
import { existsSync } from 'node:fs';
import { acquireSupervisorLock, SupervisorAlreadyRunningError } from '../../src/supervisor-lock.ts';

const [stateDir, go] = process.argv.slice(2);
while (!existsSync(go)) { /* tight start barrier */ }
let outcome;
try { acquireSupervisorLock(stateDir); outcome = 'acquired'; }
catch (error) { outcome = error instanceof SupervisorAlreadyRunningError ? 'refused' : `error: ${error.message}`; }
process.send(outcome);
// Stay alive as the holder until the parent has counted every outcome.
process.once('message', () => process.exit(0));
