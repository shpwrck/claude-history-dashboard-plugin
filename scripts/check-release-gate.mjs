#!/usr/bin/env node
// Release-gate check: a MINOR release cannot be cut until its standing review
// epics are closed and the milestone has no unfinished non-gate work.
//
// Every minor release (milestone vX.Y) is seeded with standing `release-gate`
// epics — a performance review and an architecture review, from v0.3 onward a
// security review too (#698), and from v0.6 onward a data-integrity review
// (#2130) (see docs/RELEASING.md). This script is the hard gate: it FAILS
// (non-zero exit) if the target milestone lacks the expected number or distinct
// domains of gating epics, if any gate is open, or if non-gate work remains.
// The expected cardinality and domain labels are version-aware (#698, #2130).
// Open work may be
// deliberately exempted only with the explicit `release-deferred` label; normal
// deferral should move the issue to a later milestone. Run this
// before `gh release create`, and in CI on tag push.
//
// PATCH / hotfix releases (`x.y.z`, z>0) are EXEMPT: the perf/architecture/
// security gate is a per-minor-cycle debt checkpoint, so a patch on an already-
// shipped minor is not re-gated (it would fail closed against a milestone whose
// review epics shipped a cycle ago). A patch target passes with an explanatory
// message; only a minor cut (bare `x.y` or `x.y.0`) consults the milestone. See #652.
//
// Usage:
//   node scripts/check-release-gate.mjs            # version from package.json
//   node scripts/check-release-gate.mjs v0.2       # minor cut -> gates v0.2
//   node scripts/check-release-gate.mjs 0.2.0      # minor cut -> gates v0.2
//   node scripts/check-release-gate.mjs v0.1.1     # patch/hotfix -> exempt
//
// Requires the `gh` CLI authenticated for this repo (CI: set GH_TOKEN to a
// token with `issues: read`). Repo is auto-detected from the working dir; set
// GH_REPO to override.

import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const GATE_LABEL = 'release-gate';
const DEFERRED_LABEL = 'release-deferred';

function gh(args) {
  const repo = process.env.GH_REPO;
  const full = repo ? [...args, '--repo', repo] : args;
  return execFileSync('gh', full, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// Classify a release target into its minor milestone and whether it is a PATCH
// (hotfix) cut. The gate is a per-minor-cycle checkpoint, so only a minor cut
// (bare `x.y` or `x.y.0`) is gated; a patch (`x.y.z`, z>0) is exempt.
//   v0.2 / 0.2      -> { milestone: 'v0.2', patch: null, isPatch: false }
//   0.2.0 / v0.2.0  -> { milestone: 'v0.2', patch: 0,    isPatch: false }
//   0.1.1 / v0.1.1  -> { milestone: 'v0.1', patch: 1,    isPatch: true  }
export function classifyTarget(arg) {
  const raw = String(arg).trim().replace(/^v/i, '');
  // End-anchored: the ENTIRE normalized argument must be a supported version.
  // Without the `$`, a prefix-only match accepted `v0.2.1junk` as patch 1 and
  // main() exited 0 through the patch exemption BEFORE inspecting the milestone
  // gates — a malformed target could bypass the standing release checks (#3074).
  const m = raw.match(/^(\d+)\.(\d+)(?:\.(\d+))?$/);
  if (!m) {
    throw new Error(`Cannot parse a milestone from "${arg}". Pass a version like v0.2 / 0.2 / 0.2.0.`);
  }
  const patch = m[3] === undefined ? null : Number(m[3]);
  return {
    milestone: `v${m[1]}.${m[2]}`,
    patch,
    isPatch: patch !== null && patch > 0,
  };
}

// The security review is the third standing gate epic, rolled out from v0.3
// onward (#698). Earlier milestones (v0.1, v0.2) keep the perf+architecture pair
// and must NOT be flagged for a missing security epic. A milestone qualifies
// when it is >= v0.3: any major > 0, or major 0 with minor >= 3.
export function expectsSecurityGate(milestone) {
  const m = String(milestone).match(/v?(\d+)\.(\d+)/);
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return major > 0 || minor >= 3;
}

// The data-integrity review is the fourth standing gate epic, rolled out from
// v0.6 onward (#2130). It is the deliberate per-cycle check that every
// recommendation/calculation shipped this release is provable (evidence-backed,
// reproducible per docs/adding-a-recommendation.md) and arithmetically
// faultless. Earlier milestones (<= v0.5) keep the perf+architecture+security
// set and must NOT be flagged for a missing data-integrity epic. A milestone
// qualifies when it is >= v0.6: any major > 0, or major 0 with minor >= 6.
export function expectsDataIntegrityGate(milestone) {
  const m = String(milestone).match(/v?(\d+)\.(\d+)/);
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return major > 0 || minor >= 6;
}

// Domain labels for the standing set. These match seed-release-gates.mjs: the
// architecture concern intentionally uses the repository's `tech-debt` label.
export function expectedGateLabels(milestone) {
  const labels = ['performance', 'tech-debt'];
  if (expectsSecurityGate(milestone)) labels.push('security');
  if (expectsDataIntegrityGate(milestone)) labels.push('data-integrity');
  return labels;
}

// The number of distinct standing gate domains expected for the milestone.
export function expectedGateCount(milestone) {
  return expectedGateLabels(milestone).length;
}

function labelNames(issue) {
  return (issue.labels || []).map((entry) => entry.name || entry);
}

function versionTuple(value) {
  const match = String(value).match(/v(\d+)\.(\d+)(?:\.(\d+))?/i);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3] || 0)] : null;
}

