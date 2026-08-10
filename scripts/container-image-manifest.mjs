#!/usr/bin/env node
// Canonical published-container declaration and workflow compiler (#3513).
//
// `container-images.json` is the single inventory consumed by both the image
// publisher and the action-pin gate. The workflow is generated in full and its
// checked-in bytes are equality-gated, so an added `make publish`, wrapper,
// composite action, `working-directory`, or `cd` is generic workflow drift — it
// cannot become an undiscovered publisher merely because no regex knows its
// syntax.

import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, posix, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const CONTAINER_IMAGE_MANIFEST = 'container-images.json';
export const CONTAINER_PUBLISH_WORKFLOW = '.github/workflows/docker-publish.yml';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_MANIFEST_BYTES = 64 * 1024;
const BUILD_MODES = ['server', 'spa', 'plain'];
const MANIFEST_KEYS = ['images', 'schemaVersion'];
const ENTRY_KEYS = ['buildMode', 'context', 'id', 'image', 'recipe'];

function slashPath(root, absolute) {
  return relative(root, absolute).split(sep).join('/');
}

function checkedRelativePath(value, { allowDot = false } = {}) {
  if (typeof value !== 'string' || value === '') return 'must be a non-empty string';
  if (value.includes('\\')) return 'must use forward slashes';
  if (isAbsolute(value) || value.startsWith('/')) return 'must be relative to the repository root';
  if (value === '.') return allowDot ? null : 'must name a path below the repository root';
  if (posix.normalize(value) !== value || value.split('/').includes('..')) {
    return 'must be a normalized path without `..` traversal';
  }
  return null;
}

function pathReason(root, pathname, kind) {
  const absolute = pathname === '.' ? root : join(root, ...pathname.split('/'));
  const parts = pathname === '.' ? [] : pathname.split('/');
  let cursor = root;
  for (const part of parts) {
    cursor = join(cursor, part);
    let stat;
    try {
      stat = lstatSync(cursor);
    } catch {
      return `${pathname} does not exist`;
    }
    if (stat.isSymbolicLink()) {
      return `${slashPath(root, cursor)} is a symbolic link; manifest paths must stay inside the reviewed worktree`;
    }
  }

  let stat;
  try {
    stat = lstatSync(absolute);
  } catch {
    return `${pathname} does not exist`;
  }
  if (kind === 'file' && !stat.isFile()) return `${pathname} is not a regular file`;
  if (kind === 'directory' && !stat.isDirectory()) return `${pathname} is not a directory`;
  return null;
}

function recipeInsideContext(recipe, context) {
  if (context === '.') return true;
  const rel = posix.relative(context, recipe);
  return rel !== '' && rel !== '..' && !rel.startsWith('../');
}

