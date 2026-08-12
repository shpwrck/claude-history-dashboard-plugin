#!/usr/bin/env node
// Auto-seed the standing release-gate epics for a release milestone (#721).
//
// docs/RELEASING.md -> "Release-gating epics" makes every minor release carry
// standing review epics (performance / architecture, plus security from v0.3
// onward, #698, and data-integrity from v0.6 onward, #2130), seeded DORMANT at
// release start as concern buckets per the
// two-phase model (#642): they bank concerns during the feature phase and are
// only groomed/decomposed at the review phase. `scripts/check-release-gate.mjs`
// is the *check* half of that contract — it fails the cut when the epics are
// missing or open. This script is the *seed* half, turned into a guarantee:
// `.github/workflows/seed-release-gates.yml` runs it when a milestone is
// created (and via workflow_dispatch for backfill), so a release milestone can
// no longer start life without its gates.
//
// Behaviour:
//   - Non-`vX.Y` milestone names ("Future", prose buckets) are NOT an error:
//     log "not a release milestone, skipping" and exit 0.
//   - Patch milestones (`x.y.z`, z>0) are skipped too — the gate is a
//     per-minor-cycle checkpoint and patches are exempt (#652).
//   - IDEMPOTENT: a `release-gate` epic whose domain label already exists in
//     the milestone (open OR closed) is skipped; re-running on a fully seeded
//     milestone is a no-op.
//   - The version-aware expected set lives in exactly one place:
//     `expectsSecurityGate()` is imported from check-release-gate.mjs.
//
// Usage:
//   node scripts/seed-release-gates.mjs v0.4      # or v0.4.0 — the cut-name
//                                                 # convention since #1045
// Env: GITHUB_TOKEN (or GH_TOKEN) with issues:write; GH_REPO or
// GITHUB_REPOSITORY as owner/repo. Talks plain fetch to api.github.com.

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  classifyTarget,
  expectsSecurityGate,
  expectsDataIntegrityGate,
  missingDistinctGateLabels,
} from './check-release-gate.mjs';

const API_ROOT = 'https://api.github.com';
const GATE_LABEL = 'release-gate';
const RELEASE_MILESTONE = /^v\d+\.\d+(\.\d+)?$/;

// The standing gate domains. `label` is the domain label the idempotency check
// keys on (and the one docs/RELEASING.md prescribes); `security` only applies
// from v0.3 onward and `data-integrity` only from v0.6 onward — see
// expectedGateDomains().
export const GATE_DOMAINS = [
  {
    key: 'performance',
    label: 'performance',
    title: (milestone) => `Performance review for ${milestone}`,
    concern: 'performance',
    groomHint: 'a fresh performance-review pass (perf probes, bundle/ingest budgets)',
  },
  {
    key: 'architecture',
    label: 'tech-debt',
    title: (milestone) => `Architecture review for ${milestone}`,
    concern: 'architecture',
    groomHint: 'the next improve-codebase-architecture round',
  },
  {
    key: 'security',
    label: 'security',
    title: (milestone) => `Security review for ${milestone}`,
    concern: 'security',
    groomHint: 'a fresh /security-review pass',
  },
  {
    key: 'data-integrity',
    label: 'data-integrity',
    title: (milestone) => `Data-integrity review for ${milestone}`,
    concern: 'data-integrity',
    groomHint:
      'a fresh data-integrity pass — audit that every recommendation/calculation shipped ' +
      'this cycle is provable (evidence-backed and reproducible per docs/adding-a-recommendation.md), ' +
      'the arithmetic is re-derived and faultless, stale signals are demoted to "as of <date>", ' +
      'and every `validated` fix snippet is genuinely copy-paste-safe',
  },
];

// The expected standing set for a milestone. Version-awareness is delegated to
// check-release-gate.mjs so the "which gates does vX.Y expect" rule lives in
// exactly one place (#698, #2130): security is dropped below v0.3 and
// data-integrity below v0.6.
export function expectedGateDomains(milestoneTitle) {
  const dropped = new Set();
  if (!expectsSecurityGate(milestoneTitle)) dropped.add('security');
  if (!expectsDataIntegrityGate(milestoneTitle)) dropped.add('data-integrity');
  return GATE_DOMAINS.filter((d) => !dropped.has(d.key));
}

// Decide whether a milestone title should be seeded at all.
//   { seed: true,  title }                    -> a minor release milestone
//   { seed: false, reason: 'not-release' }    -> "Future" etc. — skip, exit 0
//   { seed: false, reason: 'patch' }          -> x.y.z hotfix — skip, exit 0
export function classifySeedTarget(title) {
  const trimmed = String(title ?? '').trim();
  if (!RELEASE_MILESTONE.test(trimmed)) {
    return { seed: false, reason: 'not-release', title: trimmed };
  }
  if (classifyTarget(trimmed).isPatch) {
    return { seed: false, reason: 'patch', title: trimmed };
  }
  return { seed: true, title: trimmed };
}

