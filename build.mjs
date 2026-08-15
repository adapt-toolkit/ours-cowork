import { build as esbuild } from 'esbuild';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as vite } from 'vite';

const root = dirname(fileURLToPath(import.meta.url));
const dist = resolve(root, 'dist');
const runtimeEntries = ['src/daemon.ts', 'src/cli.ts'];

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await vite({ configFile: resolve(root, 'vite.config.ts') });

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  external: ['@ours.network/sdk', '@ours.network/sdk/*'],
  logLevel: 'info',
};

const daemonBuild = await esbuild({
  ...shared,
  entryPoints: [resolve(root, runtimeEntries[0])],
  outfile: resolve(dist, 'daemon.js'),
  metafile: true,
});
const daemonImports = Object.values(daemonBuild.metafile.outputs).flatMap((output) => output.imports);
const eagerSdkImport = daemonImports.find(({ path, kind }) =>
  path.startsWith('@ours.network/sdk') && kind !== 'dynamic-import');
if (eagerSdkImport) {
  throw new Error(`daemon supervisor eagerly imports SDK runtime: ${eagerSdkImport.path}`);
}
await esbuild({ ...shared, entryPoints: [resolve(root, runtimeEntries[1])], outfile: resolve(dist, 'cli.js') });
