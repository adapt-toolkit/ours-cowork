import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (file) => readFile(new URL(`../${file}`, import.meta.url), 'utf8');

test('package stays an independent cowork daemon', async () => {
  const pkg = JSON.parse(await read('package.json'));
  const lock = JSON.parse(await read('package-lock.json'));
  const dependencies = { ...pkg.dependencies, ...pkg.devDependencies };

  assert.equal(pkg.name, '@ours.network/cowork');
  assert.equal(pkg.bin['ours-cowork'], 'dist/cli.js');
  assert.equal(dependencies['@ours.network/sdk'], 'file:vendor/ours.network-sdk.tgz');
  assert.equal(pkg.devDependencies['@ours.network/cli'], 'file:vendor/ours.network-cli.tgz');
  assert.equal(dependencies['better-sqlite3'], '13.0.3');
  assert.equal(lock.packages['node_modules/better-sqlite3'].version, dependencies['better-sqlite3']);
  assert.equal('@adapt-toolkit/sdk' in dependencies, false);
  assert.equal('@adapt-toolkit/sdk-native' in dependencies, false);
  assert.equal(dependencies.zod, '^3.23.8');
  const forbiddenPackage = `@ours.network/${'mcp'}`;
  assert.equal(forbiddenPackage in dependencies, false);

  const sdkVersion = lock.packages['node_modules/@ours.network/sdk'].version;
  const sdkMajor = sdkVersion.split('.')[0];
  const cliVersion = lock.packages['node_modules/@ours.network/cli'].version;
  assert.equal(sdkVersion, '3.7.2');
  assert.equal(cliVersion, '2.7.2');
  const publicDocs = {
    README: await read('README.md'),
    prerequisites: await read('docs/01-prerequisites.md'),
    installation: await read('docs/02-installation.md'),
    configuration: await read('docs/03-configuration.md'),
  };
  assert(publicDocs.README.includes(`@ours.network/sdk\` ${sdkMajor}`));
  assert(publicDocs.README.includes('selected V1 `@ours.network/cli`'));
  assert(publicDocs.prerequisites.includes('selected V1 `@ours.network/sdk` artifact'));
  assert.match(publicDocs.prerequisites, new RegExp(`@ours\\.network/cli@${cliVersion.replaceAll('.', '\\.')}`));
  assert.match(publicDocs.installation, new RegExp(`@ours\\.network/cli@${cliVersion.replaceAll('.', '\\.')}`));
  assert.match(publicDocs.configuration, /OURS_DAEMON_URL/);
  assert.match(publicDocs.configuration, /OURS_DAEMON_ID/);
  assert.match(publicDocs.configuration, /OURS_DAEMON_CREDENTIAL_PATH/);

  await assert.rejects(access(new URL('../.gitmodules', import.meta.url)));

  const build = await read('build.mjs');
  assert.match(build, /src\/daemon\.ts/);
  assert.match(build, /src\/cli\.ts/);
  assert.match(build, /@ours\.network\/sdk/);
  assert.doesNotMatch(build, /dist\/mufl_code/);
  assert.doesNotMatch(build, /src\/(?!daemon\.ts|cli\.ts)[\w/-]+\.ts/);
});
