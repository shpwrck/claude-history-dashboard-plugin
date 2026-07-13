#!/usr/bin/env bash
# Deploy/refresh hook for the local dashboard container (#1650, epic #1264).
#
# This is the canonical "refresh repo-map artifacts, then (re)deploy" command.
# Generation of the structural repo map is HOST-SIDE (it needs devDeps + the WASM
# Tree-sitter grammars, which the zero-node_modules runtime container does not
# have — ADR 0007, #1013/#1195), so the generator cannot run inside the runtime
# image and must be triggered around the deploy. This wrapper makes that trigger
# automatic: it refreshes the artifacts the runtime consumes, then runs the same
# `podman compose ... up` documented in the README — so a single deploy command
# also keeps the `context.repo-map-context-waste` card live on real data.
#
# Usage:
#   scripts/deploy.sh              # refresh repo-map, then build + up -d (from source)
#   scripts/deploy.sh --pull       # refresh repo-map, then pull + up -d (published image)
#   scripts/deploy.sh --no-refresh # skip the repo-map refresh, just deploy
# Extra args after the flags are passed through to `compose up`.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# podman and docker are interchangeable here (README); prefer podman.
if command -v podman >/dev/null 2>&1; then
  ENGINE=podman
elif command -v docker >/dev/null 2>&1; then
  ENGINE=docker
else
  echo "deploy: neither podman nor docker found on PATH" >&2
  exit 1
fi

PUBLISHED=0
REFRESH=1
PASS=()
for arg in "$@"; do
  case "$arg" in
    --pull|--published) PUBLISHED=1 ;;
    --no-refresh) REFRESH=0 ;;
    *) PASS+=("$arg") ;;
  esac
done

# Refresh the host-side repo-map artifacts before deploying. Best-effort: the
# driver itself never fails the run on a per-root parse error, but guard the
# whole step too so a deploy is never blocked by repo-map generation.
if [ "$REFRESH" -eq 1 ]; then
  echo "deploy: refreshing repo-map artifacts (host-side)…"
  node "$DIR/scripts/repo-map-refresh.mjs" || \
    echo "deploy: repo-map refresh reported a problem — continuing with deploy" >&2
fi

COMPOSE=("$ENGINE" compose -f "$DIR/docker-compose.yml" -f "$DIR/docker-compose.local.yml")
# Pass variable NAMES only into the container so settings diagnostics can match
# `/doctor` without leaking host environment values. This snapshot describes
# the environment that launched the current dashboard process. Published-image
# and --no-refresh deploys must remain usable on hosts without Node, so snapshot
# capture is best-effort and an empty value explicitly means unavailable.
if command -v node >/dev/null 2>&1 && \
  HOST_ENV_NAMES="$(node -e 'process.stdout.write(JSON.stringify(Object.keys(process.env)))')"; then
  export CHD_HOST_ENV_NAMES="$HOST_ENV_NAMES"
else
  export CHD_HOST_ENV_NAMES=''
  echo "deploy: host environment snapshot unavailable — continuing without settings environment diagnostics" >&2
fi
# `${PASS[@]+"${PASS[@]}"}` is the portable empty-array expansion: a bare
# "${PASS[@]}" trips `set -u` ("unbound variable") on bash < 4.4 (e.g. macOS
# /bin/bash 3.2) when no passthrough args were given.
if [ "$PUBLISHED" -eq 1 ]; then
  echo "deploy: pulling published image and bringing it up…"
  "${COMPOSE[@]}" pull
  "${COMPOSE[@]}" up -d ${PASS[@]+"${PASS[@]}"}
else
  echo "deploy: building from source and bringing it up…"
  "${COMPOSE[@]}" up --build -d ${PASS[@]+"${PASS[@]}"}
fi
echo "deploy: done — verify on http://127.0.0.1:5173"
