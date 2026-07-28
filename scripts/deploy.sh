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

# Docs-map wrapper identity locator (#2709), the CHD_DOC_HYGIENE_* sibling: the
# gitless runtime cannot derive the checkout's owner/repo slug, so derive it
# host-side through the SAME normalizer ingest uses and pass it through BASE
# compose (never an override — podman-compose 1.5.0 drops override env
# additions). Empty on remoteless checkouts or Node-less hosts safely leaves
# the wrapper identity missing (suppression), never a fabricated slug.
CHD_DOCS_MAP_REPOSITORY=''
if command -v git >/dev/null 2>&1 && command -v node >/dev/null 2>&1; then
  CHD_DOCS_MAP_REPOSITORY="$(node --import "$DIR/scripts/register-ts.mjs" --input-type=module -e '
    const { execFileSync } = await import("node:child_process");
    const { normalizeGitRemoteUrl } = await import(process.argv[1]);
    try {
      const url = execFileSync(
        "git",
        ["-C", process.argv[2], "remote", "get-url", "origin"],
        { encoding: "utf8", env: { ...process.env, GIT_NO_LAZY_FETCH: "1" } }
      ).trim();
      process.stdout.write(normalizeGitRemoteUrl(url) ?? "");
    } catch {}
  ' "$DIR/src/lib/parse-docs-map.ts" "$DIR" 2>/dev/null || true)"
fi
export CHD_DOCS_MAP_REPOSITORY

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

# A digest-pinned image is a valid pull/run reference but cannot be the output
# tag of a local Compose build. Keep published deploys on the immutable default
# from docker-compose.yml; source deploys deliberately tag their locally built
# image in the localhost namespace instead.
if [ "$PUBLISHED" -eq 0 ]; then
  export CHD_APP_IMAGE="${CHD_APP_IMAGE:-localhost/claude-history-dashboard:local}"
fi

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
