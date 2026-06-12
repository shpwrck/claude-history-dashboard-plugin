#!/usr/bin/env node
// Label a release milestone's merged PRs with their domain label (#716).
//
// `gh release create --generate-notes` buckets merged PRs into the sections in
// .github/release.yml BY THEIR LABELS, so an unlabeled PR collapses into
// "Other changes" and the changelog reads as a flat dump. This helper makes the
// categorization actually populate: given a milestone (vX.Y or vX.Y.Z), it lists
// the milestone's merged PRs and adds the domain label each one is missing.
//
// Classification is CONSERVATIVE — a label is only applied when the evidence is
// unambiguous, in this order:
//   1. Linked-issue labels: the PR's `Closes #N` body references (plus the repo's
//      `[#N] ...` title convention) are resolved and their domain labels
//      collected. Exactly one distinct domain label across the linked issues ->
//      apply it. More than one -> ambiguous, listed for hand-labeling.
//   2. Title prefix: `[feature]`/`feat:` -> enhancement, `fix:`/`[fix]` -> bug,
//      `docs:`/`docs(...)` -> documentation, `perf:` -> performance,
//      `[chore]`/`refactor:` -> tech-debt, `ci:`/`build:`/`[infra]` -> infra,
//      `[security]` -> security, `[ui]` -> ui.
// PRs neither rule can classify are LISTED for hand-labeling, never guessed.
// PRs that already carry a domain label are skipped (idempotent).
//
// The domain-label set is read from .github/release.yml (every category label
// except the `*` catch-all), so this script and the changelog bucketing share
// one source of truth.
//
// Usage:
//   node scripts/label-milestone-prs.mjs <vX.Y> [--dry-run]
// Env: GH_TOKEN (or GITHUB_TOKEN) — a token with issues:write;
//      GH_REPO (or GITHUB_REPOSITORY) — owner/repo.
// CI: .github/workflows/label-milestone-prs.yml (workflow_dispatch) runs it from
// the Actions tab before notes are generated — see docs/RELEASING.md.
//
// Like ensure-pr-milestone.mjs, the pure logic is exported and unit-tested
// without the network (scripts/label-milestone-prs.test.mjs, mocked fetch);
// `npm run test:label-milestone-prs`.

import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// release.yml: the single source of truth for category order + domain labels.
// ---------------------------------------------------------------------------

