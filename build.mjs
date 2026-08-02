import { build } from 'esbuild';
import { copyFile, mkdir, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const dist = resolve(root, 'dist');
const runtimeEntries = ['src/daemon.ts', 'src/cli.ts', 'dist/mufl_code'];

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  external: ['@adapt-toolkit/sdk', '@adapt-toolkit/sdk/*', '@adapt-toolkit/sdk-native'],
  logLevel: 'info',
};

await build({ ...shared, entryPoints: [resolve(root, runtimeEntries[0])], outfile: resolve(dist, 'daemon.js') });
await build({ ...shared, entryPoints: [resolve(root, runtimeEntries[1])], outfile: resolve(dist, 'cli.js') });

const muflSource = resolve(root, 'mufl_code');
if (existsSync(muflSource)) {
  const packets = (await readdir(muflSource)).filter((name) => name.endsWith('.muflo'));
  if (packets.length > 1) throw new Error('expected at most one compiled MUFL packet');
  if (packets.length === 1) {
    const destination = resolve(root, runtimeEntries[2]);
    await mkdir(destination, { recursive: true });
    await copyFile(resolve(muflSource, packets[0]), resolve(destination, packets[0]));
  }
}
