import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { basename, extname, join, relative, resolve, sep } from 'node:path';
import test from 'node:test';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json', '.sh',
  '.mu', '.mm', '.mufl', '.muflo', '.yml', '.yaml',
]);
const SKIPPED_SOURCE_TREES = new Set([
  '.git', '.superpowers', 'node_modules', 'dist', 'docs', join('mufl_code', 'core'),
]);
const STATIC_GATE_PATH = 'tests/static-gates.test.mjs';
const REMOTE_PARTICIPANT_SENTENCE = 'Ordinary ours-mcp identities can join only as remote participants over the ours protocol.';
const DOC_NAMES = Array.from({ length: 10 }, (_, index) => `docs/${String(index + 1).padStart(2, '0')}-${[
  'prerequisites', 'installation', 'configuration', 'daemon-lifecycle', 'room-workflow',
  'invites', 'messaging-history', 'backup-restore', 'service-management', 'limitations',
][index]}.md`);

function normalized(path) {
  return relative(ROOT, path).split(sep).join('/');
}

function filesBelow(directory, extensions) {
  const output = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...filesBelow(path, extensions));
    else if (extensions.has(extname(entry.name))) output.push(path);
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

test('recursive owned-source discovery covers configs/scripts/tests/fixtures/MUFL and excludes only pinned third-party source', () => {
  const sourceFiles = discoverOwnedSource();
  const targets = sourceFiles.map(normalized);
  for (const expected of [
    '.github/workflows/ci.yml', '.gitmodules', 'build.mjs', 'package.json', 'package-lock.json',
    'scripts/compile-mufl.sh', 'src/daemon.ts', 'tests/e2e.test.mjs', 'mufl_code/actor.mu', 'mufl_code/config.mufl',
    'mufl_code/protocol_container.mm', 'tests/fixtures/permissive-actor.mu',
    'tests/fixtures/97473F4B9BC707583A5D699722D6DB11BF29E80222E3DDA016F09EB1208A2163.muflo', 'tsconfig.json',
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
});

test('built distribution remains standalone and contains one compiled packet', () => {
  const distFiles = filesBelow(join(ROOT, 'dist'), new Set(['.js', '.json']));
  assert.deepEqual(distFiles.flatMap((path) => boundaryViolations(normalized(path), readFileSync(path, 'utf8'))), []);
  const packets = filesBelow(join(ROOT, 'dist', 'mufl_code'), new Set(['.muflo']));
  assert.equal(packets.length, 1);
});

test('npm dry-run pack list is the exact standalone release artifact', () => {
  const output = execFileSync('npm', ['pack', '--json', '--dry-run'], { cwd: ROOT, encoding: 'utf8' });
  const packs = JSON.parse(output);
  assert.equal(packs.length, 1);
  const paths = packs[0].files.map((file) => file.path).sort();
  assert.equal(paths.some((path) => path.startsWith('docs/superpowers/')), false);
  const packetPaths = paths.filter((path) => /^dist\/mufl_code\/[0-9A-F]{64}\.muflo$/.test(path));
  assert.equal(packetPaths.length, 1);
  const expected = ['LICENSE', 'README.md', 'dist/cli.js', 'dist/daemon.js', 'package.json', ...DOC_NAMES, packetPaths[0]].sort();
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
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(manifest.scripts.test, 'node --test --test-concurrency=1 tests/*.test.mjs');
  assert.equal(manifest.scripts['test:release'], 'node --test tests/static-gates.test.mjs');
});
