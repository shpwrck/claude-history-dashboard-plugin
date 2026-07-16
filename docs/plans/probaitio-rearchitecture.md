# Probaitio rearchitecture plan

Status: **proposed** (multi-agent ultraplan, 2026-06-11; 17 agents; adversary verdict =
ship-with-adjustments). Open decisions locked 2026-06-11 (see "Decisions" below). Supersedes
the implicit "one flat repo" structure. Promote to an ADR next.

Context: the app is being renamed **Probaitio -> Probaitio** (embeds "AI") and moved to a new
GitHub org `probaitio` (created 2026-06-11). Domain `probaitio.com` is registered on
Cloudflare. Today the codebase is ONE flat package `claude-history-dashboard` with no
workspaces; this plan draws the component boundaries that don't yet exist in the build.

## Decisions (locked 2026-06-11)

- **Topology:** Hybrid - one TS pnpm-workspace monorepo + one green-field Go satellite (below).
- **Visibility:** the product monorepo will be **PUBLIC / open-source** eventually.
- **Open/closed line (open-core along the existing repo boundary):** open the WHOLE product
  monorepo (parse + detectors + dashboard + homepage + server). Keep the proof/experiment
  engine PRIVATE in `shpwrck/claude`. Detectors are heuristics; an open Detector Registry is
  a community-contribution surface. Only strategy DOCS are extracted, not detector code.
- **Repo move = FRESH public org repo, NOT a transfer.** Do the entire rearchitecture refactor
  in the existing private repo first, then publish a clean curated snapshot to the org. Avoids
  scrubbing ~1,300 issues + full git history.
- **CRD / API group:** `probaitio.com/v1alpha1` (own the domain; replaces `probaitio.com/v1alpha1`).
- **CLI placement:** `cmd/probaitio` sharing the operator's single `go.mod` (reversible later).
- **Kernel npm-publish:** DEFER until a real external consumer exists; design boundaries so a
  later publish is a non-event.
- **CI selection:** accept full-matrix initially; path-filtered/affected-graph (turbo/nx) is a
  follow-on. EXCEPTION (public-forced must-fix): the `chd-browser` self-hosted browser-compat
  runner must move to GitHub-hosted or be gated to non-fork PRs - self-hosted runners on public
  repos let forked PRs execute code on the host.
- **ADR 0008 egress gate:** stays HUMAN-only; no autonomous burn-epic run may flip
  `publiclyReachable:true`. Even more critical once public (community PRs).

## Repo & trust topology (end state)

- `probaitio/<product>` - org, **public** eventually. Fresh repo, clean history, product code
  only. The hybrid TS monorepo below.
- `probaitio/probaitio-operator` - org, public. Green-field Go operator + CLI.
- `shpwrck/probaitio-strategy` - personal, **private**. The vault: `docs/competitive-analysis/`,
  `docs/v0.4-proof-engine.md`, `docs/v0.3-efficiency-accounting.md`,
  `docs/plans/naming-brainstorm.md`, and the strategic backlog. Lives OUTSIDE the org so org
  membership never exposes it.
- `shpwrck/claude-history-dashboard` - personal, **private**. Full-history archive + working
  repo until cut-over.
- `shpwrck/claude` - personal, **private**, UNCHANGED. Agent skills/hooks + the proof/experiment
  engine (the moat). One-way file coupling to the product (receipt spool + ledger.jsonl).

## Depersonalization gate (REQUIRED before the public snapshot)

The maintainer's personal environment must NOT port into the public org repo. Surface (small,
because we snapshot rather than transfer):

- **Untracked cruft** - delete from the working tree before snapshotting: the
  `wsl-fedora-jskrzypek.tail90ab9.ts.net.crt` Tailscale cert (personal), the `*.png`
  screenshots, `claudezip.zip` / `small-upload.zip`. (All currently untracked - a clean
  snapshot excludes them, but remove explicitly.)
- **Self-hosted runner** - the `chd-browser` browser-compat runner -> GitHub-hosted or non-fork-gated.
- **Personal deploy coupling** - genericize `chd-main`/`chd-spa`/`chd-ent` instance + port refs
  (8000/7000/8190) in `AGENTS.md`, `README.md`, `docker-compose.spa.yml`, `.dockerignore`,
  `.gitignore`.
