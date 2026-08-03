import { randomBytes } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { build } from 'esbuild';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const cacheDirectory = join(
  ROOT,
  'node_modules', '.cache',
  `cowork-browser-smoke-${process.pid}-${randomBytes(6).toString('hex')}`,
);
const output = join(cacheDirectory, 'browser-smoke.mjs');

await mkdir(cacheDirectory, { recursive: true });
try {
  await build({
    entryPoints: [join(ROOT, 'tests', 'browser-smoke-entry.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    outfile: output,
    external: ['playwright-core'],
    sourcemap: false,
    logLevel: 'silent',
    define: { __COWORK_BROWSER_TEST_ROOT__: JSON.stringify(ROOT) },
  });
  await import(pathToFileURL(output).href);
  after(async () => rm(cacheDirectory, { recursive: true, force: true }));
} catch (error) {
  await rm(cacheDirectory, { recursive: true, force: true });
  throw error;
}