export function inspectContainerImageManifest(root = REPO_ROOT) {
  const reasons = [];
  const absolute = join(root, CONTAINER_IMAGE_MANIFEST);
  let source;
  try {
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      reasons.push(`${CONTAINER_IMAGE_MANIFEST} is a symbolic link; the publisher inventory must be reviewed bytes`);
      return { entries: [], reasons, manifestHash: null };
    }
    if (!stat.isFile()) {
      reasons.push(`${CONTAINER_IMAGE_MANIFEST} is not a regular file`);
      return { entries: [], reasons, manifestHash: null };
    }
    if (stat.size > MAX_MANIFEST_BYTES) {
      reasons.push(`${CONTAINER_IMAGE_MANIFEST} exceeds ${MAX_MANIFEST_BYTES} bytes`);
      return { entries: [], reasons, manifestHash: null };
    }
    source = readFileSync(absolute, 'utf8');
  } catch {
    reasons.push(`${CONTAINER_IMAGE_MANIFEST} was not found`);
    return { entries: [], reasons, manifestHash: null };
  }

  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    reasons.push(`${CONTAINER_IMAGE_MANIFEST} is not valid JSON: ${error.message}`);
    return { entries: [], reasons, manifestHash: null };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    reasons.push(`${CONTAINER_IMAGE_MANIFEST} must contain an object`);
    return { entries: [], reasons, manifestHash: null };
  }
  // perf-index-contract: container-manifest-top-level-keys always-consumed: every parsed manifest compares its complete deterministic key list against the schema
  const manifestKeys = Object.keys(parsed).sort();
  if (JSON.stringify(manifestKeys) !== JSON.stringify(MANIFEST_KEYS)) {
    reasons.push(`container image manifest must contain exactly ${MANIFEST_KEYS.join(', ')}`);
  }
  if (parsed.schemaVersion !== 1) reasons.push('container image manifest schemaVersion must be 1');
  if (!Array.isArray(parsed.images) || parsed.images.length === 0) {
    reasons.push('container image manifest images must be a non-empty array');
    return { entries: [], reasons, manifestHash: null };
  }
  if (parsed.images.length > 32) reasons.push('container image manifest may declare at most 32 images');

  const entries = [];
  // perf-index-contract: container-manifest-duplicates always-consumed: every successfully validated nonempty manifest checks every declared identity for duplicates
  const ids = new Set();
  const images = new Set();
  const recipes = new Set();
  let serverModeCount = 0;
  let spaModeCount = 0;
  let serverIdSeen = false;
  let spaIdSeen = false;
  for (const [index, candidate] of parsed.images.entries()) {
    const label = `container image manifest images[${index}]`;
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      reasons.push(`${label} must be an object`);
      continue;
    }
    // perf-index-contract: container-manifest-entry-keys always-consumed: every object entry compares its complete deterministic key list against the schema
    const keys = Object.keys(candidate).sort();
    if (JSON.stringify(keys) !== JSON.stringify(ENTRY_KEYS)) {
      reasons.push(`${label} must contain exactly ${ENTRY_KEYS.join(', ')}`);
      continue;
    }
    const { id, image, recipe, context, buildMode } = candidate;
    if (typeof id !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(id)) {
      reasons.push(`${label}.id must match [a-z][a-z0-9-]{0,31}`);
    } else if (ids.has(id)) reasons.push(`${label}.id duplicates ${id}`);
    else ids.add(id);
    if (typeof image !== 'string' || !/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._/-]*$/.test(image)) {
      reasons.push(`${label}.image must be a registry-relative owner/image name`);
    } else if (images.has(image)) reasons.push(`${label}.image duplicates ${image}`);
    else images.add(image);
    const recipeProblem = checkedRelativePath(recipe);
    if (recipeProblem) reasons.push(`${label}.recipe ${recipeProblem}`);
    else if (recipes.has(recipe)) reasons.push(`${label}.recipe duplicates ${recipe}`);
    else recipes.add(recipe);
    const contextProblem = checkedRelativePath(context, { allowDot: true });
    if (contextProblem) reasons.push(`${label}.context ${contextProblem}`);
    if (!BUILD_MODES.includes(buildMode)) {
      reasons.push(`${label}.buildMode must be one of server, spa, plain`);
    } else {
      if (buildMode === 'server') serverModeCount += 1;
      if (buildMode === 'spa') spaModeCount += 1;
    }
    if (id === 'server') {
      serverIdSeen = true;
      if (buildMode !== 'server') reasons.push(`${label} reserved id server must use buildMode server`);
    } else if (buildMode === 'server') {
      reasons.push(`${label}.buildMode server is reserved for id server`);
    }
    if (id === 'spa') {
      spaIdSeen = true;
      if (buildMode !== 'spa') reasons.push(`${label} reserved id spa must use buildMode spa`);
    } else if (buildMode === 'spa') {
      reasons.push(`${label}.buildMode spa is reserved for id spa`);
    }
    if (!recipeProblem && !contextProblem && !recipeInsideContext(recipe, context)) {
      reasons.push(`${label}.recipe ${recipe} is not inside build context ${context}`);
    }
    if (!recipeProblem) {
      const problem = pathReason(root, recipe, 'file');
      if (problem) reasons.push(`${label}.recipe ${problem}`);
    }
    if (!contextProblem) {
      const problem = pathReason(root, context, 'directory');
      if (problem) reasons.push(`${label}.context ${problem}`);
    }
    entries.push({ id, image, recipe, context, buildMode });
  }
  if (!serverIdSeen) reasons.push('container image manifest must declare reserved id server');
  if (!spaIdSeen) reasons.push('container image manifest must declare reserved id spa');
  if (serverModeCount !== 1) {
    reasons.push(`container image manifest must declare exactly one server buildMode (found ${serverModeCount})`);
  }
  if (spaModeCount !== 1) {
    reasons.push(`container image manifest must declare exactly one spa buildMode (found ${spaModeCount})`);
  }

  const manifestHash = createHash('sha256').update(source).digest('hex');
  return { entries: reasons.length ? [] : entries, reasons, manifestHash };
}

