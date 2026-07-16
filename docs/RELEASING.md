# Releasing

How Coding Agent Dashboard (`coding-agent-dashboard`, repository
`claude-history-dashboard`) cuts a versioned release.

## Model: trunk-continuous deploy, tagged checkpoints

`master` is always deployable and is **continuously published**: every push to
`master` builds `:latest`, `:master`, and `:sha-<short>` images for all four
published containers (`.github/workflows/docker-publish.yml`):

- `claude-history-dashboard` (live server),
- `claude-history-dashboard-spa` (upload-only SPA),
- `claude-history-dashboard-dispatch` (RemoteSession dispatch), and
- `claude-history-dashboard-operator-sdk` (Go operator).

The autonomous backlog flow keeps merging into `master` — nothing here changes
that.

A **release** is a deliberate, human-triggered checkpoint on a known-good
`master` commit: a semver tag, an auto-generated changelog, a GitHub Release,
and the matching semver-tagged images. It is a *narrative + rollback anchor*
layered on top of continuous deploy, not a separate deployment pipeline.

We do **not** use release branches or a stabilization freeze — that would fight
the continuous burn-down loop. If a release needs to exclude in-flight work,
hold the tag until `master` is at the commit you want.

## Each release answers one question

Every release is framed by a single **guiding question** — the one thing this
cut is trying to answer. The question is the release's narrative spine: an epic
earns a place in the milestone by helping answer it, and the milestone
description leads with it. Pick the question deliberately when the milestone
opens, and record it here so the arc across releases stays legible.

| Release | Guiding question |
| ------- | ---------------- |
| `v0.1`  | What information can we use from our Claude directory to improve our usage? |
| `v0.2`  | How can we structure this app for growth? |
| `v0.3`  | How can we lay the foundations for attribution? |
| `v0.4`  | Can this product PROVE — not suggest — that a specific change in how you work with your agent leaves you measurably better off? |