export function usesIncrementalReleaseAudit(milestoneTitle) {
  const match = /^v(\d+)\.(\d+)(?:\.\d+)?$/.exec(
    String(milestoneTitle ?? '').trim()
  );
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 0 || minor >= 7;
}

export function releaseAuditScopeSection(milestoneTitle) {
  if (!usesIncrementalReleaseAudit(milestoneTitle)) return [];
  return [
    '## Review scope',
    '',
    'Use the deterministic release-scope policy in ' +
      '`scripts/audits/release-audit-scope.mjs`: pass the previous release tag ' +
      'with `--previous-tag` and the immutable candidate with `--head`. The ' +
      'automatic set is changed paths plus direct TS/JS static-relative importers ' +
      'and tracked text files containing an exact old/new path in either tree. ' +
      'Deleted/renamed old paths remain evidenced tombstones; only head-present ' +
      'paths are dispatched.',
    '',
    'A reviewer may add an adjacent path only as `--add <path> --reason <why>`; ' +
      'the reason is sealed in the scope manifest. `--full-audit` is the explicit ' +
      'opt-in escape hatch, never the default. Use the v0.7 ledger/state/artifact ' +
      'names (`v070-*`); do not reinterpret the immutable v0.6 receipts.',
    '',
  ];
}

// Dormant concern-bucket body, mirroring the v0.4.0 gate epics (#1071/#1072/
// #1073) and the two-phase model in docs/RELEASING.md: seeded at release start,
// NOT decomposed until the review phase.
export function gateEpicBody(domain, milestoneTitle) {
  const reviewScope = releaseAuditScopeSection(milestoneTitle);
  return [
    '## Why',
    '',
    `Standing ${domain.concern}-review gate for ${milestoneTitle}: the release cannot be cut ` +
      'until this epic is **closed** (`scripts/check-release-gate.mjs`, run by ' +
      '`release-gate.yml`). Per the two-phase model (#642, docs/RELEASING.md -> ' +
      '"Two-phase model: build first, review last"), this epic is **dormant** during ' +
      'the feature phase — do **not** decompose, groom, or burn it until the review ' +
      'phase (all non-gate burnable work in the milestone drained).',
    '',
    '## Concerns raised during the release',
    '',
    `While ${milestoneTitle} is built, dump any ${domain.concern} concern surfaced during ` +
      'feature work here (a checklist line or a comment) instead of filing a loose ' +
      'issue. This bank is the raw input when the epic wakes.',
    '',
    '- [ ] _(none yet)_',
    '',
    '## Scope',
    '',
    'Groom at the review phase: decompose the banked concerns — plus ' +
      `${domain.groomHint} — into sub-issues (clean titles, \`epic-NNN\` label, ` +
      'native sub-issue links).',
    '',
    ...reviewScope,
    '## Acceptance',
    '',
    'Closes when drained: every sub-issue closed and the concern checklist above ' +
      `worked off (or explicitly moved to a later milestone). Closing this epic is ` +
      `part of what opens the release gate for the ${milestoneTitle} cut.`,
    '',
  ].join('\n');
}

// Resolve the milestone object for a target name. Exact title match wins; a
// dispatch backfill may pass `v0.4` while the milestone is named `v0.4.0` (the
// cut-name drift, #1045), so fall back to the minor-cycle equivalence that
// classifyTarget() defines.
export function findMilestone(milestones, target) {
  const list = milestones || [];
  const exact = list.find((m) => String(m.title).trim() === target);
  if (exact) return exact;
  const want = classifyTarget(target).milestone;
  return (
    list.find((m) => {
      const title = String(m.title).trim();
      if (!RELEASE_MILESTONE.test(title)) return false;
      const c = classifyTarget(title);
      return !c.isPatch && c.milestone === want;
    }) ?? null
  );
}

function labelNames(issue) {
  return (issue.labels || []).map((l) => (typeof l === 'string' ? l : l.name));
}

// Which expected domains are NOT yet covered by an existing release-gate epic
// (open or closed) in the milestone. An issue covers a domain when it carries
// both the gate label and that domain's label.
export function missingGateDomains(existingIssues, milestoneTitle) {
  const gates = (existingIssues || []).filter((issue) => {
    if (issue.pull_request) return false; // the issues API lists PRs too
    return labelNames(issue).includes(GATE_LABEL);
  });
  const expected = expectedGateDomains(milestoneTitle);
  const missingLabels = new Set(missingDistinctGateLabels(
    expected.map((domain) => domain.label),
    gates,
  ));
  return expected.filter((domain) => missingLabels.has(domain.label));
}

