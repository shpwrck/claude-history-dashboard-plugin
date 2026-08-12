#!/usr/bin/env node
// Base-image digest refresh (#3503).
//
// #3064/#3307 pinned every container base image and every CI action to an
// immutable digest/SHA. That removes "a tag owner retargets it under our
// tokens", but a pin with no refresh path trades a mutable base for an
// INDEFINITELY STALE one: the OS patch stream that carries CVE fixes never
// reaches a digest nobody bumps. `.github/dependabot.yml` closes that for the
// `github-actions` ecosystem and (as of #3503) for the `docker` ecosystem's
// Dockerfiles. This script closes the REMAINDER — the pins Dependabot's docker
// updater provably does NOT refresh:
//
//   * ghcr.io/actions/actions-runner in deploy/arc/runner-image/ — pinned by
//     DIGEST ONLY (no tag), so Dependabot has no version stream to follow, and
//     its recipe content is coupled to a review-gated version stamp that has to
//     move in lockstep across the BuildConfig and every ARC scale-set values
//     file (the #3340 cross-file stamp rule in check-action-pins.mjs).
//   * caddy:2-alpine in docker-compose.tls.yml — Dependabot's `docker`
//     ecosystem parses Dockerfiles, not Compose files (Compose is a separate
//     ecosystem), so this external base goes unbumped.
//
// It re-resolves each target's CURRENT digest from its upstream registry tag
// and rewrites the pin(s) when the digest has moved; the scheduled workflow
// (.github/workflows/base-image-digest-refresh.yml) turns a change into a
// reviewable PR. Deliberately NOT refreshed here (and why), so the coverage is
// honest rather than assumed:
//
//   * Dockerfile and probaitio-operator/Dockerfile{,.dispatch}
//     bases (node/nginx/golang/distroless) — TAGGED, so Dependabot's docker
//     ecosystem raises those bumps. Refreshing them here too would only open
//     duplicate PRs.
//   * ghcr.io/shpwrck/claude-history-dashboard:latest in docker-compose.yml —
//     our own image, rebuilt and
//     republished on every push to master by docker-publish.yml. They are not
//     an external-CVE staleness risk, and auto-bumping them would churn a PR
//     every week for a digest we already move ourselves.
//
// Pure Node builtins (no npm dependency: this must run on the zero-node_modules
// contract's terms and needs nothing more than fetch + fs + crypto). The
// registry resolver can be stubbed with CHD_DIGEST_FIXTURE so the dry-run is
// deterministic and offline in tests.
//
// Run:
//   node scripts/refresh-image-digests.mjs            # dry run: report only
//   node scripts/refresh-image-digests.mjs --apply    # rewrite files on drift

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Media types so a multi-arch image returns its INDEX digest — the value the
// repo pins — rather than a per-arch manifest digest.
export const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const HEX64_RE = '[0-9a-f]{64}';
// A version stamp: v<YYYY>-<MM>-<DD>-<8 hex>, the eight hex being the first
// eight of the runner Dockerfile's SHA-256 (the #3340 contract).
const STAMP_RE = /v\d{4}-\d{2}-\d{2}-[0-9a-f]{8}/;

/**
 * Per-registry anonymous pull-token endpoints. Both targets are public, so an
 * anonymous token suffices; a GITHUB_TOKEN, when present, is offered as Basic
 * auth to the ghcr token endpoint purely to dodge unauthenticated rate limits.
 */
const REGISTRIES = {
  'registry-1.docker.io': {
    tokenUrl: (repo) =>
      `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repo}:pull`,
  },
  'ghcr.io': {
    tokenUrl: (repo) => `https://ghcr.io/token?scope=repository:${repo}:pull`,
    basicToken: () => process.env.GH_TOKEN || process.env.GITHUB_TOKEN || null,
  },
};

/**
 * The refresh targets — the pins Dependabot's docker updater does not cover.
 *
 * `kind: 'simple'` swaps the 64-hex digest that follows `pinPrefix` in `file`.
 * `kind: 'runner'` is the cascade: swap the actions-runner digest in the
 * Dockerfile + BuildConfig, recompute the content stamp, and move the stamp
 * across the BuildConfig, every ARC scale-set values file, and the README so
 * the whole #3340 group stays internally consistent and check-action-pins.mjs
 * stays green.
 */