// Minimal parser for the exact shape of .github/release.yml (changelog ->
// exclude.labels + categories[].title/labels). Not a general YAML parser; it
// exists so the domain-label set and category order are never duplicated here.
export function parseReleaseConfig(yamlText) {
  const exclude = [];
  const categories = [];
  let mode = null; // 'exclude' | 'categories'
  let current = null;
  for (const rawLine of String(yamlText ?? '').split('\n')) {
    const noComment = rawLine.replace(/(^|\s)#.*$/, '');
    const trimmed = noComment.trim();
    if (!trimmed) continue;
    if (/^exclude:/.test(trimmed)) { mode = 'exclude'; continue; }
    if (/^categories:/.test(trimmed)) { mode = 'categories'; continue; }
    if (/^(changelog|labels):/.test(trimmed)) continue;
    const title = trimmed.match(/^-\s*title:\s*(.+)$/);
    if (title && mode === 'categories') {
      current = { title: unquote(title[1]), labels: [] };
      categories.push(current);
      continue;
    }
    const item = trimmed.match(/^-\s*(.+)$/);
    if (item) {
      const value = unquote(item[1]);
      if (mode === 'exclude') exclude.push(value);
      else if (mode === 'categories' && current) current.labels.push(value);
    }
  }
  return { exclude, categories };
}

function unquote(s) {
  const t = String(s).trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

// Every category label except the `*` catch-all is a domain label.
export function domainLabels(config) {
  return [...new Set(config.categories.flatMap((c) => c.labels).filter((l) => l !== '*'))];
}

export function loadReleaseConfig() {
  const here = dirname(fileURLToPath(import.meta.url));
  return parseReleaseConfig(readFileSync(join(here, '..', '.github', 'release.yml'), 'utf8'));
}

// ---------------------------------------------------------------------------
// Classification (pure).
// ---------------------------------------------------------------------------

// Title-prefix token -> domain label. Only tokens with one obvious home are
// mapped; anything else (e.g. `[release]`, a bare `[#123]`) is unclassified.
export const TITLE_TOKEN_TO_LABEL = {
  feat: 'enhancement',
  feature: 'enhancement',
  fix: 'bug',
  bugfix: 'bug',
  bug: 'bug',
  hotfix: 'bug',
  docs: 'documentation',
  doc: 'documentation',
  perf: 'performance',
  chore: 'tech-debt',
  refactor: 'tech-debt',
  infra: 'infra',
  ci: 'infra',
  build: 'infra',
  security: 'security',
  ui: 'ui',
};

// `[feature] ...` bracket convention or `feat(scope)!: ...` conventional-commit
// prefix. Returns a domain label or null (never guesses).
export function classifyFromTitle(title) {
  const t = String(title ?? '').trim();
  const bracket = t.match(/^\[([a-z-]+)\]/i);
  if (bracket) return TITLE_TOKEN_TO_LABEL[bracket[1].toLowerCase()] ?? null;
  const conventional = t.match(/^([a-z]+)(?:\([^)]*\))?!?:/i);
  if (conventional) return TITLE_TOKEN_TO_LABEL[conventional[1].toLowerCase()] ?? null;
  return null;
}

// Issue numbers a PR is "about": closing keywords in the body (the repo's
// `Closes #N` convention) plus the leading `[#N]` title convention.
export function parseIssueRefs(title, body) {
  const refs = new Set();
  const titleRef = String(title ?? '').match(/^\[#(\d+)\]/);
  if (titleRef) refs.add(Number(titleRef[1]));
  const closing = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+#(\d+)/gi;
  for (const m of String(body ?? '').matchAll(closing)) refs.add(Number(m[1]));
  return [...refs];
}

// Decide the label for one PR. linkedIssueLabels is the flattened label list of
// every linked issue; domains is the release.yml domain-label set.
// Returns { label, source } or { label: null, reason }.
export function classify({ title, linkedIssueLabels = [], domains }) {
  const fromIssues = [...new Set(linkedIssueLabels.filter((l) => domains.includes(l)))];
  if (fromIssues.length === 1) {
    return { label: fromIssues[0], source: 'issue-labels' };
  }
  if (fromIssues.length > 1) {
    return {
      label: null,
      reason: `linked issues carry ${fromIssues.length} domain labels (${fromIssues.join(', ')}) — ambiguous`,
    };
  }
  const fromTitle = classifyFromTitle(title);
  if (fromTitle) return { label: fromTitle, source: 'title-prefix' };
  return { label: null, reason: 'no linked-issue domain label and no recognized title prefix' };
}

// ---------------------------------------------------------------------------
// GitHub REST (fetch-based so tests inject a mock; also reused by
// scripts/backfill-release-notes.mjs).
// ---------------------------------------------------------------------------

export async function ghApi(path, { token, fetchImpl = globalThis.fetch, method = 'GET', body } = {}) {
  const url = path.startsWith('https://') ? path : `https://api.github.com${path}`;
  const res = await fetchImpl(url, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`GitHub API ${method} ${path} -> ${res.status}${detail ? ` ${detail}` : ''}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

export async function ghPaged(path, opts) {
  const all = [];
  for (let page = 1; page <= 20; page++) {
    const sep = path.includes('?') ? '&' : '?';
    const items = await ghApi(`${path}${sep}per_page=100&page=${page}`, opts);
    all.push(...items);
    if (items.length < 100) break;
  }
  return all;
}

function labelNames(labels) {
  return (labels || []).map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Orchestration (network via injected fetch; exercised by the test with mocks).
// ---------------------------------------------------------------------------

export async function labelMilestonePrs({
  repo,
  milestoneTitle,
  token,
  fetchImpl = globalThis.fetch,
  apply = true,
  config = loadReleaseConfig(),
  log = console.log,
}) {
  const opts = { token, fetchImpl };
  const domains = domainLabels(config);

  const milestones = await ghPaged(`/repos/${repo}/milestones?state=all`, opts);
  const milestone = milestones.find((m) => m.title === milestoneTitle);
  if (!milestone) {
    throw new Error(
      `milestone "${milestoneTitle}" not found in ${repo} (have: ${milestones.map((m) => m.title).join(', ') || 'none'})`,
    );
  }

  // The issues list endpoint returns issues AND PRs; merged PRs carry
  // pull_request.merged_at. state=all so closed-but-unmerged PRs can be excluded
  // explicitly rather than by accident.
  const items = await ghPaged(`/repos/${repo}/issues?milestone=${milestone.number}&state=all`, opts);
  const prs = items.filter((i) => i.pull_request && i.pull_request.merged_at);

  const labeled = [];
  const skipped = [];
  const unclassified = [];
  const issueLabelCache = new Map();

  for (const pr of prs) {
    const existing = labelNames(pr.labels).filter((l) => domains.includes(l));
    if (existing.length > 0) {
      skipped.push({ number: pr.number, title: pr.title, labels: existing });
      continue;
    }

    const linkedIssueLabels = [];
    for (const n of parseIssueRefs(pr.title, pr.body)) {
      if (n === pr.number) continue; // a self-reference carries no signal
      if (!issueLabelCache.has(n)) {
        let labels = [];
        try {
          const issue = await ghApi(`/repos/${repo}/issues/${n}`, opts);
          // A reference to another PR is not an issue-label signal.
          if (!issue.pull_request) labels = labelNames(issue.labels);
        } catch (err) {
          // Deleted/transferred issue: degrade to "no signal", do not abort the run.
          log(`  ! could not read linked issue #${n}: ${err.message}`);
        }
        issueLabelCache.set(n, labels);
      }
      linkedIssueLabels.push(...issueLabelCache.get(n));
    }

    const decision = classify({ title: pr.title, linkedIssueLabels, domains });
    if (!decision.label) {
      unclassified.push({ number: pr.number, title: pr.title, reason: decision.reason });
      continue;
    }
    if (apply) {
      await ghApi(`/repos/${repo}/issues/${pr.number}/labels`, {
        ...opts,
        method: 'POST',
        body: { labels: [decision.label] },
      });
    }
    labeled.push({ number: pr.number, title: pr.title, label: decision.label, source: decision.source });
  }

  return { milestone: milestone.title, merged: prs.length, labeled, skipped, unclassified };
}

