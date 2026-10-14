#!/bin/bash
# Build script for dsh-goal-guard (host half only: src/ -> lib/).
#
# There is no DSH *source* checkout in this deployment, so instead of compiling
# against $DSH_CHECKOUT/packages this links the type dependencies straight from
# the DEPLOYMENT's dependency tree — either the profile node_modules
# (~/.dsh/profiles/node_modules, which holds the whole DSH package graph) or the
# global install (/usr/lib/node_modules/@deepseek-ai/dsh/node_modules) — and
# uses the global tsc. Every link is a symlink, so it is safe to delete
# node_modules and re-run.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PROFILE_NM="${HOME}/.dsh/profiles/node_modules"
GLOBAL_NM="/usr/lib/node_modules/@deepseek-ai/dsh/node_modules"
DEP=""
for cand in "$PROFILE_NM" "$GLOBAL_NM"; do
  if [ -d "$cand/@deepseek-ai/dsh-tools" ] && [ -d "$cand/@deepseek-ai/schemastery" ] && [ -d "$cand/@deepseek-ai/cordis" ]; then
    DEP="$cand"
    break
  fi
done
if [ -z "$DEP" ]; then
  echo "build: cannot locate the DSH dependency tree (tried $PROFILE_NM, $GLOBAL_NM)" >&2
  exit 1
fi

TSC="/usr/bin/tsc"
if [ ! -x "$TSC" ]; then
  TSC="$(command -v tsc || true)"
fi
if [ -z "$TSC" ] || [ ! -x "$TSC" ]; then
  echo "build: tsc not found" >&2
  exit 1
fi

link_pkg() {
  local link="$1" target="$2"
  if [ ! -e "$target" ]; then
    echo "build: dependency target missing: $target" >&2
    exit 1
  fi
  node -e '
    const fs = require("fs");
    const path = require("path");
    const link = path.resolve(process.argv[1]);
    const target = path.resolve(process.argv[2]);
    fs.rmSync(link, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
  ' "node_modules/$link" "$target"
}

echo "=== Linking build type dependencies (deps root: $DEP) ==="
mkdir -p node_modules/@deepseek-ai node_modules/@types
link_pkg @deepseek-ai/cordis "$DEP/@deepseek-ai/cordis"
link_pkg @deepseek-ai/cosmokit "$DEP/@deepseek-ai/cosmokit"
link_pkg @deepseek-ai/dsh-tools "$DEP/@deepseek-ai/dsh-tools"
link_pkg @types/node "$DEP/@types/node"
# schemastery: import the SAME specifier the runtime will resolve. The
# deployment has no top-level `schemastery` package — only the vendored
# `@deepseek-ai/schemastery` (official packages and published third-party
# plugins import that name). Aliasing a local `node_modules/schemastery`
# symlink instead would compile fine and then fail to import at runtime.
link_pkg @deepseek-ai/schemastery "$DEP/@deepseek-ai/schemastery"

echo "=== Compiling host (src -> lib) ==="
"$TSC" -p tsconfig.json
echo "=== host compiled ==="
