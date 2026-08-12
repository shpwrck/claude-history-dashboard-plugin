# ADR 0007 — Repo Map: host-side producer + WASM Tree-sitter, container reads the artifact

- **Status:** Accepted
- **Date:** 2026-06-09
- **Issue:** #887 (keystone of the repo-map epic #871; gates #889/#890/#891/#893/#894)
- **Scope:** Records where the Repo Map is generated, what parses it, and the
  artifact contract downstream slices consume. Implementation is the epic's
  sub-issues; this fixes the architecture that left #887 `blocked`.

## Context

Epic #871 wants a bounded structural index of a project root — files, exported
symbols, import edges, and markdown-config sections — to bridge "config *says*
X" to "the code/sessions it governs" and to cut repeated file reads (measured
~6.6M wasted tokens against this repo alone). #887 is the keystone: the parser
that produces the map. Five slices consume its output.

As groomed, #887 mandated **native** Tree-sitter bindings run **at runtime** in
`scripts/server.mjs` "over the mounted project root." Burning the sibling slice
#888 surfaced two hard conflicts with the deploy topology:

1. **The runtime image ships zero `node_modules`.** The `Dockerfile` runtime
   stage copies only `dist/ scripts/ src/lib/ src/types.ts package.json`; the
   server runs raw `.ts` stripped live by `register-ts.mjs`, and every parser
   imports only local files + `node:` builtins. A native `.node` binding (or
   any npm package — `web-tree-sitter` and `typescript` included) cannot be
   resolved at runtime. It would build in the build stage and **fail at
   runtime** — exactly the acceptance path.

2. **The container cannot see project source.** The deploy bind-mounts only
   `~/.claude:ro` and `~/.claude.json:ro`. Project source trees
   (`/home/.../project/...`, and genuinely multi-language ones like a C kernel
   driver and a Go repo in this user's history) are **not mounted**. The
   runtime server has the project-root *paths* (decoded from
   `~/.claude/projects/<encoded>/`) but not the *files*. "Live generation over
   the mounted project root" inside the container is therefore infeasible
   without a new, dynamic, security-relevant mount surface.

## Decision

**Generate the Repo Map host-side; the container only reads the artifact.** This
is the same pattern as the #280 insights bridge — the one other thing the
read-only container can't do itself is delegated to a host process that has the
capability, and the result lands in `~/.claude` for the container to read
read-only. The dashboard's whole model is "read pre-computed `~/.claude`
artifacts, do not compute over live arbitrary source," and the Repo Map joins
that model rather than punching a hole in it.

**Parse with WASM Tree-sitter (`web-tree-sitter`), not native bindings and not
the TypeScript compiler API.** Tree-sitter matches the epic's Aider precedent
and stays multi-language — adding C/Go/etc. is one more `.wasm` grammar, which
the user's real corpus needs. The compiler API's only differentiator is
type-aware analysis, which a structural (syntactic) map does not use, and it is
permanently TS/JS-only and 8.8 MB to carry. Because generation runs host-side
(where `node_modules` exists), `web-tree-sitter` is a normal dependency of the
generator — **nothing is vendored into the runtime image, and the
zero-`node_modules` runtime invariant is preserved.**

**Artifact contract (#887's pinned deliverable).**

- **Location:** `~/.claude/usage-data/repo-map/<encoded-project-root>.json` —
  same namespace and read-only-artifact model as the insights producer, keyed by
  the encoded project-root path already used for `~/.claude/projects/<encoded>/`.
- **Privacy invariant (carried from #888/#892):** persist paths, symbols /
  signatures, import edges, config-section headings, references, hashes / mtimes
  — **never source bodies.** Test-asserted.
- **Staleness stamp:** the artifact records the git sha (or root mtime
  signature) it was generated against, so consumers can badge a stale map rather
  than silently trust it.
- **Token cap:** the rendered map is bounded by a configurable token budget; a
  test asserts the cap holds.

**Slice ownership.** #887 owns the pure generator + the schema + the stamp + a
host invocation path (a script run on the host / in CI against a fixture root).
#889 owns *reading* the artifact into the `repoMap` dataset key. #893 owns
caching / invalidation against the stamp. The in-app trigger-button automation
(the full #280-style systemd `.path` wiring) is a later slice, not #887.

## Considered options

- **Native Tree-sitter + ship `node_modules` into the runtime** — abandons a
  documented, load-bearing invariant (tiny dependency-free runtime, minimal
  attack surface) for one feature. Rejected.
- **In-container generation with a new bind-mount of project roots** — keeps
  "live/fresh" maps but adds a dynamic, security-relevant mount surface *and*
  still needs a parser in the runtime image. Rejected as disproportionate to a
  producer pattern that already exists.
- **TypeScript compiler API** — type-aware but TS/JS-only forever and heavy;
  the structural map doesn't need types. Rejected.

## Consequences

- Repo Map freshness is **producer-triggered** (like `/insights`), not
  live-per-request. The staleness stamp + badge make that visible; #893 owns
  invalidation. Accepted trade-off.
- A host-side runner must eventually be wired (script now; #280-style
  automation later). Until then the map is generated on demand by running the
  generator on the host.
- The runtime container never runs Tree-sitter; the SPA never imports it
  (`sample-boundary` stays satisfied). The zero-`node_modules` runtime invariant
  is untouched.
