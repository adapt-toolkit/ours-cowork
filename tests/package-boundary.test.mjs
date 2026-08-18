import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (file) => readFile(new URL(`../${file}`, import.meta.url), 'utf8');

test('package stays an independent cowork daemon', async () => {
  const pkg = JSON.parse(await read('package.json'));
  const dependencies = { ...pkg.dependencies, ...pkg.devDependencies };

  assert.equal(pkg.name, '@ours.network/cowork');
  assert.equal(pkg.bin['ours-cowork'], 'dist/cli.js');
  assert.equal(dependencies['@ours.network/sdk'], '1.5.2');
  assert.equal('@adapt-toolkit/sdk' in dependencies, false);
  assert.equal('@adapt-toolkit/sdk-native' in dependencies, false);
  assert.equal(dependencies.zod, '^3.23.8');
  const forbiddenPackage = `@ours.network/${'mcp'}`;
  assert.equal(forbiddenPackage in dependencies, false);

  await assert.rejects(access(new URL('../.gitmodules', import.meta.url)));

  const build = await read('build.mjs');
  assert.match(build, /src\/daemon\.ts/);
  assert.match(build, /src\/cli\.ts/);
  assert.match(build, /@ours\.network\/sdk/);
  assert.doesNotMatch(build, /dist\/mufl_code/);
  assert.doesNotMatch(build, /src\/(?!daemon\.ts|cli\.ts)[\w/-]+\.ts/);
});