function hasDeferralAudit(issue, milestone) {
  // The audit lives in the issue body, which `gh issue list --json body` returns
  // without the GraphQL comments(first: 100) truncation boundary.
  const body = String(issue.body || '');
  const destination = body.match(/\bdestination\s*:\s*(v\d+\.\d+(?:\.\d+)?)\b/i)?.[1];
  const target = versionTuple(milestone);
  const next = versionTuple(destination);
  if (!target || !next || !/\brationale\s*:\s*\S/i.test(body)) return false;
  return next.some((part, index) => part !== target[index]
    && part > target[index]
    && next.slice(0, index).every((prior, priorIndex) => prior === target[priorIndex]));
}

// Maximum bipartite matching: each expected domain must be covered by a
// different gate epic. A single epic carrying every label can satisfy only one
// domain, so label stacking cannot mask missing standing reviews.
export function missingDistinctGateLabels(expectedLabels, gateIssues) {
  const matchedDomainByIssue = new Map();
  function assign(domain, visited) {
    for (let index = 0; index < gateIssues.length; index += 1) {
      if (visited.has(index) || !labelNames(gateIssues[index]).includes(domain)) continue;
      visited.add(index);
      const previous = matchedDomainByIssue.get(index);
      if (previous === undefined || assign(previous, visited)) {
        matchedDomainByIssue.set(index, domain);
        return true;
      }
    }
    return false;
  }
  return expectedLabels.filter((domain) => !assign(domain, new Set()));
}

// Pure release-state policy used by the CLI and its tests. A minor release is
// open only when the standing gate count is complete, every gate is closed, and
// no non-gate milestone issue remains. `release-deferred` is an explicit escape
// hatch: it stays visible in the result/output rather than disappearing silently.
export function assessReleaseState(milestone, gateIssues, milestoneIssues, milestonePullRequests = []) {
  const expectedLabels = expectedGateLabels(milestone);
  const missingGateLabels = missingDistinctGateLabels(expectedLabels, gateIssues);
  const expectedCount = expectedLabels.length;
  const missingGateEpicCount = Math.max(0, expectedCount - gateIssues.length);
  const missingGateCount = Math.max(missingGateEpicCount, missingGateLabels.length);
  const openGates = gateIssues.filter((issue) => String(issue.state).toLowerCase() === 'open');
  const openMilestoneIssues = milestoneIssues.filter(
    (issue) => String(issue.state).toLowerCase() === 'open',
  );
  const deferred = openMilestoneIssues.filter(
    (issue) => labelNames(issue).includes(DEFERRED_LABEL) && hasDeferralAudit(issue, milestone),
  );
  const invalidDeferred = openMilestoneIssues.filter(
    (issue) => labelNames(issue).includes(DEFERRED_LABEL) && !hasDeferralAudit(issue, milestone),
  );
  const openIssues = openMilestoneIssues.filter((issue) => {
    const labels = labelNames(issue);
    return !labels.includes(GATE_LABEL) && !deferred.includes(issue);
  });
  const openPullRequests = milestonePullRequests.filter(
    (pull) => String(pull.state).toLowerCase() === 'open',
  );
  const openWork = [...openIssues, ...openPullRequests];
  return {
    ok: missingGateEpicCount === 0 && missingGateLabels.length === 0 && openGates.length === 0 && openWork.length === 0,
    expectedCount,
    missingGateCount,
    missingGateEpicCount,
    missingGateLabels,
    openGates,
    openWork,
    openPullRequests,
    deferred,
    invalidDeferred,
  };
}