// Seed the standing gate epics for `target`. Pure of process.* so the test can
// drive it with a mocked fetch; the CLI wrapper below wires env + global fetch.
export async function seedReleaseGates(target, options = {}) {
  const {
    fetchImpl = fetch,
    token,
    repo,
    log = (msg) => console.log(msg),
  } = options;

  const classified = classifySeedTarget(target);
  if (!classified.seed) {
    if (classified.reason === 'patch') {
      log(
        `✓ "${classified.title}" is a patch/hotfix milestone — the release gate is a ` +
          'per-minor-cycle checkpoint (see docs/RELEASING.md), skipping.',
      );
    } else {
      log(`✓ "${classified.title}" is not a release milestone (vX.Y), skipping.`);
    }
    return { seeded: false, reason: classified.reason, created: [], existing: [] };
  }

  if (!token) throw new Error('No GitHub token — set GITHUB_TOKEN (or GH_TOKEN).');
  if (!repo) throw new Error('No repository — set GH_REPO or GITHUB_REPOSITORY (owner/repo).');

  async function api(path, init = {}) {
    const res = await fetchImpl(`${API_ROOT}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'seed-release-gates',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`GitHub API ${init.method || 'GET'} ${path} -> ${res.status} ${detail}`.trim());
    }
    return res.json();
  }

  // Follow per_page/page pagination to exhaustion: state=all lists include
  // every closed milestone/issue ever, so a single 100-row page eventually
  // misses a real milestone and the seed run fails spuriously.
  async function apiPaged(path) {
    const out = [];
    for (let page = 1; ; page += 1) {
      const sep = path.includes('?') ? '&' : '?';
      const batch = await api(`${path}${sep}per_page=100&page=${page}`);
      if (!Array.isArray(batch) || batch.length === 0) break;
      out.push(...batch);
      if (batch.length < 100) break;
    }
    return out;
  }

  // `state=all`: seeding must also see a milestone someone already closed gates
  // on (idempotency is open OR closed), and backfill may target a closed one.
  const milestones = await apiPaged(`/repos/${repo}/milestones?state=all`);
  const milestone = findMilestone(milestones, classified.title);
  if (!milestone) {
    throw new Error(
      `Milestone "${classified.title}" not found in ${repo} — create the milestone first, ` +
        'then re-run (workflow_dispatch input must name an existing milestone).',
    );
  }

  const existingGates = await apiPaged(
    `/repos/${repo}/issues?milestone=${milestone.number}&labels=${GATE_LABEL}&state=all`,
  );
  const missing = missingGateDomains(existingGates, milestone.title);
  const expected = expectedGateDomains(milestone.title);
  const existing = expected.filter((d) => !missing.some((m) => m.key === d.key));

  for (const domain of existing) {
    log(`✓ ${milestone.title} already has a ${GATE_LABEL} epic for "${domain.label}" — skipping.`);
  }

  const created = [];
  for (const domain of missing) {
    const issue = await api(`/repos/${repo}/issues`, {
      method: 'POST',
      body: JSON.stringify({
        title: domain.title(milestone.title),
        body: gateEpicBody(domain, milestone.title),
        labels: ['epic', GATE_LABEL, domain.label],
        milestone: milestone.number,
      }),
    });
    created.push({ domain: domain.key, number: issue.number, title: issue.title });
    log(`✓ Seeded dormant ${domain.key} gate epic #${issue.number} for ${milestone.title}.`);
  }

  if (created.length === 0) {
    log(`✓ ${milestone.title} is fully seeded (${expected.length} gate epic(s)) — nothing to do.`);
  }
  return {
    seeded: true,
    milestone: milestone.title,
    created,
    existing: existing.map((d) => d.key),
  };
}

function fail(msg) {
  // `::error::` surfaces as an annotation in the Actions UI.
  console.error(`\n::error::${msg}`);
  process.exit(1);
}

async function main() {
  const target = process.argv[2];
  if (!target) {
    fail('Usage: node scripts/seed-release-gates.mjs <milestone, e.g. v0.4>');
    return;
  }
  try {
    await seedReleaseGates(target, {
      token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN,
      repo: process.env.GH_REPO || process.env.GITHUB_REPOSITORY,
    });
  } catch (err) {
    fail(err.message);
  }
}

// Run as a script, but stay importable (the test imports the pure pieces and
// drives seedReleaseGates with a mocked fetch). Resolve symlinks so worktree /
// npm-bin invocation paths still match.
const invokedDirectly =
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (invokedDirectly) await main();
