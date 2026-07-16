#!/usr/bin/env bash
# Deploy/refresh hook for the local dashboard container (#1650, epic #1264).
#
# This is the canonical "refresh host artifacts, then (re)deploy" command.
# Generation of the structural repo map and doc-hygiene report is HOST-SIDE (the
# zero-node_modules runtime intentionally ships neither parser devDeps nor
# Lychee — ADR 0007, #1013/#1195), so neither producer can run in the runtime
# image. This wrapper makes both triggers automatic, then runs the same
# `podman compose ... up` documented in the README — so a single deploy command
# also keeps the `context.repo-map-context-waste` card live on real data.
#
# Usage:
#   scripts/deploy.sh              # refresh host artifacts, then build + up -d
#   scripts/deploy.sh --pull       # refresh host artifacts, then pull + up -d
#   scripts/deploy.sh --no-refresh # skip host artifact refresh, just deploy
# Extra args after the flags are passed through to `compose up`.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Stable host/container identity seam for this repo's doc-hygiene artifact. The
# host producer records its real checkout root, but `/app` has a different root
# and no .git. Pass an explicit safe artifact key plus the host commit through
# base compose so ingest can locate the same read-only file. Ingest separately
# matches this host commit to the running image's baked GIT_SHA, which suppresses
# the artifact when `--pull` deploys an image from a different checkout state.
export CHD_DOC_HYGIENE_ARTIFACT_KEY=claude-history-dashboard
CHD_DOC_HYGIENE_EXPECTED_COMMIT=''
if command -v git >/dev/null 2>&1; then
  CHD_DOC_HYGIENE_EXPECTED_COMMIT="$(git -C "$DIR" rev-parse HEAD 2>/dev/null || true)"
fi
if [ -z "$CHD_DOC_HYGIENE_EXPECTED_COMMIT" ] && [ -n "${GIT_SHA:-}" ]; then
  CHD_DOC_HYGIENE_EXPECTED_COMMIT="$GIT_SHA"
fi
export CHD_DOC_HYGIENE_EXPECTED_COMMIT
# Also fulfill the existing local-build version-stamp contract when the caller
# did not supply a different stamp explicitly.
if [ -z "${GIT_SHA:-}" ] && [ -n "$CHD_DOC_HYGIENE_EXPECTED_COMMIT" ]; then
  export GIT_SHA="$CHD_DOC_HYGIENE_EXPECTED_COMMIT"
fi

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

# Refresh host-side artifacts before deploying. Both are best-effort so an
# optional checker or one malformed project cannot block the dashboard deploy.
if [ "$REFRESH" -eq 1 ]; then
  echo "deploy: refreshing repo-map artifacts (host-side)…"
  node "$DIR/scripts/repo-map-refresh.mjs" || \
    echo "deploy: repo-map refresh reported a problem — continuing with deploy" >&2
  echo "deploy: refreshing doc-hygiene artifact (host-side)…"
  node "$DIR/scripts/doc-hygiene-run.mjs" \
    --root "$DIR" \
    --artifact-key "$CHD_DOC_HYGIENE_ARTIFACT_KEY" || \
    echo "deploy: doc-hygiene refresh reported a problem — continuing with deploy" >&2
  # #2707: per-doc Git last-commit times, packaged into the image (data/ COPY)
  # so the runtime never mistakes Docker COPY mtimes for Git history. Best-effort
  # like its siblings: on failure a stale/absent manifest simply fails the
  # runtime's commit binding and docs carry non-authoritative provenance.
  echo "deploy: refreshing doc git-times manifest (host-side)…"
  node "$DIR/scripts/doc-git-times-generate.mjs" --root "$DIR" || \
    echo "deploy: doc git-times refresh reported a problem — continuing with deploy" >&2
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
