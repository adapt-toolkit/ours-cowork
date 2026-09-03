import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, extname, join, relative, resolve, sep } from 'node:path';
import test from 'node:test';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json', '.sh',
  '.css', '.html', '.mu', '.mm', '.mufl', '.muflo', '.yml', '.yaml',
]);
const SKIPPED_SOURCE_TREES = new Set([
  '.git', '.superpowers', 'node_modules', 'dist', 'docs', join('mufl_code', 'core'),
]);
const STATIC_GATE_PATH = 'tests/static-gates.test.mjs';
const REMOTE_PARTICIPANT_SENTENCE = 'Ordinary ours-mcp identities can join only as remote participants over the ours protocol.';
const WEB_RELEASE_ARTIFACTS = [
  'dist/web/index.html',
  'dist/web/assets/app.js',
  'dist/web/assets/app.css',
];
const INERT_BUNDLED_URL_PREFIXES = [
  'http://www.w3.org/1998/Math/MathML',
  'http://www.w3.org/1999/xhtml',
  'http://www.w3.org/1999/xlink',
  'http://www.w3.org/2000/svg',
  'http://www.w3.org/XML/1998/namespace',
  'https://reactjs.org/docs/error-decoder.html',
];
const MAIN_TEST_SCRIPT = 'node --import tsx --test --test-concurrency=1 tests/*.test.mjs';
const DOC_NAMES = Array.from({ length: 11 }, (_, index) => `docs/${String(index + 1).padStart(2, '0')}-${[
  'prerequisites', 'installation', 'configuration', 'daemon-lifecycle', 'room-workflow',
  'invites', 'messaging-history', 'backup-restore', 'service-management', 'limitations', 'web-console',
][index]}.md`);

function normalized(path) {
  return relative(ROOT, path).split(sep).join('/');
}

function mainTestRunnerViolations(script, devDependencies) {
  const args = script.trim().split(/\s+/);
  const violations = [];
  if (script !== MAIN_TEST_SCRIPT) violations.push('main test command must preserve the exact Node 22 multi-file runner');
  const importIndex = args.indexOf('--import');
  if (args[0] !== 'node' || importIndex < 0 || !args[importIndex + 1]) {
    violations.push('main test command must declare a Node --import loader');
  } else if (!Object.hasOwn(devDependencies, args[importIndex + 1])) {
    violations.push('main test loader must be a declared direct dev dependency');
  }
  if (args.some((arg) => arg === '--loader' || arg.startsWith('--loader=') ||
    arg === '--experimental-loader' || arg.startsWith('--experimental-loader='))) {
    violations.push('main test command must not use an experimental loader flag');
  }
  return violations;
}

function filesBelow(directory, extensions) {
  const output = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...filesBelow(path, extensions));
    else if (extensions === undefined || extensions.has(extname(entry.name))) output.push(path);
  }
  return output;
}

function discoverOwnedSource() {
  const output = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const target = normalized(path);
      if (entry.isDirectory()) {
        if (![...SKIPPED_SOURCE_TREES].some((skip) => target === skip || target.startsWith(`${skip}/`))) visit(path);
      } else if (target.startsWith('tests/') || SOURCE_EXTENSIONS.has(extname(entry.name)) || basename(path) === '.gitmodules') {
        output.push(path);
      }
    }
  }
  visit(ROOT);
  return output.sort();
}

function boundaryViolations(path, source) {
  const compact = source.replace(/\s+/g, ' ');
  const violations = [];
  const rules = [
    [/@ours\.network\s*\/\s*mcp|\bours-mcp\b/i, 'ours-mcp package or path reference'],
    [/\b(?:register|registration|registered|registering)\b[\s\S]{0,160}\bmcp\b|\bmcp\b[\s\S]{0,160}\b(?:register|registration|registered|registering)\b/i, 'MCP registration'],
    [/(?:\b(?:put|move|define|implement|host)\w*\b.{0,100}\b(?:mission[ -]?room|room)\b.{0,100}\b(?:into|inside|in|on)\b.{0,40}\b(?:shared[ -]?core|ours-mufl-core|a2a_(?:messaging|protocol))\b)|(?:\b(?:shared[ -]?core|ours-mufl-core|a2a_(?:messaging|protocol))\b\s+(?:must\s+|should\s+|will\s+)?(?:owns?|implements?|defines?|hosts?)\b.{0,80}\b(?:mission[ -]?room|room)\b)/i, 'shared-core room semantics'],
  ];
  for (const [pattern, label] of rules) if (pattern.test(compact)) violations.push(`${path}: ${label}`);
  return violations;
}

