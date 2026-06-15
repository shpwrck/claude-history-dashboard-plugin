#!/usr/bin/env node
// Release-gate check: a MINOR release cannot be cut until its standing review
// epics are closed.
//
// Every minor release (milestone vX.Y) is seeded with standing `release-gate`
// epics — a performance review and an architecture review, and from v0.3 onward
// a security review too (see docs/RELEASING.md). This script is the hard gate:
// it FAILS (non-zero exit) if the target milestone has no gating epics seeded,
// or if any of them are still open. The pass/fail rule is generic ("every
// release-gate epic in the milestone is closed"), so it already covers the
// third epic; only the "expected set" messaging is version-aware (#698). Run it
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
  const m = raw.match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
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

// Human-readable description of the standing set expected for a milestone.
function expectedSet(milestone) {
  return expectsSecurityGate(milestone)
    ? 'a performance epic, an architecture-review epic AND a security-review epic'
    : 'a performance epic AND an architecture-review epic';
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
        '--json', 'number,title,state',
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

  const open = gateIssues.filter((i) => i.state.toLowerCase() === 'open');
  const closed = gateIssues.filter((i) => i.state.toLowerCase() === 'closed');

  const expectedCount = expectsSecurityGate(resolved) ? 3 : 2;
  if (gateIssues.length < expectedCount) {
    // Fewer gating epics than the standing set for this milestone. Warn loudly;
    // the open check below still governs pass/fail.
    console.error(
      `! Warning: ${resolved} has only ${gateIssues.length} ${GATE_LABEL} epic(s) — ` +
      `expected ${expectedCount} (${expectedSet(resolved)}).`,
    );
  }

  if (open.length > 0) {
    const list = open.map((i) => `    #${i.number}  ${i.title}`).join('\n');
    fail(
      `${open.length} of ${gateIssues.length} ${GATE_LABEL} epic(s) for ${resolved} still OPEN:\n${list}\n\n` +
      `  Close them (or move them to a later milestone) before cutting ${resolved}.`,
    );
  }

  const list = closed.map((i) => `    #${i.number}  ${i.title}`).join('\n');
  console.log(`\n✓ Release gate OPEN for ${resolved} — all ${closed.length} ${GATE_LABEL} epic(s) closed:\n${list}\n`);
  process.exit(0);
}

// Run as a script, but stay importable (the test imports `classifyTarget`
// without triggering the gh-backed gate). Resolve symlinks so the worktree /
// npm-bin invocation paths still match.
const invokedDirectly =
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (invokedDirectly) main();
