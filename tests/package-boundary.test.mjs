import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (file) => readFile(new URL(`../${file}`, import.meta.url), 'utf8');

test('package stays an independent cowork daemon', async () => {
  const pkg = JSON.parse(await read('package.json'));
  const dependencies = { ...pkg.dependencies, ...pkg.devDependencies };

  assert.equal(pkg.name, '@ours.network/cowork');
  assert.equal(pkg.bin['ours-cowork'], 'dist/cli.js');
  assert.equal(dependencies['@adapt-toolkit/sdk'], '0.10.12');
  assert.equal(dependencies['@adapt-toolkit/sdk-native'], '0.10.12');
  assert.equal(dependencies.zod, '^3.23.8');
  assert.equal('@ours.network/mcp' in dependencies, false);

  const gitmodules = await read('.gitmodules');
  assert.match(gitmodules, /\[submodule "mufl_code\/core"\]/);
  assert.match(gitmodules, /path = mufl_code\/core/);
  assert.match(gitmodules, /url = https:\/\/github\.com\/adapt-toolkit\/ours-mufl-core\.git/);
  assert.equal((gitmodules.match(/^\[submodule /gm) ?? []).length, 1);

  const build = await read('build.mjs');
  assert.match(build, /src\/daemon\.ts/);
  assert.match(build, /src\/cli\.ts/);
  assert.match(build, /dist\/mufl_code/);
  assert.doesNotMatch(build, /src\/(?!daemon\.ts|cli\.ts)[\w/-]+\.ts/);
});
