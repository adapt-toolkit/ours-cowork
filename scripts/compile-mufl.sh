#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
src_dir="$here/mufl_code"

if [ ! -f "$src_dir/actor.mu" ]; then
  echo "error: mufl_code/actor.mu missing; Task 2 must add the cowork packet actor." >&2
  exit 1
fi

if [ ! -f "$src_dir/core/config.mufl" ]; then
  echo "error: shared mufl core missing at '$src_dir/core' — run 'git submodule update --init'." >&2
  exit 1
fi

if [ -n "${ADAPT_TOOLKIT:-}" ]; then
  toolkit="$ADAPT_TOOLKIT"
  platform="$(uname | tr '[:upper:]' '[:lower:]')"
  mufl_compile=""
  for candidate in "$toolkit/build/mufl-compile" "$toolkit/build.$platform.release/mufl-compile"; do
    if [ -x "$candidate" ]; then mufl_compile="$candidate"; break; fi
  done
else
  toolkit="$(cd "$here" && node -p "path.dirname(require.resolve('@adapt-toolkit/mufl/package.json'))")"
  mufl_compile="$toolkit/prebuilds/linux-x64/mufl-compile"
fi

if [ ! -x "${mufl_compile:-}" ]; then
  echo "error: mufl-compile not found; set ADAPT_TOOLKIT or npm-install @adapt-toolkit/mufl." >&2
  exit 1
fi

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

compile_actor() {
  local source_file="$1"
  local output_dir="$2"
  local label="$3"
  local build_dir="$tmp_dir/$label"

  mkdir -p "$build_dir/core" "$output_dir"
  cp "$source_file" "$build_dir/actor.mu"
  cp "$src_dir/config.mufl" "$src_dir/protocol_container.mm" "$build_dir/"
  cp "$src_dir/core/config.mufl" "$src_dir/core"/*.mm "$build_dir/core/"
  (cd "$build_dir" && MUFL_STDLIB_PATH="$toolkit/mufl_stdlib" "$mufl_compile" -mp "$toolkit/meta" -mp "$toolkit/transactions" -d-c actor.mu >/dev/null)
  local muflo
  muflo="$(cd "$build_dir" && ls *.muflo)"
  rm -f "$output_dir"/*.muflo
  cp "$build_dir/$muflo" "$output_dir/"
}

compile_actor "$src_dir/actor.mu" "$src_dir" cowork
compile_actor "$here/tests/fixtures/permissive-actor.mu" "$here/tests/fixtures" permissive
