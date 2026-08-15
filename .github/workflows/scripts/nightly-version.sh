#!/usr/bin/env bash
# Compute the nightly prerelease version for the current checkout and decide
# whether it still needs publishing.
#
# A nightly is a prerelease of the NEXT patch, never of an already released
# version, so it always sorts above every release on the `latest` dist-tag and
# below the release that eventually supersedes it. The published npm version
# participates in the base calculation for the same reason bump-version.sh uses
# it: a stale checkout can never reuse a version that already exists.
#
# Re-running against an unchanged prerelease tip is a no-op: the commit's short
# SHA is part of the version, so an existing nightly for that commit means the
# work is already published.
#
# Outputs (GITHUB_OUTPUT):
#   publish=true|false
#   version=<semver>   (only when publish=true)

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

emit() { [[ -n "${GITHUB_OUTPUT:-}" ]] && printf '%s\n' "$1" >> "$GITHUB_OUTPUT" || true; }
log() { printf '[nightly] %s\n' "$*"; }

no_publish() {
  log "no publish: $1"
  emit "publish=false"
  exit 0
}

short_sha=$(git rev-parse --short=7 HEAD)
stamp=${NIGHTLY_DATE:-$(date -u +%Y%m%d)}
log "prerelease tip: $short_sha"

published_versions=$(npm view @ours.network/cowork versions --json 2>/dev/null || echo '[]')
if node -e '
  const all = JSON.parse(process.argv[1]);
  const versions = Array.isArray(all) ? all : [all];
  process.exit(versions.some((version) => version.endsWith(`.${process.argv[2]}`)) ? 0 : 1);
' "$published_versions" "$short_sha"; then
  no_publish "commit $short_sha already has a published nightly"
fi

local_version=$(node -p "require('./package.json').version")
published_version=$(npm view @ours.network/cowork version 2>/dev/null || echo '0.0.0')
base=$(printf '%s\n%s\n' "$local_version" "$published_version" | sort -V | tail -1)

IFS=. read -r major minor patch <<<"$base"
patch=${patch%%-*}
version="${major}.${minor}.$((patch + 1))-nightly.${stamp}.${short_sha}"
log "version: $base -> $version"

npm version "$version" --no-git-tag-version --ignore-scripts >/dev/null

test "$(node -p "require('./package.json').version")" = "$version"
test "$(node -p "require('./package-lock.json').version")" = "$version"
test "$(node -p "require('./package-lock.json').packages[''].version")" = "$version"

emit "publish=true"
emit "version=$version"