export function renderContainerPublishWorkflow(root = REPO_ROOT) {
  const inspected = inspectContainerImageManifest(root);
  if (inspected.reasons.length) {
    throw new Error(inspected.reasons.join('; '));
  }
  const hash = inspected.manifestHash;
  return `# Generated by scripts/container-image-manifest.mjs from container-images.json.
# container-images sha256: ${hash}
# Do not edit this workflow directly; run:
#   node scripts/container-image-manifest.mjs write-workflow
name: Publish container image

on:
  push:
    branches:
      - master
    tags:
      - "v*"
  release:
    types: [published]
  workflow_dispatch:

env:
  REGISTRY: ghcr.io

permissions:
  contents: read
  packages: write

jobs:
  plan:
    runs-on: arc-runner-set
    outputs:
      matrix: \${{ steps.images.outputs.matrix }}
    steps:
      - name: Checkout
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - name: Compile publisher matrix from the reviewed manifest
        id: images
        run: node scripts/container-image-manifest.mjs emit-matrix >> "$GITHUB_OUTPUT"

  # Publisher cost (#3513): ${inspected.entries.length} declared images compile to
  # ${inspected.entries.length} sequential dind jobs (the former publisher used one job). Each
  # job repeats checkout, daemon wait, and GHCR login and cannot reuse local
  # layers. This is an accepted trade for manifest-driven scope and per-image
  # failure attribution; max-parallel stays 1 to bound dind resource pressure.
  build-and-push:
    needs: plan
    strategy:
      fail-fast: true
      max-parallel: 1
      matrix: \${{ fromJSON(needs.plan.outputs.matrix) }}
    runs-on: arc-dind
    steps:
      - name: Checkout
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          fetch-depth: \${{ matrix.buildMode == 'server' && '0' || '1' }}

      - name: Set up Node for the server manifest
        if: matrix.buildMode == 'server'
        uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: 22

      - name: Generate doc git-times manifest
        if: matrix.buildMode == 'server'
        run: node scripts/doc-git-times-generate.mjs --root .

      - name: Wait for Docker daemon
        run: |
          for i in $(seq 1 60); do
            if docker info >/dev/null 2>&1; then echo "docker up after \${i}s"; exit 0; fi
            sleep 1
          done
          echo "::error::Docker daemon did not become ready"; docker info; exit 1

      - name: Log in to GHCR
        uses: docker/login-action@dbcb813823bdd20940b903addbd779551569679f # v4
        with:
          registry: \${{ env.REGISTRY }}
          username: \${{ github.actor }}
          password: \${{ secrets.GITHUB_TOKEN }}

      - name: Extract image metadata
        id: meta
        uses: docker/metadata-action@dc802804100637a589fabce1cb79ff13a1411302 # v6
        with:
          images: \${{ env.REGISTRY }}/\${{ matrix.image }}
          tags: |
            type=raw,value=latest,enable={{is_default_branch}}
            type=ref,event=branch
            type=sha,prefix=sha-,format=short
            type=semver,pattern={{version}}
            type=semver,pattern={{major}}.{{minor}}
            type=semver,pattern={{major}}
            type=ref,event=tag

      - name: Build and push declared image
        env:
          TAGS: \${{ steps.meta.outputs.tags }}
          LABELS: \${{ steps.meta.outputs.labels }}
          BUILD_MODE: \${{ matrix.buildMode }}
          RECIPE: \${{ matrix.recipe }}
          BUILD_CONTEXT: \${{ matrix.context }}
          GIT_SHA: \${{ github.sha }}
          RELEASE_TAG: \${{ startsWith(github.ref, 'refs/tags/') && github.ref_name || '' }}
        run: |
          export DOCKER_BUILDKIT=0
          build_args=()
          while IFS= read -r t; do [ -n "$t" ] && build_args+=(-t "$t"); done <<< "$TAGS"
          while IFS= read -r l; do [ -n "$l" ] && build_args+=(--label "$l"); done <<< "$LABELS"
          if [ "$BUILD_MODE" = server ] || [ "$BUILD_MODE" = spa ]; then
            build_args+=(--build-arg "GIT_SHA=$GIT_SHA" --build-arg "RELEASE_TAG=$RELEASE_TAG")
          fi
          docker build "\${build_args[@]}" -f "$RECIPE" "$BUILD_CONTEXT"
          printf '%s\\n' "$TAGS" | bash scripts/docker-push-retry.sh

      - name: Smoke-check server image version stamp
        if: matrix.buildMode == 'server'
        env:
          TAGS: \${{ steps.meta.outputs.tags }}
          RELEASE_TAG: \${{ startsWith(github.ref, 'refs/tags/') && github.ref_name || '' }}
        run: |
          FIRST_TAG=$(printf '%s\\n' "$TAGS" | grep -v '^$' | head -1)
          GOT_SHA=$(docker run --rm --entrypoint sh "$FIRST_TAG" -c 'printf %s "$GIT_SHA"')
          if [ -z "$GOT_SHA" ]; then
            echo "::error::server image $FIRST_TAG self-reports an empty GIT_SHA (#1604)."
            exit 1
          fi
          echo "server image GIT_SHA=$GOT_SHA"
          if [ -n "$RELEASE_TAG" ]; then
            GOT_TAG=$(docker run --rm --entrypoint sh "$FIRST_TAG" -c 'printf %s "$RELEASE_TAG"')
            if [ -z "$GOT_TAG" ]; then
              echo "::error::tag/release image $FIRST_TAG self-reports an empty RELEASE_TAG (#1604)."
              exit 1
            fi
            echo "server image RELEASE_TAG=$GOT_TAG"
          fi

      - name: Smoke-check packaged doc git-times manifest
        if: matrix.buildMode == 'server'
        env:
          TAGS: \${{ steps.meta.outputs.tags }}
          GIT_SHA: \${{ github.sha }}
        run: |
          HEAD_COMMIT=$(git rev-parse 'HEAD^{commit}')
          if [ "$GIT_SHA" != "$HEAD_COMMIT" ]; then
            echo "::error::workflow GIT_SHA $GIT_SHA is not checkout commit $HEAD_COMMIT (#2707)."
            exit 1
          fi
          FIRST_TAG=$(printf '%s\\n' "$TAGS" | grep -v '^$' | head -1)
          docker run --rm --env EXPECTED_COMMIT="$GIT_SHA" --entrypoint node "$FIRST_TAG" -e '
            const { readFileSync } = require("node:fs");
            const manifest = JSON.parse(readFileSync("/app/data/doc-git-times.json", "utf8"));
            if (manifest.schemaVersion !== 2) throw new Error("unexpected schemaVersion: " + manifest.schemaVersion);
            if (manifest.sourceCommit !== process.env.EXPECTED_COMMIT) {
              throw new Error("sourceCommit " + manifest.sourceCommit + " != expected " + process.env.EXPECTED_COMMIT);
            }
            console.log("doc-git-times manifest OK: " + Object.keys(manifest.files).length + " entries");
          '
`;
}