function structuralTestHarnessViolations(path, source) {
  const violations = [];
  const actualExternalReference = /(?:\bimport\s*\(\s*['"`][^'"`]{0,240}(?:ours-mcp|@ours\.network\s*\/\s*mcp)[^'"`]*['"`]\s*\)|\bimport\s+(?:[^'";]{0,160}\bfrom\s*)?['"][^'"\n]{0,240}(?:ours-mcp|@ours\.network\s*\/\s*mcp)[^'"\n]*['"]|\brequire\s*\(\s*['"`][^'"`]{0,240}(?:ours-mcp|@ours\.network\s*\/\s*mcp)[^'"`]*['"`]\s*\))/is;
  const externalProcess = /\b(?:spawn|spawnSync|exec|execFile|execFileSync|fork)\s*\([^)]{0,240}(?:ours-mcp|@ours\.network\s*\/\s*mcp)/is;
  if (actualExternalReference.test(source)) violations.push(`${path}: imports an external daemon`);
  if (externalProcess.test(source)) violations.push(`${path}: starts an external daemon`);
  return violations;
}

function webReleaseViolations(path, source) {
  const violations = boundaryViolations(path, source);
  const remoteUrls = source.match(/\b(?:https?|wss?):\/\/[^\s"'`<>\\)]+/gi) ?? [];
  for (const url of remoteUrls) {
    if (!INERT_BUNDLED_URL_PREFIXES.some((prefix) => url.startsWith(prefix))) {
      violations.push(`${path}: remote URL ${url}`);
    }
  }
  if (/\b(?:localStorage|sessionStorage|indexedDB)\b|\bdocument\s*\.\s*cookie\b|\bcaches\s*\.\s*open\s*\(/i.test(source)) {
    violations.push(`${path}: browser persistence could retain secret or token material`);
  }
  if (/\bsourceMappingURL\s*=|\bsourcesContent\b/.test(source) || extname(path) === '.map') {
    violations.push(`${path}: source map material`);
  }
  if (/management-token|authorization\s*:\s*["'`]?(?:bearer|basic)\b/i.test(source)) {
    violations.push(`${path}: management credential reference`);
  }
  return violations;
}

function testHarnessViolations(path, source) {
  // Tests, helpers, and fixture data get the same broad source boundary as
  // production. Structural checks are defense in depth, not the mechanism
  // that detects variable/data-fed process paths.
  return [...boundaryViolations(path, source), ...structuralTestHarnessViolations(path, source)];
}

function documentationViolations(path, source, limitations = false) {
  const violations = [];
  for (const line of source.match(/^.*ours-mcp.*$/gim) ?? []) {
    if (line.trim() !== REMOTE_PARTICIPANT_SENTENCE) {
      violations.push(`${path}: ours-mcp may only be described by the remote-participant exception`);
    }
  }
  if (!limitations && /\bdelivered\b|remotely purged|\bkey wipe\b|secure eras(?:e|ure)|\bexactly[ -]once\b/i.test(source)) {
    violations.push(`${path}: forbidden reliability or erasure claim`);
  }
  return violations;
}

function dependencyNames(manifest) {
  return ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']
    .flatMap((field) => Object.keys(manifest[field] ?? {}));
}

test('independence rules reject multiline and package/path bypasses without semantic false positives', () => {
  for (const source of [
    "import '@ours.network/mcp'",
    '"cowork-peer": "file:../ours-mcp"',
    "import '../../ours-mcp/src/server.js'",
    'register\n this daemon as an\n MCP server',
    'MCP\n registration for this daemon',
    'put mission-room policy\n into ours-mufl-core',
    'a2a_messaging owns\n room admission semantics',
  ]) assert.equal(boundaryViolations('synthetic.ts', source).length, 1, source);
  for (const source of [
    "const label = 'mcp'; const room = localRoom();",
    'Shared protocol behavior stays in ours-mufl-core libraries. This actor owns only the room inbox.',
    'The room imports generic a2a_messaging transactions without changing shared semantics.',
  ]) assert.deepEqual(boundaryViolations('synthetic.ts', source), [], source);
  assert(testHarnessViolations('tests/e2e.test.mjs', "const peer = await import('../../ours-mcp/peer.js')").length > 0);
  const directModuleLoads = [
    "import('../../ours-mcp/peer.js')",
    "void import('@ours.network/mcp')",
    "require('../../ours-mcp/peer.js')",
  ];
  for (const source of directModuleLoads) {
    assert(structuralTestHarnessViolations('tests/fixtures/helper.mjs', source).length > 0, source);
  }
  for (const source of [
    ...directModuleLoads,
    "const executable = '../../ours-mcp/daemon.js'; spawn(process.execPath, [executable]);",
    "export const peerDaemon = '../../ours-mcp/daemon.js';",
  ]) assert(testHarnessViolations('tests/fixtures/helper.mjs', source).length > 0, source);
  const directSpawn = `${'sp' + 'awn'}(process.execPath, ['../${'ours' + '-mcp'}/daemon.js'])`;
  assert(structuralTestHarnessViolations('tests/e2e.test.mjs', directSpawn).length > 0);
  assert(testHarnessViolations(
    'tests/e2e.test.mjs',
    directSpawn,
  ).length > 0);
  assert(testHarnessViolations('tests/helper.mjs', REMOTE_PARTICIPANT_SENTENCE).length > 0,
    'the documentation-only participant wording is forbidden in executable test source');
});

test('documentation gate permits exactly the narrow remote-participant sentence', () => {
  assert.deepEqual(documentationViolations('README.md', REMOTE_PARTICIPANT_SENTENCE), []);
  assert.equal(documentationViolations('README.md', 'ours-mcp hosts cowork rooms.').length, 1);
  assert.equal(documentationViolations('README.md', 'Messages are delivered exactly-once.').length, 1);
  assert.deepEqual(documentationViolations('docs/10-limitations.md', 'No exactly once guarantee; no key wipe or secure erase.', true), []);
});

test('web release gate detects standalone, remote URL, persistence, and source-map violations', () => {
  assert(webReleaseViolations('web/bad.ts', "import '@ours.network/mcp'").length > 0);
  assert(webReleaseViolations('web/bad.ts', "const endpoint = 'https://example.invalid/api'").length > 0);
  assert(webReleaseViolations('web/bad.ts', "localStorage.setItem('invite-secret', value)").length > 0);
  assert(webReleaseViolations('dist/web/assets/app.js', '//# sourceMappingURL=app.js.map').length > 0);
  assert(webReleaseViolations('dist/web/assets/app.js', "const path = 'management-token'").length > 0);
  assert.deepEqual(webReleaseViolations('dist/web/assets/app.js', "const namespace = 'http://www.w3.org/2000/svg'"), []);

  const sourceFiles = filesBelow(join(ROOT, 'web'));
  assert.deepEqual(sourceFiles.flatMap((path) =>
    webReleaseViolations(normalized(path), readFileSync(path, 'utf8'))), []);
});

test('recursive owned-source discovery covers configs, scripts, tests, and fixtures while excluding dependency trees', () => {
  const sourceFiles = discoverOwnedSource();
  const targets = sourceFiles.map(normalized);
  for (const expected of [
    '.github/workflows/ci.yml', 'build.mjs', 'package.json', 'package-lock.json',
    'src/daemon.ts', 'src/ours-runtime.ts', 'tests/e2e.test.mjs',
    'tests/sdk-runtime.test.mjs', 'tsconfig.json',
  ]) assert(targets.includes(expected), `source discovery omitted ${expected}`);
  assert(targets.every((path) => !path.startsWith('mufl_code/core/')));
  assert.deepEqual(sourceFiles.flatMap((path) => {
    const target = normalized(path);
    const source = readFileSync(path, 'utf8');
    if (target === STATIC_GATE_PATH) return [];
    return target.startsWith('tests/') ? testHarnessViolations(target, source) : boundaryViolations(target, source);
  }), []);

  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(dependencyNames(manifest).some((name) => /@ours\.network\s*\/\s*mcp|ours-mcp/i.test(name)), false);
});

test('README and every operator document preserve the exact wording boundary', () => {
  const documentationFiles = [join(ROOT, 'README.md'), ...DOC_NAMES.map((path) => join(ROOT, path))];
  assert.deepEqual(documentationFiles.flatMap((path) => documentationViolations(
    normalized(path), readFileSync(path, 'utf8'), normalized(path) === 'docs/10-limitations.md',
  )), []);
  assert.doesNotMatch(documentationFiles.map((path) => readFileSync(path, 'utf8')).join('\n'), /management-token/i);
});

test('built distribution remains standalone and delegates packet ownership to the public SDK', () => {
  const distFiles = filesBelow(join(ROOT, 'dist'), new Set(['.js', '.json']));
  assert.deepEqual(distFiles.flatMap((path) => boundaryViolations(normalized(path), readFileSync(path, 'utf8'))), []);
  assert.doesNotMatch(distFiles.map((path) => readFileSync(path, 'utf8')).join('\n'), /management-token/i);
  const builtWebFiles = filesBelow(join(ROOT, 'dist', 'web'));
  assert.deepEqual(builtWebFiles.flatMap((path) =>
    webReleaseViolations(normalized(path), readFileSync(path, 'utf8'))), []);
  assert.deepEqual(WEB_RELEASE_ARTIFACTS.filter((path) => !builtWebFiles.map(normalized).includes(path)), []);
  assert.match(readFileSync(join(ROOT, 'dist', 'cli.js'), 'utf8'), /room_name/);
  assert.match(readFileSync(join(ROOT, 'dist', 'cli.js'), 'utf8'), /--name/);
  assert.match(readFileSync(join(ROOT, 'dist', 'web', 'assets', 'app.js'), 'utf8'), /room_name/);
  assert.equal(existsSync(join(ROOT, 'dist', 'mufl_code')), false);
  const daemon = readFileSync(join(ROOT, 'dist', 'daemon.js'), 'utf8');
  assert.match(daemon, /attachOursClient/);
  assert.doesNotMatch(daemon, /@ours\.network\/sdk\/daemon|startDaemon|OURS_UNIT_DIR/);
});

test('npm dry-run pack list is the exact standalone release artifact', () => {
  const output = execFileSync('npm', ['pack', '--json', '--dry-run'], { cwd: ROOT, encoding: 'utf8' });
  const packs = JSON.parse(output);
  assert.equal(packs.length, 1);
  const paths = packs[0].files.map((file) => file.path).sort();
  assert.equal(paths.some((path) => path.startsWith('docs/superpowers/')), false);
  assert.equal(paths.some((path) => path.startsWith('dist/mufl_code/')), false);
  for (const required of WEB_RELEASE_ARTIFACTS) assert(paths.includes(required), `package omitted ${required}`);
  assert.equal(paths.filter((path) => path.endsWith('.muflo')).length, 0);
  const expected = [
    'LICENSE', 'README.md', 'dist/cli.js', 'dist/daemon.js', 'package.json',
    ...WEB_RELEASE_ARTIFACTS, ...DOC_NAMES,
  ].sort();
  assert.deepEqual(paths, expected);
  assert.equal(paths.some((path) => /(?:^|\/)(?:src|tests)(?:\/|$)|secret|token|identity\.key|state_data\.bin/i.test(path)), false);
  for (const path of paths.filter((candidate) => !candidate.endsWith('.muflo'))) {
    const source = readFileSync(join(ROOT, path), 'utf8');
    if (path === 'README.md' || path.startsWith('docs/')) {
      assert.deepEqual(documentationViolations(path, source, path === 'docs/10-limitations.md'), []);
    } else {
      assert.deepEqual(boundaryViolations(path, source), []);
    }
  }
});

test('CI repeats E2E and invokes the asserted release gate', () => {
  const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(workflow, /for i in 1 2 3; do node --test tests\/e2e\.test\.mjs \|\| exit 1; done/);
  assert.match(workflow, /npm run test:release/);
  assert.match(workflow, /COWORK_CHROME_PATH:\s*\/usr\/bin\/google-chrome/);
  for (const command of ['npm run typecheck:web', 'npm run test:web', 'npm run test:browser']) {
    assert(workflow.includes(command), `${command} missing from CI`);
  }
  assert(workflow.indexOf('npm run test:browser') < workflow.indexOf('for i in 1 2 3;'));
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(manifest.scripts.test, MAIN_TEST_SCRIPT);
  assert.equal(manifest.devDependencies.tsx, '4.23.1');
  assert.equal(manifest.engines.node, '>=22');
  assert.deepEqual(mainTestRunnerViolations(manifest.scripts.test, manifest.devDependencies), []);
  assert.equal(manifest.scripts['test:release'], 'node --test tests/static-gates.test.mjs');
  assert.equal(manifest.scripts['test:browser'], 'node --test tests/browser-smoke.test.mjs');
  assert.deepEqual(workflow.match(/node-version:\s*\d+/g), [
    'node-version: 22',
    'node-version: 22',
    'node-version: 22',
  ]);
});

test('nightly runs the release gates and publishes a prerelease without release or repository authority', () => {
  // Comment lines are stripped first: the header documents the triggers and
  // permissions this gate forbids, and only the directives may be asserted on.
  const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'nightly.yml'), 'utf8')
    .split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');
  const publishJobAt = workflow.indexOf('\n  publish-nightly:');
  assert(publishJobAt > 0, 'nightly workflow has no publish job');
  const gateJob = workflow.slice(0, publishJobAt);

  // The npm credential must never be reachable from a trigger that can carry
  // unmerged code, and must never run alongside the gates that execute it.
  assert.doesNotMatch(workflow, /pull_request/);
  assert.doesNotMatch(gateJob, /\bsecrets\./);
  // Publishing and aliasing each need the credential, and both must live in
  // the publish job — which is the property the old single-use count stood in
  // for, asserted directly instead of by arithmetic.
  const credentialUses = [...workflow.matchAll(/secrets\.NPM_TOKEN/g)].map((match) => match.index);
  assert.equal(credentialUses.length, 2);
  assert(credentialUses.every((at) => at > publishJobAt), 'the npm credential escaped the publish job');
  assert.doesNotMatch(workflow, /secrets\.VERSION_BUMP_APP_(?:ID|PRIVATE_KEY)/);
  assert.match(workflow, /^permissions:\n  contents: read$/m);
  assert.doesNotMatch(workflow, /contents:\s*write|id-token:\s*write|packages:\s*write/);
  assert.match(workflow, /if: github\.repository == 'adapt-toolkit\/ours-cowork'/);

  // A nightly is a side channel: it may not move the dist-tag that
  // .github/workflows/ci.yml publishes releases to. `nightly` is canonical and
  // `next` is a compatibility alias applied with dist-tag, never a second
  // publish — tests/dist-tags.test.mjs owns that contract in full.
  const publishes = workflow.match(/npm publish[^\n]*/g);
  assert.deepEqual(publishes, ['npm publish --access public --tag nightly']);
  assert.deepEqual(workflow.match(/npm dist-tag[^\n]*/g), [
    'npm dist-tag add @ours.network/cowork@${{ steps.version.outputs.version }} next',
  ]);
  assert.match(workflow, /bash \.github\/workflows\/scripts\/nightly-version\.sh/);
  assert(existsSync(join(ROOT, '.github', 'workflows', 'scripts', 'nightly-version.sh')));

  // The gate job is the CI gate set, run against the prerelease tip that the
  // publish job then reuses verbatim.
  assert.match(gateJob, /ref: prerelease/);
  assert.match(workflow, /ref: \$\{\{ needs\.test\.outputs\.sha \}\}/);
  assert.match(gateJob, /COWORK_CHROME_PATH:\s*\/usr\/bin\/google-chrome/);
  assert.match(gateJob, /for i in 1 2 3; do node --test tests\/e2e\.test\.mjs \|\| exit 1; done/);
  for (const command of [
    'npm run typecheck', 'npm run typecheck:web', 'npm run build',
    'npm run test:release', 'npm test', 'npm run test:web', 'npm run test:browser',
  ]) {
    assert(gateJob.includes(command), `${command} missing from the nightly gate job`);
  }
  assert.deepEqual(workflow.match(/node-version:\s*\d+/g), [
    'node-version: 22',
    'node-version: 22',
  ]);
});

test('main runner rejects loaderless Node and undeclared direct loaders while covering every native suite', () => {
  assert.match(mainTestRunnerViolations(
    'node --test --test-concurrency=1 tests/*.test.mjs',
    { tsx: '4.23.1' },
  ).join('\n'), /--import loader/);
  assert.match(mainTestRunnerViolations(
    'node --import unlisted-loader --test --test-concurrency=1 tests/*.test.mjs',
    { tsx: '4.23.1' },
  ).join('\n'), /declared direct dev dependency/);

  const suites = readdirSync(join(ROOT, 'tests'))
    .filter((name) => name.endsWith('.test.mjs'))
    .sort();
  assert(suites.length >= 15, `main runner discovered only ${suites.length} native suites`);
  for (const representative of [
    'browser-smoke.test.mjs',
    'intake.test.mjs',
    'sdk-runtime.test.mjs',
    'static-gates.test.mjs',
    'web-server.test.mjs',
  ]) {
    assert(suites.includes(representative), `main runner omitted ${representative}`);
  }
  assert.match(MAIN_TEST_SCRIPT, /tests\/\*\.test\.mjs$/);
});

test('declared tsx loader has one semver-required esbuild installation', () => {
  const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'));
  assert.equal(lock.packages['node_modules/tsx'].version, '4.23.1');
  assert.equal(lock.packages['node_modules/tsx'].dependencies.esbuild, '~0.28.0');
  assert.equal(lock.packages['node_modules/tsx/node_modules/esbuild'].version, '0.28.1');
  assert.equal(lock.packages['node_modules/esbuild'].version, '0.25.0');

  const installations = execFileSync('npm', ['ls', '--parseable', '--all', 'esbuild'], {
    cwd: ROOT,
    encoding: 'utf8',
  }).trim().split('\n').map((path) => normalized(path)).sort();
  assert.deepEqual(installations, [
    'node_modules/esbuild',
    'node_modules/tsx/node_modules/esbuild',
  ]);
});

test('browser smoke wrapper is Node 22 JavaScript and explicitly bundles its TypeScript entry', () => {
  const wrapper = readFileSync(join(ROOT, 'tests', 'browser-smoke.test.mjs'), 'utf8');
  assert.doesNotMatch(wrapper, /(?:from\s*|import\s*\()\s*['"][^'"]+\.ts['"]/);
  assert.match(wrapper, /from ['"]esbuild['"]/);
  assert.match(wrapper, /browser-smoke-entry\.ts/);
  assert.match(wrapper, /node_modules['"],\s*['"]\.cache/);
  assert.match(wrapper, /target:\s*['"]node20['"]/);
  assert.match(wrapper, /external:\s*\[['"]playwright-core['"]\]/);
  assert.match(wrapper, /await import\(pathToFileURL\(output\)\.href\)/);
});