- **Personal paths** - `/home/jskrzypek` refs in `docs/insights-trigger-spike.md`,
  `docs/reviews/per-view-synthesis.md`.
- **`~/.claude` / dogfooding coupling** - the `/recs` dogfooding rule, shadow-calls references,
  burn-epic/groom-release operating manual, personal ports/instances in `CLAUDE.md`/`AGENTS.md`,
  `hooks/`, `commands/`, `.claude-plugin/marketplace.json`, `deploy/` hooks. Decide per-file:
  genericize to project conventions (public) vs move to the personal vault / `~/.claude`. The
  public repo carries a clean contributor-facing CLAUDE.md/AGENTS.md, not the maintainer's
  private workflow.
- **Strategy docs** - move `docs/competitive-analysis/` + the strategy docs to
  `shpwrck/probaitio-strategy` and remove from the product tree before the snapshot.

## Guiding principle: community-contributable detectors (the OSS adoption lever)

The point of open-sourcing is community adoption + feedback, and the highest-value
contribution surface is **new recommendations/detectors**. The app must be as modular as
possible and make it easy for **agents AND humans** to propose a detector. This is a primary
design constraint on `packages/detectors`, not a nice-to-have.

Reconciliation with ADR 0002 (static registry - "no runtime rule store, no fs scan, no plugin
system"): **keep it static; lower the authoring friction around it.** The static, hand-listed
barrel is a SECURITY ASSET for a tool that reads private `~/.claude` - every detector is
reviewed source, never runtime-injected/scanned code. A runtime plugin system would let an
untrusted community PR execute against private history. So modularity is achieved through
authoring ergonomics, not dynamic loading:

- **Build-time barrel codegen.** Generate `detectors/index.ts` from the category dirs via a
  committed codegen step (gated in CI), so adding a detector is "drop one file + run gen" -
  NO manual barrel edit (today's merge-conflict magnet), while the barrel stays static,
  committed, and auditable (no `import.meta.glob`, no runtime scan - ADR 0002 invariant intact).
- **One-file detector, zero-plumbing default.** A detector reading an EXISTING
  `RecommendationInput` field is a single new file. The intricate `SESSION_SIGNALS` content-hash
  path is only for brand-new data sources; document the zero-plumbing path as the front door.
- **Scaffold + instant feedback.** A `scaffold-detector` generator (category/id -> stub file +
  red test) plus the registry self-test and schema validation give a contributor (human or
  agent) immediate red/green. Promote `docs/adding-a-recommendation.md` to a first-class
  CONTRIBUTING surface.
- **Agent-native authoring path.** A skill/command/template so an agent can author a detector
  end-to-end (scaffold -> implement `rule` -> test -> codegen-register). "Agents and humans
  alike" is explicit; this also dogfoods the contribution path.
- **Stable, documented public contracts.** `Detector`, `Signal`, `RecommendationInput`,
  `Recommendation` in `packages/types` ARE the contributor-facing API. Treat them as a
  semver-respected public surface (even before any npm publish) - they are what every
  contributed detector codes against.

When this plan becomes ADR 0012, add an ADR 0002 addendum recording the barrel-codegen
refinement + the contribution-ergonomics mandate (the static-registry invariant is preserved,
not reversed).

## Decision: Hybrid topology

One TypeScript pnpm-workspace monorepo for the entire web+server+library estate, plus
exactly ONE green-field Go satellite repo for the operator+CLI, plus the already-external
`shpwrck/claude` agent/proof-engine repo left untouched.

Why hybrid and not pure monorepo or polyrepo (grounded in the coupling map):

1. **The dominant change crosses parse -> ingest -> detectors -> view -> server in one
   edit.** All 78 parsers hard-import `src/types.ts`; every detector imports `parse-*`;
   `ingest.mjs`'s `SESSION_SIGNALS` content-hash part-order is a load-bearing SQLite-cache
   invariant that must move in lockstep with its parser args. A polyrepo forces that routine
   change into a multi-repo publish/pin-bump dance that burn-epic's single-worktree/single-PR
   contract cannot express, and shatters the single-repo issue/epic/sub-issue/milestone
   automation the whole project runs on. So the TS estate stays one tree.
2. **The one honest carve-out is the Go operator/CLI.** The Go operator-sdk operator now
   lives in `probaitio-operator/` (it replaced the removed Node control-loop operator in
   #1956): a different toolchain (operator-sdk/controller-gen/OLM),
   independent k8s/OLM cadence, coupling to the product ONLY over the #1248 push-ingest HTTP
   boundary + the CRD API schema -- a network seam, never a source import. Its own repo.
3. **`shpwrck/claude` stays its own repo** -- already external, one-way file-based coupling
   (adoption-receipt spool the server drains + `ledger.jsonl` `parse-shadow-calls` reads).

### The load-bearing correction over a naive split

Wire workspace packages by **tsconfig `paths` mapping to relative on-disk source, NOT bare
`@probaitio/*` npm specifiers.** `scripts/ts-resolver.mjs` only rewrites relative specifiers
(`specifier.startsWith('.')`); a bare scoped import falls through and needs a `node_modules`
link farm, which the server runtime image (`Dockerfile`: "runtime needs NO node_modules at
all", raw TS via register-ts) cannot provide -- the exact `ERR_MODULE_NOT_FOUND` crash-loop
(#1013) that CI never catches because vitest + SPA gates never boot the server image. Defer
any npm-publish of a kernel package until a concrete external consumer exists.

## Target boundaries

```
probaitio/probaitio                 TS pnpm-workspace monorepo (whole web+server estate)
  packages/types                   src/types.ts -- the ~585-line hidden fan-in; extracted FIRST
  packages/parse                   78 parsers, sub-split: parse-core / parse-artifacts (#539
                                   server-only fs readers) / parse-derived (browser transforms)
                                   + pricing.ts + format.ts. Zero runtime npm deps.   [-> types]
  packages/ingest                  ingest.mjs + signals/index + signals/schema + session-cache
                                   + config-loader, WELDED so the SESSION_SIGNALS content-hash
                                   invariant never crosses a package line.       [-> parse,types]
  packages/detectors               detectors/* (8 categories) + recommendations + suppression +
                                   adoption + reclaim. Node-free; consumes dataset keys.[-> parse,types]
  packages/proof-consumer          parse-shadow-calls + 2 shadow detectors -- the read-only
                                   boundary to shpwrck/claude's ledger.jsonl.     [-> parse,types]
  apps/web                         App.tsx + PatternFly components + 22 views + the
                                   api-client.ts/api-client.spa.ts Vite --mode spa seam +
                                   sample-data. ONE codebase = marketing SPA + dashboard.
                                   spa-boundary grep guards the free/paid line.  [-> detectors,parse,types]
  apps/server                      server.mjs (~1630 lines) + audit/judge + ADR-0008 callAnthropic
                                   chokepoint + policy-writer + adoption endpoints + artifact-source
                                   + #1248 push-ingest. register-ts, ZERO node_modules, path-mapped
                                   RELATIVE imports only.               [-> ingest,parse,detectors,types]
  tools/repo-map                   repo-map/ + generator + web-tree-sitter wasm. Host-side ONLY
                                   (ADR 0007); isolated so heavy devDeps never enter the server
                                   graph (the #1013 cause).                            [-> types]
probaitio/probaitio-operator        green-field Go: operator-sdk hybrid.helm reconciler,
                                   RemoteSession + DashboardInstance CRDs, helm chart, the prv CLI
                                   (cmd/probaitio sharing one go.mod for now), sidecar shipper,
                                   SigV4 blob client. NO Go code today. Couples to apps/server
                                   ONLY over #1248 push-ingest HTTP + CRD schema (network).
shpwrck/claude                     UNCHANGED. Agent skills/hooks + shadow-calls/replay/race proof
                                   engine. One-way file coupling (receipt spool + ledger.jsonl).
```

## Migration sequence (re-ordered per the adversary critique)

1. **Safety gates FIRST** (valuable even if migration stops here):
   - Add a standing `server-boot` CI job: build the server Dockerfile, start the container,
     assert `/api/dataset.json` (or `/api/recommendations.json`) returns 200 non-empty against
     a tiny fixture `~/.claude`. Closes the #1013 blind spot permanently.
   - Add a madge/dependency-cruiser lint guard failing any bare `@scope` (non-relative,
     non-`node:`) import reachable from the server entrypoint. Catches the regression at PR time.
   - Wire the four parity scripts (signal-descriptor / session-blob-cache / transcript-cache /
     artifact-cache `.test.mjs`) into the required vitest `test` job and verify they run in CI.
2. **Workspace skeleton, no file moves.** Add `pnpm-workspace.yaml` + root tsconfig
   project-references + path mappings pointing at existing `src/`. Prove `pnpm -r build` +
   `pnpm -r test` green AND smoke-boot the real server image with path-mapped wiring.
3. **Extract `packages/types` FIRST**, then `packages/parse` (sub-split), then move
   signals/schema + session-cache INTO `packages/ingest` in the SAME phase. Gate on the
   parity tests. **This is a shippable resting point** no more fragile than today -- do not
   introduce a single new bare `@scope` import until the server-boot gate exists.
4. Carve `packages/detectors` + `packages/proof-consumer` (node-free, lowest risk), then
   `apps/web` + `apps/server` along the named seams; isolate `tools/repo-map`. One squashed
   PR per package; after each, verify `git show master -- <files>` landed (#124 partial-push
   guard) and re-smoke-boot the server image.
5. Build the #1248 push-ingest JSON wire seam + artifact-source interface in `apps/server` as
   the k8s-free first slice. Delivers multi-host aggregation on a laptop and FREEZES the wire
   contract the Go side targets. Add a fixture round-trip test as the cross-language guard.
6. **Public cut-over via a fresh curated snapshot (NOT a transfer).** Run the
   depersonalization gate (above): remove untracked cruft + the Tailscale cert, move strategy
   docs to `shpwrck/probaitio-strategy`, genericize personal deploy/`~/.claude` coupling, move
   `chd-browser` to a hosted runner. Do the Probaitio rename sweep (`probaitio.com/v1alpha1` ->
   `probaitio.com/v1alpha1`, coach.skrzypek.dev refs, image refs). Then create
   `probaitio/<product>` as a FRESH public repo from the cleaned tree (clean initial commit -
   no leaking history). Re-point automation and migrate only ACTIVE product issues (strategic
   issues stay in the personal archive). Finally birth `probaitio/probaitio-operator` as an
   empty Go repo seeded with ADR 0009/0010/0011 + `docs/plans/openshift-mvp/` + the
   operator-sdk scaffold, targeting the Phase-5 contract.

## Cross-cutting risks (carry into the ADR)

- **No-node_modules boot trap (highest, structural, ONGOING not one-shot).** Enforced by the
  standing `server-boot` job + bare-import lint guard, not by hand-curation.
- **SESSION_SIGNALS content-hash part-order.** Welded into one package; gated by parity tests
  in the required `test` job.
- **types.ts repoint codemod blast radius** (78 parsers + ~60 detectors + 48 components).
  Extract types first in isolation; full tsc+vitest after; `git show --stat` for stray `Bin`
  diffs (the NUL-byte hazard).
- **The one genuine 2-repo seam (#1248 + CRD schema).** burn-epic structurally cannot cross
  it; version the wire contract as a committed JSON schema in both repos with round-trip
  fixture tests, and document in AGENTS.md as a HUMAN-coordinated two-PR task burn-epic skips
  (treat like the `meta` exclusion).
- **Coarse CI in the fat monorepo.** Path-filtered/affected-graph CI (turbo/nx) is a
  follow-on, not a blocker.
- **Deferred local-first vs hosted tension.** One `apps/web` via Vite alias is right today;
  revisit a true app-module wall only if #467 multi-tenant forces the public SPA to diverge.

## Open decisions - RESOLVED 2026-06-11

All six (plus the visibility + open-core forks the public decision surfaced) are locked in the
"Decisions" section at the top. Summary: API group `probaitio.com/v1alpha1`; CLI =
`cmd/probaitio` shared go.mod; kernel npm-publish deferred; repo move = FRESH public repo (not
transfer); CI full-matrix initially BUT self-hosted runner is a public-forced must-fix; egress
gate stays human-only; visibility = public/OSS; open-core line = open the whole product
monorepo, proof engine stays private in shpwrck/claude.

## Naming note

`probaitio` (org) is intentional, not a typo for `probaitio`. The product was renamed
Probaitio -> Probaitio (embeds "AI"). The `probaitio.com/v1alpha1` API group is the OLD name; the
Phase-6 rename sweep replaces it (string TBD per the open decision above).
