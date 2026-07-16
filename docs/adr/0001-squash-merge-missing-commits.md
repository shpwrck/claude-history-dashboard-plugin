# ADR 0001 — "Squash merge drops the second commit" is a misdiagnosis; the real cause is work commits never reaching the branch head

- **Status:** Accepted
- **Date:** 2026-05-30
- **Issue:** #177
- **Supersedes:** the CLAUDE.md note that read "Squash merges in this repo keep
  dropping the second commit on a PR branch."

## Context

`CLAUDE.md` carried a load-bearing warning that GitHub squash-merge was
silently dropping commits, citing PRs #115, #119, and #124, which landed on
`master` with missing diffs. The documented workaround — squash locally to one
commit and re-verify every multi-commit PR on `master` afterwards — is a tax on
every PR, so #177 asked for one investigation pass to either fix or precisely
characterise the cause.

## Investigation

Forensic read of the three cited PRs (via `gh pr view` and `git show` against
`master`):

| PR | Title | Recorded commit(s) | Files in PR | Landed on master |
| --- | --- | --- | --- | --- |
| #115 | Remove systemd deploy artifacts | `8519e3f3e` "[docs] Sprint status…" | `SPRINT_STATUS.md +83` | **empty diff** (merge `84ca19f`) |
| #119 | README: remove hero image | `8519e3f3e` "[docs] Sprint status…" | `SPRINT_STATUS.md +83` | **empty diff** (merge `dbe942f`) |
| #124 | CLAUDE.md conventions + README sweep | `0e8836115` "[docs] CLAUDE.md…" | `CLAUDE.md +42` | `CLAUDE.md +42` only (README sweep missing) |

Two facts break the "squash dropped the second commit" theory:

1. **#115 and #119 recorded the _identical_ single commit** (`8519e3f3e`) and the
   _identical_ single file (`SPRINT_STATUS.md +83`) — despite unrelated titles.
   A shared stale commit, not each branch's own work, was sitting at both
   branch heads. There was never a "second commit" for GitHub to drop.
2. **Repo setting `squash_commit_title = COMMIT_OR_PR_TITLE`.** When a branch is
   exactly one commit ahead of base, GitHub titles the squash with _that
   commit's_ headline, not the PR title. That is precisely why #115/#119 merged
   under "[docs] Sprint status…" instead of their PR titles — corroborating that
   each branch held exactly one (wrong) commit ahead of base.

All other merge settings (`allow_squash/merge/rebase`, `squash_commit_message =
COMMIT_MESSAGES`) are standard; nothing pathological.

The common thread: these PRs were opened in the burst that created #104–#113 in
parallel. Their intended work was committed locally but never pushed to the
remote PR branch head — a push/worktree race during the parallel sprint. GitHub
squash-merge then faithfully squashed what was actually on each branch head:
nothing new versus base (#115/#119 → empty) or only the first of several
commits (#124 → partial).

## Decision

GitHub squash-merge is **not** at fault and no GitHub support ticket is
warranted. The triggering shape is **a PR branch whose head is missing its work
commits**. We adopt outcome (2) from #177 — identify the shape and add a
guardrail:

- **CI check `.github/workflows/pr-nonempty.yml`** fails any PR whose diff
  against its base branch is empty. This catches the exact silent failure that
  landed #115/#119 (an empty PR is never intended).
- **CLAUDE.md updated** to replace the misdiagnosis with the real cause and to
  keep the practical guards that remain necessary.

## Consequences

- The empty-PR case is now caught automatically before merge.
- CI cannot detect a _partial_ push (#124's shape — a real but incomplete diff),
  because it has no oracle for "what work was intended." That case stays covered
  by discipline: push a single squashed commit per PR, and after merge verify the
  expected files landed (`git show master -- <file>`).
- The standing "verify multi-commit PRs on master" treadmill can relax to "verify
  the diff is what you expected," since the root cause is unpushed work, not a
  squash defect.
