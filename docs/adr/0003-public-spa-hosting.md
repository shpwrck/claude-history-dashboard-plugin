# 0003 — Public SPA hosting: ship the upload-only build publicly while source stays private

- **Status:** Proposed (research / decision record for #326)
- **Date:** 2026-06-01
- **Deciders:** repo owner
- **Related:** #324 (the `spa` build target), #325 (the published SPA image),
  #326 (this research), and the eventual SPA/server productization split.

## Context

We want a live, public, zero-backend demo of the dashboard: visitors load their
own `~/.claude` `*.jsonl` exports through the upload UI, nothing is baked in, and
there is no server. The `spa` build (#324) already produces exactly this
artifact — `vite build --mode spa` aliases the single server chokepoint
`@api-client` to a no-op stub (`src/lib/api-client.spa.ts`), and the
`spa-boundary` CI job (`.github/workflows/ci.yml`) greps the emitted bundle for
`/api/|csrf-token|policy/write|EventSource` and fails on any hit. So the *bytes*
that would go public are already provably free of server-touching code and read
no host data.

The blocker is **not** safety of the artifact — it's that this repo is
**private**, and the obvious "turn on Pages here" path would expose the private
source (server code, `scripts/server.mjs`, the whole tree) to make the artifact
public. GitHub Pages serves from a repo; making *this* repo's Pages public
either requires a paid plan (private-repo Pages) or making the repo public
(unacceptable — the server is the paid half of the intended free/paid split).

The decision the owner has framed: **keep source private, publish only the built
SPA artifact to a *separate public repo*, and drive both from this repo.**

### Constraints discovered while scoping

- **Pages from a private repo needs a paid plan.** GitHub Pages is free only for
  **public** repositories on GitHub Free; private-repo Pages requires GitHub Pro,
  Team, or Enterprise. So "just enable Pages on this private repo" is a paid
  option, and even then the *source* repo stays the host (fine for an internal
  preview, but it doesn't give us a clean public artifact-only surface).
- **`GITHUB_TOKEN` cannot push to a different repo.** The default
  workflow token is scoped to the repo it runs in. Cross-repo publishing needs
  an explicit credential — a deploy key (SSH) or a Personal Access Token (PAT)
  stored as a secret.
- **No `base` path is set in `vite.config.ts`** (it defaults to `/`). A GitHub
  *project* Pages site serves at `https://<owner>.github.io/<repo>/`, a subpath.
  With `base: '/'`, every `/assets/...` URL would 404 under that subpath. This is
  a real, must-fix detail for any project-Pages target — see "Asset base path"
  below. It does **not** bite a user/org root site or a custom domain served at
  `/`.

## Options considered

### Option A — Build here, push `dist/` to a separate public repo's Pages ✅ recommended

A workflow **in this private repo** runs `npm run build:spa` and pushes the
resulting `dist/` to a public repo (e.g. `shpwrck/claude-history-dashboard-demo`)
whose Pages is enabled. The public repo holds only built static assets — never
source. Releases stay driven from here (the workflow lives here, triggers on
push to `master` like the existing image publish).

- **Mechanism:** `peaceiris/actions-gh-pages` with `external_repository:
  shpwrck/claude-history-dashboard-demo` and a cross-repo credential. Two
  credential shapes:
  - **Deploy key (recommended):** generate an SSH keypair; put the **private**
    key as a secret in *this* repo, register the **public** key as a write
    **deploy key** on the demo repo. Scope is exactly one repo — tighter blast
    radius than a PAT.
  - **PAT:** a fine-grained token with `contents:write` on the demo repo, stored
    as a secret here. Simpler to set up, broader scope, needs rotation.
- **Plan cost:** none beyond a second **public** repo — public Pages is free.
- **Source exposure:** zero. Only built assets land in the public repo.
- **Asset base path:** the demo is a *project* site at `/claude-history-dashboard-demo/`,
  so the build needs a matching `base` (see below) **or** a custom domain /
  user-root site served at `/`.
- **Trade-off:** a second repo to own; the deploy credential must be managed.

### Option B — Enable Pages directly on this private repo (paid plan)

Turn on Pages for this repo; a workflow builds `spa` and deploys via the official
`actions/upload-pages-artifact` + `actions/deploy-pages`.

- **Mechanism:** simplest — official actions, same-repo `GITHUB_TOKEN`, no
  cross-repo credential.
- **Plan cost:** requires GitHub **Pro/Team/Enterprise** (private-repo Pages is a
  paid feature). Ongoing subscription cost.
- **Source exposure:** the *site* can be public while the repo stays private, so
  source is not directly exposed — **but** the Pages surface and the repo are the
  same unit, coupling the public demo to the private repo's settings and any
  future visibility change. It also doesn't deliver the clean "public artifact
  repo" the owner asked for.
- **Verdict:** viable as a low-effort internal/staging preview, but it spends
  money for a coupling we explicitly want to avoid. Not recommended for the
  public demo.

### Option C — Publish the existing `…-spa` GHCR image as the deploy artifact

We already push `ghcr.io/shpwrck/claude-history-dashboard-spa:latest` (#325). A
Pages deploy could pull that image, extract `/usr/share/nginx/html`, and publish
it.

- **Mechanism:** more moving parts — pull image, extract static files, then still
  push to a public Pages target (so it collapses back into Option A's cross-repo
  push anyway, plus an image round-trip).
- **Benefit:** the published bytes are *exactly* the released image's bytes (one
  source of truth).
- **Trade-off:** strictly more complex than building `dist/` directly in the
  workflow, for a marginal provenance gain. The `spa-boundary` CI already
  guarantees the `dist/` is clean, so the extra indirection isn't buying safety.
- **Verdict:** not worth it now; revisit only if image/demo drift becomes a real
  problem.

## Decision

Adopt **Option A**: a workflow in this private repo builds the `spa` target and
publishes `dist/` to a **separate public repo** via `peaceiris/actions-gh-pages`
using a **deploy key**. Source stays private; only built assets go public; the
release is driven from here; no paid plan is required.

## Asset base path (must-fix for Option A's project site)

`vite.config.ts` currently sets no `base`, so it emits root-absolute asset URLs
(`/assets/...`). Under a project Pages URL (`/claude-history-dashboard-demo/`)
those 404. The implementation must do **one** of:

1. **Set a Pages-specific base** — e.g. `base: process.env.PAGES_BASE ?? '/'` in
   `vite.config.ts`, and pass `PAGES_BASE=/claude-history-dashboard-demo/` in the
   Pages build step only (leaving the server/dev/spa-image builds at `/`); or
2. **Serve at root** via a custom domain (`CNAME`) or a `<owner>.github.io`
   user/org root repo, so `base: '/'` is correct as-is.

Option 1 is the smaller change and keeps everything in one repo's control;
prefer it unless a custom domain is already wanted.

## Security / data-leak check

- The published artifact is the `spa` build, which the `spa-boundary` CI job
  already proves contains none of `/api/`, `csrf-token`, `policy/write`,
  `EventSource`. The implementation workflow MUST run (or depend on) that same
  boundary check before publishing, so a regression can't ship server strings to
  a public URL.
- No `~/.claude` data is ever read by the SPA (no server, upload-only), and the
  public repo receives only `dist/` — no source, no secrets, no config.
- The cross-repo credential is a per-repo deploy key, not an org-wide PAT,
  keeping write scope to the single demo repo.

## Consequences

- A new public repo (`shpwrck/claude-history-dashboard-demo` or similar) must be
  created and have Pages enabled on its deploy branch.
- A deploy keypair must be generated and split across the two repos
  (private key → secret here, public key → deploy key there).
- `vite.config.ts` gains a configurable `base` (Option 1 above) unless a custom
  domain is used.
- The public demo becomes the plausible "free tier" shop window for the eventual
  SPA/server productization split, with the server (the paid half) never exposed.

## Follow-up

Implementation is a separate work item (this ADR is the research/decision):
build the `.github/workflows/` Pages-publish job, create the public repo + deploy
key, and wire the `base` path. Filed as #401 (child of #326).

## Sources

- [GitHub Pages — availability by plan (Docs)](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)
- [GitHub Pages limits (Docs)](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits)
- [Publishing with Pages while keeping a repo private (community discussion)](https://github.com/orgs/community/discussions/22817)
- [`peaceiris/actions-gh-pages` — `external_repository`, deploy key / personal token](https://github.com/peaceiris/actions-gh-pages)
- [`actions/deploy-pages` (official, same-repo Pages)](https://github.com/actions/deploy-pages)
- [`actions/upload-pages-artifact`](https://github.com/actions/upload-pages-artifact)
- [Deploy/publish to GitHub Pages of another repository (community discussion)](https://github.com/orgs/community/discussions/42772)