export function publisherWorkflowDriftReasons(root = REPO_ROOT) {
  const inspected = inspectContainerImageManifest(root);
  if (inspected.reasons.length) return inspected.reasons;
  const absolute = join(root, CONTAINER_PUBLISH_WORKFLOW);
  let actual;
  try {
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      return [`${CONTAINER_PUBLISH_WORKFLOW} is a symbolic link; the canonical publisher must be reviewed bytes`];
    }
    if (!stat.isFile()) return [`${CONTAINER_PUBLISH_WORKFLOW} is not a regular file`];
    actual = readFileSync(absolute, 'utf8');
  } catch {
    return [`${CONTAINER_PUBLISH_WORKFLOW} was not found`];
  }
  const expected = renderContainerPublishWorkflow(root);
  if (actual !== expected) {
    return [
      `${CONTAINER_PUBLISH_WORKFLOW} differs from the canonical manifest-compiled publisher; ` +
        'run `node scripts/container-image-manifest.mjs write-workflow`. Unknown make, wrapper, ' +
        'composite-action, working-directory, and cd publishers are rejected as workflow drift',
    ];
  }
  return [];
}

function failOnReasons(reasons) {
  if (reasons.length === 0) return;
  for (const reason of reasons) console.error(`Container image manifest: ${reason}`);
  process.exit(1);
}

function main() {
  const command = process.argv[2] ?? 'check-workflow';
  const inspected = inspectContainerImageManifest();
  failOnReasons(inspected.reasons);
  if (command === 'emit-matrix') {
    console.log(`matrix=${JSON.stringify({ include: inspected.entries })}`);
    return;
  }
  if (command === 'render-workflow') {
    process.stdout.write(renderContainerPublishWorkflow());
    return;
  }
  if (command === 'write-workflow') {
    writeFileSync(join(REPO_ROOT, CONTAINER_PUBLISH_WORKFLOW), renderContainerPublishWorkflow());
    console.log(`Wrote ${CONTAINER_PUBLISH_WORKFLOW} from ${CONTAINER_IMAGE_MANIFEST}.`);
    return;
  }
  if (command === 'check-workflow') {
    const reasons = publisherWorkflowDriftReasons();
    failOnReasons(reasons);
    console.log(
      `Container publisher OK: ${inspected.entries.length} image(s) compiled from ${CONTAINER_IMAGE_MANIFEST}.`
    );
    return;
  }
  console.error(`Unknown command: ${command}`);
  process.exit(2);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main();
}
