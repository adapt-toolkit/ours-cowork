import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import test from 'node:test';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const TEXT_EXTENSIONS = new Set(['.ts', '.js', '.mjs', '.mu', '.mufl', '.mm', '.json', '.md', '.sh', '.yml', '.yaml']);
const REMOTE_PARTICIPANT_SENTENCE = 'Ordinary ours-mcp identities can join only as remote participants over the ours protocol.';

function filesBelow(directory) {
  const output = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...filesBelow(path));
    else if (TEXT_EXTENSIONS.has(extname(entry.name))) output.push(path);
  }
  return output;
}

function boundaryViolations(path, source) {
  const violations = [];
  const rules = [
    [/@ours\.network\/mcp/i, '@ours.network/mcp dependency'],
    [/(?:^|["'`\s=(])(?:\.\.\/|\.\/|\/)[^\n"'`]*ours-mcp(?:\/|["'`\s)]|$)/im, 'ours-mcp path'],
    [/\b(?:register|registration|registered)\b[^\n]{0,80}\bMCP\b|\bMCP\b[^\n]{0,80}\b(?:register|registration|registered)\b/i, 'MCP registration'],
    [/(?:\b(?:put|move|define|implement)\w*\b[^\n]{0,80}\b(?:mission[ -]?room|room)\b[^\n]{0,80}\b(?:into|inside|in)\b[^\n]{0,30}\b(?:shared[ -]?core|ours-mufl-core|a2a_(?:messaging|protocol))\b)|(?:\b(?:shared[ -]?core|ours-mufl-core|a2a_(?:messaging|protocol))\b[^\n]{0,10}\b(?:owns?|implements?|defines?)\b[^\n]{0,40}\b(?:mission[ -]?room|room)\b)/i, 'shared-core room semantics'],
  ];
  for (const [pattern, label] of rules) {
    if (pattern.test(source)) violations.push(`${path}: ${label}`);
  }
  return violations;
}

function documentationViolations(path, source, limitations = false) {
  const violations = [];
  const mcpMentions = source.match(/^.*ours-mcp.*$/gim) ?? [];
  for (const line of mcpMentions) {
    if (line.trim() !== REMOTE_PARTICIPANT_SENTENCE) {
      violations.push(`${path}: ours-mcp may only be described by the remote-participant exception`);
    }
  }
  if (!limitations) {
    const forbidden = /\bdelivered\b|remotely purged|\bkey wipe\b|secure eras(?:e|ure)|\bexactly[ -]once\b/i;
    if (forbidden.test(source)) violations.push(`${path}: forbidden reliability or erasure claim`);
  }
  return violations;
}

test('independence gate distinguishes paths, registration, and shared-core room semantics', () => {
  assert.deepEqual(boundaryViolations('src/good.ts', "const label = 'mcp';\nconst room = localRoom();"), []);
  for (const source of [
    "import '@ours.network/mcp'",
    "import '../../ours-mcp/src/server.js'",
    'register this daemon as an MCP server',
    'put mission-room policy into ours-mufl-core',
    'a2a_messaging owns room admission semantics',
  ]) assert.equal(boundaryViolations('src/bad.ts', source).length, 1, source);
});

test('documentation gate permits exactly the narrow remote-participant sentence', () => {
  assert.deepEqual(documentationViolations('README.md', REMOTE_PARTICIPANT_SENTENCE), []);
  assert.equal(documentationViolations('README.md', 'ours-mcp hosts cowork rooms.').length, 1);
  assert.equal(documentationViolations('README.md', 'Messages are delivered exactly-once.').length, 1);
  assert.deepEqual(documentationViolations('docs/10-limitations.md', 'No exactly once guarantee; no key wipe or secure erase.', true), []);
});

test('repository source, package metadata, and docs preserve the standalone boundary', () => {
  const boundaryFiles = [
    ...filesBelow(join(ROOT, 'src')),
    join(ROOT, 'mufl_code', 'actor.mu'),
    join(ROOT, 'mufl_code', 'config.mufl'),
    join(ROOT, 'mufl_code', 'protocol_container.mm'),
    join(ROOT, 'build.mjs'),
    join(ROOT, 'package.json'),
    join(ROOT, 'package-lock.json'),
  ];
  const boundaryFailures = boundaryFiles.flatMap((path) =>
    boundaryViolations(path.slice(ROOT.length + 1), readFileSync(path, 'utf8')));
  assert.deepEqual(boundaryFailures, []);

  const documentationFiles = [join(ROOT, 'README.md'), ...filesBelow(join(ROOT, 'docs'))];
  const documentationFailures = documentationFiles.flatMap((path) => documentationViolations(
    path.slice(ROOT.length + 1),
    readFileSync(path, 'utf8'),
    path.endsWith('/docs/10-limitations.md'),
  ));
  assert.deepEqual(documentationFailures, []);
});

test('release workflow repeats the standalone E2E three times and inspects the package', () => {
  const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(workflow, /for i in 1 2 3; do node --test tests\/e2e\.test\.mjs \|\| exit 1; done/);
  assert.match(workflow, /npm pack --dry-run/);
});
