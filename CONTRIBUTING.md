# Contributing

## Merge policy — what must be green before merging to `master`

`AGENTS.md` is the source of truth for the full merge gate. In short: do not
merge to `master` until CI is green, the PR is non-empty, and the agent/human
self-review policy has been satisfied.

The easy-to-miss load-bearing checks are:

| Check | Workflow | Why it matters |
| --- | --- | --- |
| `non-empty-diff` | `.github/workflows/pr-nonempty.yml` (PR has a diff) | guards against empty PRs |
| `sample-boundary` | `.github/workflows/ci.yml` (Lint and build) | keeps the public sample from importing server-only routes |
| `test` | `.github/workflows/test.yml` (Unit tests) | catches parser/UI regressions |
| Full CI rollup | all PR workflows | every non-skipped required-for-this-PR job must pass; pending or absent checks are not green |

### Enforcement is advisory, not gated

This is an **agent/human policy gate**, not a GitHub-enforced required-check
gate. Required status checks (classic branch protection *and* rulesets) are
unavailable on a **private, free-plan** repository — the API returns
`403 "Upgrade to GitHub Pro or make this repository public"`. So the merge
button stays enabled even when a check is red.

The decision (recorded in **issue #241**) is to **accept advisory-only**
enforcement rather than make the repo public or upgrade to GitHub Pro. The repo
is tied to a personal Claude-history dashboard, so it stays private. Whoever
merges is responsible for confirming the `AGENTS.md` gate first.

If the trade-off is ever revisited (make the repo public, or upgrade to Pro),
turn the load-bearing checks into *required status checks* and this section
becomes enforced rather than advisory.

### Docs-only skip classifier

`scripts/ci-docs-only.mjs` is the active docs-only skip helper used by the
expensive PR workflows. It must log the changed files and the diff strategy it
used. On pull requests it must fail loud when the PR diff cannot be computed,
rather than silently falling back to an unrelated local commit diff.
