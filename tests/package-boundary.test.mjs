import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (file) => readFile(new URL(`../${file}`, import.meta.url), 'utf8');

test('package stays an independent cowork daemon', async () => {
  const pkg = JSON.parse(await read('package.json'));
  const dependencies = { ...pkg.dependencies, ...pkg.devDependencies };

  assert.equal(pkg.name, '@ours.network/cowork');
  assert.equal(pkg.bin['ours-cowork'], 'dist/cli.js');
  assert.equal(dependencies['@ours.network/sdk'], '3.5.0');
  assert.equal(pkg.devDependencies['@ours.network/cli'], '2.5.0');
  assert.equal('@adapt-toolkit/sdk' in dependencies, false);
  assert.equal('@adapt-toolkit/sdk-native' in dependencies, false);
  assert.equal(dependencies.zod, '^3.23.8');
  const forbiddenPackage = `@ours.network/${'mcp'}`;
  assert.equal(forbiddenPackage in dependencies, false);

  const sdkVersion = dependencies['@ours.network/sdk'];
  const sdkMajor = sdkVersion.split('.')[0];
  const cliVersion = pkg.devDependencies['@ours.network/cli'];
  const publicDocs = {
    README: await read('README.md'),
    prerequisites: await read('docs/01-prerequisites.md'),
    installation: await read('docs/02-installation.md'),
    configuration: await read('docs/03-configuration.md'),
  };
  assert(publicDocs.README.includes(`@ours.network/sdk\` ${sdkMajor}`));
  assert(publicDocs.README.includes(`@ours.network/cli\` ${cliVersion}`));
  assert(publicDocs.prerequisites.includes(`@ours.network/sdk\` ${sdkVersion}`));
  assert.match(publicDocs.prerequisites, new RegExp(`@ours\\.network/cli@${cliVersion.replaceAll('.', '\\.')}`));
  assert.match(publicDocs.installation, new RegExp(`@ours\\.network/cli@${cliVersion.replaceAll('.', '\\.')}`));
  assert.match(publicDocs.configuration, new RegExp(`SDK ${sdkMajor}\\b`));

  await assert.rejects(access(new URL('../.gitmodules', import.meta.url)));

  const build = await read('build.mjs');
  assert.match(build, /src\/daemon\.ts/);
  assert.match(build, /src\/cli\.ts/);
  assert.match(build, /@ours\.network\/sdk/);
  assert.doesNotMatch(build, /dist\/mufl_code/);
  assert.doesNotMatch(build, /src\/(?!daemon\.ts|cli\.ts)[\w/-]+\.ts/);
});
