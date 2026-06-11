#!/usr/bin/env node
// Milestone guard (#722): every PR merged to `master` must carry a milestone —
// the release-scope lens (docs/RELEASING.md -> "Milestones = release buckets").
// This is the enforcement half of a rule that used to be guidance only: #717
// merged after the v0.2 cut with NO milestone and was caught only by a manual
// audit, so it fell outside every release rollup and the label-driven changelog.
//
// Given a PR number, the script is idempotent:
//   - PR already has a milestone   -> no-op, exit 0.
//   - PR has none, one open vX.Y   -> assign that release milestone, exit 0.
//   - PR has none, zero or >1 open  -> exit non-zero with a clear message so a
//     vX.Y milestones (ambiguous)      human assigns it manually.
//
// The workflow runs it at PR-open (auto-assign, friction-free — the author can
// still override) and again on merge (a backstop, because required status checks
// can't gate merge on this repo, #241, so a red check alone wouldn't block a
// milestone-less merge). The vX.Y selection is exported pure so it is unit-tested
// without hitting the network (scripts/ensure-pr-milestone.test.mjs).
//
// Usage:
//   node scripts/ensure-pr-milestone.mjs <pr-number>
// Requires the `gh` CLI authenticated for this repo (CI: GH_TOKEN with
// issues:write + pull-requests:write). Repo auto-detected from `gh`; set GH_REPO
// (owner/repo) to override — CI sets it to ${{ github.repository }}.

import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// A release milestone is named `vX.Y` or `vX.Y.Z` (e.g. v0.3 or v0.4.0). The cut
// convention drifted to an optional patch segment from v0.4 onward (#1045), so the
// guard accepts both forms — otherwise auto-assign never fires for a `vX.Y.Z`
// milestone and every PR in that release fails this check. Standing buckets like
// "Future" are NOT release milestones and must never be auto-assigned — they are
// the deferral lane, not a cut.
const RELEASE_MILESTONE = /^v\d+\.\d+(\.\d+)?$/;

export function isReleaseMilestone(title) {
  return RELEASE_MILESTONE.test(String(title ?? '').trim());
}

// Choose the single open release milestone from a list of open milestones.
// Returns { ok: true, milestone } when exactly one `vX.Y` milestone is open;
// otherwise { ok: false, reason: 'none' | 'ambiguous', candidates }.
export function pickOpenReleaseMilestone(openMilestones) {
  const releases = (openMilestones || []).filter((m) => isReleaseMilestone(m.title));
  if (releases.length === 1) return { ok: true, milestone: releases[0] };
  if (releases.length === 0) return { ok: false, reason: 'none', candidates: [] };
  return { ok: false, reason: 'ambiguous', candidates: releases };
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function repoSlug() {
  if (process.env.GH_REPO) return process.env.GH_REPO;
  return gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']).trim();
}

function fail(msg) {
  // `::error::` surfaces as an annotation in the Actions UI.
  console.error(`\n::error::${msg}`);
  process.exit(1);
}

function main() {
  const prNumber = process.argv[2];
  if (!prNumber || !/^\d+$/.test(prNumber)) {
    fail('Usage: node scripts/ensure-pr-milestone.mjs <pr-number>');
    return;
  }

  let slug;
  try {
    slug = repoSlug();
  } catch (err) {
    fail(`could not resolve the repository (set GH_REPO=owner/repo): ${(err.stderr || err.message || '').toString().trim()}`);
    return;
  }

  // Idempotent: a PR that already has a milestone is left untouched.
  let current;
  try {
    current = gh(['pr', 'view', prNumber, '--repo', slug, '--json', 'milestone', '--jq', '.milestone.title // ""']).trim();
  } catch (err) {
    fail(`could not read PR #${prNumber} via gh: ${(err.stderr || err.message || '').toString().trim()}`);
    return;
  }
  if (current) {
    console.log(`✓ PR #${prNumber} already has milestone "${current}" — nothing to do.`);
    process.exit(0);
  }

  // No milestone: assign the single open release milestone, or fail if ambiguous.
  let open;
  try {
    const raw = gh(['api', `repos/${slug}/milestones?state=open&per_page=100`, '--jq', '[.[] | {title, number}]']);
    open = JSON.parse(raw);
  } catch (err) {
    fail(`could not list open milestones via gh: ${(err.stderr || err.message || '').toString().trim()}`);
    return;
  }

  const pick = pickOpenReleaseMilestone(open);
  if (!pick.ok) {
    if (pick.reason === 'none') {
      fail(
        `PR #${prNumber} has no milestone and there is no open release milestone (vX.Y) to assign. ` +
        `Open the next release milestone and re-run, or assign one manually. See docs/RELEASING.md -> "Milestones = release buckets".`,
      );
    } else {
      const list = pick.candidates.map((m) => m.title).join(', ');
      fail(
        `PR #${prNumber} has no milestone and ${pick.candidates.length} open release milestones exist (${list}) — ` +
        `can't pick automatically. Assign the intended one manually.`,
      );
    }
    return;
  }

  try {
    gh(['pr', 'edit', prNumber, '--repo', slug, '--milestone', pick.milestone.title]);
  } catch (err) {
    fail(`could not assign milestone "${pick.milestone.title}" to PR #${prNumber}: ${(err.stderr || err.message || '').toString().trim()}`);
    return;
  }
  console.log(`✓ PR #${prNumber} had no milestone — assigned the open release milestone "${pick.milestone.title}".`);
  process.exit(0);
}

// Run as a script, but stay importable (the test imports the pure pickers
// without triggering the gh-backed flow). Resolve symlinks so worktree / npm-bin
// invocation paths still match.
const invokedDirectly =
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (invokedDirectly) main();