// Human-readable description of the standing set expected for a milestone.
function expectedSet(milestone) {
  const epics = ['a performance epic', 'an architecture-review epic'];
  if (expectsSecurityGate(milestone)) epics.push('a security-review epic');
  if (expectsDataIntegrityGate(milestone)) epics.push('a data-integrity-review epic');
  const last = epics.pop();
  return `${epics.join(', ')} AND ${last}`;
}

// The milestone naming convention standardized on the three-part `vX.Y.Z` form
// (#1045, ensure-milestone), but earlier milestones used the two-part `vX.Y`
// (#722). classifyTarget normalizes to the two-part `milestone`; resolve the
// actual milestone title by trying the three-part name first (current
// convention), then the two-part, so the gate matches whichever the repo
// actually created.
//   { milestone: 'v0.4', patch: 0 }    -> ['v0.4.0', 'v0.4']
//   { milestone: 'v0.2', patch: null } -> ['v0.2.0', 'v0.2']
export function candidateMilestones(target) {
  const patch = target.patch == null ? 0 : target.patch;
  const threePart = `${target.milestone}.${patch}`;
  return [...new Set([threePart, target.milestone])];
}

function versionFromPackageJson() {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));
  if (!pkg.version) throw new Error('package.json has no version field.');
  return pkg.version;
}

function fail(msg) {
  console.error(`\n✗ Release gate BLOCKED — ${msg}\n`);
  process.exit(1);
}

