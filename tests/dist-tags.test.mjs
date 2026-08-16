import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const VERSION_SCRIPT = join(ROOT, '.github', 'workflows', 'scripts', 'nightly-version.sh');
const WORKFLOW = readFileSync(join(ROOT, '.github', 'workflows', 'nightly.yml'), 'utf8');
const DIRECTIVES = WORKFLOW.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');
const CANONICAL_TAG = 'nightly';
const ALIAS_TAG = 'next';

/**
 * Run the real version resolver against a stub `npm`, so the assertions are
 * about the outputs a workflow step would actually consume.
 */
function fixtureRepo(t, { local = '0.3.6' } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'cowork-nightly-version-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const repo = join(home, 'repo');
  const realNpm = execFileSync('sh', ['-c', 'command -v npm'], { encoding: 'utf8' }).trim();
  // A throwaway repository, because the resolver rewrites the manifest it runs
  // against and must never be pointed at this working tree.
  execFileSync('git', ['init', '--quiet', repo]);
  writeFileSync(join(repo, 'package.json'), `${JSON.stringify({
    name: '@ours.network/cowork', version: local, private: true,
  }, null, 2)}\n`);
  writeFileSync(join(repo, 'package-lock.json'), `${JSON.stringify({
    name: '@ours.network/cowork',
    version: local,
    lockfileVersion: 3,
    requires: true,
    packages: { '': { name: '@ours.network/cowork', version: local } },
  }, null, 2)}\n`);
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', [
    '-C', repo, '-c', 'user.email=gate@example.invalid', '-c', 'user.name=gate',
    'commit', '--quiet', '-m', 'fixture',
  ]);
  const sha = execFileSync('git', ['-C', repo, 'rev-parse', '--short=7', 'HEAD'], { encoding: 'utf8' }).trim();

  return {
    sha,
    repo,
    /** Resolve against a registry that has published exactly these versions. */
    resolve(published, date = '20260816') {
      // Only the registry reads are stubbed; `npm version` is the real one, so
      // the resolver's own manifest assertions run rather than being bypassed.
      const npm = join(home, 'npm');
      writeFileSync(npm, `#!/bin/sh
if [ "$1" = 'view' ]; then
  case "$3" in
    versions) printf '%s' ${JSON.stringify(JSON.stringify(published))} ;;
    *) printf '%s' ${JSON.stringify(latestRelease(published))} ;;
  esac
  exit 0
fi
exec ${JSON.stringify(realNpm)} "$@"
`, { mode: 0o700 });
      chmodSync(npm, 0o700);
      const outputs = join(home, 'github-output');
      writeFileSync(outputs, '');
      const stdout = execFileSync('bash', [VERSION_SCRIPT], {
        cwd: repo,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${home}:${process.env.PATH}`,
          GITHUB_OUTPUT: outputs,
          NIGHTLY_DATE: date,
        },
      });
      return {
        stdout,
        outputs: Object.fromEntries(readFileSync(outputs, 'utf8')
          .split('\n').filter(Boolean).map((line) => {
            const at = line.indexOf('=');
            return [line.slice(0, at), line.slice(at + 1)];
          })),
      };
    },
  };
}

function latestRelease(published) {
  return published.filter((version) => !version.includes('-')).sort().at(-1) ?? '0.0.0';
}

test('the canonical prerelease dist-tag is nightly and nothing publishes to next', () => {
  const publishes = DIRECTIVES.match(/npm publish[^\n]*/g);
  assert.deepEqual(publishes, [`npm publish --access public --tag ${CANONICAL_TAG}`]);
  // The alias must never be a second publish of the same bytes.
  assert.equal(DIRECTIVES.includes(`--tag ${ALIAS_TAG}`), false);
  assert.doesNotMatch(DIRECTIVES, /npm publish[^\n]*--tag next/);
});

test('the compatibility alias runs on both paths, cannot be skipped, and cannot swallow failure', () => {
  const aliasCommands = DIRECTIVES.match(/npm dist-tag add[^\n]*/g);
  assert.deepEqual(aliasCommands, [
    `npm dist-tag add @ours.network/cowork@\${{ steps.version.outputs.version }} ${ALIAS_TAG}`,
  ]);
  assert.doesNotMatch(DIRECTIVES, /npm dist-tag add[^\n]*\|\|/);
  assert.doesNotMatch(DIRECTIVES, /npm dist-tag[^\n]*latest/);

  // The publish step is conditional; the alias step deliberately is not.
  const aliasStepAt = DIRECTIVES.indexOf('- name: Alias the compatibility next dist-tag');
  assert(aliasStepAt > 0, 'the alias step is missing');
  const publishStepAt = DIRECTIVES.indexOf('- name: Publish @ours.network/cowork nightly');
  assert(publishStepAt > 0 && publishStepAt < aliasStepAt, 'the publish must precede the alias');
  const publishStep = DIRECTIVES.slice(publishStepAt, aliasStepAt);
  const aliasStep = DIRECTIVES.slice(aliasStepAt, DIRECTIVES.indexOf('- name: Summary'));
  assert.match(publishStep, /if: steps\.version\.outputs\.publish == 'true'/);
  assert.doesNotMatch(aliasStep, /^\s+if:/m);
  assert.match(aliasStep, /NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}/);
});

test('the summary distinguishes a fresh publish from a reconciled existing version', () => {
  const summaryAt = DIRECTIVES.indexOf('- name: Summary');
  const summary = DIRECTIVES.slice(summaryAt);
  const [published, reconciled] = summary.split('else');
  assert.match(published, /Published @ours\.network\/cowork@/);
  assert.match(published, new RegExp(`canonical ${CANONICAL_TAG} dist-tag`));
  assert.match(published, new RegExp(`compatibility ${ALIAS_TAG} dist-tag`));
  assert.match(reconciled, /nothing published/);
  assert.match(reconciled, /already has @ours\.network\/cowork@/);
  assert.match(reconciled, new RegExp(`canonical ${CANONICAL_TAG} dist-tag`));
  assert.match(reconciled, new RegExp(`compatibility ${ALIAS_TAG} dist-tag`));
});

test('a commit with no published nightly resolves a fresh version to publish', (t) => {
  const fixture = fixtureRepo(t);
  const resolved = fixture.resolve(['0.3.5', '0.3.6']);

  assert.equal(resolved.outputs.publish, 'true');
  assert.equal(resolved.outputs.version, `0.3.7-nightly.20260816.${fixture.sha}`);
});

test('an already-published commit still emits the exact existing version to alias', (t) => {
  const fixture = fixtureRepo(t);
  const existing = `0.3.7-nightly.20260815.${fixture.sha}`;
  const resolved = fixture.resolve(['0.3.6', existing]);

  // This is the retry-repair contract: publish is skipped, but the version the
  // alias step needs is still named, so a rerun can point `next` at it.
  assert.equal(resolved.outputs.publish, 'false');
  assert.equal(resolved.outputs.version, existing);
  assert.match(resolved.stdout, /no publish: commit .* already has a published nightly/);
});

test('several nightlies for one commit resolve deterministically to the highest', (t) => {
  const fixture = fixtureRepo(t);
  const { sha } = fixture;
  const resolved = fixture.resolve([
    '0.3.6',
    `0.3.7-nightly.20260816.${sha}`,
    `0.3.7-nightly.20260814.${sha}`,
    `0.3.7-nightly.20260815.${sha}`,
  ]);
  assert.equal(resolved.outputs.version, `0.3.7-nightly.20260816.${sha}`);

  const acrossBases = fixture.resolve([
    '0.3.6', `0.3.7-nightly.20260816.${sha}`, `0.4.0-nightly.20260101.${sha}`,
  ]);
  assert.equal(acrossBases.outputs.version, `0.4.0-nightly.20260101.${sha}`);
});

test('a partially failed run is repaired by a rerun without republishing', (t) => {
  const fixture = fixtureRepo(t);
  const version = `0.3.7-nightly.20260816.${fixture.sha}`;
  // First run: published under nightly, then the alias write failed. Second
  // run sees the version already published.
  const retry = fixture.resolve(['0.3.6', version]);

  assert.equal(retry.outputs.publish, 'false');
  assert.equal(retry.outputs.version, version);
  // With publish=false the guarded publish step is skipped entirely, while the
  // unguarded alias step re-runs against that same version.
  const aliasCommand = DIRECTIVES.match(/npm dist-tag add[^\n]*/)[0]
    .replace('${{ steps.version.outputs.version }}', retry.outputs.version);
  assert.equal(aliasCommand, `npm dist-tag add @ours.network/cowork@${version} ${ALIAS_TAG}`);
  assert.equal(aliasCommand.includes('publish'), false);
});

test('the stable release pipeline is untouched and still owns the default dist-tag', () => {
  const ci = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  const publishes = ci.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n').match(/npm publish[^\n]*/g);

  assert.deepEqual(publishes, ['npm publish --access public']);
  assert.doesNotMatch(ci, /--tag/);
  assert.doesNotMatch(ci, /dist-tag/);
  assert.doesNotMatch(ci, new RegExp(`branches: \\[${CANONICAL_TAG}\\]`));
  // The nightly line must never move the stable tag. `ubuntu-latest` is a
  // runner label, not a dist-tag, so only tag-bearing commands are examined.
  for (const command of DIRECTIVES.match(/npm (?:publish|dist-tag)[^\n]*/g)) {
    assert.equal(/(?:^|[\s@])latest(?:\s|$)/.test(command), false, command);
  }
});