// ---------------------------------------------------------------------------
// CLI.
// ---------------------------------------------------------------------------

function fail(msg) {
  console.error(`\n::error::${msg}`);
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const milestoneTitle = args.find((a) => !a.startsWith('--'));
  if (!milestoneTitle || !/^v\d+\.\d+(\.\d+)?$/.test(milestoneTitle)) {
    fail('Usage: node scripts/label-milestone-prs.mjs <vX.Y|vX.Y.Z> [--dry-run]');
    return;
  }
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) {
    fail('Set GH_TOKEN (or GITHUB_TOKEN) to a token with issues:write.');
    return;
  }
  const repo = process.env.GH_REPO || process.env.GITHUB_REPOSITORY;
  if (!repo) {
    fail('Set GH_REPO (or GITHUB_REPOSITORY) to owner/repo.');
    return;
  }

  let result;
  try {
    result = await labelMilestonePrs({ repo, milestoneTitle, token, apply: !dryRun });
  } catch (err) {
    fail(err.message);
    return;
  }

  const verb = dryRun ? 'would label' : 'labeled';
  console.log(`\nMilestone ${result.milestone}: ${result.merged} merged PR(s).`);
  for (const p of result.labeled) {
    console.log(`  ✓ ${verb} #${p.number} "${p.title}" -> ${p.label} (${p.source})`);
  }
  console.log(`  ${result.skipped.length} PR(s) already carry a domain label — skipped.`);
  if (result.unclassified.length > 0) {
    console.log(`\nUnclassifiable — label these BY HAND before generating notes:`);
    for (const p of result.unclassified) {
      console.log(`  ? #${p.number} "${p.title}" — ${p.reason}`);
    }
    console.log(`\n::warning::${result.unclassified.length} PR(s) in ${result.milestone} need hand-labeling (listed above).`);
  }
  if (dryRun) console.log('\nDry run — no labels were applied. Re-run without --dry-run to apply.');
}

const invokedDirectly =
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (invokedDirectly) await main();