The question is a **lens for scope, not a hard gate**: the standing review epics
(below) and unrelated trunk fixes still ride along. But when an epic is weighed
for a milestone, "does this help answer the release question?" is the first test
— that's what `/groom-release` reconciles candidate epics against. v0.3's
question is anchored by the calibration/attribution epic (#726) behind the
North Star (#724): the cut lays the substrate for measuring *realized* (not
predicted) recommendation savings.

## What's already automated

`docker-publish.yml` (issue #168) triggers on a `v*` tag push **and** on
`release: published`, and emits semver image tags `:X.Y.Z`, `:X.Y`, `:X` for all
four images. The release event may start a second, synthetic build whose ref is
not the semver tag; treat the workflow run triggered by the actual `v*` **tag
push** as the authoritative semver-image build. Cutting a release requires no
separate local image build — creating the tag and publishing the release drive
the workflow.

`.github/release.yml` categorizes merged PRs **by their labels** into changelog
sections (Security, Features & enhancements, Performance, UI, Bug fixes,
Documentation, Infrastructure & build, Tech debt & refactors, Other) when notes
are generated. It is config, not a workflow. Because the bucketing reads each
merged PR's labels, an **unlabeled** PR lands in *Other changes* — see
[Release-notes shape](#release-notes-shape-summary--categorized-log) for the
labeling habit that keeps the log meaningful.

## Versioning

[Semantic versioning](https://semver.org). Pre-1.0, treat `0.MINOR.PATCH` as:

- **MINOR** (`0.1` -> `0.2`): user-visible features, new views/detectors,
  notable behavior changes.
- **PATCH** (`0.1.0` -> `0.1.1`): fixes and small improvements with no new
  surface.

`package.json` holds the current baseline. Bump it in the same commit that opens
a milestone for the next version, so the repo and the tag agree.

## Milestones = release buckets

Each release has a milestone (`v0.1`, `v0.2`, …). Assigning an issue to a
milestone declares "this ships in that cut." Milestones **compose** with the
`backlog` label — an issue can be both — so the burn-backlog scorer is unaffected;
the milestone is purely the release-scope lens.

- See open milestones: `gh api repos/shpwrck/claude-history-dashboard/milestones --jq '.[].title'`
- Put an issue in a release: `gh issue edit <N> --milestone v0.1`
- Track progress: the milestone page shows closed/open counts.

### Every merged PR carries a milestone (guaranteed, not guidance)

A PR that merges to `master` with **no** milestone falls outside every release
rollup and the label-driven changelog — it is invisible to `--milestone vX.Y`
and the milestone progress page. This is enforcement-critical, so it is a
guarantee, not a convention (`#722`; it leaked once — `#717` merged after the
v0.2 cut unmilestoned and was caught only by a manual audit).

`.github/workflows/milestone-guard.yml` (`scripts/ensure-pr-milestone.mjs`)
holds the line: when a PR opens (or merges) without a milestone it **auto-assigns
the single open release milestone** (the one `vX.Y`), idempotently — the author
can still change it. It runs again on merge as a backstop, since required status
checks can't gate merge on this repo (`#241`), so a red check alone wouldn't
block. It fails loudly only when the choice is **ambiguous** — zero or more than
one open `vX.Y` milestone — so a human assigns it. ("Future" is never
auto-assigned; it is the deferral lane, not a cut.)

## Release-gating epics

Every release is gated by **standing review epics**, and the cut is
**blocked until all of them are closed**:

- a **performance review** epic (label `performance`),
- an **architecture review** epic (label `tech-debt`) — typically the next
  `improve-codebase-architecture` round,
- *(from v0.3 onward)* a **security review** epic (label `security`) — typically
  the output of a `/security-review` pass, and
- *(from v0.6 onward)* a **data-integrity review** epic (label `data-integrity`)
  — the deliberate per-cycle check that every recommendation/calculation shipped
  this release is **provable** (evidence-backed and reproducible per
  [`docs/adding-a-recommendation.md`](./adding-a-recommendation.md)) and
  **arithmetically faultless**.

All carry the **`release-gate`** label and are assigned to the release
milestone. They are the deliberate "did we pay down speed, structure, security,
and data-integrity debt this cycle?" checkpoint — not a code freeze (the trunk
keeps burning down). If a gating epic won't make the cut, move it to a later
milestone rather than holding the tag indefinitely.

The cut gate also requires **all non-gate issues in the milestone to be
closed**. Normal deferral means moving the issue to a later milestone. In the
rare case where an open issue must remain attached to the current milestone for
audit/history, apply the explicit `release-deferred` label and add the auditable
fields below to the issue body. The gate requires a destination later than the
current cut and a non-empty rationale before honoring the label, and prints every
such exception on success. Provision the label once per repository if needed:

```md
Destination: v0.7.0
Rationale: <why this remains attached to the current milestone>
```

```sh
gh label create release-deferred --color BFD4F2 \
  --description "Explicitly deferred from the current release cut; requires rationale + destination"
```

`release-deferred` never exempts a standing `release-gate` epic. It is an
auditable exception for non-gate work only; silent/open unlabeled work blocks
the cut.

**Security-review rollout (v0.3+, #698).** The security epic is a *third*
standing gate, added from **v0.3 onward**. The already-shipped/in-flight v0.1 and
v0.2 milestones keep the original **performance + architecture pair** and are not
retroactively re-gated. The gate script verifies distinct domain labels, so
duplicate gate epics cannot stand in for a missing security review.
`expectsSecurityGate()` returns true for `>= v0.3`.

**Data-integrity-review rollout (v0.6+, #2130).** The data-integrity epic is a
*fourth* standing gate, added from **v0.6 onward** — v0.6.0's arc is about proof,
so a release earns its cut only after a deliberate audit that the cycle's
recommendations/calculations are provable and faultless: evidence-backed and
reproducible (`docs/adding-a-recommendation.md`), arithmetic re-derived, stale
signals demoted to "as of \<date\>" rather than phrased as current state, and
every `validated` fix snippet genuinely copy-paste-safe. v0.1–v0.5 keep their
existing gate set and are not retroactively re-gated. The gate requires the
distinct `data-integrity` domain label from v0.6 onward;
`expectsDataIntegrityGate()` returns true for `>= v0.6`.

### Two-phase model: build first, review last (#642)

A release's performance, architecture, (v0.3+) security, and (v0.6+)
data-integrity reviews assess the release **as shipped**, so they are *terminal*
work, not concurrent with the feature work they review. The release therefore
runs in two phases:

- **Feature phase** — the milestone still has open non-gate burnable work
  (sub-issues, loose backlog). The gating epics exist but are **dormant**: the
  pickers (`burn-epic`, `/groom-release`) do not decompose, groom, or burn them.
- **Review phase** — entered automatically once **all non-gate burnable work in
  the milestone is drained**. Only then do the gating epics wake: groom them into
  sub-issues (informed by the concerns banked below), burn those, close the
  epics → the gate opens → cut.

**Seed at release start, as concern buckets.** Create the standing epics when the
milestone opens (`/groom-release` surfaces a `seed-gate` candidate; it stays the
intended tool). Since `#721` this is a **guarantee**, not just a convention:
`.github/workflows/seed-release-gates.yml` (`scripts/seed-release-gates.mjs`)
seeds the standing set automatically when a `vX.Y` milestone is created — and via
`workflow_dispatch` (version input) for backfill — idempotently skipping any
domain whose `release-gate` epic already exists in the milestone, open or closed.
They're seeded early *on purpose*: while the release is built, any
performance, architecture, security, or data-integrity concern surfaced during
feature work is **dumped into the relevant standing epic** (a checklist line or
comment) instead of a loose issue. That accumulated material becomes the raw
input when the epics are groomed at the review phase. Seed them `epic` +
`release-gate` + the domain label, assigned to the milestone — but do **not**
decompose them until the review phase. v0.2's pair is #622 (architecture) and
#638 (performance); from v0.3 the seeded set also includes a security-review
epic (label `security`); from v0.6 it also includes a data-integrity-review epic
(label `data-integrity`).

The shared phase signal is `releasePhase()` in `burn-epic`'s `pick.mjs`
(reused by `groom-pick.mjs`), so both pickers agree on when the reviews wake.
`scripts/check-release-gate.mjs` (below) is unaffected — it is a hard gate at
**cut** time, by which point the reviews must exist and be closed regardless of
phase.

Enforcement is a hard gate, `scripts/check-release-gate.mjs`:

```sh
node scripts/check-release-gate.mjs v0.2
```

It exits non-zero if the milestone has no `release-gate` epics seeded, or if any
are still open — listing the offenders. The documented cut command below runs it
first, and `.github/workflows/release-gate.yml` re-runs it on `v*` tag push (a
loud, auditable post-hoc check) and via `workflow_dispatch` (run it from the
Actions tab before you tag).

### Public LLM exposure sign-off

If a release exposes any LLM-backed surface outside a private single-operator
deployment, the security `release-gate` epic must carry a reviewer receipt before
it can close:

- command output for `npm run gate:llm-egress`;
- for multi-tenant exposure, command output for
  `DASHBOARD_LLM_PUBLIC_EXPOSURE_MODE=multi-tenant npm run gate:llm-egress`;
- the reviewed `docs/llm-usage-registry.md` entry or entries with
  `publiclyReachable: true`;
- explicit confirmation that each reachable entry has auth, call/input/spend
  caps, non-stub egress scrub, and the correct tenancy boundary for the
  deployment; and
- the named human reviewer plus deployment scope being approved.

Do not close the security gate on a public LLM release with only a green machine
check. The script proves the structural invariants; the reviewer signs off that
the registry matches the actual exposure being shipped.

For enterprise pilots or CTO demos, also attach the output of
`npm run gate:enterprise-readiness`. That command composes the auth/posture,
LLM-egress, route-inventory, server-scale, bundle, repo-map, and SPA-boundary
checks into one mechanical receipt before the live deployment checklist is run.

## Cutting a release

1. **Pick the commit.** Ensure `master` is green and at the state you want to
   ship. Pull the latest: `git checkout master && git pull`.

2. **Bump the version** if not already done, in its own small PR:
   `package.json` `version` -> the target (e.g. `0.2.0`). Merge it so the tag
   lands on a commit whose `package.json` matches the tag.

3. **Label the milestone's merged PRs** so `--generate-notes` can categorize
   them (an unlabeled PR collapses into *Other changes*). Run the **Label
   milestone PRs** workflow from the Actions tab
   (`.github/workflows/label-milestone-prs.yml`, input the milestone), or
   locally:

   ```sh
   GH_TOKEN=$(gh auth token) GH_REPO=shpwrck/claude-history-dashboard \
   node scripts/label-milestone-prs.mjs v0.2
   ```

   It infers each missing domain label conservatively (linked-issue labels,
   then title prefixes) and **lists the PRs it cannot classify for
   hand-labeling** — label those by hand before moving on. See
   [Release-notes shape](#release-notes-shape-summary--categorized-log).

4. **Check the release gate, then create the tag + GitHub Release** with
   generated notes. Gate first (it fails closed if either review epic is open),
   then cut **as a draft**:

   ```sh
   node scripts/check-release-gate.mjs v0.1 && \
   gh release create v0.1.0 \
     --target master \
     --title "v0.1.0" \
     --draft \
     --generate-notes
   ```

   This creates the `v0.1.0` tag, generates the changelog from merged PRs
   (bucketed per `.github/release.yml`), and drafts the Release. Before
   publishing, on the Releases page:

   - **Prepend a short hand-written summary paragraph** (2-4 sentences naming
     what the release is about and its headline changes) above the generated
     `## What's Changed`.
   - **Confirm the log is categorized** — if everything sits under *Other
     changes*, go back to step 3, label the stragglers, and hit the draft's
     "Generate release notes" button to re-bucket. Do not hand-sort the list.

   Then publish. The tag push is the authoritative `docker-publish.yml` run and
   pushes `:X.Y.Z`, `:X.Y`, and `:X` tags for all four images. Publishing may
   also fire a synthetic release-event run; do not use that run as proof of the
   semver tags. Put the summary in before publishing, not after.

5. **Close the milestone** once its issues are done:
   `gh api -X PATCH repos/shpwrck/claude-history-dashboard/milestones/<num> -f state=closed`
   and open the next one.

6. **Verify** the authoritative workflow run has `event=push` and the expected
   tag as its `headBranch`, then verify the semver tag exists on all four
   user-owned GHCR packages. Set `VERSION` to the release being cut:

   ```sh
   VERSION=0.6.0
   TAG="v$VERSION"

   gh run list --workflow docker-publish.yml --event push --branch "$TAG" \
     --json databaseId,headBranch,status,conclusion,url --limit 1

   for image in \
     claude-history-dashboard \
     claude-history-dashboard-spa \
     claude-history-dashboard-dispatch \
     claude-history-dashboard-operator-sdk
   do
     printf '%s: ' "$image"
     gh api "/users/shpwrck/packages/container/$image/versions" --paginate \
       --jq '.[].metadata.container.tags[]' | grep -Fx "$VERSION" | head -1
   done
   ```

   Each package must print the value of `VERSION`.
   `/orgs/shpwrck/packages/...` is incorrect because `shpwrck` is a user
   account, not an organization.

### Release-notes shape: summary + categorized log

Every published release should read as **a short hand-written summary followed by
a changelog grouped by category** — not a flat dump. Two mechanisms produce that
shape; both are cheap if you stay on top of them, painful to retrofit (see the
`v0.1.1`/`v0.2.0` backfill in #716).

1. **Categorized log — automatic, but label-driven.** `--generate-notes` buckets
   merged PRs into the sections in `.github/release.yml` (Security, Features &
   enhancements, Performance, UI, Bug fixes, Documentation, Infrastructure &
   build, Tech debt & refactors, Other). The bucketing keys off each **merged PR's
   labels**, so a PR with no domain label collapses into *Other changes*. Keep the
   log meaningful by **labeling every PR with its domain label**
   (`enhancement`, `performance`, `ui`, `bug`, `documentation`, `infra`,
   `tech-debt`, `security`) before it merges — the same labels the backlog already
   uses, so this is usually just carrying the issue's label onto its PR. If a cut
   comes out all-*Other*, the fix is to label the milestone's merged PRs and
   **regenerate** (the draft Release's "Generate release notes" button re-runs the
   categorization) — not to hand-sort the list.

   The mechanical helper for that labeling pass is
   `scripts/label-milestone-prs.mjs` (Actions tab: **Label milestone PRs**,
   `.github/workflows/label-milestone-prs.yml`). Given a milestone it adds the
   domain label each merged PR is missing, inferred **conservatively** from the
   PR's linked issues (`Closes #N` / the `[#N]` title convention — exactly one
   distinct domain label across them wins; conflicts are never guessed) and
   from title prefixes (`[feature]`/`feat:` -> `enhancement`, `fix:` -> `bug`,
   `docs:` -> `documentation`, `perf:` -> `performance`, `[chore]`/`refactor:`
   -> `tech-debt`, `ci:`/`build:`/`[infra]` -> `infra`, `[security]` ->
   `security`, `[ui]` -> `ui`). Anything it cannot classify it lists for
   hand-labeling. Already-labeled PRs are skipped, so re-running is safe.

2. **Summary — hand-written.** Generated notes carry no prose, so prepend a few
   sentences naming what the release is about and its headline changes (`v0.1.0`
   is the reference shape). Because publishing is what fires the image build, add
   the summary *before* you publish: cut with `--draft`, edit the body on the
   Releases page (summary on top, categorized log beneath), then publish.

For a release that already shipped flat (no summary, all-*Other* log), use the
backfill pair instead of editing by hand: run **Label milestone PRs** for its
milestone, then **Backfill release notes**
(`.github/workflows/backfill-release-notes.yml`,
`scripts/backfill-release-notes.mjs`). The backfill regenerates the published
body as summary + regrouped categorized log; it is **dry-run by default**
(tick `apply` to write), keeps any existing summary, inserts a loud placeholder
when there is none (drafted paragraphs: `docs/release-notes-backfill.md`), and
**never destroys the previous body** — it is kept verbatim under an
HTML-comment marker inside the new body and printed in the run log.

## Hotfix / patch releases

A **patch** (`0.1.0` -> `0.1.1`) ships a fix or small improvement onto an
already-released minor — often urgently. It follows the same trunk-native flow
as a minor cut (tag a known-good `master` commit; no release branch), with one
difference: **the release gate does not apply.**

The perf+architecture `release-gate` epics are a *per-minor-cycle* debt
checkpoint. A patch is not a new cycle, and its minor's review epics shipped a
cycle ago — so `check-release-gate.mjs` **auto-exempts** any `x.y.z` with `z>0`
(it passes with a "patch/hotfix release" note instead of consulting the
milestone). The post-hoc `release-gate.yml` on the tag push sees the same and
stays green. You never have to seed or backfill gate epics to cut a hotfix.

To cut one (e.g. `v0.1.1`):

1. **Land the fix on `master`** like any change, and **bump `package.json`** to
   the patch version in that same merge so the tag and the repo agree.
2. **Tag + publish** off `master` (the gate call is a no-op for a patch, kept
   for symmetry with the minor flow):

   ```sh
   node scripts/check-release-gate.mjs 0.1.1 && \
   gh release create v0.1.1 \
     --target master \
     --title "v0.1.1" \
     --generate-notes
   ```

   Publishing fires `docker-publish.yml`, which pushes `:0.1.1`, `:0.1`, `:0`
   images — and the build stamps the running version (#646) so an instance
   reports `v0.1.1` rather than a bare commit SHA.

A patch does **not** open a new milestone; leave milestone bookkeeping to minor
cuts.

## Rollback

Every push and tag leaves an immutable `:sha-<short>` (and releases leave
`:X.Y.Z`) image. To roll a deployment back, pin that tag instead of `:latest`:

```sh
# example: pin the server image to a known-good release
podman compose -f docker-compose.yml -f docker-compose.local.yml \
  pull ghcr.io/shpwrck/claude-history-dashboard:0.1.0
# then point the compose file's image tag at :0.1.0 and `up -d`
```

See the deploy notes in `CLAUDE.md` / `README.md` for the full pull-then-`up -d`
(no `--build`) published-image path.

## Why not GitHub Projects?

Projects v2 custom fields live in a separate plane that the label-driven
automation (burn-backlog scorer, groom-backlog, triage, recs picker) does not
read — adopting it as the source of truth would fork the backlog. Milestones
avoid that because they compose with the existing `backlog` label. If a roadmap
*view* across work streams is ever wanted, add a Project as a read-only lens, not
as the authority. Tracked in #618.