export const TARGETS = [
  {
    id: 'caddy',
    kind: 'simple',
    description: 'caddy:2-alpine (docker-compose.tls.yml TLS front)',
    registry: 'registry-1.docker.io',
    repository: 'library/caddy',
    tag: '2-alpine',
    file: 'docker-compose.tls.yml',
    pinPrefix: 'caddy:2-alpine@sha256:',
  },
  {
    id: 'actions-runner',
    kind: 'runner',
    description: 'ghcr.io/actions/actions-runner (ARC CI runner base)',
    registry: 'ghcr.io',
    repository: 'actions/actions-runner',
    tag: 'latest',
    pinPrefix: 'ghcr.io/actions/actions-runner@sha256:',
    dockerfile: 'deploy/arc/runner-image/Dockerfile',
    buildconfig: 'deploy/arc/runner-image/buildconfig.yaml',
    // Every file that names the review-gated chd-ci-runner stamp.
    stampFiles: [
      'deploy/arc/runner-image/buildconfig.yaml',
      'deploy/arc/runner-scale-set-values.yaml',
      'deploy/arc/dind-scale-set-values.yaml',
      'deploy/arc/hub/runner-scale-set-values.yaml',
      'deploy/arc/hub/dind-scale-set-values.yaml',
      'deploy/arc/README.md',
    ],
  },
];

