#!/usr/bin/env bash
# Compute a Conventional-Commits version bump, update package metadata, and
# push one [skip ci] release commit. The published npm version participates in
# the base calculation so a stale checkout can never attempt to republish an
# existing version.

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

emit() { [[ -n "${GITHUB_OUTPUT:-}" ]] && printf '%s\n' "$1" >> "$GITHUB_OUTPUT" || true; }
log() { printf '[bump] %s\n' "$*"; }

no_bump() {
  log "no bump: $1"
  emit "bumped=false"
  emit "new-sha=${GITHUB_SHA:-$(git rev-parse HEAD)}"
  exit 0
}

message=$(git log -1 --pretty=%B HEAD)
subject=$(printf '%s\n' "$message" | head -n1)
body=$(printf '%s\n' "$message" | tail -n +2)
log "head subject: $subject"

printf '%s\n' "$message" | grep -qiE '\[skip ci\]|\[ci skip\]' && no_bump "[skip ci] marker present"

if printf '%s\n' "$subject" | grep -qE '^[a-z]+(\([^)]+\))?!:' \
   || printf '%s\n' "$body" | grep -qE '^BREAKING CHANGE:'; then
  level=major
else
  type=$(printf '%s\n' "$subject" | grep -oE '^[a-z]+' || true)
  case "$type" in
    feat) level=minor ;;
    fix) level=patch ;;
    ci|test|docs|chore) level=none ;;
    *) level=patch ;;
  esac
fi

[[ "$level" == none ]] && no_bump "non-shipping commit type (${type:-<empty>})"
log "bump level: $level"

bump() {
  local major minor patch
  IFS=. read -r major minor patch <<<"$1"
  case "$2" in
    major) echo "$((major + 1)).0.0" ;;
    minor) echo "${major}.$((minor + 1)).0" ;;
    patch) echo "${major}.${minor}.$((patch + 1))" ;;
  esac
}

local_version=$(node -p "require('./package.json').version")
published_version=$(npm view @ours.network/cowork version 2>/dev/null || echo '0.0.0')
base=$(printf '%s\n%s\n' "$local_version" "$published_version" | sort -V | tail -1)
version=$(bump "$base" "$level")
log "version: $base -> $version"

npm version "$version" --no-git-tag-version --ignore-scripts >/dev/null

test "$(node -p "require('./package.json').version")" = "$version"
test "$(node -p "require('./package-lock.json').version")" = "$version"
test "$(node -p "require('./package-lock.json').packages[''].version")" = "$version"

if [[ -n "${OURS_BUMP_DRY_RUN:-}" ]]; then
  log "DRY RUN - no commit/push"
  emit "bumped=true"
  emit "new-sha=$(git rev-parse HEAD)"
  emit "version=$version"
  exit 0
fi

git config user.name "ours-ci-version-bump[bot]"
git config user.email "ours-ci-version-bump[bot]@users.noreply.github.com"
git add package.json package-lock.json
git commit -m "chore(release): @ours.network/cowork v${version} [skip ci]

Triggered by $(git rev-parse --short HEAD): $(printf '%s' "$subject" | head -c 200)"
git push origin "HEAD:${GITHUB_REF_NAME:-main}"

emit "bumped=true"
emit "new-sha=$(git rev-parse HEAD)"
emit "version=$version"