function main() {
  let target;
  try {
    const arg = process.argv[2] || versionFromPackageJson();
    target = classifyTarget(arg);
  } catch (err) {
    fail(err.message);
    return;
  }
  const { milestone, patch, isPatch } = target;

  if (isPatch) {
    console.log(
      `\n✓ Release gate N/A for ${milestone}.${patch} — patch/hotfix release.\n` +
      `  The perf/architecture/security review gate is a per-minor-cycle checkpoint; a patch on\n` +
      `  an already-shipped minor is not re-gated. See docs/RELEASING.md -> "Hotfix / patch releases".\n`,
    );
    process.exit(0);
  }

  // Resolve the actual milestone title (three-part `vX.Y.Z` or two-part `vX.Y`).
  // `gh issue list` exits non-zero when the milestone title doesn't exist, so
  // try each candidate and use the first that resolves.
  const candidates = candidateMilestones(target);
  let gateIssues = null;
  let resolved = null;
  let lastErr = null;
  for (const name of candidates) {
    try {
      const out = gh([
        'issue', 'list',
        '--milestone', name,
        '--label', GATE_LABEL,
        '--state', 'all',
        '--limit', '200',
        '--json', 'number,title,state,labels',
      ]);
      gateIssues = JSON.parse(out);
      resolved = name;
      break;
    } catch (err) {
      lastErr = err;
    }
  }
  if (resolved === null) {
    fail(
      `could not find a milestone for "${milestone}" (tried ${candidates.join(', ')}) via gh ` +
      `(${(lastErr?.stderr || lastErr?.message || '').toString().trim()}).`,
    );
    return;
  }

  if (gateIssues.length === 0) {
    fail(
      `milestone "${resolved}" has no ${GATE_LABEL} epics seeded.\n` +
      `  Every release must carry ${expectedSet(resolved)}\n` +
      `  (labelled "${GATE_LABEL}", assigned to ${resolved}). Seed them before cutting —\n` +
      `  see docs/RELEASING.md -> "Release-gating epics".`,
    );
  }

  let milestoneIssues;
  try {
    milestoneIssues = JSON.parse(gh([
      'issue', 'list',
      '--milestone', resolved,
      '--state', 'open',
      '--limit', '1000',
      '--json', 'number,title,state,labels,body',
    ]));
  } catch (err) {
    fail(`could not inspect unfinished work in milestone "${resolved}" via gh (${(err?.stderr || err?.message || '').toString().trim()}).`);
    return;
  }

  let milestonePullRequests;
  try {
    milestonePullRequests = JSON.parse(gh([
      'pr', 'list',
      '--state', 'open',
      '--search', `milestone:${resolved}`,
      '--limit', '1000',
      '--json', 'number,title,state,labels',
    ]));
  } catch (err) {
    fail(`could not inspect open pull requests in milestone "${resolved}" via gh (${(err?.stderr || err?.message || '').toString().trim()}).`);
    return;
  }

  const assessment = assessReleaseState(resolved, gateIssues, milestoneIssues, milestonePullRequests);
  const closed = gateIssues.filter((i) => i.state.toLowerCase() === 'closed');

  if (assessment.missingGateCount > 0) {
    const shortages = [];
    if (assessment.missingGateEpicCount > 0) {
      shortages.push(
        `${resolved} has only ${gateIssues.length} ${GATE_LABEL} epic(s); expected ${assessment.expectedCount}.`,
      );
    }
    if (assessment.missingGateLabels.length > 0) {
      shortages.push(
        `${resolved} is missing required ${GATE_LABEL} domain label(s): ${assessment.missingGateLabels.join(', ')}.`,
      );
    }
    fail(
      `${shortages.join('\n')}\n` +
      `  Expected distinct coverage for ${expectedSet(resolved)}.\n` +
      `  Seed the missing standing gate${assessment.missingGateCount === 1 ? '' : 's'} before cutting ${resolved}.`,
    );
  }

  if (assessment.openGates.length > 0) {
    const list = assessment.openGates.map((i) => `    #${i.number}  ${i.title}`).join('\n');
    fail(
      `${assessment.openGates.length} of ${gateIssues.length} ${GATE_LABEL} epic(s) for ${resolved} still OPEN:\n${list}\n\n` +
      `  Close them (or move them to a later milestone) before cutting ${resolved}.`,
    );
  }

  if (assessment.openWork.length > 0) {
    const list = assessment.openWork.map((i) => `    #${i.number}  ${i.title}`).join('\n');
    const invalidNote = assessment.invalidDeferred.length
      ? `\n  Invalid ${DEFERRED_LABEL} exception(s) need issue-body fields "Destination: <later vX.Y.Z>" and "Rationale: ...".`
      : '';
    fail(
      `${assessment.openWork.length} unfinished non-gate issue(s) remain in ${resolved}:\n${list}\n\n` +
      `  Close them, move them to a later milestone, or explicitly label audited exceptions "${DEFERRED_LABEL}".` +
      invalidNote,
    );
  }

  const list = closed.map((i) => `    #${i.number}  ${i.title}`).join('\n');
  const deferredNote = assessment.deferred.length
    ? `\n  Explicitly deferred (${DEFERRED_LABEL}):\n${assessment.deferred.map((i) => `    #${i.number}  ${i.title}`).join('\n')}\n`
    : '';
  console.log(`\n✓ Release gate OPEN for ${resolved} — all ${closed.length} ${GATE_LABEL} epic(s) closed and non-gate work drained:\n${list}\n${deferredNote}`);
  process.exit(0);
}

// Run as a script, but stay importable (the test imports `classifyTarget`
// without triggering the gh-backed gate). Resolve symlinks so the worktree /
// npm-bin invocation paths still match.
const invokedDirectly =
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (invokedDirectly) main();