/** Escape a literal for embedding in a RegExp. */
export function escapeRegExp(literal) {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Today's UTC date as YYYY-MM-DD (overridable for deterministic tests). */
export function utcDate(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

/** first-8-hex(SHA-256(recipe)) — the #3340 stamp suffix. */
export function recipeHex(recipeContent) {
  return createHash('sha256').update(recipeContent).digest('hex').slice(0, 8);
}

/** Build a full version stamp from a recipe's content and a date. */
export function computeStamp(recipeContent, date) {
  return `v${date}-${recipeHex(recipeContent)}`;
}

/**
 * Resolve the current index digest for registry/repository:tag.
 *
 * Honors CHD_DIGEST_FIXTURE (a JSON file mapping `<registry>/<repository>:<tag>`
 * to a `sha256:...` value) so the resolver is deterministic and offline in
 * tests and demos. A requested key missing from the fixture is an error, never
 * a silent skip.
 */
export async function resolveDigest({ registry, repository, tag }, fetchImpl = fetch) {
  const key = `${registry}/${repository}:${tag}`;
  const fixturePath = process.env.CHD_DIGEST_FIXTURE;
  if (fixturePath) {
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
    if (!(key in fixture)) {
      throw new Error(`CHD_DIGEST_FIXTURE has no entry for ${key}`);
    }
    const digest = fixture[key];
    if (!DIGEST_RE.test(digest)) {
      throw new Error(`CHD_DIGEST_FIXTURE value for ${key} is not a sha256 digest: ${digest}`);
    }
    return digest;
  }

  const config = REGISTRIES[registry];
  if (!config) throw new Error(`no token endpoint configured for registry ${registry}`);

  const tokenHeaders = {};
  const basic = config.basicToken?.();
  if (basic) tokenHeaders.Authorization = `Basic ${Buffer.from(`x:${basic}`).toString('base64')}`;
  const tokenResp = await fetchImpl(config.tokenUrl(repository), { headers: tokenHeaders });
  if (!tokenResp.ok) {
    throw new Error(`token request for ${key} failed: HTTP ${tokenResp.status}`);
  }
  const tokenJson = await tokenResp.json();
  const token = tokenJson.token || tokenJson.access_token;
  if (!token) throw new Error(`token request for ${key} returned no token`);

  const manifestResp = await fetchImpl(`https://${registry}/v2/${repository}/manifests/${tag}`, {
    method: 'GET',
    headers: { Accept: MANIFEST_ACCEPT, Authorization: `Bearer ${token}` },
  });
  if (!manifestResp.ok) {
    throw new Error(`manifest request for ${key} failed: HTTP ${manifestResp.status}`);
  }
  const digest = manifestResp.headers.get('docker-content-digest');
  if (!digest || !DIGEST_RE.test(digest)) {
    throw new Error(`registry returned no usable Docker-Content-Digest for ${key}: ${digest}`);
  }
  return digest;
}

/**
 * Swap the 64-hex digest that follows `pinPrefix` in `text` with `newHex`.
 * Returns { text, oldHex, changed }. A missing pin is a configuration error and
 * fails loudly rather than silently succeeding.
 */
export function rewriteSimpleDigest(text, pinPrefix, newHex) {
  const re = new RegExp(escapeRegExp(pinPrefix) + `(${HEX64_RE})`);
  const match = re.exec(text);
  if (!match) throw new Error(`pin \`${pinPrefix}<digest>\` not found`);
  const oldHex = match[1];
  if (oldHex === newHex) return { text, oldHex, changed: false };
  return { text: text.replace(re, `${pinPrefix}${newHex}`), oldHex, changed: true };
}

/** Parse the in-force chd-ci-runner stamp from any file that names it. */
export function parseStamp(text) {
  const match = /chd-ci-runner:(v\d{4}-\d{2}-\d{2}-[0-9a-f]{8})/.exec(text);
  return match ? match[1] : null;
}

/**
 * The actions-runner cascade (#3340). Given the current file contents, the old
 * and new digests, and a date, return the rewritten contents plus a summary.
 *
 * Byte-parity between the standalone Dockerfile and the BuildConfig's inlined
 * copy is preserved because the SAME `pinPrefix<hex>` token is swapped in both,
 * touching nothing else — so recipeHex(newDockerfile) is exactly what
 * check-action-pins.mjs recomputes from the file it writes.
 */
export function applyRunnerCascade({ files, pinPrefix, oldHex, newHex, date }) {
  const oldPin = `${pinPrefix}${oldHex}`;
  const newPin = `${pinPrefix}${newHex}`;
  const swapDigest = (text) => text.split(oldPin).join(newPin);

  const newDockerfile = swapDigest(files.dockerfile.content);
  const oldStamp = parseStamp(files.buildconfig.content);
  if (!oldStamp) throw new Error('could not find the chd-ci-runner stamp in the BuildConfig');
  const newStamp = computeStamp(newDockerfile, date);

  const rewritten = {};
  rewritten[files.dockerfile.path] = newDockerfile;
  for (const { path, content } of Object.values(files.stamp)) {
    // The BuildConfig carries both the digest (inline FROM + input) and the
    // stamp (output tag); every other stamp file carries only the stamp.
    let next = swapDigest(content);
    next = next.split(oldStamp).join(newStamp);
    rewritten[path] = next;
  }
  return { rewritten, oldStamp, newStamp };
}

/** Read a repo-relative file into { path, content }. */
function readFile(rel, root) {
  return { path: rel, content: readFileSync(join(root, rel), 'utf8') };
}

/**
 * Evaluate one target against its currently-resolved digest. Returns the set of
 * { path -> newContent } rewrites (empty when up to date) plus a human summary
 * line. Pure w.r.t. the filesystem read here; writing is the caller's job.
 */
export function planTarget(target, newDigest, root = REPO_ROOT) {
  const newHex = newDigest.replace(/^sha256:/, '');
  if (target.kind === 'simple') {
    const rel = target.file;
    const { content } = readFile(rel, root);
    const { text, oldHex, changed } = rewriteSimpleDigest(content, target.pinPrefix, newHex);
    return {
      changed,
      oldHex,
      newHex,
      rewrites: changed ? { [rel]: text } : {},
      summary: changed
        ? `${target.id}: MOVED sha256:${oldHex.slice(0, 12)}… -> sha256:${newHex.slice(0, 12)}… (${rel})`
        : `${target.id}: up to date (sha256:${oldHex.slice(0, 12)}…)`,
    };
  }

  // runner cascade
  const dockerfile = readFile(target.dockerfile, root);
  const stamp = {};
  for (const rel of target.stampFiles) stamp[rel] = readFile(rel, root);
  const buildconfig = stamp[target.buildconfig];
  const currentPin = new RegExp(escapeRegExp(target.pinPrefix) + `(${HEX64_RE})`).exec(
    dockerfile.content
  );
  if (!currentPin) throw new Error(`pin \`${target.pinPrefix}<digest>\` not found in ${target.dockerfile}`);
  const oldHex = currentPin[1];
  if (oldHex === newHex) {
    return {
      changed: false,
      oldHex,
      newHex,
      rewrites: {},
      summary: `${target.id}: up to date (sha256:${oldHex.slice(0, 12)}…)`,
    };
  }
  const { rewritten, oldStamp, newStamp } = applyRunnerCascade({
    files: { dockerfile, buildconfig, stamp },
    pinPrefix: target.pinPrefix,
    oldHex,
    newHex,
    date: utcDate(),
  });
  return {
    changed: true,
    oldHex,
    newHex,
    oldStamp,
    newStamp,
    rewrites: rewritten,
    summary:
      `${target.id}: MOVED sha256:${oldHex.slice(0, 12)}… -> sha256:${newHex.slice(0, 12)}… ` +
      `and re-stamped ${oldStamp} -> ${newStamp} across ${Object.keys(rewritten).length} file(s)`,
  };
}

/** Compose the PR body from the applied per-target results. */
export function composeSummary(results) {
  const moved = results.filter((r) => r.plan.changed);
  const lines = [
    '## Automated base-image digest refresh',
    '',
    'The scheduled `base-image-digest-refresh` workflow re-resolved each pinned',
    "digest that Dependabot's docker updater does not cover and found the",
    'following upstream move(s):',
    '',
  ];
  for (const { target, plan } of moved) {
    lines.push(`### ${target.description}`);
    lines.push('');
    lines.push(`- Upstream tag followed: \`${target.registry}/${target.repository}:${target.tag}\``);
    lines.push(`- \`sha256:${plan.oldHex}\` -> \`sha256:${plan.newHex}\``);
    if (plan.newStamp) {
      lines.push(`- Recomputed content stamp: \`${plan.oldStamp}\` -> \`${plan.newStamp}\``);
    }
    lines.push(`- Files: ${Object.keys(plan.rewrites).map((f) => `\`${f}\``).join(', ')}`);
    lines.push('');
  }
  lines.push('Review the upstream release notes before merging. `npm run gate:action-pins`');
  lines.push('must stay green (the pins remain digest-pinned; only the digests move).');
  return lines.join('\n');
}

function setOutput(name, value) {
  const out = process.env.GITHUB_OUTPUT;
  if (!out) return;
  appendFileSync(out, `${name}=${value}\n`);
}

export async function run({ apply, summaryFile }, { root = REPO_ROOT, fetchImpl = fetch } = {}) {
  const results = [];
  for (const target of TARGETS) {
    const digest = await resolveDigest(target, fetchImpl);
    const plan = planTarget(target, digest, root);
    results.push({ target, plan });
    console.log(plan.summary);
  }

  const changed = results.filter((r) => r.plan.changed);
  if (apply) {
    for (const { plan } of changed) {
      for (const [rel, content] of Object.entries(plan.rewrites)) {
        writeFileSync(join(root, rel), content);
      }
    }
    if (changed.length && summaryFile) {
      writeFileSync(summaryFile, composeSummary(results));
    }
    setOutput('changed', changed.length ? 'true' : 'false');
    setOutput('count', String(changed.length));
    console.log(
      changed.length
        ? `Applied ${changed.length} digest refresh(es).`
        : 'All pinned digests are current; nothing to write.'
    );
  } else {
    console.log(
      changed.length
        ? `\nDry run: ${changed.length} digest(s) have moved and WOULD be rewritten (run with --apply to open a PR).`
        : '\nDry run: all pinned digests are current.'
    );
    if (changed.length) console.log('\n--- PR body preview ---\n' + composeSummary(results));
  }
  return results;
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const sfIndex = args.indexOf('--summary-file');
  const summaryFile = sfIndex !== -1 ? args[sfIndex + 1] : null;
  await run({ apply, summaryFile });
}

// Fire only as a CLI (the house realpath pattern from check-action-pins.mjs), so
// importing this module for tests never triggers a live registry sweep.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`refresh-image-digests: ${error.message}`);
    process.exit(1);
  });
}
