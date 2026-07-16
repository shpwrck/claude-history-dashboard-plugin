# Release-notes backfill drafts (#716)

Hand-written summary paragraphs for the releases that shipped as flat
`--generate-notes` dumps. Paste the relevant paragraph above `## What's
Changed` in the Release body (or run the backfill workflow first and replace
its placeholder line with the paragraph).

Procedure per release (see `docs/RELEASING.md` -> "Release-notes shape"):

1. Actions tab -> **Label milestone PRs** with the release's milestone
   (`v0.1` for `v0.1.1`, `v0.2` for `v0.2.0`); hand-label anything the run
   lists as unclassifiable.
2. Actions tab -> **Backfill release notes** with the tag, dry-run first;
   inspect the composed body in the log, then re-run with `apply`.
3. Edit the Release body and replace the `_Summary pending ..._` placeholder
   with the paragraph below.

Drafted from `git log v0.1.0..v0.1.1 --oneline` and
`git log v0.1.1..v0.2.0 --oneline`.

## v0.1.1

> v0.1.1 is a small process-hardening patch on the v0.1 line. It introduces
> the release gate — a cut is now blocked until the milestone's standing
> performance and architecture review epics are closed
> (`scripts/check-release-gate.mjs`, with patch releases like this one
> auto-exempt) — and the running app now surfaces its version (release tag or
> commit SHA), so a deployment can be identified at a glance. The edge
> deployment moved to `edge-coach.skrzypek.dev`, and the release/epic workflow
> documentation landed alongside.

## v0.2.0

> v0.2.0 answers this release's guiding question: how can we structure this
> app for growth? The monoliths were decomposed — `server.mjs`, `ingest.mjs`
> and `Recommendations.tsx` split into focused modules, with shared
> hooks/components retiring more than a dozen duplicated copies — and the
> growth guardrails went in: per-flavor bundle-size budgets, a cold-load
> budget, and an ingest-throughput benchmark, enforced or tracked in CI. The
> recommendation engine gained detectors for unused subagents and slash
> commands, workflow health (failed runs, runaway fan-out cost) and the
> habit-impact HURTS verdict, and nested workflow-agent transcripts now merge
> into their parent session. The release process itself matured too: a
> security review joins performance and architecture as a standing release
> gate from v0.3 onward.
