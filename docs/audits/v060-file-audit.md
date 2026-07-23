# v0.6.0 file-by-file audit — full repo

Input to release-gate epic #1931 (architecture review). Baseline: origin/master `bd45f1c5`
(survey worktree `../chd-arch-survey`). Every tracked file gets four checks:

- **Feature** — what product feature/surface does this file support?
- **If removed** — what concretely breaks (named consumers: CI job, script, route, import)?
- **Current** — stale content? `OK` or `FINDING:` with evidence.
- **Location** — right place in the tree? `OK` or note.

Homogeneous corpora (fixtures, snapshots) are audited as families: shared verdict,
per-file listing, exceptions called out individually.

Findings that are real defects get filed as sub-issues of #1931 (milestone v0.6.0).

## Ledger (resume state — update after each batch)

| Section | Files | Status | Batch/session |
|---|---|---|---|
| root | 33 | DONE (1 finding → #2953) | 2026-07-22 (da32878e) |
| scripts/ | 158 | DONE (see findings) | 2026-07-22 (da32878e) |
| src/lib (non-detectors) | 455 | DONE (findings: #2959-#2962, additions to #2961) | 2026-07-22 (da32878e) |
| src/lib/detectors | 212 | DONE | 2026-07-22 (da32878e) |
| src/components | 161 | DONE | 2026-07-22 (da32878e) |
| src (rest) | 13 | DONE | 2026-07-22 (da32878e) |
| docs/ | 140 | DONE | 2026-07-22 (da32878e) |
| fixtures/ | 172 | DONE (family treatment) | 2026-07-22 (da32878e) |
| e2e/ | 13 | DONE | 2026-07-22 (da32878e) |
| .github/ | 21 | DONE | 2026-07-22 (da32878e) |
| probaitio-operator/ | 81 | DONE | 2026-07-22 (da32878e) |
| deploy/ | 8 | DONE | 2026-07-22 (da32878e) |
| data/, tools/, bin/, commands/, .claude* | 27 | DONE | 2026-07-22 (da32878e) |

Token pacing: root audit ran ~5.5K subagent tokens/file at full scrutiny. Size each batch
to ≤ half the remaining 5h window (workflow-window-guard); weekly budget matters too.

---

## root (DONE — 2026-07-22)

Audited by three parallel readers + spot verification; one defect filed (#2953).

### package.json / package-lock.json
- Feature: build system spine; all npm entry points.
- If removed: everything — every CI job and build invocation.
- Current: OK — every script target resolves (incl. `gate-2702/*.test.mjs` glob, `bin/coding-agent-dashboard.mjs`). Note: package name `coding-agent-dashboard` vs product brand is intentional.
- Location: OK (root required).

### tsconfig.json / tsconfig.app.json / tsconfig.node.json
- Feature: typecheck gate (`tsc -b`, type-clean per #978).
- If removed: `build`/`typecheck` fail; CI red.
- Current: OK — `paths` aliases match the three live alias seams (`@api-client`, `@shadow-experiments-client`, `@instant-load`) in vite+vitest configs.
- Location: OK (convention).

### vite.config.ts
- Feature: all four build flavors; the free/paid alias seam; instant-shell build-time skeleton; sample-data regeneration.
- If removed: no builds at all.
- Current: OK — detector-chunk list is `existsSync`-guarded by design.
- Location: OK (tool-required).

### vitest.config.ts / eslint.config.js
- Feature: unit-test and lint gates.
- If removed: `test.yml` / `ci.yml` lint job fail.
- Current: OK. Location: OK.

### playwright.config.ts
- Feature: e2e render-smoke/desktop-scroll/overflow gates (browser-compat.yml).
- If removed: `test:e2e` breaks; UI overflow regressions ship unseen.
- Current: OK — all spec patterns map to real files. Location: OK.

### playwright.visual-pilot.config.ts
- Feature: opt-in local mobile visual-regression harness (non-promoted pilot).
- If removed: `test:e2e:visual-pilot` scripts break; no CI impact (deliberately CI-dark, documented in docs/mobile-visual-regression-pilot.md).
- Current: OK. Location: OK. Carry-forward: SC-class (pilot).

### index.html
- Feature: SPA entry; instant-shell injection anchor (`#root`).
- If removed: no app.
- Current: OK (17 lines; skeleton injected at build). Location: tool-required root.

### Dockerfile / Dockerfile.spa
- Feature: server image (zero-node_modules runtime) / static SPA image.
- If removed: docker-publish.yml + deploy.sh / SPA channel break.
- Current: OK — all COPY paths exist; `runtime/gate-2702/` is generated in-build; images match workflow names.
- Location: OK (build context root).

### docker-compose.yml / .local / .spa / .tls
- Feature: the four deployment flavors (base+local = canonical deploy; spa = no-mount static; tls = Caddy HTTPS).
- If removed: deploy.sh (base+local), documented SPA/TLS paths break; 5 parity tests reference them.
- Current: OK — images match publish workflow; env forwards all consumed. See #2953 for the `.env.example` side.
- Location: OK (root required for `.env` auto-load + deploy.sh).
- Note: TLS flavor + Caddyfile are **dormant surface** — zero Caddy containers ever created on the only known operator host; never CI-exercised. v0.7.0 scope decision: keep iff hosted/self-hoster tier ships, else demote to a docs recipe.

### Caddyfile / nginx.spa.conf.template
- Feature: TLS proxy config / SPA nginx config (`${SPA_PORT}`=8325, `/api/`→404).
- If removed: tls flavor breaks / Dockerfile.spa COPY fails.
- Current: OK — proxy target and env vars all wired. Location: OK (relative mounts).

### .dockerignore / .gitignore
- Feature: build-context and repo hygiene.
- If removed: image bloat + `.git` leaks into context / generated files get committed.
- Current: OK — every notable entry maps to a live generator; `public/` entries are annotated intentional guards.
- Location: OK.

### .env.example
- Feature: documented env surface for the compose stack (~82 vars; ~80% enterprise auth/hardening).
- If removed: first-run config discovery gone.
- Current: **FINDING → #2953** — `PORT` is compose-inert (no `${PORT}` interpolation anywhere); real knobs `DASHBOARD_PORT`/`BIND_HOST` undocumented. All other 82 vars verified consumed (TLS set consumed by Caddyfile/compose, not code).
- Location: OK (compose auto-load).

### bundle-budget.json / cold-load-budget.json / perf-probe-budget.json / repo-map-budget.json / server-scale-budget.json
- Feature: the ADR 0016 budget belt — structural bundle classes, cold-load FCP/TTI/CP, warm hot-path (opt-in), repo-map cost ceilings + value floors, large-history server scale.
- If removed: their gate scripts (`check-bundle-size`, `cold-load-measure`, `perf-probe --enforce`, `repo-map-gate`, `server-scale-budget`) fail at default-path resolution; CI jobs red (except perf-probe, deliberately opt-in).
- Current: OK — every changelog note matches current values.
- Location: OK and **load-bearing** — each script hardcodes `join(REPO_ROOT, '<name>.json')`; moving to budgets/ is a 5-script+CI coordinated change.

### README.md
- Feature: front door (users + Pages audience).
- If removed: no onboarding.
- Current: OK — 9+ concrete claims verified (ports, scripts, flavors, view names). Longest root doc (718 lines); trim candidate, not cut.
- Location: OK.

### AGENTS.md / CLAUDE.md
- Feature: cross-harness working agreements / Claude-specific addendum (imports AGENTS.md).
- If removed: agent merge-gate and worktree discipline unenforced-by-doc; CLAUDE.md is the harness entry.
- Current: OK — all named workflows/scripts verified to exist. Location: OK.

### CONTEXT.md
- Feature: domain-language charter (Recommendation/Detector/Catalog, Rule A/B/BYO, RemoteSession, experiment ontology).
- If removed: vocabulary drift across code/issues/reviews; 3 docs reference it.
- Current: OK — all named identifiers verified; `RULES` array retirement now effectively complete, hedge can strengthen to past tense on next touch (minor, no issue).
- Location: OK. Carry-forward: core (semantic contract outlives implementation).

### CONTRIBUTING.md
- Feature: merge policy summary + #241 advisory-gate record + docs-only classifier contract.
- If removed: GitHub PR-UI surfacing lost; #241 record must move to AGENTS.md/ADR first.
- Current: OK — check names match workflows. Duplicate-by-design of AGENTS.md (declared source of truth) = standing drift risk. Cut candidate if consolidated; keep is also defensible (40 lines).
- Location: OK (GitHub convention).

### REFERENCES.md
- Feature: authoritative artifact→parser map; enforced freshness contract (warn 180d/error 365d).
- If removed: parser navigation contract gone; freshness detector loses its subject.
- Current: OK — 1 day fresh; 5+ rows spot-verified.
- Location: OK. Carry-forward: core.

---

## scripts/ (DONE — 2026-07-22)

### — group: server (12 files) —

### scripts/enterprise-auth.test.mjs
- Feature: Enterprise auth bootstrap (#1017) — bearer-token/JWT/session-cookie/CSRF behavior contract for the paid multi-user server mode.
- If removed: `npm run test:enterprise-auth` (package.json:39) breaks; CI `lint` job step "Test enterprise auth behavior suite" (.github/workflows/ci.yml:95) fails; enterprise-readiness-gate.mjs check 1 (`test:enterprise-auth`, scripts/enterprise-readiness-gate.mjs:24) fails — auth/CSRF regressions would ship green again (the exact F5 gap the security sweep closed via #1578).
- Current: OK — header claims match wiring; the ENOENT-sentinel note (#1578) matches code at scripts/enterprise-auth.test.mjs:34-43.
- Location: OK (all server integration suites live in scripts/ beside server.mjs).

### scripts/enterprise-posture-gate.mjs
- Feature: Enterprise "CTO-demo" security posture — boots the real server with hardened config and fails on any action-required control in the admin posture report.
- If removed: `npm run gate:enterprise-posture` (package.json:106) breaks; CI `lint` job step "Check enterprise CTO-demo security posture" (ci.yml:84) fails; enterprise-readiness-gate.mjs check 6 (scripts/enterprise-readiness-gate.mjs:52) fails.
- Current: OK — required-controls list and boot-the-real-server approach match ci.yml's stated intent (#1201/#1016 comments at ci.yml:80-83).
- Location: OK.

### scripts/enterprise-readiness-gate.mjs
- Feature: Composite enterprise readiness receipt for CTO-demo / paid-pilot review — ordered composition of the narrower auth/egress/posture/scale/SPA-boundary gates.
- If removed: `npm run gate:enterprise-readiness` (package.json:107) breaks; enterprise-readiness-gate.test.mjs (CI, ci.yml:78) fails on its import of `ENTERPRISE_READINESS_CHECKS`/`findSpaBoundaryOffenders`; docs consumers break: docs/enterprise-readiness.md:105, docs/enterprise-deployment-guide.md:247, docs/RELEASING.md:244.
- Current: OK. Note (known, not refiling): no workflow runs the full gate itself — CI runs only its unit test plus most sub-gates individually; docs/audits/2026-06-codebase-audit.md:212 already tracks the "re-enable in CI or mark local-only" decision, and the header honestly says "local receipt".
- Location: OK.

### scripts/enterprise-readiness-gate.test.mjs
- Feature: Pins the readiness receipt's check list and SPA-boundary scanner (#1176) so the CTO receipt can't silently lose a sub-gate.
- If removed: `npm run test:enterprise-readiness-gate` (package.json:46) breaks; CI `lint` job step (ci.yml:78) fails.
- Current: OK — asserted check list matches `ENTERPRISE_READINESS_CHECKS` in the gate (verified names/order against scripts/enterprise-readiness-gate.mjs:22-108).
- Location: OK.

### scripts/instant-shell-server.test.mjs
- Feature: Instant-load shell (#2444) — GET / serves real KPIs when auth is off, and MUST stay a skeleton pre-auth under enterprise auth (no global-count disclosure).
- If removed: `npm run test:instant-shell-server` (package.json:55) breaks; CI `build` job step "Check instant-shell server upgrade + pre-auth suppression" (ci.yml:171) fails; the security-relevant `ENTERPRISE_AUTH_ON ? null : lastInstantShell` gate loses its regression guard.
- Current: OK.
- Location: OK.

### scripts/policy-write.test.mjs
- Feature: Policy Builder settings.json write-back route (#199/#308/#311) — validation, backup, dedupe, idempotency, CSRF-token/same-origin/content-type rejection matrix.
- If removed: `npm run test:policy-write` (package.json:38) breaks; docs/plans/openshift-mvp/40-same-origin-csrf.md names it as the pinning test for the whole same-origin/CSRF contract. No CI workflow consumes it (see finding).
- Current: FINDING — unwired test: no workflow runs `test:policy-write` (`grep -rn policy-write .github/` → no hits) and `npm test` is `vitest run && node --test scripts/gate-2702/*.test.mjs` (package.json:33), so this mutating-route security suite never runs automatically; docs/plans/openshift-mvp/40-same-origin-csrf.md:496 even assumes it sits "in the CI test job alongside" — it doesn't. Header claim "wired as npm run test:policy-write" (line 5) is true but only manual.
- Location: OK.

### scripts/server-hardening.test.mjs
- Feature: Server startup-config rejection + bounded recommendation single-flight maps (#1420).
- If removed: `npm run test:server-hardening` (package.json:61) breaks; CI `build` job step "Check server hardening contracts" (ci.yml:186) fails.
- Current: OK.
- Location: OK.

### scripts/server-healthcheck.test.mjs
- Feature: `/healthz` no-data liveness endpoint for containers/reverse proxies, incl. under enterprise auth (#1203).
- If removed: `npm run test:server-healthcheck` (package.json:53) breaks; CI `build` job step (ci.yml:159) fails; enterprise-readiness-gate.mjs check (scripts/enterprise-readiness-gate.mjs:72) fails.
- Current: OK.
- Location: OK.

### scripts/server-http-timeouts.test.mjs
- Feature: Explicit slow-client listener timeouts (headers/request/keep-alive) instead of Node-version defaults (#1205).
- If removed: `npm run test:server-http-timeouts` (package.json:60) breaks; CI `build` job step (ci.yml:182) fails; enterprise-readiness-gate.mjs check (scripts/enterprise-readiness-gate.mjs:82) fails.
- Current: OK.
- Location: OK.

### scripts/server-runtime-import-guard.test.mjs
- Feature: Zero-node_modules runtime image guarantee (#1013/#1195, ADR 0007) — boots the server with `DASHBOARD_RUNTIME_IMPORT_GUARD=1` so bare npm imports in the boot graph fail before release instead of crash-looping the published image.
- If removed: `npm run test:server-runtime-imports` (package.json:50) breaks; TWO CI consumers fail: test.yml `test` job (test.yml:69, "standalone runtime isolation tests") and ci.yml `build` job (ci.yml:153); enterprise-readiness-gate.mjs check (scripts/enterprise-readiness-gate.mjs:67) fails; also imports `buildGate2702Runtime` from scripts/build-gate-2702-runtime.mjs.
- Current: OK. Minor: it runs twice per PR (both test.yml and ci.yml on every PR event) — redundant CI spend, though harmless for correctness.
- Location: OK.

### scripts/server-scale-budget.mjs
- Feature: Server-mode large-history load budget (#1139/#1099) — synthetic 1000+-session org-shaped corpus; budgets boot, cold dataset route, ingest, assembly, serialization, memory growth vs server-scale-budget.json.
- If removed: `npm run gate:server-scale` (package.json:109) breaks; dedicated PR workflow .github/workflows/server-scale.yml (job `server-scale`, line 94) fails; enterprise-readiness-gate.mjs check (scripts/enterprise-readiness-gate.mjs:87) fails; docs/perf-sprint/server-scale.md and docs/enterprise-deployment-guide.md:237 reference it.
- Current: OK — imports `buildSampleCorpus` from scripts/sample-data/build-corpus.mjs exactly as server-scale.yml:11-13 describes; Node-24 calibration note (#1572) present in the workflow.
- Location: OK.

### scripts/server.mjs
- Feature: THE live backend — the entire server flavor of the product: serves the built SPA from dist/ plus ~147 `/api/*` and legacy data routes computed live from `~/.claude`.
- If removed: the server deployment ceases to exist — Dockerfile CMD (`Dockerfile:108`: `node --import ./scripts/register-ts.mjs scripts/server.mjs`) breaks; every server integration suite above spawns it (`SERVER = 'scripts/server.mjs'` in enterprise-auth, posture-gate, instant-shell, policy-write, hardening, healthcheck, http-timeouts, runtime-import-guard, plus the source-routes/push-ingest/recommendations suites); server-scale-budget.mjs boots it; deploy path (`npm run deploy` → compose) ships it.
- Current: OK — the 19-line header is an honest but very partial summary (legacy routes it lists are still live: /sessions-manifest.json + /history.jsonl handled at scripts/server.mjs:8823/10669; the "Env: HOST, PORT" line dramatically undersells the DASHBOARD_* env surface, but suites and docs carry those contracts). No stale claim found.
- Location: OK by repo convention, though at 10,972 lines a single scripts/ file is the repo's largest module by far — decomposition is an architecture observation for the artifact, not a defect of the file's placement per current conventions.

FINDINGS:
1. scripts/policy-write.test.mjs is not wired into any CI workflow: no workflow references `test:policy-write` and `npm test` (package.json:33) runs only vitest + gate-2702 suites, so the mutating settings.json write-back security matrix (CSRF token, same-origin, content-type, byte caps) only runs when invoked manually — the same class of gap the sweep's F5 (#1578) closed for enterprise-auth. docs/plans/openshift-mvp/40-same-origin-csrf.md:496 assumes it is already in the CI test job.
2. (minor) scripts/server-runtime-import-guard.test.mjs runs twice on every PR — test.yml:69 and ci.yml:153 both invoke `npm run test:server-runtime-imports`; one is redundant CI spend.


### — group: ingest-data (28 files) —

### scripts/artifact-cache-parity.test.mjs
- Feature: Data-integrity/zero-reparse gate for the #624 artifact-ingest cache seam (dataset assembly of `~/.claude` auxiliary artifacts).
- If removed: `npm run test:artifact-cache` (package.json:68) breaks. Nothing else references it.
- Current: FINDING — the test is not wired into CI. `test:artifact-cache` appears nowhere in `.github/workflows/` (grepped all workflows), `npm test` is only `vitest run && node --test scripts/gate-2702/*.test.mjs` (package.json:33). This is the exact class ci.yml:365-369 already fixed for `test:session-blob-cache` ("was only a manual-run command and never ran in CI").
- Location: OK.

### scripts/cold-ingest-bench.mjs
- Feature: Prototype benchmark for parallel first-ever empty-cache ingest fan-out (#855) — perf exploration, not product path.
- If removed: `npm run bench:ingest:cold` (package.json:103) breaks; it is the only consumer of `cold-ingest-worker.mjs`. No CI wiring (on-demand bench by design).
- Current: OK — header honestly says it "stops before production wiring", and ingest.mjs indeed still has no worker fan-out (no `worker_threads` import), so the prototype framing is accurate, not stale.
- Location: OK.

### scripts/cold-ingest-worker.mjs
- Feature: Worker-thread half of the #855 cold-ingest prototype (parses session_blob rows off-thread via `session-blob-row.mjs`).
- If removed: `scripts/cold-ingest-bench.mjs` breaks (spawns it via `new Worker`). Sole consumer; lives or dies with the bench.
- Current: OK.
- Location: OK.

### scripts/dataset-cache-schema-version.test.mjs
- Feature: Regression gate for persisted `dataset_cache` invalidation (#1543) — schema version must feed both source signature and ingest contentHash.
- If removed: `npm run test:dataset-cache-schema` (package.json:92) and the CI step at ci.yml:377 break.
- Current: FINDING — the comment at scripts/dataset-cache-schema-version.test.mjs:59-62 claims "the exact equal(28) assertion above already excludes every other version" and uses that to omit a v27 `notEqual`; but the assertion at :54-57 compares the key against a template built from the SAME const (`v${ingest.FLAG_OFF_DATASET_ASSEMBLY_SCHEMA_VERSION}`) — self-referential, no literal 28 pin exists anywhere (grepped scripts/ + src/). A FLAG_OFF regression to 27 would pass both it and every listed `notEqual` (v26…v20), silently re-serving stale v27 cache bodies — the exact regression class the #2709 review item meant to fence.
- Location: OK.

### scripts/dataset-field-sizes.mjs
- Feature: Per-field byte attribution of `/api/dataset.json` (#2072, v0.5.0 perf gate) — the "why is it large" probe.
- If removed: `npm run perf:field-sizes` (package.json:115) and its unit test's import break; the pure `fieldSizes` core is what ci.yml:287 exercises via the test.
- Current: OK — fetch path is documented as on-demand, matching ci.yml:284-287's comment.
- Location: OK.

### scripts/dataset-field-sizes.test.mjs
- Feature: Unit tests for the network-free aggregation core of dataset-field-sizes.
- If removed: `npm run test:dataset-field-sizes` (package.json:64) and CI step ci.yml:287 break.
- Current: OK — wired into CI.
- Location: OK.

### scripts/ingest-bench.mjs
- Feature: Throughput benchmark for assembleDataset() and parse hot paths (#665), against the deterministic sample corpus.
- If removed: `npm run bench:ingest` (package.json:102) breaks. On-demand bench, no CI wiring by design.
- Current: OK.
- Location: OK.

### scripts/ingest-guidance.mjs
- Feature: Fetches registered external guidance articles into committed static snapshots under `data/external-guidance/` that recommendation rendering reads (#1303/#1407).
- If removed: `npm run ingest:guidance` (package.json:28) and the scheduled refresh workflow `.github/workflows/ingest-guidance.yml:48` (`npm run -s ingest:guidance`) break, plus its test's imports.
- Current: OK.
- Location: OK.

### scripts/ingest-guidance.test.mjs
- Feature: Unit tests for per-page conditional fetch, redirect allowlist, entity decoding, and drift report of ingest-guidance.
- If removed: `npm run test:ingest-guidance` (package.json:67) breaks.
- Current: FINDING — unwired into CI: `test:ingest-guidance` appears in no workflow (ingest-guidance.yml runs only the ingest itself, ci.yml/test.yml never invoke it, `npm test` doesn't glob scripts/). The allowlist/redirect enforcement it covers is a security-relevant write path (committed snapshots), so it only runs when someone remembers to.
- Location: OK.

### scripts/ingest.mjs
- Feature: The core — incremental transcript ingestion + normalized dataset assembly (SQLite session_blob/dataset_cache) behind every `/api/*` data route.
- If removed: `scripts/server.mjs` breaks (static import at server.mjs:93 plus per-enterprise-root dynamic import at server.mjs:1358); ~20 scripts/tests import it (repo-map-generate.mjs, session-blob-row.mjs consumers, all the parity tests, server-scale-budget.mjs, mcp-shim.mjs, …).
- Current: OK (as far as a head-read of a file this size can vouch; its cache-invalidation knobs are fence-tested via test:scripts-parity, ci.yml:359).
- Location: OK.

### scripts/lib/doc-hygiene-agents-lint.mjs
- Feature: Adapter normalizing the pinned agents-lint 0.5.0 JSON contract for the doc-hygiene producer/recommendations (#2487, epic #2256).
- If removed: `scripts/doc-hygiene-run.mjs` (the deploy-path producer, `npm run refresh:doc-hygiene`, scripts/deploy.sh:93) and both its tests break.
- Current: OK.
- Location: OK — shared lib consumed by a script and its tests.

### scripts/lib/doc-hygiene-agents-lint.test.mjs
- Feature: Unit tests for the agents-lint adapter (masking, line-number stability, checker admission).
- If removed: `npm run test:doc-hygiene-host` (package.json:86, first entry in the chain) and CI step ci.yml:324 break.
- Current: OK — wired into CI.
- Location: OK — co-located with its subject in scripts/lib/; note it is the only `.test.mjs` under scripts/lib/ (every other scripts test sits at scripts/ top level), a minor convention wobble, not a defect.

### scripts/lib/host-producer.mjs
- Feature: The ADR 0007 host-producer seam (#2077): shared `~/.claude` root discovery + capped artifact reads for every producer/consumer.
- If removed: `scripts/ingest.mjs` (static import), `scripts/repo-map-refresh.mjs`, `scripts/server.mjs`, `scripts/host-producer.test.mjs` (`npm run test:host-producer`, CI ci.yml:311) all break.
- Current: OK — the "three producers" framing in the header predates the doc-hygiene producer (#2486), but that producer discovers via `git ls-tree`, not `~/.claude` roots, so the seam claim still holds; cosmetic at most.
- Location: OK.

### scripts/lib/kube-client.mjs
- Feature: Zero-dep dual-mode Kubernetes API client for the server's `/api/sessions` RemoteSession dispatch routes (k8s substrate, epic #1247).
- If removed: `scripts/server.mjs` breaks (dynamic imports at server.mjs:5535, 5583, 5621); `scripts/server-runtime-import-guard.test.mjs` references it.
- Current: OK.
- Location: OK — must live outside src/ (server boot graph can't import src/), per its own header and the zero-node_modules constraint.

### scripts/lib/model-edit-benchmark.ts
- Feature: Host-only mutation + scoring mechanics for the structured-edit eval corpus (down-modelling confidence work, #2138 family).
- If removed: `scripts/model-eval-run.mjs` (`npm run eval:model-edit`) and `scripts/structured-edit-arm-run.mjs` (`npm run eval:structured-edit-arm`) break; `src/lib/structured-edit-eval.ts:267` pins its path as the receipt `scorer_path`.
- Current: OK.
- Location: OK — deliberately split from the dependency-free `src/lib/structured-edit-eval.ts` to keep Babel/Prettier/diff out of that contract; the only npm-heavy module in scripts/lib, but header justifies it and it's host/eval-only.

### scripts/lib/parser-output-versions.mjs
- Feature: The single parser-output → cache-invalidation registry (#2075) gating the session_blob key and the persisted repo-map version.
- If removed: `scripts/session-blob-row.mjs`, `scripts/ingest.mjs`, `src/lib/repo-map/parser.ts`, `src/lib/repo-map/cache.ts`, and the forward-fence test (in `test:scripts-parity`, CI ci.yml:359) all break.
- Current: OK.
- Location: OK.

### scripts/lib/remotesession-dispatch.mjs
- Feature: Pure validation/naming/manifest helpers for the server's `/api/sessions` RemoteSession dispatch routes.
- If removed: `scripts/server.mjs` breaks (dynamic import at server.mjs:5574); `src/lib/provision-naming.test.ts` (vitest, so in CI via `npm test`) is the byte-for-byte drift guard against `src/lib/provision-naming.ts`.
- Current: OK.
- Location: OK — deliberate mirror because the server can't import src/; the drift-guard test is the documented compensation.

### scripts/lib/stat-gated-cache.mjs
- Feature: Route-agnostic stat-gated single-flight response cache (#1573) behind `/api/digest` and `/api/search`.
- If removed: `scripts/server.mjs` and `scripts/ingest.mjs` break; tests `stat-gated-cache.test.mjs` (`npm run test:stat-gated-cache`, CI ci.yml:261) and `search-digest-cache-route.test.mjs` break.
- Current: OK.
- Location: OK.

### scripts/repo-map-artifact-path-parity.test.mjs
- Feature: Producer/consumer path-encoding parity for the repo-map artifact seam (#719/#1004) — both sides must use `artifactPathFor`.
- If removed: `npm run test:repo-map-artifact-path` (package.json:82) breaks. Nothing else references it.
- Current: FINDING — unwired into CI: `test:repo-map-artifact-path` appears in no workflow; `npm test` doesn't reach it. Same never-runs-in-CI class ci.yml:365 documents having fixed for the session-blob cache test. A silent encoding drift is exactly what this test exists to catch, and today it would only be caught manually.
- Location: OK.

### scripts/repo-map-gate.mjs
- Feature: Repo-map measurement/budget CI gate (#893, epic #871): artifact size, cold-ingest cost, localization recall, reread-waste savings vs `repo-map-budget.json`.
- If removed: CI step ci.yml:296 (runs it directly) and `npm run gate:repo-map` (package.json:110) break.
- Current: OK.
- Location: OK.

### scripts/repo-map-generate.mjs
- Feature: Host-side repo-map producer (#887, ADR 0007): writes `~/.claude/usage-data/repo-map/<encoded-root>.json` for the runtime to consume.
- If removed: `scripts/repo-map-refresh.mjs` (spawns it per root — the `npm run deploy` path), `scripts/doc-neighborhood-inject.mjs`, and `scripts/repo-map-refresh.test.mjs` break.
- Current: OK.
- Location: OK.

### scripts/repo-map-refresh.mjs
- Feature: Deploy-time refresh driver (#1650): discovers ingested project roots and runs the repo-map producer for each, keeping the `context.repo-map-context-waste` rec live.
- If removed: `npm run refresh:repo-map` (package.json:23), `scripts/deploy.sh:90` (every `npm run deploy`), and its test break.
- Current: OK.
- Location: OK.

### scripts/repo-map-refresh.test.mjs
- Feature: End-to-end coverage of the refresh driver, round-tripping produced artifacts through the real consumer.
- If removed: `npm run test:repo-map-refresh` (package.json:83) and CI step ci.yml:304 break.
- Current: OK — wired into CI.
- Location: OK.

### scripts/sample-data/build-corpus.mjs
- Feature: Seeded deterministic synthetic `~/.claude` corpus (#526) powering the marketing SPA's sample data and every ingest bench.
- If removed: `vite.config.ts:8` (SPA-mode sample-data.zip plugin) breaks the SPA build; also `scripts/sample-data/generate.mjs`, `ingest-bench.mjs`, `cold-ingest-bench.mjs`, `server-scale-budget.mjs` (server-scale.yml), `measure-render-churn.mjs`, and coverage tests `src/lib/sample-corpus.test.ts` / `sample-adoption.test.ts` (vitest → CI).
- Current: OK.
- Location: OK.

### scripts/sample-data/generate.mjs
- Feature: Manual escape hatch writing `sample-data.zip` to the repo root for inspection (#526); the SPA build generates the zip itself via the Vite plugin.
- If removed: only `npm run generate:sample` (package.json:22) breaks. Header correctly says it is NOT part of any build.
- Current: OK.
- Location: OK.

### scripts/session-blob-cache-parity.test.mjs
- Feature: Load-bearing data-integrity gate for the #627 session_blob cache extraction (round-trip byte-identity + sig-gate incremental contract).
- If removed: `npm run test:session-blob-cache` (package.json:70) and CI step ci.yml:369 break.
- Current: OK — wired into CI (ci.yml:365 documents it was previously unwired and fixed).
- Location: OK.

### scripts/session-blob-row.mjs
- Feature: Pure per-session parse-row builder (session_blob columns) shared by production ingest and the #855 worker prototype.
- If removed: `scripts/ingest.mjs` (production ingest path), `scripts/cold-ingest-worker.mjs`, and `scripts/parser-output-versions.fence.test.mjs` (CI via test:scripts-parity) break.
- Current: OK — the long in-file version history is explicitly rationale-only, with the live value correctly delegated to the #2075 seam.
- Location: OK.

### scripts/session-blob-schema-parity.test.mjs
- Feature: DDL/upsert parity gate for the #524 generated session_blob schema against verbatim golden DDL.
- If removed: `npm run test:scripts-parity` (package.json:90, first file in the list) and CI step ci.yml:359 break.
- Current: OK — wired into CI.
- Location: OK.

FINDINGS:
1. scripts/artifact-cache-parity.test.mjs — data-integrity test unwired into CI: `test:artifact-cache` (package.json:68) is invoked by no workflow and `npm test` (package.json:33) doesn't reach scripts/ tests; same class ci.yml:365 records fixing for `test:session-blob-cache`.
2. scripts/repo-map-artifact-path-parity.test.mjs — parity test unwired into CI: `test:repo-map-artifact-path` (package.json:82) appears in no workflow; the producer/consumer path-encoding drift it guards would ship silently.
3. scripts/ingest-guidance.test.mjs — test unwired into CI: `test:ingest-guidance` (package.json:67) is run by no workflow; `.github/workflows/ingest-guidance.yml:48` runs only the ingest itself, so the redirect/allowlist enforcement tests never run automatically.
4. scripts/dataset-cache-schema-version.test.mjs:59-62 — comment claims the preceding equal assertion "excludes every other version" so v27 needs no `notEqual`, but that assertion (:54-57) is self-referential (template built from `FLAG_OFF_DATASET_ASSEMBLY_SCHEMA_VERSION` itself; no literal 28 pin exists in the repo), so a FLAG_OFF regression to 27 passes all assertions and stale v27 dataset_cache bodies would be re-served — the gap the #2709 review item intended to close.


### — group: gates-ci (20 files) —

### scripts/check-bundle-size.mjs
- Feature: Per-flavor JS bundle-size budget gate (#664/#1415) — enforces `bundle-budget.json` ceilings on the server and SPA build outputs.
- If removed: ci.yml `build` job step "Check server bundle-size budget" (ci.yml:131) and `spa-boundary` step "Check SPA bundle-size budget" (ci.yml:482) fail (missing script); `scripts/enterprise-readiness-gate.mjs:62,106` invokes it for both flavors; its pure core is imported by `src/lib/check-bundle-size.test.ts:26` (vitest, so `npm test`/test.yml would break too).
- Current: OK — header's claimed wiring (ci.yml build=server, spa-boundary=spa) matches ci.yml:131/482 exactly.
- Location: OK.

### scripts/check-engine-absent.mjs
- Feature: Viewer-only browser contract (#2719, epic #2443) — proves the detector catalog/`buildRecommendations` sentinel is absent from emitted browser bundles.
- If removed: ci.yml steps at :125 (server frontend dist) and :464 (SPA dist) fail; npm script `check:engine-absent` (package.json:21) breaks; referenced as the enforcement mechanism by `src/lib/detectors/index.ts:191` and `src/lib/recommendation-surface.test.ts:122`.
- Current: OK — marker `CHD_DETECTOR_CATALOG_v2719_PRESENT` kept in sync with `src/lib/detectors/index.ts`.
- Location: OK.

### scripts/check-enterprise-route-inventory.mjs
- Feature: Enterprise data-route surface gate (#1180) — every `/api/*` route in `scripts/server.mjs` must be classified in `ENTERPRISE_ROUTE_INVENTORY` with an access policy.
- If removed: npm `gate:enterprise-routes` (package.json:108) breaks; `scripts/enterprise-readiness-gate.mjs:47` runs that gate; its test (ci.yml:87) imports it and validates the real `server.mjs` (test line 48), so the ci `lint`-job step fails.
- Current: OK.
- Location: OK.

### scripts/check-enterprise-route-inventory.test.mjs
- Feature: Unit + real-source coverage for the route-inventory gate; reads the real `scripts/server.mjs` (line 48), so the inventory-vs-server sync check runs on every PR.
- If removed: ci.yml:87 (`npm run test:enterprise-route-inventory`, package.json:47) fails; the only PR-CI execution of the inventory sync check disappears (the `gate:enterprise-routes` npm script itself is not run directly in CI).
- Current: OK — wired into CI.
- Location: OK.

### scripts/check-inbound-boundary.mjs
- Feature: Inbound half of the SPA/server split (#2081) — asserts every server call routes through the `src/lib/api-client.ts` chokepoint by banning raw network primitives outside `NETWORK_OWNERS`.
- If removed: ci.yml `spa-boundary` step :474 (`npm run gate:inbound-boundary`, package.json:105) fails; test at ci.yml:477 imports it; allowlist entries are cross-referenced from `src/lib/instant-load.ts:10` and `src/lib/dataset-slice-worker.ts:20`.
- Current: OK.
- Location: OK.

### scripts/check-inbound-boundary.test.mjs
- Feature: Regression coverage for the inbound boundary gate's false-positive classes (owners, comments, test files).
- If removed: ci.yml:477 (`npm run test:inbound-boundary`, package.json:91) fails.
- Current: OK — wired into CI.
- Location: OK.

### scripts/check-llm-egress.mjs
- Feature: Anthropic egress governance gate (ADR 0008, #932) — origin-literal allowlist, wrapper call-site registration against `src/lib/llm-registry.ts`, pre-public exposure contract, generated-doc freshness.
- If removed: ci.yml:417 (`npm run gate:llm-egress`, package.json:104) fails; its test (ci.yml:414) imports it; the ADR 0008 enforcement seam disappears.
- Current: FINDING (minor): header at check-llm-egress.mjs:4 says "The gate has three layers:" but enumerates four (lines 5–10 list 1–4, doc-freshness added without updating the count).
- Location: OK.

### scripts/check-llm-egress.test.mjs
- Feature: Unit tests for the egress gate's pure validators (#932).
- If removed: ci.yml:414 (`npm run test:llm-egress-gate`, package.json:45) fails.
- Current: OK — wired into CI.
- Location: OK.

### scripts/check-release-gate.mjs
- Feature: Release-cut hard gate — a minor release cannot cut until the milestone's standing `release-gate` epics (perf/arch, +security ≥v0.3, +data-integrity ≥v0.6 #2130) are closed; patch releases exempt (#652).
- If removed: `release-gate.yml:61` (workflow_dispatch + v* tag push) fails; `scripts/seed-release-gates.mjs` imports `expectsSecurityGate()` and friends from it (single source of truth for the version-aware gate set), so the seed workflow breaks too; `npm run test:release-gate` breaks.
- Current: script OK; adjacent staleness in its consumer: `release-gate.yml:3-5` header still describes only perf/arch/security and omits the v0.6+ data-integrity gate the script enforces (same omission in `seed-release-gates.yml:3-4`).
- Location: OK.

### scripts/check-release-gate.test.mjs
- Feature: Unit tests for target classification and the patch-exemption logic (#652).
- If removed: only `npm run test:release-gate` (package.json:40) breaks.
- Current: FINDING: unwired from CI — `test:release-gate` appears in no workflow (grep of `.github/workflows/` for `test:release-gate`/`check-release-gate.test` returns nothing) and `npm test` is `vitest run` (include `src/**/*.test.{ts,tsx}`, vitest.config.ts:38) plus `node --test scripts/gate-2702/*.test.mjs` only. A regression in the release gate ships silently until a cut.
- Location: OK.

### scripts/ci-docs-only.mjs
- Feature: Docs-only PR classifier — lets expensive jobs skip at the job level without required check names disappearing (replaces `paths-ignore`).
- If removed: five workflows fail at their "Detect docs-only changes" step: test.yml:41, ci.yml:53, browser-compat.yml:64, server-scale.yml:47, cold-load.yml:54.
- Current: OK.
- Location: OK.

### scripts/compose-runtime-hardening.test.mjs
- Feature: Least-privilege container contract for `docker-compose.yml` (#1208) — enterprise deployments keep hardened runtime settings.
- If removed: ci.yml:177 (`npm run test:compose-runtime-hardening`, package.json:65) fails; compose hardening could silently drift.
- Current: OK — wired into CI; subject (`docker-compose.yml`) exists.
- Location: OK (it is a config-contract check, not a script test; scripts/ is where all standalone .mjs suites live).

### scripts/ensure-pr-milestone.mjs
- Feature: Milestone guard (#722) — every PR to master carries a release milestone; auto-assigns when exactly one open vX.Y(.Z) milestone exists.
- If removed: `milestone-guard.yml:54` fails on every PR open/merge event; `npm run test:milestone-guard` breaks.
- Current: OK — header matches the workflow (PR-open auto-assign + merge backstop) and the #1045 vX.Y.Z drift is handled.
- Location: OK.

### scripts/ensure-pr-milestone.test.mjs
- Feature: Unit test for the pure milestone-selection logic of the guard.
- If removed: only `npm run test:milestone-guard` (package.json:42) breaks.
- Current: FINDING: unwired from CI — `test:milestone-guard` appears in no workflow and is outside `npm test`'s vitest/node-test globs (same evidence as check-release-gate.test.mjs).
- Location: OK.

### scripts/label-milestone-prs.mjs
- Feature: Release-notes hygiene (#716) — backfills domain labels onto a milestone's merged PRs so `gh release create --generate-notes` buckets via `.github/release.yml` instead of "Other changes".
- If removed: `label-milestone-prs.yml:53,55` (workflow_dispatch, dry-run + apply) fails; `scripts/backfill-release-notes.mjs:16` documents it as the prerequisite step; `npm run test:label-milestone-prs` breaks.
- Current: OK.
- Location: OK.

### scripts/label-milestone-prs.test.mjs
- Feature: node:test suite for the conservative PR classifier, incl. parsing the real `.github/release.yml`.
- If removed: only `npm run test:label-milestone-prs` (package.json:43) breaks.
- Current: FINDING: unwired from CI — `test:label-milestone-prs` appears in no workflow and is outside `npm test`'s globs. Notably this test parses the real `.github/release.yml`, so a release.yml category change that breaks the classifier would not fail any PR check.
- Location: OK.

### scripts/register-ts.mjs
- Feature: Two-line `node:module` register shim delegating to `scripts/ts-resolver.mjs` — lets Node run the `.ts` parsers in `src/lib` directly (zero-node_modules server runtime, ADR 0007).
- If removed: the production container entrypoint dies (`Dockerfile:108` CMD `node --import ./scripts/register-ts.mjs scripts/server.mjs`); ~40 package.json scripts (`test:settings`, `test:instant-shell-server`, every `--import ./scripts/register-ts.mjs` entry), `scripts/deploy.sh:50`, and dozens of standalone test/eval scripts break. Highest-blast-radius file in the group.
- Current: OK.
- Location: OK.

### scripts/seed-release-gates.mjs
- Feature: Seed half of the release-gate contract (#721) — auto-creates the standing dormant `release-gate` epics when a vX.Y milestone is created; imports the version-aware expected set from check-release-gate.mjs.
- If removed: `seed-release-gates.yml:63` (milestone-created + workflow_dispatch) fails — releases could again start life without their gates; `npm run test:seed-release-gates` breaks.
- Current: OK (header correctly includes the v0.6 data-integrity gate; the workflow header does not — noted under check-release-gate.mjs).
- Location: OK.

### scripts/seed-release-gates.test.mjs
- Feature: node:test suite for the seeder (mocked GitHub fetch): idempotence, version-aware domain sets, patch/non-vX.Y no-ops, #1045 name drift.
- If removed: only `npm run test:seed-release-gates` (package.json:41) breaks.
- Current: FINDING: unwired from CI — `test:seed-release-gates` appears in no workflow and is outside `npm test`'s globs.
- Location: OK.

### scripts/settings-validation.test.mjs
- Feature: Regression test for `validateSettingsJson` in `src/lib/config-hygiene.ts` (#167) — the Config Hygiene settings.json validation surface.
- If removed: only `npm run test:settings` (package.json:35) breaks — but this is the ONLY test of `validateSettingsJson` (`grep validateSettingsJson src/lib/*.test.ts` returns nothing; `src/lib/config-hygiene.test.ts` does not cover it).
- Current: TWO FINDINGS: (a) unwired from CI — `test:settings` appears in no workflow and is outside `npm test`'s globs, so the sole coverage of settings validation never runs on PRs; (b) stale header at settings-validation.test.mjs:3 — "This repo has no formal test runner" — false since the Vitest suite (#222) and test.yml became required PR checks.
- Location: Arguable — since it tests a `src/lib` module (not a script), it could live as `src/lib/config-hygiene-settings.test.ts` under vitest, which would also fix the CI-wiring gap for free.

FINDINGS:
1. Five gate/release test suites are unwired from CI: `scripts/check-release-gate.test.mjs`, `scripts/ensure-pr-milestone.test.mjs`, `scripts/label-milestone-prs.test.mjs`, `scripts/seed-release-gates.test.mjs`, `scripts/settings-validation.test.mjs` exist only as manual npm scripts (package.json:35,40-43); no workflow invokes them (grep of `.github/workflows/` for `test:settings|test:release-gate|test:seed-release-gates|test:milestone-guard|test:label-milestone-prs` — zero hits) and `npm test` runs only `vitest run` (include `src/**/*.test.{ts,tsx}`, vitest.config.ts:38) + `node --test scripts/gate-2702/*.test.mjs`. Regressions in the release-cut gate, milestone guard, seeder, and changelog labeler ship without any red check.
2. `scripts/settings-validation.test.mjs:3` — stale claim "This repo has no formal test runner"; the Vitest suite has been a required PR check since #222 (test.yml). Compounding finding 1: this file is the only coverage of `validateSettingsJson` anywhere.
3. `scripts/check-llm-egress.mjs:4` — header says "The gate has three layers:" but enumerates four (lines 5-10); the doc-freshness layer was added without updating the count.
4. Consumer-side staleness for `scripts/check-release-gate.mjs`: `.github/workflows/release-gate.yml:3-5` and `.github/workflows/seed-release-gates.yml:3-4` headers still describe the gate set as perf/arch + security-from-v0.3, omitting the v0.6+ data-integrity gate (#2130) the scripts enforce/seed.


### — group: gate-2702 (23 files) —

### scripts/gate-2702/accounting.mjs
- Feature: C5-only cost + Sidekick accounting producer for the #2702 gate experiment (worker cost, sidekick ledger, all-in-cost receipt), consent-gated behind `CHD_EXPERIMENT_2702=1`
- If removed: `scripts/gate-2702/seal.mjs` breaks — it resolves `ACCOUNTING_PATH` (seal.mjs:50) and spawns it as the `collect` producer (seal.mjs:723); `accounting.test.mjs` (in the `npm test` glob) fails; the seal's accounting evidence chain (`seal-accounting.mjs` rederivation) loses its producer
- Current: OK — header ("C5-only cost and Sidekick accounting bridge for #2702") matches behavior; consent gate precedes all side effects as claimed
- Location: OK

### scripts/gate-2702/accounting.test.mjs
- Feature: Test coverage for the accounting producer (spawns `accounting.mjs` CLI, accounting.test.mjs:18)
- If removed: coverage lost; wired into CI via `package.json:33` (`"test": "vitest run && node --test scripts/gate-2702/*.test.mjs"`) run by `.github/workflows/test.yml:62`
- Current: OK — subject under test is `accounting.mjs`, test is CI-wired
- Location: OK

### scripts/gate-2702/behavior-context.mjs
- Feature: Shared constants + environment capture for the C5 bridge — worker/sidekick model ids, sidekick version 0.3.3, `SIDEKICK_*` env-key allowlist, execution-mode switch
- If removed: five siblings break at import: `accounting.mjs`, `classify.mjs`, `judge.mjs`, `run.mjs`, `seal-classification.mjs`, plus `classify.test.mjs` and `judge.test.mjs` import it directly
- Current: OK — model ids (`claude-haiku-4-5-20251001`, `claude-sonnet-5`) and sidekick v0.3.3 are consistent with all consumers and current model naming
- Location: OK (no dedicated test file, but it is a constants/pure-capture module exercised by every sibling's CI-wired test)

### scripts/gate-2702/classify.mjs
- Feature: Arm classifier/executor for the C5 trial — launches the jailed worker per arm, runs the vitest/typecheck gate checks, captures classification evidence
- If removed: `run.mjs` breaks (`CLASSIFIER_PATH`, run.mjs:41); `seal.mjs` lineage validation breaks (`CLASSIFIER_PATH`, seal.mjs:49); `classify.test.mjs` fails; `run.test.mjs` also references it (run.test.mjs:21)
- Current: OK
- Location: OK

### scripts/gate-2702/classify.test.mjs
- Feature: Test coverage for the classifier (spawns `classify.mjs`, classify.test.mjs:24; also exercises `behavior-context.mjs`)
- If removed: coverage lost; CI-wired via `npm test` glob (package.json:33) in test.yml:62
- Current: OK
- Location: OK

### scripts/gate-2702/evaluate.mjs
- Feature: Deterministic policy evaluator producing the pre-registered C5 v1 Verdict from a verified #2822 seal (`loadCurrentEvaluation` read API)
- If removed: `shadow-projection.mjs` dev fallback breaks (shadow-projection.mjs:95); `runtime-verifier-entry.mjs` (the Dockerfile-bundled runtime verifier) breaks; `evaluate.test.mjs` and `seal.test.mjs` (imports `evaluateTrial`, seal.test.mjs:23) fail; npm script `test:gate-2702-evaluate` (package.json:37) breaks
- Current: OK — header's "intentionally narrower than a generic experiment evaluator" claim matches the hardcoded CONTROL/TREATMENT/metric ids
- Location: OK

### scripts/gate-2702/evaluate.test.mjs
- Feature: Test coverage for the evaluator (imports definition subjects via `register-ts.mjs`, evaluate.test.mjs:16-22)
- If removed: coverage lost; CI-wired twice — `npm test` glob (package.json:33, test.yml:62) and dedicated `test:gate-2702-evaluate` (package.json:37, local convenience, not referenced by any workflow)
- Current: OK
- Location: OK

### scripts/gate-2702/judge.mjs
- Feature: Blind LLM judge for the C5 trial — scores the two arms per attempt on the fixed dimension rubric with a Haiku judge, bounded budget/timeout
- If removed: `seal.mjs` breaks — `JUDGE_PATH` (seal.mjs:51) is both lineage-validated (seal.mjs:589) and spawned as a producer (seal.mjs:729); `judge.test.mjs` fails; npm script `test:gate-2702-judge` (package.json:36) breaks
- Current: OK — definition digest `sha256:8fffa233…` matches seal.mjs, seal-classification.mjs, seal-judge.mjs, shadow-projection.mjs, and `src/lib/experiment-runtime/bridges/gate-2702/definition.test.ts:23`
- Location: OK

### scripts/gate-2702/judge.test.mjs
- Feature: Test coverage for the judge (spawns `judge.mjs`, judge.test.mjs:25; also exercises `worktree-evidence.mjs` and `behavior-context.mjs`)
- If removed: coverage lost; CI-wired via `npm test` glob (test.yml:62) plus local `test:gate-2702-judge` (package.json:36, not in any workflow)
- Current: OK
- Location: OK

### scripts/gate-2702/run.mjs
- Feature: The operator CLI for the whole C5 experiment — narrow, disposable runner that launches/resumes/inspects/seal-gates the one checked-in #2818 Definition (spawns `classify.mjs` and `seal.mjs`, run.mjs:41-42)
- If removed: the gate-2702 experiment loses its entry point (the external `~/.claude` gate-2702 runner drives this CLI); `run.test.mjs` fails (RUNNER, run.test.mjs:20)
- Current: OK — header honestly disclaims general-harness ambitions, matching the hardcoded REPOSITORY/definition constants
- Location: OK

### scripts/gate-2702/run.test.mjs
- Feature: Test coverage for the runner (spawns `run.mjs`, run.test.mjs:20; 9 tests)
- If removed: coverage lost; CI-wired via `npm test` glob (package.json:33, test.yml:62)
- Current: OK
- Location: OK

### scripts/gate-2702/runtime-verifier-entry.mjs
- Feature: 5-line build-only entry re-exporting `loadCurrentEvaluation` for the self-contained verifier bundle shipped into the zero-node_modules server image
- If removed: the Docker build breaks — `Dockerfile:38` runs `scripts/build-gate-2702-runtime.mjs`, whose Vite `build.ssr` entry is this file (build-gate-2702-runtime.mjs:48-53), and `Dockerfile:65` copies the resulting `runtime-verifier.bundle.mjs` next to `shadow-projection.mjs`, which imports it in production (shadow-projection.mjs:86); `server-runtime-import-guard.test.mjs:93-147` (CI: `test:server-runtime-imports`, test.yml:69 / ci.yml:153) fails
- Current: OK — the "bundling Ajv" comment is accurate (Ajv lives in `src/lib/experiment-runtime/contracts/v1/schema.ts`, pulled in via evaluate → contracts)
- Location: OK

### scripts/gate-2702/seal-accounting.mjs
- Feature: Pure (no fs/process) rederivation + validation of accounting evidence for the sealed C5 bundle
- If removed: `seal.mjs` breaks at import (seal.mjs:44); `seal-accounting.test.mjs` and `seal.test.mjs` (imports `deriveGate2702AccountingEvidence`, seal.test.mjs:24) fail
- Current: OK
- Location: OK

### scripts/gate-2702/seal-accounting.test.mjs
- Feature: Test coverage for the pure accounting rederivation (direct import, seal-accounting.test.mjs:7)
- If removed: coverage lost; CI-wired via `npm test` glob (test.yml:62)
- Current: OK
- Location: OK

### scripts/gate-2702/seal-classification.mjs
- Feature: Pure classification-evidence verifier for the sealed bundle — rederives worker/check/lifecycle claims from retained bytes only
- If removed: `seal.mjs` breaks at import (seal.mjs:45); `seal-classification.test.mjs` fails
- Current: OK — frozen SUBJECTS/TREATMENTS/CHECKS constants match `judge.mjs` and `run.test.mjs` exactly
- Location: OK

### scripts/gate-2702/seal-classification.test.mjs
- Feature: Test coverage for the classification-evidence verifier (direct import, seal-classification.test.mjs:4)
- If removed: coverage lost; CI-wired via `npm test` glob (test.yml:62)
- Current: OK
- Location: OK

### scripts/gate-2702/seal-judge.mjs
- Feature: Pure judge-evidence verifier — rederives frozen input, blind requests, attempt lifecycles, and the final judge result from retained bytes
- If removed: `seal.mjs` breaks at import (seal.mjs:46); `seal-judge.test.mjs` fails
- Current: OK — JUDGE_MODEL/timeout/budget constants mirror `judge.mjs` verbatim (intentional duplication so the verifier stays independent of the producer)
- Location: OK

### scripts/gate-2702/seal-judge.test.mjs
- Feature: Test coverage for the judge-evidence verifier (direct import, seal-judge.test.mjs:4)
- If removed: coverage lost; CI-wired via `npm test` glob (test.yml:62)
- Current: OK
- Location: OK

### scripts/gate-2702/seal.mjs
- Feature: Durable evidence sealer/verifier for C5 — captures every retained byte + full git diffs into one atomic content-addressed bundle; `verify`/`loadVerifiedTrial` work from the bundle alone after worktrees are gone
- If removed: `run.mjs` breaks (`SEALER_PATH`, run.mjs:42); `evaluate.mjs` breaks (`loadVerifiedTrial` dynamic import, evaluate.mjs:284) — which transitively breaks the server's shadow projection and the Docker runtime bundle; `seal.test.mjs` fails
- Current: OK
- Location: OK

### scripts/gate-2702/seal.test.mjs
- Feature: Test coverage for seal/verify/loadVerifiedTrial (direct imports, seal.test.mjs:23-25; 17 tests)
- If removed: coverage lost; CI-wired via `npm test` glob (test.yml:62)
- Current: OK
- Location: OK

### scripts/gate-2702/shadow-projection.mjs
- Feature: Server-only filesystem adapter feeding the bounded `gate2702` field of `GET /api/shadow-experiments.json` (the Shadow Calls C5 view)
- If removed: `scripts/server.mjs` breaks — dynamic import at server.mjs:182-183, called per-request at server.mjs:10236 (deliberately uncached so tampered artifacts never outlive validation); `shadow-projection.test.mjs` and the `test:shadow-experiments-route` CI job's surface (ci.yml:281) lose the projection
- Current: OK — production/bundle-vs-dev-fallback import logic (shadow-projection.mjs:83-96) matches the Dockerfile bundle placement and the "never fall back to the npm-dependent source graph in production" comment
- Location: OK — borderline (it is server-runtime code living under scripts/, like `server.mjs` itself), consistent with repo convention

### scripts/gate-2702/shadow-projection.test.mjs
- Feature: Test coverage for the shadow projection (direct import of `readGate2702ShadowProjection`, shadow-projection.test.mjs:14)
- If removed: coverage lost; CI-wired via `npm test` glob (test.yml:62)
- Current: OK
- Location: OK

### scripts/gate-2702/worktree-evidence.mjs
- Feature: Shared git-worktree evidence capture (tracked-source + untracked-file digests under hard byte/count caps) for the C5 producers
- If removed: `classify.mjs` (classify.mjs:29) and `judge.mjs` (judge.mjs:29) break at import; `judge.test.mjs` imports it directly (judge.test.mjs:22)
- Current: OK
- Location: OK (no dedicated test file, but exercised by the CI-wired classify/judge tests)

FINDINGS: none


### — group: doc-family (13 files) —

### scripts/doc-git-times-generate.mjs
- Feature: Per-document Git last-commit-time manifest (`data/doc-git-times.json`) powering doc "as-of" freshness provenance in the docs/doc-graph surface (#2707, epic #2256; ADR-0007 host producer).
- If removed: `npm run refresh:doc-git-times` (package.json:25) breaks; `scripts/deploy.sh:102` fails on every deploy; `.github/workflows/docker-publish.yml:64` fails the publish workflow pre-build step; `scripts/doc-git-times-generate.test.mjs` and `scripts/doc-git-times-parity.test.mjs` (CI `test:doc-git-times`, ci.yml:333) break; consumer `src/lib/doc-git-times.ts` degrades every doc to filesystem provenance; `src/lib/docker-docs-runtime.test.ts:57-64` fails.
- Current: OK — header claims (fail-closed, zero-dep, workflow + deploy.sh call sites) all match the code and workflows checked.
- Location: OK (scripts/ is the ADR-0007 host-producer home).

### scripts/doc-git-times-generate.test.mjs
- Feature: Black-box producer tests for the git-times manifest (fixture repos, fail-closed paths).
- If removed: `npm run test:doc-git-times` (package.json:87) loses its first half; CI step "Check doc git-times producer" (ci.yml:333) loses producer coverage.
- Current: OK — wired into CI via `test:doc-git-times`; subject under test is `doc-git-times-generate.mjs` (line 24).
- Location: OK (co-located with subject; vitest only globs src/**, so scripts/ tests must live here with explicit wiring — ci.yml:327-331 comment states this).

### scripts/doc-git-times-parity.test.mjs
- Feature: Producer(.mjs)/consumer(.ts) seam-constant parity fence for the git-times manifest (RELPATH, schema version, caps, pathspecs).
- If removed: second half of `test:doc-git-times` (package.json:87) and CI step ci.yml:333 lose the drift fence; a moved RELPATH would ship dark (the silent-death class the header names).
- Current: OK — imports resolve (`doc-git-times-generate.mjs` exports all four constants; `src/lib/doc-git-times.ts`, `src/lib/parse-docs.ts` referenced consistently).
- Location: OK.

### scripts/doc-hygiene-artifact-path-parity.test.mjs
- Feature: Producer/consumer parity + tolerant-ingest contract for the doc-hygiene artifact path (#2486) — asserts ingest finds `~/.claude/usage-data/doc-hygiene/<key>.json` and deploy.sh invokes the runner (line 196 asserts `doc-hygiene-run.mjs` appears in deploy.sh; deploy.sh:93 satisfies it).
- If removed: second half of `npm run test:doc-hygiene-host` (package.json:86) and CI step "Check doc-hygiene host producer" (ci.yml:324) lose path-parity coverage.
- Current: OK.
- Location: OK.

### scripts/doc-hygiene-run.mjs
- Feature: Host-side Markdown hygiene producer (#2486, epic #2256) — Lychee + agents-lint over the committed Markdown surface, writing a Scorecard-shaped artifact under `~/.claude/usage-data/doc-hygiene/`.
- If removed: `npm run refresh:doc-hygiene` (package.json:24) breaks; `scripts/deploy.sh:93` fails; `scripts/doc-hygiene-run.test.mjs` (imports it, line 20) and `doc-hygiene-artifact-path-parity.test.mjs` (asserts its presence in deploy.sh) fail — i.e. CI `test:doc-hygiene-host` (ci.yml:324) goes red; docs-hygiene ingest degrades to null.
- Current: OK — header's opt-in claim (`CHD_DOC_HYGIENE_EXTERNAL_LINKS=1`, zero external calls when unset) matches the code and the repo's non-local-data rule.
- Location: OK.

### scripts/doc-hygiene-run.test.mjs
- Feature: Unit tests for the hygiene runner (command construction, external-link opt-in, missing-binary degradation, lychee JSON normalization).
- If removed: `npm run test:doc-hygiene-host` (package.json:86) loses runner coverage; CI ci.yml:324 weakened.
- Current: OK — wired into CI; subject is `doc-hygiene-run.mjs` (lines 14-20, 464).
- Location: OK.

### scripts/doc-issue-parity.test.mjs
- Feature: Byte-identical-default + seam parity fence for the opt-in doc-issue GitHub snapshot (#2710) — proves the serialized dataset OMITS `docIssueSnapshot` when `CHD_DOC_ISSUES` is unset/invalid.
- If removed: `npm run test:doc-issue-parity` (package.json:89) loses its lead suite; CI step "Check doc-issue snapshot parity" (ci.yml:347) loses the flag-off byte-identical guarantee — the exact guarantee AGENTS.md's non-local-data rule requires stated and verified.
- Current: OK.
- Location: OK.

### scripts/doc-issue-recommendations-expiry.test.mjs
- Feature: Real-server boundary proof that a recommendation envelope built on a doc-issue snapshot is cached only through the snapshot's inclusive 24h boundary (#2710).
- If removed: dropped from `test:doc-issue-parity` (package.json:89, third entry) and CI ci.yml:347 — the 24h stale-claim boundary would be untested.
- Current: OK — wired into CI; spawns the real `scripts/server.mjs` with intercepted external fetches.
- Location: OK.

### scripts/doc-issue-server-restart.test.mjs
- Feature: Cold-restart safety for the doc-issue snapshot — persisted SQLite dataset cache must not serve stale snapshot-backed claims after opt-out or past-boundary restarts (#2710).
- If removed: dropped from `test:doc-issue-parity` (package.json:89, second entry) and CI ci.yml:347.
- Current: OK.
- Location: OK.

### scripts/doc-neighborhood-inject.mjs
- Feature: ADR-0007 host-side doc-neighborhood agent-inject producer (#2322/#2263) — given a task anchor, emits the ranked doc cluster JSON; backs the plugin's `doc_neighborhood` MCP tool.
- If removed: `scripts/mcp-shim.mjs:167` breaks the `doc_neighborhood` MCP tool; `scripts/doc-neighborhood-inject.test.mjs` and `npm run test:doc-neighborhood-inject` (package.json:85, CI ci.yml:318) fail; `src/lib/doc-neighborhood-inject.ts:41` documents it as the walking half of the surface.
- Current: OK — header's usage/gating claims match `mcp-shim.mjs` and the test's suppression assertions.
- Location: OK.

### scripts/doc-neighborhood-inject.test.mjs
- Feature: End-to-end producer test over a real tmp doc tree plus the empty-stdout suppression contract.
- If removed: `npm run test:doc-neighborhood-inject` (package.json:85) empties; CI step "Check doc-neighborhood inject producer" (ci.yml:318) loses its only coverage.
- Current: OK — wired into CI.
- Location: OK.

### scripts/docker-push-retry.sh
- Feature: Bounded-retry `docker push` wrapper riding out GHCR blob-race flakes during image publish.
- If removed: all four push steps in `.github/workflows/docker-publish.yml` (lines 127, 220, 249, 279) break — dashboard, SPA, dispatch, and operator image publishes.
- Current: FINDING (known, already filed — do not refile): header line 6 says "docker-publish builds five images" but the workflow builds four (`Dockerfile`, `Dockerfile.spa`, `probaitio-operator/Dockerfile.dispatch`, `probaitio-operator/Dockerfile` — docker-publish.yml:121, 214, 246, 276). Mechanically harmless; the retry logic is ref-count-agnostic.
- Location: OK (scripts/ alongside other CI helpers; referenced by relative path from the workflow).

### scripts/docs-map-parity.test.mjs
- Feature: Seam parity fence for the versioned docs-map contract (#2709) — relpath constant vs re-hardcoded literals in ingest, committed declaration parses under the reader cap, identity locator plumbed into BASE compose.
- If removed: `npm run test:docs-map` (package.json:88) empties; CI step "Check docs-map contract parity" (ci.yml:341) loses the fence; a moved `DOCS_MAP_RELPATH` or an override-only compose locator would die silently (podman-compose 1.5.0 drops override additions — the class this fence pins).
- Current: OK.
- Location: OK.

FINDINGS:
1. scripts/docker-push-retry.sh:6 — header says "docker-publish builds five images"; the workflow builds four (docker-publish.yml:121/214/246/276). Already filed per audit brief — noted here, not refiled.


### — group: plugin-release (14 files) —

### scripts/assemble-plugin-payload.mjs
- Feature: Claude Code plugin marketplace mirror — assembles the published plugin payload (dist, scripts, src, manifest, commands, docs) as the single source of truth for what ships.
- If removed: `pages-publish-plugin.yml:81` (publish workflow) fails; `package.json` `build:plugin-payload` breaks; `scripts/plugin-mcp-payload.test.mjs` (CI `test` job via `test:plugin-mcp-payload`, test.yml:71, and pages-publish-plugin.yml:88) cannot build its clean-runtime fixture.
- Current: OK — header claim ("publish workflow and the clean-runtime test both call this") matches both consumers exactly.
- Location: OK.

### scripts/atomize-config.mjs
- Feature: Config-hygiene codemod for the `context.over-scoped-config-section` recommendation (#1267/#1268/#1664) — splits monolithic CLAUDE.md/AGENTS.md into path-scoped rules or nested AGENTS.md files, reversibly.
- If removed: the fix path referenced by `src/lib/detectors/context/over-scoped-config-section.ts` becomes a dead pointer; `src/lib/atomize-config.test.ts` (vitest, wired into `npm test` via `include: ['src/**/*.test.{ts,tsx}']`) fails to import it; `src/lib/config-rule-naming.ts` documents it as its consumer. Not a removal candidate.
- Current: OK — header commands match the implemented flags; parity with `parse-config-sections.ts` is pinned by the vitest test as claimed.
- Location: OK (user-facing CLI belongs in scripts/), though note it is config-hygiene tooling, not plugin-release — it landed in this audit group by adjacency only.

### scripts/backfill-release-notes.mjs
- Feature: Release management — regenerates a published GitHub Release body into the `.github/release.yml` categorized shape (#716), dry-run by default, never destroys the prior body.
- If removed: `.github/workflows/backfill-release-notes.yml:56,58` (workflow_dispatch job) breaks; `scripts/backfill-release-notes.test.mjs` and `npm run test:backfill-release-notes` break. Imports `ghApi`/`loadReleaseConfig` from `label-milestone-prs.mjs` (dependency, not consumer).
- Current: OK — header's CI pointer (`backfill-release-notes.yml`, workflow_dispatch) and test pointer are accurate.
- Location: OK.

### scripts/backfill-release-notes.test.mjs
- Feature: Unit coverage for the release-notes backfill composition logic (mocked fetch, fixture PR lists).
- If removed: only `npm run test:backfill-release-notes` (package.json:44) breaks — and nothing runs that script in CI.
- Current: FINDING — unwired test. `npm test` is `vitest run && node --test scripts/gate-2702/*.test.mjs` (package.json:33) and vitest's include is `src/**/*.test.{ts,tsx}` (vitest.config.ts:38), so this file is excluded; grep of `.github/workflows/` for `backfill` finds only the dispatch workflow running the *script* (backfill-release-notes.yml:56,58), never `test:backfill-release-notes`. The suite runs only when invoked by hand.
- Location: OK.

### scripts/build-plugin-mcp.mjs
- Feature: Plugin publish pipeline — Vite-SSR-bundles `mcp-shim.mjs` plus all npm deps (`@modelcontextprotocol/sdk`) into one self-contained ESM artifact so the zero-dependency server runtime never carries the SDK.
- If removed: `assemble-plugin-payload.mjs` (its sole importer) fails, breaking `build:plugin-payload`, `pages-publish-plugin.yml`, and `test:plugin-mcp-payload`.
- Current: OK.
- Location: OK.

### scripts/generate-experiment-contract-fixtures.mjs
- Feature: Experiment-runtime contract v1 (fixtures for enrollment/race/replay/proof-model-evaluation/speed-background-first flows) — deterministic generator for the committed corpus under `fixtures/experiment-runtime/v1/`.
- If removed: nothing executes it automatically (no npm script, no workflow — greps: `grep -rn generate-experiment-contract-fixtures .github/workflows/ package.json` empty), but the committed fixtures it produces are consumed by wired vitest suites `src/lib/experiment-runtime/contracts/v1/fixture-corpus.test.ts` and `canonical.test.ts`, and `src/lib/experiment-runtime/README.md:43` names it as the regeneration path. Removing it orphans the corpus (unregenerable). Keep.
- Current: OK — imports `canonical.ts` directly, which works under the repo's `engines: node >=22.18.0` (native type stripping). Manual-run-only is by design (fixtures are committed).
- Location: OK.

### scripts/generate-llm-usage-registry-doc.mjs
- Feature: LLM egress governance (ADR 0008) — renders `docs/llm-usage-registry.md` from `src/lib/llm-registry.ts` and exports the staleness check used by the egress gate.
- If removed: `npm run generate:llm-registry` (package.json:30) breaks, and `scripts/check-llm-egress.mjs:18` imports `checkLlmUsageRegistryDocFresh` from it — so `gate:llm-egress` (package.json:104, run in ci.yml:417) fails.
- Current: OK.
- Location: OK.

### scripts/mcp-shim-isolation.test.mjs
- Feature: Guards the MCP isolation contract — server.mjs never references the shim, the shim imports the MCP SDK, and the plugin manifest declares the shim inline.
- If removed: the isolation contract loses its CI enforcement; wired via `test:mcp-shim-isolation` (package.json:51) in the required `test` job (test.yml:70).
- Current: OK — its three claims verify against reality (`.claude-plugin/plugin.json:22` declares the shim; grep-based check honestly scoped, deferring transitive-graph proof to `server-runtime-import-guard.test.mjs`).
- Location: OK.

### scripts/mcp-shim.mjs
- Feature: The plugin's stdio MCP server process — exposes `dashboard_status`, `get_recommendations`, `top_frictions`, `doc_neighborhood` to Claude Code, isolated from the zero-deps server boot graph.
- If removed: `.claude-plugin/plugin.json:22` launch args dangle (plugin MCP dead); `build-plugin-mcp.mjs` bundle entry missing (publish pipeline fails); `mcp-shim-isolation.test.mjs` and `plugin-mcp-payload.test.mjs` (both in CI test job) fail.
- Current: OK — the four documented tools match `EXPECTED_TOOLS` in plugin-mcp-payload.test.mjs and the live plugin's tool surface.
- Location: OK.

### scripts/plugin-ctl.mjs
- Feature: Cross-platform zero-npm-deps supervisor (start/stop/status) for the dashboard server when installed as a Claude Code plugin.
- If removed: `commands/dashboard.md` (the `/dashboard` plugin command, lines 2/17/33/39) breaks; `plugin-runtime-state.test.mjs` source-regex assertion fails; `plugin-ctl.test.mjs` loses its subject; ships in the plugin payload via `assemble-plugin-payload.mjs`.
- Current: OK — Node>=24 preflight is deliberate and documented (repo `engines` is >=22.18.0 for the wider toolchain; the divergence is explained in plugin-runtime-state.test.mjs's Node-22-CI comment).
- Location: OK.

### scripts/plugin-ctl.test.mjs
- Feature: Test coverage for the plugin supervisor's pid/port/liveness logic; wired via `test:plugin-ctl` (package.json:48) in the required CI test job (test.yml:73).
- If removed: CI's `test:plugin-ctl` step fails (missing file) — wired consumer exists.
- Current: FINDING — the test never imports or executes `plugin-ctl.mjs` at all: it re-implements the helpers locally (lines 47–50 admit "We replicate the minimal pure functions here") and asserts against the replicas, so the real module can regress without this suite noticing. Worse, the header (lines 7–8) claims "Spawn is exercised via an integration smoke test that only boots the real server when the test environment allows it" — no such smoke test exists anywhere in the file (no spawn, no import, no child process). The header contradicts the file's own contents; the only real coupling to plugin-ctl.mjs source anywhere is one regex assertion in plugin-runtime-state.test.mjs.
- Location: OK.

### scripts/plugin-mcp-payload.test.mjs
- Feature: Runtime contract test for the installed plugin — assembles the real payload into an OS temp dir (no reachable node_modules) and drives the bundled shim over a real MCP stdio client, proving the marketplace artifact boots standalone.
- If removed: the strongest publish-integrity guard disappears; wired via `test:plugin-mcp-payload` in the CI test job (test.yml:71) and as a pre-publish gate (pages-publish-plugin.yml:88).
- Current: OK — `EXPECTED_TOOLS` matches the shim's actual four tools.
- Location: OK.

### scripts/plugin-runtime-state.mjs
- Feature: Shared port/cache-dir state resolution between the supervisor (`plugin-ctl.mjs`) and the separately bundled MCP shim — Node built-ins only.
- If removed: `mcp-shim.mjs` (imports `readActiveDashboardPort`) and `plugin-ctl.mjs` (imports `pluginCacheDir`/`pluginPortFile`/`preferredDashboardPort`) both break, i.e. the entire plugin runtime; `plugin-runtime-state.test.mjs` fails.
- Current: OK.
- Location: OK.

### scripts/plugin-runtime-state.test.mjs
- Feature: Unit tests for the shared runtime-state module (port precedence CHD_PORT→PORT→5173, state-file wins, malformed fallback), plus a source-regex pin that plugin-ctl.mjs wires `preferredDashboardPort` into `freePort`.
- If removed: CI `test:plugin-runtime-state` step (test.yml:72, package.json:49) fails — wired consumer exists; also removes the only assertion anywhere that touches real `plugin-ctl.mjs` code (see plugin-ctl.test.mjs finding).
- Current: OK — runs under `node --test`, exercises the real imported module.
- Location: OK.

FINDINGS:
1. scripts/backfill-release-notes.test.mjs is not wired into CI: `npm test` (vitest include `src/**/*.test.{ts,tsx}` at vitest.config.ts:38 + `node --test scripts/gate-2702/*.test.mjs` only) excludes it, and no workflow runs `test:backfill-release-notes` — the suite only runs when invoked manually.
2. scripts/plugin-ctl.test.mjs tests re-implemented replicas of the supervisor helpers instead of importing `plugin-ctl.mjs` (lines 47–50), and its header claim of an "integration smoke test that ... boots the real server" (lines 7–8) is false — no spawn/import of the real module exists in the file, so CI green here proves nothing about the actual supervisor.


### — group: perf-bench (10 files) —

### scripts/analyze-bundle.mjs
- Feature: Bundle-composition visibility (epic #1852, #1860) — attributes built SPA bytes to source modules/owners via sourcemap decoding, so bundle growth is traceable.
- If removed: `npm run analyze:bundle` (package.json:20) breaks, and ci.yml `bundle-report` job breaks (`node scripts/analyze-bundle.mjs --dist dist | tee bundle-composition.txt`, ci.yml:515 — informational artifact upload, `|| true`, non-gating).
- Current: OK — header (zero-dep, post-processes sourcemap build, source-map-explorer-style attribution) matches the code and the ci.yml job comment (ci.yml:484-491).
- Location: OK.

### scripts/cold-load-measure.mjs
- Feature: Cold-load budget gate (#663, epic #638) — median FCP/TTI-proxy/Content-Painted per SPA flavor against the published build via `vite preview` + headless Chromium, gated on `cold-load-budget.json`.
- If removed: `.github/workflows/cold-load.yml` cold-load job breaks (cold-load.yml:90), `npm run measure:cold-load` (package.json:116) breaks, and docs/perf-sprint/cold-load.md's run recipes (lines 157-171) go dead.
- Current: OK — header claims (wired into cold-load.yml, flavor ports 4473/4474, CP metric per #1867) all check out; `cold-load-budget.json` exists at repo root.
- Location: OK.

### scripts/host-producer.test.mjs
- Feature: Contract tests for the host-producer seam (`scripts/lib/host-producer.mjs`, #2077, ADR 0007) — the shared capped-read/root-discovery layer for ingest.mjs / repo-map-refresh.mjs.
- If removed: ci.yml "Check host-producer seam" step breaks (ci.yml:310-311 → `npm run test:host-producer`, package.json:84). Subject module `scripts/lib/host-producer.mjs` exists.
- Current: OK — wired into CI; pins the byte-cap robustness gap the seam was built to close, matching the ci.yml comment (ci.yml:306-309).
- Location: OK (sibling of other scripts/*.test.mjs; subject is under scripts/lib/). Not a perf-bench script despite the grouping — it is a producer-seam test.

### scripts/measure-isolated-views.mjs
- Feature: Per-view render-churn measurement with a fresh browser context per view (#666) — avoids cumulative PerformanceObserver bleed that the combined harness suffers.
- If removed: `npm run perf:render-churn-isolated` (package.json:113) breaks; documented in docs/perf-sprint/render-churn.md:7,150. On-demand only, not CI.
- Current: FINDING (shared with measure-render-churn.mjs): imports `chromium` from `'playwright'` (scripts/measure-isolated-views.mjs:4) but package.json declares only `@playwright/test` (package.json:133) — a phantom dependency that resolves via npm hoisting today but breaks under strict installers or a `@playwright/test` dep change. cold-load-measure.mjs does it right (`from '@playwright/test'`).
- Location: OK.

### scripts/measure-render-churn.mjs
- Feature: Render-churn harness (#666) + warm-nav settle sweep (#2395) — longtask/CLS/resize-storm per view against `vite preview`; also exports the route-catalog parser (`extractRouteCatalog`) that reads nav-prefs.ts via the TypeScript compiler API.
- If removed: `npm run perf:render-churn` / `perf:render-churn:sweep` (package.json:111-112) break; ci.yml "Check render-churn route catalog" step breaks transitively (its test imports this module); docs/perf-sprint/render-churn.md:7 goes dead.
- Current: FINDING: same phantom `'playwright'` import (scripts/measure-render-churn.mjs:24) as measure-isolated-views.mjs — not in package.json (`typescript`, its other unusual import, IS declared at package.json:150). Otherwise header matches code (default port 4476, `--sweep --json` stdout purity).
- Location: OK.

### scripts/measure-render-churn.test.mjs
- Feature: Pins the network-free `extractRouteCatalog()` parser in measure-render-churn.mjs (#2395) so a nav-prefs.ts shape change can't silently shrink sweep coverage.
- If removed: ci.yml "Check render-churn route catalog" step breaks (ci.yml:199-200 → `npm run test:render-churn`, package.json:63).
- Current: OK — wired into CI; header's claim about what it covers (parser only, measurement path on demand) matches ci.yml:196-198.
- Location: OK.

### scripts/perf-compare.sh
- Feature: Baseline-vs-PR `/api/dataset.json` TTFB comparison (5-hit medians via curl) — early perf-sprint tooling (#163 era, last touched 2026-05-29).
- If removed: nothing found — removal candidate. Greps: `grep -rn "perf-compare" .` (excl. node_modules/.git) hits only the file itself; absent from package.json scripts, .github/workflows/, Dockerfile*, docs/, and src/.
- Current: OK as a script, but orphaned; its niche (server TTFB) is now largely covered by perf-probe.mjs (#2069), though the two-URL A/B compare shape is unique to it.
- Location: OK (scripts/), but if kept it should be documented somewhere; today it is invisible.

### scripts/perf-probe.mjs
- Feature: Warm hot-path latency probe (#2069, epic #1474, v0.5.0 perf gate) — per-endpoint warm latency (`/api/dataset.json`, `/api/recommendations.json`, `/api/digest`, `/api/sessions`) against an already-running server on the real corpus, with opt-in budget enforcement from `perf-probe-budget.json`.
- If removed: `npm run perf:probe` (package.json:114) breaks; perf-probe.test.mjs breaks (imports `percentile`/`round1`/`evaluateBudget`), which breaks ci.yml:192-193; `perf-probe-budget.json` becomes dead config.
- Current: OK — header's boundary claims vs server-scale-budget.mjs and cold-load-measure.mjs are accurate; measurement path deliberately not a CI gate, pure logic unit-tested, exactly as stated.
- Location: OK.

### scripts/perf-probe.sh
- Feature: Legacy curl-based first-data probe of a running dashboard's `/api/dataset.json` (identity/brotli/If-None-Match hits + index.html) — pre-#2069 tooling, last touched 2026-05-29 (#163).
- If removed: nothing found — removal candidate. Greps: `grep -rn "perf-probe\.sh" .` (excl. node_modules/.git) hits only the file itself; absent from package.json, workflows, docs, src. Superseded by perf-probe.mjs, which measures the same endpoint with percentiles, more routes, and a budget gate (its byte/encoding-header inspection is the only piece the .mjs lacks).
- Current: OK content-wise, but stale as a surface — the name collision with the canonical perf-probe.mjs invites confusion about which is the real probe.
- Location: OK (scripts/), but orphaned; fold anything still wanted into perf-probe.mjs and drop it.

### scripts/perf-probe.test.mjs
- Feature: Unit tests for perf-probe.mjs's pure budget logic (percentile interpolation, evaluateBudget breaches) plus a shape check on the shipped `perf-probe-budget.json`.
- If removed: ci.yml "Check perf-probe budget logic" step breaks (ci.yml:192-193 → `npm run test:perf-probe`, package.json:62), and a malformed budget-file edit would only surface at probe runtime.
- Current: OK — wired into CI; scope matches the perf-probe.mjs header's "only the pure budget logic is unit-tested" contract.
- Location: OK.

FINDINGS:
1. scripts/perf-compare.sh has zero consumers (no workflow, npm script, doc, or script references it — greps above) — removal candidate.
2. scripts/perf-probe.sh has zero consumers and is superseded by perf-probe.mjs (#2069); the shared basename with the canonical probe is actively confusing — removal candidate.
3. Phantom dependency: scripts/measure-render-churn.mjs:24 and scripts/measure-isolated-views.mjs:4 `import { chromium } from 'playwright'`, but package.json declares only `@playwright/test` (package.json:133); resolution relies on npm hoisting of a transitive dep and breaks under strict installers — should import from `@playwright/test` (as cold-load-measure.mjs does) or declare `playwright`.


### — group: misc (38 files) —

### scripts/build-gate-2702-runtime.mjs
- Feature: Gate-#2702 seal/evaluation verifier — bundles the verifier + npm deps into one ESM file for the zero-node_modules production runtime (ADR 0007).
- If removed: `Dockerfile:38` (`RUN node scripts/build-gate-2702-runtime.mjs /app/runtime/gate-2702/runtime-verifier.bundle.mjs`) fails the image build; `scripts/assemble-plugin-payload.mjs` (plugin payload) and `scripts/gate-2702/seal.test.mjs` + `scripts/server-runtime-import-guard.test.mjs` break.
- Current: OK — header matches Dockerfile usage.
- Location: OK.

### scripts/checkpoint-answer-route.test.mjs
- Feature: Test — CSRF-protected checkpoint-answer persistence route (#2519) on the real server.
- If removed: npm `test:checkpoint-answers` breaks; CI `ci.yml:247` (`npm run test:checkpoint-answers`) fails.
- Current: OK — wired into CI.
- Location: OK.

### scripts/daily-digest-route.test.mjs
- Feature: Test — `/api/digest` daily-digest route contract (#1292/#1385) against the real server.
- If removed: nothing breaks. FINDING: completely unwired — no `package.json` script references it (grep of `daily-digest` in package.json: no hits) and no workflow runs it; vitest covers `src/**` only and `npm test`'s node --test glob is `scripts/gate-2702/*.test.mjs` only. Verified also on origin/master. The route gets only incidental coverage via `search-digest-cache-route.test.mjs`.
- Current: FINDING (above) — the test itself looks healthy (hermetic mkdtemp fixture, last touched in #2451), it just never runs.
- Location: OK.

### scripts/deploy.sh
- Feature: Canonical deploy — refresh host-side repo-map/doc-hygiene/doc-git-times artifacts, then `podman compose … up` (#1650, epic #1264).
- If removed: npm `deploy` / `deploy:pull` (package.json:26-27) break; `docker-compose.yml:62` and `Dockerfile:83` document contracts that depend on the env vars/artifacts it exports; several tests reference its behavior (`src/lib/deploy-script.test.ts`, `scripts/docs-map-parity.test.mjs`, `scripts/doc-hygiene-artifact-path-parity.test.mjs`).
- Current: OK — header matches AGENTS.md deploy documentation (`--pull`, `--no-refresh`).
- Location: OK.

### scripts/experiments-route.test.mjs
- Feature: Test — `/api/experiments.json` experiment-axis evaluator route (#2242).
- If removed: npm `test:experiments-route` breaks; CI `ci.yml:273` fails.
- Current: OK.
- Location: OK.

### scripts/local-analyze-eval-run.mjs
- Feature: Host-only two-arm (free-form vs schema-constrained) analyze repair-rate eval runner (#2725), feeding the #2138 down-modelling confidence loop.
- If removed: npm `eval:analyze-repair` breaks; imports from `src/lib/local-analyze-eval.ts` orphaned. Manual/host-only by design; not in CI (intentional — offline eval, not a gate).
- Current: OK — offline/zero-egress claims match the code (scripted endpoint import, no network client).
- Location: OK.

### scripts/model-eval-batch.mjs
- Feature: Model down-shift eval batch-spec generator (#1084) over shadow-calls/replay/curated corpora.
- If removed: npm `eval:model-batch` breaks; only consumer of `buildModelEvalBatchSpec`/`generateEvalBatchesFromClusters` CLI surface (`src/lib/model-eval-batch.ts` keeps its unit tests).
- Current: OK.
- Location: OK.

### scripts/model-eval-run.mjs
- Feature: Structured-edit eval runner (#2296) — offline scoring default, opt-in jailed live run (`CHD_MODEL_EDIT_EVAL=1` via srt).
- If removed: npm `eval:model-edit` breaks; `scripts/structured-edit-arm-run.mjs` documents its `--responses DIR` interop and `src/lib/structured-edit-*` eval modules lose their driver.
- Current: OK — no unjailed fallback claim matches the code (dynamic reuse of shadow-calls sandbox).
- Location: OK.

### scripts/parser-output-versions.fence.test.mjs
- Feature: Test — forward fence for the parser-output → cache-invalidation seam (#2075): recomputes each parser's output-shape fingerprint against `scripts/lib/parser-output-versions.mjs`.
- If removed: npm `test:scripts-parity` (package.json:90) loses the fence; CI `ci.yml:359` weakens — new parser output fields would ship inert again.
- Current: OK — wired via test:scripts-parity in CI.
- Location: OK.

### scripts/proof-batch.mjs
- Feature: v0.4 pre-registered matched-pairs causal-proof batch orchestrator (#1077, epic #995) — jailed control/injected arms, ProofReceipt append.
- If removed: npm `proof:batch` breaks; `src/lib/parse-shadow-calls.ts` and `scripts/ingest.mjs` consume the receipts it appends (data flow, not import).
- Current: OK — depends on `~/.claude/shadow-calls/lib` (documented, host-only by design).
- Location: OK.

### scripts/push-ingest-route.test.mjs
- Feature: Test — push-ingest POST route contract (#1248/#1563): shipper POSTs artifacts, dataset consumes with provenance.
- If removed: npm `test:push-ingest` breaks. FINDING: not wired into CI — `grep -rn "test:push-ingest\b" .github/workflows/` matches nothing (only `test:push-ingest-second-source` runs, ci.yml:387); manual-only. Verified same on origin/master.
- Current: OK apart from CI wiring gap; the second-source e2e's header explicitly leans on this test proving the empty-local-root spine, so the gap is load-bearing.
- Location: OK.

### scripts/push-ingest-second-source-e2e.test.mjs
- Feature: Test — operator-free two-source aggregation e2e (#1647, epic #1563): populated local root + live-POSTed second source coexist in `/api/dataset.json`.
- If removed: npm `test:push-ingest-second-source` breaks; CI `ci.yml:387` fails.
- Current: OK.
- Location: OK.

### scripts/read-workflows-bounds.test.mjs
- Feature: Test — bounds/caps behavior of the workflow-manifest reader `scripts/read-workflows.mjs` (fixture-driven, node:test).
- If removed: nothing breaks. FINDING: completely unwired — no `package.json` script (grep `read-workflows-bounds` in package.json: no hits, also on origin/master), no workflow invocation, not in `npm test`'s glob (`scripts/gate-2702/*.test.mjs` only), and never had one (`git log -S "read-workflows-bounds" -- package.json` is empty).
- Current: FINDING (above) — test content itself looks current.
- Location: OK.

### scripts/read-workflows.mjs
- Feature: Shared reader/projection for Workflow-tool run manifests (#435/#661) — feeds `/api/workflows` (server.mjs, async) and `assembleDataset()` (ingest.mjs, sync).
- If removed: `scripts/server.mjs` `/api/workflows` route and `scripts/ingest.mjs` workflow-health signal path break; `src/lib/references-ingest-parity.test.ts` and `workflow-ratelimit-burst` detector tests fail.
- Current: OK — dual entry-point claim matches consumers.
- Location: OK.

### scripts/recommendations-statusline.mjs
- Feature: One-line recs statusline CLI for Claude Code statusline integration (reads local `/api/recommendations.json`).
- If removed: npm `recs:statusline` breaks; `scripts/recommendations-statusline.test.mjs` imports its exported `buildStatusline`/`parseArgs`.
- Current: OK — loopback-default (127.0.0.1:5173) matches local-first policy.
- Location: OK.

### scripts/recommendations-statusline.test.mjs
- Feature: Test — statusline builder/arg-parsing for recommendations-statusline.mjs.
- If removed: npm `test:recommendations-statusline` breaks. FINDING: not wired into CI — no workflow runs `test:recommendations-statusline` (grep across `.github/workflows/*.yml`: no hits; same on origin/master); manual-only.
- Current: OK apart from CI wiring gap.
- Location: OK.

### scripts/recommendations-surface-route.test.mjs
- Feature: Test — typed `surface=global|reclaim-compass` contract on `/api/recommendations.json` (#2718, epic #2443), incl. legacy byte-compatibility and flag-off zero-egress.
- If removed: npm `test:recommendations-surface` breaks; CI `ci.yml:241` fails.
- Current: OK.
- Location: OK.

### scripts/recommendations-swr-cache.test.mjs
- Feature: Test — two-tier stale-while-revalidate freshness gate on `/api/recommendations.json` (#2184, epic #2181).
- If removed: npm `test:recommendations-swr` breaks; CI `ci.yml:225` fails.
- Current: OK.
- Location: OK.

### scripts/recs-dataset-reuse.test.mjs
- Feature: Test — recs request assembles the ~128 MB dataset once and reuses it (optional `dataset` param, #2071).
- If removed: npm `test:recs-dataset-reuse` breaks; CI `ci.yml:206` fails.
- Current: OK.
- Location: OK.

### scripts/recs-light-dataset.test.mjs
- Feature: Test — `assembleRecommendationDataset()` light assembler byte-identity + no-full-assembly proof (#2182).
- If removed: npm `test:recs-light-dataset` breaks; CI `ci.yml:216` fails.
- Current: OK.
- Location: OK.

### scripts/recs-worker.mjs
- Feature: Off-main-thread recommendations rebuild worker (#2196, epic #2181) — worker-private CHD_DB_PATH, byte-identical output.
- If removed: `scripts/server.mjs` worker spawn path breaks (`CHD_RECS_WORKER` path); `scripts/recs-worker.test.mjs` fails.
- Current: OK.
- Location: OK.

### scripts/recs-worker.test.mjs
- Feature: Test — worker/inline byte-identity + round-trip contract for recs-worker.mjs.
- If removed: npm `test:recs-worker` breaks; CI `ci.yml:254` fails; recommendations-surface-route.test.mjs's header delegates worker byte-equivalence proof here.
- Current: OK.
- Location: OK.

### scripts/reject-suppression-route.test.mjs
- Feature: Test — POST `/api/recommendations/reject` end-to-end suppression: receipt mirror, cache bust, finding removal (#2332, epic #1298).
- If removed: npm `test:reject-suppression` breaks; CI `ci.yml:233` fails — and this test exists specifically to pin a previously-shipped silent no-op regression.
- Current: OK.
- Location: OK.

### scripts/search-digest-cache-route.test.mjs
- Feature: Test — `/api/search` + `/api/digest` wired to the stat-gated single-flight response cache (#1573).
- If removed: npm `test:search-digest-cache` breaks; CI `ci.yml:264` fails.
- Current: OK.
- Location: OK.

### scripts/session-timeline-route.test.mjs
- Feature: Test — lazy per-session timeline detail route (#1285) serving the session_blob timeline with cache validators.
- If removed: npm `test:session-timeline-route` breaks. FINDING: not wired into CI — no workflow runs `test:session-timeline-route` (grep across `.github/workflows/*.yml`: no hits; same on origin/master); manual-only.
- Current: OK apart from CI wiring gap.
- Location: OK.

### scripts/shadow-experiments-route.test.mjs
- Feature: Test — GET `/api/shadow-experiments.json` ledger route with #2149 dispositions, pagination, fail-open (#2152, epic #2147).
- If removed: npm `test:shadow-experiments-route` breaks; CI `ci.yml:281` fails.
- Current: OK.
- Location: OK.

### scripts/signal-descriptor-parity.test.mjs
- Feature: Test — byte-identical parity between the #524 signal descriptor (`makeSessionSignals`) and the frozen pre-refactor inline `ingestOne`/`assembleDataset` logic.
- If removed: npm `test:scripts-parity` (package.json:90) loses a member; CI `ci.yml:359` weakens.
- Current: OK.
- Location: OK.

### scripts/source-routes.test.mjs
- Feature: Test — generic source/harness route aliases (`/api/sources/<id>/…`) as default-source aliases for the raw routes (#1281).
- If removed: npm `test:source-routes` breaks. FINDING: not wired into CI — no workflow runs `test:source-routes` (grep across `.github/workflows/*.yml`: no hits; same on origin/master); manual-only.
- Current: OK apart from CI wiring gap.
- Location: OK.

### scripts/stat-gated-cache.test.mjs
- Feature: Test — route-agnostic stat-gated single-flight cache core (`scripts/lib/stat-gated-cache.mjs`, #1573): single-flight, invalidation, LRU prune.
- If removed: npm `test:stat-gated-cache` breaks; CI `ci.yml:261` fails.
- Current: OK — correctly split (deterministic core here, HTTP wiring in search-digest-cache-route.test.mjs).
- Location: OK.

### scripts/static-serving.test.mjs
- Feature: Test — static shell/cache contract (#1488): hashed assets immutable, missing assets never fall through to the SPA shell.
- If removed: npm `test:static-serving` breaks; CI `ci.yml:165` fails.
- Current: OK.
- Location: OK.

### scripts/structured-edit-arm-run.mjs
- Feature: Host-only free-form vs edit-DSL-constrained structured-edit two-arm runner (#2726), producing dirs re-scoreable by `model-eval-run.mjs --responses`.
- If removed: npm `eval:structured-edit-arm` breaks; `src/lib/structured-edit-arm-eval.ts` loses its CLI driver.
- Current: OK — offline/zero-egress and interop claims match model-eval-run.mjs.
- Location: OK.

### scripts/sync-data.sh
- Feature: Legacy pre-server data sync — symlinks `~/.claude/history.jsonl` and pre-merges session+subagent JSONL into `public/` for the original static dashboard.
- If removed: nothing found — removal candidate. Greps: `grep -rn "sync-data" .github/ package.json scripts/ src/ Dockerfile* docker-compose*.yml docs/` → only `scripts/server.mjs:3865`, a comment calling it "the old sync-data.sh merge"; no npm script, no workflow, no doc. The live flow reads `~/.claude` directly via server.mjs (the `public/history.jsonl` path survives only as the "legacy fallback fetch (unused by the live flow)" in `src/lib/api-client.ts:1332`). Untouched since the two founding commits (8f8af9c6, 1237891f).
- Current: FINDING: superseded by server.mjs live ingest; the script's `public/`-symlink model no longer matches the deployment (container bind-mounts `~/.claude`, doesn't serve from `public/` links).
- Location: N/A if removed; otherwise OK.

### scripts/transcript-cache-parity.test.mjs
- Feature: Test — session_transcript BLOB cache extraction (#627 slice 3, `src/lib/session-cache.ts`): round-trip, zero-rewrite incremental, targeted invalidation.
- If removed: npm `test:transcript-cache` breaks. FINDING: not wired into CI — no workflow runs `test:transcript-cache` (grep across `.github/workflows/*.yml`: no hits; same on origin/master) — despite its own header calling it "the load-bearing data-integrity gate for the extraction" (scripts/transcript-cache-parity.test.mjs:7-8).
- Current: OK apart from CI wiring gap.
- Location: OK.

### scripts/transcript-compression-policy.test.mjs
- Feature: Test — transcript BLOB writes use fast lossless brotli (quality ≤5 + SIZE_HINT, never quality 11) by grepping `scripts/ingest.mjs` source.
- If removed: npm `test:scripts-parity` loses a member; CI `ci.yml:359` weakens.
- Current: OK (regex-on-source style is brittle but the constant `TRANSCRIPT_BROTLI_QUALITY` exists in ingest.mjs).
- Location: OK.

### scripts/ts-resolver.mjs
- Feature: Node ESM resolve hook letting scripts import the project's extensionless `.ts` parser modules; also enforces the runtime-import guard boundary.
- If removed: `scripts/register-ts.mjs` (the `--import` shim used by ~30 npm scripts, server, worker) breaks — effectively every scripts/-side test and the server's .ts imports; `server-runtime-import-guard.test.mjs` and `mcp-shim-isolation.test.mjs` fail.
- Current: OK.
- Location: OK.

### scripts/validate-thinking.mjs
- Feature: One-shot validation harness for the #1927/#2006 thinking-token residual estimator — measures the no-thinking control group over raw local transcripts.
- If removed: nothing found — removal candidate (manual measurement harness). Greps: `grep -rn "validate-thinking" .github/ package.json scripts/ src/ Dockerfile* docker-compose*.yml docs/` → only its own usage comment (scripts/validate-thinking.mjs:7). No npm script, no workflow, no importer; imports flow one-way from `src/lib/thinking-tokens.ts`.
- Current: OK as a manual tool; its measurement (#2006) is done, so it is archive/removal material rather than stale.
- Location: OK (though a spike/ or tools/ dir would separate it from wired scripts).

### scripts/workflow-transcript-merge-parity.test.mjs
- Feature: Test — nested Workflow-tool agent transcripts (`subagents/workflows/<runId>/agent-*.jsonl`) merge into the parent session's token/cost rows (#636): discovery, attribution, idempotence.
- If removed: npm `test:scripts-parity` loses a member; CI `ci.yml:359` weakens.
- Current: OK.
- Location: OK.

### scripts/workflow-transcripts.mjs
- Feature: Single source of truth for the second merge level (#636) — enumerates nested workflow agent transcripts for both merge sites (server.mjs `readMergedSession`, ingest.mjs `listSessions`).
- If removed: `scripts/server.mjs` and `scripts/ingest.mjs` merge paths break (workflow-agent tokens vanish from Tokens/Cost); `workflow-transcript-merge-parity.test.mjs` fails.
- Current: OK — scope-exclusion claims (journal.jsonl, meta.json) match the code.
- Location: OK.

FINDINGS:
1. scripts/daily-digest-route.test.mjs is completely unwired: no package.json script and no CI workflow ever invokes it (vitest covers src/** only; `npm test`'s node --test glob is `scripts/gate-2702/*.test.mjs` only) — the `/api/digest` route contract (#1292) has zero automated coverage of its own. Verified unchanged on origin/master.
2. scripts/read-workflows-bounds.test.mjs is completely unwired: no package.json script (never had one — `git log -S "read-workflows-bounds" -- package.json` empty) and no workflow invocation, so the read-workflows bounds behavior is untested in practice. Verified unchanged on origin/master.
3. scripts/transcript-cache-parity.test.mjs has an npm script (`test:transcript-cache`) but no workflow runs it, despite its own header (lines 7-8) declaring it "the load-bearing data-integrity gate" for the #627 session-cache extraction.
4. scripts/push-ingest-route.test.mjs (`test:push-ingest`) is not run by any workflow — only the second-source e2e (ci.yml:387) runs in CI, and that e2e's header explicitly relies on this route test proving the empty-local-root spine.
5. scripts/source-routes.test.mjs (`test:source-routes`) is not run by any workflow — the #1281 source-alias route contract is manual-only.
6. scripts/session-timeline-route.test.mjs (`test:session-timeline-route`) is not run by any workflow — the #1285 lazy timeline route contract is manual-only.
7. scripts/recommendations-statusline.test.mjs (`test:recommendations-statusline`) is not run by any workflow — the statusline CLI is manual-only tested.
8. scripts/sync-data.sh is dead legacy: nothing consumes it (only reference is a "the old sync-data.sh merge" comment at scripts/server.mjs:3865); its `public/`-symlink serving model was superseded by server.mjs live ingest — removal candidate.
9. scripts/validate-thinking.mjs has no consumers (only its own usage comment); it is a completed one-shot measurement harness for #2006 — archive/removal candidate.


---

## src/lib — non-detectors, part 1 of 2: parsers + dataset + recs-core + sessions + cost (DONE — 2026-07-22)

### — group: parsers-1 (35 files) —

### src/lib/parse-agent-effectiveness.test.ts
- Feature: Vitest coverage for the per-agent-type effectiveness rollup (Agents & Skills view).
- If removed: CI test coverage lost for `computeAgentEffectiveness`/`suggestAgentWorkflows`/`publishAgentTaskSuggestions`; vitest (test.yml) is the consumer.
- Current: OK — imports match the subject's live exports; fixtures built from `parse-tools` types.
- Location: OK (co-located with subject).

### src/lib/parse-agent-effectiveness.ts
- Feature: Agents & Skills view — one effectiveness row per `subagent_type` (artifact rate, no-op rate, cost, follow-ups) from toolData + attribution + agent settings + runtime events.
- If removed: `src/components/AgentSkill.tsx:51` (value import; lazy-loaded via `view-registry.tsx:175`) breaks, i.e. the Agents & Skills view; plus its own test.
- Current: OK — header honestly scopes the heuristics (parent-side follow-up window, no subagent-transcript cross-reference).
- Location: OK.

### src/lib/parse-agents.test.ts
- Feature: Vitest coverage for attribution parsing and agent/skill/MCP aggregation.
- If removed: CI coverage lost for `parseAttribution`, the six aggregate helpers, `parseAgentSettings`, `UNSPECIFIED_BUCKET` semantics.
- Current: OK.
- Location: OK.

### src/lib/parse-agents.ts
- Feature: Native `attribution*`-field parsing (agents/skills/commands/MCP per session) feeding Agents & Skills, Recommendations, and model recommendation.
- If removed: wide breakage — `AgentSkill.tsx`, `parse-model-recommendation.ts`, `config-hygiene.ts`, `parse-agent-effectiveness.ts`, `upload-parse.ts` (SPA upload path), `view-registry.tsx`, `App.tsx`, `DigestSpine.tsx`, `Recommendations.tsx`, `detectors/types.ts`, and server ingest `scripts/session-blob-row.mjs:136`.
- Current: OK — command attribution correctly documented as derived from `<command-name>` markers (#634), not a native field.
- Location: OK.

### src/lib/parse-assistant-features.test.ts
- Feature: Vitest coverage for per-turn assistant-behaviour features (refusal/hedging/code-density counts).
- If removed: CI coverage lost for `parseAssistantFeatures` (null on no assistant turns, marker-per-turn counting).
- Current: OK.
- Location: OK.

### src/lib/parse-assistant-features.ts
- Feature: Numeric per-session assistant-behaviour features (`assistantFeatures` dataset key) consumed by the recs engine's cost/output-verbosity detector.
- If removed: server ingest `scripts/session-blob-row.mjs:122` breaks; `detectors/cost/output-verbosity.ts` loses its `assistantFeatures` dataDep; REFERENCES.md rows (29, 216) and the #541 parity test go stale.
- Current: OK — browser-safe claim (TextEncoder, no node built-ins) verified; the "shipped undocumented" episode cited in `references-ingest-parity.test.ts:9` is historical, now fenced.
- Location: OK.

### src/lib/parse-backups.test.ts
- Feature: Vitest coverage for `~/.claude/backups` snapshot parsing and config-drift diffing.
- If removed: CI coverage lost for `parseBackupsDir`/`diffConfigDrift` (five drift scenarios + global-churn counter), hermetic via temp dirs.
- Current: OK.
- Location: OK.

### src/lib/parse-backups.ts
- Feature: Config-drift audit log from timestamped `~/.claude.json` backups (Permissions view drift panel + `reliability/config-drift` detector).
- If removed: server ingest `scripts/ingest.mjs:2082` breaks; `DriftEvent` type consumers break (`Permissions.tsx:20`, `App.tsx:121`, `DigestSpine.tsx:99`, `Recommendations.tsx:76`, `view-registry.tsx:71`, `sample-artifacts.ts:31`, `detectors/types.ts:44`); `detectors/reliability/config-drift.ts` loses its input shape.
- Current: OK — server-only (node:path + bounded-fs); all SPA-reachable consumers are `import type` only, so the SPA boundary holds.
- Location: OK.

### src/lib/parse-churn-geometry.test.ts
- Feature: Vitest coverage for structured-patch churn geometry (edits, rework distance, post-stop re-edits).
- If removed: CI coverage lost for `parseChurnGeometry` over synthetic tool_use/tool_result JSONL.
- Current: OK.
- Location: OK.

### src/lib/parse-churn-geometry.ts
- Feature: Per-file/per-session edit-churn geometry (gross/net lines, re-edit ranges) for Recommendations churn detectors and digest.
- If removed: `upload-parse.ts:86,148` (SPA upload), `scripts/session-blob-row.mjs:139` (server ingest), `Recommendations.tsx`, `App.tsx`, `DigestSpine.tsx`, `view-registry.tsx`, `detectors/types.ts` break.
- Current: OK — pure, browser-safe, dual-consumed by SPA and ingest as designed.
- Location: OK.

### src/lib/parse-compaction-risk.test.ts
- Feature: Vitest coverage for forward-looking compaction-risk scoring and its exported thresholds.
- If removed: CI coverage lost for `computeCompactionRisk`/`summarizeCompactionRisk` and the threshold constants the UI mirrors.
- Current: OK.
- Location: OK.

### src/lib/parse-compaction-risk.ts
- Feature: Forward-looking compaction-risk score + avoidance suggestions (Context Health view, Session list badges, CompactionPanel).
- If removed: `ContextHealth.tsx:39`, `SessionList.tsx:57`, `recommendations/CompactionPanel.tsx:13`, `Recommendations.tsx` break (all value imports).
- Current: OK — explicitly labels itself heuristic, complements `context-health.ts` (imports its `OVER_WINDOW`).
- Location: OK.

### src/lib/parse-config-attribution.test.ts
- Feature: Vitest coverage for the config-section → behaviour-signature attribution wedge (#892).
- If removed: CI coverage lost for `attributeConfigSections`/`summarizeConfigAttribution`/`DEFAULT_SIGNATURES` (build-command, native-tool, key-file-pin classes).
- Current: OK.
- Location: OK.

### src/lib/parse-config-attribution.ts
- Feature: Repo-map substrate (#871/#892): classifies each config section as attributable/unattributable/unfalsifiable against observed session behaviour, tier-0 only.
- If removed: server ingest `scripts/ingest.mjs:2092` breaks; `parse-repo-map-join.ts:1` loses the `ConfigAttribution` type; #894 recs promotion loses its input.
- Current: OK — evidence-honesty header (correlational, never causal) matches the repo's auditable-claims contract.
- Location: OK.

### src/lib/parse-config-sections.test.ts
- Feature: Vitest coverage for the markdown-config explosion parser (#888).
- If removed: CI coverage lost for `parseConfigSections`/`parseConfigSet`/`countConfigReferences` incl. the no-body-leak privacy assertion.
- Current: OK.
- Location: OK.

### src/lib/parse-config-sections.ts
- Feature: Explodes CLAUDE.md/AGENTS.md/skill manifests into stable-id `ConfigSection` records (heading + hash + typed refs, never the body).
- If removed: `scripts/ingest.mjs:2090`, `parse-config-attribution.ts` (value import), `parse-repo-map-join.ts:2` (type), `atomize-config.test.ts` break.
- Current: OK — pure, string-in; privacy non-goal enforced by test.
- Location: OK.

### src/lib/parse-debug.test.ts
- Feature: Vitest coverage for `~/.claude/debug/*.txt` metrics (TTFB, retry pressure, fast-mode tax).
- If removed: CI coverage lost for `parseDebugDir` fixtures mirroring real debug-log line formats (#569).
- Current: OK.
- Location: OK.

### src/lib/parse-debug.ts
- Feature: Per-session API reliability metrics from debug logs, joined into the Agent Report Card (#572) and review queue.
- If removed: server ingest `scripts/ingest.mjs:2066` breaks; `DebugSessionMetrics` type consumers break (`report-card.ts:37`, `review-queue.ts:5`, `AgentReportCardPf.tsx:37`, `ReviewQueuePf.tsx`, `sample-artifacts.ts:27`, `view-registry.tsx:65`, `detectors/types.ts`).
- Current: OK — SERVER-ONLY warning in header is honored: every client-side import is `import type`.
- Location: OK.

### src/lib/parse-deceit-signals.test.ts
- Feature: Vitest coverage for ingest-time model-deceit claim/evidence correlation (#685).
- If removed: CI coverage lost for `parseDeceitSignals` incl. the five non-firing honest classes (scoped disclosure, stale-but-true, background completion, fail-regex, limitation #1103).
- Current: OK.
- Location: OK.

### src/lib/parse-deceit-signals.ts
- Feature: Numeric per-session `deceitSignals` (unbacked completion claims) feeding the `security/model-deceit` detector and the deceit judge audit.
- If removed: `scripts/session-blob-row.mjs:125` (ingest) breaks; `signals/index.ts`, `detectors/security/model-deceit.ts` dataset dep, `audit/judge-deceit.*` comparisons, `sample-artifacts.ts`, `coverage.ts` break.
- Current: OK — browser-safe as claimed; precision-bar documentation matches the test suite.
- Location: OK.

### src/lib/parse-docs-map.test.ts
- Feature: Vitest coverage for the versioned `docs/docs-map.json` contract (#2709).
- If removed: CI coverage lost for `parseDocsMap` strict whole-map rejection, slug/path validators, and the bound constants.
- Current: OK.
- Location: OK.

### src/lib/parse-docs-map.ts
- Feature: Doc-hygiene epic #2256 — strict, identity-bound validator for the source-binding docs map that the #2489 symbol-drift detector will trust.
- If removed: `scripts/ingest.mjs:743` (readDocsMap wiring) breaks; type/validator consumers in `Recommendations.tsx`, `App.tsx`, `DigestSpine.tsx`, `view-registry.tsx`, `detectors/types.ts`, `docker-docs-runtime.test.ts` break; the `DOCS_MAP_RELPATH` seam constant and its parity fence (`scripts/docs-map-parity.test.mjs`) lose their anchor.
- Current: OK — pure/browser-safe as declared; reject-whole-map contract clearly stated.
- Location: OK.

### src/lib/parse-docs.test.ts
- Feature: Vitest coverage for the repo doc-graph builder (#2257) — link resolution, issue/src refs, frontmatter, declared indices.
- If removed: CI coverage lost for every acceptance bullet of the doc-graph keystone.
- Current: OK.
- Location: OK.

### src/lib/parse-docs.ts
- Feature: SCIP-style graph over repo Markdown docs (`docGraph` on RecommendationInput) for the doc-hygiene detector; declared-index recognition (REFERENCES/ADR/tracker).
- If removed: `scripts/ingest.mjs:696` (buildDocGraph et al.) breaks; `doc-neighborhood.ts`, `doc-neighborhood-inject.ts`, `sample-doc-neighborhood.ts`, `Recommendations.tsx`, `App.tsx`, `view-registry.tsx`, `detectors/types.ts` break.
- Current: OK — SERVER-ONLY header accurate (node:fs/child_process); browser gets types only via `import type`, mirroring parse-tasks/parse-teams.
- Location: OK.

### src/lib/parse-errors.test.ts
- Feature: Vitest coverage for tool-error aggregation, retry-group detection, and native/text API-error parsing.
- If removed: CI coverage lost for `aggregateToolErrors`, `detectRetryGroups`, `parseApiErrors`, status/retry-pressure aggregates, error-retry sequences.
- Current: OK.
- Location: OK.

### src/lib/parse-errors.ts
- Feature: Error/retry telemetry backbone — tool error rates, retry groups, API error events (native + text fallback) for Sessions, Tool Usage, Prompt Analyzer, Recommendations, weekly delta, model-gap mining.
- If removed: the widest blast radius in this group — ~45 consumers including `SessionList.tsx`, `ToolUsage.tsx`, `PromptAnalyzer.tsx`, `Recommendations.tsx`, `AskClaude.tsx`, `ErrorRetry.tsx`, `EvaluatorLanding.tsx`, `upload-parse.ts` (SPA), `live-session.ts`, `session-scorecard.ts`, `weekly-delta.ts`, `model-gap-mining.ts`, `review-queue.ts`, `detectors/types.ts`, and server ingest `scripts/session-blob-row.mjs:133`.
- Current: OK.
- Location: OK.

### src/lib/parse-external-guidance.test.ts
- Feature: Vitest coverage for the external-guidance snapshot reader + re-exported pure core (#1300).
- If removed: CI coverage lost for `readExternalGuidanceSnapshots` (temp-dir hermetic) and the re-exported validators (`isAllowedUrl`, `parseExternalGuidanceSnapshot`, `SOURCE_REGISTRY`).
- Current: OK.
- Location: OK.

### src/lib/parse-external-guidance.ts
- Feature: On-disk external-guidance snapshot-store reader (epic #656); pure core split out to `external-guidance.ts` for the browser engine.
- If removed: server ingest `scripts/ingest.mjs:665` breaks; `recommendations.ts:157` loses the `ParseExternalGuidanceOptions` type re-export; `detectors/types.ts` type import breaks.
- Current: OK — node:fs confined here; `recommendations.ts` (browser-bundled) imports only a type from it, honoring the split the header describes.
- Location: OK — thin server-side shell over `external-guidance.ts` is the intended shape.

### src/lib/parse-file-history.test.ts
- Feature: Vitest coverage for `~/.claude/file-history` churn scoring (pure math + tmp-dir walk).
- If removed: CI coverage lost for `scoreSession`/`parseFileHistoryDir` incl. the never-read-bodies invariant.
- Current: OK.
- Location: OK.

### src/lib/parse-file-history.ts
- Feature: Edit-churn/burst signal from `@v2` pre-edit snapshots (#564) — structural counts only, no file bodies.
- If removed: server ingest `scripts/ingest.mjs:2068` breaks; `FileHistorySession` type consumers break (`App.tsx:115`, `Recommendations.tsx:71`, `DigestSpine.tsx:95`, `view-registry.tsx:67`, `view-scope.ts:23`, `sample-artifacts.ts:28`, `detectors/types.ts:39`).
- Current: OK — server-only (node:fs); all client imports are `import type`.
- Location: OK.

### src/lib/parse-file-reread.test.ts
- Feature: Vitest coverage for the re-read/load-once cost heuristic.
- If removed: CI coverage lost for `parseFileReread`/`aggregateRereadByPath` (token-waste estimate, session-mean fallback, `tokenEstimateSource`).
- Current: OK.
- Location: OK.

### src/lib/parse-file-reread.ts
- Feature: Quantified re-read waste (estimated token cost + time spread) for File Impact, Evaluator landing, live session, repo-map join.
- If removed: `FileImpact.tsx:23`, `EvaluatorLanding.tsx:30`, `live-session.ts:16` (value imports), `parse-repo-map-join.ts:4` (type), and `scripts/ingest.mjs:2094` break.
- Current: OK — the 4-chars/token caveat and fallback semantics are documented and match the implementation.
- Location: OK.

### src/lib/parse-files.test.ts
- Feature: Vitest coverage for file/dir op aggregation (reads/edits/writes, churn, redundant reads).
- If removed: CI coverage lost for `aggregateFiles`, `aggregateDirs`, `readOnlyFiles`, `topChurnFiles`, `redundantReads`.
- Current: OK.
- Location: OK.

### src/lib/parse-files.ts
- Feature: File Impact view primitives — per-file/per-dir operation stats and churn/redundant-read tables.
- If removed: `FileImpact.tsx:19` (value import), `parse-repo-map-join.ts:3` (`ChurnStat` type), `scripts/ingest.mjs:2095` (`topChurnFiles`) break; `parse-file-reread.ts` docstring cross-reference goes dangling.
- Current: OK — small, pure, no staleness.
- Location: OK.

### src/lib/parse-git-outcome.test.ts
- Feature: Vitest coverage for git delivery-outcome classification (#1757) — branch→PR attribution, outcome labels, staleness demotion.
- If removed: CI coverage lost for `buildGitOutcomes`, `classifyPullRequestOutcome`, `attributeBranchToPullRequest`, `isGitOutcomeStale`/`demoteStaleGitOutcome`, `gitOutcomesReposFromEnv`, `GIT_OUTCOME_FRESHNESS_DAYS`.
- Current: OK — imports match the subject's exports; subject exists (`src/lib/parse-git-outcome.ts`). The subject's "SIGNAL ONLY, no user-facing detector yet" header remains accurate: repo-wide, `gitOutcomes` is consumed only by `detectors/types.ts` (input shape), `scripts/ingest.mjs` (fetch/build), and `recommendation-view-data.ts` (listed as a server-only field the client envelope omits) — no detector reads it yet, matching the deferred-to-#1911-child claim. The pure/no-network discipline (gh fetch lives in ingest, gated by `CHD_GIT_OUTCOMES`) matches the repo's opt-in non-local-data rule.
- Location: OK.

FINDINGS: none


### — group: parsers-2 (35 files) —

### src/lib/parse-git-outcome.ts
- Feature: Git delivery-outcome signal (#1757/#1911) — per-session merged/reverted/churn labels grounding the autonomy success proxy on `RecommendationInput.gitOutcomes`.
- If removed: `scripts/ingest.mjs` (the `CHD_GIT_OUTCOMES`-gated ingest join) and `src/lib/detectors/types.ts` (`gitOutcomes?: GitOutcome[]` on `RecommendationInput`, consumed via `src/lib/recommendation-view-data.ts`) break; `parse-git-outcome.test.ts` fails CI.
- Current: OK — header accurately declares "SIGNAL ONLY, no user-facing detector yet" and the pure/no-network discipline holds (types-only imports, PR data injected as argument).
- Location: OK — pure parser under `src/lib/**`, network fetch correctly kept in `scripts/ingest.mjs`.

### src/lib/parse-history.test.ts
- Feature: CI regression coverage for history parsing/grouping (vitest, `test.yml`).
- If removed: regression protection lost for `parseHistoryJsonl`, `groupBySessions`, `groupByProjects`, `groupWorktrees`, `deriveEntriesFromTranscript`, `unionEntries`, `unionHistoryParts` — all verified as current exports of the subject.
- Current: OK — pins jsonl tolerance (skip blank/unparseable lines), session/project/worktree grouping, and history∪transcript union semantics.
- Location: OK.

### src/lib/parse-history.ts
- Feature: Core history ingestion — parses `~/.claude/history.jsonl` and groups entries into sessions/projects/worktree repo groups; feeds most project-level views.
- If removed: wide breakage — `scripts/server.mjs` (dynamic-imports `groupBySessions`/`groupByProjects` at line 282), `scripts/ingest.mjs:602`, `src/App.tsx`, `ProjectBreakdown.tsx`, `CostAttribution.tsx`, `api-client.ts`, `upload-dataset.ts`, `unzip-upload.ts`, `parse-sessions.ts`, `parse-prompt-analysis.ts`, `parse-task-success.ts`, `parse-steering.ts`, `cost-attribution.ts`, `view-scope.ts`, `build-daily-digest.ts`.
- Current: OK — `shortenProject` re-export is explicitly documented as backward-compat (canonical home `./format`).
- Location: OK — this is the hub parser named in REFERENCES.md's history mapping.

### src/lib/parse-last-update.test.ts
- Feature: CI regression coverage for CLI self-update outcome analysis.
- If removed: coverage lost for `parseLastUpdate`/`analyzeUpdateHealth` (both current exports); fixtures mirror `proto/539-last-update` snapshots.
- Current: OK — pins success/failure classification over 1..N result arrays.
- Location: OK.

### src/lib/parse-last-update.ts
- Feature: `.last-update-result.json` parser → CLI self-update health signal (#566) surfaced in Recommendations/DigestSpine.
- If removed: `scripts/ingest.mjs:2079` (`parseLastUpdate`, wraps single result in a 1-element array at line 4176 exactly as the header documents), `App.tsx`, `Recommendations.tsx`, `DigestSpine.tsx`, `view-registry.tsx`, `upload-artifacts.ts`, `sample-artifacts.ts`, `detectors/types.ts` break.
- Current: OK — the "snapshot history is a FUTURE ENHANCEMENT; today ingest reads once and wraps" note matches ingest.mjs:4176-4177 exactly.
- Location: OK.

### src/lib/parse-local-calibration-producer-contract.test.ts
- Feature: Producer↔consumer contract pin — the dashboard reader must consume the versioned shadow-calls calibration receipt byte-shape without dropping/coercing fields (#2317/#2318 cross-repo contract).
- If removed: the cross-repo drift guard is lost — a producer field rename in `~/.claude/shadow-calls/lib/calibration-report.mjs` would silently zero the Tier B signal. Fixture `fixtures/contracts/calibration-report-v1.pass.json` exists.
- Current: OK.
- Location: OK — contract test co-located with the reader, fixture under `fixtures/contracts/`.

### src/lib/parse-local-calibration.test.ts
- Feature: CI regression coverage for the Tier B calibration reader.
- If removed: coverage lost for `parseLocalCalibration`, `parseCalibrationClass`, `LOCAL_CALIBRATION_FRESHNESS_DAYS` (incl. the cross-check against `DOWN_MODEL_PROOF_FRESHNESS_DAYS` keeping the two freshness constants aligned).
- Current: OK.
- Location: OK.

### src/lib/parse-local-calibration.ts
- Feature: Tier B per-task-class local-model calibration reader (#2318, epic #2177) — pass/fail/insufficient verdicts for the `cost.local-downroute` detector.
- If removed: `scripts/ingest.mjs:682` (`readLocalCalibration`), `src/lib/detectors/types.ts`, and `local-calibration-wiring.test.ts` break.
- Current: OK — verdict discipline (insufficient-by-default, parity-gated pass) and pure text-in contract match the tests and ingest wiring.
- Location: OK.

### src/lib/parse-mcp-auth.test.ts
- Feature: CI regression coverage for the MCP re-auth pre-flight signal.
- If removed: coverage lost for `parseMcpAuthCache`/`classifyAuthServers` fail-open behavior (`{}`, empty, malformed JSON → clear state).
- Current: OK.
- Location: OK.

### src/lib/parse-mcp-auth.ts
- Feature: `mcp-needs-auth-cache.json` parser (#567, epic #539) — flags MCP servers needing interactive OAuth so unattended runs don't burn tokens on failing tool calls.
- If removed: `scripts/ingest.mjs:2080`, `App.tsx`, `Recommendations.tsx`, `DigestSpine.tsx`, `view-registry.tsx`, `upload-artifacts.ts`, `sample-artifacts.ts`, `detectors/types.ts` break.
- Current: OK — pure text-in, malformed-JSON → empty state as documented.
- Location: OK.

### src/lib/parse-memories.test.ts
- Feature: CI regression coverage for memory-file/frontmatter/index parsing.
- If removed: coverage lost for `parseMemoryFile`, `parseMemories`, `parseMemoryIndex`, `buildMemoryStores`, `countMemories`, `projectPathToSlug`, `memoriesMatchProject` — all current exports.
- Current: OK — pins frontmatter tolerance (name falls back to filename, type to `'other'`).
- Location: OK.

### src/lib/parse-memories.ts
- Feature: Per-project agent-memory parsing (#458) — Memories view, memory-hygiene detectors (#2233 family), sample/upload paths.
- If removed: `scripts/ingest.mjs:671` (`buildMemoryStores`), server route `/api/memories` consumers via `api-client.ts:784`, `Memories.tsx`, `App.tsx`, `view-registry.tsx`, `upload-dataset.ts`, `unzip-upload.ts`, `sample-memories.ts`, `api-client.spa.ts`, `detectors/types.ts` break.
- Current: OK — "server returns raw markdown, this module owns parsing" matches server.mjs:10466-10470.
- Location: OK — browser-safe (no node imports), correctly SPA-reachable.

### src/lib/parse-model-recommendation.test.ts
- Feature: CI regression coverage for the per-turn cheaper-model recommender.
- If removed: coverage lost for `computeModelRecommendations`, `summarizeModelRecommendations`, `estimateMonthlySavings` and the `REC_HAIKU/REC_SONNET/REC_OPUS` targets.
- Current: OK.
- Location: OK.

### src/lib/parse-model-recommendation.ts
- Feature: Per-turn trivial/moderate/complex bucketing → cheapest-capable-model recommendation + savings estimate (ModelPanel in Recommendations).
- If removed: `components/recommendations/ModelPanel.tsx` and `components/Recommendations.tsx` break.
- Current: OK — header bucket targets ("moderate → claude-sonnet-5") match `CURRENT_MODEL_IDS.sonnet = 'claude-sonnet-5'` in `model-registry.ts:40` after the Sonnet 5 promotion; targets are registry-derived, not hardcoded.
- Location: OK.

### src/lib/parse-permission-data.ts
- Feature: Browser-safe permission-mode extraction pass for the SPA upload worker.
- If removed: `upload-parse.ts` (upload worker) and `parse-permissions.ts` (which re-exports it for legacy importers) break.
- Current: OK.
- Location: OK — deliberately split out as a small leaf so the upload worker avoids pulling the 2461-line `parse-permissions.ts`; good precedent for similar splits.

### src/lib/parse-permissions.test.ts
- Feature: CI regression coverage for permission modes, dangerous-command detection, safety scores, and shell-decomposition helpers.
- If removed: coverage lost for `parsePermissionData` (via re-export), `aggregatePermissionModes`, `detectDangerousCommands`, `computeSafetyScores`, `rankPromptProneTools`, and the shell segment/skeleton/heredoc analyzers.
- Current: OK.
- Location: OK.

### src/lib/parse-permissions.ts
- Feature: Permissions/safety surface — mode stats, dangerous-command + risky-action classification feeding the Permissions view, session scorecard, and Policy Builder.
- If removed: `scripts/server.mjs:299` (dynamic-imports `aggregatePermissionModes`/`computeSafetyScores`/`detectDangerousCommands`), `Permissions.tsx`, `App.tsx`, `view-registry.tsx`, `parse-tools.ts`, `parse-policy.ts`, `session-scorecard.ts` break.
- Current: OK — the `parse-tools-types` leaf-import cycle note (#1582) matches the actual imports at lines 1-6.
- Location: OK, though at 2461 lines it is the group's strongest split candidate (the `parse-permission-data` extraction shows the pattern).

### src/lib/parse-plans.test.ts
- Feature: CI regression coverage for plan-signature extraction and k-means shape clustering.
- If removed: coverage lost for `parsePlanMarkdown`, `parsePlansDir` (tmpdir round-trip), `clusterPlans`.
- Current: OK.
- Location: OK.

### src/lib/parse-plans.ts
- Feature: Saved plan-mode document shapes (#565) — 4-feature structural signatures + deterministic k=3 clustering for PlanShapesPf.
- If removed: `scripts/ingest.mjs:2069` (`parsePlansDir`), `PlanShapesPf.tsx` (`clusterPlans` value import), and type importers `App.tsx`, `DigestSpine.tsx`, `Recommendations.tsx`, `view-registry.tsx`, `sample-artifacts.ts`, `detectors/types.ts` break.
- Current: OK — structure-only/no-prose extraction claim matches the exported signature shape.
- Location: OK with a note: the module mixes a `node:fs` dir walker (`parsePlansDir`, ingest-only) with the browser-consumed `clusterPlans` in one file; the SPA bundle relies on tree-shaking dropping the fs import (verified by the CI SPA build passing), but splitting the fs half out (à la `parse-permission-data`) would make the boundary structural instead of tree-shake-dependent.

### src/lib/parse-policy.test.ts
- Feature: CI regression coverage for Policy Builder candidate seeding and settings-diff rendering.
- If removed: coverage lost for `buildPolicyCandidates`, `computePolicyDiff`, `policyDiffToSnippet`.
- Current: OK.
- Location: OK.

### src/lib/parse-policy.ts
- Feature: Policy Builder (#133) — turns dangerous-command/friction evidence into deny/ask/allow candidates and a copy-pasteable `settings.json` diff.
- If removed: `PolicyBuilder.tsx` and `Permissions.tsx` break.
- Current: OK — the #2719 note (import `BASH_SAFE_ALLOW_RULES` from the detector-free `detectors/shared` leaf, not the recommendations barrel) matches line 416 and keeps the detector catalog out of the browser bundle.
- Location: OK.

### src/lib/parse-prompt-analysis.test.ts
- Feature: CI regression coverage for prompt-quality scoring.
- If removed: coverage lost for `parsePromptAnalysis` (specificity/imperative/hedging/constraint heuristics).
- Current: OK.
- Location: OK.

### src/lib/parse-prompt-analysis.ts
- Feature: Per-session prompt-quality features (specificity, hedging, constraints, questions/imperatives) from history entries.
- If removed: `scripts/ingest.mjs:604` and `src/App.tsx` break; `sample-corpus.test.ts` fails.
- Current: OK.
- Location: OK — correctly reuses `isRealHumanTurn` from `parse-history` rather than duplicating the turn filter.

### src/lib/parse-repo-map-join.test.ts
- Feature: CI regression coverage for the repo-map ⨯ session-evidence join.
- If removed: coverage lost for `buildRepoMapDataset` (reread/churn/config-section/recommendation joins onto repo-map files).
- Current: OK.
- Location: OK.

### src/lib/parse-repo-map-join.ts
- Feature: Joins host-generated repo-map artifacts with reread/churn/config-attribution evidence — powers the repo-map context-waste view and Ask Claude context.
- If removed: `scripts/ingest.mjs:2096`, `claude-context.ts`, `AskClaude.tsx`, `App.tsx`, `Recommendations.tsx`, `DigestSpine.tsx`, `view-registry.tsx`, `sample-artifacts.ts`, `detectors/types.ts` break.
- Current: OK — the #2709 `owner/repo` identity note matches the exported `RepoMapProjectJoin` shape.
- Location: OK.

### src/lib/parse-runtime-events.test.ts
- Feature: CI regression coverage for native `type:"system"` telemetry parsing.
- If removed: coverage lost for `parseRuntimeEvents`, `aggregateTurnLatency`, `aggregateStopHooks`, `collectAutomationFeed`, `IDLE_TURN_THRESHOLD_MS`.
- Current: OK.
- Location: OK.

### src/lib/parse-runtime-events.ts
- Feature: Measured per-turn latency, stop-hook overhead, AFK/scheduled-wakeup feeds (turn_duration / stop_hook_summary / away_summary / scheduled_task_fire).
- If removed: broad breakage — `signals/index.ts` registry, `scripts/session-blob-row.mjs:138`, `upload-parse.ts`, `live-session.ts`, `parse-agent-effectiveness.ts`, `parse-task-success.ts`, plus `SessionList/SessionPatterns/EvaluatorLanding/AgentSkill/Recommendations/DigestSpine` components.
- Current: OK — the empirically-measured caveats (hookInfos carry no name/id; durationMs on ~7% of entries) are dated evidence presented as measurements with issue refs (#261/#134), not stale present-tense claims.
- Location: OK.

### src/lib/parse-secrets-at-rest.test.ts
- Feature: CI regression coverage for the secrets-at-rest signal, using shape-only fake credentials.
- If removed: coverage lost for `parseSecretsAtRest` — including the security invariant that no matched value/snippet is ever stored and the benign-high-entropy (git SHA) non-fire case.
- Current: OK.
- Location: OK.

### src/lib/parse-secrets-at-rest.ts
- Feature: `security.secrets-at-rest` ingest signal (#2504, epic #2199) — counts secret-shaped values in prompts/tool_results with EvidenceRef coordinates only.
- If removed: `signals/index.ts` parser registry (lines 97/260) and `scripts/session-blob-row.mjs:127` break; type importers `App.tsx`, `Recommendations.tsx`, `DigestSpine.tsx`, `view-registry.tsx`, `detectors/types.ts` break.
- Current: OK — reuses the shared `SECRET_PATTERNS` (no parallel regex set) and the never-store-values invariant is structurally true of the returned shape.
- Location: OK.

### src/lib/parse-session-registry.test.ts
- Feature: CI regression coverage for the live process-registry parser.
- If removed: coverage lost for `analyzeAttribution`/`parseSessionRegistryDir` — the committed/split/low-signal thresholds and the critical kind≠entrypoint anomaly (`sdk-cli` reporting `kind:"interactive"`).
- Current: OK — header invariants match the subject's documented caveat.
- Location: OK.

### src/lib/parse-session-registry.ts
- Feature: `~/.claude/sessions/<pid>.json` process-registry parser + interactive-vs-automation attribution (#561 → Agent Report Card #572).
- If removed: `scripts/ingest.mjs:2060/4005` (`parseSessionRegistryDir`) and `report-card.ts:333` (`analyzeAttribution`) break; type importers `App.tsx`, `AgentReportCardPf.tsx`, `view-scope.ts`, `view-registry.tsx` break.
- Current: OK — the "key on entrypoint, never kind" caveat is still the load-bearing rule the tests pin.
- Location: OK — `node:fs` half (`parseSessionRegistryDir`) is ingest-only; browser consumers take only types + the pure `analyzeAttribution`, tree-shaking drops the fs import (same accepted pattern as parse-plans).

### src/lib/parse-sessions.context-composition.test.ts
- Feature: CI regression coverage for #1926 per-turn input-context composition (contextHistoryTokens / contextToolResultTokens accumulated in transcript order).
- If removed: the context-composition apportionment contract on `parseSessionJsonl` loses its pin.
- Current: OK.
- Location: OK — reasonable as a separate focused file beside the main `parse-sessions.test.ts`.

### src/lib/parse-sessions.test.ts
- Feature: CI regression coverage for transcript token/cost parsing.
- If removed: coverage lost for `parseSessionJsonl`/`estimateCost` — including the #234 regression (message as JSON-encoded string vs object) and null-model handling.
- Current: OK.
- Location: OK.

### src/lib/parse-sessions.ts
- Feature: The token/cost backbone — parses transcript JSONL into `SessionTokenData` (usage, model, entrypoint, compaction, opener, context composition) for nearly every cost/usage surface.
- If removed: massive breakage — `scripts/server.mjs:290` (dynamic-imports `estimateCost`/`isUnattendedEntrypoint`; the `/api` daily-digest and opener paths at server.mjs:1801 depend on its output), plus `SessionList`, `SessionTimeline`, `TokenUsage`, `CostAttribution`, `Permissions`, `AutomationView`, `DigestSpine`, `ExperimentSegment` components and `summary.ts`, `report-card.ts`, `live-session.ts`, `session-overview.ts`, `session-summaries.ts`, `session-scorecard.ts`, `automation-runs.ts`, `model-pin-savings.ts`, `cost-attribution.ts`, `detectors/shared.ts`.
- Current: OK — entrypoint taxonomy note (`cli`/`sdk-cli`/`sdk-py`, no `cron`, #291) and the density-estimate caveats are accurate and hedged as reconstructions.
- Location: OK. Reminder from memory (not a defect): output-shape changes here are inert until the parser-version knob is bumped.

### src/lib/parse-shadow-calls.test.ts
- Feature: CI regression coverage for the shadow-calls ledger aggregation (epic #513, #518/#523/#2149/#2150).
- If removed: coverage lost for a wide export surface — `parseShadowCalls`, `classifyExperimentSource`, `parseProofReceiptCells`, `mergeExternalSourceCells`, the delta helpers, config-scoping evidence, and the `counted + synthetic + skipped === total` accounting invariant; it also integration-tests `buildRecommendations` over ledger input. Subject `src/lib/parse-shadow-calls.ts` exists (1681 lines) and all imported names are current exports.
- Current: OK.
- Location: OK.

FINDINGS: none


### — group: parsers-3 (35 files) —

### src/lib/parse-shadow-calls.ts
- Feature: Shadow-calls experiment ledger aggregation (epic #513/#2147) — per-axis win rates for the Shadow Calls PF view and shadow-axis recommendations.
- If removed: `ShadowCallsPf.tsx`, `shadow-experiments.ts`, detectors `workflow/shadow-axis-wins.ts`, `workflow/uncovered-shadow-axis.ts`, `workflow/shadow-prompt.ts`, `context/over-scoped-config-section.ts`, `detectors/types.ts`, `sample-artifacts.ts`, `view-registry.tsx`, `App.tsx`, `DigestSpine.tsx`, `Recommendations.tsx`, and `scripts/ingest.mjs` all break.
- Current: OK — header's counting-transparency invariant (`counted + synthetic + skipped === total`, #2149) and source taxonomy (#2150) match the code; pure text-in, no node imports despite ledger living on disk.
- Location: OK (1,681 lines — large but cohesive: one artifact, one aggregate).

### src/lib/parse-stats-cache.test.ts
- Feature: Vitest coverage (CI `test` job) pinning `parseStatsCache` shape validation and the `analyzeActivityTrend` week-over-week verdict against fixtures mirroring the real `stats-cache.json` artifact.
- If removed: CI loses the WoW-trend regression net for the UsagePulse sparkline and `activity.activity-trend` detector input.
- Current: OK — imports match subject exports.
- Location: OK.

### src/lib/parse-stats-cache.ts
- Feature: `~/.claude/stats-cache.json` daily-activity rollup — UsagePulse PF sparkline + `activity.activity-trend` detector (#563).
- If removed: `UsagePulsePf.tsx`, `detectors/activity/activity-trend.ts`, `build-daily-digest.ts`, `upload-artifacts.ts`, `sample-artifacts.ts`, `detectors/types.ts`, `view-registry.tsx`, `App.tsx`, `DigestSpine.tsx`, `Recommendations.tsx`, `scripts/ingest.mjs` break.
- Current: FINDING: header at `src/lib/parse-stats-cache.ts:11` claims "Server-only: YES … not available in SPA mode", but `parseStatsCache` is value-imported by `src/lib/upload-artifacts.ts:6` (reached from `upload-dataset.ts`, the SPA upload path) — the parser is pure and DOES run in SPA mode on uploaded artifacts; only the live file read is server-side. Stale claim.
- Location: OK.

### src/lib/parse-steer-telemetry.test.ts
- Feature: Vitest coverage pinning `sanitizeSteerRecord` bounds, `parseSteerTelemetryLines` line tolerance, `aggregateSteerTelemetry` per-rule rollup, and `readSteerTelemetry` missing-file fail-open (tmp-dir fs tests).
- If removed: no regression net for the /api/steer-telemetry rollup contract.
- Current: OK — imports match subject exports.
- Location: OK.

### src/lib/parse-steer-telemetry.ts
- Feature: PreToolUse-steer delivery/outcome log reader (#2203, epic #1868) feeding `GET /api/steer-telemetry` for the AdoptionScorecard panel.
- If removed: `scripts/server.mjs` breaks (dynamic tsx import at server.mjs:205; route wiring at :5820/:9029/:10391) and the AdoptionScorecard steer panel loses its data. No src/ value importer by design — browser side uses the node-free `steer-telemetry-types.ts` split.
- Current: OK — the node-fs/pure split described in the header is real and correct.
- Location: OK.

### src/lib/parse-steering-divergence.test.ts
- Feature: Precision/recall harness (#1751) pinning `extractTaskSteeringFromTranscript` + `isStructuralCorrective` (from `parse-steering.ts`) against the labeled `__fixtures__/steering-anchor-fixture`.
- If removed: the corrective-classifier accuracy floor for the autonomy axis (#1266) is no longer enforced in CI.
- Current: OK — imports match `parse-steering.ts` exports.
- Location: Note: there is no `parse-steering-divergence.ts` — the name implies a missing subject module; it is really a second test file for `parse-steering.ts`. Harmless but mildly misleading.

### src/lib/parse-steering.test.ts
- Feature: Vitest coverage pinning `classifySteeringTurn` (corrective/clarifying/approving) and `extractTaskSteeringFromTranscript` span extraction.
- If removed: no unit net for the steering-turn taxonomy used by autonomy detectors.
- Current: OK.
- Location: OK.

### src/lib/parse-steering.ts
- Feature: Per-task human-steering classification + steering-divergence rate (#1751, autonomy axis #1266) — ExperimentSegment view and autonomy detectors.
- If removed: `ExperimentSegment.tsx`, detectors `workflow/autonomy-over-steered.ts`, `workflow/human-input-leverage.ts`, `detectors/types.ts`, `view-registry.tsx`, `App.tsx`, `DigestSpine.tsx`, `Recommendations.tsx`, and `scripts/ingest.mjs:605` (`computeTaskSteering`) break.
- Current: OK.
- Location: OK.

### src/lib/parse-task-success.test.ts
- Feature: Vitest coverage pinning `classifyHumanTaskVerdict`, `classifyAgentClosingClaim`, `computeTaskSuccess`, `parseTaskSuccess` — the accept/correct/neutral task-outcome proxy.
- If removed: no regression net for the task-success verdict grammar consumed by the digest and autonomy detectors.
- Current: OK.
- Location: OK.

### src/lib/parse-task-success.ts
- Feature: Heuristic per-task success proxy (human verdict × agent closing claim, with recurrence demotion) feeding the daily digest and autonomy detectors.
- If removed: `build-daily-digest.ts`, `detectors/workflow/autonomy-over-steered.ts`, `detectors/types.ts`, `view-registry.tsx`, `App.tsx`, `DigestSpine.tsx`, `Recommendations.tsx` break.
- Current: OK.
- Location: OK.

### src/lib/parse-tasks.test.ts
- Feature: Vitest coverage pinning `parseTasksDir` (real-fs via tmp dir) and `summarizeTasks` against fixtures shaped like `~/.claude/tasks/<sessionId>/<n>.json` (#559).
- If removed: no net for the tasks-artifact shape assumptions.
- Current: OK.
- Location: OK.

### src/lib/parse-tasks.ts
- Feature: `~/.claude/tasks/` parser + session summaries — Task Health and Team Coordination PF views, task-pileup detectors (#559).
- If removed: `TaskHealthPf.tsx`, `TeamCoordinationPf.tsx`, `team-coordination-context.ts`, detectors `workflow/abandoned-tasks.ts`, `workflow/blocked-task-pileup.ts`, `workflow/owner-concentration.ts`, `detectors/types.ts`, `sample-artifacts.ts`, `view-registry.tsx`, `App.tsx`, `DigestSpine.tsx`, `Recommendations.tsx`, `scripts/ingest.mjs:2058` break.
- Current: FINDING: header at `src/lib/parse-tasks.ts:12` says "SERVER-ONLY: uses node:fs … never import this in browser code", but `src/components/TaskHealthPf.tsx:36-41` value-imports `summarizeTasks` + `COLD_DAYS` from it in the browser bundle. It only works because Vite externalizes `node:fs` to a stub; the stated contract is violated. Either split the pure `summarizeTasks`/types into a browser-safe leaf (the `parse-teams.ts` type-only pattern) or fix the comment.
- Location: See finding — the pure summarize half arguably belongs in a node-free sibling module.

### src/lib/parse-teams.test.ts
- Feature: Vitest coverage pinning `parseTeamsDir`/`analyzeTeams` against inline fixtures shaped like `~/.claude/teams/<id>/inboxes/<agent>.json` (#560).
- If removed: no net for the teams-inbox artifact contract.
- Current: OK.
- Location: OK.

### src/lib/parse-teams.ts
- Feature: Teams inbox ingest (`task_assignment` payloads) — Team Coordination view + `reliability.dropped-assignments` detector (#560).
- If removed: `scripts/ingest.mjs:2059`, `detectors/reliability/dropped-assignments.ts`, `detectors/types.ts`, `sample-artifacts.ts`, `view-registry.tsx` break; `TeamCoordinationPf.tsx` loses its `TeamSummary` type.
- Current: OK — its "never imported by SPA/components" claim holds: all component/detector imports are `import type` (erased), only ingest value-imports it.
- Location: OK.

### src/lib/parse-telemetry.test.ts
- Feature: Vitest coverage pinning `parseTelemetryDir`/`analyzeReliability` (and the latency path) against base64-metadata fixtures shaped like `~/.claude/telemetry/1p_failed_events*.json` (#562), including secret-dropping.
- If removed: no net for the telemetry decode + secret-scrub contract.
- Current: OK.
- Location: OK.

### src/lib/parse-telemetry.ts
- Feature: CLI internal-telemetry reader — Agent Report Card reliability metrics (#572) and per-model latency samples (#1166) for `speed.model-latency`.
- If removed: `report-card.ts`, `review-queue.ts`, `detectors/speed/model-latency.ts`, `AgentReportCardPf.tsx`, `ReviewQueuePf.tsx`, `detectors/types.ts`, `sample-artifacts.ts`, `view-scope.ts`, `view-registry.tsx`, `scripts/ingest.mjs:2064` break.
- Current: FINDING: header is stale — `src/lib/parse-telemetry.ts:22` says `aggregateModelLatency` has "no detector yet, #915" and `:25` calls #915 "deferred", but the detector exists and consumes it (`src/lib/detectors/speed/model-latency.ts:3-6` imports `aggregateModelLatency`; its own header says "#915 … shipped under ADR 0006 gating"). Line 24's "NO detector, NO view" is likewise no longer true.
- Location: OK.

### src/lib/parse-timeline-success.test.ts
- Feature: Vitest coverage pinning `clusterTimelinesByShape`, `describeSignature`, `analyzeHabitImpact`, `computeSessionOutcomes` — the shape→outcome clustering contract.
- If removed: no net for the session-outcome scoring reused by server.mjs rollups (server.mjs:305, :1643).
- Current: OK.
- Location: OK.

### src/lib/parse-timeline-success.ts
- Feature: Timeline-shape → outcome correlation (clusters + per-session outcome tags) for Session Patterns, scorecards, and the review queue.
- If removed: `SessionPatterns.tsx`, `SessionList.tsx`, `build-daily-digest.ts`, `review-queue.ts`, `session-scorecard.ts`, `detectors/workflow/harmful-habit.ts`, and `scripts/server.mjs:305` (dynamic import; outcome rollups) break.
- Current: OK — header is honest about association-not-causation.
- Location: OK.

### src/lib/parse-timeline.test.ts
- Feature: Vitest coverage pinning `parseSessionTimeline`, `slimSessionTimeline`, `isBackgroundableBashCommand`, plus the BFC-collection interop with `experiments/conversational-availability-metric`.
- If removed: the widest-blast-radius parser in the repo loses its direct unit net.
- Current: OK.
- Location: OK.

### src/lib/parse-timeline.ts
- Feature: Core per-session timeline parser (entry kinds, session dimensions, wait-class classification #1873/#1880) — the substrate for the Session Timeline view and most detectors.
- If removed: catastrophic — ~80 importers including `SessionTimeline.tsx`, `SessionList.tsx`, `PromptAnalyzer.tsx`, `AskClaude.tsx`, `api-client.ts`/`api-client.spa.ts` (type), `upload-parse.ts`, `evidence.ts`, `forensic-graph.ts`, `session-scorecard.ts`, dozens of detectors (`ghost-session`, `serial-tool-gap`, `reclaim-wait-windows`, `mid-turn-interrupt-steering`, …), and `scripts/ingest.mjs:592`.
- Current: OK — pure (`parse-utils` only), no `/api/` literals or node imports, so SPA reachability is clean.
- Location: OK.

### src/lib/parse-titles.test.ts
- Feature: Vitest coverage pinning `parseSessionTitles`: ai-title vs custom-title precedence and last-non-empty-wins.
- If removed: no net for the title-precedence contract used at ingest.
- Current: OK.
- Location: OK.

### src/lib/parse-titles.ts
- Feature: Session title extraction (`ai-title`/`custom-title` lines → `sessionId → title` map) feeding `Session.title` at ingest.
- If removed: `scripts/session-blob-row.mjs:143/:272` (the blob-row builder used by `scripts/ingest.mjs:2184` and `cold-ingest-worker.mjs`) breaks — session titles vanish from SessionList/summaries. No direct src/ importer (session-summaries.ts references it only in a comment); greps: `grep -rn parseSessionTitles src scripts` → only session-blob-row.mjs. Thin but live.
- Current: OK.
- Location: OK.

### src/lib/parse-tool-effectiveness.test.ts
- Feature: Vitest coverage pinning `computeToolEffectiveness` — error/retry/undo/progress signal windows and Laplace smoothing.
- If removed: no net for the effectiveness heuristic thresholds.
- Current: OK.
- Location: OK.

### src/lib/parse-tool-effectiveness.ts
- Feature: Per-tool usefulness-vs-noise proxy (error/retry/undo vs forward motion) — ToolUsage view table + effectiveness detectors.
- If removed: `ToolUsage.tsx`, `claude-context.ts`, detectors `workflow/low-tool-effectiveness.ts` and `workflow/tool-undo-rate.ts` break.
- Current: OK — clearly labeled heuristic/directional.
- Location: OK.

### src/lib/parse-tool-inventory.test.ts
- Feature: Vitest coverage pinning `parseToolInventory`/`aggregateInventory` against `deferred_tools_delta` + `skill_listing` attachment fixtures.
- If removed: no net for the catalog-utilization reconstruction.
- Current: OK.
- Location: OK.

### src/lib/parse-tool-inventory.ts
- Feature: Per-session tool-catalog utilization (available vs invoked MCP/deferred tools + skills) — ToolUsage view + MCP-cost detectors.
- If removed: `ToolUsage.tsx`, detectors `context/mcp-schema-tax.ts`, `cost/idle-mcp-tools.ts`, `detectors/types.ts`, `upload-parse.ts`, `view-registry.tsx`, `App.tsx`, `DigestSpine.tsx`, `Recommendations.tsx` break.
- Current: OK.
- Location: OK.

### src/lib/parse-tools-types.ts
- Feature: Dependency-free leaf type module (#1582) breaking the `parse-tools` ↔ `parse-permissions` madge cycle (`DangerousCommandCertainty`, `BypassCategory`, `DurableCommandKind`, …).
- If removed: `parse-tools.ts`, `parse-permissions.ts`, and `detectors/cost/edit-format-churn.ts` break; the runtime-erased import cycle returns.
- Current: OK — imports nothing, as its header promises.
- Location: OK.

### src/lib/parse-tools.test.ts
- Feature: Vitest coverage pinning the whole `parse-tools` public surface: `parseToolUsage`, `aggregateTools`, bash stats, `repeatedCommands`, `nativeToolBypass`, `mineCorrections`, `classifyDurableCommand`, `deriveBashCommandSignals`, ….
- If removed: the repo's single largest analysis module loses its direct net.
- Current: OK — imports match live exports.
- Location: OK.

### src/lib/parse-tools.ts
- Feature: Core tool-call parsing plus a family of analyses (bash command stats, native-bypass, correction mining, durable-command classification, input distillation) — powers ToolUsage, cost attribution, and ~40 detectors.
- If removed: catastrophic — ~120 importers across components (`ToolUsage`, `CostAttribution`, `Permissions`, `SessionList`, …), both api-clients (type), `upload-parse.ts`, `cost-attribution.ts`, most detector categories, and sibling parsers (`parse-sessions`, `parse-permissions`, `parse-timeline-success`, …).
- Current: OK — pure (parse-utils + parse-tools-types + parse-permissions values), no node/`/api/` content, so its SPA reachability is legitimate.
- Location: OK as a path, but at 4,902 lines it is a parser + multi-analyzer grab-bag; the #1582 leaf split shows the tangle is known — further analyzer extraction (corrections mining, bypass, durable-command) is the obvious next seam. Not filed as a defect.

### src/lib/parse-utils.test.ts
- Feature: Vitest coverage pinning `parseMessage` (object/JSON-string/garbage), `summarize`, and the `MAX_SUMMARY` cap.
- If removed: no net for the wire-format assumptions every parser shares.
- Current: OK.
- Location: OK.

### src/lib/parse-utils.ts
- Feature: Shared JSONL scaffolding (`parseJsonl`, `parseMessage`, `summarize`, `RawSessionEntry`, `parseDateMs`) — the one place the transcript wire format is assumed.
- If removed: 16 sibling parsers break (`parse-sessions`, `parse-timeline`, `parse-tools`, `parse-history`, `parse-teams`, `parse-titles`, `parse-value-flow`, …).
- Current: OK.
- Location: OK.

### src/lib/parse-value-flow.test.ts
- Feature: Vitest coverage pinning `parseValueFlow` — distinctive-value reuse edges between tool uses from assistant/user transcript lines.
- If removed: no net for the forensic-graph edge derivation.
- Current: OK.
- Location: OK.

### src/lib/parse-value-flow.ts
- Feature: Value-flow edges/hypotheses (#2108 slim edges) between tool calls — the forensic overlay on the Session Timeline.
- If removed: `forensic-graph.ts`, `SessionTimeline.tsx`, `upload-parse.ts`, `detectors/types.ts`, `view-registry.tsx`, `App.tsx`, `DigestSpine.tsx`, `Recommendations.tsx` break.
- Current: OK — the #2108 slimming rationale in the header matches the exported `ValueFlowEdge` shape.
- Location: OK.

### src/lib/parse-workflows.test.ts
- Feature: Vitest coverage pinning `parseWorkflows`/`parseWorkflowRun` tolerance (null-coalescing partial runs) and the #437 helpers `agentsByPhase`, `phaseAggregates`, `runTimeline`.
- If removed: no net for the workflow-manifest projection contract.
- Current: OK.
- Location: OK.

### src/lib/parse-workflows.ts
- Feature: Workflow-tool run-manifest shaping (#435/#437) — the Workflow view over `GET /api/workflows` and the workflow-cost/failure detectors.
- If removed: `WorkflowList.tsx`, `api-client.ts`/`api-client.spa.ts`, `unzip-upload.ts`, `upload-dataset.ts`, `sample-workflows.ts`, detectors `reliability/workflow-ratelimit-burst.ts`, `workflow/failed-workflow-runs.ts`, `workflow/runaway-workflow-cost.ts`, `detectors/types.ts`, `view-registry.tsx`, `scripts/ingest.mjs:657` break.
- Current: OK — pure, no `/api/` literal (the route lives in server.mjs; header describes it accurately as documentation).
- Location: OK.

FINDINGS:
1. src/lib/parse-telemetry.ts:22,24-25 — stale header: claims `aggregateModelLatency` has "no detector yet" and #915 is "deferred", but `src/lib/detectors/speed/model-latency.ts:3-6` (the shipped #915 detector) imports and consumes it; the "NO detector, NO view" line is also falsified by `AgentReportCardPf.tsx`/`ReviewQueuePf.tsx`.
2. src/lib/parse-tasks.ts:12 — violated doc contract: "SERVER-ONLY … never import this in browser code" while `src/components/TaskHealthPf.tsx:36-41` value-imports `summarizeTasks`/`COLD_DAYS` into the browser bundle (survives only because Vite stubs `node:fs`); split the pure summarize half into a node-free leaf or correct the header.
3. src/lib/parse-stats-cache.ts:11 — stale header: "Server-only: YES … not available in SPA mode", but `parseStatsCache` runs in the SPA upload path (`src/lib/upload-artifacts.ts:6` → `upload-dataset.ts`) and its output renders in `UsagePulsePf.tsx`; only the live file read is server-side.


### — group: dataset-cache (37 files) —

### src/lib/artifact-source-ingest.test.ts
- Feature: CI regression suite for the multi-root artifact-source ingest (ADR 0009 §1, #1643)
- If removed: vitest coverage lost for `scripts/ingest.mjs` multi-source aggregation (sourceId provenance, two-root collision-free merge, single-source parity); no runtime consumer
- Current: OK — subjects (`scripts/ingest.mjs`, register-ts harness) exist; pins the four #1643 acceptance properties by spawning the real ingest
- Location: OK

### src/lib/artifact-source.test.ts
- Feature: Unit tests for the filesystem `ArtifactSource` implementation
- If removed: coverage lost for `FilesystemArtifactSource` resolve/list/exists/read + signature semantics; no runtime consumer
- Current: OK — imports `FilesystemArtifactSource`/`filesystemArtifactSource` which `artifact-source.ts` exports
- Location: OK

### src/lib/artifact-source.ts
- Feature: Data-plane source abstraction (ADR 0009 §1) — addresses raw `~/.claude` artifacts by source_id + rel_path + signature for multi-root ingest
- If removed: `scripts/ingest.mjs:57` (`filesystemArtifactSource` — every source-relative read in ingest) and `src/lib/repo-map/cache.ts` break; server dataset build stops working
- Current: OK — header accurately describes the interface, the `absPath` escape hatch, and the zero-node_modules dependency constraint
- Location: OK (node-only, but src/lib is this repo's convention for register-ts-loaded server modules)

### src/lib/bounded-fs.ts
- Feature: Bounded directory listing primitive — caps entry counts so pathological dirs can't blow up ingest parsers
- If removed: 11 importers break: `config-loader.ts`, `parse-backups/debug/external-guidance/file-history/plans/session-registry/tasks/teams/telemetry.ts`, `repo-map/generate.ts`
- Current: OK
- Location: OK

### src/lib/chunked.test.ts
- Feature: Unit tests for `mapChunked` (#758)
- If removed: coverage lost for order/index/empty/progress semantics of the chunked map
- Current: OK — matches `chunked.ts` exports
- Location: OK

### src/lib/chunked.ts
- Feature: Main-thread-friendly chunked map for the upload parse (#758) — yields between chunks so the tab stays responsive
- If removed: `src/lib/upload-parse.ts` (the yielding fallback + SPA sample path) breaks
- Current: OK
- Location: OK

### src/lib/dataset-body.test.ts
- Feature: Tests for the single-serialization dataset body + ETag-stable bytes (#2070)
- If removed: coverage lost for generatedAt splice, ETag stability across timestamp-only rebuilds, lone-surrogate edge cases
- Current: OK
- Location: OK

### src/lib/dataset-body.ts
- Feature: `/api/dataset.json` response construction — one serialization yields both served body and ETag-stable bytes (v0.5.0 perf gate #2070)
- If removed: `scripts/server.mjs:227` (dynamic register-ts import) breaks — the server dataset endpoint loses its body/ETag builder; also applies the #2107 wire slimming via `dataset-slim`
- Current: OK
- Location: OK

### src/lib/dataset-boot.test.ts
- Feature: Tests for the boot/slice dataset split (#2443)
- If removed: coverage lost for the exact key partition (boot ∪ slices reconstitutes the dataset), heavy-key exclusion, non-array slice null round-trip
- Current: OK
- Location: OK

### src/lib/dataset-boot.ts
- Feature: Tier-3 instant-load boot/slice split — `splitDataset`/`mergeDataset`/`HEAVY_SLICE_KEYS` shared by server endpoints and client loader (#2443, epic #1852)
- If removed: `scripts/server.mjs:232` (`/api/dataset/boot` + `/api/dataset/slice/<key>` endpoints), `src/App.tsx`, `src/lib/instant-load.ts`, `src/lib/instant-shell.ts` all break
- Current: FINDING (minor): header lines 3–10 frame the split as future ("Today the server ships the whole assembled dataset … as one `/api/dataset.json` monolith … Tier 3 may serve smarter") — the split has shipped: `scripts/server.mjs:3429-3458` serves the boot/slice endpoints and `instant-load.ts:65-82` consumes them; the monolith is now the fallback, not the default
- Location: OK

### src/lib/dataset-cache-client.ts
- Feature: Client-side wrapper over the dataset-worker IndexedDB cache — last-good dataset read/persist plus identity-pinned monolith SWR fallback for the instant-load path
- If removed: `src/lib/instant-load.ts` (the #2443 boot-first loader's cache + fallback plumbing) breaks; `instant-load.test.ts` mocks it
- Current: OK
- Location: OK

### src/lib/dataset-cache-schema-version.test.ts
- Feature: Guard test that the dataset assembly schema version salts both the source signature and ingest contentHash (#1543)
- If removed: nothing stops a refactor of `scripts/ingest.mjs` from silently dropping the schema-version salt, resurrecting stale-cache-after-schema-change bugs
- Current: OK — source-greps `scripts/ingest.mjs` (exists); regexes still match current source
- Location: OK (source-grep test; subject is scripts/ingest.mjs, but src/lib placement matches repo pattern for these wiring tests)

### src/lib/dataset-cache-store.test.ts
- Feature: Tests for the IndexedDB cached-dataset store (fake IDBFactory, commit-before-ack semantics)
- If removed: coverage lost for read/write round-trip and the transaction-commit-before-worker-termination guarantee
- Current: OK
- Location: OK

### src/lib/dataset-cache-store.ts
- Feature: IndexedDB persistence for the parsed dataset (ETag-keyed last-good snapshot) used by the decode worker
- If removed: `src/lib/dataset-worker.ts` breaks — SWR cached-paint (#1015) and offline last-good fallback disappear
- Current: OK
- Location: OK

### src/lib/dataset-slice-worker.ts
- Feature: Off-thread fetch+JSON.parse of the ~19 heavy dataset slices for the instant-load path (#2448)
- If removed: `src/lib/instant-load.ts:123` (`new Worker(new URL('./dataset-slice-worker.ts', …))`) breaks; slice decode falls back to (or breaks) the main thread
- Current: OK — registered in `NETWORK_OWNERS` (scripts/check-inbound-boundary.mjs:28) with the URLs-as-params justification; SPA-safe because its only importer is the aliased-away instant-load.ts
- Location: OK

### src/lib/dataset-slim.test.ts
- Feature: Tests for lossless tokenData wire slimming (#2107) — slim/rehydrate inverse, cost-estimate parity
- If removed: coverage lost for the zero-drop/zero-restore invariant and the `toolResultBytes` conditional-emit edge
- Current: OK
- Location: OK

### src/lib/dataset-slim.ts
- Feature: Wire-level tokenData slimming for `/api/dataset.json` (#2107, v0.5.0 perf gate) — drops zero-valued numerics, client restores them
- If removed: `src/lib/dataset-body.ts` (server serialize side), `src/App.tsx` (`rehydrateDataset` at applyDataset), and `scripts/server.mjs:247` break
- Current: OK — unusually thorough header documenting why toolData is NOT slimmed
- Location: OK

### src/lib/dataset-worker-cache-policy.test.ts
- Feature: Guard test that the dataset worker revalidates by ETag (`If-None-Match`/304) and never sets `no-store`/`no-cache`
- If removed: a refactor could silently reintroduce cache-bypassing fetches of the multi-MB dataset
- Current: OK — source-greps `dataset-worker.ts` + `dataset-cache-store.ts` (both exist, patterns match)
- Location: OK

### src/lib/dataset-worker.ts
- Feature: Off-thread dataset fetch + JSON.parse worker with ETag-keyed IndexedDB SWR (#162, #1015) — the monolith `/api/dataset.json` path
- If removed: `src/lib/api-client.ts:677` and `src/lib/dataset-cache-client.ts:15,61` break — server dataset load and cache read/write both die
- Current: FINDING (minor): header sizes are stale — `dataset-worker.ts:3-4,12` say "~8 MB fetch + JSON.parse (~128 ms)" / "65 MB JSON parse", while sibling modules measured the same payload at ~98–128 MB parsed (`dataset-body.ts:3`, `instant-load.ts` epic docs) with multi-second parse; the comment understates by ~10× what the worker now offloads
- Current: (SPA-safety: registered NETWORK_OWNER, URL arrives as param — OK)
- Location: OK

### src/lib/instant-load.spa.ts
- Feature: SPA/sample-build alias stub for `@instant-load` — keeps `/api/` literals physically out of the upload-only bundle
- If removed: `vite build --mode spa|sample` breaks (`vite.config.ts:244-247` aliases `@instant-load` to this file); the spa-boundary guarantee would be lost
- Current: OK — export surface mirrors the real `loadServerDataset` signature
- Location: OK

### src/lib/instant-load.test.ts
- Feature: Unit tests for `loadServerDataset` orchestration (#2450 shell counts, #2449 preserve-on-failure, skew→monolith fallback)
- If removed: coverage lost for the boot-first loader's failure/fallback matrix
- Current: OK — mocks `@api-client` and `dataset-cache-client`; accurately notes the worker/main-thread slice-decode equivalence
- Location: OK

### src/lib/instant-load.ts
- Feature: Boot-first server dataset loader (#2443) — fetches `/api/dataset/boot` then heavy slices, lazy chunk DCE'd from the SPA build
- If removed: `src/App.tsx:1492` (`await import('@instant-load')` under `SERVER_AVAILABLE`) breaks the server-flavor load path entirely
- Current: OK — NETWORK_OWNERS registration (check-inbound-boundary.mjs:29) and the lazy-chunk/DCE claims verified against vite.config.ts and App.tsx
- Location: OK

### src/lib/instant-shell.test.ts
- Feature: Tests for the instant above-the-fold shell contract (#2444) — literal-duplication drift guard, envelope serialize/parse, template injection/rewrite
- If removed: the deliberate literal duplication in main.tsx/App.tsx (`__BOOT__`, `data-instant-shell`) could silently drift from this module
- Current: OK
- Location: OK

### src/lib/instant-shell.ts
- Feature: First-HTML-response shell rendering — cross-stage contract between vite build injection, server.mjs runtime rewrite, and client hydration (#2444)
- If removed: `vite.config.ts:9` (`injectShellIntoTemplate`, chd-instant-shell plugin), `scripts/server.mjs:241` (runtime rewrite), and `src/main.tsx`/`src/App.tsx` hydration all break
- Current: OK — dependency-free as its zero-node_modules constraint requires
- Location: OK

### src/lib/sources.test.ts
- Feature: Tests for multi-source `DataSource` resolution (defaults, `CLAUDE_DIR`, config normalization)
- If removed: coverage lost for the historyDir/configFile default contract ingest and server rely on
- Current: OK
- Location: OK

### src/lib/sources.ts
- Feature: `DataSource` resolution — turns env/config into the list of harness roots ingest aggregates (multi-harness ingest seam)
- If removed: `scripts/ingest.mjs:56` (`resolveSources`) and `scripts/server.mjs:111` break; `artifact-source.test.ts` imports its `DataSource` type
- Current: OK
- Location: OK

### src/lib/unzip-upload.test.ts
- Feature: Tests for zip inflation, sensitive-file filtering, skip rules, project-name extraction, upload collectors
- If removed: coverage lost for the security-relevant guarantee that `credentials.json`/`.env`/`settings.json` are never decompressed, plus the #758 bomb guards
- Current: OK
- Location: OK

### src/lib/unzip-upload.ts
- Feature: Pure upload helpers (#395/#758) — fflate unzip with sensitive-file filter and decompression-bomb caps, path classification, transcript/memory/workflow collectors
- If removed: `src/components/FileUpload.tsx`, `src/lib/sample-data.ts`, `src/lib/upload-artifacts.ts`, `src/lib/upload-dataset.ts` break — the whole SPA/upload tier dies
- Current: OK
- Location: OK

### src/lib/upload-artifacts.test.ts
- Feature: Tests for upload-side artifact parsing (#1051) — tasks, team messages, last-update, MCP auth, stats cache
- If removed: coverage lost for the upload path's artifact-slice parity with the server ingest
- Current: OK
- Location: OK

### src/lib/upload-artifacts.ts
- Feature: Parses non-transcript `~/.claude` artifacts (tasks/, teams/, caches) out of an uploaded bundle into App dataset slices (#1051)
- If removed: `src/lib/upload-dataset.ts` breaks — uploaded bundles lose tasks/teams/config artifact views
- Current: OK
- Location: OK

### src/lib/upload-dataset.test.ts
- Feature: Tests for the single-pass worker-side upload pipeline (#1069), incl. the SECRET_MARKER no-leak guard
- If removed: coverage lost for the guarantee that decoded transcript text never crosses the worker boundary
- Current: OK
- Location: OK

### src/lib/upload-dataset.ts
- Feature: The whole upload build in one pass — inflate, read, parse history/sessions/artifacts, post only parsed results (#1069)
- If removed: `src/lib/upload-pipeline-worker.ts` and `src/lib/upload-pipeline-client.ts` (fallback path) break — manual upload and SPA sample load die
- Current: OK
- Location: OK

### src/lib/upload-parse.ts
- Feature: The 11 progressive parse passes for an upload, shared between worker and yielding main-thread fallback (#1015/#1069)
- If removed: `src/lib/upload-dataset.ts` (runtime) breaks; `src/App.tsx:54` imports the `UploadParseEmit` type for its merge-into-state seam
- Current: OK
- Location: OK

### src/lib/upload-pipeline-client.ts
- Feature: Upload pipeline orchestrator — prefers the worker, transparently falls back to a yielding main-thread build (#1069)
- If removed: `src/components/FileUpload.tsx` and `src/App.tsx` break — no upload entry point; `FileUpload.test.ts` also imports it
- Current: OK
- Location: OK

### src/lib/upload-pipeline-worker.ts
- Feature: Web Worker entry running `buildUploadDataset` fully off the main thread (#1069)
- If removed: `src/lib/upload-pipeline-client.ts:59` (`new Worker(new URL('./upload-pipeline-worker.ts', …))`) breaks; every upload falls to the slower main-thread path
- Current: OK
- Location: OK

### src/lib/upload-result-scheduler.test.ts
- Feature: Tests for the idle-callback batching scheduler (enqueue/flush/cancel, batch cap, fake scheduler)
- If removed: coverage lost for the progressive-render batching contract App relies on during uploads
- Current: OK
- Location: OK

### src/lib/upload-result-scheduler.ts
- Feature: Batches parsed upload results into idle-time state applications so progressive render doesn't jank the main thread
- If removed: `src/App.tsx` breaks — upload results would apply per-message, re-introducing render thrash during large uploads
- Current: OK
- Location: OK

FINDINGS:
1. src/lib/dataset-boot.ts:3-10 — stale header: frames the boot/slice split as a future possibility ("Today the server ships the whole assembled dataset … as one monolith … may serve smarter") when the split is shipped and live (`scripts/server.mjs:3429-3458` serves `/api/dataset/boot` + `/api/dataset/slice/<key>`; `instant-load.ts:65-82` consumes them; the monolith is now the fallback path). Comment-only, but misleads a reader about the current architecture.
2. src/lib/dataset-worker.ts:3-4,12 — stale measurements: "~8 MB `/api/dataset.json` fetch + `JSON.parse` (~128 ms)" and "65 MB JSON parse" understate the current payload by ~10× (sibling modules `dataset-body.ts:3` and the #1852 epic docs measure the same dataset at ~98-128 MB parsed with multi-second stalls). Comment-only.


### — group: recs-core (15 files) —

### src/lib/domain-registry.test.ts
- Feature: Guardrail for the action-domain taxonomy (#2079) that organizes the whole nav/digest UI.
- If removed: vitest coverage lost (CI `test` job runs `src/**/*.test.ts`); the completeness invariants — every RecCategory maps to exactly one domain, every domain has a landing view registered in `NAV_ITEMS`, order/labels unchanged — would no longer fail on drift.
- Current: OK — its literal unions match the live types: 9 `RecCategory` members incl. `maintenance` (src/lib/detectors/rec-enums.ts:21-33) and 9 `ActionDomain` members (src/types.ts:488-497).
- Location: OK (beside its subject).

### src/lib/domain-registry.ts
- Feature: Single source of truth for the six action-domains + three structural buckets driving sidebar/digest ordering, labels, landings, and rec-category→domain mapping.
- If removed: `src/lib/digest.ts:26-28` (derives `CATEGORY_TO_DOMAIN`/`DOMAIN_LANDING`), `src/lib/nav-prefs.ts:45` (derives `DOMAIN_LABEL` from `DOMAIN_OUTCOME_VERB`), `src/lib/coverage.ts:2` (`ACTION_DOMAIN_NAMES`), and transitively `canonical-evidence.ts`/`PFLayout`/`DigestSpine` break — the whole domain-organized nav collapses.
- Current: OK — header's derivation claims verified in digest.ts/nav-prefs.ts; the #1582 cycle-avoidance import of `RecCategory` from `detectors/rec-enums` is intact.
- Location: OK.

### src/lib/reclaim-trendline.test.ts
- Feature: Pins the reclaim-trendline/coverage-gauge math (epic #944 PR6, #952) feeding CostAttribution.
- If removed: vitest coverage lost for weekly baseline-vs-afterReclaim points, the independent coverage gauge, and per-lever marginals.
- Current: OK — imports `buildReclaimTrendline` from the live subject plus `scopeKeyOf`/`ReclaimClaim` from `./reclaim`; fixtures mirror reclaim.test.ts as its comment claims.
- Location: OK.

### src/lib/reclaim-trendline.ts
- Feature: Reclaim-compass trendline + coverage gauge + per-lever marginal derivation — the visible payoff of the compass reframe (#724) on the Cost Attribution view.
- If removed: `src/components/CostAttribution.tsx` (its sole non-test consumer) loses the trendline/gauge rendering; `reclaim-trendline.test.ts` fails.
- Current: OK — pure math over `Recommendation[]` + `SessionTokenData[]`, no fetch/node imports, so the "no new server call / spa-boundary stays green" claim holds.
- Location: OK. Single-consumer module, but the pure-math/component split is deliberate and tested.

### src/lib/reclaim.test.ts
- Feature: Pins the guarded-marginal reclaim cascade (epic #944 PR1/PR2) — the accounting model that prevents dollar double-counting.
- If removed: vitest coverage lost for `runReclaimCascade`/`rollupCascade`/`scopeKeyOf`/`DEFAULT_CAUSE` — the `sum(marginal) ≡ billOriginal − billFinal` identity and `residual ≥ 0` rejection semantics go unguarded.
- Current: OK.
- Location: OK.

### src/lib/reclaim.ts
- Feature: The reclaim cascade — sequential-residual dollar accounting (`docs/v0.3-efficiency-accounting.md` §4) behind every `estSavingsUsd` rollup, plus the detector-free cascade helpers moved here in #2719 so browsers can roll up server-supplied recs without bundling the engine.
- If removed: massive breakage — ~40 direct importers: `recommendations.ts` (re-exports it, so the server path via `scripts/ingest.mjs`→`recommendations.ts` breaks), `Recommendations.tsx`, `reclaim-trendline.ts`, `detectors/types.ts`, `detectors/shared.ts`, and ~25 cost/context/workflow/reliability detectors + their tests.
- Current: OK — header's PR1/PR2 history reads as history, not stale present-tense.
- Location: OK.

### src/lib/recommendation-surface.test.ts
- Feature: Pins the #2718/#2719 typed-surface client contract: query serialization (rec/family excluded), strict `parseRecommendationResult` envelope validation, and the viewer-only engine boundary.
- If removed: vitest coverage lost, including the fast source-contract twin of `scripts/check-engine-absent.mjs` (lines 119-160 read `use-recommendations.ts`/`claude-context.ts`/`recommendation-surface.ts`/`App.tsx` sources to reject value imports of the engine).
- Current: OK — `readFileSync` source-grepping is brittle by design but currently matches the files it reads.
- Location: OK.

### src/lib/recommendation-surface.ts
- Feature: Client-safe boundary seam (#2719, epic #2443) browser viewers import instead of the heavy `./recommendations` barrel — surface types, `recommendationSurfaceQuery`, `parseRecommendationResult`.
- If removed: `src/lib/api-client.ts`, `src/lib/api-client.spa.ts`, `src/lib/use-recommendations.ts`, and `src/components/CostAttribution.tsx` break; the SPA build would have to import the engine barrel, violating the viewer-only boundary.
- Current: OK — runtime graph is one `URLSearchParams` call; all engine imports are `import type`. The `/api/recommendations.json` string at line 106 is comment-only (it is not in `NETWORK_OWNERS`, scripts/check-inbound-boundary.mjs:24-32, and carries no fetch primitive — compliant).
- Location: OK.

### src/lib/recommendation-view-data.test.ts
- Feature: The #2352 parity contract — the canonical client envelope must supply every detector-consumed field except the documented server-only artifacts.
- If removed: a new detector consuming a client-carried signal could silently drop from Home Digest/Recommendations/Ask Claude — `engineConsumedFields()` derived from the live catalog would no longer gate the envelope.
- Current: OK.
- Location: OK.

### src/lib/recommendation-view-data.ts
- Feature: Canonical `ViewData` → `RecommendationViews` envelope mapping for the browser's presentation props and the server typed-surface seam (#2352/#2719).
- If removed: `src/lib/view-registry.tsx:26,600,610` breaks (Home Digest + Recommendations views spread this envelope); the parity test fails.
- Current: FINDING (minor doc drift): the module docstring (lines 10-14) lists only 5 client-absent fields (`gitOutcomes`, `modelPinSavings`, `organizationIdentity`, `semanticIntent`, `memoryStores`) while `CLIENT_ABSENT_ENGINE_FIELDS` (lines 31-49) actually carries 7 — `docHygieneArtifact` and `localCalibration` are missing from the prose list. The constant's own JSDoc is accurate; only the intro paragraph is stale.
- Location: OK.

### src/lib/recommendations-parity.test.ts
- Feature: Golden frozen snapshot proving the 20 legacy in-file rules ported into the detector catalog (#507) byte-identically.
- If removed: silent behavioral drift in ported detectors becomes possible; nothing else imports it.
- Current: OK — imports only stable `buildRecommendations` API; its "never regenerate to pass" discipline is stated in the header.
- Location: OK.

### src/lib/recommendations.test.ts
- Feature: The engine-plumbing test suite: assembly, ranking, severity bumps, project attribution/filtering, reclaim rollups, rejection suppression.
- If removed: vitest coverage lost for the entire `buildRecommendations` plumbing surface (4,490 lines of contracts).
- Current: OK — all 17 imported names resolve against the live barrel (CI would fail otherwise).
- Location: OK, though at 4,490 lines it is a candidate for splitting along the same seams the source already has (reclaim rollups vs. ranking vs. assembly).

### src/lib/recommendations.ts
- Feature: The recommendations engine barrel — `buildRecommendations` (detector catalog run + rank), `assembleRecommendationInput`, per-project attribution, and back-compat type/helper re-exports.
- If removed: the product's core breaks: `scripts/ingest.mjs:617` (server `/api/recommendations.json` route, dynamic-imports it via register-ts), `Recommendations.tsx`, `RecommendationCard.tsx`, `DigestSpine.tsx`, `TopActionHero.tsx`, `SeveritySummaryBar.tsx`, `recommendation-display.ts`, `cost-scope.ts`, `canonical-evidence.ts`, `claude-context.ts`, `detectors/types.ts`, `recommendation-view-data.ts`, plus ~15 test files.
- Current: OK — header's "holds only engine plumbing since #507" claim matches the 726-line reality; #2719 re-export notes for the reclaim move are accurate.
- Location: OK.

### src/lib/use-recommendations.test.tsx
- Feature: Pins the viewer-only loader hook's state machine (#2719): loading/ready/error/unavailable, abort of obsolete requests, retry keeping prior findings on a same-scope refetch.
- If removed: vitest coverage lost for the trust contract that only a `ready` response may render "no findings".
- Current: OK — mocks `@api-client` exactly as the hook consumes it (`SERVER_AVAILABLE`, `fetchRecommendationSurface`).
- Location: OK.

### src/lib/use-recommendations.ts
- Feature: `useRecommendationSurface` — the viewer-only React hook that fetches the server-computed rec envelope per scoped surface and exposes the discriminated async state.
- If removed: `src/App.tsx`, `AskClaude.tsx`, `Recommendations.tsx`, `CostAttribution.tsx`, `DigestSpine.tsx`, `view-registry.tsx`, and `test-support/ready-analysis.ts` break — every rec-rendering surface loses its loader.
- Current: OK — imports only `@api-client` (the sanctioned chokepoint alias) + the client-safe surface seam; no `/api/` literals or node imports, and the boundary test in recommendation-surface.test.ts pins that. Filename is plural-legacy vs. its single `useRecommendationSurface` export — cosmetic only.
- Location: OK.

FINDINGS:
1. src/lib/recommendation-view-data.ts:10-14 — stale module docstring: the prose list of client-absent engine fields names 5 fields but omits `docHygieneArtifact` and `localCalibration`, both present in `CLIENT_ABSENT_ENGINE_FIELDS` (lines 31-49) and pinned by the parity test. Doc drift only; no behavioral defect.


### — group: sessions-timeline (20 files) —

### src/lib/classify-session.test.ts
- Feature: Vitest pin for the deterministic task-category classifier feeding the daily digest.
- If removed: CI (test.yml `npm test` vitest glob) loses the taxonomy-shape + rule-scoring pins for `classifySession`.
- Current: OK — imports match live exports; the `(#655)` tag matches the taxonomy provenance comment in src/types.ts:84 even though the module landed via PR #1320.
- Location: OK (sibling of subject).

### src/lib/classify-session.ts
- Feature: Deterministic, no-LLM task-category (implementation/debugging/review/…) classification per session, powering the daily-digest category grouping.
- If removed: `src/lib/build-daily-digest.ts` breaks, which breaks the daily-digest route in `scripts/server.mjs` (dynamic import at line 288) and `scripts/daily-digest-route.test.mjs`; plus its own test.
- Current: OK.
- Location: OK.

### src/lib/context-composition.test.ts
- Feature: Vitest pin for the #1926 token-bucket reconstruction (`tokenizeConfigPrefix`/`composeSession`/`composeAggregate`).
- If removed: CI loses the additive-not-proportional reconciliation contract (high-fidelity buckets unscaled, residual absorbs the gap).
- Current: OK — imports match live exports.
- Location: OK.

### src/lib/context-composition.ts
- Feature: Context-composition view (#1926) — dissects the billed input total into named buckets (system prefix, conversation history, tool payloads, residual).
- If removed: `src/components/ContextComposition.tsx` breaks (rendered as `<ContextCompositionPf>` inside `src/components/TokenUsage.tsx:626`), plus its test.
- Current: OK — honest fidelity-tier documentation matches the implementation; pure module, SPA-safe (no `/api/` or node imports).
- Location: OK.

### src/lib/context-health.ts
- Feature: Context-health scoring (hit rate, growth rate, over-window/compaction thresholds) for the Context Health view and several recs detectors.
- If removed: wide breakage — `src/components/ContextHealth.tsx` (wired in `src/lib/view-registry.tsx:776`), detectors `context/compaction-hot-sessions`, `context/low-cache-hit`, `context/low-health`, `context/over-window`, `context/last-n-runs-audit`, plus `live-session.ts`, `parse-compaction-risk.ts`, `review-queue.ts`, `session-overview.ts`, `session-scorecard.ts`.
- Current: OK — exported thresholds are the shared source of truth the consumers cite.
- Location: OK — correctly a leaf constants+compute module under src/lib.

### src/lib/conversation-patterns.ts
- Feature: Conversation-pattern stats (turn counts, latency buckets, thinking ratio, velocity) for the Conversation Patterns view.
- If removed: `src/components/ConversationPatterns.tsx` breaks (wired in `src/lib/view-registry.tsx:786`) and its component test `src/components/ConversationPatterns.test.ts`.
- Current: OK — pure over `SessionTimeline`, SPA-safe.
- Location: OK.

### src/lib/digest.test.ts
- Feature: Vitest pin for the home-landing digest ranking (safety-first ordering, per-domain top pick, verdict, empty-state copy).
- If removed: CI loses the safety-leads-severity ordering contract (the S1-Priya siloing guard).
- Current: OK — it imports the `Recommendation`/`DomainCoverage` types via the `./recommendations`/`./coverage` barrels the subject deliberately avoids (#1582 cycle break); harmless for a test (types are re-exported and erased), not a boundary violation.
- Location: OK.

### src/lib/digest.ts
- Feature: Digest spine (epic #490/#491) — pure ranking/verdict logic behind the home landing page.
- If removed: `src/components/DigestSpine.tsx` breaks (wired in `src/lib/view-registry.tsx:599`), plus `src/lib/canonical-evidence.ts` and `src/lib/coverage.test.ts`.
- Current: OK — the #1582 leaf-import cycle-break comment matches the actual imports (`detectors/types`, `detectors/rec-enums`, `coverage-types`, `domain-registry`).
- Location: OK.

### src/lib/session-cache.ts
- Feature: Ingest persistence layer (#627 slices 3+4) — `session_transcript` BLOB cache and `session_blob` per-session signal cache prepared statements/migrations.
- If removed: `scripts/ingest.mjs` breaks (dynamic imports at lines 2170/2174-area; routes `persistTranscript` and the session_blob read/write paths through it), and the parity harnesses `scripts/transcript-cache-parity.test.mjs` + `scripts/session-blob-cache-parity.test.mjs` fail.
- Current: FINDING — the module is fine, but its slice-3 parity guard `scripts/transcript-cache-parity.test.mjs` runs only via the manual `test:transcript-cache` script (package.json:69) and is wired into NO workflow (grep of `.github/workflows/` finds nothing), the exact "orphaned parity harness" class ci.yml itself remediated for `test:session-blob-cache` (#2384, ci.yml:359-369) and `test:scripts-parity` (#1654). A `session_transcript` DDL/statement drift would ship dark.
- Location: OK — server-only `.ts` deliberately placed in src/lib for the ts-loader import from ingest.mjs (header documents the no-cycle contract); never reachable from the SPA bundle.

### src/lib/session-display.test.ts
- Feature: Vitest pin for session labeling helpers (title fallback chain, short-id truncation, display map).
- If removed: CI loses the "#7 never show 'Untitled session'" fallback-label contract.
- Current: OK — imports match live exports.
- Location: OK.

### src/lib/session-display.ts
- Feature: Canonical session label/title/short-id derivation used everywhere a session is named in the UI.
- If removed: 13 components break — SessionList, SessionTimeline, SessionIdLink, DigestSpine, TokenUsage, ContextComposition, ContextHealth, ConversationPatterns, CostAttribution, ProjectBreakdown, AgentReportCardPf, AutomationView, TaskHealthPf.
- Current: OK.
- Location: OK.

### src/lib/session-overview.test.ts
- Feature: Vitest pin for `computeSessionOverview`, including user-turn counting from slim timelines (stripped summaries → `summaryLen`-derived counts).
- If removed: CI loses the slim-timeline (#2106-era shape) user-turn derivation contract.
- Current: OK.
- Location: OK.

### src/lib/session-overview.ts
- Feature: Per-session overview rollup (tokens/cost/tools/files/errors/compactions/duration) backing the session drill-in and Ask Claude context.
- If removed: `src/components/AskClaude.tsx` (+ its test), `src/components/SessionList.tsx`, `src/components/ExperimentSegment.tsx`, and `src/lib/claude-context.ts` (+ test) break.
- Current: OK — reuses `OVER_WINDOW` from context-health and `estimateCost` from parse-sessions rather than re-deriving.
- Location: OK.

### src/lib/session-scorecard.test.ts
- Feature: Vitest pin for the seven-axis session scorecard (`SCORECARD_AXIS_IDS`, `computeSessionScorecard`, `scorecardAxis`).
- If removed: CI loses the axis-id set and confidence/evidence scoring contracts.
- Current: OK — imports match live exports.
- Location: OK.

### src/lib/session-scorecard.ts
- Feature: Per-session multi-axis scorecard (cost/outcome/speed/security/portability/reliability/focus) rendered in the session list and patterns views.
- If removed: `src/components/SessionList.tsx` (+ `SessionList.test.ts`) and `src/components/SessionPatterns.tsx` break.
- Current: OK — composes existing parsers (runtime events, timeline-success, permissions danger detection, context-health thresholds); no duplicate threshold definitions.
- Location: OK.

### src/lib/session-summaries.test.ts
- Feature: Vitest pin for `composeSessionSummary` + `computeActivityRollups`/`ROLLUP_WINDOWS` (#960 path B).
- If removed: CI loses the deterministic per-session summary line and hour/day/week/month rollup contracts.
- Current: OK.
- Location: OK.

### src/lib/session-summaries.ts
- Feature: Pure no-LLM "what this session did" one-liners + multi-window activity rollups (#960 path B) for SessionList and the usage pulse.
- If removed: `src/components/SessionList.tsx` and `src/components/UsagePulsePf.tsx` break.
- Current: OK — the header's #1056 note ("insights facets removed; heuristic classifier is the replacement") is corroborated by src/lib/summary.ts:405; ADR 0005 always-on/SPA-safe claim holds (pure imports only).
- Location: OK.

### src/lib/session-type-classifier.test.ts
- Feature: Vitest pin for the always-on heuristic session-type classifier (#655) — quick_question/exploration/multi_task/single_task boundaries.
- If removed: CI loses the turn/duration threshold and explore-vs-action verb-split contracts.
- Current: OK — imports (`classifySessionType`, `buildSessionTypeClassifier`) match live exports.
- Location: OK.

### src/lib/session-type-classifier.ts
- Feature: Local heuristic session-shape classifier (#655) that fills the Summary "By session type" breakdown without `/insights`, in `/insights` vocabulary.
- If removed: `src/components/SummaryView.tsx` and `src/lib/session-summaries.ts` (hence SessionList/UsagePulsePf) break.
- Current: OK — facet-wins-over-heuristic claim matches `spendBySessionType` usage; no network/LLM code, consistent with ADR 0005/0008 claims in the header.
- Location: OK.

### src/lib/transcript-hygiene.ts
- Feature: Secret scrubbing (#204/#181 slice 1) of transcript text before durable SQLite persistence; pattern list shared with the secrets-at-rest signal (#2504).
- If removed: `scripts/ingest.mjs` breaks (dynamic import of `scrubValue` at line 2174 — transcripts would persist unscrubbed), and `src/lib/parse-secrets-at-rest.ts` + `src/lib/parse-value-flow.ts` lose `SECRET_PATTERNS`.
- Current: OK — deterministic/JSON-safe redaction design matches implementation; single shared pattern list as the #2504 comment claims.
- Location: OK — dual-consumed (ingest + parsers), so src/lib is the right home.

FINDINGS:
1. `scripts/transcript-cache-parity.test.mjs` — the DATA-INTEGRITY parity guard that `src/lib/session-cache.ts` (slice 3, `session_transcript`) explicitly cites as its proof — is not wired into any CI workflow; it exists only as the manual `test:transcript-cache` script (package.json:69). This is the same orphaned-harness class ci.yml already remediated for `test:session-blob-cache` (#2384, ci.yml:369) and `test:scripts-parity` (#1654, ci.yml:359), so a `session_transcript` DDL/statement drift would currently ship without failing CI.


### — group: cost-tokens (12 files) —

### src/lib/activity-pulse.ts
- Feature: Activity view (ProjectActivityPf) — 90-day session calendar, hour×weekday heatmap, per-project momentum (sessions/week).
- If removed: `src/components/ProjectActivity.tsx` breaks (sole importer), which is lazy-loaded by `src/lib/view-registry.tsx:159-161` and rendered at `view-registry.tsx:734` — the Activity view fails to load.
- Current: OK — DST-safe local-day bucketing is deliberate and documented (lines 49-53).
- Location: OK in `src/lib`, though note it is session-cadence analytics, not cost/token math — it sits in this audit group only by bucketing, not by domain.

### src/lib/burn-rate-projection.test.ts
- Feature: CI regression pin (vitest via `test.yml` globs `src/**/*.test.ts`).
- If removed: only test coverage of `burn-rate-projection.ts` (plus its use in `BurnRateProjection.test.tsx`) is lost; nothing imports a test.
- Current: OK — subject exists; imports (`PLAN_WINDOW_MS`, `buildBurnRateProjection`, `projectUsageWindow`) match live exports. Pins the plan-window elapsed-fraction/time-to-limit math and the spend/plan payload assembly against a fixed `CostTrend` fixture and frozen clock.
- Location: OK (co-located with subject).

### src/lib/burn-rate-projection.ts
- Feature: Burn-rate projection card in the Token Usage view — combines dollar burn (CostTrend) with live plan-window utilization (`/api/usage`) into time-to-limit and month-end projections.
- If removed: `src/components/BurnRateProjection.tsx` breaks (rendered by `TokenUsage.tsx:620`), plus `BurnRateProjection.test.tsx` and `burn-rate-projection.test.ts`.
- Current: OK — pure, clock-injected (`nowMs` param), degrades cleanly when usage is unavailable.
- Location: OK.

### src/lib/cost-attribution.test.ts
- Feature: CI regression pin (vitest).
- If removed: coverage of `attributeCostByTool` / `attributeCostByToolId` lost.
- Current: OK — subject exists, imports match. Pins the resultBytes-proportional cost split (heavy Read outweighs one-line Bash), the call-count fallback when all result sizes are zero, and the `_no_tools` synthetic bucket, driven through real `parseSessionJsonl`/`parseToolUsage` fixtures rather than hand-built rows.
- Location: OK.

### src/lib/cost-attribution.ts
- Feature: Cost view attribution — per-tool, per-project, and top-expensive-session cost breakdowns.
- If removed: `src/components/CostAttribution.tsx` and `SummaryView.tsx` break; `src/lib/summary.ts` and `src/lib/review-queue.ts` break; server side, `scripts/server.mjs:279` dynamically imports `topExpensiveSessions` for the agentic-opportunity audit's displaced-cost weighting (#741) — that route crash-loops.
- Current: OK — synthetic-bucket constants (`_no_tools`, `_unknown`) documented; delegates per-entry pricing to `estimateEntryCost` (parse-sessions), the right seam.
- Location: OK.

### src/lib/cost-scope.test.ts
- Feature: CI regression pin (vitest).
- If removed: coverage of the #2718 server-safe Cost-route boundary lost.
- Current: OK — subject exists, imports (`filterCostDataByRoute`, `reclaimScopedInput`) match. Pins the two seams the extraction added: the reduced reclaim engine input (empty-but-referentially-stable collections) and the route-filter re-export; header comment correctly defers moved-verbatim logic to `view-registry.test.ts`/`cost-attribution.test.ts`.
- Location: OK.

### src/lib/cost-scope.ts
- Feature: Cost / Reclaim Compass ROUTE filter (project/date/mode/entrypoint) — the React-free server-safe boundary (#2718) shared by browser and server recommendation scoping.
- If removed: `src/components/CostAttribution.tsx` (lazy Cost chunk) breaks, and `scripts/ingest.mjs:633-635` (`filterCostDataByRoute`, `reclaimScopedInput` for scoped recommendation surfaces) crashes the server ingest path; `CostAttribution.test.ts` + `cost-scope.test.ts` fail.
- Current: OK — honors its own contract: pure `src/lib` imports + `import type` only, no React, no `/api/` literals, no node imports; the module-doc bundle rationale (stay out of the eager shell) matches its importer set.
- Location: OK — deliberately separate from `view-scope.ts` for ADR 0016 chunking; documented in-file.

### src/lib/cost-trend.ts
- Feature: Cost-over-time analytics — daily spend series, trailing 7-day burn rate, month-end projection feeding TokenUsage chart, Summary, weekly-delta, and burn-rate projection.
- If removed: `TokenUsage.tsx`, `token-usage-chart.ts`, `summary.ts`, `weekly-delta.ts`, `burn-rate-projection.ts`, `BurnRateProjection.tsx` all break, plus five test files.
- Current: FINDING — `entryCost` (cost-trend.ts:66-79) is a byte-identical duplicate of `estimateEntryCost` (parse-sessions.ts:476-490); the doc comment at cost-trend.ts:63-64 claims "there is exactly one place the per-entry pricing formula lives," which is false — two independent copies exist (neither delegates; verified imports), so a pricing tweak to one silently desyncs the daily series from the headline Est. Cost it promises to match.
- Location: OK.

### src/lib/pricing.ts
- Feature: Pricing resolution layer — provenance-flagged model→rate resolution (synthetic/unknown/missing exclusion), server-tool flat rates, cheapest-model swap counterfactual (`entryCostAtModel`); rate tables themselves live in `model-registry.ts` and are re-exported.
- If removed: 18 importers break, including `parse-sessions.ts` (all cost math), `cost-trend.ts`, `summary.ts`, `reclaim.ts`, `detectors/shared.ts`, `model-pin-savings.ts`, `TokenUsage.tsx` — effectively every cost surface and several detectors.
- Current: OK — header pricing sources carry explicit verification dates (2026-05-26/2026-06-12); zero-price-and-flag posture for unknown models documented and consistent with the code.
- Location: OK — the registry/pricing split (data in `model-registry.ts`, resolution here) is coherent.

### src/lib/usage-gauge.test.ts
- Feature: CI regression pin (vitest).
- If removed: only unit coverage of the server's `/api/usage` core lost — notably the #1712 credential-ranking regression (mcpOAuth token 401ing the usage ping).
- Current: OK — subject exists, imports (`findAccessToken`, `parseUsageWindow`, `buildUsagePayload`) match. Pins sk-ant-oat-prefix ranking over DFS order, header parsing, and auth-failed/no-headers payload shapes.
- Location: OK.

### src/lib/usage-gauge.ts
- Feature: Plan-limit usage gauge server core for `GET /api/usage` (#130/#626) — credential-tree token walk, rate-limit header parsing, payload assembly.
- If removed: `scripts/server.mjs:161-163` dynamically imports `findAccessToken`/`buildUsagePayload` — the usage route (and the BudgetGauge/BurnRateProjection cards behind it) breaks; `usage-gauge.test.ts` fails. No SPA-bundle importer, so it never ships client-side despite living in `src/lib` (placed here purely for unit-testability, per its header).
- Current: OK — pure (no node imports, no fetch); the impure credential-read/ping stays in the server route as documented. `UsageWindow`/`UsageOverage` types are intentionally mirrored (not shared) with `usage.ts`, which documents the mirror.
- Location: OK — server-only logic in `src/lib` is the established pattern for this repo (dynamic-imported .ts under the register-ts loader).

### src/lib/usage.ts
- Feature: Client-side types for the plan-usage gauge — the `Usage` shapes consumed by BudgetGauge, burn-rate projection, and the api-client chokepoint.
- If removed: `api-client.ts`, `api-client.spa.ts`, `BudgetGauge.tsx`, and `burn-rate-projection.ts` break.
- Current: OK — genuinely types-only as its header claims (`fetchUsage` moved to api-client per #324); `/api/usage` appears only in comments, no network primitives, so the SPA inbound-boundary posture holds (NETWORK_OWNERS untouched).
- Location: OK.

FINDINGS:
1. src/lib/cost-trend.ts:66 — `entryCost` duplicates `estimateEntryCost` (src/lib/parse-sessions.ts:476) byte-for-byte, while its doc comment (cost-trend.ts:63-64) asserts "there is exactly one place the per-entry pricing formula lives"; the two copies can silently drift, desyncing the daily-spend series from the headline Est. Cost total the module promises to match. One should delegate to (or re-export) the other.

---

## src/lib — non-detectors, part 2a: adoption-experiments + config-claude + docs-repomap + api-net (DONE — 2026-07-22)

### — group: adoption-experiments (44 files) —

### src/lib/adoption-receipts.test.ts
- Feature: Test coverage for the adoption-receipt append-only store (recs adoption loop, #575/#2206)
- If removed: vitest coverage lost (CI `test` job globs src/**/*.test.ts); no import consumers
- Current: OK — pins `sanitizeAdoptionReceipt` fail-closed allowlist, append/read round-trip, `ADOPTION_RECEIPT_LINE_MAX_BYTES` cap, `readRejectedFindingIds`, writes-disabled gate; imports match subject exports
- Location: OK (co-located with subject)

### src/lib/adoption-receipts.ts
- Feature: Server-side append-only JSONL store for SURFACED/SUPPRESSED/REJECTED adoption receipts — the write/read substrate of the Adoption Scorecard and the recs feedback loop
- If removed: scripts/server.mjs:197 (value import; adoption/reject routes, spool drain wiring), src/lib/adoption-spool.ts, src/lib/adoption-scorecard.ts (types), src/lib/sample-artifacts.ts, plus type-only `AdoptionReceipt` imports in App.tsx:122, view-registry.tsx:72, api-client.ts:35, api-client.spa.ts:17 all break; AdoptionScorecard view and receipt capture die
- Current: OK
- Location: OK — Node fs imports are safe because every SPA-reachable consumer imports types only; value consumers are server-only

### src/lib/adoption-scorecard.test.ts
- Feature: Test coverage for the scorecard read-side join (#577, ADR 0005)
- If removed: vitest coverage lost; nothing imports it
- Current: OK — pins `buildAdoptionScorecard`/`liveClaudeMdHunk` honesty rules (render-time hunk extraction, organic-suppression exclusion) against real detector marker catalog
- Location: OK

### src/lib/adoption-scorecard.ts
- Feature: Pure read-side join deriving per-finding adoption rows for the Adoption Card + Scorecard view (#577)
- If removed: src/components/AdoptionScorecard.tsx (registered view) and src/lib/sample-adoption.test.ts break
- Current: OK — header honesty rules (lower-bound M/N, non-causal quiet, attribution-pending) still match implementation; #581 hook-side surfaced write it mentions as pending has landed as the spool path, but the "until #581 lands" phrasing is inside a conditional rendering rule that still applies to un-attributed transitions
- Location: OK (pure, browser-safe)

### src/lib/adoption-spool.test.ts
- Feature: Test coverage for the offline receipt spool drain (#581)
- If removed: vitest coverage lost; nothing imports it
- Current: OK — pins drain/quiet-drain, sanitize-on-drain drop, batch byte behavior against `ADOPTION_RECEIPT_LINE_MAX_BYTES`
- Location: OK

### src/lib/adoption-spool.ts
- Feature: Server boot-time drain of the dashboard-owned SURFACED-receipt spool written when the dashboard was down (#581)
- If removed: scripts/server.mjs:215 (boot drain; spool path const at server.mjs:412) breaks — offline-emitted receipts would never reach the canonical log
- Current: OK
- Location: OK (server-only, imported only by server.mjs; Node imports appropriate)

### src/lib/checkpoint-answer-store.test.ts
- Feature: Test coverage for the durable checkpoint answer-time store (#2519)
- If removed: vitest coverage lost; nothing imports it
- Current: OK — pins sanitize/append/parse/index/efficacy read plus the clock-skew, max-duration, and read-size fail-closed constants; exercises the real builder from checkpoint-instrumentation
- Location: OK

### src/lib/checkpoint-answer-store.ts
- Feature: Server-only JSONL persistence + efficacy aggregation for checkpoint answer records (#2519, epic #2262)
- If removed: scripts/server.mjs:202 (checkpoint-answer capture/read routes; pinned by scripts/checkpoint-answer-route.test.mjs) and scripts/ingest.mjs:646 break
- Current: OK
- Location: OK — Node builtins only, imported by server/ingest only, types-only bridge to the browser module

### src/lib/checkpoint-instrumentation.test.ts
- Feature: Test coverage for the pure checkpoint answer-record builder (#2323)
- If removed: vitest coverage lost; nothing imports it
- Current: OK — pins fail-closed `buildCheckpointAnswerRecord`, `withLateCorrection` monotonicity, in-memory sink
- Location: OK

### src/lib/checkpoint-instrumentation.ts
- Feature: Browser-safe pure builder + sink seam for human answer-time efficacy records on the doc-comprehension checkpoint surface (#2323, epic #2262)
- If removed: src/components/CheckpointDocContext.tsx, src/components/DocRelationshipView.tsx, src/lib/checkpoint-answer-store.ts, and type imports in api-client.ts:42 / api-client.spa.ts:23 break
- Current: FINDING: stale header claim — src/lib/checkpoint-instrumentation.ts:24-27 says the durable server-side sink ("a `/api/...` capture route + append-only JSONL") "is tracked as a follow-up", but that follow-up shipped: checkpoint-answer-store.ts (#2519) exists and scripts/server.mjs:202 wires the capture route (scripts/checkpoint-answer-route.test.mjs pins it)
- Location: OK (pure, type-only imports, SPA-safe as designed)

### src/lib/experiment-arms.test.ts
- Feature: Test coverage for experiment-arm session tagging (#2096)
- If removed: vitest coverage lost; nothing imports it
- Current: OK — pins the four branch prefixes, the `exp-os/` vs `exp-o/` shared-prefix disambiguation, and kickoff-marker fallback
- Location: OK

### src/lib/experiment-arms.ts
- Feature: Spec-of-record for attributing sessions to agent-team-structure trial arms via branch prefix / kickoff marker (#2096, epic #2094)
- If removed: src/components/ExperimentSegment.tsx (registered view via view-registry.tsx) breaks; grep: `grep -rln "experiment-arms" src scripts` → only ExperimentSegment.tsx + its tests
- Current: OK
- Location: OK (pure, reads only already-ingested fields)

### src/lib/experiment-runtime/README.md
- Feature: Boundary doc for the harness-neutral experiment contract v1 (epic #2582): digest rules, external resolution, fixture corpus provenance
- If removed: human/agent orientation only — no code imports it; the boundary invariants it states are enforced by import-boundary.test.ts anyway
- Current: OK — statements verified against code (digest rules match canonical.ts; fixture path `fixtures/experiment-runtime/v1` + generator script exist). Minor: it describes only `contracts/`+`schemas/` and doesn't mention the sibling `bridges/` dir that has since landed, but its "no adapter in the boundary" claim is scoped to contracts/v1 and remains true
- Location: OK

### src/lib/experiment-runtime/bridges/gate-2702/definition.test.ts
- Feature: Test pinning the frozen gate-2702 C5 definition document and its content digest
- If removed: vitest coverage lost — the sha256 `8fffa23374…` digest that server projection and scripts hard-code would be unguarded
- Current: OK — decodes the definition through the real contracts/v1 codec and recomputes the digest
- Location: OK

### src/lib/experiment-runtime/bridges/gate-2702/definition.ts
- Feature: The immutable #2702 C5 (Haiku-solo vs Haiku+Sonnet-sidekick) experiment Definition + registry + selection binding, bridged onto contract v1
- If removed: scripts/gate-2702/run.mjs, classify.mjs, seal.mjs, evaluate.mjs, accounting.mjs all break — the whole gate-2702 live-receipt runner and its server-side verified projection chain
- Current: OK — digest matches the one asserted in gate-2702-shadow-projection.ts:16 and shadow-projection.mjs
- Location: OK — `node:crypto` import is fine; nothing SPA-reachable imports it (browser side consumes only the allowlisted projection)

### src/lib/experiment-runtime/contracts/v1/canonical.test.ts
- Feature: Test coverage for RFC 8785 canonical JSON + document/fingerprint digests
- If removed: vitest coverage lost; digest determinism unguarded
- Current: OK — validates against the checked-in fixture corpus (`fixtures/experiment-runtime/v1/valid/…`)
- Location: OK

### src/lib/experiment-runtime/contracts/v1/canonical.ts
- Feature: Canonicalization + sha256 digest engine for contract v1 documents (strict JSON domain, lone-surrogate/negative-zero rejection)
- If removed: codec.ts, index.ts, bridges/gate-2702/definition.ts, and (via the barrel) scripts/gate-2702/{seal,evaluate}.mjs + scripts/generate-experiment-contract-fixtures.mjs break
- Current: OK
- Location: OK (server-side only; `node:crypto` never reaches the SPA)

### src/lib/experiment-runtime/contracts/v1/codec.ts
- Feature: Strict decode pipeline (JSON preflight → schema → digest → registry → referential context) for Definition/Run/Verdict documents
- If removed: contracts/v1/index.ts re-exports break, taking out the gate-2702 bridge, scripts/gate-2702/evaluate.mjs + seal.mjs, and fixture-corpus.test.ts
- Current: OK — no sibling codec.test.ts, but fixture-corpus.test.ts and definition.test.ts exercise all three decoders against the corpus
- Location: OK

### src/lib/experiment-runtime/contracts/v1/fixture-corpus.test.ts
- Feature: Corpus-driven contract test — every checked-in valid/invalid/correction fixture must decode/reject exactly as manifested
- If removed: vitest coverage lost; the codec ↔ published-schema ↔ fixture triangle would be unguarded
- Current: OK — fixtures dir `fixtures/experiment-runtime/v1/` exists (manifest.json, valid/, invalid-cases.json, verdict-corrections.json), generator script present
- Location: OK

### src/lib/experiment-runtime/contracts/v1/import-boundary.test.ts
- Feature: Structural test that contracts/ + schemas/ import nothing outside the boundary (no parsers, harness homes, runtime state)
- If removed: vitest coverage lost; the README's boundary promise becomes unenforced prose
- Current: OK — walks `contracts/` and `schemas/` under the runtime root and asserts import isolation
- Location: OK

### src/lib/experiment-runtime/contracts/v1/index.ts
- Feature: Public barrel of the contract v1 boundary (canonical + codec + schema exports)
- If removed: bridges/gate-2702/definition.ts, scripts/gate-2702/seal.mjs, evaluate.mjs (+ its test), and scripts/generate-experiment-contract-fixtures.mjs break
- Current: OK
- Location: OK

### src/lib/experiment-runtime/contracts/v1/schema.ts
- Feature: Ajv 2020-12 validation of the three published wire schemas, deep-frozen and exported as `EXPERIMENT_CONTRACT_SCHEMAS_V1`
- If removed: codec.ts (schema stage) and fixture-corpus.test.ts break; the JSON schema assets would be orphaned
- Current: OK
- Location: OK

### src/lib/experiment-runtime/schemas/v1/experiment-definition.schema.json
- Feature: Published Draft 2020-12 wire schema for immutable versioned Definitions
- If removed: schema.ts JSON import fails to compile; fixture-corpus.test.ts fails
- Current: OK
- Location: OK — deliberately a sibling of contracts/ as the "published assets" half; import-boundary.test.ts covers it

### src/lib/experiment-runtime/schemas/v1/experiment-run.schema.json
- Feature: Published wire schema for immutable terminal Runs
- If removed: schema.ts JSON import fails; fixture-corpus.test.ts fails
- Current: OK
- Location: OK

### src/lib/experiment-runtime/schemas/v1/experiment-verdict.schema.json
- Feature: Published wire schema for the replaceable current Verdict
- If removed: schema.ts JSON import fails; fixture-corpus.test.ts fails
- Current: OK
- Location: OK

### src/lib/experiments/conversational-availability-metric.test.ts
- Feature: Test coverage for the shared BFC (Backgroundable-Foreground-Call) metric (#2238/#2242)
- If removed: vitest coverage lost; nothing imports it
- Current: OK — pins BLOCK_FLOOR_MS gating, backgroundable-kind + not-backgrounded + real-block-time conjunction
- Location: OK

### src/lib/experiments/conversational-availability-metric.ts
- Feature: Single shared per-session BFC metric consumed by both the recommendation detector and the experiment evaluator so the two surfaces never drift
- If removed: src/lib/detectors/workflow/conversational-availability.ts, src/lib/experiments/evaluator.ts, and src/lib/parse-timeline.test.ts break
- Current: OK
- Location: OK

### src/lib/experiments/enrollment-ledger.test.ts
- Feature: Test coverage for enrollment-ledger parsing (#2242)
- If removed: vitest coverage lost; nothing imports it
- Current: OK — pins last-line-wins re-enrollment, fail-open garbage tolerance
- Location: OK

### src/lib/experiments/enrollment-ledger.ts
- Feature: Parser for `~/.claude/experiments/enrollment.jsonl` written by the `/experiment-enroll` skill — arm-per-session ingest for the experiments surface
- If removed: scripts/server.mjs:172 (the /api/experiments route feed, pinned by scripts/experiments-route.test.mjs) and evaluator.ts's `SessionEnrollment` type break
- Current: OK
- Location: OK (pure text-in parser)

### src/lib/experiments/evaluator.test.ts
- Feature: Test coverage for the per-axis experiment verdict (#2242)
- If removed: vitest coverage lost; nothing imports it
- Current: OK — pins `MIN_SESSIONS_PER_ARM`, `EFFECT_THRESHOLD`, and the metric-normalization construction
- Current caveats match subject header (observational confidence, counter-metric provisionality)
- Location: OK

### src/lib/experiments/evaluator.ts
- Feature: Ingest+measure+qualify loop-closer producing auditable per-axis experiment verdicts (background-first axis, #2227/#2242)
- If removed: scripts/server.mjs:175 (/api/experiments verdict feed) breaks
- Current: OK — honesty contract (observational-only for menu assignment, `counterMetric: not-auto-measured`) implemented as documented
- Location: OK

### src/lib/gate-2702-shadow-projection.test.ts
- Feature: Test coverage for the bounded C5 display projection
- If removed: vitest coverage lost; nothing imports it
- Current: OK — pins the frozen definition ref digest, allowlist reconstruction, bounded evaluation counts
- Location: OK

### src/lib/gate-2702-shadow-projection.ts
- Feature: Display-safe allowlist projection of the verified #2702 C5 trial into `/api/shadow-experiments.json` (`gate2702` field) and the Gate2702Results view
- If removed: src/lib/shadow-experiments.ts:30/43 (which re-exports it to Gate2702Results.tsx and to scripts/server.mjs via the route module) and scripts/gate-2702/shadow-projection.mjs's "allowlisted TypeScript projection" call break
- Current: OK — hard-coded digest/subjects/treatments match bridges/gate-2702/definition.ts (intentional duplication: the projection must not import the bridge)
- Location: OK — pure, no node imports, safe for the lazy browser chunk

### src/lib/proof-fixture-pairs.chain.test.ts
- Feature: Test coverage for the multi-session chain extension of the proof-pair schema (#2082)
- If removed: vitest coverage lost; nothing imports it
- Current: OK — header honestly notes it is synthetic-only, not coupled to the committed manifest
- Location: OK

### src/lib/proof-fixture-pairs.test.ts
- Feature: Reproducibility guard that the committed v0.4 proof fixture bundle satisfies the pre-registration (>=12 pairs, both arms derivable, gates wired to real files)
- If removed: vitest coverage lost; the frozen-corpus guarantee of docs/v0.4-proof-preregistration.md becomes unenforced
- Current: OK
- Location: OK

### src/lib/proof-fixture-pairs.ts
- Feature: Typed schema + sanitizing loader for the v0.4 causal-proof matched-pair fixture bundle, bridging pairs into #1080 corpus tasks (#1076, epic #995)
- If removed: scripts/proof-batch.mjs:47 (the `npm run proof:batch` pipeline, package.json:101) and both proof-fixture-pairs test suites break
- Current: OK
- Location: OK (pure/deterministic; the runner deliberately lives in shadow-calls, not this repo)

### src/lib/proof-revalidation.ts
- Feature: Browser-safe proof-freshness status vocabulary (`current|stale|revoked`) shared by adoption PROOF receipts and shadow-experiment readers
- If removed: src/lib/adoption-receipts.ts:5 and src/lib/parse-shadow-calls.ts break; inlining it back into adoption-receipts would drag Node fs imports into the browser-bundled shadow parser — the exact coupling this seam exists to prevent
- Current: OK (no dedicated test; 17-line pure enum+normalizer, exercised via consumers' suites)
- Location: OK

### src/lib/proof-stats.test.ts
- Feature: Test coverage for the pre-registered v0.4 proof statistics (#1077)
- If removed: vitest coverage lost; the frozen analysis plan (Wilcoxon, seeded bootstrap, verdict rule) unguarded
- Current: OK
- Location: OK

### src/lib/proof-stats.ts
- Feature: Pure deterministic stats implementing docs/v0.4-proof-preregistration.md §4-§5 (paired-median delta, Wilcoxon, seeded bootstrap CI, PROVEN/NULL/REFUTED verdict)
- If removed: scripts/proof-batch.mjs:58 (`npm run proof:batch`) and proof-stats.test.ts break
- Current: OK
- Location: OK

### src/lib/shadow-experiments-client.spa.ts
- Feature: SPA-build stub for the `@shadow-experiments-client` seam — zero-fetch, zero-URL-literal mirror keeping the upload bundle provably server-free (#2152/#2153)
- If removed: `vite build --mode spa` breaks — vite.config.ts:232-236 aliases the seam to this file in spa/sample mode; ShadowExperimentLog.tsx:36 then fails to resolve
- Current: OK — exported surface mirrors the real client (verified: same `ShadowExperimentsResponse` shape + `fetchShadowExperiments` signature)
- Location: OK

### src/lib/shadow-experiments-client.ts
- Feature: Server-build fetcher for GET /api/shadow-experiments.json, split from api-client to keep the frozen first-paint shell budget (ADR 0016, #2371)
- If removed: the `@shadow-experiments-client` alias target for server builds (vite.config.ts:236) breaks, taking out ShadowExperimentLog.tsx and the Shadow Calls drill-down
- Current: OK — carries a `/api/` URL literal but no raw network primitive (delegates to `serverFetch` from `@api-client`), so its absence from the 7-file NETWORK_OWNERS allowlist in scripts/check-inbound-boundary.mjs is correct, and the mode-swap keeps the literal out of the SPA bundle
- Location: OK

### src/lib/shadow-experiments.test.ts
- Feature: Test coverage for the flat per-experiment row parse + trend bucketing (#2152/#2153)
- If removed: vitest coverage lost; nothing imports it
- Current: OK — pins empty-input shape, counted/synthetic/skipped disposition parity with parse-shadow-calls
- Location: OK

### src/lib/shadow-experiments.ts
- Feature: Flat one-row-per-ledger-line read of the shadow-calls ledger for the Shadow Calls drill-down log/trends and the /api/shadow-experiments.json route (epic #2147)
- If removed: src/components/ShadowExperimentLog.tsx, ShadowExperimentTrends.tsx, Gate2702Results.tsx, and scripts/server.mjs:180 (route pinned by scripts/shadow-experiments-route.test.mjs) break
- Current: OK
- Location: OK — pure text-in parser correctly shared by browser lazy chunk and server route; re-exports the gate-2702 projection as the route's single import surface

FINDINGS:
1. src/lib/checkpoint-instrumentation.ts:24-27 — stale header comment: claims the durable server-side sink ("a `/api/...` capture route + append-only JSONL") "is tracked as a follow-up", but that follow-up has shipped as src/lib/checkpoint-answer-store.ts (#2519) with the route wired at scripts/server.mjs:202 and pinned by scripts/checkpoint-answer-route.test.mjs.


### — group: config-claude (19 files) —

### src/lib/atomize-config.test.ts
- Feature: Config atomizer codemod (#1268, epic #1264) — splitting a monolithic CLAUDE.md/AGENTS.md into `.claude/rules/<topic>.md` files.
- If removed: vitest (CI `test` job) loses the only coverage of `scripts/atomize-config.mjs` — dry-run write-nothing, apply→revert byte-identical round-trip, `paths:` frontmatter, naming parity with `config-rule-naming`, the #1427 `--infer` gate. Subject exists (`scripts/atomize-config.mjs`, imports `src/lib/config-rule-naming.ts` at its line 75).
- Current: OK — header claims (parser import since #1427, detector-fed mapping) match the codemod; vitest.config.ts:41 explicitly names this suite among the child_process-driving ones the 30s timeout covers.
- Location: OK — deliberate: test lives in `src/lib/` because vitest only globs `src/**/*.test.{ts,tsx}`; it drives the scripts/ codemod via `execFileSync`.

### src/lib/claude-api.ts
- Feature: Ask Claude BYO-key chat — browser-direct Anthropic Messages API client (key in localStorage, no server custody).
- If removed: `src/components/AskClaude.tsx` (chat + model calls), `src/components/Settings.tsx` (key/model picker), and `src/components/AskClaude.test.ts` break.
- Current: OK — models delegated to `model-registry`; key custody split to `api-key` (#2371) with re-exports preserved. Carries `api.anthropic.com` fetch literals but is sanctioned by name in `scripts/check-inbound-boundary.mjs` NETWORK_OWNERS (line 30, "governed by ADR 0008, not the chokepoint").
- Location: OK.

### src/lib/claude-context.test.ts
- Feature: Ask Claude per-view context builders — bounded repo-map injection (#891, epic #871).
- If removed: vitest loses the pins on the two #891 acceptance bullets: repo-map slice strictly enforced under `DEFAULT_REPO_MAP_TOKEN_CAP`, and clean omission (no `repoMap` key) when the server-only dataset is absent.
- Current: OK — imports match `claude-context.ts` exports.
- Location: OK.

### src/lib/claude-context.ts
- Feature: Ask Claude panel — per-view ~10KB JSON context summaries attached to the user prompt.
- If removed: `src/components/AskClaude.tsx` (value + `ContextPayload` type imports at lines 45/160) and `AskClaude.test.ts` break.
- Current: OK — pure builders, no `/api/` literals, no node imports; safe on both SPA and server paths.
- Location: OK.

### src/lib/claude-md-append.test.ts
- Feature: Opt-in mid-session CLAUDE.md fix append (#584, ADR 0005 item #10).
- If removed: vitest loses the pins on `appendClaudeMdFix`: append-only byte preservation, idempotent `already-applied` via `claudeMdMarksApplied`, `not-applicable` rejection of non-CLAUDE.md fixes.
- Current: OK — matches the subject's exports.
- Location: OK.

### src/lib/claude-md-append.ts
- Feature: Dashboard-owned contract for the agent-side "apply this fix to my project CLAUDE.md" opt-in append (recs skill).
- If removed: only `src/lib/claude-md-append.test.ts` breaks. No runtime consumer exists anywhere: `grep -rln claude-md-append` over the repo hits only the test, and `grep -rln claude-md-append ~/.agents/skills ~/.claude/skills/recs` is empty — the executable wiring the header defers to (meta, shpwrck/claude#12) has not landed. Dormant contract module, not a clean removal candidate (deliberate design), but see FINDINGS.
- Current: OK — header honestly states the wiring is external/meta; content matches ADR 0005.
- Location: OK.

### src/lib/claude-tree-classification.test.ts
- Feature: ADR 0009 config/session-data/secret classification of ~/.claude paths.
- If removed: vitest loses the classifier pins AND the load-bearing byte-for-byte DRIFT GUARD between `src/lib/claude-tree-classification.ts` and its zero-dep mirror `probaitio-operator/dispatch/artifact-ship.mjs` (it imports both and cross-checks).
- Current: OK.
- Location: OK.

### src/lib/claude-tree-classification.ts
- Feature: Enterprise/hub ingest safety — the ONE canonical classifier keeping `.credentials*`/`paste-cache`/keys out of the config bake and artifact shipper.
- If removed: `scripts/server.mjs:5696` (dynamic import in `POST /api/ingest/:id/artifacts`), `scripts/server-runtime-import-guard.test.mjs` (proves that import resolves in the zero-node_modules runtime), and the drift-guard test break; the shipper mirror in `probaitio-operator/dispatch/artifact-ship.mjs` would lose its reference copy.
- Current: OK — secret-first ordering and regex sets match the test and the mirror.
- Location: OK.

### src/lib/config-hygiene-actions.ts
- Feature: Config Hygiene "act on it" affordance — copyable removal/JSON-mutation shell snippets per hygiene finding.
- If removed: `src/components/affordance/ConfigFindingActions.tsx`, `src/lib/detectors/safety/config-hygiene-rollup.ts` (`buildConfigRemovalSnippetBlock`), and the four `detectors/workflow/unused-installed-{skills,subagents,plugins,commands}.ts` detectors break.
- Current: OK — pure string building (the `node:fs` hit is inside a generated snippet string, not an import).
- Location: OK.

### src/lib/config-hygiene.test.ts
- Feature: P/I/U config-hygiene engine (#172/#174).
- If removed: vitest loses the direct `computeConfigHygiene` pins (LiveConfig × SessionAttribution fixtures, scope rollup / recency behavior). Thin (6 cases for a 1032-line module) but supplemented by `ConfigHygiene.test.ts`, `recommendations.test.ts`, and the unused-installed detector suites.
- Current: OK.
- Location: OK.

### src/lib/config-hygiene.ts
- Feature: Config Hygiene view + "installed but unused" recommendation family; also settings.json validation.
- If removed: `ConfigHygiene.tsx`, `Recommendations.tsx`, `ConfigFindingActions.tsx`, `config-hygiene-actions.ts`, `detectors/safety/config-hygiene-rollup.ts`, the four `unused-installed-*` detectors, `detectors/reliability/settings-json-invalid.test.ts`, and `config-loader.ts` (`validateSettingsJson`) all break.
- Current: OK — pure (no node imports), so its dual SPA-component/server-loader consumption is sound.
- Location: OK.

### src/lib/config-loader.test.ts
- Feature: Live-config assembly (#627 slice 1) — settings/CLAUDE.md/plugins/MCP/skills loading.
- If removed: vitest loses the pins on `assembleLiveConfig` (names-only host env observation into settings validation), `hookReferencedTargetsSignature`, `hostEnvironmentObservationSignature`, `readStopHookConfigState`, and the wiring into the `settings-json-invalid` and `skill-hook-integrity` detectors.
- Current: OK.
- Location: OK.

### src/lib/config-loader.ts
- Feature: Server-side liveConfig bundle assembly for the dataset endpoint (single-user and enterprise scoped ingest).
- If removed: `scripts/ingest.mjs:2109` (dynamic `.ts` import under the register-ts loader), `src/lib/parse-backups.ts` and `src/lib/parse-external-guidance.ts` (value imports of `CONFIG_FILE_MAX_BYTES`/`readTextFileCappedSync`), and its test break.
- Current: OK. Node-only (`node:fs`, `node:crypto`) yet never reaches the SPA bundle: every component-side import of `parse-backups`/`parse-external-guidance` is `import type` (App.tsx:121, Permissions.tsx:20, Recommendations.tsx:76, DigestSpine.tsx:99, view-registry.tsx:71, detectors/types.ts:44-57), so it erases at build.
- Location: OK.

### src/lib/config-rule-naming.ts
- Feature: Shared rule-file naming (slug + subtree) between the over-scoped-config-section detector (#1267) and the atomizer codemod (#1268) so adoption tracking joins on one path.
- If removed: `src/lib/detectors/context/over-scoped-config-section.ts`, `scripts/atomize-config.mjs` (imports it from plain Node at line 75 — hence the deliberate zero-dependency constraint), and `atomize-config.test.ts` break, reintroducing the pre-#1427 slug-mismatch bug the header documents.
- Current: OK.
- Location: OK.

### src/lib/hook-overhead-snippet.test.ts
- Feature: Stop-hook overhead corrective (#1806, epic #1485).
- If removed: vitest loses the pins that the corrective quotes the actual measured mean/max/timed-count (never fabricates) and escalates at the detector heavy bar (>=5s).
- Current: OK.
- Location: OK.

### src/lib/hook-overhead-snippet.ts
- Feature: Agents → Runtime Telemetry — copyable prose corrective for slow Stop-hook overhead.
- If removed: `src/components/AgentSkill.tsx:62` (`hookOverheadCorrective`) and its test break.
- Current: OK — header's rationale (no stable per-hook id, ~7% duration coverage, prose over shell snippet) matches #261/#710; pure string transform, SPA-safe as claimed.
- Location: OK.

### src/lib/permission-rules.ts
- Feature: Permissions analysis — conservative parse/match of `Tool(specifier)` permission rules (direct-prefix subset).
- If removed: `src/lib/parse-permissions.ts` (parse-time derivation) and `src/lib/detectors/shared.ts` (re-exports to the detector layer) break.
- Current: OK — dependency-free leaf as its header requires (no parser/detector imports, so no cycle).
- Location: OK.

### src/lib/policy-writer.test.ts
- Feature: Policy Builder write-back (#199/#625, hardened #2062).
- If removed: vitest loses the unit pins on `validatePolicyInput` / `mergeAndDedupe` / `applyPolicyWrite` — grammar validation, corrupt-file refusal, timestamped backup before write, atomic temp+rename, backup pruning — leaving only the HTTP-level `scripts/policy-write.test.mjs` surface the extraction was done to escape.
- Current: OK.
- Location: OK.

### src/lib/policy-writer.ts
- Feature: The one route that mutates the user's global `~/.claude/settings.json` (Policy Builder) — pure validate/merge/dedupe core + backup/atomic-write contract.
- If removed: `scripts/server.mjs:191` (dynamic import; the HTTP handler now only frames these results — comments at server.mjs:4536/5095 point here), `scripts/checkpoint-answer-route.test.mjs`, and its unit test break.
- Current: OK — header history (#625 extraction, #2062 hardening: atomic rename, per-file serialisation, MAX_POLICY_BACKUPS pruning, grammar validation) matches the code and server.mjs comments.
- Location: OK.

FINDINGS:
1. `src/lib/claude-md-append.ts` is a dormant contract module: its only importer anywhere is its own test. The runtime consumer it was written for (the agent-side `recs` skill append flow, wiring deferred as meta shpwrck/claude#12 per the file header) has never landed — `grep -rln claude-md-append` hits only `src/lib/claude-md-append.test.ts` in-repo, and the same grep over `~/.agents/skills`/`~/.claude/skills/recs` is empty. Either land the #12 wiring or decide to drop the module; as shipped it is tested dead code.


### — group: docs-repomap (25 files) —

### src/lib/doc-contract.ts
- Feature: Doc-graph hygiene (epic #2256, #2472) — the browser-safe doc-category vocabulary (`DOC_CATEGORIES`, `isDocCategory`) shared by the server doc-graph parser and the browser-bundled doc-hygiene detector.
- If removed: `src/lib/parse-docs.ts` (server doc-graph build) and `src/lib/detectors/maintenance/doc-hygiene.ts` (+ both tests) fail to compile — the doc-hygiene recommendation and category validation of `category:` frontmatter break.
- Current: OK — zero-import module, matches its stated contract.
- Location: OK — deliberately placed as the dependency-free seam between the server parser and the browser detector.

### src/lib/doc-git-times.test.ts
- Feature: CI (vitest via test.yml) pinning of the git-times manifest consumer.
- If removed: fail-closed validation of the #2707 manifest (schema, commit binding, path bounds, future-date rejection — "every rejection path yields NO times") loses regression coverage.
- Current: OK — imports (`DOC_GIT_TIMES_MAX_ENTRIES`, `isValidManifestDocPath`, `parseDocGitTimesManifest`) match the subject's exports.
- Location: OK — co-located with subject.

### src/lib/doc-git-times.ts
- Feature: Doc freshness provenance in the container deploy (#2707, epic #2256) — pure fail-closed consumer contract for the packaged per-doc Git-time manifest, so Docker COPY mtimes are never mistaken for Git history.
- If removed: `src/lib/parse-docs.ts` (`readDocGitTimes`), `src/lib/detectors/maintenance/doc-hygiene.ts`, `src/lib/docker-docs-runtime.test.ts`, and `scripts/doc-git-times-parity.test.mjs` break; the producer `scripts/doc-git-times-generate.mjs` (run by `scripts/deploy.sh:102`) loses its consumer, degrading doc-staleness claims to `filesystem` provenance.
- Current: OK — browser-safe (no node imports), `DOC_GIT_TIMES_RELPATH = 'data/doc-git-times.json'` matches the Dockerfile/gitignore invariants pinned in docker-docs-runtime.test.ts.
- Location: OK — pure/Node split mirrors the documented `external-guidance.ts` precedent.

### src/lib/doc-hygiene-artifact.test.ts
- Feature: CI pinning of the doc-hygiene artifact parser.
- If removed: fail-closed parse of the host-produced artifact (`parseDocHygieneArtifact`, `docHygieneArtifactFilename`) loses coverage for schema rejection paths.
- Current: OK — imports match subject exports.
- Location: OK.

### src/lib/doc-hygiene-artifact.ts
- Feature: Doc-hygiene recommendation pipeline (#2486) — runtime contract for the artifact `scripts/doc-hygiene-run.mjs` writes under `~/.claude/usage-data/doc-hygiene/`.
- If removed: `scripts/ingest.mjs:730` (dynamic import) and `scripts/doc-hygiene-run.mjs:863` fail at server boot/producer run; `src/lib/detectors/types.ts` and `src/lib/detectors/maintenance/doc-hygiene.ts` fail to compile — the maintenance doc-hygiene recommendation dies.
- Current: OK — dependency-free as its header requires (zero-node_modules server imports it).
- Location: OK.

### src/lib/doc-issue-fetch.test.ts
- Feature: CI pinning of the opt-in GitHub issue-state fetcher.
- If removed: coverage lost for GraphQL batching caps, atomic 0600 cache, credential non-persistence, and the 15m-reuse/24h-usable refresh policy (#2710).
- Current: OK — imports match subject exports.
- Location: OK.

### src/lib/doc-issue-fetch.ts
- Feature: Opt-in (`CHD_DOC_ISSUES`) GitHub issue-state snapshot for the doc graph (#2710) — the Node half: GraphQL fetch, credential read, SSRF/byte caps, atomic cache, single-flight refresh.
- If removed: `scripts/ingest.mjs:707` (dynamic import; exposes `refreshDocIssueSnapshotForServer` consumed at `scripts/server.mjs:1413` in the dataset-route ingest preamble) breaks. No SPA/src consumer besides its test — correct, since it uses `node:fs`/`node:crypto`.
- Current: OK — server-only, never bundled; flag-off default path stays zero-external-call per the non-local-data rule.
- Location: OK — server-only module in src/lib follows the established `parse-docs.ts` pattern; not in the SPA reachability graph.

### src/lib/doc-issue-snapshot.test.ts
- Feature: CI pinning of snapshot schema/freshness helpers.
- If removed: coverage lost for fail-closed validation, ref-set identity binding, state normalization, and reuse/usable freshness predicates.
- Current: OK — imports match subject exports.
- Location: OK.

### src/lib/doc-issue-snapshot.ts
- Feature: Browser-safe schema half of the #2710 issue-state carrier — types, strict validation, GitHub-state normalization, freshness predicates shared by producer and consumers.
- If removed: `src/lib/doc-issue-fetch.ts`, `src/lib/detectors/types.ts`, `src/lib/detectors/maintenance/doc-hygiene.ts`, `src/App.tsx:132`, and `src/lib/view-registry.tsx:78` fail to compile — both the server producer and the UI freshness display break.
- Current: OK — no `node:*` imports, honoring its BROWSER-SAFE banner; no `/api/` literals (boundary respected).
- Location: OK.

### src/lib/doc-neighborhood-inject.test.ts
- Feature: CI pinning of the agent-inject surface (#2322).
- If removed: coverage lost for injection payload shape, null-suppression gating, demoted/as-of stale presentation, and trigger provenance citing node id + flag kind.
- Current: OK — imports match subject exports.
- Location: OK.

### src/lib/doc-neighborhood-inject.ts
- Feature: Doc-comprehension routing bridge (#2322, epic #2262) — turns the #2263 neighborhood into an agent injection payload plus the #1934 ambiguity-trigger signal.
- If removed: `scripts/doc-neighborhood-inject.mjs:107` (dynamic import) breaks, which kills both the CLI producer and the plugin MCP `doc_neighborhood` tool (`scripts/mcp-shim.mjs:167` spawns that script).
- Current: OK — pure, type-only imports from `parse-docs`/`detectors/types`; honest epistemics (no `estSavingsUsd` claim) as documented.
- Location: OK.

### src/lib/doc-neighborhood.test.ts
- Feature: CI pinning of the pure doc-neighborhood retrieval (#2263).
- If removed: coverage lost for hop-bounded clustering, centrality/recency/status ranking, hygiene flags, ambiguity trigger, and anchor resolution (slug/issue/file).
- Current: OK — imports match subject exports.
- Location: OK.

### src/lib/doc-neighborhood.ts
- Feature: Reader-agnostic doc-neighborhood retrieval (#2263) — the shared core under both the agent-inject and the human relationship view.
- If removed: `doc-neighborhood-inject.ts`, `src/components/DocRelationshipView.tsx`, `src/components/DocHygieneBadges.tsx`, `src/components/CheckpointDocContext.tsx`, `src/lib/checkpoint-answer-store.ts`, `src/lib/checkpoint-instrumentation.ts`, and `src/lib/sample-doc-neighborhood.ts` all break — the docs relationship view, checkpoint doc-context, and MCP inject path die together.
- Current: OK — pure (no I/O, no `Date.now`), type-only imports from `parse-docs`, so browser-safe as claimed.
- Location: OK.

### src/lib/doc-relationship.ts
- Feature: Human doc-relationship view (#2323) — induces the `md-link` sub-graph (links/backlinks) over a neighborhood so the view stays a thin presenter.
- If removed: `src/components/DocRelationshipView.tsx` and `src/lib/sample-doc-neighborhood.ts` (+ their tests) fail to compile.
- Current: OK — pure, type-only imports; no dedicated test file, but its behavior is exercised through `sample-doc-neighborhood.test.ts` and `DocRelationshipView.test.tsx`.
- Location: OK.

### src/lib/docker-docs-runtime.test.ts
- Feature: Container-deploy packaging invariants for doc-graph inputs (#2380/#2707/#2709) — asserts the Dockerfile COPYs root `*.md`, `docs/`, and `data/` (git-times manifest), and the manifest is git-ignored but not dockerignored.
- If removed: nothing imports it (vitest is the consumer); the runtime image could silently stop shipping the docs tree or git-times manifest — doc graph goes empty in the container with no CI signal.
- Current: OK — intentionally has no same-name subject module; its subject is the Dockerfile/.gitignore/.dockerignore, cross-checked against the live `DOC_GIT_TIMES_RELPATH`/`DOCS_MAP_RELPATH` constants so it can't drift from the code.
- Location: Acceptable — must live under `src/**` for the vitest glob; slightly unusual home for a Dockerfile test but self-explanatory.

### src/lib/repo-map/cache.test.ts
- Feature: CI pinning of repo-map persistence hardening (#893).
- If removed: coverage lost for `computeCacheKey`/`isCacheValid` (sha vs mtime signatures), `enforceSizeLimit` trimming, `assertNoBodyLeakage`, and `artifactPathFor`.
- Current: OK — uses a deterministic fake parser so it runs without WASM; imports match subject exports.
- Location: OK.

### src/lib/repo-map/cache.ts
- Feature: Repo Map artifact cache + size hardening (#893, ADR 0007) — signature-gated reuse, 1 MiB size cap, body-leak guard, artifact path encoding for the host producer.
- If removed: `scripts/repo-map-generate.mjs` (via the index barrel), `scripts/ingest.mjs:2105` (`artifactPathFor`, `unwrapPersistedRepoMap`), `scripts/doc-hygiene-run.mjs:861`, `scripts/repo-map-refresh.test.mjs`, and the parity/fence tests (`repo-map-artifact-path-parity`, `doc-hygiene-artifact-path-parity`, `parser-output-versions.fence`) all break — both producing and ingesting repo-map artifacts (the `repo-map-context-waste` rec's data) die.
- Current: OK — the `@ts-expect-error` import of `scripts/lib/parser-output-versions.mjs` is a documented single-seam design (#2075), not drift.
- Location: OK — host-only module; never reachable from the SPA bundle (only scripts import it).

### src/lib/repo-map/file-cache.test.ts
- Feature: CI pinning of the per-file parse cache (#2327).
- If removed: coverage lost for cohort-wide salt/schema invalidation, entry/byte bounds, and corrupt/oversize tolerance (cold-cache event, never a generation failure).
- Current: OK — imports match subject exports.
- Location: OK.

### src/lib/repo-map/file-cache.ts
- Feature: Host-only disposable per-file parse cache (#2327) — makes repo-map regeneration incremental instead of a full WASM re-parse per refresh.
- If removed: `src/lib/repo-map/index.ts` re-exports break, and `scripts/repo-map-generate.mjs` (destructures `createRepoMapFileCache`, `DEFAULT_REPO_MAP_FILE_CACHE_MAX_BYTES`) fails — every `npm run deploy` repo-map refresh reverts to cold full parses.
- Current: OK — persists no raw source/mtimes/RepoFile records as documented.
- Location: OK.

### src/lib/repo-map/generate.test.ts
- Feature: CI pinning of the walk/rank/render/budget logic via a deterministic fake `ParseFile` (no WASM needed).
- If removed: coverage lost for directory ignore-list, in-degree ranking, token-budgeted rendering, and file caps.
- Current: OK.
- Location: OK.

### src/lib/repo-map/generate.ts
- Feature: Repo Map generator (#887, ADR 0007) — walks a root, extracts structure via injected `ParseFile`, ranks by import in-degree, renders a token-capped privacy-safe map (no source bodies).
- If removed: `src/lib/repo-map/index.ts` (→ `scripts/repo-map-generate.mjs`, run by `npm run deploy` / `scripts/deploy.sh`) and cache/file-cache tests break — no repo-map artifacts get produced.
- Current: OK.
- Location: OK — host-only, correctly outside the runtime/SPA reachability graph.

### src/lib/repo-map/index.ts
- Feature: Barrel/public surface of the repo-map substrate for the host producer.
- If removed: `scripts/repo-map-generate.mjs:37` (dynamic import of the whole surface: `generateRepoMap`, `enforceSizeLimit`, `artifactPathFor`, `createRepoMapFileCache`, `createTsParseFile`, …) and `scripts/repo-map-artifact-path-parity.test.mjs` break.
- Current: OK — header restates the ADR 0007 invariant (parser never imported by server.mjs/SPA), which holds in the import graph.
- Location: OK.

### src/lib/repo-map/parser.test.ts
- Feature: CI pinning that the real pinned WASM pair (`web-tree-sitter@0.20.8` + `tree-sitter-wasms@0.1.13`) loads and extracts correct symbols/imports.
- If removed: a dependency bump to an incompatible dylink format (0.25+) would pass typecheck and only fail at deploy-time generation.
- Current: OK — package.json carries `^0.20.8`/`^0.1.13`; caret semantics on 0.x keep the resolvable range below the breaking 0.21/0.2 lines, so the "pinned pair" comment is honest in effect.
- Location: OK.

### src/lib/repo-map/parser.ts
- Feature: WASM Tree-sitter TS/JS structure extractor (#887, ADR 0007) — host/CI-only, where devDeps exist.
- If removed: `src/lib/repo-map/generate.ts` (`createTsParseFile`), `index.ts`, `file-cache.test.ts`, and `scripts/repo-map-refresh.test.mjs` break — real (non-fake-parser) map generation dies.
- Current: OK — never imported by `scripts/server.mjs` or SPA-reachable code, so the zero-node_modules runtime invariant holds; shares the #2075 version seam with cache.ts.
- Location: OK.

### src/lib/repo-map/types.ts
- Feature: Shared repo-map vocabulary (RepoMap/RepoFile/RepoSymbol/ParseFile) plus `RepoMapParserInitializationError`.
- If removed: every repo-map module breaks, and the browser side breaks too — `src/lib/parse-repo-map-join.ts` (type-only import feeding `RepoMapDataset` into App.tsx, Recommendations, AskClaude, DigestSpine, detectors) fails to compile.
- Current: OK — types-only module, so the browser's type-only imports erase at build (SPA boundary safe).
- Location: OK.

FINDINGS: none


### — group: api-net (30 files) —

### src/lib/anthropic-egress.test.ts
- Feature: Vitest pins for the server Anthropic-egress chokepoint (ADR 0008 governance).
- If removed: coverage loss only — consumer is vitest via CI `test` job (test.yml globs src/**/*.test.ts). Subject `./anthropic-egress` exists.
- Current: OK — imports (`callAnthropic`, `callAnthropicMessages`, `egressScrub`, errors) and the `llm-registry` validators match live exports; also cross-checks registry call sites by reading source files with node:fs (test-only, allowed).
- Location: OK (co-located with subject).

### src/lib/anthropic-egress.ts
- Feature: The single governed server→api.anthropic.com chokepoint (#931/ADR 0008): credential class, scrub receipts, cap receipts enforced before any network call.
- If removed: `scripts/server.mjs:250` dynamic-imports it (`callAnthropic` for `server.usage-gauge` at :4497, `callAnthropicMessages` for `server.audit-judge` at :10586) — both server LLM routes break; `scripts/check-llm-egress.mjs` (CI `gate:llm-egress`) fails because registered egress ids lose their runtime call sites; `anthropic-egress.test.ts` fails.
- Current: OK — registry ids, OAuth-vs-console-key split, and scrub/cap receipt contracts match `llm-registry.ts` and server usage.
- Location: OK — server-only module; correctly NOT in `NETWORK_OWNERS` (it is not fetched from browser code; server.mjs loads it via register-ts import, outside the inbound-boundary walk which only covers src consumers of `fetch(`).

### src/lib/api-client.recommendation-surface.test.ts
- Feature: Pins the exact scoped query string + cancellation semantics of `fetchRecommendationSurface` (the `/recs` surface contract).
- If removed: coverage loss only — vitest/CI is the consumer; subject export exists in `api-client.ts`.
- Current: OK — asserts URL literal `/api/recommendations.json?surface=...`, abort signal forwarding, non-OK rejection; matches the live client.
- Location: OK.

### src/lib/api-client.spa.ts
- Feature: SPA-build stub of the server chokepoint — `vite build --mode spa` aliases `@api-client` here so the upload-only bundle is provably free of server strings (`SERVER_AVAILABLE = false`).
- If removed: `vite.config.ts:223` alias target breaks (SPA build fails); `scripts/check-inbound-boundary.mjs:26` allowlist entry dangles; `api-client.test.ts` parity imports fail; the `spa-boundary` CI job loses its mechanism.
- Current: OK — no URL literals, no fetch, type-only imports (incl. `AuditFinding` from `./audit/types`, erased at compile).
- Location: OK — must sit beside `api-client.ts` for the alias swap; sanctioned NETWORK_OWNERS member.

### src/lib/api-client.test.ts
- Feature: Pins enterprise auth-session semantics (403/429 handling), audit-run/checkpoint fetchers, and server↔SPA stub parity (`fetchAuditRun`/`postCheckpointAnswer` from both builds).
- If removed: coverage loss only — vitest/CI consumer; both subjects exist.
- Current: OK — imports match live exports of `api-client.ts`, `api-client.spa.ts`, `enterprise-capabilities.ts`.
- Location: OK.

### src/lib/api-client.ts
- Feature: THE server chokepoint (#324) — every frontend call to the dashboard backend (all `/api/*` literals, dataset worker, EventSource) lives here and nowhere else.
- If removed: ~50 consumers via the `@api-client` alias (App.tsx, view-registry, most components), `vite.config.ts:220` default alias target, `check-inbound-boundary.mjs` allowlist anchor, three test files — the entire live (non-SPA) frontend breaks.
- Current: OK — head doc accurately describes the alias mechanism, completeness-signal conventions (#1621), and SPA guard.
- Location: OK — sanctioned NETWORK_OWNERS #1.

### src/lib/api-key.ts
- Feature: Browser custody of the user-pasted BYO Ask-Claude Anthropic key (sessionStorage, with one-shot localStorage migration, #2063), split out of `claude-api.ts` for eager-chunk weight (#2371).
- If removed: `src/lib/claude-api.ts:24` (re-exports for Settings/Ask-Claude) and `src/App.tsx:34` (eager first-paint `getApiKey` read) break.
- Current: OK — dependency-free, no network; storage-key constant and migration logic match the doc.
- Location: OK — deliberate eager-graph leaf; keep separate from claude-api.ts.

### src/lib/audit/agentic-opportunities.test.ts
- Feature: Pins the agentic-opportunity audit (#741): recurring-sequence detection → injected-judge path + per-candidate failure isolation.
- If removed: coverage loss only — vitest/CI consumer; subject exists.
- Current: OK — imports match subject exports; type-only `JudgeFn from './judge'` still valid via re-export.
- Location: OK.

### src/lib/audit/agentic-opportunities.ts
- Feature: Tier-3 audit detecting recurring manual tool sequences worth converting to agentic workflows, cost-weighted (#605/#741), served via `/api/audit.json`.
- If removed: `audit/judge.ts` (imports `detectRecurringSequences`/`runAgenticOpportunityAudit`) breaks, which breaks the server audit route; its test fails.
- Current: OK — head honestly documents #741 spec drift (nonexistent APIs it substitutes real ones for).
- Location: OK.

### src/lib/audit/boomerang-rework.test.ts
- Feature: Pins the boomerang/rework-rate audit (#742): high-rework selection → judge → rate computation; skipped candidates drop out of the denominator.
- If removed: coverage loss only — vitest/CI consumer; subject exists.
- Current: OK.
- Location: OK.

### src/lib/audit/boomerang-rework.ts
- Feature: Tier-3 audit of shipped-work bounce-back rate, reusing existing rework/churn signals (no git in the container) (#605/#742).
- If removed: `audit/judge.ts` import breaks → `/api/audit.json` harness breaks; test fails.
- Current: OK — no-git rationale matches the read-only `~/.claude`-mount deployment reality.
- Location: OK.

### src/lib/audit/judge-deceit.test.ts
- Feature: Pins the judge-based deceit audit (#687): the marquee "said X, did narrower Y" case the Slice-B deterministic rules provably miss.
- If removed: coverage loss only — vitest/CI consumer; subject exists.
- Current: OK.
- Location: OK.

### src/lib/audit/judge-deceit.ts
- Feature: Tier-3 transcript-level deceit audit (undisclosed semantic shortcuts), server-only because only the server holds transcripts (#687, epic #683 slice C).
- If removed: `audit/judge.ts` import breaks → `/api/audit.json` harness breaks; test fails.
- Current: OK — `getTranscript` is injected (line 203), matching the "route wires brotli decompression" design.
- Location: OK.

### src/lib/audit/judge-types.ts
- Feature: Dependency-free leaf holding the injectable judge contract (`JudgeFn`/`JudgeVerdict`), hoisted from `./judge` to break the madge type-cycle (#1582).
- If removed: value/type imports in `judge.ts` and the six per-audit modules (`judge-deceit`, `mcp-adoption-gap`, `boomerang-rework`, `agentic-opportunities`, `start-stop-oracle`, `natural-experiment`) break.
- Current: OK. Minor: its doc comment (lines 5-7) lists the per-audit modules judge.ts imports but omits `skill-candidates` — cosmetic, not load-bearing.
- Location: OK — true leaf, only depends on `./types`.

### src/lib/audit/judge.test.ts
- Feature: Pins the harness run/aggregate entrypoint (#738): reference audit, `parseVerdict`, and the no-injected-judge → `[]` degrade the route relies on.
- If removed: coverage loss only — vitest/CI consumer; subject exists.
- Current: OK.
- Location: OK.

### src/lib/audit/judge.ts
- Feature: Tier-3 judge-audit harness entrypoint — aggregates all per-audit modules, exports `runAudits`/`makeClaudeJudge`/`makeClaudeDraftJudge` (lines 292/311/354) with the governed chat fn injected by the server.
- If removed: `scripts/server.mjs:271` dynamic import breaks → `/api/audit.json` route dies; all eight audit test files that import `JudgeFn from './judge'` break.
- Current: OK — network egress correctly stays outside (injected), keeping the audit core SPA-safe.
- Location: OK.

### src/lib/audit/mcp-adoption-gap.test.ts
- Feature: Pins the MCP adoption-gap audit (#740), especially the installed-vs-gap exclusion.
- If removed: coverage loss only — vitest/CI consumer; subject exists.
- Current: OK.
- Location: OK.

### src/lib/audit/mcp-adoption-gap.ts
- Feature: Tier-3 audit surfacing a beneficial-but-not-installed MCP server from tool-usage capability signals (#605/#740).
- If removed: `audit/judge.ts` import breaks → `/api/audit.json` harness breaks; test fails.
- Current: OK — documents #740 spec drift (nonexistent `readMcpServers`) and the real `ds.liveConfig.mcpServers` input.
- Location: OK.

### src/lib/audit/natural-experiment.test.ts
- Feature: Pins the natural-experiment OLS audit (#744): synthetic known-answer fit, insufficient-data gate, singular-design degrade.
- If removed: coverage loss only — vitest/CI consumer; subject exists.
- Current: OK.
- Location: OK.

### src/lib/audit/natural-experiment.ts
- Feature: Tier-3 confound-controlled model/tool outcome regression (OLS with difficulty covariate), honesty-contracted output (#605/#744).
- If removed: `audit/judge.ts` import breaks → `/api/audit.json` harness breaks; test fails.
- Current: OK.
- Location: OK — largest audit module (632 lines) but the pure fit/design-matrix core justifies it.

### src/lib/audit/skill-candidates.test.ts
- Feature: Pins the skill-candidate audit (#739): successful-trajectory mining → draft-judge, plus the PROPOSE-ONLY / no-fs-write guarantee (reads subject source to assert no fs import).
- If removed: coverage loss only — vitest/CI consumer; subject exists.
- Current: OK.
- Location: OK.

### src/lib/audit/skill-candidates.ts
- Feature: Tier-3 audit drafting reusable skill/command/CLAUDE.md-rule proposals from recurring successful tool trajectories, propose-only (#605/#739).
- If removed: `audit/judge.ts` (imports `detectSuccessfulTrajectories`/`runSkillCandidateAudit`/`parseDraftVerdict`) breaks → `/api/audit.json` harness breaks; test fails.
- Current: OK.
- Location: OK.

### src/lib/audit/start-stop-oracle.test.ts
- Feature: Pins the start/stop-oracle audit (#743): opener-feature extraction, risky-feature ranking, judge-confirm single-finding path.
- If removed: coverage loss only — vitest/CI consumer; subject exists.
- Current: OK.
- Location: OK.

### src/lib/audit/start-stop-oracle.ts
- Feature: Tier-3 audit predicting "don't start / stop early" from session-opener traits vs historical bad outcomes (#605/#743).
- If removed: `audit/judge.ts` import breaks → `/api/audit.json` harness breaks; test fails.
- Current: OK.
- Location: OK.

### src/lib/audit/types.ts
- Feature: Leaf type module for tier-3 judge audits — `AuditFinding`/`AuditDomain`/`AuditConfidence`, the wire shape of `/api/audit.json`.
- If removed: every audit module, `judge-types.ts`, plus type-only consumers `api-client.ts:35`, `api-client.spa.ts:16`, and `src/components/Recommendations.tsx:86` break.
- Current: FINDING — stale doc claim at `src/lib/audit/types.ts:12-14`: "This module is SERVER-ONLY. It is imported solely by `scripts/server.mjs` behind the `/api/audit.json` route and is never pulled into the SPA bundle." The "imported solely" clause is false: it is type-imported by `api-client.ts`, `api-client.spa.ts`, and `Recommendations.tsx` (all SPA-reachable). The runtime never-in-SPA-bundle claim still holds (type-only imports are erased), but the sentence misdescribes the import graph.
- Location: OK.

### src/lib/enterprise-capabilities.test.ts
- Feature: Pins the enterprise capability gate truth table (single-user pass-through vs enterprise per-capability check).
- If removed: coverage loss only — vitest/CI consumer; subject exists.
- Current: OK.
- Location: OK.

### src/lib/enterprise-capabilities.ts
- Feature: Pure capability gate (`enterpriseCapabilityAllowed`) deciding whether the current `EnterpriseSession` may use an enterprise feature — feeds enterprise-mode UI gating.
- If removed: `src/App.tsx`, `src/lib/view-registry.tsx`, three `App.*.test.tsx` files, and `api-client.test.ts` break.
- Current: OK — fail-closed on error/unauthenticated/unconfigured; type-only `@api-client` import keeps it SPA-safe.
- Location: OK.

### src/lib/enterprise-posture.test.ts
- Feature: Pins security-control posture counting and action-required-first ordering.
- If removed: coverage loss only — vitest/CI consumer; subject exists.
- Current: OK.
- Location: OK.

### src/lib/enterprise-posture.ts
- Feature: Pure summarize/order helpers for enterprise security controls, rendered by the admin dashboard.
- If removed: `src/components/EnterpriseAdmin.tsx` (its only non-test consumer) breaks.
- Current: OK. Minor: imports types via relative `./api-client` (line 1) rather than the `@api-client` alias used by its sibling `enterprise-capabilities.ts` — harmless (type-only, erased) but inconsistent with the chokepoint-alias convention.
- Location: OK.

### src/lib/llm-registry.ts
- Feature: Governance registry of every intentional Anthropic egress path (3 ids: `server.usage-gauge`, `server.audit-judge`, `browser.ask-claude`) — credential class, data class, scrub mode, caps.
- If removed: `anthropic-egress.ts:1-5` (types + `getLlmUsageEntry`), `scripts/server.mjs:254`, the CI `gate:llm-egress` (`scripts/check-llm-egress.mjs:26`), and `scripts/generate-llm-usage-registry-doc.mjs:14` (reviewer-facing doc generation) all break; `anthropic-egress.test.ts` fails.
- Current: OK — registry ids match the live server call sites (server.mjs:4497, :10586) and the browser BYO path in `claude-api.ts`.
- Location: OK — beside its chokepoint consumer.

FINDINGS:
1. `src/lib/audit/types.ts:12-14` — stale doc comment: claims the module "is imported solely by `scripts/server.mjs`", but it is type-imported by `api-client.ts:35`, `api-client.spa.ts:16`, and `src/components/Recommendations.tsx:86`; the SERVER-ONLY runtime claim survives (type imports are erased) but the import-graph description is wrong.

---

## src/lib — non-detectors, part 2b: misc (DONE — 2026-07-22)

### — group: misc-1 (50 files) —

### src/lib/__fixtures__/steering-anchor-fixture.ts
- Feature: Steering/correction analytics — hand-labeled 60-turn precision-gate corpus for the structural-anchor corrective classifier in `parse-steering.ts` (#1751).
- If removed: `src/lib/parse-steering-divergence.test.ts` fails to compile (imports `STEERING_ANCHOR_FIXTURE`), breaking the vitest CI job.
- Current: OK — fixture doc matches its use (cohort-bias + firstInSpan contract).
- Location: OK — `__fixtures__/` is the right home for test-only data.

### src/lib/__snapshots__/recommendations-parity.test.ts.snap
- Feature: Recommendation engine — byte-identical `buildRecommendations` output snapshot for the Detector Catalog parity gate (#507).
- If removed: vitest regenerates it on next run; `src/lib/recommendations-parity.test.ts` (`describe('recommendations parity snapshot (#507)')`, line 116) loses its pinned baseline, so a silent output drift would pass CI once.
- Current: OK — snapshot key matches the live describe/it names; 1 entry, 706 lines.
- Location: OK — vitest-managed path.

### src/lib/app-instant-load-contract.test.ts
- Feature: Instant-load boot path (#2443) — source-text contract over `App.tsx`'s `reloadFromDisk` boundary.
- If removed: nothing imports it; consumer is vitest/CI. Losing it drops the guard that interactions lock before the lazy `@instant-load` chunk loads and that the monolith `fetchDataset` fallback survives.
- Current: OK — the anchors it slices on still exist (`src/App.tsx:1473` `const reloadFromDisk`, `:1492` `import('@instant-load')`, `:1519` `const dataAccessReady`).
- Location: OK, though it tests `src/App.tsx`, not a lib module — arguably belongs in `src/`.

### src/lib/automation-runs.test.ts
- Feature: Automation timeline strip (#300).
- If removed: CI loses the pin on `selectAutomationRuns` (sdk-only selection, NaN-timestamp drop, window/percent math).
- Current: OK — imports match `automation-runs.ts` exports.
- Location: OK.

### src/lib/automation-runs.ts
- Feature: Automation view — positions unattended `sdk-*` runs on a timeline strip (#300).
- If removed: `src/components/AutomationView.tsx` breaks (sole production importer); `canonical-evidence.ts` only shares the `'automation-runs'` signal string, not an import.
- Current: OK.
- Location: OK.

### src/lib/bash-command-fingerprint.ts
- Feature: Tool-usage parsing — FNV-1a fingerprint + length suffix stored with stripped Bash previews so truncation/newline-flattening is detectable.
- If removed: `src/lib/parse-tools.ts` breaks (sole importer).
- Current: OK.
- Location: OK, though at 13 lines it could live inside parse-tools; standalone is defensible for testability.

### src/lib/build-daily-digest.test.ts
- Feature: Diary/daily-digest data layer.
- If removed: CI loses the pin on digest bucketing (server-local calendar day, category grouping, outcome rollup).
- Current: OK — imports match subject exports.
- Location: OK.

### src/lib/build-daily-digest.ts
- Feature: Diary view — builds the per-day digest (sessions, categories, outcomes, totals).
- If removed: `scripts/server.mjs:288` dynamic-imports it (`await import(join(PROJECT_DIR,'src','lib','build-daily-digest.ts'))`) for the daily-digest route — server boot/route breaks; `scripts/daily-digest-route.test.mjs` and `build-daily-digest.test.ts` fail. Note the consumer edge is invisible to static import greps (dynamic path-join import).
- Current: OK.
- Location: OK.

### src/lib/build-mode.ts
- Feature: Tiered delivery (epic #1852, ADR 0014) — `SAMPLE_MODE` flag + `UPLOAD_APP_URL` for the sample/spa split.
- If removed: `src/App.tsx`, `src/lib/variant-capabilities.ts`, and three `App.*.test.tsx` suites break.
- Current: OK.
- Location: OK.

### src/lib/canonical-evidence.test.ts
- Feature: Recommendation evidence routing.
- If removed: CI loses the pin on signal classification (token/agent/model-routing/automation) and destination views.
- Current: OK.
- Location: OK.

### src/lib/canonical-evidence.ts
- Feature: "See the evidence" deep links — maps a recommendation to its canonical evidence view/filter (tokens, model-evals, agents, automation).
- If removed: `src/components/DigestSpine.tsx`, `src/components/recommendations/TopActionHero.tsx`, `src/components/RecommendationCard.tsx` break.
- Current: OK, with the caveat that the id-prefix matchers (`tokenSignal` etc.) are string-coupled to detector ids — drift risk is accepted and test-covered.
- Location: OK.

### src/lib/chd-cache-dir.test.ts
- Feature: Plugin-safe cache dir (#1336) — `CHD_CACHE_DIR` resolution keeping writes out of the install dir.
- If removed: CI loses the drift oracle. The test deliberately duplicates the formula rather than importing the scripts (DB-open side effects).
- Current: OK — oracle matches both real formulas (`scripts/ingest.mjs:106-107`, `scripts/server.mjs:155-156`: `process.env.CHD_CACHE_DIR || join(CLAUDE,'.cache','chd')`).
- Location: OK, though its subject is `scripts/` — a `scripts/*.test.mjs` sibling would be more discoverable.

### src/lib/check-bundle-size.test.ts
- Feature: Structural bundle-size budget gate (#1852 Phase C, ADR 0016) — shell/vendor/route class budgets.
- If removed: CI loses the pin on `evaluateStructuredBudget`/`evaluateBudget`/`chunkBaseName`/`findServerMarkers` (all present in `scripts/check-bundle-size.mjs:70-164`).
- Current: OK.
- Location: OK (tests the pure core of a scripts/ CLI from src/lib; same caveat as chd-cache-dir.test).

### src/lib/cloud-capture-hook.test.ts
- Feature: Cloud-session capture — `tools/cloud-capture/publish-claude.sh` + `install.sh` hook behavior.
- If removed: CI loses the spawned end-to-end pin on the publish/install shell scripts (both exist in `tools/cloud-capture/`), incl. the hermetic-git isolation regression (#1416).
- Current: OK.
- Location: OK-ish — subject is `tools/`, test lives in `src/lib` purely to ride the vitest glob; acceptable per repo pattern.

### src/lib/coding-agent-dashboard-cli.test.ts
- Feature: npm-installable CLI entrypoint `bin/coding-agent-dashboard.mjs`.
- If removed: CI loses the spawn-level pin on CLI args/version/HOME-fixture behavior (subject exists at `bin/coding-agent-dashboard.mjs`).
- Current: OK.
- Location: OK (same scripts-subject-in-src/lib caveat).

### src/lib/coverage-types.ts
- Feature: Domain-coverage honesty surface (#1582) — dependency-free leaf holding `DomainCoverage`/`DomainCoverageStatus`.
- If removed: `src/lib/digest.ts`, `src/lib/recommendation-surface.ts`, `src/lib/coverage.ts` break; the leaf exists precisely to break a coverage↔digest cycle.
- Current: OK.
- Location: OK.

### src/lib/coverage-verdict.ts
- Feature: CoverageState chips (epic #1480, #1619) — proven/inferred/cannot-see-yet verdict vocabulary + presentation meta.
- If removed: `src/components/CoverageState.tsx` and its test break.
- Current: OK (uses house plain-char glyphs, not emoji).
- Location: OK — kept out of the .tsx for react-refresh, as documented.

### src/lib/coverage.test.ts
- Feature: Domain coverage computation.
- If removed: CI loses the pin on `computeDomainCoverage` PROVE/INFER/CANNOT_SEE transitions and `timedEventFractionPct` over stop-hook timing.
- Current: OK.
- Location: OK.

### src/lib/coverage.ts
- Feature: Per-domain data-coverage status feeding the recommendations result and repo-map generation.
- If removed: `src/lib/recommendations.ts` and `src/lib/repo-map/generate.ts` break; `digest.test.ts` fails.
- Current: OK — the #2390 teardown note (registry import instead of digest) matches the actual imports.
- Location: OK.

### src/lib/deploy-script.test.ts
- Feature: Canonical deploy path — `scripts/deploy.sh` (repo-map refresh + compose up).
- If removed: CI loses the pin on deploy.sh degraded-environment behavior (no-node fallback via stubbed `dirname`/`podman`); subject exists.
- Current: OK.
- Location: OK (scripts-subject caveat).

### src/lib/discovery-failures.test.ts
- Feature: Skill-discovery-failure detector.
- If removed: CI loses the pin on `detectDiscoveryFailures` keyword-overlap thresholds.
- Current: OK.
- Location: OK.

### src/lib/discovery-failures.ts
- Feature: ToolUsage view — flags sessions re-implementing an installed-but-never-invoked skill in raw Bash (#136), deterministic keyword overlap only.
- If removed: `src/components/ToolUsage.tsx` breaks (sole production importer).
- Current: OK.
- Location: OK.

### src/lib/evidence.test.ts
- Feature: Evidence-ref plumbing.
- If removed: CI loses the pin on `EvidenceRef` creation/resolution (timestamp + toolUseId matching, index drift recovery).
- Current: OK.
- Location: OK.

### src/lib/evidence.ts
- Feature: Auditable-evidence backbone — stable refs from recommendations/flows into transcript timeline entries.
- If removed: wide breakage: `src/App.tsx`, `src/components/SessionTimeline.tsx`, `SessionList.tsx`, `AskClaude.tsx`, `src/lib/view-registry.tsx`, `parse-permissions.ts`, `parse-secrets-at-rest.ts`, `parse-value-flow.ts`, `detectors/types.ts`, `detectors/security/secrets-at-rest.ts`.
- Current: OK.
- Location: OK.

### src/lib/external-guidance-registry.test.ts
- Feature: External-guidance article registry ↔ committed-snapshot cross-validation (#1407).
- If removed: CI loses the two-way pin that keeps `data/external-guidance/` snapshots and the registry from silently diverging (hash/coverage check over the data dir).
- Current: OK.
- Location: OK.

### src/lib/external-guidance-registry.ts
- Feature: Single source of truth for which external docs are ingested and their fact extractors (#1407, epic #656).
- If removed: `scripts/ingest-guidance.mjs:32` (dynamic register-ts import) breaks, as does `scripts/ingest-guidance.test.mjs` and the registry test. Not in the SPA bundle — server/scripts side only.
- Current: OK.
- Location: OK.

### src/lib/external-guidance.ts
- Feature: Browser-safe half of external guidance (#1300) — types, trust-tiered source registry, snapshot validator, reference projection for recommendation attach-time.
- If removed: `src/lib/recommendations.ts`, `view-registry.tsx`, `App.tsx`, `components/Recommendations.tsx`, `DigestSpine.tsx`, `RecommendationCard.tsx`, `parse-external-guidance.ts` (its node-side re-exporter), and the registry all break.
- Current: OK — genuinely pure (no node imports), honoring the documented SPA-bundle constraint.
- Location: OK.

### src/lib/filtered-empty.ts
- Feature: Filter-aware empty states — describes the active time/project filter so "no data" screens say what was filtered.
- If removed: `FilteredEmptyState.tsx`, `UsageStats.tsx`, `SummaryView.tsx`, `TokenUsage.tsx`, `SessionPatterns.tsx`, `Recommendations.tsx`, `CostAttribution.tsx`, `App.tsx`, `view-registry.tsx` break.
- Current: OK.
- Location: OK.

### src/lib/forensic-graph.test.ts
- Feature: Session Timeline forensic overlay.
- If removed: CI loses the pin on `buildForensicModel` turn/tool folding and value-flow edge re-anchoring.
- Current: OK.
- Location: OK.

### src/lib/forensic-graph.ts
- Feature: Session Timeline evidence overlay (#1307, epic #807) — turn→tool-call model with proven value-flow edges.
- If removed: `src/components/SessionTimeline.tsx` breaks (sole production importer).
- Current: OK.
- Location: OK — deliberately out of the .tsx for react-refresh.

### src/lib/format.test.ts
- Feature: Shared formatting helpers.
- If removed: CI loses the pin on `formatMetric`/`formatTokens`/`truncateMiddle`/`truncateTick`.
- Current: OK (covers a subset of format.ts exports; the untested ones — `formatUSD`, `shortenProject` — are exercised transitively by component tests).
- Location: OK.

### src/lib/format.ts
- Feature: Cross-view display formatting (USD, tokens, project paths, clock strings, truncation).
- If removed: ~20 components break (`PFLayout`, `SessionList`, `SessionTimeline`, `TokenUsage`, `CostAttribution`, `SearchView`, `AutomationView`, …) plus `filtered-empty.ts` and `parse-history.ts` (which re-exports `shortenProject` from here — no duplication).
- Current: OK.
- Location: OK.

### src/lib/fsrs-decay.test.ts
- Feature: FSRS-4.5 decay math verification.
- If removed: CI loses the only exercise of `fsrs-decay.ts` (calibration invariants like R(t=stability)=0.9, clamping, refit).
- Current: OK — imports match subject exports.
- Location: OK.

### src/lib/fsrs-decay.ts
- Feature: Staleness/memory-lifecycle work (#2338; epics #2233/#2280) — pure FSRS-4.5 retrievability port mined from `nagisanzenin/engram`.
- If removed: only `fsrs-decay.test.ts` breaks. No production consumer anywhere — greps `grep -rln "fsrs-decay" src scripts` and `grep -rn "retrievability|FSRS" src/lib/detectors src/components scripts` return nothing outside the pair. Landed keystone awaiting its #2338 detector integration, not dead code per se — but today it ships zero user-visible behavior.
- Current: OK (content is accurate and self-consistent); the gap is integration, not staleness.
- Location: OK.

### src/lib/github-review-sync.test.ts
- Feature: GitHub review-event sync.
- If removed: CI loses the pin on the server-only sync (env/repo-list parsing, cache TTL, transcript-free dataset shape).
- Current: OK.
- Location: OK.

### src/lib/github-review-sync.ts
- Feature: Review-bottleneck signals (#1127) — server-side fetch of PR review-request events, transcript-free by contract.
- If removed: `scripts/server.mjs:208` (dynamic import) breaks; `recommendations.test.ts`, `detectors/workflow/review-bottleneck.test.ts`, `detectors/provenance-contract.test.ts`, `scripts/enterprise-auth.test.mjs` fail. Node-only (`node:fs`/`node:crypto`) and correctly kept off the SPA path — `organization-review-events.ts` only names it in a comment, no import.
- Current: OK.
- Location: OK.

### src/lib/hub-ingest.test.ts
- Feature: Hub multi-user ingest — `DASHBOARD_HUB_PROJECTS_DIR` transcript discovery through `scripts/ingest.mjs`.
- If removed: CI loses the subprocess-level pin (spawns node with `./scripts/register-ts.mjs` importing `ingest`/`assembleDataset`) on hub-projects-dir ingestion.
- Current: OK.
- Location: OK (scripts-subject caveat).

### src/lib/hybrid-search.test.ts
- Feature: Search view scoring.
- If removed: CI loses the pin on `hybridSearchEntries` (lexical/semantic blend, stop words, snippeting).
- Current: OK.
- Location: OK.

### src/lib/hybrid-search.ts
- Feature: History search — pure lexical+semantic hybrid scorer shared by server and upload builds.
- If removed: `src/components/SearchView.tsx`, `src/lib/api-client.ts`, and `src/lib/api-client.spa.ts` break. Correct on the SPA boundary: no node imports, no `/api/` literals, so its presence in the spa client is legal (it's how upload-mode search works without a server).
- Current: OK.
- Location: OK.

### src/lib/json-safe.test.ts
- Feature: JSON export validity (#1104).
- If removed: CI loses the pin that lone-surrogate `\udXXX` escapes are scrubbed and emoji pairs survive round-trip.
- Current: OK.
- Location: OK.

### src/lib/json-safe.ts
- Feature: Strict-parser-safe served JSON (`/api/dataset.json` etc.) — lone-surrogate scrub before `JSON.stringify` (#1104, from the 2026-06-10 audit).
- If removed: `src/lib/dataset-body.ts` breaks (sole importer; the server's dataset body path flows through it).
- Current: OK — pure/dependency-free as documented, safe in both bundles.
- Location: OK.

### src/lib/judge-gold-set.test.ts
- Feature: LLM-judge ground truth from user reject signals.
- If removed: CI loses the only exercise of `judge-gold-set.ts` (verdict mapping, dedup, JSONL export via a temp reject log).
- Current: OK.
- Location: OK.

### src/lib/judge-gold-set.ts
- Feature: Rec feedback loop slice 3 (#2207, epic #1298) — exports accumulated rejections as a judge-validation gold set.
- If removed: only its test breaks. No production consumer — `grep -rn "JudgeGoldSet|judge-gold" scripts server.mjs bin` and the src-wide import grep find nothing outside the pair; the judge-validation harness it documents ("A validation harness runs the judge…") does not exist yet. Mechanism landed, consumer pending — same posture as fsrs-decay.
- Current: OK (header honestly scopes itself to "only EXPORTS the gold set").
- Location: OK.

### src/lib/leave-behind.test.ts
- Feature: Leave-behind runbook contract.
- If removed: CI loses the pin on the v1 structure validator (headings/subheadings, path pattern).
- Current: OK.
- Location: OK.

### src/lib/leave-behind.ts
- Feature: Agent-as-handoff (#2313, epic #2281) — canonical human-resumable runbook contract checker.
- If removed: `src/lib/parse-tools.ts`, `src/lib/parse-permissions.ts`, `src/lib/detectors/workflow/value-of-agent-handoff.ts` break.
- Current: OK — matches the leave-behind v1 shape enforced by the global runbook-autofire hook.
- Location: OK.

### src/lib/live-session.test.ts
- Feature: Live Session widget compute.
- If removed: CI loses the pin on `liveSession()` (tail-window pattern detection, idle threshold, file-based reads).
- Current: OK.
- Location: OK.

### src/lib/live-session.ts
- Feature: Live Session widget (#627 slice 2, epic #622) — pure-ish compute over a given session list, deliberately file-based so liveness never lags the dataset cache.
- If removed: `scripts/ingest.mjs:598` (dynamic import feeding `computeLiveSession`, which `scripts/server.mjs` calls — see server.mjs:10661) breaks.
- Current: FINDING (minor): header comment `src/lib/live-session.ts:6` claims the extraction makes the logic "importable by both server and client", but line 11 imports `node:fs` (`closeSync, openSync, readSync, statSync`) — a client import would fail; no client actually imports it, so this is a stale doc claim, not a boundary violation.
- Location: OK.

### src/lib/local-analyze-eval.test.ts
- Feature: Tier A analyze receipt harness.
- If removed: CI loses the pin on the free-form vs schema-constrained arm comparison and the record shape for #2138.
- Current: OK.
- Location: OK.

### src/lib/local-analyze-eval.ts
- Feature: Publish-only-if-proven receipt for the Tier A local-analyze repair loop (#2725, epic #2177) — measures both arms via the production `runLocalAnalyze`/`runRepairLoop`, injected transport, zero network.
- If removed: `scripts/local-analyze-eval-run.mjs` (the host-side CLI runner) and the test break.
- Current: OK — correctly host-only (never in server boot graph per ADR 0007) and imports the shipping mechanism rather than re-implementing it.
- Location: OK.

### src/lib/local-analyze.test.ts
- Feature: Tier A "Analyze locally" contract (#2177/ADR 0018).
- If removed: CI loses the pin on `local-analyze.ts` (prompt build, output validation, `RepairMessage` repair-loop wiring from schema-repair). Subject exists and is production-wired (`LocalAnalyze.tsx`, `api-client.ts`, `api-client.spa.ts`, `view-registry.tsx`).
- Current: OK.
- Location: OK.

FINDINGS:
1. `src/lib/fsrs-decay.ts` — no production consumer: only `fsrs-decay.test.ts` imports it (verified: `grep -rln "fsrs-decay" src scripts` and `grep -rn "retrievability|FSRS" src/lib/detectors src/components scripts` empty outside the pair). Landed for #2338 but currently ships zero behavior; either wire the staleness detector or mark it explicitly as a pending keystone.
2. `src/lib/judge-gold-set.ts` — same shape: only its test imports it (verified: `grep -rn "JudgeGoldSet|judge-gold" scripts bin` empty); the judge-validation harness its header describes does not exist yet (#2207 slice pending).
3. `src/lib/live-session.ts:6` — stale header claim: says the extraction makes the logic "importable by both server and client", but line 11 imports `node:fs`, making it server-only; no client imports it, so doc-only inaccuracy.


### — group: misc-2 (50 files) —

### src/lib/local-analyze.ts
- Feature: Tier A "Analyze locally" surface (#2319, ADR 0018) — shared result types + degrade/repair-loop contract for the local-model analyze flow.
- If removed: `src/components/LocalAnalyze.tsx` (+ its test), `src/lib/api-client.ts`, `src/lib/api-client.spa.ts` (type-only import), `src/lib/local-analyze-eval.ts`, `scripts/server.mjs` (POST /api/analyze/local, dynamic-imports it at line 266), and `scripts/local-analyze-eval-run.mjs` break.
- Current: OK — pure, dependency-free except `schema-repair`; SPA-safe (the SPA client imports only the `LocalAnalyzeResult` type, erased at build).
- Location: OK.

### src/lib/local-calibration-wiring.test.ts
- Feature: Tier B calibration wiring guard (#2318, epic #2177) — source-level pin that `scripts/ingest.mjs` threads the calibration report into `buildRecommendations`, including the `surface=global` restore path (#2718/#2719).
- If removed: vitest/CI loses the boot-path wiring guard; a refactor of `ingest.mjs` could silently drop the dataset threading (vitest cannot boot the server graph per #1013).
- Current: OK — subjects (`scripts/ingest.mjs`, `./recommendations`, `./parse-local-calibration`) all exist.
- Location: OK.

### src/lib/local-model-client.test.ts
- Feature: Tests for the loopback-only local-model transport — pins `assertLoopbackEndpoint`, config env reading, timeout/error taxonomy (`LocalModelError` codes).
- If removed: CI loses coverage of the ADR 0018 loopback hard guardrail — the one property preventing the analyze surface from reaching a third-party host.
- Current: OK — imports match `local-model-client.ts` exports.
- Location: OK.

### src/lib/local-model-client.ts
- Feature: Tier A local-model transport (#2319, ADR 0018) — loopback-pinned OpenAI-compatible chat call for the analyze route.
- If removed: `scripts/server.mjs` breaks (dynamic import at line 263, backing POST /api/analyze/local); `local-model-client.test.ts` fails. Server-only — no src client graph import.
- Current: FINDING — the module makes a raw network call but is NOT in `NETWORK_OWNERS` in `scripts/check-inbound-boundary.mjs` (7-entry allowlist, "each entry is load-bearing"). It passes the gate only because the call site aliases the primitive (`const fetcher = req.fetchImpl ?? fetch; … await fetcher(url…)` at src/lib/local-model-client.ts:160/173), which the `\bfetch\(` regex cannot see. The inbound boundary's stated invariant ("the ONLY modules permitted to make a raw browser network call") is therefore evaded rather than exempted — it should be an allowlisted entry with its loopback-guard rationale, like `claude-api.ts`.
- Location: OK (server-only sibling of local-analyze.ts, as its header documents).

### src/lib/model-eval-batch.test.ts
- Feature: Tests for the eval batch *spec* builder — pins spec shape, registry status, cluster-scoped batch generation, `CORPUS_ADDRESS_ORDER`, validation.
- If removed: CI loses the contract pin on the #975 batch-spec substrate.
- Current: OK.
- Location: OK.

### src/lib/model-eval-batch.ts
- Feature: Model-routing eval batch spec generator (epic #975, Unit 7) — turns clusters/corpus tasks into repeatable comparison specs.
- If removed: `model-evals-workbench.ts` (Model Evals view) breaks; `model-eval-corpus.test.ts` (fixture-backed spec) fails.
- Current: OK.
- Location: OK.

### src/lib/model-eval-corpus.test.ts
- Feature: Tests the curated corpus loader/validator and pins the `fixtures/model-eval-corpus/curated-corpus.json` byte-for-byte drift guard.
- If removed: fixture manifests could drift from `CURATED_CORPUS` silently.
- Current: OK — fixture dir exists (`fixtures/model-eval-corpus/curated-corpus.json`).
- Location: OK.

### src/lib/model-eval-corpus.ts
- Feature: Curated fixture corpus with deterministic objective gates for model-routing evals (#1080, epic #975 Unit 1).
- If removed: `model-eval-batch.ts` (+ test), `proof-fixture-pairs.ts` (+ test) break.
- Current: OK — pure/deterministic as claimed; no live API.
- Location: OK.

### src/lib/model-eval-ingest-wiring.test.ts
- Feature: Boot-path wiring guard for #1242 — source-level pin that `scripts/ingest.mjs` registers `ingestModelEvalResults` behind existsSync/cachedArtifact and threads the summary into `assembleDataset()`.
- If removed: an ingest refactor could ship a dataset without the model-eval summary field with no CI signal.
- Current: OK — same technique as references-ingest-parity (#541), correctly self-described.
- Location: OK.

### src/lib/model-eval-ingest.test.ts
- Feature: Tests the artifact summarizer — determinism, sanitize-on-ingest, veto rollups, `ARTIFACT_LEDGER_CAP` bounded history (#1387).
- If removed: CI loses the determinism/fail-closed pins on the ingest fold.
- Current: OK.
- Location: OK.

### src/lib/model-eval-ingest.ts
- Feature: Folds on-disk `ModelEvalResult` artifacts into the deterministic per-model summary the dataset carries (#1085/#1242, epic #975).
- If removed: `scripts/ingest.mjs` (dynamic import pinned by the wiring test), `src/types.ts`, `view-registry.tsx`, `App.tsx`, `ModelEvalsPf.tsx`, `Recommendations.tsx`, `DigestSpine.tsx`, `sample-artifacts.ts`, detector `types.ts` break.
- Current: OK — dependency-free except its `model-eval-result` sibling, honoring the #1013 zero-node_modules server graph.
- Location: OK.

### src/lib/model-eval-result.test.ts
- Feature: Tests the committed eval-result schema — 50/25/15/10 weights, fail-closed `sanitizeModelEvalResult`, veto/evidence enums.
- If removed: CI loses the pin on the "one schema, two consumers" (#975/#995) contract.
- Current: OK.
- Location: OK.

### src/lib/model-eval-result.ts
- Feature: The committed per-batch eval-result schema + fail-closed sanitizer (#1079) — shared substrate for routing evals and workflow proof.
- If removed: widest blast radius of the eval family — `model-eval-batch/ingest/evals-workbench/gap-mining/gap-exclusions`, `ModelEvalsPf.tsx`, `provenance-contract.test.ts`, and their tests all break.
- Current: OK — zero imports, as its zero-node_modules rule requires.
- Location: OK.

### src/lib/model-evals-workbench.test.ts
- Feature: Tests the workbench data-prep helpers — cluster/gap-analysis builders, proposed batch-spec serialization, evidence labels.
- If removed: CI loses the pin that the Model Evals view's client-side derivations stay deterministic proposals.
- Current: OK.
- Location: OK.

### src/lib/model-evals-workbench.ts
- Feature: Pure data-prep for the Model Evals workbench view (#1086) — clusters + proposed replay batch specs derived client-side (SPA-boundary safe).
- If removed: `ModelEvalsPf.tsx` (+ test), `App.tsx`, `sample-corpus.test.ts` break.
- Current: OK — proposal-only contract (standing rule 6) upheld: no mutation exports.
- Location: OK.

### src/lib/model-gap-clustering.test.ts
- Feature: Tests task-shape clustering — stable cluster IDs, size-band thresholds, `unprofiled` bucket, parse round-trip.
- If removed: CI loses the cluster-ID stability pin that the eval-result `clusterId` field depends on.
- Current: OK.
- Location: OK.

### src/lib/model-gap-clustering.ts
- Feature: Task-shape clustering of kept gap runs into stable-ID buckets (#1083, epic #975 Unit 6).
- If removed: `model-eval-batch.ts`, `model-evals-workbench.ts` break.
- Current: OK — deterministic, no embeddings/live API as documented.
- Location: OK.

### src/lib/model-gap-exclusions.test.ts
- Feature: Tests the six human/process noise classifiers (human-waiting, exploration, external-blocker, churn, harness-overhead, baseline-failure) and the kept/filtered partition.
- If removed: CI loses coverage of the auditable-survivors rule (every run gets a reason).
- Current: OK.
- Location: OK.

### src/lib/model-gap-exclusions.ts
- Feature: Exclusion classifiers separating genuine model-routing gaps from human/process noise (#1082, epic #975 Unit 5).
- If removed: `model-evals-workbench.ts` breaks (workbench exclusion join).
- Current: OK.
- Location: OK.

### src/lib/model-gap-mining.test.ts
- Feature: Tests hindsight gap mining — direction assignment, evidence-strength ceilings, dataset-input adapter.
- If removed: CI loses the pin that cost signals stay `token-cost-discovery` strength (standing rule 4).
- Current: OK.
- Location: OK.

### src/lib/model-gap-mining.ts
- Feature: Hindsight gap-mining over parsed history — surfaces haiku→sonnet / sonnet→opus eval candidates (#1081, epic #975 Unit 2).
- If removed: `model-eval-batch.ts`, `model-evals-workbench.ts`, `model-gap-clustering.ts`, `model-gap-exclusions.ts` (+ tests) break.
- Current: OK — discovery-only contract explicit; never derives a quality score.
- Location: OK.

### src/lib/model-pin-savings.test.ts
- Feature: Tests the model-pin savings attribution math (before/after windows, unattended-only gate, synthetic-model handling).
- If removed: CI loses coverage of a dollar-figure claim the recs engine publishes (auditable-claims rule).
- Current: OK.
- Location: OK.

### src/lib/model-pin-savings.ts
- Feature: Before/after savings attribution for the model-pin recommendation, with optional task-class narrowing (#2140).
- If removed: `src/lib/recommendations.ts` breaks (sole non-test consumer).
- Current: OK.
- Location: OK.

### src/lib/model-registry.test.ts
- Feature: Pins `CURRENT_MODEL_IDS`, pricing table, family resolution, picker list, and the model-update checklist.
- If removed: a model-promotion PR (like the recent Sonnet 5 one) could half-update the registry unnoticed.
- Current: OK — expectations match the registry (opus-4-8 / sonnet-5 / haiku-4-5).
- Currentness of subject also OK post-#2288.
- Location: OK.

### src/lib/model-registry.ts
- Feature: Single source of truth for model IDs, families, pricing tiers, aliases, and the Anthropic picker list.
- If removed: 12 modules break — `pricing.ts`, `summary.ts`, `claude-api.ts`, `parse-model-recommendation.ts`, `sample-workflows.ts`, `model-eval-batch/evals-workbench/gap-mining`, `Settings.tsx`, `TokenUsage.tsx`, plus tests.
- Current: OK — current with Sonnet 5 promotion (commit 7ea65891); aliases carry the legacy IDs.
- Location: OK.

### src/lib/native-bypass-snippet.test.ts
- Feature: Tests the CLAUDE.md guidance-block generator for native-tool-bypass findings (one bullet per bypassed category).
- If removed: CI loses the pin on the copyable corrective's format.
- Current: OK.
- Location: OK.

### src/lib/native-bypass-snippet.ts
- Feature: Copyable CLAUDE.md corrective for native-tool-bypass findings (#1804, epic #1485) — Tools view + `workflow.native-bypass` detector.
- If removed: `src/components/ToolUsage.tsx` breaks; `adoption-scorecard.test.ts` fails.
- Current: OK — pure string transform, SPA-safe as documented.
- Location: OK.

### src/lib/nav-prefs.test.ts
- Feature: Tests the versioned/opt-in nav-prefs model (#608) — curated-default roll-forward vs preserved customization, legacy-blob degradation.
- If removed: CI loses the migration-safety pin protecting user sidebar customizations across layout versions.
- Current: OK.
- Location: OK.

### src/lib/nav-prefs.ts
- Feature: The sidebar nav registry (`NAV_ITEMS`: view/contract/domain/icon/description) + hidden-views localStorage persistence — the backbone of app navigation.
- If removed: catastrophic — ~60 consumers including `App.tsx`, `routing.ts`, `view-registry`, nearly every `src/components/*` view, and the reachable-views/domain-registry/variant-capabilities drift guards.
- Current: FINDING (minor) — stale comment at src/lib/nav-prefs.ts:541 ("Not serverOnly: …") references the `serverOnly` flag that epic #1852 removed in favor of `requires` (per `reachable-views.test.ts:6-7`); the flag no longer exists anywhere in the module.
- Location: OK — though at 907 lines it is both a data registry and a prefs store; a registry/persistence split would be a reasonable future seam, not a defect.

### src/lib/organization-identity.test.ts
- Feature: Tests the contributor-alias resolver — normalization, explicit unknown/ambiguous states, refusal to infer identity.
- If removed: CI loses the pin on the conservative-identity contract (#1122).
- Current: OK.
- Location: OK.

### src/lib/organization-identity.ts
- Feature: Enterprise contributor-identity contract (#1122) — maps explicit aliases to stable contributors for org detectors.
- If removed: `src/lib/recommendations.ts`, `src/lib/detectors/types.ts` break; `scripts/ingest.mjs`/`server.mjs` thread `organizationIdentity` through the recommendation context.
- Current: OK.
- Location: OK.

### src/lib/organization-review-events.ts
- Feature: Structured PR/review-event contract (#1123) feeding enterprise review recommendations; populated by the GitHub review sync.
- If removed: `github-review-sync.ts`, `recommendations.ts`, `detectors/types.ts`, `src/types.ts` (via consumers), `view-registry.tsx`, `App.tsx`, `Recommendations.tsx`, `DigestSpine.tsx`, `provenance-contract.test.ts` break; `scripts/ingest.mjs` review-events refresh loses its type source.
- Current: OK — 52 lines of pure types, transcript-free as documented. No dedicated test file, acceptable for a type-only contract.
- Location: OK.

### src/lib/prefetch.test.ts
- Feature: Regression guard for #2390 — asserts `warmLazyChunks` is a no-op under vitest so no dynamic import outlives environment teardown.
- If removed: the teardown-race flake class could silently return.
- Current: OK.
- Location: OK.

### src/lib/prefetch.ts
- Feature: Warms the lazy Recommendations/AskClaude chunks after data load so first navigation is instant.
- If removed: `src/App.tsx` breaks (sole consumer); otherwise only a perf warm-up.
- Current: OK — the `MODE === 'test'` guard and its rationale are accurate.
- Location: OK.

### src/lib/project-identity.ts
- Feature: Windows drive/UNC path identity normalization so per-project joins survive case/separator variance.
- If removed: `src/lib/recommendations.ts` and `detectors/workflow/value-of-agent-handoff.ts` (+ its test) break.
- Current: OK.
- Location: OK. (No sibling test file, but the value-of-agent-handoff test exercises `projectIdentityKey`.)

### src/lib/project-slug.ts
- Feature: The cwd-path ↔ `~/.claude/projects/<slug>` join for the memories project filter; kept leaf/dependency-free for the frozen first-paint shell budget (ADR 0016).
- If removed: `parse-memories.ts` and `view-scope.ts` break.
- Current: OK — one-way/lossy caveat correctly documented.
- Location: OK — the leaf-module placement is deliberate and explained.

### src/lib/provision-naming.test.ts
- Feature: The load-bearing drift guard proving the TS naming copy and `scripts/lib/remotesession-dispatch.mjs` (the authority writing RemoteSession `metadata.name`) are byte-identical.
- If removed: the two naming copies could silently diverge — the exact failure mode the byte-for-byte mirror exists to prevent.
- Current: OK — the mirror file exists.
- Location: OK.

### src/lib/provision-naming.ts
- Feature: Pure naming (GitHub repo parse, RFC-1123 slug, session/env names) for Probaitio session provisioning; mirrored by the zero-dep server-side dispatch lib.
- If removed: `SessionProvisioning.tsx` breaks; the drift-guard test fails.
- Current: OK — the github.com host anchor and injection-safe character classes are as documented.
- Location: OK.

### src/lib/reachable-views.test.ts
- Feature: Drift guard (#765) keeping the hand-kept `e2e/reachable-views.ts` (Playwright render-smoke list) equal to `NAV_ITEMS.filter(!requires)`.
- If removed: adding/gating a view in nav-prefs could silently drop it from the render-smoke gate.
- Current: OK — correctly updated for the #1852 `serverOnly`→`requires` migration; `e2e/reachable-views.ts` exists.
- Location: OK.

### src/lib/references-ingest-parity.test.ts
- Feature: Enforces the deterministic half of the REFERENCES.md map (#541): every `assembleDataset()` key must have an ingest-table row (with a reasoned allowlist).
- If removed: the parser→dataset-key documentation drifts again (the ~11-row late-May regression it was built for).
- Current: OK — subjects (`scripts/ingest.mjs`, `REFERENCES.md`) exist.
- Location: OK.

### src/lib/reject-reason.ts
- Feature: The node-free reject-reason vocabulary (#1294, epic #1298) shared by browser UI and node persistence.
- If removed: `RejectControl.tsx`, `RecommendationCard.tsx`, `TopActionHero.tsx`, `Recommendations.tsx`, `api-client.ts`, `adoption-receipts.ts`, `judge-gold-set.ts`, `reject-signals.ts` break.
- Current: OK — the node-free split is exactly the right SPA-boundary shape.
- Location: OK.

### src/lib/reject-signals.test.ts
- Feature: Tests the reject-signal JSONL log — sanitize-on-write/read, append semantics, malformed-line tolerance.
- If removed: CI loses coverage of the fail-closed sanitizer on a user-feedback log the engine will learn from.
- Current: OK.
- Location: OK.

### src/lib/reject-signals.ts
- Feature: Append-only capture of *why* a user rejected a recommendation (#1294) — the rec-feedback loop's write side.
- If removed: `scripts/server.mjs` breaks (dynamic import `appendRejectSignal`, line 199; log path line 392); `judge-gold-set.ts` breaks.
- Current: OK — imports `node:fs` but is reachable only from the server graph (the browser imports the vocabulary from `reject-reason.ts` instead), so the SPA boundary holds.
- Location: OK.

### src/lib/repeated-command-snippet.test.ts
- Feature: Tests the repeated-command wrapper/alias generators — verbatim command preservation, shell-quoting, slug derivation.
- If removed: CI loses the pin that generated wrappers are copy-paste-safe (the #1803 heredoc/injection concern).
- Current: OK.
- Location: OK.

### src/lib/repeated-command-snippet.ts
- Feature: Copyable script/alias wrapper for commands a session ran 3+ times (#1803, epic #1485) — Tools view corrective.
- If removed: `src/components/ToolUsage.tsx` breaks.
- Current: OK — pure string transform, SPA-safe as documented.
- Location: OK.

### src/lib/report-card.test.ts
- Feature: Tests the Agent Report Card join — blended per-project verdicts from session-registry + telemetry + debug metrics.
- If removed: CI loses the pin on the KEEP-disqualification logic (reliability tax vs attribution).
- Current: OK.
- Location: OK.

### src/lib/report-card.ts
- Feature: Agent Report Card (#572/#539) — joins three parsers on sessionId/cwd into one blended per-project verdict.
- If removed: `AgentReportCardPf.tsx` (+ test) breaks; `sample-artifacts.test.ts` fails.
- Current: OK — pure (no I/O), so the server/client no-drift claim holds structurally.
- Location: OK.

### src/lib/review-queue.test.ts
- Feature: Tests the review-queue builder — category/severity assignment across cost/reliability/speed/context/outcome signals from empty and populated inputs.
- If removed: CI loses coverage of the triage-queue ranking contract.
- Current: OK.
- Location: OK.

### src/lib/review-queue.ts
- Feature: The Review Queue view's builder — flags sessions worth human review across five signal categories, reusing cost-attribution/context-health/telemetry analyzers.
- If removed: `ReviewQueuePf.tsx` (+ test) breaks (registered lazily in `view-registry.tsx:211`).
- Current: OK — pure aggregation over already-parsed inputs.
- Location: OK.

### src/lib/route-filtering.ts
- Feature: Shared URL-route filter predicates (text/date/session matching) applied by list views when deep-linked with filters.
- If removed: 8 components (`SessionList`, `TokenUsage`, `ToolUsage`, `ErrorRetry`, `ContextHealth`, `AgentSkill`, `AutomationView`, `SessionPatterns`) and `cost-scope.ts` break.
- Current: OK. No dedicated test file, but consumers' tests exercise it; the helpers are small and pure.
- Location: OK.

FINDINGS:
1. `src/lib/local-model-client.ts` makes a raw network call (`const fetcher = req.fetchImpl ?? fetch;` then `await fetcher(url.toString(), …)` at lines ~160/173) but is not in the `NETWORK_OWNERS` allowlist of `scripts/check-inbound-boundary.mjs`; the aliased call sidesteps the gate's `\bfetch\(` primitive regex, so the inbound SPA/server boundary invariant ("the ONLY modules permitted to make a raw browser network call") is evaded rather than consciously exempted. It should be an allowlisted entry with its loopback-guard rationale (like `claude-api.ts`) or the gate should catch the alias pattern.
2. Stale comment in `src/lib/nav-prefs.ts:541` — "Not serverOnly: …" references the `serverOnly` flag removed by epic #1852 (replaced with `requires`, per `src/lib/reachable-views.test.ts:6-7`); the flag no longer exists in the module.


### — group: misc-3 (48 files) —

All consumer/CI checks verified. Composing the artifact.

### src/lib/routing-core.ts
- Feature: Masthead time/project filter primitives (#2718) — React-free preset→range math shared by browser and server.
- If removed: `src/lib/routing.ts` (re-exports it), `src/lib/view-scope.ts`, and the server ingest path (`scripts/ingest.mjs:640` imports it via `join(LIB, 'routing-core.ts')`) break; every `TIME_PRESETS`/`presetToRange` consumer downstream of routing.ts loses its source.
- Current: OK — header accurately describes the #2718 extraction and the re-export contract.
- Location: OK.

### src/lib/routing.test.ts
- Feature: Pins the hash-route contract (`parseRoute`/`routeToHash`/`navigateWithFilter`/filter parsing) for the one-URL-space (#490/#491).
- If removed: vitest coverage of URL round-tripping lost (consumer: CI `test` job via vitest glob).
- Current: OK — imports match routing.ts exports; jsdom env correct for hash tests.
- Location: OK.

### src/lib/routing.ts
- Feature: Hash-based routing + bidirectional URL↔state sync for all dashboard views (epic #490).
- If removed: ~35 consumers break — App.tsx, PFLayout, SessionList, Recommendations, DrillThrough, view-registry.tsx, view-scope.ts, cost-scope.ts, filtered-empty.ts, route-filtering.ts, etc. (grep of `from '…/routing'` across src/).
- Current: OK.
- Location: OK.

### src/lib/sample-adoption.test.ts
- Feature: Drift guard for the SPA demo Adoption Card lifecycle (#578, ADR 0005) — sample receipts must traverse SURFACED→ADOPTED→SUPPRESSED through the real `buildAdoptionScorecard`.
- If removed: demo Adoption Card can silently ship empty/broken (consumer: CI vitest).
- Current: OK — subjects `scripts/sample-data/build-corpus.mjs` and `sample-artifacts.ts` both exist and export the imported symbols.
- Location: OK.

### src/lib/sample-artifacts.test.ts
- Feature: Coverage guard that every #539 server-only sample artifact renders non-empty demo data and demo recommendations fire.
- If removed: sample-mode #539 views (Task Health, Team Coordination, Pulse, Report Card…) can silently blank in the SPA demo.
- Current: OK — imports match sample-artifacts.ts exports; fixed clock keeps generators deterministic.
- Location: OK.

### src/lib/sample-artifacts.ts
- Feature: Synthetic #539 ingest artifacts (11 shapes) injected by App.tsx when SPA demo mode activates.
- If removed: `src/App.tsx:1643` (lazy `import('./lib/sample-artifacts')`), `sample-adoption.test.ts`, `sample-artifacts.test.ts`, and `App.sample-isolation.test.tsx` (mocks it) break; demo mode renders the five #539 views empty.
- Current: OK — spa-boundary claim (no `/api/` literals) verified by grep.
- Location: OK.

### src/lib/sample-corpus.test.ts
- Feature: Coverage guard that the SPA sample zip corpus (#526) lights up every dashboard section through the real parsers.
- If removed: a parser shape change could silently ship an empty demo section.
- Current: OK — subject `scripts/sample-data/build-corpus.mjs` exists and exports `buildSampleCorpus`/`buildSampleModelEvalResults`.
- Location: OK — lives in src/lib despite a scripts/ subject, deliberately: it exercises the src/lib parsers over the corpus.

### src/lib/sample-data.ts
- Feature: Marketing-SPA sample-bundle loader (#526) — fetches build-emitted `sample-data.zip` and inflates it through the upload path.
- If removed: `src/App.tsx:1611` (demo-mode dynamic import) breaks; `App.sample-isolation.test.tsx:72` mocks it; the vite plugin (`vite.config.ts` `sample-data-zip`) would emit an asset nothing loads.
- Current: OK — it is one of the sanctioned fetchers (allowlisted at `scripts/check-inbound-boundary.mjs:31`).
- Location: OK.

### src/lib/sample-doc-neighborhood.test.ts
- Feature: Pins that the sample doc-graph (#2323) exercises every hygiene class (contradiction, stale, supersession, dangling) via the real `docNeighborhood` retrieval.
- If removed: demo doc-relationship view could drift to missing hygiene classes unnoticed.
- Current: OK.
- Location: OK.

### src/lib/sample-doc-neighborhood.ts
- Feature: Self-contained sample doc-graph + neighborhood for the doc relationship view (#2323) in SPA/sample builds and tests.
- If removed: `src/components/DocRelationshipView.tsx` and its test break.
- Current: OK — browser-safe claim holds (imports only retrieval + types, no `buildDocGraph`/node:fs).
- Location: OK.

### src/lib/sample-memories-workflows.test.ts
- Feature: Coverage guard that sample Memories (#537) and Workflows fixtures survive the real `parseMemories`/`parseWorkflows` non-empty.
- If removed: parser shape changes could silently blank the demo Memories/Workflows views.
- Current: OK.
- Location: OK.

### src/lib/sample-memories.ts
- Feature: Synthetic `MemoriesResponse` for the SPA demo Memories view (#537/#458).
- If removed: `src/App.tsx:1629` (demo-mode dynamic import) and `sample-memories-workflows.test.ts` break; demo Memories renders empty.
- Current: OK.
- Location: OK.

### src/lib/sample-workflows.ts
- Feature: Synthetic Workflow-run ledger (#537/#435) templated over real demo session ids for the SPA demo.
- If removed: `src/App.tsx:1630` (demo-mode dynamic import), `sample-artifacts.test.ts`, and `sample-memories-workflows.test.ts` break.
- Current: OK — uses `CURRENT_MODEL_IDS` from model-registry so model names can't go stale independently.
- Location: OK.

### src/lib/schema-repair.test.ts
- Feature: Pins the bounded generate→validate→repair loop contract (#2682): scripted chat transport, domain-phrased errors, `checkShape`.
- If removed: repair-loop regressions (e.g. raw traces leaking into repair prompts) go uncaught.
- Current: OK.
- Location: OK.

### src/lib/schema-repair.ts
- Feature: Schema-constrained repair loop for the ADR 0018 Tier A local-analyze surface (#2682, epic #2177); pure, transport-injected, zero-dep.
- If removed: `structured-edit-dsl.ts`, `structured-edit-arm-eval.ts`, `local-analyze.ts`, `local-analyze-eval.ts` (+ their tests) break.
- Current: OK — the "imports NOTHING" claim holds; the no-ajv rationale (zero node_modules runtime, ADR 0007) is accurate.
- Location: OK.

### src/lib/semantic-intent-wiring.test.ts
- Feature: Source-level boot-path guard for #2574 — pins that `scripts/ingest.mjs` registers semantic-intent behind the `CHD_SEMANTIC_INTENT=1` opt-in gate, flag-check-before-any-filesystem-touch.
- If removed: a refactor could reorder flag/fs checks and silently break the AGENTS.md flag-off byte-identical guarantee.
- Current: OK — the pinned literals (`SEMANTIC_INTENT_DIR`, `SEMANTIC_INTENT_ENABLED`) exist in ingest.mjs (CI would fail otherwise).
- Location: OK — src-level wiring tests of scripts/ follow the established `model-eval-ingest-wiring.test.ts` style.

### src/lib/semantic-intent.test.ts
- Feature: Pins the receipt parser's suppression discipline (#2574) — malformed/low-confidence/taxonomy-mismatch rows never invent a class.
- If removed: parser could start "lying" (silent best-effort reads) uncaught.
- Current: OK.
- Location: OK.

### src/lib/semantic-intent.ts
- Feature: Parser for local semantic-intent classifier receipts under `~/.claude/model-evals/semantic-intent/` (#2574, epic #2177 down-modelling).
- If removed: `src/types.ts`, `src/lib/detectors/types.ts`, and `detectors/cost/model-eval-routing-gap.ts` (+ test) break.
- Current: OK — dependency-free/browser-safe claims verified (no imports at all).
- Location: OK.

### src/lib/signals/index.ts
- Feature: `SESSION_SIGNALS` descriptor (#524 slice 1) — single source of truth for per-session signal parse/hash/read-back in the ingest pipeline.
- If removed: `scripts/ingest.mjs` (dynamic import via `session-blob-row.mjs:144` path and derived loops), `src/lib/session-cache.ts`, `scripts/session-blob-row.mjs`, `scripts/signal-descriptor-parity.test.mjs`, `scripts/session-blob-schema-parity.test.mjs`, `scripts/parser-output-versions.fence.test.mjs`, `scripts/lib/parser-output-versions.mjs`, and `src/lib/signals/schema.ts` break; cached `session_blob` rows would silently invalidate.
- Current: OK — header's "slice 2 will generate the SQLite schema… not started here" is superseded by the sibling schema.ts existing, but the sentence is scoped to slice 1's own diff, so not wrong.
- Location: OK.

### src/lib/signals/schema.ts
- Feature: Generated `session_blob` DDL/upsert (#524 slice 2), derived from `SESSION_SIGNALS`.
- If removed: `scripts/ingest.mjs:2191` (`buildCreateIndexSql` dynamic import) and `scripts/session-blob-schema-parity.test.mjs` break; ingest loses its schema source of truth.
- Current: OK — additive-migration contract documented and pinned by the parity test.
- Location: OK.

### src/lib/standalone-runtime-ci.test.ts
- Feature: CI-wiring guard (#1349) — keeps `test:server-runtime-imports`, `test:mcp-shim-isolation`, `test:plugin-ctl` in the required test job.
- If removed: those isolation suites could be dropped from `.github/workflows/test.yml` unnoticed.
- Current: OK — all three scripts exist in package.json:48-51 and appear at test.yml:69-73.
- Location: OK — arguably a repo-meta test rather than a lib test, but it follows the repo's src-level guard convention; fine.

### src/lib/steer-telemetry-types.ts
- Feature: Shared node-free vocabulary for the PreToolUse-steer telemetry surface (#2203, epic #1868): event kinds, misfire taxonomy, record shapes.
- If removed: `parse-steer-telemetry.ts`, `api-client.ts:37`, `api-client.spa.ts:18`, `AdoptionScorecard.tsx`, `SteerTelemetryPanel.test.ts` break.
- Current: OK — node-free as claimed (type/const-only), safe on the SPA path.
- Location: OK.

### src/lib/structured-edit-arm-eval.test.ts
- Feature: Pins the two-arm (free-form vs schema-constrained) edit-eval harness (#2726): scripted endpoint, repair telemetry, corpus parsing.
- If removed: arm-comparison generation regressions go uncaught.
- Current: OK.
- Location: OK.

### src/lib/structured-edit-arm-eval.ts
- Feature: Two-arm produced-file generator for the structured-edit down-modelling proof (#2726, epic #2177); host-only measurement code.
- If removed: `scripts/structured-edit-arm-run.mjs:35` (the CLI runner) and its test break. No app/runtime consumer — that is by design (ADR 0007: inert in the runtime image), not a removal signal.
- Current: OK — reuses `runRepairLoop` verbatim as claimed.
- Location: OK.

### src/lib/structured-edit-dsl.test.ts
- Feature: Pins the edit-DSL validate/apply contract (#2726): fence tolerance, domain-phrased rejections, deterministic apply.
- If removed: hallucinated-anchor detection and error-phrasing regressions go uncaught.
- Current: OK.
- Location: OK.

### src/lib/structured-edit-dsl.ts
- Feature: Constrained exact-text edit DSL + deterministic apply for the constrained arm of the edit eval (#2726).
- If removed: `structured-edit-arm-eval.ts` (+ test) break.
- Current: OK.
- Location: OK.

### src/lib/structured-edit-eval.test.ts
- Feature: Pins the benchmark result assembly, per-task-class summaries, telemetry merge, and (via the .mjs runner import) the jailed live-task runner surface.
- If removed: benchmark scoring/rollup regressions go uncaught.
- Current: OK — heavy node: imports are fine (test file, vitest/node).
- Location: OK.

### src/lib/structured-edit-eval.ts
- Feature: Reproducible TypeScript structured-edit benchmark substrate (#2296) — mutations, corpus, task/tool reliability metrics for the #2138 down-modelling proof.
- If removed: `structured-edit-arm-eval.ts`, `scripts/lib/model-edit-benchmark.ts`, and both eval test suites break; `scripts/model-eval-run.mjs` runner loses its types.
- Current: OK.
- Location: OK.

### src/lib/summary.test.ts
- Feature: Pins the Summary-view spend rollups (spendByProject/Day/Model/TokenType/SessionType) against the canonical cost aggregators.
- If removed: Summary-vs-Cost-view number drift goes uncaught.
- Current: OK.
- Location: OK.

### src/lib/summary.ts
- Feature: Token-spend aggregator for the Summary view (epic #730), composing `attributeCostByProject` so Summary matches the Cost view exactly.
- If removed: `SummaryView.tsx`, `TokenUsage.tsx` (+ TokenUsage.test.ts) break.
- Current: OK — header's "as later slices (#732-#736) extend this module" is now historical (all six rollups shipped, summary.ts:85-392), but it reads as design intent, not a false claim.
- Location: OK.

### src/lib/task-class.test.ts
- Feature: Pins the authoring/mechanical/review opener-precedence classifier (#2139), especially authoring-first bias on keyword collisions.
- If removed: misclassification of code-writing sessions as "mechanical" (the dangerous direction for down-modelling) goes uncaught.
- Current: OK.
- Location: OK.

### src/lib/task-class.ts
- Feature: Coarse 3-bucket task-class segmentation for the down-modelling confidence epic (#2139/#2138).
- If removed: `detectors/shared.ts`, `detectors/types.ts`, `detectors/cost/automation-share.ts` (+ test), `structured-edit-eval.ts`, `structured-edit-arm-eval.ts` break.
- Current: OK.
- Location: OK.

### src/lib/team-coordination-context.ts
- Feature: Joins a sparse inbox "dropped assignment" to its canonical task (ID+subject exact match, owner tie-break) for the Team Coordination view.
- If removed: `src/components/TeamCoordinationPf.tsx` (+ its test, which exercises the view) breaks.
- Current: OK — though it is the one module in this group with no header block explaining feature/issue provenance; minor doc gap, not a defect.
- Location: OK.

### src/lib/theme.test.ts
- Feature: Pins light/dark theme resolution (#442): stored choice wins over OS preference, PF6 dark class applied.
- If removed: theme-preference regressions go uncaught.
- Current: OK.
- Location: OK.

### src/lib/theme.ts
- Feature: Light/dark theme preference (#442) — localStorage persistence + `pf-v6-theme-dark` application.
- If removed: `App.tsx` and `PFLayout.tsx` break (theme toggle and initial resolve).
- Current: OK.
- Location: OK.

### src/lib/thinking-tokens.test.ts
- Feature: Pins the recalibrated thinking-token residual estimate (#1927/#2006): 2.6/1.7 chars-per-token divisors, clamp-at-zero.
- If removed: divisor/clamp regressions (over-attributing to thinking) go uncaught.
- Current: OK.
- Location: OK.

### src/lib/thinking-tokens.ts
- Feature: Residual-based per-message thinking-token estimator (#1927, recalibrated #2006) feeding token composition surfaces.
- If removed: `parse-sessions.ts` and `context-composition.ts` break.
- Current: OK — header is unusually honest about precision limits (corpus-directional lower bound), matching the auditable-claims convention.
- Location: OK.

### src/lib/use-session-tags.ts
- Feature: Personal good/bad session labels (#138) in localStorage with cross-view sync via a window event.
- If removed: `SessionList.tsx` and `SessionPatterns.tsx` break (tagging + pattern colouring).
- Current: OK. (No dedicated unit test, but exercised via its two consumers; not a defect.)
- Location: OK.

### src/lib/variant-capabilities.test.ts
- Feature: Pins the delivery-variant capability matrix (ADR 0014): sample/upload/server profiles gate `serverData`/`liveServer` views.
- If removed: tier-gating regressions (e.g. liveServer views leaking into SPA builds) go uncaught at the predicate level.
- Current: OK — comment honestly notes it can't stub `import.meta.env.MODE` so it tests with explicit cap objects.
- Location: OK.

### src/lib/variant-capabilities.ts
- Feature: Declarative "what is available in this build/tier" matrix (epic #1852, ADR 0014), replacing scattered SAMPLE_MODE/SERVER_AVAILABLE checks.
- If removed: `App.tsx`, `PFLayout.tsx`, `CompositeTabsView.tsx`, `nav-prefs.ts` break.
- Current: OK.
- Location: OK.

### src/lib/version.test.ts
- Feature: Pins release/commit/dev version-label formatting (#646).
- If removed: masthead version-stamp formatting regressions go uncaught.
- Current: OK.
- Location: OK.

### src/lib/version.ts
- Feature: In-app version stamp (#646) — defensive read of the vite-defined `__APP_VERSION__` plus label/title formatters.
- If removed: `PFLayout.tsx` (masthead version label) breaks.
- Current: OK.
- Location: OK.

### src/lib/view-heading-drift.test.ts
- Feature: Drift guard (#1599) — renders every registered view and asserts its page heading matches the nav catalog.
- If removed: view heading vs NAV_ITEMS label drift ships silently.
- Current: OK.
- Location: OK.

### src/lib/view-registry.test.ts
- Feature: Pins the view registry contract: every View has a renderer/anchor/filter policy, redirects resolve, filter policies behave.
- If removed: "add a view in one place" invariant (registry completeness) goes unenforced.
- Current: OK.
- Location: OK.

### src/lib/view-registry.tsx
- Feature: Single declarative view registry (epic #490/#491) — lazy render closures + per-view data-filter policies, retiring the App.tsx routing monolith.
- If removed: `App.tsx`, `recommendation-view-data.ts` (+ test), `view-scope.ts` (type-only), `view-heading-drift.test.ts`, `view-registry.test.ts` break; every view render path dies.
- Current: OK.
- Location: OK.

### src/lib/view-scope.ts
- Feature: React-free masthead time/project filtering (#2718), extracted from view-registry so the zero-node_modules server reproduces client filter semantics.
- If removed: `view-registry.tsx` and the server path (`scripts/ingest.mjs:631` imports `join(LIB, 'view-scope.ts')`; `scripts/server.mjs:9876` documents the dependency) break — server/client filter parity is lost.
- Current: OK — the type-only-cycle note (ViewData imported type-only to avoid a runtime cycle) checks out.
- Location: OK.

### src/lib/weekly-delta.ts
- Feature: Week-over-week delta aggregation (#129) — cost/errors/retry-storms bucketed into complete ISO weeks for the Recommendations banner and reclaim trendline.
- If removed: `Recommendations.tsx`, `recommendations/WeeklyDeltaPanel.tsx`, `reclaim-trendline.ts` break.
- Current: OK — pure/wall-clock-free claim holds per header contract.
- Location: OK.

### src/lib/weekly-delta.test.ts
- Feature: Pins ISO-week bucketing (Monday/UTC), complete-week comparison, and cost parity with `computeCostTrend`.
- If removed: week-boundary and double-counting regressions go uncaught.
- Current: OK.
- Location: OK.

FINDINGS: none.

---

## src/lib/detectors (212) + src/components (161) (DONE — 2026-07-22)

### — group: detectors-1 (65 files) —

### src/lib/detectors/workflow/abandoned-tasks.test.ts
- Feature: Unit tests for `workflow.abandoned-tasks` (cold-session open-task detector, #559).
- If removed: vitest CI (`test` job) loses the dedicated cold-gate/false-positive coverage; imports `./abandoned-tasks` directly. Bank coverage in recommendations.test.ts (#507) remains.
- Current: OK.
- Location: OK (co-located with detector).

### src/lib/detectors/workflow/abandoned-tasks.ts
- Feature: `workflow.abandoned-tasks` rec — flags pending/in_progress tasks in sessions idle ≥7 days (persona P2, #559); action-domain: workflow.
- If removed: import breaks in src/lib/detectors/index.ts:94 (catalog entry :269) → recommendations engine → /api/recommendations.json + Recommendations view; its test file and the exhaustive fires-in-bank suite fail.
- Current: FINDING (stale): header comment (lines 8-10) and `dataDeps: ['tasks' as keyof RecommendationInput]` (line 23) plus the `(input as … & { tasks?: TaskRecord[] })` cast (line 28) claim `tasks` is "not yet in the shared RecommendationInput type" — it is first-class at src/lib/detectors/types.ts:648.
- Location: OK; category `workflow` matches folder; no appliedMarkers.

### src/lib/detectors/workflow/assistant-refusal-rate.ts
- Feature: `workflow.assistant-refusal-rate` rec — high refusal/concession share of assistant turns signals underspecified context (#206); action-domain: workflow.
- If removed: index.ts:84 import (catalog :214) breaks; exercised by the exhaustive bank in recommendations.test.ts (refusalCount fixture ~line 1932). No dedicated unit-test file (bank + data-deps contract cover it).
- Current: OK — reads only declared `assistantFeatures`.
- Location: OK.

### src/lib/detectors/workflow/autonomy-over-steered.test.ts
- Feature: Unit tests for `workflow.autonomy-over-steered` (steering-load vs task-success join, #1266 axis).
- If removed: vitest CI loses monotone-inverse suppression / weighting coverage; imports `./autonomy-over-steered`.
- Current: OK.
- Location: OK.

### src/lib/detectors/workflow/autonomy-over-steered.ts
- Feature: `workflow.autonomy-over-steered` rec — tasks that passed success proxy despite heavy corrective/clarifying steering → grant more autonomy (#1751); action-domain: workflow.
- If removed: index.ts:107 (catalog :302) breaks; also feeds human-input-leverage conceptually (that detector re-reads `taskSteering` itself, no import edge).
- Current: OK — dataDeps `['taskSteering','taskSuccess']` match reads.
- Location: OK.

### src/lib/detectors/workflow/blocked-task-pileup.test.ts
- Feature: Unit tests for `workflow.blocked-task-pileup` (blocked-DAG-root detector, #559).
- If removed: vitest CI loses pileup-threshold/root-attribution coverage; imports `./blocked-task-pileup`.
- Current: OK.
- Location: OK.

### src/lib/detectors/workflow/blocked-task-pileup.ts
- Feature: `workflow.blocked-task-pileup` rec — ≥2 tasks stalled behind one never-completed blockedBy root (#559); action-domain: workflow.
- If removed: index.ts:95 (catalog :270) breaks → engine/API/UI; test + bank fail.
- Current: FINDING (stale, same family as abandoned-tasks): comment lines 8-9 and `'tasks' as keyof RecommendationInput` cast (line 20) + input cast (line 23) — `tasks` is first-class at types.ts:648.
- Location: OK.

### src/lib/detectors/workflow/churn-geometry.test.ts
- Feature: Unit tests for `workflow.churn-geometry` (line-level structuredPatch rework, #597).
- If removed: vitest CI loses post-stop-reedit/rework-distance threshold coverage; imports `./churn-geometry`.
- Current: OK.
- Location: OK.

### src/lib/detectors/workflow/churn-geometry.ts
- Feature: `workflow.churn-geometry` rec — high gross-vs-net line churn / post-stop re-edit ranges signal trial-and-error rework (#597); action-domain: workflow.
- If removed: index.ts:101 (catalog :278) breaks; consumes `churnGeometry` input (types.ts:630) produced by parse-churn-geometry.
- Current: OK — dataDeps `['churnGeometry']` matches reads.
- Location: OK.

### src/lib/detectors/workflow/conversational-availability.test.ts
- Feature: Unit tests for `workflow.conversational-availability` (backgroundable-foreground-call detector, #2230) incl. provenance validation.
- If removed: vitest CI loses BFC classification / no-double-count-with-passive-wait coverage; imports `./conversational-availability` + `../provenance`.
- Current: OK.
- Location: OK.

### src/lib/detectors/workflow/conversational-availability.ts
- Feature: `workflow.conversational-availability` rec — in-turn foreground tool calls that were backgroundable blocked the human's thread (#2230, epic #2227); action-domain: workflow.
- If removed: index.ts:110 (catalog :467) breaks; shares `collectSessionBfcs` with src/lib/experiments/conversational-availability-metric (experiment axis 1 metric also loses its detector consumer).
- Current: OK — dataDeps `['timelines']`; complementary split vs `reliability.passive-wait-stall` documented and enforced (turn-end vs in-turn).
- Location: OK; metric helper correctly lives in `experiments/`, detector here.

### src/lib/detectors/workflow/correction-mining.test.ts
- Feature: Unit tests for `workflow.correction-mining` (failed→fixed fact mining, #1040).
- If removed: vitest CI loses correction-aggregation and marker-suppression coverage; imports `./correction-mining`.
- Current: OK.
- Location: OK.

### src/lib/detectors/workflow/correction-mining.ts
- Feature: `workflow.correction-mining` rec — mines errored→succeeded same-tool sequences into pinnable CLAUDE.md facts (#1040, epic #866); action-domain: workflow.
- If removed: index.ts:105 (catalog :296) breaks; human-input-leverage reuses its `mineCorrections` signal via parse-tools, and the adoption scorecard loses `workflow.correction-mining` marker tracking.
- Current: OK — appliedMarkers present and mirrored in FINDING_MARKER_CATALOG (applied-markers.ts, `MARKERS_CORRECTIONS`, byte-identical; contract test guards); dataDeps `['toolData','liveConfig']` match reads.
- Location: OK.

### src/lib/detectors/workflow/failed-workflow-runs.test.ts
- Feature: Unit tests for `workflow.failed-workflow-runs` (#635).
- If removed: vitest CI loses fail-status/agent-state regex coverage; imports `./failed-workflow-runs`.
- Current: OK.
- Location: OK.

### src/lib/detectors/workflow/failed-workflow-runs.ts
- Feature: `workflow.failed-workflow-runs` rec — Workflow-tool runs that failed/aborted or left agents in error state = wasted fan-out (#635); action-domain: workflow.
- If removed: index.ts:98 (catalog :273) breaks; consumes `workflows` input (parse-workflows).
- Current: OK — dataDeps `['workflows']` matches reads.
- Location: OK.

### src/lib/detectors/workflow/file-churn.ts
- Feature: `workflow.file-churn` rec — files edited HIGH_CHURN+ times as design-smell signal; action-domain: workflow.
- If removed: index.ts:83 (catalog :213) breaks. No dedicated test file; the underlying `topChurnFiles` is tested in parse-files.test.ts and the detector is exercised by the exhaustive bank + data-deps contract.
- Current: OK — tiny, reads only declared `toolData`.
- Location: OK.

### src/lib/detectors/workflow/harmful-habit.test.ts
- Feature: Unit tests for `workflow.harmful-habit` (#549).
- If removed: vitest CI loses hurts-verdict→recommendation ranking coverage; imports `./harmful-habit`.
- Current: OK.
- Location: OK.

### src/lib/detectors/workflow/harmful-habit.ts
- Feature: `workflow.harmful-habit` rec — surfaces habit factors whose `analyzeHabitImpact` verdict is "hurts" with a prescriptive per-factor action (#549); action-domain: workflow.
- If removed: index.ts:104 (catalog :293) breaks; recomputes the Patterns view's (SessionPatterns.tsx) report engine-side via parse-timeline-success.
- Current: OK — dataDeps `['timelines','tokenData','toolData','apiErrors']` match the analyzeHabitImpact call (lines 59-62); localStorage-tags limitation honestly documented.
- Location: OK.

### src/lib/detectors/workflow/human-input-leverage.test.ts
- Feature: Unit tests for `workflow.human-input-leverage` (#2200) incl. fix-validity checks.
- If removed: vitest CI loses excursion-join/fix-snippet coverage; imports `./human-input-leverage` + `../fix-validity`.
- Current: OK.
- Location: OK.

### src/lib/detectors/workflow/human-input-leverage.ts
- Feature: `workflow.human-input-leverage` rec — dollarizes excursions (token-outlier spans carrying steering/correction/interrupt signals) a small upfront human question would have averted (#2200, keystone of epic #1934); action-domain: workflow.
- If removed: index.ts:108 (catalog :305) breaks; adoption scorecard loses its marker entry.
- Current: OK — local `MARKERS_HUMAN_INPUT` (line 75) byte-matches catalog `MARKERS_HUMAN_INPUT_LEVERAGE` (applied-markers.ts:154, contract-test-guarded); wide dataDeps declared and read.
- Location: OK.

### src/lib/detectors/workflow/low-tool-effectiveness.test.ts
- Feature: Unit tests for `workflow.low-tool-effectiveness` (#423).
- If removed: vitest CI loses score-threshold + PostToolUse-hook self-suppression coverage; imports `./low-tool-effectiveness`.
- Current: OK.
- Location: OK.

### src/lib/detectors/workflow/low-tool-effectiveness.ts
- Feature: `workflow.low-tool-effectiveness` rec — tools with persistently low composite effectiveness (error/undo/retry vs forward motion), self-suppressing once a PostToolUse hook exists (#423); action-domain: workflow.
- If removed: index.ts:90 (catalog :255) breaks; shares `computeToolEffectiveness` with tool-undo-rate and the Tools view.
- Current: OK — dataDeps `['toolData','apiErrors','timelines','liveConfig']` all read.
- Location: OK.

### src/lib/detectors/workflow/mid-turn-interrupt-steering.test.ts
- Feature: Unit tests for `workflow.mid-turn-interrupt-steering` (#1754) incl. sentinel anchoring via `isInterruptSentinel`.
- If removed: vitest CI loses orphaned-turn scoping / quoted-sentinel false-positive coverage; imports `./mid-turn-interrupt-steering` + parse-timeline.
- Current: OK.
- Location: OK.

### src/lib/detectors/workflow/mid-turn-interrupt-steering.ts
- Feature: `workflow.mid-turn-interrupt-steering` rec — prices output tokens discarded when a human interrupts mid-response (first dollarized steering-friction signal, #1754); action-domain: workflow.
- If removed: index.ts:109 (catalog :457) breaks; human-input-leverage header cites its signal (re-derived, no import edge).
- Current: OK — dataDeps `['timelines','tokenData']` match reads (lines 133, 137); honest minority-of-turns framing documented.
- Location: OK.

### src/lib/detectors/workflow/native-bypass.test.ts
- Feature: Unit tests for `workflow.native-bypass` (677 lines: scope split, staleness, deny-shadow, marker suppression).
- If removed: vitest CI loses the largest bypass-classification suite; imports `./native-bypass`.
- Current: OK.
- Location: OK.

### src/lib/detectors/workflow/native-bypass.ts
- Feature: `workflow.native-bypass` rec — shell commands (cat/grep/find…) re-implementing first-class tools, with guidance snippet fix and reclaim claim; action-domain: workflow.
- If removed: index.ts:80 (catalog :210) breaks; also consumers src/lib/native-bypass-snippet.ts and reclaim cascade lose their emitting detector; adoption scorecard marker entry orphaned.
- Current: OK — `MARKERS_NATIVE_BYPASS` byte-matches catalog (applied-markers.ts, contract-guarded); dataDeps `['toolData','tokenData','liveConfig']` read.
- Location: OK.

### src/lib/detectors/workflow/owner-concentration.test.ts
- Feature: Unit tests for `workflow.owner-concentration` (#942) incl. exported thresholds and alias resolution.
- If removed: vitest CI loses share/threshold + contributor-alias coverage; imports from `./owner-concentration`.
- Current: OK.
- Location: OK.

### src/lib/detectors/workflow/owner-concentration.ts
- Feature: `workflow.owner-concentration` rec — one named owner carries most open tasks (first multi-user rec, #942); action-domain: workflow.
- If removed: index.ts:96 (catalog :271) breaks; uses organization-identity alias resolver shared with review-bottleneck.
- Current: OK — dataDeps `['tasks','sessions','organizationIdentity']` (note: declares `tasks` plainly, confirming the field is first-class — corroborates the stale casts flagged in abandoned-tasks/blocked-task-pileup).
- Location: OK.

### src/lib/detectors/workflow/plan-missing-verification.test.ts
- Feature: Unit tests for `workflow.plan-missing-verification` (#565).
- If removed: vitest CI loses file-ref/word thresholds + marker suppression coverage; imports `./plan-missing-verification`.
- Current: OK.
- Location: OK.

### src/lib/detectors/workflow/plan-missing-verification.ts
- Feature: `workflow.plan-missing-verification` rec — large/sprawling plan-mode docs lacking a Verification section (#565, P5); action-domain: workflow.
- If removed: index.ts:103 (catalog :280) breaks; consumes `plans` input (parse-plans, types.ts:681); adoption-loop marker orphaned.
- Current: OK — `MARKERS_PLAN_VERIFICATION` byte-matches catalog; dataDeps `['plans']`.
- Location: OK.

### src/lib/detectors/workflow/procedural-memory.test.ts
- Feature: Unit tests (1029 lines) for `workflow.procedural-memory` (#2250): matchKey normalization, contiguity, provenance.
- If removed: vitest CI loses the near-lossless matchKey / quoted-whitespace semantics coverage; imports `./procedural-memory`.
- Current: OK.
- Location: OK.

### src/lib/detectors/workflow/procedural-memory.ts
- Feature: `workflow.procedural-memory` rec — recurring contiguous multi-step Bash procedures with no backing skill → capture as a skill (#2250, epic #2265); action-domain: workflow.
- If removed: index.ts:112 (catalog :484) breaks; sibling boundary docs in session-restart-retype reference it.
- Current: OK — dataDeps `['toolData','liveConfig','sessions','tokenData']`; `claimClass:'accounting'` posture documented per auditable-claim contract.
- Location: OK.

### src/lib/detectors/workflow/prompt-clarity.ts
- Feature: `workflow.prompt-clarity` rec — correlates low-specificity opening prompts with follow-up-turn/error load (#promptAnalysis consumer); action-domain: workflow.
- If removed: index.ts:106 (catalog :299) breaks; covered via recommendations.test.ts bank + canonical-evidence.test.ts (no dedicated unit file — acceptable, bank is exhaustive over the catalog per #507).
- Current: OK — dataDeps `['promptAnalysis','timelines','apiErrors']` all read (lines 90-96).
- Location: OK.

### src/lib/detectors/workflow/reclaim-wait-windows.test.ts
- Feature: Unit tests for `workflow.reclaim-wait-windows` (#1880) incl. provenance validation.
- If removed: vitest CI loses wait-class ruleset/safety-filter coverage; imports `./reclaim-wait-windows` + `../provenance`.
- Current: OK.
- Location: OK.

### src/lib/detectors/workflow/reclaim-wait-windows.ts
- Feature: `workflow.reclaim-wait-windows` rec — authors the suggest-only wait-class reclaim ruleset consumed by the Stop-hook enforcer (#1880, part of #867); action-domain: workflow.
- If removed: index.ts:111 (catalog :476) breaks; the ~/.claude Stop-hook wait-window path loses its policy source.
- Current: OK — `dependsOn: ['reliability.passive-wait-stall']` is a real import (`collectSessionStalls`, line 3), satisfying the data-deps contract's dependsOn rule; dataDeps `['timelines']`.
- Location: OK — cross-category import of the reliability detector's helper is the declared, contract-checked pattern.

### src/lib/detectors/workflow/redundant-reads.test.ts
- Feature: Unit tests for `workflow.redundant-reads`.
- If removed: vitest CI loses re-read token estimate + marker suppression coverage; imports `./redundant-reads`.
- Current: OK.
- Location: OK.

### src/lib/detectors/workflow/redundant-reads.ts
- Feature: `workflow.redundant-reads` rec — same file Read repeatedly in one session, direct-estimate dollar lever (#951) with reclaim claim; action-domain: workflow.
- If removed: index.ts:81 (catalog :211) breaks; adoption scorecard marker entry (`MARKERS_REDUNDANT_READS`) orphaned; reclaim cascade loses this lever.
- Current: OK — markers byte-match catalog; dataDeps `['toolData','tokenData','liveConfig']` read.
- Location: OK.

### src/lib/detectors/workflow/repeated-commands.test.ts
- Feature: Unit tests for `workflow.repeated-commands`.
- If removed: vitest CI loses repeat-threshold + marker suppression coverage; imports `./repeated-commands`.
- Current: OK.
- Location: OK.

### src/lib/detectors/workflow/repeated-commands.ts
- Feature: `workflow.repeated-commands` rec — identical Bash commands run 3+ times per session → script/automate them; action-domain: workflow.
- If removed: index.ts:82 (catalog :212) breaks; `MARKERS_REPEATED_COMMANDS` catalog entry orphaned.
- Current: OK — markers byte-match catalog; dataDeps `['toolData','liveConfig']`.
- Location: OK.

### src/lib/detectors/workflow/review-bottleneck.test.ts
- Feature: Unit tests for `workflow.review-bottleneck` (#1123) incl. exported thresholds + provenance.
- If removed: vitest CI loses stale-review threshold/alias coverage; imports from `./review-bottleneck` (line 13).
- Current: OK.
- Location: OK.

### src/lib/detectors/workflow/review-bottleneck.ts
- Feature: `workflow.review-bottleneck` rec — stale PR review-request queues from structured reviewEvents only (never inferred from transcripts, #1123); action-domain: workflow.
- If removed: index.ts:97 (catalog :272) breaks; consumes `reviewEvents` + `organizationIdentity` (types.ts:664/657).
- Current: OK — stays-dark-without-aggregate posture documented; dataDeps match.
- Location: OK.

### src/lib/detectors/workflow/rework-signature.test.ts
- Feature: Unit tests for `workflow.rework-signature` (#564).
- If removed: vitest CI loses reworkScore/burst-rate threshold coverage; imports `./rework-signature`.
- Current: OK.
- Location: OK.

### src/lib/detectors/workflow/rework-signature.ts
- Feature: `workflow.rework-signature` rec — retry-storm signature from file-history checkpoint bursts (churn × burstRate, #564 P5); action-domain: workflow.
- If removed: index.ts:100 (catalog :277) breaks; consumes `fileHistory` (parse-file-history).
- Current: FINDING (minor stale): line 35-36 still casts `(input as RecommendationInput & { fileHistory?: FileHistorySession[] })` although its own comment (line 34) and types.ts:679 say `fileHistory` is first-class — dead cast, same family as abandoned-tasks/blocked-task-pileup.
- Location: OK.

### src/lib/detectors/workflow/runaway-workflow-cost.test.ts
- Feature: Unit tests for `workflow.runaway-workflow-cost` (#635).
- If removed: vitest CI loses median-outlier/absolute-floor and fan-out reclaim coverage; imports `./runaway-workflow-cost`.
- Current: OK.
- Location: OK.

### src/lib/detectors/workflow/runaway-workflow-cost.ts
- Feature: `workflow.runaway-workflow-cost` rec — Workflow run whose token spend is a ≥3× median outlier, with cacheWrite5m→cacheRead reclaim claim (#635); action-domain: workflow.
- If removed: index.ts:99 (catalog :274) breaks; reclaim cascade loses the fan-out lever.
- Current: OK — declares `tokenData` it never reads directly, but that is deliberate: the reclaim claim's scopes resolve against tokenData downstream (documented lines 59-63), so the declaration keeps the field present in assembled/light datasets; not a contract violation.
- Location: OK.

### src/lib/detectors/workflow/session-restart-retype.test.ts
- Feature: Unit tests for `workflow.session-restart-retype` (#2505) incl. engine-level integration via `buildRecommendations`.
- If removed: vitest CI loses opener-similarity/unattended-entrypoint exclusion coverage; imports `./session-restart-retype` + `../../recommendations`.
- Current: OK.
- Location: OK.

### src/lib/detectors/workflow/session-restart-retype.ts
- Feature: `workflow.session-restart-retype` rec — new session re-types the same task instead of `--resume`/`--continue` (#2505, epic #2199); action-domain: workflow.
- If removed: index.ts:114 (catalog :499) breaks; `MARKERS_SESSION_RESTART_RETYPE` catalog entry orphaned.
- Current: OK — local `MARKERS` (line 102) byte-matches catalog (applied-markers.ts:164); dataDeps `['tokenData','sessions','liveConfig']`; sibling-boundary doc (cross-session-reread / procedural-memory / value-of-agent-handoff) accurate.
- Location: OK.

### src/lib/detectors/workflow/shadow-axis-wins.ts
- Feature: `workflow.shadow-axis-wins` rec — adopt a shadow-calls axis whose variation consistently beats Main, plus per-finding recs-axis efficacy verdicts (#518/#523/#545/#579); action-domain: workflow.
- If removed: index.ts:91 (catalog :258) breaks; ALSO exports `MIN_SAMPLES`/`MIN_DECIDED`/`MIN_SHADOW_WIN_RATE`/`clearsVariationThresholds` consumed by workflow/shadow-prompt.ts and `clearsShadowWinThresholds` by context/over-scoped-config-section.ts (its `dependsOn` edge). Covered via parse-shadow-calls.test.ts + recommendations.test.ts bank (no dedicated unit file).
- Current: OK — `MARKERS_SHADOW_AXIS_WINS` matches catalog; dataDeps `['shadowCalls']`.
- Location: OK.

### src/lib/detectors/workflow/shadow-prompt.test.ts
- Feature: Unit tests for `workflow.shadow-prompt` (#2555) incl. threshold-sharing with shadow-axis-wins.
- If removed: vitest CI loses per-variation prompt-receipt coverage; imports `./shadow-prompt` and `./shadow-axis-wins`.
- Current: OK.
- Location: OK.

### src/lib/detectors/workflow/shadow-prompt.ts
- Feature: `workflow.shadow-prompt` rec — names the exact winning prompt-axis variation from per-variation shadow receipts (#2555, epic #2561); action-domain: workflow.
- If removed: index.ts:92 (catalog :262) breaks; the prompt-axis exclusion contract with shadowAxisWins/uncoveredShadowAxis (index.ts:260-261 comment) would leave the prompt axis unrepresented.
- Current: OK — `dependsOn: ['workflow.shadow-axis-wins']` backed by a real import (thresholds, line 4-9); `MARKERS_SHADOW_PROMPT` matches catalog; dataDeps `['shadowCalls','liveConfig']`.
- Location: OK.

### src/lib/detectors/workflow/shared-checkout-rework.test.ts
- Feature: Unit tests (629 lines) for `workflow.shared-checkout-rework` (#956).
- If removed: vitest CI loses git-segment signature classification coverage; imports `./shared-checkout-rework`.
- Current: OK.
- Location: OK.

### src/lib/detectors/workflow/shared-checkout-rework.ts
- Feature: `workflow.shared-checkout-rework` rec — shared-checkout / foreign-HEAD-swap rework signature → recommend worktree-first (#956, epic #866); action-domain: workflow.
- If removed: index.ts:102 (catalog :279) breaks; consumes parse-tools git command segments.
- Current: OK — command-pattern-only data scoping honestly documented (no output text/cwd available); dataDeps `['toolData']`.
- Location: OK.

### src/lib/detectors/workflow/tool-undo-rate.test.ts
- Feature: Unit tests for `workflow.tool-undo-rate` (#422).
- If removed: vitest CI loses undo-rate threshold + PreToolUse-hook self-suppression coverage; imports `./tool-undo-rate`.
- Current: OK.
- Location: OK.

### src/lib/detectors/workflow/tool-undo-rate.ts
- Feature: `workflow.tool-undo-rate` rec — file-edit tools rolled back ≥10% of the time, self-suppressing when a PreToolUse Edit|Write hook exists (#422); action-domain: workflow.
- If removed: index.ts:89 (catalog :254) breaks; shares `computeToolEffectiveness` with low-tool-effectiveness.
- Current: OK — dataDeps `['toolData','apiErrors','timelines','liveConfig']`.
- Location: OK.

### src/lib/detectors/workflow/uncovered-shadow-axis.ts
- Feature: `workflow.uncovered-shadow-axis` rec — discovery: a winning shadow axis with no dedicated catalog rule → fix is a `gh issue` filing command (#530, ADR 0002 deterministic MVP); action-domain: workflow.
- If removed: index.ts:93 (catalog :263) breaks; the shadow→new-rule discovery loop (#511 feedback rule) loses its engine half. Covered via parse-shadow-calls.test.ts + recommendations.test.ts (no dedicated unit file).
- Current: OK, one note — it re-declares `MIN_SAMPLES`/`MIN_DECIDED`/`MIN_SHADOW_WIN_RATE` locally (lines 18-20) instead of importing shadow-axis-wins' exports the way shadow-prompt.ts does; values match today (5/3/0.6) but can silently drift (see FINDINGS).
- Location: OK.

### src/lib/detectors/workflow/unused-installed-commands.test.ts
- Feature: Unit tests for `workflow.unused-installed-commands` (#634).
- If removed: vitest CI loses zero-invocation window coverage; imports `./unused-installed-commands`.
- Current: OK.
- Location: OK.

### src/lib/detectors/workflow/unused-installed-commands.ts
- Feature: `workflow.unused-installed-commands` rec — installed slash commands with zero 30-day invocations, copy-only prune fix (#634); action-domain: workflow.
- If removed: index.ts:87 (catalog :252) breaks; one of the four config-hygiene siblings over `computeConfigHygiene`/`buildConfigRemovalSnippetBlock`.
- Current: OK — dataDeps `['liveConfig','attribution','sessions']` all read.
- Location: OK.

### src/lib/detectors/workflow/unused-installed-plugins.test.ts
- Feature: Unit tests for `workflow.unused-installed-plugins`.
- If removed: vitest CI loses plugin-slice filter coverage; imports `./unused-installed-plugins`.
- Current: OK.
- Location: OK.

### src/lib/detectors/workflow/unused-installed-plugins.ts
- Feature: `workflow.unused-installed-plugins` rec — installed-but-unused plugins with prune command; action-domain: workflow.
- If removed: index.ts:88 (catalog :253) breaks; config-hygiene sibling (see -commands).
- Current: OK — note it has no `MIN_UNUSED` floor unlike its three siblings (fires at 1 unused plugin); appears intentional (plugins are heavier installs) — not flagged.
- Location: OK.

### src/lib/detectors/workflow/unused-installed-skills.test.ts
- Feature: Unit tests for `workflow.unused-installed-skills` (#421).
- If removed: vitest CI loses skill-slice/MIN_UNUSED coverage; imports `./unused-installed-skills`.
- Current: OK.
- Location: OK.

### src/lib/detectors/workflow/unused-installed-skills.ts
- Feature: `workflow.unused-installed-skills` rec — installed skills with zero 30-day invocations (#421); action-domain: workflow.
- If removed: index.ts:85 (catalog :250) breaks; config-hygiene sibling.
- Current: OK.
- Location: OK.

### src/lib/detectors/workflow/unused-installed-subagents.test.ts
- Feature: Unit tests for `workflow.unused-installed-subagents` (#633).
- If removed: vitest CI loses subagent-slice coverage; imports `./unused-installed-subagents`.
- Current: OK.
- Location: OK.

### src/lib/detectors/workflow/unused-installed-subagents.ts
- Feature: `workflow.unused-installed-subagents` rec — installed subagent definitions with zero 30-day invocations (#633); action-domain: workflow.
- If removed: index.ts:86 (catalog :251) breaks; config-hygiene sibling.
- Current: OK.
- Location: OK.

### src/lib/detectors/workflow/value-of-agent-handoff.test.ts
- Feature: Unit tests (4184 lines — largest in the group) for `workflow.value-of-agent-handoff` (#2312): durable-mutation classification, leave-behind observation, rediscovery windows.
- If removed: vitest CI loses the entire handoff-detector behavioural suite; imports `./value-of-agent-handoff`.
- Current: OK.
- Location: OK.

### src/lib/detectors/workflow/value-of-agent-handoff.ts
- Feature: `workflow.value-of-agent-handoff` rec — sessions that mutated durable external state without a leave-behind artifact, priced by later rediscovery (#2312, epic #2281 inverse-handoff); action-domain: workflow.
- If removed: index.ts:113 (catalog :491) breaks; joins parse-tools `classifyDurableCommand`, leave-behind.ts, project-identity.ts, parse-timeline rediscovery — engine half of the runbook-autofire loop's evidence.
- Current: OK — local `MARKERS` (line 74) byte-matches catalog `MARKERS_VALUE_OF_AGENT_HANDOFF` (applied-markers.ts:158, contract-guarded); dataDeps `['toolData','timelines','sessions','tokenData','liveConfig']`. At 2146 lines it is the largest single detector — decomposition candidate but not a defect.
- Location: OK.

FINDINGS:
1. `src/lib/detectors/workflow/abandoned-tasks.ts:8-10,23,28` — stale: header comment and `'tasks' as keyof RecommendationInput` cast (plus the `input as … & { tasks?: TaskRecord[] }` cast) claim `tasks` is "not yet in the shared RecommendationInput type"; it is first-class at `src/lib/detectors/types.ts:648` (owner-concentration declares it plainly). Dead casts + misleading comment.
2. `src/lib/detectors/workflow/blocked-task-pileup.ts:8-9,20,23` — same stale "new optional field / not in shared type" cast-and-comment pattern for the now-first-class `tasks` field.
3. `src/lib/detectors/workflow/rework-signature.ts:35-36` — redundant `(input as RecommendationInput & { fileHistory?: … })` cast for `fileHistory`, which is first-class at `types.ts:679`; the file's own comment at line 34 acknowledges this, leaving a dead cast.
4. `src/lib/detectors/workflow/uncovered-shadow-axis.ts:18-20` — duplicates the evidence-bar constants (`MIN_SAMPLES`/`MIN_DECIDED`/`MIN_SHADOW_WIN_RATE`) locally instead of importing shadow-axis-wins' exports (as shadow-prompt.ts does); values match today (5/3/0.6) but nothing prevents silent drift between the adopt-axis and discovery detectors' thresholds.


### — group: detectors-2 (37 files) —

### src/lib/detectors/reliability/agent-report-card.test.ts
- Feature: Unit tests pinning `reliability.agent-report-card` wording — MOVE-verdict disambiguation (#1103, low-signal vs heavy-drag).
- If removed: vitest `test` CI job loses the only wording regression guard for the report-card detector; no other module imports it.
- Current: OK — imports `./agent-report-card` and exercises `detector.rule` with inline fixtures.
- Location: OK (co-located with detector).

### src/lib/detectors/reliability/agent-report-card.ts
- Feature: `reliability.agent-report-card` rec (#572) — consolidated KEEP/FLAG/MOVE project verdict for the Agent Report Card surface; project-portfolio reliability domain.
- If removed: barrel import breaks (src/lib/detectors/index.ts:142), `/api/recommendations.json` + `/recs` lose the finding; its test file fails.
- Current: OK. Registered; dataDeps `['sessionRegistry','telemetry','debugLogs','sessions','tokenData']` all actually read (agent-report-card.ts:26-30); no fix/markers.
- Location: OK — category folder matches emitted `category: 'reliability'`.

### src/lib/detectors/reliability/api-errors.ts
- Feature: Dual-emit detector — `reliability.rate-limits` (429/529 pacing fix, CLAUDE.md target) and `reliability.api-errors` (info branch); rate-limit-hygiene domain.
- If removed: barrel import breaks (index.ts:133); dual-emit registry entry dangles (src/lib/detectors/dual-emit.ts:14); external-guidance target `reliability.rate-limits` dangles (external-guidance-registry.ts:189).
- Current: FINDING — the fix-bearing finding is emitted as `reliability.rate-limits` (api-errors.ts:35,49), but `FINDING_MARKER_CATALOG` keys markers under the detector id `reliability.api-errors` only (applied-markers.ts:181; no `rate-limits` key anywhere in that file), and `buildAdoptionScorecard` looks up markers by receipt finding-id (adoption-scorecard.ts:316,331). A SURFACED-only `reliability.rate-limits` receipt therefore can never resolve its live hunk and reach the #1785 early-ADOPTED state; the catalog entry it does have is attached to the info branch, which ships no fix. Suppression-path adoption still works via `suppressed.markerHeading`.
- Location: OK. No dedicated unit test (covered via recommendations.test.ts catalog tests).

### src/lib/detectors/reliability/config-drift.test.ts
- Feature: Tests for `reliability.config-drift` — recency window, severity escalation, disabled-server headline, evidence formatting.
- If removed: vitest CI loses the only direct coverage of the drift detector; nothing else imports it.
- Current: OK.
- Location: OK.

### src/lib/detectors/reliability/config-drift.ts
- Feature: `reliability.config-drift` rec (P11) — project MCP/config drifted in last 7 days / server silently disabled, from `~/.claude/backups` diffs; config-hygiene domain, view `permissions`.
- If removed: barrel import breaks (index.ts:141); ingest's `configBackups` pipeline (scripts/ingest.mjs:4190) loses its only detector consumer.
- Current: FINDING (minor doc-rot) — `dataDeps: ['configBackups' as keyof RecommendationInput]` + "Access the new optional field without touching the shared types file" (config-drift.ts:47-50) are stale: `configBackups` is a first-class field (detectors/types.ts:687), so the cast and comment misdescribe the type.
- Location: OK; dataDeps declared = read.

### src/lib/detectors/reliability/cwd-drift-execution.test.ts
- Feature: Tests for `reliability.cwd-drift-execution` — anchor grammar (git -C / gh -R / GH_REPO= / cd &&), guard suppression, marker suppression.
- If removed: vitest CI loses the anchor-parsing regression net for a regex-heavy detector; nothing else imports it.
- Current: OK.
- Location: OK.

### src/lib/detectors/reliability/cwd-drift-execution.ts
- Feature: `reliability.cwd-drift-execution` rec (#1870) — unanchored `git`/`gh` Bash segments that can silently hit the wrong repo; execution-hygiene domain, CLAUDE.md fix.
- If removed: barrel import breaks (index.ts:146); FINDING_MARKER_CATALOG entry (applied-markers.ts:207) orphans and the applied-markers contract test fails.
- Current: OK — markers present in catalog keyed by its emitted id; dataDeps `['toolData','liveConfig']` match reads; also honors `hasPreToolUseAnchorGuard` equivalent-suppression.
- Location: OK.

### src/lib/detectors/reliability/discovery-freshness.test.ts
- Feature: Tests for `reliability.discovery-freshness` — read→file-changed→edit-without-reread windows, repo-map mtime gating, marker suppression.
- If removed: vitest CI loses coverage of the mtime-interval logic (#2325); nothing else imports it.
- Current: OK.
- Location: OK.

### src/lib/detectors/reliability/discovery-freshness.ts
- Feature: `reliability.discovery-freshness` rec (#2325) — file was Read, changed on disk (repo-map `mtimeMs`), then Edited without re-read; stale-read hygiene domain, CLAUDE.md fix.
- If removed: barrel import breaks (index.ts:148); catalog entry applied-markers.ts:209 orphans (contract test fails); the repo-map `mtimeMs` capture loses this consumer.
- Current: OK — dataDeps `['toolData','repoMap','liveConfig']` all read; markers in catalog.
- Location: OK.

### src/lib/detectors/reliability/dropped-assignments.test.ts
- Feature: Tests for `reliability.dropped-assignments` (#560) — null/severity/evidence paths on inline TeamSummary fixtures.
- If removed: vitest CI loses the only coverage of the teams-inbox detector.
- Current: OK.
- Location: OK.

### src/lib/detectors/reliability/dropped-assignments.ts
- Feature: `reliability.dropped-assignments` rec (#560) — inter-agent task assignments never acknowledged by worker agents (`teams/` inbox health); multi-agent orchestration domain.
- If removed: barrel import breaks (index.ts:138); ingest's `teams` parsing loses its detector consumer.
- Current: FINDING (minor doc-rot) — "`teams` is a new optional field" + `as keyof RecommendationInput` cast and "cast to avoid touching the shared RecommendationInput type in this PR" (dropped-assignments.ts:26-27,31-33) are stale: `teams` is first-class in detectors/types.ts:650.
- Location: OK.

### src/lib/detectors/reliability/ghost-session.test.ts
- Feature: Tests (721 lines) for `reliability.ghost-session` — affirmative-edit-request grammar, delegated-tool exemptions, marker suppression.
- If removed: vitest CI loses the regression net for the largest regex surface in the group.
- Current: OK.
- Location: OK.

### src/lib/detectors/reliability/ghost-session.ts
- Feature: `reliability.ghost-session` rec — session where the user asked for an edit, the agent read ≥5 files but never edited/delegated; task-follow-through domain, CLAUDE.md fix.
- If removed: barrel import breaks (index.ts:149); catalog entry applied-markers.ts:210 orphans (contract test fails).
- Current: OK — uniquely imports `MARKERS_GHOST_SESSION` from the leaf catalog (ghost-session.ts:3) rather than declaring locally; contract test still holds (values identical by construction). dataDeps `['toolData','timelines','liveConfig']` match reads.
- Location: OK.

### src/lib/detectors/reliability/hook-errors.test.ts
- Feature: Tests for `reliability.hook-errors` — threshold, and #1102 past-/present-tense demotion when no Stop hook is still configured.
- If removed: vitest CI loses the stale-input-demotion guard.
- Current: OK.
- Location: OK.

### src/lib/detectors/reliability/hook-errors.ts
- Feature: `reliability.hook-errors` rec (#419) — ≥3 Stop-hook error events; hook-health domain, tense-demoted via `liveConfig` (#1102).
- If removed: barrel import breaks (index.ts:136); `aggregateStopHooks` error path loses a consumer.
- Current: OK — dataDeps `['runtimeEvents','liveConfig']` both read; no markers (fix targets hooks, not CLAUDE.md).
- Location: OK.

### src/lib/detectors/reliability/hook-prevented-continuation.test.ts
- Feature: Tests for `reliability.hook-prevented-continuation` threshold and fix payload.
- If removed: vitest CI loses the only direct coverage.
- Current: OK.
- Location: OK.

### src/lib/detectors/reliability/hook-prevented-continuation.ts
- Feature: `reliability.hook-prevented-continuation` rec (#420) — ≥5 Stop-hook blocking exits halting unattended runs; hook-health domain, `target: 'hook'` fix.
- If removed: barrel import breaks (index.ts:137).
- Current: OK — dataDeps `['runtimeEvents']` matches the single read; hook-target fix legitimately carries no appliedMarkers.
- Location: OK.

### src/lib/detectors/reliability/mcp-needs-auth.test.ts
- Feature: Tests for `reliability.mcp-needs-auth` — blocking vs advisory classification and severity.
- If removed: vitest CI loses coverage of the unattended-call classification.
- Current: OK.
- Location: OK.

### src/lib/detectors/reliability/mcp-needs-auth.ts
- Feature: `reliability.mcp-needs-auth` rec — MCP servers needing re-auth, `critical` when unattended sessions call them; MCP-availability domain, `claude mcp auth` command fix.
- If removed: barrel import breaks (index.ts:140); `mcpAuth` ingest field loses its detector consumer.
- Current: OK — dataDeps `['attribution','sessions','mcpAuth']` all read (attribution/sessions via `buildUnattendedCallMap`, mcp-needs-auth.ts:37).
- Location: OK.

### src/lib/detectors/reliability/overload-reretry.test.ts
- Feature: Tests for `reliability.overload-reretry` — 429/529 + `retryAttempt > 1` gate and conservative cacheRead-only reclaim booking.
- If removed: vitest CI loses the gate coverage; also imports `PREFIX_REWASTE_FRAC` from reclaim-prefix.
- Current: OK.
- Location: OK.

### src/lib/detectors/reliability/overload-reretry.ts
- Feature: `reliability.overload-reretry` reclaim lever (epic #944 PR4) — SDK re-retries of overloaded requests re-paying the cache-read prefix; cost-reclaim domain.
- If removed: barrel import breaks (index.ts:144); reclaim cascade loses one cause-side lever.
- Current: OK — dataDeps `['apiErrors','tokenData']` match reads; books `scaleTokens` on cacheRead only at fixed 5% frac per the documented no-`toolUseId` constraint.
- Location: OK.

### src/lib/detectors/reliability/passive-wait-stall.test.ts
- Feature: Tests for `reliability.passive-wait-stall` — stall attribution to forced-human gaps, backgrounded-tool exemption.
- If removed: vitest CI loses the only direct coverage.
- Current: OK.
- Location: OK.

### src/lib/detectors/reliability/passive-wait-stall.ts
- Feature: `reliability.passive-wait-stall` rec (#1873) — assistant turns ending on wait language with no background mechanism, forcing human re-engagement; autonomy/self-resume domain.
- If removed: barrel import breaks (index.ts:145); `entries[].waitLanguage`/`backgrounded` flags in parse-timeline lose their consumer.
- Current: OK — dataDeps `['timelines']` matches the single read.
- Location: OK.

### src/lib/detectors/reliability/reclaim-prefix.ts
- Feature: Shared reliability→token join helper (`PREFIX_REWASTE_FRAC`, `makeWindow`, `resolveReliabilityScopes`) for the two re-paid-prefix reclaim levers; not itself a detector (correctly unregistered).
- If removed: `retry-prefix-rewaste.ts:9`, `overload-reretry.ts:7` and both their tests fail to import — both levers die.
- Current: OK — thoroughly documented conservative-booking contract (doc §6, no `toolUseId` edge).
- Location: OK — only reliability detectors consume it, so living beside them beats `detectors/shared`.

### src/lib/detectors/reliability/retry-prefix-rewaste.test.ts
- Feature: Tests for `reliability.retry-prefix-rewaste` — `hasErrors` gate (not count), window-scoped cacheRead scaling.
- If removed: vitest CI loses the over-booking guard for this lever.
- Current: OK.
- Location: OK.

### src/lib/detectors/reliability/retry-prefix-rewaste.ts
- Feature: `reliability.retry-prefix-rewaste` reclaim lever (epic #944 PR4) — errored retry groups re-paying the cache-read prefix; cost-reclaim domain.
- If removed: barrel import breaks (index.ts:143); reclaim cascade loses a cause-side lever.
- Current: OK — dataDeps `['toolData','tokenData']` match reads; gates on `RetryGroup.hasErrors` per the documented contract.
- Location: OK.

### src/lib/detectors/reliability/retry-storms.ts
- Feature: `reliability.retry-storms` rec — long back-to-back same-tool runs containing errors; retry-hygiene domain, info severity, view `errors`.
- If removed: barrel import breaks (index.ts:134); the errors view loses its storm rec.
- Current: OK — dataDeps `['toolData']` matches; simplest detector in the folder. No dedicated unit test (covered only via recommendations.test.ts catalog checks) — thin but not a defect.
- Location: OK.

### src/lib/detectors/reliability/self-update-health.test.ts
- Feature: Tests for `reliability.self-update-health` — success-rate thresholds, error-code surfacing, cadence formatting.
- If removed: vitest CI loses the only direct coverage.
- Current: OK.
- Location: OK.

### src/lib/detectors/reliability/self-update-health.ts
- Feature: `reliability.self-update-health` rec — CLI auto-update failure rate/cadence/version drift from update snapshots; CLI-health domain.
- If removed: barrel import breaks (index.ts:139); ingest's `updateResults` field (scripts/ingest.mjs:4177) loses its consumer.
- Current: FINDING (minor doc-rot) — `dataDeps: ['updateResults' as keyof RecommendationInput]` + "Pull the optional field without touching the shared RecommendationInput type" (self-update-health.ts:30,32-33) are stale: `updateResults` is first-class in detectors/types.ts:683.
- Location: OK.

### src/lib/detectors/reliability/settings-json-invalid.test.ts
- Feature: Tests for `reliability.settings-json-invalid` — kind prioritization, per-kind remediation fixes, missing-env command fix.
- If removed: vitest CI loses coverage of the remediation-builder branches.
- Current: OK.
- Location: OK.

### src/lib/detectors/reliability/settings-json-invalid.ts
- Feature: `reliability.settings-json-invalid` rec (#417) — settings.json findings (syntax/type/unknown-key/rule-format/missing-env) that Claude Code silently ignores; config-integrity domain, per-kind `RecFix`.
- If removed: barrel import breaks (index.ts:135); `SettingsHealthFinding` pipeline loses its rec surface.
- Current: OK — dataDeps `['liveConfig']` matches; missing-env fix honestly `fixKind: 'manual'` with launch-snapshot caveat.
- Location: OK.

### src/lib/detectors/reliability/stale-state-assertion.test.ts
- Feature: Tests for `reliability.stale-state-assertion` — integration-ref grammar, fetch-coverage window, gh exclusion, marker suppression.
- If removed: vitest CI loses the ref-grammar regression net.
- Current: OK.
- Location: OK.

### src/lib/detectors/reliability/stale-state-assertion.ts
- Feature: `reliability.stale-state-assertion` rec (#1871) — local `git` reads of `origin/master`-class refs with no prior fetch in-session; stale-read hygiene domain, CLAUDE.md fix.
- If removed: barrel import breaks (index.ts:147); catalog entry applied-markers.ts:208 orphans (contract test fails).
- Current: OK — dataDeps `['toolData','liveConfig']` match reads; markers in catalog; measures the behavior the global repo-freshness hook prevents (dogfooding loop documented in-file).
- Location: OK.

### src/lib/detectors/reliability/tool-errors.test.ts
- Feature: Tests for `reliability.tool-errors` — error-rate thresholds, `hasPostEditHook` suppression, adopt-block marker suppression (#1783).
- If removed: vitest CI loses coverage of both suppression paths.
- Current: OK.
- Location: OK.

### src/lib/detectors/reliability/tool-errors.ts
- Feature: `reliability.tool-errors` rec — tools with high error rates, settings.json PostToolUse-hook fix; tool-health domain.
- If removed: barrel import breaks (index.ts:132); catalog entry applied-markers.ts:206 orphans (contract test fails).
- Current: OK — adopt-block wrapper markers (heading + finding-title strict-AND, #1783/#580) present in catalog; dataDeps `['toolData','liveConfig']` match reads.
- Location: OK.

### src/lib/detectors/reliability/workflow-ratelimit-burst.test.ts
- Feature: Tests (1201 lines) for `reliability.workflow-ratelimit-burst` — exhaustion-text matcher, null-state handling, completed-agent false-positive guard, critical thresholds (the 68/24 incident).
- If removed: vitest CI loses the largest evidence-matcher regression net in the group.
- Current: OK.
- Location: OK.

### src/lib/detectors/reliability/workflow-ratelimit-burst.ts
- Feature: `reliability.workflow-ratelimit-burst` rec (#2305, epic #2199) — bursts of agent deaths inside one Workflow run from shared usage-limit exhaustion; fan-out capacity-planning domain.
- If removed: barrel import breaks (index.ts:150); the workflow-manifest ingest loses its rate-limit-cause consumer (generic `workflow.failed-workflow-runs` remains).
- Current: OK — dataDeps `['workflows']` matches the single read; state-gated evidence matching documented against the false-positive case.
- Location: OK — reliability is right even though the sibling generic card lives in workflow/ (the finding is a reliability failure mode, and its emitted category is `reliability`).

FINDINGS:
1. `src/lib/detectors/reliability/api-errors.ts` (dual-emit seam, with `src/lib/detectors/applied-markers.ts:181`): the fix-carrying finding is emitted as `reliability.rate-limits` (api-errors.ts:35,49) but the client-safe marker catalog keys its markers under the detector id `reliability.api-errors` only, and `buildAdoptionScorecard` resolves markers by receipt finding-id (adoption-scorecard.ts:316,331) — so a SURFACED-only `reliability.rate-limits` receipt can never reach the #1785 "fix landed, awaiting quiet" ADOPTED state; the catalog entry that does exist is attached to the markerless info branch. Adoption via later SUPPRESSED receipts (markerHeading fallback) still works, so this degrades, not breaks, the adoption loop.
2. Stale "new optional field / avoid touching the shared types" casts and comments in three detectors — config-drift.ts:47-50 (`configBackups`), dropped-assignments.ts:26-33 (`teams`), self-update-health.ts:30-33 (`updateResults`) — the fields are now first-class on `RecommendationInput` (detectors/types.ts:650,683,687); the `as keyof RecommendationInput` casts are dead weight and the comments misdescribe the type. Doc-rot only; behavior unaffected.


### — group: detectors-3 (38 files) —

### src/lib/detectors/cost/automation-share.test.ts
- Feature: Unit tests for `cost.automation-share` (unattended sdk-session spend share + down-model proof freshness).
- If removed: Test coverage for the detector's fire/suppress/staleness paths lost; run by vitest in the `test` CI job. No other consumers.
- Current: OK — imports `detector` + `DOWN_MODEL_PROOF_FRESHNESS_DAYS` from the sibling module.
- Location: OK (colocated with detector).

### src/lib/detectors/cost/automation-share.ts
- Feature: `cost.automation-share` rec — surfaces the share of spend from unattended/automation sessions and a non-booked down-model ceiling (model-pin action-domain).
- If removed: `src/lib/detectors/index.ts:43` import + `DETECTORS` entry break; `buildRecommendations` → `/api/recommendations.json` loses the rec; its test fails.
- Current: OK. Registered (legacy-RULES section). No appliedMarkers (no fix contract needed). dataDeps `['tokenData','liveConfig','modelPinSavings']` — all real `RecommendationInput` keys (types.ts:707 for `modelPinSavings`); enforced by data-deps contract test.
- Location: OK — cost/ matches `category: 'cost'`.

### src/lib/detectors/cost/batchable-workload.test.ts
- Feature: Unit tests for `cost.batchable-workload` (Batch API -50% lever on sdk-* sessions).
- If removed: Detector regression coverage lost; vitest `test` job only consumer.
- Current: OK.
- Location: OK.

### src/lib/detectors/cost/batchable-workload.ts
- Feature: `cost.batchable-workload` rec (#1755) — token-heavy unattended workloads routable through the Batch API; books the batch claim (orderKey 82).
- If removed: `index.ts:54` import + registration break; the batch reclaim claim disappears from the cost card.
- Current: OK. Registered; no appliedMarkers; dataDeps `['tokenData','runtimeEvents']` contract-checked; category matches folder.
- Location: OK.

### src/lib/detectors/cost/cache-1h-waste.ts
- Feature: `cost.cache-1h-waste` rec — 1h-cache writes billed 2× vs 5-min 1.25× with no post-5-min reuse; fix = CLAUDE.md caching guidance (appliedMarkers).
- If removed: `index.ts:40` import + registration break; `FINDING_MARKER_CATALOG` entry `['cost.cache-1h-waste', …]` (applied-markers.ts:184) orphaned; referenced across recommendations/reclaim/judge tests.
- Current: OK. Markers present in catalog (applied-markers.ts:184). No colocated unit test, but exercised via `src/lib/recommendations.test.ts` and the applied-markers/data-deps contract tests.
- Location: OK.

### src/lib/detectors/cost/cache-economics.test.ts
- Feature: Unit tests for `cost.cache-economics`.
- If removed: Detector coverage lost; vitest only consumer.
- Current: OK.
- Location: OK.

### src/lib/detectors/cost/cache-economics.ts
- Feature: `cost.cache-economics` rec — context-cost breakdown (uncached input vs cache writes vs reads), awareness-level cost lever.
- If removed: `index.ts:41` import + registration break; rec vanishes from `/api/recommendations.json`.
- Current: OK. Registered; dataDeps `['tokenData']` minimal and contract-checked; explicitly does not claim the dead-token tranche (honest sizing).
- Location: OK.

### src/lib/detectors/cost/disproportionate-thinking.test.ts
- Feature: Unit tests for `cost.disproportionate-thinking`.
- If removed: Coverage lost; vitest only consumer.
- Current: OK.
- Location: OK.

### src/lib/detectors/cost/disproportionate-thinking.ts
- Feature: `cost.disproportionate-thinking` rec (#1927) — sessions whose reconstructed thinking-token spend dwarfs visible output; effort-calibration action-domain.
- If removed: `index.ts:51` import + registration break (Tier B, epic #411 section).
- Current: OK. Registered; dataDeps `['tokenData']`; uses `src/lib/thinking-tokens.ts` residual estimate as documented.
- Location: OK.

### src/lib/detectors/cost/edit-format-churn.test.ts
- Feature: Unit tests for `cost.edit-format-churn` (formatting-only hunk churn proxy).
- If removed: Coverage lost, incl. named exports (multi-symbol import at line 1); vitest only consumer.
- Current: OK.
- Location: OK.

### src/lib/detectors/cost/edit-format-churn.ts
- Feature: `cost.edit-format-churn` rec (#2507) — Edit/MultiEdit traffic dominated by whitespace-only hunks; fix via CLAUDE.md guidance (appliedMarkers).
- If removed: `index.ts:56-61` (import + named re-exports) and registration break; catalog entry applied-markers.ts:199 orphaned; parser-owned `ToolCall.editFormatChurn` metric loses its only detector consumer.
- Current: OK. Markers in `FINDING_MARKER_CATALOG` (applied-markers.ts:199); dataDeps `['toolData','liveConfig']` matches its parser-metric read.
- Location: OK.

### src/lib/detectors/cost/expensive-agent-type.test.ts
- Feature: Unit tests for `cost.expensive-agent-type`.
- If removed: Coverage lost; vitest only consumer.
- Current: OK.
- Location: OK.

### src/lib/detectors/cost/expensive-agent-type.ts
- Feature: `cost.expensive-agent-type` rec (#418) — subagent types averaging >$0.10/run over ≥5 runs; model right-sizing action-domain; self-suppresses on global Haiku pin.
- If removed: `index.ts:50` import + registration break.
- Current: OK. Registered; broad dataDeps (`agentSettings, attribution, runtimeEvents, toolData, tokenData, liveConfig`) validated by the data-deps contract test.
- Location: OK.

### src/lib/detectors/cost/expensive-sessions.ts
- Feature: `cost.expensive-sessions` rec — spend-dominating sessions; fix = fresh-session-per-task CLAUDE.md guidance (appliedMarkers).
- If removed: `index.ts:42` import + registration break; catalog entry applied-markers.ts:182 orphaned; referenced by `recommendations.test.ts`.
- Current: OK. Markers in catalog; no colocated test (legacy ported rule; covered by recommendations.test.ts + contract tests).
- Location: OK.

### src/lib/detectors/cost/idle-mcp-tools.test.ts
- Feature: Unit tests for `cost.idle-mcp-tools`.
- If removed: Coverage lost; vitest only consumer.
- Current: OK.
- Location: OK.

### src/lib/detectors/cost/idle-mcp-tools.ts
- Feature: `cost.idle-mcp-tools` rec (#416) — MCP tools loaded ≥3 sessions but never invoked (per-turn manifest tax); MCP-config action-domain.
- If removed: `index.ts:49` import + registration break.
- Current: OK. Registered; dataDeps `['toolInventories','liveConfig']`.
- Location: OK.

### src/lib/detectors/cost/legacy-model-overpay.test.ts
- Feature: Unit tests for `cost.legacy-model-overpay`.
- If removed: Coverage lost; vitest only consumer.
- Current: OK.
- Location: OK.

### src/lib/detectors/cost/legacy-model-overpay.ts
- Feature: `cost.legacy-model-overpay` rec — Opus 4.0/4.1 turns billed $15/MTok vs $5 on current Opus; model-pin action-domain; identifies legacy tiers by pricing-object reference equality.
- If removed: `index.ts:45` import + registration break; couples to `CURRENT_MODEL_IDS` in `src/lib/pricing.ts`.
- Current: OK. Registered; dataDeps `['tokenData','liveConfig']`.
- Location: OK.

### src/lib/detectors/cost/local-downroute.test.ts
- Feature: Unit tests for `cost.local-downroute` (calibration-gated pass/fail/insufficient dispositions).
- If removed: Coverage of the receipt-gated publish logic lost; vitest only consumer.
- Current: OK.
- Location: OK.

### src/lib/detectors/cost/local-downroute.ts
- Feature: `cost.local-downroute` rec (#2318, epic #2177) — per-task-class local-model down-route, published only on a calibration `pass` (honest-null on `fail`); routing action-domain.
- If removed: `index.ts:55` import + registration break; the `localCalibration` ingest report (shadow-calls calibration-report.mjs, #2317) loses its only detector consumer.
- Current: OK. Registered; no appliedMarkers (approval-gated, not a paste-fix); dataDeps `['localCalibration','liveConfig']`; stale passes demoted via provenance.ts as documented.
- Location: OK.

### src/lib/detectors/cost/model-eval-routing-gap.test.ts
- Feature: Unit tests for `cost.model-eval-routing-gap`.
- If removed: Coverage of veto/evidence-strength gating lost; vitest only consumer.
- Current: OK.
- Location: OK.

### src/lib/detectors/cost/model-eval-routing-gap.ts
- Feature: `cost.model-eval-routing-gap` rec (#1086, epic #975) — act-now scoped routing gap from committed `modelEvalSummary` evidence; fix with appliedMarkers, promotion needs explicit user approval (Rule 6).
- If removed: `index.ts:52` import + registration break; catalog entry applied-markers.ts:189 orphaned; `modelEvalSummary` (#1085/#1242 rollup) loses its detector consumer.
- Current: OK. Markers in catalog; dataDeps `['modelEvalSummary','liveConfig','semanticIntent']`; dark on SPA as documented.
- Location: OK.

### src/lib/detectors/cost/model-routing-rollup.test.ts
- Feature: Unit tests for `cost.model-routing-rollup`.
- If removed: Coverage lost; vitest only consumer.
- Current: OK.
- Location: OK.

### src/lib/detectors/cost/model-routing-rollup.ts
- Feature: `cost.model-routing-rollup` rec (#1165) — wraps `computeModelRecommendations()` per-turn cheaper-model routing into one summary cost rec so it flows through `buildRecommendations()`.
- If removed: `index.ts:46` import + registration break; the routing-savings panel data would again bypass the rec pipeline (the exact gap #1165 closed).
- Current: OK. Registered; dataDeps `['tokenData','toolData','timelines','attribution']`.
- Location: OK.

### src/lib/detectors/cost/output-verbosity.test.ts
- Feature: Unit tests for `cost.output-verbosity`.
- If removed: Coverage lost; vitest only consumer.
- Current: OK.
- Location: OK.

### src/lib/detectors/cost/output-verbosity.ts
- Feature: `cost.output-verbosity` rec (#1923) — verbose assistant PROSE (assistantFeatures.textLength, text blocks only), dollarized conservatively; fix = CLAUDE.md brevity guidance (appliedMarkers).
- If removed: `index.ts:53` import + registration break; catalog entry applied-markers.ts:198 orphaned.
- Current: OK. Markers in catalog; dataDeps `['assistantFeatures','tokenData','liveConfig']`; honest prose-only sizing documented at head.
- Location: OK.

### src/lib/detectors/cost/priority-tier-spend.test.ts
- Feature: Unit tests for `cost.priority-tier-spend`.
- If removed: Coverage lost; vitest only consumer.
- Current: OK.
- Location: OK.

### src/lib/detectors/cost/priority-tier-spend.ts
- Feature: `cost.priority-tier-spend` rec (#426) — count-only awareness nudge for sessions on `service_tier='priority'`; deliberately no costed claim and no fix (no controlling settings key).
- If removed: `index.ts:48` import + registration break.
- Current: OK. Registered; dataDeps `['tokenData']`; consistent with the repo note that service_tier is an API field, not infra.
- Location: OK.

### src/lib/detectors/cost/unknown-model.ts
- Feature: `cost.unknown-model` rec — cost figures are guesses where the model string is unrecognised; fix = pin a known model (satisfied when global `model` is set).
- If removed: `index.ts:44` import + registration break; referenced in `recommendations.test.ts`, `recommendations-parity.test.ts`, `model-gap-mining.test.ts`.
- Current: OK. Registered; dataDeps `['tokenData','liveConfig']`; no colocated test but covered by the parity/recommendations suites.
- Location: OK.

### src/lib/detectors/cost/web-search-spend.test.ts
- Feature: Unit tests for `cost.web-search-spend`.
- If removed: Coverage lost; vitest only consumer.
- Current: OK.
- Location: OK.

### src/lib/detectors/cost/web-search-spend.ts
- Feature: `cost.web-search-spend` rec (#414) — flat $0.01/uncached web-search calls exceeding $0.50 and >10% of spend; fix = CLAUDE.md web-search discipline (appliedMarkers).
- If removed: `index.ts:47` import + registration break; catalog entry applied-markers.ts:197 orphaned; also the barrel's own doc example (index.ts:22,34) goes stale.
- Current: OK. Markers in catalog; dataDeps `['tokenData','liveConfig']`.
- Location: OK.

### src/lib/detectors/security/model-deceit.test.ts
- Feature: Unit tests for `security.model-deceit`.
- If removed: Coverage of the unbacked/contradicted-claim thresholds lost; vitest only consumer.
- Current: OK.
- Location: OK.

### src/lib/detectors/security/model-deceit.ts
- Feature: `security.model-deceit` rec (#686, epic #683 slice B) — sessions where the agent claimed work it can't be shown to have done; thin read of the #685 ingest signal.
- If removed: `index.ts:128` import + registration break; `deceitSignals` (parse-deceit-signals.ts) loses its detector consumer.
- Current: OK. Registered; dataDeps `['deceitSignals']`; all FP tuning correctly lives at ingest per the head comment.
- Location: OK — security/ matches `category: 'security'`.

### src/lib/detectors/security/secrets-at-rest.test.ts
- Feature: Unit tests for `security.secrets-at-rest`.
- If removed: Coverage of count-only/never-store-value behavior and cleanupPeriodDays self-suppression lost; vitest only consumer.
- Current: OK.
- Location: OK.

### src/lib/detectors/security/secrets-at-rest.ts
- Feature: `security.secrets-at-rest` rec (#2504, epic #2199) — secret-shaped values in plaintext transcripts (counts + EvidenceRef only, value never stored); retention action-domain.
- If removed: `index.ts:129` import + registration break; `parse-secrets-at-rest.ts` ingest signal loses its detector consumer.
- Current: OK. Registered; dataDeps `['secretsAtRest','liveConfig']`; privacy contract (per-kind counts only) matches head docs.
- Location: OK.

### src/lib/detectors/activity/activity-trend.test.ts
- Feature: Unit tests for `activity.activity-trend` (>= +50% WoW tool-call-rate warning).
- If removed: Coverage lost, incl. exported `HOT_THRESHOLD_PCT`; vitest only consumer.
- Current: OK.
- Location: OK.

### src/lib/detectors/activity/activity-trend.ts
- Feature: `activity.activity-trend` rec (#563) — early warning when this week's tool-call rate runs ≥ +50% over last week (rate-cap awareness), from `stats-cache.json`.
- If removed: `index.ts:166` import + registration break; the `statsCache` input field loses its only detector consumer.
- Current: FINDING (stale content): activity-trend.ts:24 `dataDeps: ['statsCache' as keyof RecommendationInput]` and the comment at :26 ("`statsCache` is not (yet) part of the base RecommendationInput") plus the input cast at :28 are vestigial — `statsCache?: StatsCache | null` is a declared `RecommendationInput` field at src/lib/detectors/types.ts:677. Behavior is correct; the cast/comment misdescribe the type contract.
- Location: OK — activity/ matches `category: 'activity'`.

### src/lib/detectors/activity/stale-projects.ts
- Feature: `activity.stale-projects` rec — projects with real history gone quiet; fix satisfied when `cleanupPeriodDays` is set.
- If removed: `index.ts:165` import + registration break; `scripts/recommendations-statusline.test.mjs:50` fixture references the id.
- Current: OK structurally (registered, dataDeps `['projects','liveConfig']`), but no unit test anywhere — `grep -rn "stale-projects\|staleProject" src --include=*.test.ts` returns nothing; only the generic contract tests and a statusline fixture touch it.
- Location: OK.

FINDINGS:
1. src/lib/detectors/activity/activity-trend.ts:24-28 — stale comment + vestigial casts claiming `statsCache` "is not (yet) part of the base RecommendationInput" while it is declared at src/lib/detectors/types.ts:677; drop the `as keyof RecommendationInput` / input cast and the comment.
2. src/lib/detectors/activity/stale-projects.ts — no unit-test coverage anywhere in src (greps over `src --include=*.test.ts` for `stale-projects|staleProject` return nothing); only generic contract tests exercise it, unlike every other detector in this group.


### — group: detectors-4 (35 files) —

### src/lib/detectors/context/bloated-claude-md.test.ts
- Feature: Unit tests for `context.bloated-claude-md` (oversized CLAUDE.md warning).
- If removed: `context.bloated-claude-md` loses its warn/critical line-threshold regression coverage; vitest CI (`test` job) runs it via the standard `src/**/*.test.ts` glob.
- Current: OK — imports `detector` from `./bloated-claude-md`.
- Location: OK (co-located with subject).

### src/lib/detectors/context/bloated-claude-md.ts
- Feature: `context.bloated-claude-md` recommendation (context domain) — flags merged global CLAUDE.md past ~200/400 lines (#412).
- If removed: catalog barrel import breaks (`src/lib/detectors/index.ts:67`), plus its test; finding disappears from `/api/recommendations.json` and `/recs`.
- Current: OK. Registered in barrel; deliberately no appliedMarkers (documented at head — a prose marker would suppress the finding it describes); dataDeps `['liveConfig']` matches actual reads exactly.
- Location: OK — `context/` folder matches emitted `category: 'context'`.

### src/lib/detectors/context/compaction-hot-sessions.test.ts
- Feature: Unit tests for `context.compaction-hot-sessions`.
- If removed: detector loses regression coverage; also indirectly complements `context-dollars.test.ts` cascade coverage.
- Current: OK.
- Location: OK.

### src/lib/detectors/context/compaction-hot-sessions.ts
- Feature: `context.compaction-hot-sessions` (context) — sessions repeatedly hitting compaction, with a `scaleTokens` ReclaimClaim (#944/#949 dollarization).
- If removed: barrel import (`index.ts:68`) breaks; `context-dollars.test.ts` and its own test break; adoption-loop entry `MARKERS_COMPACTION_HOT_SESSIONS` (applied-markers.ts:60/190) orphans.
- Current: OK. Registered; markers present in FINDING_MARKER_CATALOG (`applied-markers.ts:190`, drift guarded by `applied-markers.contract.test.ts`); dataDeps `[tokenData, toolData, timelines, liveConfig]` = exact reads.
- Location: OK.

### src/lib/detectors/context/compaction-large-tool-outputs.test.ts
- Feature: Unit tests for `context.compaction-large-tool-outputs`.
- If removed: detector loses regression coverage; vitest glob consumer.
- Current: OK.
- Location: OK.

### src/lib/detectors/context/compaction-large-tool-outputs.ts
- Feature: `context.compaction-large-tool-outputs` (context) — attributes compaction pressure to oversized tool outputs; books no reclaim (barrel comment index.ts:349 — bytes not double-claimed).
- If removed: barrel import (`index.ts:70`) breaks; catalog entry `MARKERS_COMPACTION_LARGE_TOOL_OUTPUTS` (applied-markers.ts:72/196) orphans.
- Current: OK. Registered; markers in catalog; dataDeps `[tokenData, toolData, timelines, liveConfig]` = exact reads.
- Location: OK.

### src/lib/detectors/context/context-dollars.test.ts
- Feature: Integration test (epic #944 PR3/#949) — proves `low-cache-hit` + `compaction-hot-sessions` ReclaimClaims satisfy the guarded-marginal cascade invariants (dollar identity, residual ≥ 0).
- If removed: the cross-detector cascade invariant for the context category loses its only combined test; vitest glob consumer. Note: no `context-dollars.ts` sibling exists by design — it tests two sibling detectors through `src/lib/reclaim`.
- Current: OK.
- Location: OK — reasonable home next to the detectors it exercises.

### src/lib/detectors/context/cross-session-reread.test.ts
- Feature: Unit tests for `context.cross-session-reread`, incl. provenance (`validateRecommendationProvenance`) and fix-snippet validity checks.
- If removed: detector loses its auditable-claim (provenance/fix-validity) coverage required by `docs/adding-a-recommendation.md`.
- Current: OK.
- Location: OK.

### src/lib/detectors/context/cross-session-reread.ts
- Feature: `context.cross-session-reread` (context) — doc/file cold first-reads repeated across sessions, doc-scoped so it never double-books vs repo-map-context-waste (barrel comment index.ts:394).
- If removed: barrel import (`index.ts:74`) breaks; `reclaim-potential.test.ts` imports it; catalog entry `MARKERS_CROSS_SESSION_REREAD` (applied-markers.ts:84/201) orphans.
- Current: OK. Registered; markers in catalog; dataDeps `[toolData, tokenData, liveConfig]` = exact reads.
- Location: OK.

### src/lib/detectors/context/last-n-runs-audit.test.ts
- Feature: Unit tests for `context.last-n-runs-audit` (imports detector + exported helpers/thresholds).
- If removed: window-vs-baseline drift math loses coverage.
- Current: OK.
- Location: OK.

### src/lib/detectors/context/last-n-runs-audit.ts
- Feature: `context.last-n-runs-audit` (context) — rolling last-N-runs context-creep audit (agent-maintenance essay, `docs/competitive-analysis/agent-maintenance.md`).
- If removed: barrel import (`index.ts:73`) breaks; its test breaks.
- Current: OK. Registered; no fix markers (none claimed); dataDeps `['tokenData']` = exact reads.
- Location: OK.

### src/lib/detectors/context/low-cache-hit.test.ts
- Feature: Unit tests for `context.low-cache-hit`.
- If removed: cache hit-rate thresholds lose direct coverage (cascade behavior still partially covered by `context-dollars.test.ts`).
- Current: OK.
- Location: OK.

### src/lib/detectors/context/low-cache-hit.ts
- Feature: `context.low-cache-hit` (context) — poor prompt-cache reuse with `scaleTokens` reclaim, "stable context prefix" CLAUDE.md fix.
- If removed: barrel import (`index.ts:66`) breaks; `context-dollars.test.ts` + own test break; catalog entry `MARKERS_LOW_CACHE_HIT` (applied-markers.ts:18/180) orphans.
- Current: OK. Registered; markers in catalog; dataDeps `[tokenData, liveConfig]` = exact reads.
- Location: OK.

### src/lib/detectors/context/low-health.ts
- Feature: `context.low-health` (context) — low session context-health signal with "session health" CLAUDE.md fix marker.
- If removed: barrel import (`index.ts:65`) breaks; catalog entry `MARKERS_LOW_HEALTH` (applied-markers.ts:38/185) orphans.
- Current: OK. Registered; markers in catalog; dataDeps `[tokenData, liveConfig]` = exact reads. No dedicated `.test.ts`, but the shared detector contract tests (bank fixture, applied-markers contract, data-deps) cover the contract surface — noted, not filed as a defect.
- Location: OK.

### src/lib/detectors/context/mcp-schema-tax.test.ts
- Feature: Unit tests for `context.mcp-schema-tax` incl. `duplicateMcpServers` interplay.
- If removed: schema-tax dollarization and duplicate-server detection lose coverage.
- Current: OK.
- Location: OK.

### src/lib/detectors/context/mcp-schema-tax.ts
- Feature: `context.mcp-schema-tax` (#1920, context) — dollarizes the MCP tool-schema share of the fixed per-turn prefix; flags duplicate MCP servers as removal lever (sibling to bloated-claude-md, barrel comment index.ts:355).
- If removed: barrel import (`index.ts:76`) breaks; its test breaks.
- Current: OK. Registered; no markers (none claimed); dataDeps `[toolInventories, liveConfig, tokenData]` = exact reads.
- Location: OK.

### src/lib/detectors/context/over-scoped-config-section.test.ts
- Feature: Integration-style tests for `context.over-scoped-config-section` (drives it via `buildRecommendations`, exercising the full pipeline).
- If removed: the largest context detector (1019-line module) loses its only dedicated test.
- Current: OK.
- Location: OK.

### src/lib/detectors/context/over-scoped-config-section.ts
- Feature: `context.over-scoped-config-section` (context) — flags config/CLAUDE.md sections scoped wider than the repo-map + shadow-calls evidence justifies, using rule-topic naming and shadow-axis win thresholds.
- If removed: barrel import (`index.ts:71`) breaks; its test breaks.
- Current: OK. Registered; no appliedMarkers claimed; dataDeps `[repoMap, shadowCalls, liveConfig]` = exact reads; emits `DETECTOR_ID = 'context.over-scoped-config-section'` (line 17) matching folder/category.
- Location: OK — at 1019 lines it is the heaviest file in the folder; internal helpers could split out, but nothing misplaced.

### src/lib/detectors/context/over-window.ts
- Feature: `context.over-window` (context) — sessions pushing past the context window, with CLAUDE.md session-reset fix marker.
- If removed: barrel import (`index.ts:64`) breaks; catalog entry `MARKERS_OVER_WINDOW` (applied-markers.ts:68/195) orphans.
- Current: OK. Registered; markers in catalog; dataDeps `[tokenData, liveConfig]` = exact reads. Like low-health, no dedicated test file (shared contract tests apply).
- Location: OK.

### src/lib/detectors/context/reclaim-potential.test.ts
- Feature: Tests for `context.reclaim-potential`, incl. non-double-booking vs `cross-session-reread` and `repo-map-context-waste` (imports all three detectors).
- If removed: the reclaim non-overlap guarantee (barrel comment index.ts:402-403) loses its proof.
- Current: OK.
- Location: OK.

### src/lib/detectors/context/reclaim-potential.ts
- Feature: `context.reclaim-potential` (#1758, epic #1911; context) — deterministic ML-free counter of provably compressible/removable context, priced at cache-read rate; the competitive response to the "headroom" tool.
- If removed: barrel import (`index.ts:77`) breaks; its test breaks; catalog entry `MARKERS_RECLAIM_POTENTIAL` (applied-markers.ts:88/202) orphans.
- Current: OK. Registered; markers in catalog; dataDeps `[toolData, sessions, tokenData, liveConfig]` = exact reads.
- Location: OK.

### src/lib/detectors/context/repeated-compactions.test.ts
- Feature: Unit tests for `context.repeated-compactions`.
- If removed: compaction-count threshold behavior loses coverage.
- Current: OK.
- Location: OK.

### src/lib/detectors/context/repeated-compactions.ts
- Feature: `context.repeated-compactions` (context) — flags sessions compacting multiple times; "Session resets" CLAUDE.md fix.
- If removed: barrel import (`index.ts:69`) breaks; catalog entry `MARKERS_REPEATED_COMPACTIONS` (applied-markers.ts:42/186) orphans.
- Current: OK. Registered; markers in catalog; dataDeps `[tokenData, toolData, timelines, liveConfig]` = exact reads.
- Location: OK.

### src/lib/detectors/context/repo-map-context-waste.test.ts
- Feature: Unit tests for `context.repo-map-context-waste`.
- If removed: structural reread-join logic loses coverage; this rec is also kept live by `npm run deploy`'s repo-map refresh (#1650) — test is its behavioral anchor.
- Current: OK.
- Location: OK.

### src/lib/detectors/context/repo-map-context-waste.ts
- Feature: `context.repo-map-context-waste` (#890, epics #871/#944; context) — repo-map-aware structural version of redundant-reads (code files, vs cross-session-reread's docs).
- If removed: barrel import (`index.ts:72`) breaks; own test + `reclaim-potential.test.ts` break; catalog entry `MARKERS_REPO_MAP_WASTE` (applied-markers.ts:80/200) orphans; deploy-time repo-map refresh (scripts/deploy.sh) loses its consumer.
- Current: OK. Registered; markers in catalog; dataDeps `[repoMap, toolData, tokenData, liveConfig]` = exact reads.
- Location: OK.

### src/lib/detectors/context/tool-call-right-sizing.test.ts
- Feature: Unit tests for `context.tool-call-right-sizing`.
- If removed: verbose-tool/fat-read thresholds lose coverage.
- Current: OK.
- Location: OK.

### src/lib/detectors/context/tool-call-right-sizing.ts
- Feature: `context.tool-call-right-sizing` (#1924, context) — flags tool calls pulling far more bytes into context than needed and dollarizes trimming (via `toolPayloadRightSizing` in parse-tools).
- If removed: barrel import (`index.ts:75`) breaks; its test breaks.
- Current: OK. Registered; no markers claimed; dataDeps `[toolData, tokenData]` = exact reads; books reclaim via `scopeKeyOf` so cascade non-overlap holds.
- Location: OK.

### src/lib/detectors/speed/hook-overhead.test.ts
- Feature: Unit tests for `speed.hook-overhead` incl. the dated-stop-hook aggregation and cache-validity helpers.
- If removed: the freshness/cache-validity helpers consumed by the server worker lose coverage.
- Current: OK.
- Location: OK.

### src/lib/detectors/speed/hook-overhead.ts
- Feature: `speed.hook-overhead` (#710, epic #708, ADR 0006; speed) — slow synchronous Stop hooks add wall-clock to every turn; fills the "Go faster" card.
- If removed: barrel import (`index.ts:154`) breaks; barrel also re-exports `hookOverheadCacheValidity`/`hookOverheadCacheValidityContains` (index.ts:158-162), consumed by `src/lib/recommendations.ts`, `scripts/recs-worker.mjs`, and `scripts/server.mjs` — server-side recs cache invalidation breaks too.
- Current: OK. Registered; no fix markers claimed; dataDeps `[runtimeEvents, liveConfig]` = exact reads.
- Location: OK — folder matches `category: 'speed'`; the cache-validity helpers are detector-owned state, reasonable here.

### src/lib/detectors/speed/model-latency.test.ts
- Feature: Unit tests for `speed.model-latency`.
- If removed: the two-cohort gate and cost-downshift-in-disguise refusal (ADR 0006) lose coverage.
- Current: OK.
- Location: OK.

### src/lib/detectors/speed/model-latency.ts
- Feature: `speed.model-latency` (#915, epic #866; speed) — hard-gated clock detector: successful-path API timing normalized by output tokens, ≥2 model cohorts required.
- If removed: barrel import (`index.ts:156`) breaks; its test breaks.
- Current: OK. Registered; dataDeps `['modelLatency']` = exact reads.
- Location: OK.

### src/lib/detectors/speed/serial-tool-gap.test.ts
- Feature: Unit tests for `speed.serial-tool-gap` (detector + `summarizeSerialGaps` helper).
- If removed: independence heuristic for batchable read-only calls loses coverage.
- Current: OK.
- Location: OK.

### src/lib/detectors/speed/serial-tool-gap.ts
- Feature: `speed.serial-tool-gap` (#1753, epic #1910; speed) — independent read-only tool calls issued serially cost an avoidable model round-trip each; recommends batching.
- If removed: barrel import (`index.ts:157`) breaks; its test breaks.
- Current: OK. Registered; dataDeps `[timelines, runtimeEvents]` = exact reads.
- Location: OK.

### src/lib/detectors/speed/time-motion.test.ts
- Feature: Unit tests for `speed.time-motion` (detector + `attributeWallClock`).
- If removed: wall-clock bucket attribution (model-working / idle-AFK / waiting) loses coverage.
- Current: OK.
- Location: OK.

### src/lib/detectors/speed/time-motion.ts
- Feature: `speed.time-motion` (#596, epic #606; speed) — attributes measured wall-clock into model-working vs idle/AFK buckets using `turn_duration` + `away_summary` with the 15-min idle cutoff.
- If removed: barrel import (`index.ts:155`) breaks; its test breaks.
- Current: OK. Registered; dataDeps `[runtimeEvents, timelines]` = exact reads.
- Location: OK.

FINDINGS: none. All 18 detectors are registered in the Catalog barrel (`src/lib/detectors/index.ts:64-77,154-157`); all 9 marker-shipping detectors have matching FINDING_MARKER_CATALOG entries in `src/lib/detectors/applied-markers.ts` (drift structurally guarded by `applied-markers.contract.test.ts`); every detector's declared `dataDeps` exactly equals its `input.*` reads; every category folder matches its emitted category. (Non-defect observations: `low-health.ts` and `over-window.ts` have no dedicated test files, relying on the shared contract tests; `over-scoped-config-section.ts` is 1019 lines and could be split; `context-dollars.test.ts` intentionally has no same-named subject module.)


### — group: detectors-5 (37 files) —

### src/lib/detectors/applied-markers.contract.test.ts
- Feature: Adoption Scorecard adoption loop — anti-drift guard proving the client-safe marker leaf equals the detector-declared `appliedMarkers` catalog (#1909).
- If removed: `applied-markers.ts` could silently diverge from detector `appliedMarkers`, breaking SURFACED→ADOPTED resolution in AdoptionScorecard; runs in the `test` CI job (vitest default include).
- Current: OK — asserts key-set equality and deep-equality both directions against `findingMarkerCatalog()`.
- Location: OK (beside the leaf it guards).

### src/lib/detectors/applied-markers.ts
- Feature: Client-safe finding-id → CLAUDE.md marker catalog (`FINDING_MARKER_CATALOG`, `RETIRED_SUPPRESSION_MARKER_CATALOG`) so the digest route resolves markers without bundling the engine.
- If removed: `src/components/AdoptionScorecard.tsx:44` and `src/lib/adoption-scorecard.ts:22` fail to import; the alternative (importing the barrel) trips the route bundle-budget gate (ADR 0016).
- Current: OK — contract test keeps it byte-equal to detector declarations.
- Location: OK (deliberate leaf under detectors/).

### src/lib/detectors/data-deps-introspect.ts
- Feature: Static TS-compiler analyzer extracting each detector's actually-read `RecommendationInput` fields, `id`, `dataDeps`, `dependsOn`, imports (#2080).
- If removed: `data-deps.contract.test.ts` (its sole consumer — grep over src/+scripts confirms) fails to import; the dataDeps contract becomes unenforceable.
- Current: OK — correctly excludes tests/index and self via line-anchored `export const detector` match.
- Location: OK; test-only (imports devDep `typescript`), correctly never imported by the barrel or runtime code.

### src/lib/detectors/data-deps.contract.test.ts
- Feature: CI contract making `Detector.dataDeps` load-bearing — fails any detector reading an undeclared input field, validates `dependsOn` edges, includes a negative-control fixture.
- If removed: undeclared-field couplings (detector reads `undefined`, silently emits nothing) return; `dependsOn` ids could rot; `assembleRecommendationInput` normalization unlocked.
- Current: OK.
- Location: OK.

### src/lib/detectors/dual-emit.ts
- Feature: Single source of truth for detectors whose one rule body emits a second rec id (dangerous-bypass→dangerous-commands, api-errors→rate-limits, value-of-agent-handoff→leave-behind-candidate-verification).
- If removed: `src/lib/recommendations.test.ts:4028` (registry self-test) and `src/lib/external-guidance-registry.test.ts:15` (guidance target resolution) break; hand-copied maps could re-open the #1401 dangling-target hole.
- Current: OK — all three entries match actual emit sites (e.g. dangerous-bypass.ts:569/622).
- Location: OK.

### src/lib/detectors/fix-validity.test.ts
- Feature: CI gate for the "Copy fix" product surface — unit tests for the validators plus a source scan failing any detector embedding a non-portable reference in a default-`validated` snippet (#1101).
- If removed: copy-paste-unsafe snippets (host paths, `claude-team`, harness tools) could ship as `validated` again — the exact 2026-06-10 audit regression.
- Current: OK.
- Location: OK.

### src/lib/detectors/fix-validity.ts
- Feature: Fix-snippet portability contract — `effectiveFixKind`, `NON_PORTABLE_SNIPPET_PATTERNS`, `validateFixSnippet`, `isBlanketModelPinSnippet` (#2548), `validateNpmRunScripts`.
- If removed: the gate test plus ~20 detector tests (dangerous-bypass, local-downroute, cross-session-reread, …) fail to import; `cost/local-downroute.ts` also consumes it at engine runtime.
- Current: OK.
- Location: OK (dependency-light leaf, per its own contract).

### src/lib/detectors/index.ts
- Feature: The hand-written detector Catalog barrel — `DETECTORS` (load-bearing emit order), `DETECTOR_CATALOG_MARKER` (#2719 bundle-absence sentinel), `findingMarkerCatalog()`.
- If removed: `buildRecommendations` (recommendations.ts) has no catalog — the entire recs engine, `/api/recommendations.json`, digest, and `/recs` go dark; `scripts/check-engine-absent.mjs` loses its sentinel.
- Current: OK — all 37 group detectors verified registered; sentinel consumed by recommendations.ts + check-engine-absent.mjs.
- Location: OK.

### src/lib/detectors/provenance-contract.test.ts
- Feature: Auditability keystone (#1049) — validator accept/reject matrix, allowlist-ids-are-registered check, exemplar end-to-end provenance assertion.
- If removed: `PROVENANCE_DETECTORS` allowlist can rot (ids of deleted detectors linger) and malformed provenance ships unnoticed, eroding the "recommendations are auditable claims" contract.
- Current: OK.
- Location: OK.

### src/lib/detectors/provenance.ts
- Feature: `RecProvenance` validation truth + `PROVENANCE_DETECTORS` allowlist + shared `isAsOfStale` freshness rule (#1102).
- If removed: 37 detector modules import from it (incl. dangerous-bypass, all maintenance detectors); the provenance contract test and stale-demotion ("as of <date>") behavior collapse.
- Current: OK — spot-checked allowlist ids (all three maintenance ids present and registered).
- Location: OK.

### src/lib/detectors/rec-enums.ts
- Feature: Dependency-free leaf enums `RecCategory` + `SavingsAttributionTier` hoisted to break type-only madge cycles (#1582).
- If removed: `types.ts:73`, `reclaim.ts:47`, `parse-config-attribution.ts:53`, `external-guidance.ts:11`, `domain-registry.ts:32`, `digest.ts:21` fail; re-inlining reintroduces the cycles.
- Current: OK — `maintenance` category comment matches the three live registered detectors.
- Location: OK.

### src/lib/detectors/shared.test.ts
- Feature: Unit tests for shared cost helpers (`automationCostShare`, `automationCostByClass`) feeding cost.automation-share.
- If removed: automation cost-share math regressions ship silently; only consumer of these helpers' direct coverage.
- Current: OK.
- Location: OK.

### src/lib/detectors/shared.ts
- Feature: Shared detector helpers — severity rank/bump, gating thresholds (`MIN_SAVINGS_USD`), CLAUDE.md suppression matching (`claudeMdMarksApplied`, `mergedClaudeMdText`), permission-rule re-exports, task-class/cost helpers.
- If removed: recommendations.ts, review-queue.ts:15, parse-policy.ts:5, claude-md-append.ts:29, adoption-scorecard.ts:21, and most detector files fail to import — engine-wide breakage.
- Current: OK.
- Location: OK (sits between types.ts and detectors by design, no cycle).

### src/lib/detectors/suppression-transition.test.ts
- Feature: Tests for ADR 0005 engine-loop SUPPRESSED-receipt computation (fires once, idempotent-while-terminal, organic excluded) using synthetic + real detectors.
- If removed: the adoption signal's core semantics lose their only pure-unit coverage.
- Current: OK.
- Location: OK.

### src/lib/detectors/suppression-transition.ts
- Feature: Computes FIRING→SUPPRESSED adoption transitions once over the catalog by diffing a real engine run against a blanked-CLAUDE.md counterfactual (#576, ADR 0005); pure, no I/O.
- If removed: `recommendations.ts:121/127` fail to import; SUPPRESSED receipts stop flowing to the #575 writer and the adoption scorecard's coached count freezes.
- Current: OK.
- Location: OK.

### src/lib/detectors/types.ts
- Feature: Leaf type module — `Detector`, `Recommendation`, `RecommendationInput` (40+ fields), `RecFix`/`FixKind`, `AppliedMarkers`, `RecProvenance`, re-exported enums.
- If removed: everything breaks — recommendations.ts, dozens of components (Recommendations.tsx, CostAttribution.tsx, DigestSpine.tsx), lib modules (reclaim, digest, coverage, model-pin-savings, …).
- Current: OK.
- Location: OK (documented leaf of the dependency graph).

### src/lib/detectors/safety/allow-rule-overlaps-deny.ts
- Feature: `safety.allow-rule-overlaps-deny` (safety domain) — flags permission `allow` rules fully shadowed by a `deny` (#175).
- If removed: catalog entry (index.ts:121/222) breaks; the dead-allow hygiene card disappears.
- Current: FINDING (minor) — zero behavioral test coverage: the id appears in no `*.test.ts` anywhere and the core helper `allowShadowedByDeny` has no direct unit test either; the barrel recipe (index.ts:20) requires a red→green test per detector.
- Location: OK (category `safety` matches folder).

### src/lib/detectors/safety/config-hygiene-rollup.test.ts
- Feature: Tests the mcpServer+plugin unused-resource rollup (thresholds, hedged short windows, no double-emission vs unused-installed-*).
- If removed: rollup scoping/threshold regressions ship silently.
- Current: OK.
- Location: OK.

### src/lib/detectors/safety/config-hygiene-rollup.ts
- Feature: `safety.config-hygiene-rollup` (#1164) — one summary card for unused mcpServer/plugin families that no `workflow.unused-installed-*` detector covers.
- If removed: catalog entry (index.ts:122/218) breaks; unused MCP servers/plugins vanish from `/api/recommendations.json` again (the exact gap #1164 closed).
- Current: OK — dataDeps `['liveConfig','attribution','sessions']`; CI data-deps contract enforces reads.
- Location: OK.

### src/lib/detectors/safety/continuation-blocked.test.ts
- Feature: Tests blocked-continuation session aggregation from parsed `stop_hook_summary` runtime events.
- If removed: threshold (`MIN_BLOCKED_CONTINUATIONS`) and session-attribution regressions ship silently.
- Current: OK.
- Location: OK.

### src/lib/detectors/safety/continuation-blocked.ts
- Feature: `safety.continuation-blocked` — sessions where Stop hooks repeatedly blocked continuation (runaway loop signal).
- If removed: catalog entry (index.ts:123/223) breaks.
- Current: OK — dataDeps `['runtimeEvents']` matches its RuntimeEvents-only read.
- Location: OK.

### src/lib/detectors/safety/dangerous-bypass.test.ts
- Feature: The safety flagship's test suite (1060 lines): dual-emit ids, provenance validation, fix validity, severity bump under unattended entrypoints, deny-rule interplay.
- If removed: the largest safety detector loses all behavioral coverage — and `deny-rule-never-triggered` loses its only test (exercised at line 1020).
- Current: OK.
- Location: OK.

### src/lib/detectors/safety/dangerous-bypass.ts
- Feature: `safety.dangerous-bypass` + dual-emit `safety.dangerous-commands` — permission-bypass modes and destructive command patterns, provenance-bearing (on `PROVENANCE_DETECTORS`).
- If removed: catalog entry (index.ts:117/216) breaks; `suppression-transition.test.ts` and `dual-emit.ts` references dangle; a core safety surface goes dark.
- Current: OK — dual emit registered in dual-emit.ts:13; dataDeps 4-field declaration CI-enforced.
- Location: OK.

### src/lib/detectors/safety/deny-rule-never-triggered.ts
- Feature: `safety.deny-rule-never-triggered` (#175) — deny rules that never matched history (dangerous-command guards deliberately excluded).
- If removed: catalog entry (index.ts:120/221) breaks; dangerous-bypass.test.ts:3 import fails.
- Current: OK.
- Location: OK.

### src/lib/detectors/safety/policy-change.test.ts
- Feature: Tests risk-increasing policy-change classification (`isRiskIncreasingPolicyChange`, dimension dedup) over config-backup drift events.
- If removed: trust-flip/enable-all classification regressions ship silently.
- Current: OK.
- Location: OK.

### src/lib/detectors/safety/policy-change.ts
- Feature: `safety.policy-change` — surfaces risk-increasing config drift (trust flips, blanket MCP enables) from `configBackups`.
- If removed: catalog entry (index.ts:124/219) breaks.
- Current: OK — reuses `formatConfigDriftEvidence` from reliability/config-drift instead of duplicating (good).
- Location: OK (cross-category helper import is import-only, category stays `safety`).

### src/lib/detectors/safety/prompt-friction.ts
- Feature: `safety.prompt-friction` — the tool driving most permission prompts; fix seeds an allowlist (self-suppressing once `BASH_SAFE_ALLOW_RULES` present).
- If removed: catalog entry (index.ts:119/220) breaks; recommendations.test.ts:2034 coverage block fails.
- Current: OK.
- Location: OK.

### src/lib/detectors/safety/risky-actions.test.ts
- Feature: Tests risky-action categorization (deploy/production-config/database/secret-sensitive) and severity escalation via `detectRiskyActions`.
- If removed: category/severity regressions ship silently.
- Current: OK.
- Location: OK.

### src/lib/detectors/safety/risky-actions.ts
- Feature: `safety.risky-actions` — high-impact command review card (deploys, prod config, DB, secrets) from toolData+timelines.
- If removed: catalog entry (index.ts:118/217) breaks.
- Current: OK.
- Location: OK.

### src/lib/detectors/safety/unattended-sessions.test.ts
- Feature: Tests unattended (`sdk-*`) entrypoint detection joined to dangerous-command/mode signals.
- If removed: unattended-risk aggregation regressions ship silently.
- Current: OK.
- Location: OK.

### src/lib/detectors/safety/unattended-sessions.ts
- Feature: `safety.unattended-sessions` — dangerous activity inside unattended entrypoint sessions (the #197 severity-context case).
- If removed: catalog entry (index.ts:125/224) breaks.
- Current: OK — dataDeps `['toolData','tokenData','permissionRows','timelines']` CI-enforced.
- Location: OK.

### src/lib/detectors/maintenance/doc-hygiene.test.ts
- Feature: Tests for the doc-graph audit (1786 lines): broken links, orphans, dangling `src/` refs, freshness-contract parsing, provenance validation.
- If removed: the largest maintenance detector loses all coverage including the declared-freshness contract (`FRESHNESS_WARN_KEY`/`FRESHNESS_ERROR_KEY`).
- Current: OK.
- Location: OK.

### src/lib/detectors/maintenance/doc-hygiene.ts
- Feature: `maintenance.doc-hygiene` (#2258, epic #2256) — deterministic repo-doc audit (broken-internal-link / orphan / dangling-src-ref) as one recommend-only card; on the provenance allowlist.
- If removed: catalog entry (index.ts:171/520) breaks; the docs half of artifact hygiene (epic #2241) goes dark.
- Current: OK — dataDeps 5-field declaration (docGraph, repoMap, docHygieneArtifact, docsMap, docIssueSnapshot) CI-enforced; dark on doc-graph-free datasets as documented.
- Location: OK.

### src/lib/detectors/maintenance/memory-hygiene.test.ts
- Feature: Tests the memory-store audit signals (index budget/line caps, dangling/unindexed detection incl. archive index, provenance).
- If removed: the #2558 archive-index-honoring fix and absence-claim gating lose their regression guard.
- Current: OK.
- Location: OK.

### src/lib/detectors/maintenance/memory-hygiene.ts
- Feature: `maintenance.memory-hygiene` (#1779, revised by #2558) — four deterministic memory-store signals in one recommend-only card; feeds the memory-lifecycle loop (epic #2233).
- If removed: catalog entry (index.ts:170/513) breaks; the first maintenance-category detector disappears (rec-enums.ts:31 comment would also go stale).
- Current: OK — dataDeps `['memoryStores']`; docstring cites #2558 while the barrel cites #1779 — both accurate per git history (495de263 → 0b775cc9), not a defect.
- Location: OK.

### src/lib/detectors/maintenance/skill-hook-integrity.test.ts
- Feature: Tests dangling-hook-script / dangling-skill-ref flags plus the exported cache-validity knob (`skillHookIntegrityCacheValidity*`).
- If removed: reference-integrity regressions and cache-validity contract drift ship silently.
- Current: OK.
- Location: OK.

### src/lib/detectors/maintenance/skill-hook-integrity.ts
- Feature: `maintenance.skill-hook-integrity` (#2500, epic #2241) — flags settings hooks/skills pointing at ingest-verified-missing paths; pure detector reading config-loader's `referencedPaths`/`danglingRefs` annotations.
- If removed: catalog entry (index.ts:172/528) breaks, plus the barrel's re-export of its cache-validity symbols (index.ts:173-177) used by the parser-version knob contract.
- Current: OK — dataDeps `['liveConfig']`; "as of ingest" point-in-time wording honors the auditable-claims rule.
- Location: OK.

FINDINGS:
1. src/lib/detectors/safety/allow-rule-overlaps-deny.ts — no behavioral test coverage anywhere: `grep -rln "allow-rule-overlaps-deny" src/ --include='*.test.ts'` returns nothing and `allowShadowedByDeny` (permission-rules.ts) has no direct unit test either; every other detector in this group is exercised by a dedicated or sibling test, and the Catalog recipe (src/lib/detectors/index.ts:20) requires a red→green test per detector. Minor (logic is small and the shadow test is conservative), but a regression in the Bash-prefix shadow check would ship silently.


### — group: components-sub (25 files) —

### src/components/affordance/ApplyButton.tsx
- Feature: Tier-3 "in-app write" affordance ladder rung (epic #490/#491) — preview→confirm→apply modal in server builds, degrading to CopyButton in the SPA.
- If removed: nothing found — removal candidate. Greps: `grep -rn "ApplyButton" src scripts --include='*.ts' --include='*.tsx'` matched only its own file (no importer, no test, not in view-registry or App.tsx).
- Current: FINDING — dead UI: exported `ApplyButton`/`ApplyButtonProps` (ApplyButton.tsx:35,53) have zero consumers anywhere in src/ or scripts/; landed in c6120cea (#548) and never wired in.
- Location: OK (affordance dir is right if it ever gets a consumer).

### src/components/affordance/ConfigFindingActions.tsx
- Feature: Config Hygiene view — per-finding "copy removal snippet" / "copy open-config command" action row.
- If removed: `ConfigHygiene.tsx:33,524` breaks (registered view). Depends on `lib/config-hygiene-actions` builders.
- Current: OK.
- Location: OK.

### src/components/affordance/CopyButton.test.ts
- Feature: vitest coverage for CopyButton.
- If removed: test coverage lost; consumer is vitest (`npm run test` CI job). Subject `./CopyButton` exists.
- Current: OK — pins static-text copy + "Copied!" flash and lazy `getText` evaluation at click time.
- Location: OK (colocated).

### src/components/affordance/CopyButton.tsx
- Feature: Shared tier-2 copy-to-clipboard button (epic #490/#491), consolidating three drifted local copies; Clipboard API + execCommand fallback.
- If removed: ~17 components break — SessionList, SessionTimeline, ToolUsage, PolicyBuilder, ModelEvalsPf, TeamCoordinationPf, BudgetGauge, ContextHealth, AgentSkill, RecommendationCard, FileImpact, CostAttribution, ProjectBreakdown, ConfigHygiene, DigestSpine, plus ApplyButton/ConfigFindingActions/DangerousCommandEvidence in-dir.
- Current: OK. SPA-safe (no api-client/node imports).
- Location: OK.

### src/components/affordance/DangerousCommandEvidence.css
- Feature: Styling for the dangerous-command evidence rows (grid layout, labeled session/pattern chips).
- If removed: `DangerousCommandEvidence.tsx:3` (`import './DangerousCommandEvidence.css'`) fails at build; evidence rows lose all layout.
- Current: OK — uses PF design tokens, no hardcoded theme colors.
- Location: OK (colocated with its component).

### src/components/affordance/DangerousCommandEvidence.test.ts
- Feature: vitest coverage for DangerousCommandEvidence.
- If removed: coverage lost; consumer is vitest. Subject `./DangerousCommandEvidence` exists.
- Current: OK — pins session/pattern/command rendering from a structured evidence row, per-command copy, and full-row copy fallback for legacy compact evidence.
- Location: OK.

### src/components/affordance/DangerousCommandEvidence.tsx
- Feature: Renders safety-recommendation evidence rows (dangerous bypass/commands) with per-command CopyButton in Permissions, RecommendationCard, and DigestSpine.
- If removed: `Permissions.tsx:35`, `RecommendationCard.tsx:34`, `DigestSpine.tsx:79` break (all reachable registered views).
- Current: OK.
- Location: OK.

### src/components/affordance/DrillThrough.test.ts
- Feature: vitest coverage for DrillThrough helper factories.
- If removed: coverage lost; consumer is vitest. Subject `./DrillThrough` exists.
- Current: OK — pins the target-shape contract (view + filter + identity + label) for project/day/tool/permission-mode/risk-band targets and route-filter forwarding (#2349).
- Location: OK.

### src/components/affordance/DrillThrough.tsx
- Feature: Tier-1 navigate affordance — typed drill-through targets ("open Sessions filtered to X") shared by every KPI/chart click-through, incl. route-scope forwarding (#2349).
- If removed: 9+ views break — UsageStats, ConversationPatterns, SessionPatterns, PromptAnalyzer, ToolUsage, EvaluatorLanding, ContextHealth, Permissions, CostAttribution — plus `view-registry.tsx:32` itself (`navigateDrillThroughWithFilter`) and UsageStats.test.ts.
- Current: OK.
- Location: OK.

### src/components/affordance/ExpandableText.tsx
- Feature: Click-to-expand truncated text cell (epic #490, #494/#495) — fixes the false ellipsis affordance; keyboard-accessible.
- If removed: `ErrorRetry.tsx:44,683,891` breaks (registered view).
- Current: OK.
- Location: OK.

### src/components/affordance/RejectControl.test.ts
- Feature: vitest coverage for RejectControl.
- If removed: coverage lost; consumer is vitest. Subject `./RejectControl` exists.
- Current: OK — pins the three reject reasons (dismiss/wrong/not-relevant), the `onReject(findingId, reason)` call contract, and the post-success confirmation state.
- Location: OK.

### src/components/affordance/RejectControl.tsx
- Feature: Recommendation reject-signal capture (#1294, epic #1298) — records why a rec was rejected without hiding it.
- If removed: `RecommendationCard.tsx:31` and `recommendations/TopActionHero.tsx:18` break.
- Current: OK. `api-client` import is type-only (`import type { RejectSignalWriteResult }`) — SPA-boundary-clean.
- Location: OK.

### src/components/affordance/dangerous-command-evidence.ts
- Feature: Pure parsing/id-matching helpers for dangerous-command evidence rows (`sessionId, pattern: command` format), kept out of the .tsx for testability.
- If removed: `DangerousCommandEvidence.tsx:2`, `RecommendationCard.tsx:35`, `DigestSpine.tsx:80` break (`isDangerousCommandRecommendationId`, `parseDangerousCommandEvidenceRow`).
- Current: OK.
- Location: OK.

### src/components/charts/LightweightCharts.tsx
- Feature: The dashboard's zero-dependency SVG chart kit (Area/Donut/Sparkline/Horizontal/Vertical/Grouped/MultiLine) with PF token colors and stable-id bar-click identity (#1810).
- If removed: 10+ chart views break — UsageStats, AgentSkill, ConversationPatterns, ErrorRetry, ContextHealth, FileImpact, ToolUsage, ShadowExperimentTrends, TokenUsage, CostAttribution; `token-usage-chart.ts:6` (type-only `XYPoint`).
- Current: OK.
- Location: OK.

### src/components/hooks/useContainerWidth.test.ts
- Feature: vitest coverage for useContainerWidth.
- If removed: coverage lost; consumer is vitest. Subject `./useContainerWidth` exists.
- Current: OK — pins the no-ResizeObserver fallback (default 500) and observed-width commit behavior via a probe component.
- Location: OK.

### src/components/hooks/useContainerWidth.ts
- Feature: Shared responsive-chart-width hook (#623, epic #622; #2419 pre-paint seed) replacing 14 hand-rolled ResizeObserver blocks.
- If removed: 12+ views break — AgentSkill, UsageStats, ConversationPatterns, SummaryView, PlanShapesPf, ErrorRetry, ContextHealth, FileImpact, SessionTimeline, ToolUsage, ProjectActivity, TokenUsage, CostAttribution.
- Current: OK.
- Location: OK.

### src/components/hooks/useRowWindow.test.ts
- Feature: vitest coverage for useRowWindow.
- If removed: coverage lost; consumer is vitest. Subject `./useRowWindow` exists.
- Current: OK — pins viewport-bounded row visibility via a fake IntersectionObserver (which sentinels intersect → which indices render full content) and the everything-visible degradation.
- Location: OK.

### src/components/hooks/useRowWindow.ts
- Feature: IntersectionObserver row windowing for large tables (#714, epic #718) — bounds Sessions-table layout cost by viewport, not row count (#666 resize-storm fix).
- If removed: `SessionList.tsx:69` breaks (registered `sessions` view); the resize-longtask regression returns.
- Current: OK — graceful jsdom/SSR degradation documented and implemented.
- Location: OK.

### src/components/recommendations/CompactionPanel.tsx
- Feature: Recommendations page — "sessions running hot" compaction-risk warning card (extracted from Recommendations.tsx, #629).
- If removed: `Recommendations.tsx:111` (`CompactionRiskCard`) breaks; Recommendations is registered in view-registry.tsx:108.
- Current: OK.
- Location: OK.

### src/components/recommendations/ModelPanel.test.ts
- Feature: vitest coverage for the CheaperModelCard.
- If removed: coverage lost; consumer is vitest. Subject `./ModelPanel` (`CheaperModelCard`) exists.
- Current: OK — pins rendering of the down-modelling summary (downgradable %, estimated savings) from a `ModelRecSummary` fixture.
- Location: OK.

### src/components/recommendations/ModelPanel.tsx
- Feature: Recommendations page — "cheaper model would suffice" card with per-turn feature attribution and savings estimate (#629 extraction).
- If removed: `Recommendations.tsx:106` (`CheaperModelCard`) and ModelPanel.test.ts break.
- Current: OK.
- Location: OK.

### src/components/recommendations/SeveritySummaryBar.tsx
- Feature: Recommendations page — proportional critical/warning/info severity strip using PF status tokens (#451, #629 extraction).
- If removed: `Recommendations.tsx:113` breaks.
- Current: OK.
- Location: OK.

### src/components/recommendations/TopActionHero.test.ts
- Feature: vitest coverage for TopActionHero.
- If removed: coverage lost; consumer is vitest. Subject `./TopActionHero` exists.
- Current: OK — pins that duplicated token-signal recs navigate through the canonical evidence view (canonical-evidence routing contract).
- Location: OK.

### src/components/recommendations/TopActionHero.tsx
- Feature: Recommendations page — the single highest-priority "do this first" hero card with fix block, canonical-evidence navigation, and reject affordance (#629 extraction).
- If removed: `Recommendations.tsx:112` and TopActionHero.test.ts break.
- Current: OK. `api-client` import is type-only — SPA-clean.
- Location: OK.

### src/components/recommendations/WeeklyDeltaPanel.tsx
- Feature: Recommendations page — week-over-week delta banner + tabbed drilldown across token/tool/error signals (#629 extraction).
- If removed: `Recommendations.tsx:108-110` (`WeeklyDeltaBanner`, `WeeklyDeltaDrilldown`) breaks.
- Current: OK.
- Location: OK.

FINDINGS:
1. `src/components/affordance/ApplyButton.tsx` is dead UI — exported `ApplyButton` (ApplyButton.tsx:53) has zero consumers across src/ + scripts/ (grep `"ApplyButton"` hits only its own file); the tier-3 apply affordance from epic #490/#491 (commit c6120cea) was never wired into any view. Removal candidate, or wire it into its intended Recommendations/PolicyBuilder consumers.


### — group: components-1 (46 files) —

### src/components/AdoptionScorecard.test.ts
- Feature: Pins the Adoption Scorecard view (#577) UI contract.
- If removed: vitest coverage lost for `AdoptionScorecardPf`; no other consumer. Subject exists (`AdoptionScorecard.tsx`).
- Current: OK — mocks `@api-client` (SERVER_AVAILABLE=false) and pins registry-described page header + SPA needs-a-server empty state.
- Location: OK.

### src/components/AdoptionScorecard.tsx
- Feature: Recs Adoption Scorecard (#577, ADR 0005 demo artifact) — joins SURFACED/SUPPRESSED receipts with live CLAUDE.md hunks, plus steer telemetry.
- If removed: view-registry.tsx:244 lazy route breaks (scorecard view 404s); AdoptionScorecard.test.ts fails.
- Current: OK — honesty labels (lower bound / non-causal / attribution pending) documented and load-bearing.
- Location: OK. `adoption-receipts` import is type-only (line 36) — SPA-safe; data fetch routes through `@api-client`.

### src/components/AgentReportCardPf.test.ts
- Feature: Pins the Agent Report Card (#572) rendering contract.
- If removed: vitest coverage lost; subject exists. Pins KEEP/FLAG/MOVE verdict rendering with mocked `buildReportCard` + expandable per-session context (8 tests).
- Current: OK.
- Location: OK.

### src/components/AgentReportCardPf.tsx
- Feature: Agent Report Card (#572) — per-project reliability/attribution verdicts from sessions + telemetry + debug.
- If removed: view-registry.tsx:206 lazy route breaks; AgentReportCardPf.test.ts fails.
- Current: OK — server-only nature documented in header.
- Location: OK, though it is the only component here carrying a `Pf` filename suffix (cosmetic inconsistency, not a defect).

### src/components/AgentSkill.test.ts
- Feature: Pins the Agents & Skills capability view aggregation/rendering (15 tests).
- If removed: vitest coverage lost; subject `AgentSkillPf` exists.
- Current: OK.
- Location: OK.

### src/components/AgentSkill.tsx
- Feature: Agents/skills/MCP invocation-usage view (capabilities surface).
- If removed: view-registry.tsx:176 lazy route breaks; AgentSkill.test.ts fails; CoverageState consumer link lost.
- Current: OK — leading `@vitest-environment jsdom` pragma in a non-test file is deliberate per its own comment.
- Location: OK.

### src/components/AppErrorBoundary.test.ts
- Feature: Pins the top-level crash guard: catches a throwing child, renders fallback, reset button recovers.
- If removed: vitest coverage lost; subject exists.
- Current: OK.
- Location: OK.

### src/components/AppErrorBoundary.tsx
- Feature: App-wide React error boundary wrapping the whole dashboard.
- If removed: main.tsx:9 import breaks — a render error anywhere would white-screen the app.
- Current: OK.
- Location: OK.

### src/components/AskClaude.test.ts
- Feature: Pins AskClaudePf overlay: FAB visibility, panel open/close, quick prompts, no-API-key warning, controller re-exports, mobile viewport (14 tests).
- If removed: vitest coverage lost; subject exists.
- Current: OK.
- Location: OK.

### src/components/AskClaude.tsx
- Feature: Ask Claude chat overlay (BYO Console API key) — floating action button + panel.
- If removed: App.tsx:33/:174 (type imports + lazy) break; prefetch.ts:23 prefetch breaks; three App.*.test.tsx mocks reference it.
- Current: FINDING (minor): header (lines 1–2) says "PatternFly 6 conversion of src/components/AskClaude.tsx (#407)" — the file describes itself as a conversion of itself; the pre-PF original it references no longer exists. Impersonation rule correctly preserved.
- Location: OK.

### src/components/AutomationView.test.ts
- Feature: Pins the unattended/automation-sessions view: `sdk-cli` entrypoint classification, table, search/filter (13 tests).
- If removed: vitest coverage lost; subject `AutomationViewPf` exists.
- Current: OK.
- Location: OK.

### src/components/AutomationView.tsx
- Feature: Automation view — unattended (SDK/CLI-entrypoint) session inventory and hygiene.
- If removed: view-registry.tsx:171 lazy route breaks (automation composite tab content); AutomationView.test.ts fails.
- Current: OK.
- Location: OK.

### src/components/BudgetGauge.test.ts
- Feature: Pins the plan-window budget gauge: fetchUsage-driven bars, thresholds, auth-login prompt (14 tests).
- If removed: vitest coverage lost; subject `BudgetGaugePf` exists.
- Current: FINDING (minor): comment at line 6 says "BudgetGauge.pf uses a relative import ('../lib/api-client')" — stale on both counts: the file is `BudgetGauge.tsx` (no `.pf`) and it imports `from '@api-client'` (BudgetGauge.tsx:34), not the relative path. Mock still resolves via the vitest alias, so tests pass.
- Location: OK.

### src/components/BudgetGauge.tsx
- Feature: Plan-usage budget gauge card (5h/7d windows) rendered inside Recommendations.
- If removed: Recommendations.tsx:92 lazy import breaks; BudgetGauge.test.ts fails.
- Current: FINDING (minor): header (line 2) self-references "conversion of src/components/BudgetGauge.tsx" — the pre-PF original is gone. Otherwise OK; server calls route through `@api-client`.
- Location: OK.

### src/components/BurnRateProjection.test.tsx
- Feature: Pins burn-rate projection table from cost trend + mocked usage windows (2 tests).
- If removed: vitest coverage lost; subject `BurnRateProjectionPf` exists.
- Current: OK.
- Location: OK.

### src/components/BurnRateProjection.tsx
- Feature: Plan-window burn-rate projection card embedded in Token Usage.
- If removed: TokenUsage.tsx:40 import breaks; BurnRateProjection.test.tsx fails.
- Current: OK — pure presentation over `lib/burn-rate-projection`, usage via `@api-client`.
- Location: OK.

### src/components/CheckpointDocContext.test.tsx
- Feature: Pins the checkpoint surface: doc-neighborhood render alongside AskUserQuestion-style options; answer records flow to the in-memory sink (3 tests).
- If removed: vitest coverage lost; subject exists.
- Current: OK.
- Location: OK.

### src/components/CheckpointDocContext.tsx
- Feature: Human-facing checkpoint surface (#2323, epic #2262) — doc cluster + answer prompt + efficacy instrumentation.
- If removed: DocRelationshipView.tsx:37 import breaks (embedded live preview); CheckpointDocContext.test.tsx fails.
- Current: OK — stale nodes demoted "as of <date>", instrumentation via pure `checkpoint-instrumentation` builder.
- Location: OK.

### src/components/CompositeTabsView.test.tsx
- Feature: Pins the composite tab shell (#2351): only active tab mounted, no own h1 (#1599 guard), first-visible default, serverData gating with `covered` override (11 tests).
- If removed: vitest coverage lost; subject exists.
- Current: OK.
- Location: OK.

### src/components/CompositeTabsView.tsx
- Feature: Generic composite tab shell for the consolidated `capabilities`/`automation` destinations (#2351).
- If removed: view-registry.tsx:256 lazy route breaks — both composite destinations lose their shell.
- Current: OK.
- Location: OK.

### src/components/ConfigHygiene.test.ts
- Feature: Pins config-hygiene panel rendering: resource-type grouping order, settings-health findings, hook command display (28 tests).
- If removed: vitest coverage lost; subject `ConfigHygienePf` exists.
- Current: OK.
- Location: OK.

### src/components/ConfigHygiene.tsx
- Feature: Config hygiene findings panel (unused skills/agents/plugins, settings health #167) rendered inside Recommendations.
- If removed: Recommendations.tsx:97 import breaks; ConfigHygiene.test.ts fails.
- Current: FINDING (minor): line 1 header self-references "conversion of src/components/ConfigHygiene.tsx (#407)" — original gone, same pattern as AskClaude/BudgetGauge.
- Location: OK.

### src/components/ContextComposition.test.tsx
- Feature: Pins the context-composition bucket table from token data + reconstructed liveConfig prefix (4 tests).
- If removed: vitest coverage lost; subject `ContextCompositionPf` exists.
- Current: OK.
- Location: OK.

### src/components/ContextComposition.tsx
- Feature: Context-window composition card (six buckets, #1926 live-config prefix) embedded in Token Usage.
- If removed: TokenUsage.tsx:56 import breaks; ContextComposition.test.tsx fails.
- Current: OK — honesty notes on reconstructed prefix/residual documented.
- Location: OK.

### src/components/ContextHealth.test.ts
- Feature: Pins the Context Health view: session health scoring, compactions, cache-efficiency tables, explainer text (29 tests).
- If removed: vitest coverage lost; subject `ContextHealthPf` exists.
- Current: OK.
- Location: OK.

### src/components/ContextHealth.tsx
- Feature: Context Health view — context growth, cache efficiency, compaction, per-session health scores.
- If removed: view-registry.tsx:190 lazy route breaks; ContextHealth.test.ts fails; EmptyDataView consumer link lost.
- Current: OK.
- Location: OK.

### src/components/ConversationPatterns.test.ts
- Feature: Pins the Turn Patterns view: conversation aggregation, latency histogram, search, registry explainer (23 tests).
- If removed: vitest coverage lost; subject `ConversationPatternsPf` exists.
- Current: OK.
- Location: OK.

### src/components/ConversationPatterns.tsx
- Feature: Conversation/turn-patterns view over session timelines.
- If removed: view-registry.tsx:195 lazy route breaks; ConversationPatterns.test.ts fails.
- Current: OK.
- Location: OK.

### src/components/CostAttribution.test.ts
- Feature: Pins the Cost Attribution view: flow-graph conservation invariant (#1014), tables, and the Reclaim Compass card via mocked recommendation surface (50 tests).
- If removed: vitest coverage lost, including the unit-testable-without-render conservation invariant; subject exists.
- Current: OK.
- Location: OK.

### src/components/CostAttribution.tsx
- Feature: Cost Attribution view — Sankey cost-flow graphs (tool/session/model×project) with Unattributed residual sink.
- If removed: view-registry.tsx:144 lazy route breaks; CostAttribution.test.ts fails.
- Current: OK — co-exported pure builders documented via eslint-disable rationale (lines 1–7).
- Location: OK.

### src/components/CoverageState.test.tsx
- Feature: Pins the coverage-verdict chip/empty-state: glyph + label per verdict from `COVERAGE_VERDICT_META` (5 tests).
- If removed: vitest coverage lost; subjects `CoverageState`/`CoverageVerdictBadge` exist.
- Current: OK.
- Location: OK.

### src/components/CoverageState.tsx
- Feature: Shared proven/inferred/cannot-see-yet coverage-verdict badge and empty-state.
- If removed: EvaluatorLanding.tsx:41 and AgentSkill.tsx:60 imports break; CoverageState.test.tsx fails.
- Current: OK — value vocabulary correctly lives in `lib/coverage-verdict` with type-only re-export here (react-refresh discipline).
- Location: OK.

### src/components/DiaryView.test.ts
- Feature: Pins the daily-digest Diary view: fetchDigest-driven day navigation, category groups, outcomes (6 tests).
- If removed: vitest coverage lost; subject `DiaryView` exists.
- Current: OK.
- Location: OK.

### src/components/DiaryView.tsx
- Feature: Diary view — daily digest per day, fetched from the server digest API.
- If removed: view-registry.tsx:230 lazy route breaks; DiaryView.test.ts fails.
- Current: OK — server fetch via `@api-client` + `SERVER_AVAILABLE` guard.
- Location: OK.

### src/components/DigestSpine.test.ts
- Feature: Pins the home landing spine: verdict → beats ordering with ready/loading/unavailable/error recommendation-surface states (8 tests).
- If removed: vitest coverage lost; subject `DigestSpine` exists.
- Current: OK.
- Location: OK.

### src/components/DigestSpine.tsx
- Feature: Home landing (epic #490/#491) — single ranked cross-domain answer spine, safety-first.
- If removed: view-registry.tsx:101 lazy route breaks — the home view; DigestSpine.test.ts fails.
- Current: OK — ranking logic correctly delegated to pure `lib/digest.ts`; strict h1→h2→h3 hierarchy documented.
- Location: OK.

### src/components/DocHygieneBadges.tsx
- Feature: Shared doc-neighborhood hygiene badges (#2323) — stale/contradictory/dangling PF Labels + `asOfDate`/`isDemoted`/`demotedTextStyle` helpers.
- If removed: DocRelationshipView.tsx:36 and CheckpointDocContext.tsx:29 imports break. No dedicated test file (covered indirectly via those consumers' tests).
- Current: OK — explicitly enforces the plain-characters-not-emoji convention in its own contract.
- Location: OK.

### src/components/DocRelationshipView.test.tsx
- Feature: Pins the doc-relationship view: honest empty state for null neighborhood, sample-neighborhood render, stale-node demotion (8 tests).
- If removed: vitest coverage lost; subjects `DocRelationshipView`/`DocRelationshipViewSample` exist.
- Current: OK.
- Location: OK.

### src/components/DocRelationshipView.tsx
- Feature: Human doc-relationship graph view (#2323, epic #2262) with embedded checkpoint-surface preview.
- If removed: view-registry.tsx:264 lazy route breaks (registered as the SPA-safe `DocRelationshipViewSample` variant); DocRelationshipView.test.tsx fails.
- Current: OK.
- Location: OK.

### src/components/EmptyDataView.test.ts
- Feature: Pins the shared empty-state shape: title/h1/3xl, optional Card wrap, `titleMarginBottom` default 24 (4 tests).
- If removed: vitest coverage lost; subject exists.
- Current: OK.
- Location: OK.

### src/components/EmptyDataView.tsx
- Feature: Shared full-page "no data yet" guard used across analytics views.
- If removed: five importers break — ContextHealth.tsx:57, FilteredEmptyState.tsx:4, ReviewQueuePf.tsx:34, ToolUsage.tsx:47, ExperimentSegment.tsx:17.
- Current: OK.
- Location: OK.

### src/components/EnterpriseAdmin.test.ts
- Feature: Pins the enterprise admin view: mocked enterprise API fetches → org rollup, sessions, audit export, readiness receipt (7 tests).
- If removed: vitest coverage lost; subject `EnterpriseAdmin` exists.
- Current: OK.
- Location: OK.

### src/components/EnterpriseAdmin.tsx
- Feature: Enterprise admin dashboard (org rollup, security controls, audit export) — server-tier only.
- If removed: view-registry.tsx:281 conditional lazy route breaks; correctly compiled out of `spa`/`sample` modes via `EnterpriseAdminUnavailable` (view-registry.tsx:277–279), so the SPA bundle never carries it.
- Current: OK — all server data via `@api-client`.
- Location: OK.

### src/components/ErrorRetry.test.ts
- Feature: Pins the Errors & Retries view: tool-error/API-status/retry-pressure KPI values from fixtures (13 tests).
- If removed: vitest coverage lost; subject `ErrorRetryPf` exists.
- Current: OK.
- Location: OK.

### src/components/ErrorRetry.tsx
- Feature: Errors & Retries view — tool errors, API error statuses, retry-group detection.
- If removed: view-registry.tsx:165 lazy route breaks; ErrorRetry.test.ts fails.
- Current: OK — presentation over `lib/parse-errors` aggregators.
- Location: OK.

### src/components/EvaluatorLanding.test.ts
- Feature: Pins the evaluator landing view: KPI values from runtime events/errors/file-reread fixtures + drill-through navigation (11 tests).
- If removed: vitest coverage lost; subject `EvaluatorLandingPf` exists (EvaluatorLanding.tsx, registered at view-registry.tsx:119).
- Current: OK.
- Location: OK.

FINDINGS:
1. src/components/BudgetGauge.test.ts:6 — stale comment: claims "BudgetGauge.pf uses a relative import ('../lib/api-client')", but the component is `BudgetGauge.tsx` and imports `from '@api-client'` (BudgetGauge.tsx:34); the mock works only via the vitest alias, so the documented mechanism is wrong (minor, comment-only).
2. Stale self-referential "PatternFly 6 conversion of src/components/<X>.tsx (#407)" headers in AskClaude.tsx:2, BudgetGauge.tsx:2, ConfigHygiene.tsx:1 — each file describes itself as a conversion of a pre-PF original that no longer exists in the tree (minor, comment-only; no behavioral impact).


### — group: components-2 (46 files) —

### src/components/EvaluatorLanding.tsx
- Feature: Evaluator landing view — speed/cost evaluation tiles (turn latency, per-task cost, retry pressure, re-read churn) with drill-through (#491/#493).
- If removed: view-registry.tsx lazy route breaks (`src/lib/view-registry.tsx:118-121`, rendered at :628).
- Current: OK — comments track later cleanups (#2346) accurately.
- Location: OK.

### src/components/ExperimentSegment.test.tsx
- Feature: Vitest coverage for the experiment-segment view (#2096).
- If removed: vitest loses the pin; subject `ExperimentSegment.tsx` exists.
- Current: OK — pins per-arm segmentation from branch-prefix/opener markers (`exp-os/…` fixture) and per-arm cost/metric table rendering.
- Location: OK (co-located).

### src/components/ExperimentSegment.tsx
- Feature: Experiment-arm segmentation view for the agent-team-structure trial (#2096, epic #2094) — per-arm metrics over already-ingested sessions.
- If removed: view-registry lazy route breaks (`view-registry.tsx:270-272`, rendered :665); ExperimentSegment.test.tsx fails.
- Current: OK — pure presentational as its header claims; no fetch.
- Location: OK.

### src/components/FileImpact.test.ts
- Feature: Vitest coverage for the File Impact view.
- If removed: vitest loses the pin; subject `FileImpact.tsx` exists.
- Current: OK — pins file/dir aggregation, re-read detection thresholds, and nav description via fixtures.
- Location: OK.

### src/components/FileImpact.tsx
- Feature: File Impact view — files/dirs touched, read-only vs churn, re-read waste tables and bar chart.
- If removed: view-registry lazy route breaks (`view-registry.tsx:140-141`, rendered :698); FileImpact.test.ts fails.
- Current: OK.
- Location: OK.

### src/components/FileUpload.test.ts
- Feature: Vitest coverage for the SPA upload modal.
- If removed: vitest loses the pin; subject `FileUpload.tsx` exists.
- Current: OK — mocks `runUploadPipeline` and pins the onUserUploadStart/onResult upload contract (#526/#1069).
- Location: OK.

### src/components/FileUpload.tsx
- Feature: Upload modal (directory / .zip / drag-drop) feeding the worker-based upload parse pipeline — the SPA's data-ingest front door.
- If removed: App.tsx import breaks (plus App.*.test.tsx suites); SPA upload path dies.
- Current: OK — mobile two-target rule and worker offload documented and present.
- Location: OK.

### src/components/FilteredEmptyState.tsx
- Feature: Shared "no data matches these filters" empty state for filtered dashboard views.
- If removed: view-registry lazy import breaks (`view-registry.tsx:103-105`, rendered via `shouldShowFilteredEmptyState` at :933).
- Current: OK.
- Location: OK.

### src/components/Gate2702Results.test.tsx
- Feature: Vitest coverage for the gate-2702 results table.
- If removed: vitest loses the pin; subject `Gate2702Results.tsx` exists.
- Current: OK — pins run-row projection rendering and the decision/outcome label mapping (sidekick-clears / inconclusive / invalid).
- Location: OK.

### src/components/Gate2702Results.tsx
- Feature: Renders the gate-2702 sidekick live-receipt trial projection (runs, gates, verdict) inside the shadow-experiments panel.
- If removed: `ShadowExperimentLog.tsx:38` import breaks (rendered :194), which sits under `ShadowCallsPf` → view-registry route (`view-registry.tsx:232-233`).
- Current: OK.
- Location: OK.

### src/components/LiveSession.test.ts
- Feature: Vitest coverage for the live in-flight session widget.
- If removed: vitest loses the pin; subject `LiveSession.tsx` exists.
- Current: OK — mocks `../lib/api-client` fetchLive and pins the poll/render/render-nothing-when-inactive contract.
- Location: OK.

### src/components/LiveSession.tsx
- Feature: Live in-flight session widget — polls `/api/live` ~10s for tokens burned, model, context fill, retry-storm/re-read badges (#196).
- If removed: `Recommendations.tsx:94-95` lazy import breaks (rendered :683); LiveSession.test.ts fails.
- Current: OK.
- Location: OK — server call correctly routed via `@api-client` alias (SPA stub-safe).

### src/components/LocalAnalyze.test.tsx
- Feature: Vitest coverage for the Tier A local-analyze panel.
- If removed: vitest loses the pin; subject `LocalAnalyze.tsx` exists (export `LocalAnalyzePf`).
- Current: OK — mocks `@api-client` analyzeLocal and pins the click-to-analyze flow plus deterministic-fallback degradation.
- Location: OK.

### src/components/LocalAnalyze.tsx
- Feature: Tier A "Analyze locally" surface (#2319, ADR 0018) — user-initiated local-model analysis over deterministic rec call sites; never "insights".
- If removed: view-registry lazy route breaks (`view-registry.tsx:113-116`, rendered :621); LocalAnalyze.test.tsx fails.
- Current: OK — ADR 0018 governance header matches behavior (loopback local model only, deterministic fallback).
- Location: OK.

### src/components/Markdown.test.ts
- Feature: Vitest coverage for the hand-rolled markdown renderer.
- If removed: vitest loses the pin; subject `Markdown.tsx` exists.
- Current: OK — pins paragraph/heading/code block parsing of the zero-dep parser.
- Location: OK.

### src/components/Markdown.tsx
- Feature: Zero-dependency markdown renderer (insights-report-aware headings) used by LLM-output surfaces.
- If removed: `AskClaude.tsx:47` (`MarkdownPf`) and `LocalAnalyze.tsx` imports break; Markdown.test.ts fails.
- Current: OK — "verbatim copy from src/components/Markdown.tsx" header is self-referential post-#407 conversion but harmless/historical.
- Location: OK.

### src/components/Memories.tsx
- Feature: Agent memories view (#458) — per-project `~/.claude/projects/<slug>/memory/*.md` grouped, badged, expandable.
- If removed: view-registry lazy route breaks (`view-registry.tsx:178-179`, rendered :500); Memories.test.ts fails.
- Current: OK — works on both server (`/api/memories`) and SPA/upload data as documented.
- Location: OK.

### src/components/Memories.test.ts
- Feature: Vitest coverage for the memories view.
- If removed: vitest loses the pin; subject `Memories.tsx` exists (export `MemoriesPf`).
- Current: OK — pins per-project grouping, type badge, and expand-to-body behavior.
- Location: OK.

### src/components/ModelEvalsPf.test.tsx
- Feature: Vitest coverage for the Model Evals workbench.
- If removed: vitest loses the pin; subject `ModelEvalsPf.tsx` exists.
- Current: OK — pins ranked-run/veto rendering and the gap-mining proposed-batch-spec serialization face.
- Location: OK.

### src/components/ModelEvalsPf.tsx
- Feature: Model Evals workbench (#1086, epic #975) — committed eval evidence, result-history ledger, mined task-shape clusters, proposal-only routing recs.
- If removed: view-registry lazy route breaks (`view-registry.tsx:239`); ModelEvalsPf.test.tsx fails.
- Current: OK — "no write/API action" standing rule 6 documented and honored (read-only view).
- Location: OK.

### src/components/PFLayout.test.ts
- Feature: Vitest coverage for the app shell.
- If removed: vitest loses the pin; subject `PFLayout.tsx` exists.
- Current: OK — pins nav groups/items, sidebar toggle, filter toolbar with jsdom ResizeObserver/matchMedia polyfills.
- Location: OK.

### src/components/PFLayout.tsx
- Feature: The PatternFly app shell — masthead, sidebar nav, filter/theme/upload toolbar hosting every view.
- If removed: App.tsx breaks; the entire dashboard chrome disappears.
- Current: OK (minor: `PFLayout.tsx:99` comment says "Passed down from App.pf" — stale `.pf` filename, actual file is `App.tsx`; cosmetic).
- Location: OK.

### src/components/Permissions.test.ts
- Feature: Vitest coverage for the permissions/safety view.
- If removed: vitest loses the pin; subject `Permissions.tsx` exists (export `PermissionsPf`).
- Current: OK — pins permission-mode aggregation, safety scores, dangerous-command detection fixtures.
- Location: OK.

### src/components/Permissions.tsx
- Feature: Permissions & safety view — permission modes, safety scores, dangerous commands, config drift, policy candidates.
- If removed: view-registry lazy route breaks (`view-registry.tsx:167-168`, rendered :758); Permissions.test.ts fails; PolicyBuilder loses its only mount.
- Current: FINDING (minor) — `Permissions.tsx:265` comment references `./PolicyBuilder.pf`; the actual module is `./PolicyBuilder` (`.tsx`), a stale pre-rename filename.
- Location: OK.

### src/components/PlanShapesPf.test.tsx
- Feature: Vitest coverage for the Plan Shapes view.
- If removed: vitest loses the pin; subject `PlanShapesPf.tsx` exists.
- Current: OK — pins shape A/B/C clustering render, scatter, and the SPA empty state off `PlanSignature` fixtures.
- Location: OK.

### src/components/PlanShapesPf.tsx
- Feature: Plan Shapes view (#565) — structural clustering of `~/.claude/plans/` docs (server-only data; explanatory SPA empty state).
- If removed: view-registry lazy route breaks (`view-registry.tsx:224`); PlanShapesPf.test.tsx fails.
- Current: OK.
- Location: OK.

### src/components/PolicyBuilder.test.ts
- Feature: Vitest coverage for the settings-policy builder.
- If removed: vitest loses the pin; subject `PolicyBuilder.tsx` exists (export `PolicyBuilderPf`).
- Current: OK — mocks `../lib/api-client` writePolicy; pins candidate selection → diff/snippet → write flow.
- Location: OK.

### src/components/PolicyBuilder.tsx
- Feature: Policy Builder (#133) — turns permission-prompt candidates into a `settings.json` diff/snippet, with gated live write via `writePolicy`.
- If removed: `Permissions.tsx:37` import breaks; PolicyBuilder.test.ts fails.
- Current: OK — server write correctly routed through `@api-client` alias; `canWritePolicy` capability gate documented.
- Location: OK.

### src/components/ProjectActivity.test.ts
- Feature: Vitest coverage for the activity view.
- If removed: vitest loses the pin; subject `ProjectActivity.tsx` exists.
- Current: OK — pins calendar/heatmap/momentum stats and nav-description rendering.
- Location: OK.

### src/components/ProjectActivity.tsx
- Feature: Project Activity view — calendar days, hour heatmap, project momentum, usage stats.
- If removed: view-registry lazy route breaks (`view-registry.tsx:159-161`, rendered :734); ProjectActivity.test.ts fails.
- Current: OK.
- Location: OK.

### src/components/ProjectBreakdown.test.ts
- Feature: Vitest coverage for the projects view.
- If removed: vitest loses the pin; subject `ProjectBreakdown.tsx` exists.
- Current: OK — pins per-project stats/worktree grouping (minor: line 8 comment cites `PFLayout.pf.test.ts`; actual file is `PFLayout.test.ts`).
- Location: OK.

### src/components/ProjectBreakdown.tsx
- Feature: Projects view — per-project/worktree-group stats, session titles, progress bars.
- If removed: view-registry lazy route breaks (`view-registry.tsx:126-129`, rendered :657); ProjectBreakdown.test.ts fails.
- Current: OK.
- Location: OK.

### src/components/PromptAnalyzer.test.ts
- Feature: Vitest coverage for the prompt analyzer.
- If removed: vitest loses the pin; subject `PromptAnalyzer.tsx` exists (export `PromptAnalyzerPf`).
- Current: OK — pins prompt-length/quality stats and API-error correlation cards.
- Location: OK.

### src/components/PromptAnalyzer.tsx
- Feature: Prompt analyzer view — prompt-quality metrics with drill-through to analyzed sessions.
- If removed: view-registry lazy route breaks (`view-registry.tsx:184-186`, rendered :485); PromptAnalyzer.test.ts fails.
- Current: OK.
- Location: OK.

### src/components/RecommendationCard.test.ts
- Feature: Vitest coverage for the single-recommendation renderer.
- If removed: vitest loses the pin; subject `RecommendationCard.tsx` exists.
- Current: OK — pins severity/fix-block/unattended-badge rendering against a real detector's output shape.
- Location: OK.

### src/components/RecommendationCard.tsx
- Feature: Presentational primitives for one recommendation (card, FixBlock, UnattendedBadge, label maps), extracted from the Recommendations god-component (#628, epic #622).
- If removed: `Recommendations.tsx` and `AdoptionScorecard.tsx` imports break (both registered views).
- Current: OK — acyclic-dependency contract in the header holds (no import back into Recommendations.tsx).
- Location: OK.

### src/components/Recommendations.rec-focus.test.ts
- Feature: Vitest coverage for rec-focus deep linking.
- If removed: the `rec=<id>` route-param → scroll/focus contract (#2437) loses its pin; subject `Recommendations.tsx` exists.
- Current: OK — mocks the engine so the focused id is deterministic; asserts the `rec-<id>` DOM anchor + focus.
- Location: OK.

### src/components/Recommendations.test.ts
- Feature: Vitest coverage for the Recommendations view.
- If removed: vitest loses the main view pin; subject exists.
- Current: OK — stubs server-only widgets (BudgetGauge, LiveSession) and pins engine-output rendering/filtering.
- Location: OK.

### src/components/Recommendations.tsx
- Feature: The Recommendations view — the human-facing surface of the recs engine (the product's core claim surface).
- If removed: view-registry lazy route breaks (`view-registry.tsx:108-111`); Home-Digest sharing contract (:596) and both Recommendations test suites break; LiveSession loses its mount.
- Current: OK.
- Location: OK.

### src/components/ReviewQueuePf.test.tsx
- Feature: Vitest coverage for the review queue.
- If removed: vitest loses the pin; subject `ReviewQueuePf.tsx` exists.
- Current: OK — mocks `buildReviewQueue` and pins category/row rendering + empty state.
- Location: OK.

### src/components/ReviewQueuePf.tsx
- Feature: Review Queue view — sessions needing human attention, categorized from parsed telemetry/debug/timeline signals.
- If removed: view-registry lazy route breaks (`view-registry.tsx:210-212`, rendered :825); ReviewQueuePf.test.tsx fails.
- Current: OK.
- Location: OK.

### src/components/SearchView.test.ts
- Feature: Vitest coverage for search.
- If removed: vitest loses the pin; subject `SearchView.tsx` exists (export `SearchViewPf`).
- Current: OK — mocks `@api-client` with `SERVER_AVAILABLE: false`, pinning the client-side fallback search path.
- Current: OK.
- Location: OK.

### src/components/SearchView.tsx
- Feature: Prompt-history search view — server hybrid search via `fetchHybridSearch`, client-side `hybridSearchEntries` fallback in SPA.
- If removed: view-registry lazy route breaks (`view-registry.tsx:131-132`, rendered :675); SearchView.test.ts fails.
- Current: OK — server call correctly behind `@api-client`.
- Location: OK.

### src/components/SessionIdLink.test.ts
- Feature: Vitest coverage for the session-id link primitive.
- If removed: vitest loses the pin; subject `SessionIdLink.tsx` exists.
- Current: OK — pins onOpen link behavior and the no-onOpen copy-affordance fallback (#1618) with title resolution.
- Location: OK.

### src/components/SessionIdLink.tsx
- Feature: Shared session-id affordance — link to open a session, or copy-to-clipboard token when no navigation exists (#1618).
- If removed: at least 11 view components break (ContextHealth, TaskHealthPf, ConversationPatterns, SessionTimeline, ToolUsage, TokenUsage, SessionPatterns, AutomationView, AgentReportCardPf, CostAttribution, FileImpact).
- Current: OK.
- Location: OK.

### src/components/SessionList.test.ts
- Feature: Vitest coverage for the sessions list view.
- If removed: vitest loses the pin; subject `SessionList.tsx` exists (export `SessionListPf`, registered at `view-registry.tsx:123`).
- Current: OK — pins scorecard computation proportional to visible rows (#1000 lazy-scoring contract) plus sorting/filtering.
- Location: OK.

FINDINGS:
1. src/components/Permissions.tsx:265 — comment references the module as `./PolicyBuilder.pf`; the actual file is `PolicyBuilder.tsx` (stale pre-rename filename in doc comment). Same stale `.pf` naming pattern at src/components/PFLayout.tsx:99 ("App.pf") and src/components/ProjectBreakdown.test.ts:8 ("PFLayout.pf.test.ts"). Cosmetic comment staleness only; no behavioral defect.

All 46 files are reachable (view-registry lazy routes, App.tsx, or imports from registered views; tests all have existing subjects). No dead UI, no server-only value-imports outside the sanctioned `@api-client` boundary, and no emoji in UI copy.


### — group: components-3 (44 files) —

### src/components/SessionList.tsx
- Feature: Sessions view — per-session card list with expansion, source/member attribution, and transcript drill-in.
- If removed: view-registry.tsx:123-124 lazy route (`SessionListPf`) breaks; Sessions view 404s. Consumer of SessionTranscriptPf/heading/StatCard chains.
- Current: FINDING: stale header — lines 3-5 claim `<SessionTranscript />` "is not yet converted, so we render a minimal PF detail panel in its place", but the file imports `SessionTranscriptPf` (line 74) and renders it (line 1644).
- Location: OK.

### src/components/SessionPatterns.test.ts
- Feature: Vitest coverage for the Session Patterns view.
- If removed: vitest loses its pin; subject `SessionPatternsPf` exists in SessionPatterns.tsx.
- Current: OK — pins rendering of pattern digests from timeline/token/tool/error inputs.
- Location: OK.

### src/components/SessionPatterns.tsx
- Feature: Session Patterns view — cross-session behavioural pattern digest.
- If removed: view-registry.tsx:199-201 lazy route (`SessionPatternsPf`) breaks.
- Current: OK.
- Location: OK.

### src/components/SessionProvisioning.tsx
- Feature: Remote-session pool provisioning card (#1251 Slice 2) — provision `claude remote-control` pods, server-tier only.
- If removed: view-registry.tsx:249-251 lazy route breaks (`<SessionProvisioning serverAvailable/>` at :868).
- Current: OK — SPA path correctly degrades via api-client.spa stub (documented in header).
- Location: OK.

### src/components/SessionTimeline.css
- Feature: Styles for the Session Timeline evidence controls/toolbar.
- If removed: SessionTimeline.tsx:44 (`import './SessionTimeline.css'`) fails the build.
- Current: OK.
- Location: OK — colocated with its sole consumer.

### src/components/SessionTimeline.test.ts
- Feature: Vitest coverage for Session Timeline.
- If removed: loses pins on `SessionTimelinePf` (exists) incl. slim-hydration contract (#1035) via mocked `fetchSessionTimeline`.
- Current: OK.
- Location: OK.

### src/components/SessionTimeline.tsx
- Feature: Session Timeline view — per-session event/value-flow timeline with slim hydration.
- If removed: view-registry.tsx:154-156 lazy route (`SessionTimelinePf`) breaks.
- Current: OK.
- Location: OK.

### src/components/SessionTranscript.test.ts
- Feature: Vitest coverage for transcript drill-in.
- If removed: loses pins on `SessionTranscriptPf` (exists) and the stable-key helpers from session-transcript-keys.
- Current: OK.
- Location: OK.

### src/components/SessionTranscript.tsx
- Feature: Full transcript drill-in (assistant text + thinking blocks) fetched via api-client.
- If removed: SessionList.tsx:74/:1644 breaks (server-tier transcript panel).
- Current: FINDING (minor): self-referential header — line 2 says "PatternFly 6 conversion of src/components/SessionTranscript.tsx", i.e. it describes itself as its own pre-conversion original; stale note from the #407 swap-in.
- Location: OK.

### src/components/Settings.test.ts
- Feature: Vitest coverage for the Settings modal.
- If removed: loses pins on `SettingsPf` (dynamic-imported at test line 73; subject exists) — nav-prefs/API-key/model form behaviour.
- Current: OK.
- Location: OK.

### src/components/Settings.tsx
- Feature: Settings modal — API key, model, nav-prefs (PF Modal, lazy off first paint).
- If removed: App.tsx:170-171 lazy import (`SettingsPf`) breaks.
- Current: OK.
- Location: OK.

### src/components/ShadowCallsPf.test.tsx
- Feature: Vitest coverage for the Shadow Calls view.
- If removed: loses pin on `ShadowCallsPf` (exists) rendering `ShadowCallAggregate` cards.
- Current: OK.
- Location: OK.

### src/components/ShadowCallsPf.tsx
- Feature: Shadow Calls view (#513) — per-axis aggregate cards plus embedded experiments panel.
- If removed: view-registry.tsx:233 lazy route breaks; also the mount point for ShadowExperimentsPanel (import :30).
- Current: OK.
- Location: OK.

### src/components/ShadowExperimentLog.test.tsx
- Feature: Vitest coverage for the experiment drill-down log.
- If removed: loses pin on `ShadowExperimentLogView` (#2153: one row per ledger line, synthetic/skipped labelled not hidden).
- Current: OK.
- Location: OK.

### src/components/ShadowExperimentLog.tsx
- Feature: Per-experiment drill-down log (#2153) — filterable/sortable ledger rows from `/api/shadow-experiments.json`.
- If removed: ShadowCallsPf.tsx:30 (`ShadowExperimentsPanel`) and ShadowExperimentTrends.tsx:21 (`FilterSelect`) break.
- Current: OK.
- Location: OK.

### src/components/ShadowExperimentTrends.test.tsx
- Feature: Vitest coverage for experiment trend charts.
- If removed: loses pin on `ShadowExperimentTrendsView` (#2154: daily volume/win-rate/cost-delta series, empty days as zeros).
- Current: OK.
- Location: OK.

### src/components/ShadowExperimentTrends.tsx
- Feature: Shadow experiment trends over time (#2154) — daily series sliceable by axis/source.
- If removed: ShadowExperimentLog.tsx:39 (`ShadowExperimentTrendsView`) breaks.
- Current: OK.
- Location: OK.

### src/components/SortableTableHeader.tsx
- Feature: Shared sortable-column header primitive (arrow icons + button styling).
- If removed: ConversationPatterns.tsx:31 and FileImpact.tsx:34 break.
- Current: OK.
- Location: OK.

### src/components/StatCard.test.ts
- Feature: Vitest coverage for the KPI stat-card primitives.
- If removed: loses pin on `StatCardPf`/`StatCardStripPf` (both exist) — label/value/tone rendering.
- Current: OK.
- Location: OK.

### src/components/StatCard.tsx
- Feature: Shared KPI tile + strip primitive used across nearly every view.
- If removed: ~18 views break (AgentReportCardPf, AgentSkill, ContextHealth, ConversationPatterns, CostAttribution, DiaryView, ErrorRetry, EvaluatorLanding, ExperimentSegment, FileImpact, Permissions, ProjectActivity, PromptAnalyzer, SessionPatterns, TaskHealthPf, TeamCoordinationPf, TokenUsage, ToolUsage, UsageStats, WorkflowList).
- Current: OK.
- Location: OK.

### src/components/SteerTelemetryPanel.test.ts
- Feature: Vitest coverage for PreToolUse-steer telemetry (#2203).
- If removed: loses pin on `SteerTelemetryPanel` — subject exists but is exported from AdoptionScorecard.tsx:491 (test imports `./AdoptionScorecard`, mocks `@api-client`); pins fetch/render of `SteerRuleTelemetry` rules.
- Current: OK.
- Location: Note — test filename has no matching SteerTelemetryPanel.tsx; subject lives inside AdoptionScorecard.tsx. Acceptable but name-mismatched; consider colocating name or extracting the panel.

### src/components/SummaryView.test.ts
- Feature: Vitest coverage for the token-spend Summary view.
- If removed: loses pin on `SummaryView` (exists) — spend rollups from Session/SessionTokenData.
- Current: OK.
- Location: OK.

### src/components/SummaryView.tsx
- Feature: Token-spend Summary view — project/day/model/token-type spend rollups, SPA-safe by construction.
- If removed: view-registry.tsx:151-152 lazy route breaks.
- Current: OK.
- Location: OK.

### src/components/TaskHealthPf.test.ts
- Feature: Vitest coverage for Task Health.
- If removed: loses pin on `TaskHealthPf` (exists) — task completion/abandonment digest from `TaskRecord`s + nav-prefs label.
- Current: OK.
- Location: OK.

### src/components/TaskHealthPf.tsx
- Feature: Task Health view (#559) — per-session task completion/abandonment, server-only with SPA empty state.
- If removed: view-registry.tsx:216 lazy route breaks.
- Current: OK.
- Location: OK.

### src/components/TeamCoordinationPf.test.ts
- Feature: Vitest coverage for Team Coordination.
- If removed: loses pin on `TeamCoordinationPf` (exists) — dropped-assignment/stalled-agent inbox health.
- Current: OK.
- Location: OK.

### src/components/TeamCoordinationPf.tsx
- Feature: Team Coordination view (#560) — inter-agent inbox health from `~/.claude/teams/`, server-only.
- If removed: view-registry.tsx:219-220 lazy route breaks.
- Current: OK.
- Location: OK.

### src/components/TokenUsage.tsx
- Feature: Token Usage view — spend-over-time chart, KPI tiles with drill-through links (#1813).
- If removed: view-registry.tsx:134-135 lazy route (`TokenUsagePf`) breaks; consumer of token-usage-chart.ts.
- Current: FINDING: line 1 is `// @vitest-environment jsdom` — a vitest test-file pragma at the top of a production component; it belongs in test files (cf. TokenUsage.test.ts), is inert here, and should be removed.
- Location: OK.

### src/components/TokenUsage.test.ts
- Feature: Vitest coverage for Token Usage.
- If removed: loses pins on `TokenUsagePf` (exists) + chart bucketing from token-usage-chart (daily→weekly rollup, multi-year axis labels #2438, KPI drill-through #1813).
- Current: OK.
- Location: OK.

### src/components/ToolUsage.test.ts
- Feature: Vitest coverage for Tool Usage.
- If removed: loses pin on `ToolUsagePf` (exists) — tool frequency/error rendering from ToolUsageData/ApiErrorEvent/ToolInventory.
- Current: OK.
- Location: OK.

### src/components/ToolUsage.tsx
- Feature: Tool Usage view — per-tool call/error breakdown with inventory.
- If removed: view-registry.tsx:137-138 lazy route (`ToolUsagePf`) breaks.
- Current: OK.
- Location: OK.

### src/components/UsagePulsePf.test.ts
- Feature: Vitest coverage for Usage Pulse.
- If removed: loses pin on `UsagePulsePf` (exists) — sparkline/week-over-week verdict from StatsCache + SPA-safe rollup card.
- Current: OK.
- Location: OK.

### src/components/UsagePulsePf.tsx
- Feature: Usage Pulse view (#563) — daily-activity sparkline + WoW verdict; stats-cache portion server-only, rollup card (#960) SPA-safe.
- If removed: view-registry.tsx:227 lazy route breaks.
- Current: OK.
- Location: OK.

### src/components/UsageStats.test.ts
- Feature: Vitest coverage for the usage-stats panel.
- If removed: loses pin on `UsageStatsPf` (exists) — day/project drill-through targets (affordance/DrillThrough).
- Current: OK.
- Location: OK.

### src/components/UsageStats.tsx
- Feature: Usage-stats panel — former standalone Stats view, folded into Project Activity (view-registry.tsx:729 comment, #14).
- If removed: ProjectActivity.tsx:30 (`UsageStatsPf`) breaks; ProjectActivity is registered (view-registry.tsx:159-161), so reachable.
- Current: OK.
- Location: OK.

### src/components/ViewErrorBoundary.test.ts
- Feature: Vitest coverage for the per-view error boundary.
- If removed: loses pin on `ViewErrorBoundary` (exists) — catch/render-fallback/retry contract.
- Current: OK.
- Location: OK.

### src/components/ViewErrorBoundary.tsx
- Feature: Per-view React error boundary — one crashing lazy view doesn't take down the app shell.
- If removed: App.tsx:137 breaks; every routed view loses crash isolation.
- Current: OK.
- Location: OK.

### src/components/WorkflowList.tsx
- Feature: Workflow Run Ledger view (#435) — post-hoc ledger of Workflow-tool runs via GET /api/workflows, server-only.
- If removed: view-registry.tsx:181-182 lazy route (`WorkflowListPf`) breaks.
- Current: OK.
- Location: OK.

### src/components/WorkflowList.test.ts
- Feature: Vitest coverage for the workflow ledger.
- If removed: loses pin on `WorkflowListPf` (exists) — run rows, per-agent phase tables, session deep-link.
- Current: OK.
- Location: OK.

### src/components/heading.test.ts
- Feature: Vitest coverage for the heading-hierarchy convention.
- If removed: loses pin on `PageHeader`/`PageTitle`/`SectionHeader`/`SubSectionHeader` (all exist) — the #614 type-scale/glyph contract.
- Current: OK.
- Location: OK.

### src/components/heading.tsx
- Feature: Shared heading-hierarchy convention module (#614) — PageHeader/SectionHeader/SubSectionHeader + `subtleCardTitle` token.
- If removed: ~35 views break (AdoptionScorecard through UsagePulsePf — see the repo-wide `from './heading'` import list).
- Current: OK — eslint-disable rationale documented; glyphs are plain characters, not emoji.
- Location: OK.

### src/components/recommendation-display.ts
- Feature: Recommendation severity/category/fix-target/view display maps (#628) for the Recommendations surface.
- If removed: RecommendationCard.tsx:43, Recommendations.tsx:105, recommendations/TopActionHero.tsx:26, and Recommendations.test.ts break.
- Current: OK.
- Location: OK — deliberately component-free module colocated in components/ (react-refresh rationale in header).

### src/components/session-transcript-keys.ts
- Feature: Stable React-key derivation (stable stringify) for transcript content/thinking blocks.
- If removed: SessionTranscript.tsx:26 and SessionTranscript.test.ts break.
- Current: OK.
- Location: OK — same colocated-helper pattern as recommendation-display.ts.

### src/components/token-usage-chart.ts
- Feature: Chart-series shaping for TokenUsage spend-over-time (daily→weekly rollup boundary #2397).
- If removed: TokenUsage.tsx:46 (`buildCostTrendChartSeries`) and TokenUsage.test.ts break.
- Current: OK.
- Location: OK — header documents the non-component-module pattern.

FINDINGS:
1. src/components/SessionList.tsx:3-5 — stale header comment claims SessionTranscript "is not yet converted, so we render a minimal PF detail panel in its place"; the file imports `SessionTranscriptPf` at line 74 and renders it at line 1644.
2. src/components/TokenUsage.tsx:1 — stray `// @vitest-environment jsdom` test pragma at the top of a production component file (belongs only in test files); inert but wrong content.
3. src/components/SessionTranscript.tsx:2 — self-referential stale header: "PatternFly 6 conversion of src/components/SessionTranscript.tsx" describes the file as a conversion of itself (leftover from the #407 swap-in).

---

## Final batch: src root, docs, fixtures, e2e, .github, operator, deploy, periphery (DONE — 2026-07-22)

### — group: src-root (13 files) —

### src/App.doc-issue-expiry.test.tsx
- Feature: Regression test for doc-issue expiry hygiene at App level — verifies repoMap-slice patches/refresh keys flow so expiry recommendations re-derive after a slice update.
- If removed: silent regression risk in the App slice-patch → recommendation refresh path; consumed only by vitest (`npm test`).
- Current: OK — mocks match App's real `applySlice`/dataset hooks.
- Location: OK (colocated with App.tsx per repo convention).

### src/App.redirect-nav.test.tsx
- Feature: #2351 redirect chokepoints — absorbed workflow-hygiene view ids (`tools`, `tasks`, …) keep resolving via hash deep-links and programmatic `navigateTo`/`navigateWithFilter`.
- If removed: legacy-view redirect regressions undetected; companion to pure-parse coverage in `src/lib/routing.test.ts`; vitest-only consumer.
- Current: OK.
- Location: OK.

### src/App.sample-isolation.test.tsx
- Feature: #1749 race regression — a mid-flight demo-corpus auto-load must never re-seed sample data on top of a real user upload (SPA free path).
- If removed: the demo/real data-mixing race could silently return; vitest-only consumer.
- Current: OK — drives the exact deferred-import race with `SAMPLE_CORPUS_1749` tag scan.
- Location: OK.

### src/App.tsx
- Feature: The state monolith (~2100 lines, dozens of `useState` slices incl. generic `useState<T>` calls): dataset load/rehydrate, enterprise auth/session, sample vs upload vs server data source, routing/focus, and `renderView` dispatch for every surface.
- If removed: entire app breaks — consumed by `src/main.tsx` (both hydrate and createRoot branches render `AppPf`), `src/components/PFLayout.tsx` (import from `'../App'`), and the three App tests above.
- Current: OK for this pass — entry wiring verified: `index.html` → `/src/main.tsx` → `ShellGate` (server flavor) → `AppPf`; #2444 `initialShell` seed is type-only at the shell boundary as documented.
- Location: OK, though its size makes it the standing decomposition target (see v060-decomposition drafts).

### src/assets/ (react.svg, vite.svg)
- Feature: None — Vite React template leftovers (last touched 2026-05-21, commit 8f8af9c6); the favicon is an inline data-URI in `index.html`.
- If removed: nothing found — removal candidate. Greps: `grep -rn "react.svg\|vite.svg" src index.html --include=*.ts,*.tsx,*.html,*.css` → zero matches.
- Current: FINDING: dead template assets shipped in the source tree.
- Location: n/a (delete).

### src/instant-shell-gate.tsx
- Feature: #2444 instant-paint bridge — re-renders the server-painted shell HTML opaquely for hydration, then flips to the real app after first paint (rAF + 100ms hidden-tab fallback).
- If removed: server-flavor hydration path in `main.tsx` breaks (blank/reflowed first frame, destructive mount on populated `#root`); sole consumer is `src/main.tsx`.
- Current: OK — the `data-instant-shell=""` empty-string hydration-match subtlety is documented inline.
- Location: OK (could live in `src/lib/`, but it's a component and entry-adjacent by design).

### src/main.tsx
- Feature: Browser entry point: PF base.css + pf-global.css imports, then flavor split — hydrate `ShellGate`-wrapped `AppPf` when `[data-instant-shell]` exists (server build), else fresh `createRoot` (SPA/dev).
- If removed: app doesn't boot — `index.html` script tag is the sole loader.
- Current: OK — `__BOOT__` parse is fail-open (missing/malformed boot script degrades to unseeded hydration) as the #2444 contract states.
- Location: OK.

### src/pf-global.css
- Feature: The minimal global stylesheet layered on PF base.css: `pf-live-pulse` keyframes (LiveSession dot) and `.chd-sidebar-filters` grid (PFLayout sidebar).
- If removed: live-session pulse animation and sidebar filter layout break; consumers `src/components/LiveSession.tsx`, `src/components/PFLayout.tsx`; imported once from `src/main.tsx`.
- Current: FINDING (minor, stale comments): pf-global.css:4 says "Imported once from the PF entry (main.pf.tsx)" — no `main.pf.tsx` exists, the entry is `src/main.tsx`; pf-global.css:9 references `LiveSession.pf.tsx` — the file is `LiveSession.tsx`. Leftovers from the pre-#439 `.pf` naming cutover.
- Location: OK.

### src/test-support/ready-analysis.ts
- Feature: #2719 test-only factories for `RecommendationSurfaceState` (ready/loading/unavailable/error) so component tests reproduce viewer-only "engine ran" states without shipping the detector catalog to the browser.
- If removed: 4 test suites break (`Recommendations.test.ts`, `Recommendations.rec-focus.test.ts`, `CostAttribution.test.ts`, `DigestSpine.test.ts`).
- Current: OK — imported only by `*.test.*` files, honoring the engine-absence bundle gate as its header claims.
- Location: OK — the dedicated `test-support/` dir is exactly right for this.

### src/types.ts
- Feature: The shared domain-type spine (~730 lines): `View`, `HistoryEntry`, `Session*`, `DataSource`/`CodingHarness` multi-harness provenance, etc.
- If removed: near-total breakage — imported across essentially the whole `src/` tree (hundreds of `from './types'`/`'../types'` import sites).
- Current: OK — field docs sampled (member attribution #1563/#1999, transcript dimensions) match current parsers; `service_tier` note aligns with the AGENTS.md caveat.
- Location: OK.

### src/vite-env.d.ts
- Feature: Vite client type reference + `__APP_VERSION__` ambient declaration for the #646 build-time version stamp (`define` in vite.config.ts).
- If removed: typecheck fails anywhere `__APP_VERSION__` or `import.meta.env` is referenced (`tsc -b` is CI-gating).
- Current: OK.
- Location: OK (canonical Vite location).

### src/vite-plugin-instant-shell.test.ts
- Feature: #2444 wiring guard — proves the `chd-instant-shell` plugin runs for the default/server build and is absent for `spa`/`sample` (index.html byte-identical), which the cold-load harness cannot gate.
- If removed: a flavor-wiring regression (shell injected into SPA, or dropped from server) would ship unnoticed; vitest-only consumer.
- Current: OK — plugin it tests is inline in `vite.config.ts:120` (`name: 'chd-instant-shell'`), and it pre-sets `GIT_SHA` so the config factory never shells out to git.
- Location: Slight mismatch — it tests root-level `vite.config.ts`, not a `src/` module (the shell helper itself is `src/lib/instant-shell.ts` with its own test); living in `src/` is presumably for the vitest include glob. Note only, not a defect.

FINDINGS:
1. `src/assets/react.svg` and `src/assets/vite.svg` are dead Vite-template leftovers with zero consumers (grep of `src/` + `index.html` for `react.svg|vite.svg` finds nothing; favicon is an inline data-URI) — removal candidates.
2. `src/pf-global.css` stale comments: line 4 claims the import site is `main.pf.tsx` (actual: `src/main.tsx`; no `main.pf.tsx` exists) and line 9 references `LiveSession.pf.tsx` (actual: `src/components/LiveSession.tsx`) — pre-#439 `.pf` naming residue.


### — group: docs-adr-plans (32 files) —

### docs/adr/0001-squash-merge-missing-commits.md
- Feature: PR-merge integrity guardrail — records why the `PR has a diff` CI gate exists.
- If removed: `.github/workflows/pr-nonempty.yml` and `AGENTS.md` (PR scope gate) cite it as rationale — links break; the guardrail itself keeps working.
- Current: OK — Status Accepted matches reality (gate enforced in CI).
- Location: OK.

### docs/adr/0002-dynamic-recommendation-rule-engine.md
- Feature: Recommendation engine architecture — discovery-pipeline-not-runtime-eval decision.
- If removed: cited by `docs/adding-a-recommendation.md`, ADR 0005, `docs/competitive-analysis/anthropic-guidance.md`.
- Current: FINDING — Status still "Proposed (RFC — needs human ratification)" (line 3) while #189 is CLOSED and Accepted ADR 0004 declares it "Builds on: ADR 0002 (the recommendation engine this feeds)" — same stale-Proposed class as #2949.
- Location: OK.

### docs/adr/0003-public-spa-hosting.md
- Feature: Public upload-only SPA hosting split (private source, public artifact).
- If removed: cited by ADRs 0008, 0009, 0014.
- Current: FINDING — Status "Proposed (research/decision record for #326)" but #326 is CLOSED and the SPA is live in production (ADR 0014:17 cites "the live public SPA (`coach.skrzypek.dev`)"). Same class as #2949.
- Location: OK.

### docs/adr/0004-shadow-calls-experiment-engine.md
- Feature: Shadow-calls counterfactual experiment engine (epic #513) feeding recs.
- If removed: cited by `docs/shadow-calls.md` and ADR 0005.
- Current: OK — Accepted, amended 2026-07-13 with packaging issue #2582; matches shipped state.
- Location: OK.

### docs/adr/0005-recs-adoption-measurable-impact.md
- Feature: Recs adoption/impact measurement design (adopt-block markers, AdoptionScorecard).
- If removed: cited by ADRs 0008/0017/0018, `docs/product/privacy-and-data.md`, proof-preregistration doc, feature docs.
- Current: FINDING — Status "Proposed (design-first…)" but #573 is CLOSED and the design shipped (`src/components/AdoptionScorecard.tsx` + adoption-loop live). Same stale-Proposed class as #2949.
- Location: OK.

### docs/adr/0006-speed-domain-the-clock-hard-lever.md
- Feature: `speed` action-domain boundary + actionability bar (#708 epic).
- If removed: cited by `docs/audits/2026-07-harness-neutral-speed-opportunities.md` and `src/lib/domain-registry.ts:61` narrative.
- Current: OK — Accepted; `src/lib/detectors/speed/` (time-motion, model-latency, hook-overhead) exists.
- Location: OK.

### docs/adr/0007-repo-map-host-producer-wasm.md
- Feature: Repo Map generation topology — host-side WASM producer, container reads artifact.
- If removed: `src/lib/repo-map/index.ts` cites it as the artifact contract; deploy refresh path (`scripts/deploy.sh`) depends on the decision.
- Current: OK — Accepted, matches enforcement (host-side `refresh:repo-map`, zero-node_modules runtime).
- Location: OK.

### docs/adr/0008-server-llm-usage-governance.md
- Feature: Scoped Anthropic-egress invariant + call-site registry for server LLM use.
- If removed: load-bearing — cited by `CLAUDE.md`, `AGENTS.md`, ADRs 0009/0010/0013/0014/0018, product docs.
- Current: FINDING (already filed, #2949 OPEN — do not refile) — Status "Proposed" though CI-enforced.
- Location: OK.

### docs/adr/0009-hosted-k8s-operator-dispatch-aggregation.md
- Feature: Hosted operator architecture — aggregate-everywhere ingest + pod-per-dispatch `RemoteSession`.
- If removed: the k8s ADR chain (0010/0011/0012/0013/0015) and competitive-analysis docs all anchor on it; ADR 0012 defers to it as "the current operator" architecture.
- Current: FINDING — Status "Proposed" but the architecture is implemented and running (`probaitio-operator/` in-repo; ADR 0012 points here for "the current operator"). Same stale-Proposed class as #2949.
- Location: OK.

### docs/adr/0010-k8s-substrate-reuse-over-build.md
- Feature: Reuse-over-build posture for the k8s substrate.
- If removed: `AGENTS.md` "Kubernetes substrate: reuse over build" section cites it as the full posture; ADRs 0011/0013/0015/0018 build on it.
- Current: FINDING — Status "Proposed" while `AGENTS.md` enforces it as standing project convention and later Accepted ADRs treat it as the default. Same stale-Proposed class as #2949.
- Location: OK.

### docs/adr/0011-probaitio-openshift-mvp.md
- Feature: OpenShift packaging + Probaitio naming/API-group + single-tenant MVP scope.
- If removed: ADR 0012 and all four `docs/plans/openshift-mvp/` docs cite it as the reconciliation anchor.
- Current: OK — Accepted; matches shipped `probaitio.com/v1alpha1` group in `probaitio-operator/api/v1alpha1/`.
- Location: OK.

### docs/adr/0012-probatio-operator-mvp-realization.md
- Feature: Operator MVP realization record — now a supersession pointer (#1956 Go rewrite).
- If removed: cited by ADRs 0013/0014; it is the only doc recording where the Node operator went and why.
- Current: OK — Status Superseded is honest and the body was rewritten as a pointer.
- Location: OK — filename spells old name "probatio" vs product "Probaitio"; immutable-filename convention makes this acceptable, note only.

### docs/adr/0013-swappable-compute-substrate.md
- Feature: Substrate-neutrality decision — `RemoteSession` execution pluggable across substrates.
- If removed: cited by ADR 0015; the dispatch-abstraction rationale is only recorded here.
- Current: OK — Accepted; consistent with 0015's "build RemoteSession, defer Kagenti".
- Location: OK.

### docs/adr/0014-tiered-delivery-model.md
- Feature: Five-tier delivery ladder keyed on data locality (one engine, five envelopes).
- If removed: cited by ADR 0016/0018, `docs/page-contracts.md`, `docs/product/how-it-works.md`, `docs/product/privacy-and-data.md`.
- Current: OK — Accepted; tier work is live (epic #2443 instant-load refs in `bundle-budget.json`).
- Location: OK.

### docs/adr/0015-kagenti-evaluation-build-remotesession.md
- Feature: Build-vs-adopt verdict on Kagenti as dispatch substrate (defer to enrollment layer).
- If removed: no in-repo consumer found (`grep -rln 0015-kagenti` → only self); it is the sole record of the #1885 evaluation, so keep as decision record — not a removal candidate.
- Current: OK — Accepted; consistent with 0009/0013.
- Location: OK.

### docs/adr/0016-bundle-budget-classes.md
- Feature: Structural bundle budget (shell/vendor/routes classes) replacing the rising total.
- If removed: `docs/bundle-budget-contract.md` cites it; `bundle-budget.json` header names it as authority for shell raises ("Raise only via ADR").
- Current: OK — Accepted and enforced (`bundle-budget.json` v2 + `scripts/check-bundle-size.mjs`); amendment #2446 recorded in the budget file.
- Location: OK.

### docs/adr/0017-proof-tier-ladder-and-premise-gate.md
- Feature: Proportionate proof tiers + premise-pricing gate for recommendation claims.
- If removed: cited by `docs/adding-a-recommendation.md` (the detector contract) and ADR 0018; speed audit doc.
- Current: OK — Accepted; matches operating practice (memory: proof-tier ladder governs cut-gate work).
- Location: OK.

### docs/adr/0018-tiered-local-model-invocation.md
- Feature: Batch / live-analysis / in-session local-model invocation tiers (epic #2177).
- If removed: cited by ADR 0019, `docs/product/features/tiered-model-invocation.md`, privacy doc.
- Current: OK — Accepted 2026-07-09, records already-locked epic decisions.
- Location: OK.

### docs/adr/0019-leave-behind-contract.md
- Feature: One-artifact-per-state-scope leave-behind (runbook) contract (epic #2281).
- If removed: `src/lib/detectors/maintenance/doc-hygiene.test.ts` and `docs/leave-behind-contract.md` + `docs/doc-hygiene-borrow-stack.md` reference it; the detector recognizes the contract it defines.
- Current: OK — Accepted; correctly documents the 0018 number collision.
- Location: OK.

### docs/plans/bundle-rearchitecture.md
- Feature: Bundle de-warping plan (epic #1852, Phases A–C).
- If removed: cited by ADRs 0014 and 0016 as "plan detail".
- Current: OK — epic #1852 still OPEN; the doc self-corrects Phase A (stale-checkout CORRECTION note) and Phase C has landed as ADR 0016; still the live plan of record.
- Location: OK.

### docs/plans/centralized-auth-design.md
- Feature: Overnight 2026-06-15 fork-list for the "centralized auth" MVP pillar.
- If removed: nothing found — no in-repo references (`grep -rln centralized-auth-design` → none); removal/archive candidate once dispositioned.
- Current: FINDING — the "pick on wake" forks were never resolved in the doc; interpretation (1)'s per-member `credentialRef` was never built (`probaitio-operator/api/v1alpha1/remotesession_types.go:44` has only `GitCredentialRef`). Abandoned plan with no disposition note — archive material.
- Location: Belongs in an archive/ or needs a status header saying which fork won.

### docs/plans/experiment-runtime-schema-v1.md
- Feature: Experiment Definition/Run/Verdict JSON schema decision record (#2592).
- If removed: sole decision record for the experiment-runtime wire contract; #2609/#2610 resolutions anchor on it.
- Current: OK — #2592 CLOSED and the 2026-07-14 addendum correctly marks which shapes #2609/#2610 supersede.
- Location: OK.

### docs/plans/history-d-session-parts.md
- Feature: `history.d/<sessionId>.jsonl` split-history file contract + merge semantics.
- If removed: `REFERENCES.md` links it as the authoritative contract; implemented by `src/lib/parse-history.ts` (+ tests).
- Current: OK — contract matches the shipped parser (part-owns-session, legacy fallback, transcript-authoritative).
- Location: OK (arguably contract-grade, could live beside REFERENCES.md, but linked from there — fine).

### docs/plans/naming-brainstorm.md
- Feature: Product naming decision — picked "Probaitio", pinned API group/operator/CLI identities.
- If removed: cited by ADR 0011 and `docs/plans/probaitio-rearchitecture.md`; it's the only record of why the name won.
- Current: OK — decision concluded and adopted (shipped `probaitio.com/v1alpha1` group). Its "downstream doc edits owed" list is done for openshift-mvp/20/30 (0 live `ClaudeCoach` refs; 00's remaining ones are historical "the old kind became" mentions).
- Location: OK.

### docs/plans/openshift-mvp/00-refined-plan.md
- Feature: Integrated build contract for the #1247 single-tenant OpenShift substrate.
- If removed: cited by ADRs 0011/0012 and probaitio-rearchitecture as implementation detail.
- Current: OK-ish — carries the "reconciled to ADR 0011" banner; ClaudeCoach mentions (lines 77, 207-211) are explicitly historical. No landed/superseded closure note, but the ADR 0011/0012 chain covers it.
- Location: OK.

### docs/plans/openshift-mvp/10-oidc-sigv4.md
- Feature: Dependency-free SigV4 artifact-blob client + image-boot CI gate design.
- If removed: only ADR 0011/0012-adjacent cross-refs; the SigV4 half has no implementation to orphan.
- Current: FINDING — presents `src/lib/s3/sigv4.ts` as the plan of record, but no SigV4 code exists anywhere (`grep -rln sigv4 src scripts` → none) and no supersession/deferral note was added; the shipped ingest went via `POST /api/ingest` push (#1563) instead.
- Location: OK (needs a status note more than a move).

### docs/plans/openshift-mvp/20-go-reconciler.md
- Feature: Operator implementation design — operator-sdk **hybrid.helm** plugin, Helm chart + thin Go reconciler.
- If removed: cited by ADR 0012's relocation note and 30-olm-bootstrap.
- Current: FINDING — the shipped `probaitio-operator/` is a plain Go controller-runtime project, not hybrid.helm (`probaitio-operator/PROJECT` plugins block lists only manifests/scorecard v2; no Helm chart dir). #1956 landed the divergent reality; this doc still reads as authoritative with no supersession note.
- Location: OK.

### docs/plans/openshift-mvp/30-olm-bootstrap.md
- Feature: OLM Classic bundle + FBC catalog + install-ordering bootstrap plan.
- If removed: companion-doc cross-refs only.
- Current: FINDING — no OLM bundle exists in `probaitio-operator/` (no `bundle/`/FBC artifacts); the MVP deployed directly in-cluster (#1559 per `overnight-mvp-status.md`). Plan unexecuted, no status/deferral note.
- Location: OK.

### docs/plans/openshift-mvp/40-same-origin-csrf.md
- Feature: Public browser write-gate CSRF design, deferred to #467 multi-tenant phase.
- If removed: reference design for #467 would be lost; nothing in code consumes it yet by design.
- Current: OK — explicitly and correctly annotated "deferred to #467; design is implementation-ready for that phase".
- Location: OK.

### docs/plans/overnight-mvp-status.md
- Feature: Resumable status log of the 2026-06-15 overnight autonomous MVP run.
- If removed: `docs/plans/centralized-auth-design.md` references it; nothing else.
- Current: FINDING — point-in-time session scratch presented as live status: "Slice 1 done + committed … NOT yet PR'd" is long resolved (#1563 CLOSED); per AGENTS.md, status files are session-scoped scratch, not durable docs. Archive material.
- Location: Belongs in an archive, not `docs/plans/`.

### docs/plans/probaitio-rearchitecture.md
- Feature: Monorepo/open-core rearchitecture plan (workspaces + Go satellite + public org repo).
- If removed: cited by `docs/audits/2026-06-codebase-audit.md`; the locked open-core/visibility decisions live only here (never "promoted to an ADR" as line 5 intends).
- Current: FINDING — content corrupted by the Probatio→Probaitio rename sweep: line 7 "renamed **Probaitio -> Probaitio**", line 23 "`probaitio.com/v1alpha1` … replaces `probaitio.com/v1alpha1`" (self-referential), lines 241-243 "`probaitio` (org) is intentional, not a typo for `probaitio`". The old name was scrubbed out of the very sentences documenting the rename, destroying their meaning. Plan also still "proposed"; repo remains a flat package (dormant, unannotated).
- Location: OK.

### docs/plans/v0.6.0-epic-map.md
- Feature: Orientation map of v0.6.0 epics and their semantic clusters.
- If removed: nothing found referencing it (`grep -rln v0.6.0-epic-map` → none); orientation artifact only.
- Current: FINDING — last touched 2026-06-26 (git log 84dab9a1) and predates the 2026-07-14 v0.6.0 refocus: no mention of the cut-gate composite (#2143/#2144 absent; only #2138 appears), so the map still reflects the reversed "Kitchen-Sink" shape.
- Location: OK, but needs a refreshed-or-superseded banner.

FINDINGS:
1. Stale "Proposed" status class (same as already-filed #2949 for ADR 0008) on four more ADRs whose decisions are implemented/enforced: 0002 (`docs/adr/0002-dynamic-recommendation-rule-engine.md:3`, #189 closed, Accepted ADR 0004 builds on it), 0003 (`docs/adr/0003-public-spa-hosting.md:3`, SPA live at coach.skrzypek.dev per ADR 0014:17), 0005 (`docs/adr/0005-recs-adoption-measurable-impact.md:3`, #573 closed, AdoptionScorecard shipped), 0009 (`docs/adr/0009-hosted-k8s-operator-dispatch-aggregation.md:3`, operator implemented in `probaitio-operator/`), 0010 (`docs/adr/0010-k8s-substrate-reuse-over-build.md:3`, enforced as standing AGENTS.md convention).
2. `docs/plans/probaitio-rearchitecture.md` corrupted by the Probatio→Probaitio rename sweep — lines 7, 23, 241-243 now read as self-referential nonsense ("renamed Probaitio -> Probaitio"; "not a typo for `probaitio`"), erasing the old name from the sentences that documented the rename.
3. `docs/plans/openshift-mvp/` 10/20/30 diverged from or were never executed by the shipped implementation with no supersession notes: 10's `src/lib/s3/sigv4.ts` was never built, 20's hybrid.helm operator shipped as plain Go controller-runtime (#1956, `probaitio-operator/PROJECT`), 30's OLM bundle path was bypassed by direct in-cluster deploy (#1559).
4. `docs/plans/overnight-mvp-status.md` presents 2026-06-15 session state as current ("NOT yet PR'd"; #1563 since closed) — session-scoped scratch that should be archived.
5. `docs/plans/centralized-auth-design.md` — the "pick on wake" forks were never dispositioned in the doc and interpretation (1) (per-member `credentialRef`) was never built (`remotesession_types.go:44` has only `GitCredentialRef`); abandoned plan, archive material.
6. `docs/plans/v0.6.0-epic-map.md` predates the 2026-07-14 v0.6.0 refocus (no cut-gate #2143/#2144; last modified 2026-06-26) and still presents the pre-refocus epic shape as current orientation.


### — group: docs-rest (108 files) —

### docs/RELEASING.md
- Feature: Release process — trunk-continuous deploy, tagged checkpoints, four published container images.
- If removed: groom-release/burn-epic release model and release-notes-backfill.md procedures lose their authority doc; AGENTS.md links it.
- Current: OK — four-image claim matches `.github/workflows/docker-publish.yml:21-30`.
- Location: OK

### docs/adding-a-recommendation.md
- Feature: Detector-authoring recipe for the recommendations engine (epic #866 auditability contract).
- If removed: AGENTS.md "Recommendations are auditable claims" and `docs-map.json` both point at it; product/README claim-discipline links it.
- Current: OK — module layout matches `src/lib/detectors/`, ADR 0002 reference intact.
- Location: OK

### docs/audits/ (family: 2026-06-app-state, 2026-06-codebase, 2026-06-v0.5.0-security-sweep, 2026-07-experiment-lifecycle-inventory, 2026-07-harness-neutral-speed-opportunities, 2026-07-portable-signal-inventory)
- Feature: Dated point-in-time audit records feeding child-issue fan-outs (the "broad audits → doc then issues" pattern).
- If removed: their child issues lose evidence backing; portable-signal-inventory is the declared input to harness-neutral-speed-opportunities; experiment-lifecycle-inventory answers #2599.
- Current: OK as a family — explicitly dated, pinned to audited SHAs; app-state and codebase audits carry 2026-07-08 correction banners (good hygiene). portable-signal-inventory has `category: audit` frontmatter; none claim present-tense currency.
  - 2026-06-app-state-audit.md — OK (corrected 2026-07-08).
  - 2026-06-codebase-audit.md — OK (pinned to master `173781b`).
  - 2026-06-v0.5.0-security-sweep.md — OK (verified against origin/master at audit time; feeds #1476/#1716).
  - 2026-07-experiment-lifecycle-inventory.md — OK (#2599 record).
  - 2026-07-harness-neutral-speed-opportunities.md — OK (#2595 wayfinder).
  - 2026-07-portable-signal-inventory.md — OK (#2598 wayfinder input).
- Location: OK — `docs/audits/` is the right home.

### docs/backlog/ingest-brevity-guidance.md
- Feature: In-repo tracking copy of backlog issue #1589 (register a prompt-brevity guide in the external-guidance pipeline).
- If removed: nothing found — removal candidate. Greps: `grep -rln "ingest-brevity\|prahladyeri" src scripts docs` hits only `src/lib/external-guidance-registry.ts` (the implementation) and the doc itself; `doc-issue-parity.test.mjs` doesn't reference `docs/backlog/`.
- Current: FINDING: obsolete — the ask is implemented (`src/lib/external-guidance-registry.ts:194-198` registers `prompt-brevity-language-efficiency` citing #1589); the doc still reads as an open ask.
- Location: `docs/backlog/` is a one-file dir duplicating GitHub-issue authority (AGENTS.md: backlog lives in issues) — fold into the issue or delete.

### docs/bundle-budget-contract.md
- Feature: Structural bundle-budget gate (ADR 0016, #1852 Phase C) documentation.
- If removed: rationale for `scripts/check-bundle-size.mjs` + `bundle-budget.json` classes lost; memory/coder guidance points here.
- Current: OK — enforcer, config, and both CI wire-ups named at head all exist.
- Location: OK

### docs/coding-agent-dashboard-cli.md
- Feature: npx `coding-agent-dashboard` launcher CLI (serve/recs/stop).
- If removed: only user doc for the published npm entry point (`package.json` `bin` → `bin/coding-agent-dashboard.mjs`).
- Current: OK — documented commands match `bin/coding-agent-dashboard.mjs:233-241` (serve/recs/stop, plus -h/-v).
- Location: OK

### docs/competitive-analysis-helmdeck.md
- Feature: Competitive note on Helmdeck (typed-tool runtime), dated 2026-06-09.
- If removed: indexed from `docs/competitive-analysis/README.md:42` via a `../` link.
- Current: OK — dated, verdict-scoped.
- Location: FINDING: belongs in `docs/competitive-analysis/` with its 30 siblings; it predates the directory and was never moved (the README's `../` link is the tell).

### docs/competitive-analysis/ (family: README, template + 28 notes)
- Feature: Durable competitive/inspiration corpus feeding positioning, moat wording, and borrow/build decisions (docs-tracking #926).
- If removed: README is the tiered index; individual notes back memory entries, positioning docs (`product/vs.md`), and issues (#1874, #1877, #1881, #2178, #2901…).
- Current: OK as a family — all notes carry Source/Date-captured headers; per-file:
  - README.md — OK (index current through the 2026-07 Phoenix/Langfuse adds); does NOT index `docs/competitive/agent-sandbox.md` (see that block).
  - template.md — OK (the capture template).
  - agent-maintenance.md / agent-maintenance-recs-vocabulary-decision.md — OK (source note + #1881 decision record pair).
  - agent-substrate.md, ax.md — OK (ADR 0009 buy-vs-build references).
  - agentsview.md, sniffly.md, vibe-log.md, headroom.md, her.md, claude-code-transcripts.md, storybloq.md, usage-monitors.md, team-observability.md, claude-howto.md, hexo-sia.md, rh-agent.md, superpowers.md, nirmata-aicontrols.md, claude-code-setup-plugin.md — OK (dated capture notes).
  - anthropic-guidance.md, anthropic-official-analytics.md, claude-code-dashboards.md — OK; the latter two carry the #2488 declared-freshness frontmatter (`freshness.warn_after: 90d` / `error_after: 180d`).
  - defending-against-the-first-party.md — OK (strategy companion).
  - code-search-graph-tools.md — OK (backs graph-tools memory / #2254).
  - phoenix.md, langfuse.md — OK (2026-07 adds, PR #2901); NOTE: these two fast-moving-threat notes lack the #2488 freshness frontmatter their siblings pioneered — worth adding, not a defect (contract is opt-in).
  - unified-agentic-memory-hooks.md — OK (TDS capture, feeds #1247/#2233).
- Location: OK (except helmdeck/agent-sandbox strays noted separately).

### docs/competitive/agent-sandbox.md
- Feature: Substrate analysis of kubernetes-sigs/agent-sandbox for the #1247 execution-substrate choice.
- If removed: referenced by sandcastle/Edera memory trail; but `grep -rn agent-sandbox docs/competitive-analysis/README.md` → no index entry.
- Current: OK content (dated 2026-06-16, explicitly "not a product competitor").
- Location: FINDING: singleton `docs/competitive/` directory shadowing `docs/competitive-analysis/`; unindexed in the README — move and index.

### docs/doc-hygiene-borrow-stack.md
- Feature: Borrow/build decision record for repo-Markdown hygiene (#2256/#2260).
- If removed: the doc-hygiene detector family (`src/lib/detectors/maintenance/doc-hygiene.ts`) loses its decision provenance.
- Current: OK — dated, pinned to `69794d2`, carries `category: doc` frontmatter.
- Location: OK

### docs/docs-map.json
- Feature: Machine-readable doc→source-symbol map powering the doc-hygiene/doc-graph detectors and repo-map join.
- If removed: hard break — consumed by `src/lib/parse-docs-map.ts`, `detectors/maintenance/doc-hygiene.ts`, `scripts/ingest.mjs`, `scripts/repo-map-generate.mjs`, and parity tests (`docs-map-parity.test.mjs`, `doc-issue-parity.test.mjs`) wired into CI.
- Current: OK — parity tests keep it honest.
- Location: OK

### docs/doctor-vs-recs.md
- Feature: Positioning note separating Claude Code `/doctor` from dashboard `/recs`.
- If removed: linked from `docs/adding-a-recommendation.md`; low blast radius otherwise.
- Current: OK.
- Location: OK

### docs/enterprise-deployment-guide.md
- Feature: Paid-pilot deployment shape for the enterprise-auth server build.
- If removed: README + `scripts/enterprise-readiness-gate.mjs` ecosystem references the enterprise doc trio; pilot operators lose the runbook.
- Current: OK — matches `DASHBOARD_AUTH_MODE=enterprise` surface in `scripts/server.mjs` / `EnterpriseAdmin.tsx`.
- Location: OK

### docs/enterprise-readiness.md
- Feature: CTO/security-review brief for the enterprise controls.
- If removed: `scripts/enterprise-readiness-gate.mjs` (+ its test) exists to keep this brief honest — the gate loses its subject.
- Current: OK — scoped to "bootstrap pilot", doesn't overclaim SaaS.
- Location: OK

### docs/enterprise-threat-model.md
- Feature: Threat model for the enterprise-auth deployment.
- If removed: security sweep (#1476) and readiness brief cite it; the trio is deliberately layered (guide=how, brief=what, model=threats) — not duplicative.
- Current: OK — explicitly scopes out SaaS multi-tenancy/OIDC.
- Location: OK

### docs/experiment-methodology.md
- Feature: Cache-confound cost-measurement method for headless `claude -p` proof experiments (#1310).
- If removed: pre-registration and proof-batch docs cite it as the shared method; receipts lose their cache-control citation.
- Current: OK.
- Location: OK

### docs/experiments/agent-team-structure-trial.md
- Feature: Run protocol + task corpus for the agent-team-structure efficacy trial (epic #2094, closes #2097).
- If removed: sub-issues #2098/#2099 lose their governing protocol (pre-registration-style artifact).
- Current: OK — v0.6.0-scoped, matches memory (#2094 rides along the cut-gate).
- Location: OK — `docs/experiments/` is the right home for run protocols.

### docs/hook-timing-spike.md
- Feature: Negative spike record: no per-tool hook timing exists in transcripts (#134).
- If removed: the "close #134 as unsupported" evidence disappears; future agents may re-run the exhaustion search.
- Current: OK — dated verdict, exhaustion evidence retained.
- Location: OK

### docs/insights-removal.md
- Feature: Degradation map + staged plan for removing the Insights feature (#1056).
- If removed: the decision record behind "Ask Claude must never impersonate `/insights`" loses its removal inventory.
- Current: OK — decision dated 2026-06, matches shipped state (no Insights view in NAV catalog).
- Location: OK

### docs/insights-trigger-spike.md
- Feature: Spike record (#265): `claude -p "/insights"` can trigger a fresh insights run.
- If removed: historical evidence only; nothing in code consumes it.
- Current: FINDING: superseded with no banner — its standing verdict "keep the Insights view and make it self-refreshing; do not retire it" (head, ~line 14) was reversed by `docs/insights-removal.md` (#1056 full removal), and neither doc cross-references the other (`grep -n "265\|spike" docs/insights-removal.md` → empty). Needs a supersession note.
- Location: OK

### docs/leave-behind-contract.md
- Feature: The leave-behind v1 runbook contract (ADR 0019, epic #2281).
- If removed: the global `runbook-autofire` Stop hook and `runbook` skill enforce exactly this contract; the enforced standard would lose its spec.
- Current: OK — pairs with `docs/adr/0019-leave-behind-contract.md` (exists).
- Location: OK

### docs/llm-usage-registry.md
- Feature: Generated inventory of every intentional Anthropic egress path (ADR 0008 governance).
- If removed: regenerated by `scripts/generate-llm-usage-registry-doc.mjs`; `npm run gate:llm-egress` (`scripts/check-llm-egress.mjs`) checks it — removal breaks the gate.
- Current: OK — carries the "generated, do not edit" banner.
- Location: OK

### docs/memory-lifecycle-schema.md
- Feature: Authoritative machine-readable contract for memory-lifecycle detectors (epic #2233, issue #2234).
- If removed: `src/lib/parse-memories.ts` detectors and the global CLAUDE.md writer-twin lose their parity anchor (parity recorded vs shpwrck/claude#160).
- Current: OK — parity record present; matches the writer-side rules in the global CLAUDE.md.
- Location: OK

### docs/mobile-parity-audit.md
- Feature: Dated desktop-vs-mobile parity verdicts for the (then-)18 nav views (#256).
- If removed: mobile-testing-rigor-spike builds on it by reference; follow-up `ui` issues cite it.
- Current: OK — point-in-time audit, findings routed to issues; view count is historical by design.
- Location: OK

### docs/mobile-testing-rigor-spike.md
- Feature: Decision record (#929): expand Playwright, don't adopt Maestro/Appium.
- If removed: the "don't relitigate" guard on mobile-CI decisions disappears.
- Current: OK — head explicitly reconciles gaps already closed by `browser-compat.yml`.
- Location: OK

### docs/mobile-visual-regression-pilot.md
- Feature: Pilot record (#1112) for opt-in screenshot snapshots outside the blocking browser-compat path.
- If removed: rationale for the non-blocking snapshot harness lost.
- Current: OK.
- Location: OK

### docs/multi-user-recommendations.md
- Feature: Analysis (#942) of which existing artifacts support team/org recommendations.
- If removed: design provenance for team-scoped recs; cited sources (`src/lib/parse-tasks.ts`, `parse-teams.ts`) both exist.
- Current: OK.
- Location: OK

### docs/openapi/openapi.yaml
- Feature: OpenAPI 3.1 contract for the server build's `/api/*` surface (formal twin of `src/lib/api-client.ts`).
- If removed: linked from `README.md:61` and `REFERENCES.md:172` as the API contract; no script/CI consumer.
- Current: OK, with a caveat: self-declared "descriptive of current behavior" and nothing gates it against `scripts/server.mjs` (no parity check found in scripts/ or CI) — silent-drift risk, matching its own "follow-up work" note.
- Location: OK

### docs/page-contracts.md
- Feature: Per-route contract-class matrix (action/evidence/raw) for the NAV_ITEMS catalog (epic #2345, issue #2350).
- If removed: `src/lib/nav-prefs.ts:170,274` points at it as the full matrix behind the in-code contract fields.
- Current: OK.
- Location: OK

### docs/perf-audit.md
- Feature: Early scoped perf + dedup audit (issue #9) with before/after bundle tables.
- If removed: historical only; authority moved to `bundle-budget-contract.md` + `perf-sprint/` gates.
- Current: OK as a dated record; do not read its bundle numbers as current (the structural budget superseded them).
- Location: OK

### docs/perf-sprint/ (family: baseline, cold-load, ingest-throughput, render-churn, repo-map, server-scale)
- Feature: Perf-sprint budget definitions + measured baselines (epics #638/#1157; issues #663-#666, #893, #1099).
- If removed: each doc is the spec for a live gate script — `scripts/cold-load-measure.mjs`, `scripts/ingest-bench.mjs`, `scripts/measure-render-churn.mjs`, `scripts/server-scale-budget.mjs` all exist; repo-map.md documents the `repo-map/cache.ts` gates.
- Current: OK as a family — budgets documented next to their runnable scripts; baselines are dated snapshots.
  - baseline.md — OK (dated cycle-1 snapshot; data shape is historical).
  - cold-load.md — OK (script names verified).
  - ingest-throughput.md — OK (2026-06-05 baseline, `npm run bench:ingest`).
  - render-churn.md — OK (#666 methodology record).
  - repo-map.md — OK (#893, ADR 0007 alignment).
  - server-scale.md — OK (#1099 gate).
- Location: OK

### docs/pitch/ai-coding-coach-red-hat.html
- Feature: One-off 470KB HTML pitch deck ("AI coding coach" for Red Hat audience).
- If removed: nothing found — removal candidate as repo content (or keep as archived collateral). Greps: `grep -rln "ai-coding-coach-red-hat" scripts .github src package.json docs` → empty.
- Current: OK as archived collateral; unverifiable claims-vs-code (binary-ish artifact) and nothing keeps it current.
- Location: Questionable — sales collateral in the code repo; an archive/ or external home would be cleaner.

### docs/plugin-mirror-README.md
- Feature: README template for the published gh-pages plugin bundle.
- If removed: `scripts/assemble-plugin-payload.mjs` (+ `plugin-mcp-payload.test.mjs`) consume it — the published bundle would ship without its README.
- Current: OK — carries the "auto-generated, do not edit here" banner for the mirror side.
- Location: OK

### docs/presentation-audit.md
- Feature: Keep/tweak/replace verdicts per data-presentation surface (issue #321).
- If removed: historical audit record; follow-ups were filed as issues.
- Current: OK as a dated record.
- Location: OK

### docs/product/ (family: README, how-it-works, privacy-and-data, reading-a-proof-receipt, vs, features/{down-modelling-confidence, human-as-free-tool, shadow-calls, tiered-model-invocation})
- Feature: Public-facing Probaitio product docs held to the auditable-claims bar.
- If removed: referenced from detector learn-more paths (`src/lib/detectors/fix-validity.ts`, `detectors/cost/automation-share.ts` grep-hit `docs/product`); the v0.6.0 positioning surface disappears.
- Current: OK as a family — the claim-discipline banner (method-before-proof) is respected; every feature page carries an explicit status banner:
  - README.md — OK (claim-discipline contract stated).
  - how-it-works.md / privacy-and-data.md — OK (local-only claims match the SPA/server split and ADR 0008 scoping).
  - reading-a-proof-receipt.md — OK (correctly gates result claims on #995).
  - vs.md — OK (positioning; consistent with competitive-analysis corpus).
  - features/down-modelling-confidence.md — OK ("in progress, epic #2138" banner).
  - features/human-as-free-tool.md — OK ("not yet groomed, epic #1934" banner).
  - features/shadow-calls.md — OK ("in progress, epic #2147" banner).
  - features/tiered-model-invocation.md — OK ("design, #2177" banner; Tier S gated on #2138).
- Location: OK

### docs/recommendation-actionability-contract.md
- Feature: UI-data → recommendation actionability contract + audit (epic #866, issue #851).
- If removed: mapped in `docs-map.json`; the wrapper sub-issues lose their governing contract.
- Current: OK.
- Location: OK

### docs/recs-adoption-receipts.md
- Feature: Spec of the append-only adoption-receipt JSONL store (SURFACED/ADOPTED kinds).
- If removed: the store's live consumers (`src/lib/adoption-scorecard.ts`, `api-client.ts`, server routes + tests) lose their format doc; the global CLAUDE.md recs hook depends on this contract.
- Current: OK — schemaVersion/kind examples match the allowlist described.
- Location: OK

### docs/release-notes-backfill.md
- Feature: Hand-written summary paragraphs for early releases shipped as raw `--generate-notes` (#716).
- If removed: one-time backfill drafts; only value is if backfill is still pending — otherwise historical.
- Current: OK as a dated procedure record; points at RELEASING.md for the current shape.
- Location: OK

### docs/reviews/ (family: actionability-review, nav-redesign-funnel, nav-redesign-outcome-first, per-view-detail, per-view-synthesis, prototype/{README, digest-led-nav.html, outcome-first-nav.html, 4 screenshots})
- Feature: The 2026-06 nav-redesign decision trail (#490): per-view actionability data → synthesis → outcome-first proposal → blind persona funnel → clickable mocks.
- If removed: provenance for the shipped digest/nav structure (`nav-prefs.ts`) and the page-contracts epic (#2345) disappears; nothing in code consumes them.
- Current: OK as a family — the chain self-documents its supersessions: actionability-review and per-view docs carry 2026-07-08 correction banners; outcome-first explicitly marks itself "refined/superseded by the funnel"; prototype/README marks `outcome-first-nav.html` superseded and `digest-led-nav.html` as the landed concept.
  - actionability-review.md — OK (corrected 2026-07-08).
  - nav-redesign-funnel.md — OK (final concept record).
  - nav-redesign-outcome-first.md — OK (self-declared superseded).
  - per-view-detail.md / per-view-synthesis.md — OK (dated snapshots; component line numbers are point-in-time, flagged as such by date).
  - prototype/README.md + 2 HTML mocks + 4 PNGs — OK (explicitly throwaway, not wired into the app).
- Location: OK

### docs/runbooks/chd-deploy-master/README.md
- Feature: Leave-behind v1 runbook for the standing local dashboard deployment (`chd-deploy-master`, port 5173).
- If removed: the runbook-autofire Stop-hook contract requires exactly this artifact per state scope; operators lose the resume map.
- Current: OK — frontmatter (`leave-behind: v1`, `status: current`) intact; container/image/port claims match the known standing instance (compose project `chd-deploy-master`, ghcr `:latest`, 5173).
- Location: OK — canonical `docs/runbooks/<state-scope>/README.md` path.

### docs/shadow-calls.md
- Feature: Operator guide for the shadow-calls experiment engine's repo-side consumer (ADR 0004).
- If removed: the deliberate engine(`~/.claude`)/consumer(repo) split loses its repo-side doc; `src/lib/parse-shadow-calls.ts` exists as claimed.
- Current: OK.
- Location: OK

### docs/ui-consistency-audit.md
- Feature: Page-header convention record (#1591/#1592) for rollout batches.
- If removed: rollout batches would re-decide the `PageTitle` h1 convention.
- Current: OK — "5 of 31 views" is the audit-time count, framed as findings.
- Location: OK

### docs/user-stories.md
- Feature: Persona/IA brainstorm that flipped the default landing route to recommendations.
- If removed: narrative provenance for the persona model; nothing consumes it.
- Current: FINDING: stale code references asserted as current — cites `src/components/Layout.tsx` (lines 10, 505) which no longer exists (layout is `PFLayout.tsx`; nav catalog is `NAV_ITEMS` in `src/lib/nav-prefs.ts`), and "eighteen top-level views" no longer matches the ~31-view catalog. Needs an as-of banner like the reviews/ docs got.
- Location: OK

### docs/v0.3-efficiency-accounting.md
- Feature: Design-draft synthesis of the efficiency-dollarization brainstorm (pre-v0.4 era anchors #724/#726/#858…).
- If removed: `v0.4-proof-engine.md` names it as its counterpart; historical strategy record.
- Current: FINDING (minor): title/filename mismatch — H1 reads "# v0.4 design — Ruthless efficiency" (line 1) in a file named `v0.3-…`; confusing when both a real v0.4 north star and this draft exist.
- Location: OK

### docs/v0.4-productization-course.md
- Feature: Productization course for the v0.4.0 milestone (#1046) — proof engine first, dashboard as data layer.
- If removed: proof-engine doc links it as the north-star→product codification.
- Current: OK — clearly milestone-scoped and dated 2026-06-10.
- Location: OK

### docs/v0.4-proof-engine.md
- Feature: v0.4 north star: the proof engine, credibility bar, epistemic boundaries.
- If removed: pre-registration, receipt reader (`product/reading-a-proof-receipt.md`), and ADR 0017 ladder all cite its sections (including a fragment link to "Epistemic boundaries").
- Current: OK.
- Location: OK

### docs/v0.4-proof-preregistration.md (+ amendments family: amendment-1-multisession, amendment-2-fixture-repair, v0.4-proof-external-review-2083.md)
- Feature: Pre-registration of record for the v0.4 proof batch (#1075/#995) plus its two signed-off amendments and the external review of the #2083 corrected-corpus NULL.
- If removed: hard break of the proof chain — receipts carry `preRegistrationRef` pointing at the pre-registration; the amendments' "by new commit only" provenance rule makes these append-only artifacts that must never be edited or deleted.
- Current: OK as a family — amendment banners are signed and dated; the external review honestly records ACCEPT-WITH-CAVEATS + underpowering; the NULL-stays-on-record discipline is explicit in Amendment 2.
- Location: OK

### docs/v0.4-time-axis.md
- Feature: Companion time-horizon strategy for the proof-engine pivot (#1050).
- If removed: proof-engine doc links it; strategy provenance only.
- Current: OK.
- Location: OK

FINDINGS:
1. `docs/insights-trigger-spike.md` — standing verdict "keep the Insights view and make it self-refreshing; do not retire it" was reversed by `docs/insights-removal.md` (#1056, full removal); neither doc cross-references the other, so the spike reads as live guidance. Add a supersession banner.
2. `docs/user-stories.md` — asserts `src/components/Layout.tsx` (lines 10, 505) and an 18-view nav as current; the file is gone (`PFLayout.tsx` / `nav-prefs.ts` NAV_ITEMS, ~31 views). Needs an as-of/correction banner like the reviews/ docs.
3. `docs/competitive/agent-sandbox.md` — stray singleton `docs/competitive/` directory shadowing `docs/competitive-analysis/`, and the note is absent from the competitive-analysis README index; move and index it.
4. `docs/backlog/ingest-brevity-guidance.md` — obsolete tracking copy: its ask is implemented (`src/lib/external-guidance-registry.ts:194-198`, entry `prompt-brevity-language-efficiency` citing #1589) but the doc still reads as an open backlog ask; also duplicates GitHub-issue authority (AGENTS.md: backlog lives in issues).
5. `docs/competitive-analysis-helmdeck.md` — location: predates and sits outside `docs/competitive-analysis/`; the README indexes it via a `../` link. Move it in with its 30 siblings.
6. `docs/v0.3-efficiency-accounting.md` — title/filename mismatch: H1 is "v0.4 design — Ruthless efficiency" (line 1) in a `v0.3-*` file, ambiguous against the real v0.4 north-star doc.
7. `docs/openapi/openapi.yaml` — no automated parity gate against `scripts/server.mjs` (no script/CI consumer found; only README/REFERENCES links), so the "descriptive of current behavior" contract can drift silently; low severity, matches its own declared follow-up gap.


### — group: fixtures (172 files) —

### fixtures/contracts/calibration-report-v1.pass.json
- Feature: Tier B local-calibration producer contract (`tier-b-calibration` v1) — the golden "pass" report shape for down-modelling calibration ingest.
- If removed: `src/lib/parse-local-calibration-producer-contract.test.ts:7` loads it by URL; that suite fails.
- Current: OK — `version: 1`, `asOf: 2026-07-01`, matches parser expectations.
- Location: OK.

### fixtures/experiment-runtime/v1/ (family: manifest.json, invalid-cases.json, verdict-corrections.json, type-witness.ts, valid/*.json — 15 files)
- Feature: Experiment-runtime contract v1 codec/schema conformance corpus — valid bundles per flow×harness (enrollment, proof-model-evaluation, race, replay, speed-background-first × claude-code/codex), mutation-derived invalid cases, and verdict corrections.
- If removed: `src/lib/experiment-runtime/contracts/v1/fixture-corpus.test.ts` (loads `manifest.json`, `invalid-cases.json`, corrections at :187-193) and `canonical.test.ts:27` (reads `valid/enrollment.claude-code.json`) fail; `tsconfig.app.json:35` explicitly includes `type-witness.ts`, so `tsc -b` breaks too. All files are regenerable via `scripts/generate-experiment-contract-fixtures.mjs` (writes every family member, :996-1015).
- Current: OK. The `sk-ant-api03-AAAA…` string in `invalid-cases.json:304` is a deliberately synthetic all-A placeholder exercising the `fingerprint.secret-like-display` rejection — not a real secret.
- Location: OK (generated artifacts colocated with their manifest; generator header comment in `type-witness.ts:1` points back).
- Files: manifest.json, invalid-cases.json, verdict-corrections.json, type-witness.ts, valid/{enrollment,proof-model-evaluation,race,replay,speed-background-first}.{claude-code,codex}.json

### fixtures/local-analyze-eval/corpus.json
- Feature: Tier A "Analyze locally" free-form vs schema-constrained repair receipt (#2725, epic #2177) — committed measurement corpus.
- If removed: `src/lib/local-analyze-eval.test.ts:246` ("committed corpus" describe) fails; `scripts/local-analyze-eval-run.mjs` loses its default `--corpus` path (:43).
- Current: OK — test asserts the corpus still shows constrained ahead of free-form (the honest direction).
- Location: OK.

### fixtures/model-eval-corpus/ (family: README.md, curated-corpus.json, structured-edit-corpus.json, oh-my-pi-NOTICE.md, structured-edit/*/{source,input,expected}.ts — 6 tasks × 3 files)
- Feature: Model-routing eval corpora (#1080 epic #975; structured-edit repair corpus #2296) — deterministic objective-gate tasks for down-modelling receipts; consumed by `src/lib/model-eval-corpus.test.ts` (byte-for-byte drift guard vs `CURATED_CORPUS` in `model-eval-corpus.ts`), `src/lib/structured-edit-eval.test.ts` (drift guard + reads each task's `input.ts`/`expected.ts` at :1427/:1475 + `noticePath: 'oh-my-pi-NOTICE.md'` at :152), and runners `scripts/model-eval-run.mjs` / `model-eval-batch.mjs` / `structured-edit-arm-run.mjs`.
- If removed: those three test suites fail (drift + per-task byte checks); removing `oh-my-pi-NOTICE.md` also drops the required MIT attribution for the adapted `can1357/oh-my-pi` benchmark (license obligation, not just a test).
- Current: OK — corpus JSONs verified against in-repo source of truth by CI drift tests; NOTICE pins the upstream commit.
- Location: OK.
- Files: README.md, curated-corpus.json, structured-edit-corpus.json, oh-my-pi-NOTICE.md, structured-edit/{authoring-candidate-gate, authoring-retry-boundary, mechanical-queue-filter, mechanical-status-transition, review-approval-gate, review-confidence-threshold}/{source,input,expected}.ts

### fixtures/model-eval-corpus/receipts/claude-haiku-4-5-2026-07-13.json (exception: no test consumer)
- Feature: First full-corpus jailed reproducibility receipt (n=6 Haiku mechanism smoke run) — evidence artifact for the structured-edit eval, cited in the family README (lines 17-22) with its `manifest_sha256` binding it to the corpus.
- If removed: no test fails — greps `grep -rln "claude-haiku-4-5-2026-07-13\|model-eval-corpus/receipts" src scripts docs .github` return nothing; only `README.md` cites it. It is provenance evidence (the "receipt" in publish-only-if-proven), not dead weight — keep, but it is code-orphaned by design.
- Current: OK — contains only model/cost/corpus-hash metadata, no PII/secrets.
- Location: OK.

### fixtures/proof/repo-map-context-waste/ (family: README.md, manifest.json, pairs/<12 pairIds>/tree/** — 12 matched-pair fixture repos, ~130 files)
- Feature: v0.4 causal-proof corpus for the #890 repo-map context-waste treatment (#1076, multi-session chains #2082) — 12 frozen matched pairs run injected-vs-withheld with deterministic gates; loaded via `src/lib/proof-fixture-pairs.ts` (declares `manifest.json` + `pairs/<pairId>/tree/` as on-disk source of truth, :9-11), tested by `proof-fixture-pairs.test.ts` + `proof-fixture-pairs.chain.test.ts`, executed by `scripts/proof-batch.mjs`.
- If removed: both proof-fixture test suites fail and `proof-batch.mjs` has no corpus; the pre-registered v0.4 proof (docs/v0.4-proof-preregistration.md, minimum N=12) becomes unrunnable.
- Current: OK — manifest `pairs` ids match the 12 on-disk dirs exactly (verified programmatically), `sessionsPerChain: 8` matches the README's amendment-1 description; trees are synthetic mini-repos (`.mjs` + `test.mjs`/`check-build.mjs` gates), no real data.
- Location: OK.
- Files: README.md, manifest.json, pairs/{config-backed-flag-rename-diff, config-backed-thresholds-bugfix, config-backed-validator-feature, high-centrality-audit-consumer, high-centrality-extend-status, high-centrality-rename-diff, high-centrality-wire-entry, stable-api-bugfix-units, stable-api-build-add-export, stable-api-codec-roundtrip, stable-api-feature-rate-format, stable-api-refactor-pure-discount}/tree/**

### fixtures/structured-edit-arm-eval/corpus.json
- Feature: EDIT-class free-form vs edit-DSL-constrained arm measurement (#2726, epic #2177) — the edit-class sibling of local-analyze-eval.
- If removed: `src/lib/structured-edit-arm-eval.test.ts` committed-corpus assertions fail; `scripts/structured-edit-arm-run.mjs` loses its default `--corpus` path (:52).
- Current: OK — `schemaVersion`/`kind`/`samples` shape matches the parser.
- Location: OK.

FINDINGS: none.


### — group: e2e-github (34 files) —

### e2e/desktop-scroll.spec.ts
- Feature: Desktop inner-scrollbar overflow gate (#764/#767) — no unintended horizontal scrollbars inside `main#main-content` at 1280px; `data-allow-x-scroll` allowlist.
- If removed: desktop-chromium project in `playwright.config.ts` (DESKTOP_SPECS/DESKTOP_ONLY regexes) loses the gate; browser-compat.yml's `npm run test:e2e` run silently shrinks — desktop table-overflow regressions ship.
- Current: OK — included via `DESKTOP_SPECS`, desktop-only via `DESKTOP_ONLY`; runs in browser-compat.yml's browser-compat job against the sample SPA bundle. Pins: content fits its card at desktop width.
- Location: OK.

### e2e/metric-overflow.spec.ts
- Feature: Metric-card value overflow/wrap gate (#769/#792/#793) — every `[data-metric-value]` stays one compact line (catches clip AND multi-line wrap that the scrollbar gate can't see).
- If removed: the `formatMetric` <=6-char compaction contract goes unguarded; runs at both widths (in `DESKTOP_SPECS`, not in `DESKTOP_ONLY`) under browser-compat.yml.
- Current: OK.
- Location: OK.

### e2e/mobile-smoke.spec.ts
- Feature: Cross-engine (Chromium+WebKit) 390px mobile layout smoke (#257/#760) — view renders non-blank, no page-level horizontal overflow, no uncaught exception; runs in browser-compat.yml via mobile-chromium/mobile-webkit projects.
- If removed: the only WebKit/Safari layout gate disappears (render-smoke covers mount crashes but not page-overflow).
- Current: FINDING — its private `SPA_VIEWS` list (e2e/mobile-smoke.spec.ts:24-47) has drifted from the nav catalog: it still enumerates retired/redirected ids (`tools`, `agents`, `workflows`, `memories`, `stats` — all in `REDIRECTED_VIEWS`, src/lib/nav-prefs.ts:658-673) and omits current reachable views (`summary`, `reclaim-compass`, `capabilities`, `doc-relationships`, `experiment-segment` — e2e/reachable-views.ts). Unlike render-smoke it does NOT import `REACHABLE_VIEWS`, and the vitest drift guard (src/lib/reachable-views.test.ts) covers only reachable-views.ts, so the mobile-overflow gate never runs on the newer views and nothing fails when this list rots further.
- Location: OK (but should consume `e2e/reachable-views.ts` instead of a second hand-rolled list).

### e2e/reachable-views.ts
- Feature: Import-free canonical list of non-server-only nav views for the Playwright specs (nav-prefs.ts can't be loaded by the Playwright ESM runner).
- If removed: render-smoke, desktop-scroll, and metric-overflow all import it (compile failure); src/lib/reachable-views.test.ts (the drift guard, run by test.yml via `npm test`) fails.
- Current: OK — includes the #2351 composites and #2323/#2351-era views; drift-guarded against NAV_ITEMS.
- Location: OK.

### e2e/render-smoke.spec.ts
- Feature: Every reachable view mounts without console.error/pageerror/error-boundary and renders non-empty `<main>` (#764/#765), via cold hash-router deep links; runs at all three projects (both widths) in browser-compat.yml.
- If removed: the "compiles + passes vitest but throws on mount" class (#677/#671 regression) ships undetected again.
- Current: OK.
- Location: OK.

### e2e/sample-data-smoke.spec.ts
- Feature: Data-bearing counterpart to render-smoke (#533) — sample banner present, curated views render a real table/chart (not an empty state), plus the #1444 sparse-validation-card assertions; desktop-chromium only.
- If removed: a parser/shape break that degrades views to "No data" placeholders passes render-smoke and ships.
- Current: OK — note it navigates legacy ids (`tools` in DATA_VIEWS at :29, `/#/prompts` at :106) which still work via `REDIRECTED_VIEWS`, so it exercises the composite tabs correctly; cosmetic, not broken.
- Location: OK.

### e2e/visual-pilot/mobile-visual-pilot.pilot.ts
- Feature: Opt-in visual-regression PILOT (#1112) — `toHaveScreenshot()` snapshots of home/sessions/tokens at 390px + 1440px against the SPA bundle.
- If removed: `npm run test:e2e:visual-pilot[:update]` scripts break; docs/mobile-visual-regression-pilot.md's harness references dangle. Deliberately NOT in any CI workflow (own config `playwright.visual-pilot.config.ts`, `.pilot.ts` extension excluded from the main config's `*.spec.ts` match) — documented as outside the blocking browser-compat path, so unwired-by-design, not a #2954-style gap.
- Current: OK.
- Location: OK.

### e2e/visual-pilot/mobile-visual-pilot.pilot.ts-snapshots/ (family: 6 PNG baselines — overview/sessions/tokens × visual-mobile-chromium/visual-desktop-chromium, linux)
- Feature: Committed screenshot baselines the pilot's `toHaveScreenshot()` compares against (3 views × 2 projects on the linux runner).
- If removed: `npm run test:e2e:visual-pilot` fails with missing-snapshot errors; regenerable via `test:e2e:visual-pilot:update` (baseline history lost).
- Current: OK — file set exactly matches PILOT_VIEWS × the two projects in playwright.visual-pilot.config.ts.
- Location: OK (Playwright's default snapshot dir convention).

### .github/ISSUE_TEMPLATE/epic.md
- Feature: Issue template scaffolding the autonomous-epic LEDGER (`/run-epic` skill + `~/.claude/playbooks/autonomous-epic-execution.md`): unit checklist, standing rules, per-unit gate.
- If removed: nothing in-repo breaks; the run-epic workflow loses its structured ledger shape (skill-side consumer, not code).
- Current: OK — note the `title: "[epic] "` prefix is specific to run-epic ledger epics and intentionally differs from the clean-title convention for groomed release epics/children (AGENTS.md); the template's own comments cover labeling.
- Location: OK.

### .github/actions/ensure-gh/action.yml
- Feature: Composite action installing `gh` root-lessly on the minimal ARC runner image (ghcr.io/actions/actions-runner ships no gh).
- If removed: backfill-release-notes, ingest-guidance, label-milestone-prs, milestone-guard, and release-gate workflows all fail at their "Ensure gh CLI" step (pages-publish-stable inlines its own copy because it needs gh pre-checkout).
- Current: OK.
- Location: OK.

### .github/release.yml
- Feature: Label-driven changelog categorization for GitHub "Generate release notes" (`gh release create --generate-notes`); excludes `meta`/`duplicate`/`invalid`/`wontfix`.
- If removed: release notes degrade to one flat "Other changes" bucket; consumed by docs/RELEASING.md flow and by label-milestone-prs.yml/backfill-release-notes.yml whose whole point is feeding these categories.
- Current: OK.
- Location: OK (GitHub-mandated path).

### .github/workflows/agent-cross-review.yml
- Feature: Cross-vendor PR review routing (#2404). Trigger: pull_request. Jobs: `detect` (vendor via co-author trailer domain), `claude-reviews-codex` (claude-code-action + always-published advisory "Claude Cross-Review" check-run/marker), `codex-reviews-claude` (PAT-authored `@codex review` comment). Advisory — never concludes failure; soft-skips green without ANTHROPIC_API_KEY / CODEX_TRIGGER_PAT.
- If removed: cross-review automation stops; the Codex merge flow loses its verdict marker (memory: codex-cross-review gotchas). Nothing hard-requires the check.
- Current: OK (uses github-script@v7 vs @v9 in notify-ready — cosmetic version skew).
- Location: OK.

### .github/workflows/backfill-release-notes.yml
- Feature: Manual (workflow_dispatch, dry-run default) regeneration of a published Release body into the #716 shape via `scripts/backfill-release-notes.mjs` (exists). One job: `backfill`.
- If removed: docs/RELEASING.md's release-notes backfill step breaks; no CI gate role.
- Current: OK. Its unit suite `test:backfill-release-notes` is one of the 17 unwired suites (#2954 — already filed).
- Location: OK.

### .github/workflows/browser-compat.yml
- Feature: PR gate running the whole main Playwright suite (all 5 specs × 3 projects) against the served `build:sample` bundle on arc-dind. Jobs: `changes` (docs-only skip), `browser-compat`.
- If removed: every e2e spec above becomes unwired — the only CI consumer of `npm run test:e2e`.
- Current: OK — script refs (`ci-docs-only.mjs`, `build:sample`, `test:e2e`) all exist. Minor stale comment: header says "setup-node@v4" while jobs use @v6 (browser-compat.yml:26).
- Location: OK.

### .github/workflows/ci.yml
- Feature: The main PR gate — jobs: `changes`, `lint` (eslint + enterprise posture/route/auth gates), `build` (tsc+vite plus ~35 contract-test steps: engine-absent, bundle budget, recharts entry-chunk, server runtime/healthcheck/hardening, recs cache/worker/SWR, repo-map, doc-* parity, push-ingest e2e...), `llm-egress`, `spa-boundary` (inbound+outbound #324 boundary + SPA budget), `bundle-report` (informational).
- If removed: nearly the entire PR quality gate disappears; AGENTS.md's merge gate names `spa-boundary` as load-bearing.
- Current: OK — cross-checked every `npm run`/`node scripts/...` step against package.json/scripts: all 40+ referenced scripts exist. (upload-artifact @v4 here vs @v7 in browser-compat — cosmetic.)
- Location: OK.

### .github/workflows/cold-load.yml
- Feature: PR cold-load budget gate (#663) — builds both SPA flavors, measures FCP/domInteractive/CLS medians via headless Chromium, gates on cold-load-budget.json. Jobs: `changes`, `cold-load` (arc-dind). Script `scripts/cold-load-measure.mjs` exists.
- If removed: byte budgets (ci.yml) remain but time-to-paint regressions ship ungated.
- Current: OK (same stale "setup-node@v4" header comment as browser-compat).
- Location: OK.

### .github/workflows/docker-publish.yml
- Feature: Publish pipeline — master push / v* tag / release / dispatch builds+pushes 4 GHCR images (server, spa, dispatch, operator-sdk) with classic builder on arc-dind; bakes doc-git-times manifest (#2707) and smoke-checks version stamp (#1604) + manifest commit binding. One job: `build-and-push`.
- If removed: no published images — `npm run deploy:pull`, the plugin/enterprise consumers, and AGENTS.md's documented rollback path all break.
- Current: OK — `scripts/docker-push-retry.sh`, `doc-git-times-generate.mjs`, both `probaitio-operator/Dockerfile*` all exist.
- Location: OK.

### .github/workflows/ingest-guidance.yml
- Feature: Weekly cron (Mon 06:17 UTC) + dispatch guidance-snapshot refresh (#1303); opens a drift PR when `data/external-guidance` changes. Jobs: `ingest`. `npm run ingest:guidance` exists.
- If removed: guidance snapshots go stale silently (the drift-guard test only validates committed content, it doesn't refetch).
- Current: OK.
- Location: OK.

### .github/workflows/label-milestone-prs.yml
- Feature: Manual dispatch backfill of domain labels onto a milestone's merged PRs (#716) so `.github/release.yml` can categorize; idempotent, dry-run input. Jobs: `label`. `scripts/label-milestone-prs.mjs` exists.
- If removed: release changelogs collapse into "Other changes"; docs/RELEASING.md references it by name.
- Current: OK. (`test:label-milestone-prs` is among the 17 unwired suites — #2954.)
- Location: OK.

### .github/workflows/milestone-guard.yml
- Feature: pull_request_target guard (#722) auto-assigning the single open release milestone on open/reopen/ready and re-checking on merge. Jobs: `ensure-milestone`. `scripts/ensure-pr-milestone.mjs` exists; memory `pr-needs-open-milestone` documents its failure mode.
- If removed: milestone-less PRs slip outside release rollups again (#717 regression class).
- Current: OK — safe pull_request_target usage (no PR-head code executed).
- Location: OK.

### .github/workflows/notify-ready.yml
- Feature: check_suite:completed handler (#277) — when the whole Actions suite is green on an open PR, add `ready-to-merge` + one marker-deduped mention comment (uses the `✓` char per repo convention).
- If removed: the hands-off burn workflow loses its durable "ready to merge" signal; nothing else depends on it.
- Current: OK.
- Location: OK.

### .github/workflows/pages-publish-edge.yml
- Feature: EDGE channel (#621) — every master push builds `build:spa` and pushes dist/ to shpwrck/claude-coach-edge gh-pages (edge-coach.skrzypek.dev) via ACTIONS_DEPLOY_KEY_EDGE, after re-running the spa-boundary forbidden-strings publish gate.
- If removed: the public edge demo freezes at its last publish.
- Current: OK.
- Location: OK.

### .github/workflows/pages-publish-plugin.yml
- Feature: PLUGIN channel (#1335) — every master push assembles the fat plugin payload (`assemble-plugin-payload.mjs`, exists), verifies the clean MCP handshake (`test:plugin-mcp-payload`), and publishes to the shpwrck/claude-history-dashboard-plugin marketplace mirror.
- If removed: `/plugin marketplace add shpwrck/claude-history-dashboard-plugin` installs a stale bundle.
- Current: OK — includes a server-flavor sanity grep so an accidental SPA build can't publish.
- Location: OK.

### .github/workflows/pages-publish-stable.yml
- Feature: STABLE channel (#621/ADR 0014) — release-published (or dispatch-by-tag) build of `build:sample` pushed to shpwrck/claude-coach-release (coach.skrzypek.dev); tag resolved pre-checkout (inline gh install), charset-validated, never falls back to a branch.
- If removed: coach.skrzypek.dev stops tracking releases.
- Current: OK.
- Location: OK.

### .github/workflows/pr-nonempty.yml
- Feature: "PR has a diff" gate (#177 / ADR 0001) — fails any PR whose three-dot diff against base is empty. One job: `non-empty-diff`. Explicitly named load-bearing in AGENTS.md's PR scope gate.
- If removed: the #115/#119 silent empty-merge failure mode returns.
- Current: OK.
- Location: OK.

### .github/workflows/release-gate.yml
- Feature: Release-cut gate — dispatch (pre-cut, intended) or v* tag push (post-hoc alarm) runs `scripts/check-release-gate.mjs` (exists) requiring the milestone's `release-gate` epics closed. Jobs: `gate`.
- If removed: docs/RELEASING.md's gating epics become guidance-only again.
- Current: OK. (`test:release-gate` is among the 17 unwired suites — #2954.)
- Location: OK.

### .github/workflows/seed-release-gates.yml
- Feature: Seed half of the two-phase gate model (#642/#721) — on milestone:created (or dispatch) idempotently seeds the standing perf/arch/security `release-gate` epics via `scripts/seed-release-gates.mjs` (exists). Jobs: `seed`.
- If removed: new milestones can start life gateless; release-gate.yml then fails at cut time instead.
- Current: OK. (`test:seed-release-gates` unwired — #2954.)
- Location: OK.

### .github/workflows/server-scale.yml
- Feature: PR server-mode large-history budget gate (#1099) — boots the real server on Node 24 (matching Dockerfile) against a synthetic corpus, gates latency/payload/retained-heap via `gate:server-scale` (exists) + server-scale-budget.json, MALLOC_ARENA_MAX=2 (#1572). Jobs: `changes`, `server-scale`.
- If removed: cold-load covers only the SPA; server dataset-route scale regressions ship ungated.
- Current: OK.
- Location: OK.

### .github/workflows/test.yml
- Feature: PR unit-test gate (#222) — `npm test` (vitest + gate-2702 node tests) plus five standalone runtime-isolation suites (server-runtime-imports, mcp-shim-isolation, plugin-mcp-payload, plugin-runtime-state, plugin-ctl). Jobs: `changes`, `test`.
- If removed: the parser layer and the zero-node_modules boot-graph contracts go ungated; also the transitive runner of the reachable-views drift guard.
- Current: OK. Workflow-side cross-check of #2954: exactly 17 `test:*` scripts have no workflow reference — my grep reproduces the count; nuance extending (not contradicting) it: `test:gate-2702-*` DO run indirectly via `npm test`'s glob, while `test:release-gate` / `test:seed-release-gates` / `test:milestone-guard` / `test:label-milestone-prs` / `test:backfill-release-notes` are the unit suites of scripts that live workflows invoke — the automation itself is CI-unguarded.
- Location: OK.

FINDINGS:
1. e2e/mobile-smoke.spec.ts:24-47 — hand-rolled `SPA_VIEWS` has drifted from the nav catalog: still lists retired/redirected ids (`tools`, `agents`, `workflows`, `memories`, `stats`; all in `REDIRECTED_VIEWS`, src/lib/nav-prefs.ts:658-673) and omits current views (`summary`, `reclaim-compass`, `capabilities`, `doc-relationships`, `experiment-segment`; e2e/reachable-views.ts), so the 390px overflow/blank-screen gate never exercises the newer views; no drift guard covers this list (src/lib/reachable-views.test.ts guards only e2e/reachable-views.ts). Fix: import `REACHABLE_VIEWS` like the other three specs.
2. Stale header comments in .github/workflows/browser-compat.yml:26 and .github/workflows/cold-load.yml:17 claim "setup-node@v4" while the jobs use actions/setup-node@v6 (cosmetic doc rot only).


### — group: operator-1 (41 files) —

All checks complete. Composing the artifact.

### probaitio-operator/.devcontainer/devcontainer.json
- Feature: Kubebuilder-scaffolded dev environment for the operator subtree (ADR 0012 MVP tooling); go + kind + docker-in-docker.
- If removed: nothing found — removal candidate for CI/runtime; only a human opening `probaitio-operator/` as a devcontainer uses it (`grep -rn devcontainer Makefile README.md .github/workflows/` → no hits).
- Current: FINDING: pins `"image": "golang:1.24"` (devcontainer.json:3) while `go.mod:3` requires `go 1.25.0` (works only via GOTOOLCHAIN auto-download) — drifted from Dockerfile's `golang:1.25`.
- Location: OK (scaffold convention).

### probaitio-operator/.devcontainer/post-install.sh
- Feature: devcontainer bootstrap — installs kind/kubebuilder/kubectl for local envtest/e2e (ADR 0012 tooling).
- If removed: only `devcontainer.json:onCreateCommand` consumes it; nothing else (`grep -rn post-install` elsewhere → no hits). Dies with the devcontainer.
- Current: OK (fetches `latest` of everything — unpinned but scaffold-standard).
- Location: OK.

### probaitio-operator/.dockerignore
- Feature: build hygiene for both operator images — excludes `bin/` from the docker context.
- If removed: `docker-publish.yml:246,276` builds (context `probaitio-operator`) ship stale local `bin/` artifacts into build context; images still build.
- Current: OK.
- Location: OK (context root).

### probaitio-operator/.github/workflows/lint.yml
- Feature: intended golangci-lint CI for the operator Go tree (ADR 0012 quality gate).
- If removed: nothing breaks — it never runs. GitHub Actions only executes workflows under the repo root `.github/workflows/`; this lives at `probaitio-operator/.github/workflows/`, so it is dead.
- Current: FINDING: CI-dark scaffold leftover; even relocated it would fail (`go-version-file: go.mod` at lint.yml:17 resolves against repo root, no `working-directory`). Confirms the known "tests are CI-dark" state — root workflows contain no `go test`/golangci job (`grep -rn "go test\|golangci" .github/workflows/` → none).
- Location: FINDING: wrong place to ever execute; a real gate needs a root-level workflow with `defaults.run.working-directory: probaitio-operator`.

### probaitio-operator/.github/workflows/test-e2e.yml
- Feature: intended kind-based e2e CI (`make test-e2e`, ADR 0012).
- If removed: nothing breaks — never triggered (nested `.github`, same as lint.yml); `make test-e2e` (Makefile:147) remains runnable locally.
- Current: FINDING: CI-dark; would also fail if moved as-is (`go mod tidy`/`make test-e2e` run from repo root, where no go.mod exists).
- Location: FINDING: same relocation note as lint.yml.

### probaitio-operator/.github/workflows/test.yml
- Feature: intended envtest unit/integration CI (`make test`, Makefile:123 — the controller suites in `internal/controller/*_test.go`).
- If removed: nothing breaks — never triggered. The controller tests (churn guard, invariants) run only when a developer runs `make test` locally.
- Current: FINDING: CI-dark; same root-cause and same would-fail-if-moved caveats as its siblings.
- Location: FINDING: same relocation note.

### probaitio-operator/.gitignore
- Feature: nested ignore for Go build/test outputs (`bin/`, `*.test`, `go.work`) — nested .gitignore is honored by git.
- If removed: `bin/` tool downloads (kustomize, controller-gen, envtest via Makefile) start showing as untracked noise in the dashboard repo; no functional break.
- Current: OK.
- Location: OK.

### probaitio-operator/.golangci.yml
- Feature: lint policy for the Go tree (ADR 0012 quality gate), consumed by `make lint` (Makefile:156).
- If removed: `make lint` falls back to golangci-lint defaults — local-only impact since lint.yml never runs; nothing in the dashboard repo reads it.
- Current: OK (v2 config, api/internal lll/dupl exclusions consistent with tree).
- Location: OK.

### probaitio-operator/Dockerfile
- Feature: the operator manager image (ADR 0012), published as `ghcr.io/shpwrck/claude-history-dashboard-operator-sdk` — this is a three-touch coupling point.
- If removed: dashboard-repo break: `docker-publish.yml:276` (`-f probaitio-operator/Dockerfile`) fails, and `config/default/kustomization.yaml:8` + `Makefile:53 IMG` point at an image that stops updating. Inside operator: `make docker-build` breaks.
- Current: OK (golang:1.25 builder matches go.mod 1.25.0; distroless nonroot; go-mod-download retry documented).
- Location: OK.

### probaitio-operator/Dockerfile.dispatch
- Feature: ADR 0009 §6 golden dispatch image (claude CLI + git + cred-sync/artifact-ship sidecar scripts), published as `…-dispatch` — second three-touch coupling point.
- If removed: dashboard-repo break: `docker-publish.yml:246` fails; operator break: `cmd/main.go` DISPATCH_IMAGE default (`…-dispatch:latest`) goes stale so RemoteSession pods run an old CLI; the classifier-drift test (`src/lib/claude-tree-classification.test.ts:5`) still passes (it imports `dispatch/artifact-ship.mjs` source, not the image).
- Current: OK (image name matches main.go default and docker-publish env; OpenShift arbitrary-UID handling documented).
- Location: OK (context = probaitio-operator/, as docker-publish expects).

### probaitio-operator/Makefile
- Feature: full operator-sdk build/test/deploy toolchain (ADR 0012): manifests/generate, envtest, kind e2e, kustomize deploy, `pull-secret` helper, bundle targets.
- If removed: all local dev + `make install`/`make deploy` (the only deploy path — no root CI does this) break inside the operator; dashboard repo unaffected (docker-publish calls `docker build` directly, not make).
- Current: OK (IMG default `ghcr.io/shpwrck/claude-history-dashboard-operator-sdk:latest` matches docker-publish.yml:30 and the config/default image pin; OPERATOR_SDK v1.42.2 matches SPRINT_STATUS).
- Location: OK.

### probaitio-operator/PROJECT
- Feature: kubebuilder/operator-sdk project manifest tracking the two scaffolded APIs (RemoteSession, DashboardInstance — ADR 0009/0012).
- If removed: future `operator-sdk create api`/`generate kustomize manifests` scaffolding breaks inside the operator; no runtime or dashboard-repo consumer.
- Current: OK (`repo: github.com/shpwrck/probaitio-operator` matches go.mod module even though the tree is vendored into this repo — intentional per SPRINT_STATUS).
- Location: OK.

### probaitio-operator/README.md
- Feature: operator operating doc (ADR 0011/0012): deploy, session-namespace secret contract (`claude-oauth`/`probaitio-ingest`), manager resource tuning.
- If removed: humans lose the only in-tree doc of the namespace-local secret contract; nothing machine-consumes it.
- Current: FINDING: still carries kubebuilder stubs `// TODO(user): Add simple overview` (README.md:2,5) and a stale prerequisite `go version v1.24.0+` (README.md:10) vs go.mod's 1.25.0 — the real custom content (secrets, resources) is appended below untouched scaffold.
- Location: OK.

### probaitio-operator/SPRINT_STATUS.md
- Feature: session-scoped progress scratch for the `feature/operator-sdk-mvp` build-out (the AGENTS.md long-loop status-file discipline).
- If removed: nothing found — removal/archive candidate. No references outside historical docs (`grep -rn SPRINT_STATUS docs/ probaitio-operator/` → only `docs/audits/2026-06-codebase-audit.md`, `docs/adr/0001…`), and project AGENTS.md explicitly says SPRINT_STATUS is not a source of truth.
- Current: FINDING: stale point-in-time scratch committed on master — describes worktree `../chd-opsdk`, "Go 1.26.4" toolchain (go.mod says 1.25.0), and a DONE list frozen mid-sprint. The module-graph "do not re-break" note is the one durable nugget; it belongs in README or an ADR.
- Location: FINDING: session scratch should not live at HEAD; fold the durable note out and drop the file.

### probaitio-operator/api/v1alpha1/dashboardinstance_types.go
- Feature: `DashboardInstance` CRD schema (ADR 0009 aggregation half / ADR 0012): dashboard Image/Host/ArtifactPVC so shipped session-data lands in a hub dashboard.
- If removed: operator break: dashboardinstance_controller.go, zz_generated.deepcopy.go, and the CRD base fail to compile/regenerate; dashboard repo unaffected at build time (it only creates CRs via kube-client.mjs at runtime).
- Current: OK.
- Location: OK.

### probaitio-operator/api/v1alpha1/groupversion_info.go
- Feature: registers `probaitio.com/v1alpha1` scheme — the group every consumer (dispatch-rbac.yaml, kube-client.mjs, CRDs) hardcodes.
- If removed: package fails to compile; everything in the operator breaks.
- Current: OK.
- Location: OK.

### probaitio-operator/api/v1alpha1/remotesession_types.go
- Feature: the core ADR 0009 `RemoteSession` contract: Mode interactive/headless, Repo/Ref, PoolSize 0..8, persisted churn-guard status (ConsecutiveFastExits/BackoffUntil per ADR 0012).
- If removed: operator ceases to exist functionally; dashboard-side, the server dispatch path that creates RemoteSession CRs (scripts/lib/kube-client.mjs) starts failing at runtime against a cluster without the type.
- Current: OK (headless mode declared-but-deferred is documented inline, matching ADR 0009).
- Location: OK.

### probaitio-operator/api/v1alpha1/zz_generated.deepcopy.go
- Feature: controller-gen DeepCopy implementations — required for the types to satisfy runtime.Object.
- If removed: compile break until `make generate` re-emits it; no other consumer.
- Current: OK (generated).
- Location: OK.

### probaitio-operator/cmd/main.go
- Feature: manager entrypoint (ADR 0012): wires both reconcilers, DistressProbe, and the dispatch config knobs (DISPATCH_IMAGE, CRED_SECRET_NAME=claude-oauth, PULL_SECRET=ghcr-pull, RECONCILER_VERSION, PROBAITIO_INGEST_URL for #1563 shipping).
- If removed: operator image has no entrypoint (Dockerfile:20 copies exactly `cmd/main.go`); dashboard repo unaffected at build time.
- Current: OK — but verified for the group question: no `driver`/`substrate` identifier exists anywhere in the Go tree (`grep -rni "driver\|substrate" --include=*.go` → zero hits), so the ADR 0013 substrate-driver seam ("the seam is the deliverable", 0013:74-76) is not realized; main.go wires RemoteSessionReconciler directly to pod construction.
- Location: OK.

### probaitio-operator/config/crd/bases/probaitio.com_remotesessions.yaml
- Feature: generated RemoteSession CRD (ADR 0009/0012), installed by `make install` / `kustomize build config/default`.
- If removed: `config/crd/kustomization.yaml:5` dangles → every kustomize deploy path breaks; regenerable via `make manifests`. Dashboard-side, clusters deployed without it reject kube-client.mjs dispatch calls.
- Current: OK (printer columns match current spec/status fields; controller-gen v0.18.0).
- Location: OK.

### probaitio-operator/config/crd/bases/probaitio.com_dashboardinstances.yaml
- Feature: generated DashboardInstance CRD (ADR 0009 aggregation).
- If removed: `config/crd/kustomization.yaml:6` dangles; regenerable via `make manifests`.
- Current: OK.
- Location: OK.

### probaitio-operator/config/crd/kustomization.yaml
- Feature: CRD layer of the kustomize deploy (ADR 0012), consumed by `config/default/kustomization.yaml` (`- ../crd`).
- If removed: `make install` and `kustomize build config/default` break.
- Current: OK (webhook patches correctly still commented — no webhooks exist).
- Location: OK.

### probaitio-operator/config/crd/kustomizeconfig.yaml
- Feature: kustomize name/namespace substitution rules for CRD conversion webhooks.
- If removed: nothing breaks today — its only reference (`configurations:` in crd/kustomization.yaml:16-17) is commented out. Dormant scaffold, kept for the day webhooks are enabled.
- Current: OK.
- Location: OK.

### probaitio-operator/config/default/cert_metrics_manager_patch.yaml
- Feature: optional cert-manager-backed metrics TLS (scaffold).
- If removed: nothing breaks — its only reference (default/kustomization.yaml:69) is commented out. Dormant scaffold; standard kubebuilder practice to keep.
- Current: OK.
- Location: OK.

### probaitio-operator/config/default/kustomization.yaml
- Feature: THE deploy overlay (ADR 0011/0012): namespace `probaitio-operator-system`, namePrefix, image pin to the published GHCR operator-sdk package (#1251), and the active patch set (metrics, pull-secret, ingest, resources).
- If removed: `make deploy` breaks entirely; dashboard-side, kube-client.mjs's fallback namespace `'probaitio-operator-system'` (scripts/lib/kube-client.mjs:67-69) is the convention this file defines — the third three-touch coupling.
- Current: OK.
- Location: OK.

### probaitio-operator/config/default/manager_image_pull_secret_patch.yaml
- Feature: `ghcr-pull` imagePullSecret on the manager so the private GHCR operator image pulls (paired with `make pull-secret`).
- If removed: manager pod ImagePullBackOff on clusters where the package is private; operator-internal only.
- Current: OK (secret name matches Makefile pull-secret target and main.go PULL_SECRET default).
- Location: OK.

### probaitio-operator/config/default/manager_ingest_patch.yaml
- Feature: #1563 session-data shipping wiring — sets PROBAITIO_INGEST_URL (conventional in-cluster DashboardInstance Service) that the operator passes to each pod's artifact-ship sidecar.
- If removed: shipping silently disabled cluster-wide (main.go: empty ingest-url disables shipping, claim-labeling still runs) — sessions stop appearing in the hub dashboard; no build break anywhere.
- Current: OK (token-never-in-manager-env design matches README's secrets section).
- Location: OK.

### probaitio-operator/config/default/manager_metrics_patch.yaml
- Feature: enables secure metrics on :8443 (default in main.go is `0` = disabled).
- If removed: metrics endpoint off; metrics_service.yaml/prometheus monitor point at nothing. Operator-internal.
- Current: OK (active at default/kustomization.yaml:47).
- Location: OK.

### probaitio-operator/config/default/manager_resources_patch.yaml
- Feature: manager resource defaults (10m/64Mi req, 500m/128Mi lim) as an overlay-overridable patch, documented in README "Manager resource tuning".
- If removed: manager deploys with the scaffold manager.yaml resources; README section goes stale. Operator-internal.
- Current: OK (values match README exactly).
- Location: OK.

### probaitio-operator/config/default/metrics_service.yaml
- Feature: controller-manager metrics Service (8443), the target of prometheus/monitor.yaml.
- If removed: ServiceMonitor selector matches nothing; kustomize build still succeeds minus the Service. Operator-internal.
- Current: OK (referenced at default/kustomization.yaml resources).
- Location: OK.

### probaitio-operator/config/dispatch-rbac.yaml
- Feature: ADR 0009 dashboard-dispatch least-privilege (Slice 1): SA `probaitio-dashboard` + Role limited to `remotesessions` CRUD + status read — deliberately standalone (not in config/default, so un-prefixed) for direct `oc apply`.
- If removed: dashboard-repo break at runtime: the in-cluster dashboard's kube-client.mjs dispatch calls lose their RBAC — session dispatch from the dashboard 403s. Operator itself unaffected.
- Current: OK (group/resource names match the CRDs; no-pods/no-secrets posture matches ADR 0009).
- Location: OK (standalone-on-purpose is documented in its header).

### probaitio-operator/config/manager/kustomization.yaml
- Feature: manager layer indirection (2 lines) consumed by `config/default` (`- ../manager`).
- If removed: `kustomize build config/default` breaks.
- Current: OK.
- Location: OK.

### probaitio-operator/config/manager/manager.yaml
- Feature: the scaffold manager Deployment/Namespace (restricted PSS securityContext, `image: controller:latest` rewritten by the default overlay's image pin, leader election).
- If removed: no manager Deployment renders — deploy path gone.
- Current: OK.
- Location: OK.

### probaitio-operator/config/manifests/kustomization.yaml
- Feature: OLM bundle manifest assembly (operator-sdk `make bundle` path) — unused by the actual GHCR/kustomize deploy flow.
- If removed: only `make bundle` breaks; nothing in the deploy or dashboard path consumes it.
- Current: FINDING (minor): references `bases/probaitio-operator.clusterserviceversion.yaml` (line 4) but `config/manifests/bases/` does not exist — as checked in, `kustomize build config/manifests` fails; it self-heals only because `make bundle` runs `operator-sdk generate kustomize manifests` first, which would create it.
- Location: OK.

### probaitio-operator/config/network-policy/allow-metrics-traffic.yaml
- Feature: optional NetworkPolicy gating /metrics to `metrics: enabled` namespaces (ADR 0010's "reuse NetworkPolicy" posture, scaffold-provided).
- If removed: nothing breaks — the layer is commented out at default/kustomization.yaml:41. Dormant scaffold.
- Current: OK.
- Location: OK.

### probaitio-operator/config/network-policy/kustomization.yaml
- Feature: 2-line resource list for the dormant network-policy layer.
- If removed: nothing breaks (layer not referenced anywhere active).
- Current: OK.
- Location: OK.

### probaitio-operator/config/prometheus/kustomization.yaml
- Feature: optional ServiceMonitor layer (metrics scraping).
- If removed: nothing breaks — `- ../prometheus` is commented out at default/kustomization.yaml:34. Dormant scaffold.
- Current: OK.
- Location: OK.

### probaitio-operator/config/prometheus/monitor.yaml
- Feature: ServiceMonitor for the manager metrics Service (dormant with its layer).
- If removed: nothing breaks today.
- Current: OK (scaffold TODO about insecureSkipVerify is upstream-standard, acceptable while dormant).
- Location: OK.

### probaitio-operator/config/prometheus/monitor_tls_patch.yaml
- Feature: cert-manager TLS hardening patch for the ServiceMonitor.
- If removed: nothing breaks — doubly dormant (referenced only by the commented patches block in prometheus/kustomization.yaml:8-11, inside an already-disabled layer).
- Current: OK.
- Location: OK.

### probaitio-operator/config/rbac/dashboardinstance_admin_role.yaml
- Feature: convenience ClusterRole (`*` on dashboardinstances) for cluster admins to delegate — scaffold-generated, "not used by the project itself" per its header.
- If removed: `config/rbac/kustomization.yaml:30` dangles (fix = drop the line); no runtime consumer found in either repo.
- Current: OK.
- Location: OK.

### probaitio-operator/config/rbac/dashboardinstance_editor_role.yaml
- Feature: convenience editor ClusterRole for dashboardinstances (same scaffold family).
- If removed: `config/rbac/kustomization.yaml:31` dangles; no other consumer.
- Current: OK.
- Location: OK.

FINDINGS:
1. All three operator CI workflows (`probaitio-operator/.github/workflows/{lint,test,test-e2e}.yml`) are dead: GitHub Actions only executes root-level `.github/workflows/`, and no root workflow runs go test/golangci — the operator's envtest suites and lint gate are fully CI-dark. Even relocated they'd fail (go.mod/working-directory resolved from repo root).
2. ADR 0013's substrate-driver seam does not exist in code: `grep -rni "driver|substrate" --include=*.go probaitio-operator/` returns zero hits; `cmd/main.go` wires RemoteSessionReconciler straight to pod construction. ADR 0013 (Accepted) states "we build the driver interface plus that one reference implementation" (docs/adr/0013:74-76) — doc/code drift.
3. `probaitio-operator/SPRINT_STATUS.md` is stale mid-sprint session scratch committed on master (worktree `../chd-opsdk`, "Go 1.26.4" vs go.mod 1.25.0); AGENTS.md itself disclaims SPRINT_STATUS as source of truth. Extract the module-graph "do not re-break" note, then remove.
4. `probaitio-operator/README.md` retains kubebuilder `// TODO(user)` stubs (lines 2,5) and a stale `go version v1.24.0+` prerequisite (line 10) vs go.mod's 1.25.0.
5. `probaitio-operator/.devcontainer/devcontainer.json:3` pins `golang:1.24`, below go.mod's `go 1.25.0` (works only via GOTOOLCHAIN auto-download).
6. Minor: `probaitio-operator/config/manifests/kustomization.yaml:4` references `bases/probaitio-operator.clusterserviceversion.yaml`, which is absent from the tree — `kustomize build config/manifests` fails as checked in (self-heals only through `make bundle`'s generate step).


### — group: operator-2 (40 files) —

### probaitio-operator/config/rbac/dashboardinstance_viewer_role.yaml
- Feature: Kubebuilder-scaffolded helper ClusterRole — read-only access to DashboardInstance CRs for human/monitoring users.
- If removed: nothing in-tree consumes it beyond `config/rbac/kustomization.yaml:29`; cluster admins lose the pre-baked viewer grant. Aggregate helper roles (admin/editor are part 1's files) stay coherent only as a set.
- Current: OK (standard scaffold; verbs match CRD).
- Location: OK.

### probaitio-operator/config/rbac/dispatch_role.yaml
- Feature: Least-privilege Role for session-pod sidecars — cred-sync writes back the `claude-oauth` Secret; artifact-ship self-labels its pod `claimed` (#1563).
- If removed: cred-sync.mjs gets 403 on Secret PATCH (token rotation lost across pod recycles) and artifact-ship can't set the claim label, breaking refill-on-claim.
- Current: OK — verbs match sidecar behavior; multi-tenant caveat (#467) is documented inline.
- Location: OK.

### probaitio-operator/config/rbac/dispatch_role_binding.yaml
- Feature: Binds the dispatch Role to the `probaitio-dispatch` session-pod ServiceAccount.
- If removed: sidecar SA has no permissions — same breakage as removing dispatch_role.yaml.
- Current: FINDING (shared with pod.go, see FINDINGS 1): `config/default` `namePrefix: probaitio-operator-` renders SA/Role/Binding as `probaitio-operator-probaitio-dispatch` (verified via `kubectl kustomize config/default`), but `internal/controller/pod.go:210` hardcodes `ServiceAccountName: "probaitio-dispatch"` — session pods reference a nonexistent SA under a stock `make deploy`.
- Location: OK.

### probaitio-operator/config/rbac/dispatch_service_account.yaml
- Feature: The SA every single-use remote-control session Pod runs as (no auto-mounted token; cred-sync gets a projected one).
- If removed: pod creation fails at admission (`serviceAccountName: probaitio-dispatch`, pod.go:210).
- Current: FINDING — same name-prefix mismatch as the binding (see FINDINGS 1).
- Location: OK.

### probaitio-operator/config/rbac/kustomization.yaml
- Feature: Assembles all operator RBAC (manager, leader-election, dispatch trio, metrics, CRD helper roles) into `config/rbac`, consumed by `config/default/kustomization.yaml:26` (`- ../rbac`).
- If removed: `make deploy`/`make install` loses all RBAC — operator unauthorized for everything.
- Current: OK; well-commented, resource list matches directory contents (admin/editor files are in part 1's group).
- Location: OK.

### probaitio-operator/config/rbac/leader_election_role.yaml
- Feature: Scaffolded namespace Role for controller-manager leader election (leases/configmaps/events).
- If removed: manager with `--leader-elect` crash-loops on lease RBAC denial.
- Current: OK (configmaps rule is stock kubebuilder v4 scaffold, harmless).
- Location: OK.

### probaitio-operator/config/rbac/leader_election_role_binding.yaml
- Feature: Binds leader-election Role to the `controller-manager` SA.
- If removed: same as above.
- Current: OK (subject namespace `system` is rewritten by the kustomize namespace transformer).
- Location: OK.

### probaitio-operator/config/rbac/metrics_auth_role.yaml
- Feature: ClusterRole letting the manager do TokenReview/SubjectAccessReview for the authn/authz-protected `/metrics` endpoint.
- If removed: metrics endpoint auth fails; e2e `should ensure the metrics endpoint is serving metrics` (test/e2e/e2e_test.go:173) breaks.
- Current: OK.
- Location: OK.

### probaitio-operator/config/rbac/metrics_auth_role_binding.yaml
- Feature: Binds metrics-auth-role to the controller-manager SA.
- If removed: same as metrics_auth_role.yaml.
- Current: OK.
- Location: OK.

### probaitio-operator/config/rbac/metrics_reader_role.yaml
- Feature: ClusterRole granting `get /metrics` to scrapers; e2e creates a binding to it (`metricsRoleBindingName`, test/e2e/e2e_test.go:42).
- If removed: e2e metrics test fails; Prometheus scraping has no ready-made grant.
- Current: OK.
- Location: OK.

### probaitio-operator/config/rbac/remotesession_admin_role.yaml
- Feature: Scaffolded helper ClusterRole — full control of RemoteSession CRs for delegating admins.
- If removed: only `config/rbac/kustomization.yaml:32` consumes it; convenience grant lost, nothing functional breaks.
- Current: OK.
- Location: OK.

### probaitio-operator/config/rbac/remotesession_editor_role.yaml
- Feature: Scaffolded helper ClusterRole — CRUD on RemoteSession CRs without RBAC control.
- If removed: kustomization ref only; convenience grant lost. Note the dashboard's own dispatch grant is the separate `config/dispatch-rbac.yaml`, not this.
- Current: OK.
- Location: OK.

### probaitio-operator/config/rbac/remotesession_viewer_role.yaml
- Feature: Scaffolded helper ClusterRole — read-only RemoteSession access.
- If removed: kustomization ref only; convenience grant lost.
- Current: OK.
- Location: OK.

### probaitio-operator/config/rbac/role.yaml
- Feature: The controller-gen-generated manager ClusterRole — the operator's actual permissions (CRs + status/finalizers, pods, pods/log, nodes, services, deployments, OpenShift routes).
- If removed: manager loses all API access; every reconcile fails.
- Current: OK — verified in sync with the `+kubebuilder:rbac` markers in `remotesession_controller.go:37-42` and `dashboardinstance_controller.go:53-59` (incl. `nodes` for distress.go and `pods/log` for podlog.go).
- Location: OK (generated; edit markers, not this file).

### probaitio-operator/config/rbac/role_binding.yaml
- Feature: ClusterRoleBinding of manager-role to the controller-manager SA.
- If removed: same as role.yaml.
- Current: OK.
- Location: OK.

### probaitio-operator/config/rbac/service_account.yaml
- Feature: The controller-manager ServiceAccount the operator Deployment runs as.
- If removed: deploy fails (Deployment references SA; e2e asserts `probaitio-operator-controller-manager`, test/e2e/e2e_test.go:37).
- Current: OK.
- Location: OK.

### probaitio-operator/config/samples/kustomization.yaml
- Feature: Sample-CR index consumed by `operator-sdk generate bundle` (manifests.sdk plugin in PROJECT) for the OLM bundle's alm-examples.
- If removed: `make bundle` loses its sample CRs; `kubectl apply -k config/samples` stops working.
- Current: OK.
- Location: OK.

### probaitio-operator/config/samples/probaitio_v1alpha1_dashboardinstance.yaml
- Feature: Sample DashboardInstance CR for smoke-applies and bundle examples.
- If removed: samples kustomization breaks (it lists this file); bundle example lost.
- Current: OK-but-thin — still the raw scaffold stub (`spec:` + `# TODO(user): Add fields here`) even though DashboardInstanceSpec has real fields (image/host/artifactPVC/resources, api/v1alpha1/dashboardinstance_types.go:28-51). Empty spec is valid (all fields optional/defaulted) so it works, but it demonstrates nothing — contrast the RemoteSession sample, which was updated. Doc-staleness, not a defect.
- Location: OK.

### probaitio-operator/config/samples/probaitio_v1alpha1_remotesession.yaml
- Feature: Sample RemoteSession CR; demonstrates the spec.resources tuning path (#1717).
- If removed: samples kustomization breaks; bundle example lost.
- Current: OK (updated past the scaffold stub).
- Location: OK.

### probaitio-operator/config/scorecard/bases/config.yaml
- Feature: Base operator-sdk scorecard Configuration (empty stage) that the patches append tests to.
- If removed: `make bundle` / `operator-sdk scorecard` config generation breaks (scorecard.sdk plugin registered in PROJECT).
- Current: OK (stock scaffold).
- Location: OK.

### probaitio-operator/config/scorecard/kustomization.yaml
- Feature: Composes base + basic/olm scorecard patches into the bundle's `tests/scorecard/config.yaml`.
- If removed: scorecard config missing from generated bundles; no in-tree CI consumes it (`.github/workflows` runs lint/test/test-e2e only), so impact is bundle-tooling-only.
- Current: OK.
- Location: OK.

### probaitio-operator/config/scorecard/patches/basic.config.yaml
- Feature: Adds the `basic-check-spec` scorecard test.
- If removed: scorecard basic suite drops out of the bundle config; nothing else consumes it.
- Current: OK (scorecard-test image pinned v1.42.2, consistent across both patches).
- Location: OK.

### probaitio-operator/config/scorecard/patches/olm.config.yaml
- Feature: Adds the five OLM scorecard tests (bundle validation, CRD validation/resources, spec/status descriptors).
- If removed: OLM scorecard suite lost from generated bundles; no other consumer.
- Current: OK.
- Location: OK.

### probaitio-operator/dispatch/artifact-ship.mjs
- Feature: Session-data shipper sidecar (ADR 0009 §3, #1563) — ships each session pod's `~/.claude` artifacts to the dashboard push-ingest endpoint and self-labels the pod `probaitio.com/claimed=true` (refill-on-claim signal).
- If removed: `Dockerfile.dispatch:22` COPY fails; pod.go:161 launches a missing binary — session ingestion and warm-pod claim detection both die.
- Current: OK — zero-dep, env contract documented, token via `PROBAITIO_INGEST_TOKEN` (post-#2067 shape); tested indirectly via remotesession_controller_test.go:150-197.
- Location: OK.

### probaitio-operator/dispatch/cred-sync.mjs
- Feature: OAuth credential write-back sidecar (ADR 0012 D1) — persists refreshed `.credentials.json` into the source Secret so the next dispatch starts from the latest token.
- If removed: `Dockerfile.dispatch:18` COPY fails; pod.go:128 launches missing script — OAuth refresh-token rotation is lost across pod teardown, sessions eventually fail auth.
- Current: OK — mtime-gated sync, SIGTERM flush, matches dispatch_role.yaml verbs (get/update/patch).
- Location: OK.

### probaitio-operator/go.mod
- Feature: Go module definition for the operator (`github.com/shpwrck/probaitio-operator`), pinning controller-runtime v0.21.0 / k8s.io v0.33.0 / go 1.25.
- If removed: nothing builds — every `make` target and CI job dies.
- Current: OK — version set is internally coherent (c-r 0.21 ↔ k8s 1.33); note module path repo `shpwrck/probaitio-operator` doesn't exist as its own repo (tree lives inside claude-history-dashboard), which is fine for a non-published module.
- Location: OK.

### probaitio-operator/go.sum
- Feature: Dependency checksum lockfile paired with go.mod.
- If removed: `go build`/CI fail on missing sums.
- Current: OK.
- Location: OK.

### probaitio-operator/hack/boilerplate.go.txt
- Feature: License header template for controller-gen codegen (`Makefile:112` `object:headerFile="hack/boilerplate.go.txt"`).
- If removed: `make generate` fails.
- Current: OK.
- Location: OK.

### probaitio-operator/internal/controller/dashboardinstance_controller.go
- Feature: Reconciles DashboardInstance → single-replica dashboard Deployment + Service + OpenShift Route (the aggregator the provisioning card fronts). Route handled as unstructured to avoid an openshift/api dependency.
- If removed: no in-cluster dashboard provisioning; cmd/main.go setup and dashboardinstance_controller_test.go fail to compile.
- Current: OK — RBAC markers (lines 53-59) match config/rbac/role.yaml; 4Gi default resources per #1605 covered by tests.
- Location: OK.

### probaitio-operator/internal/controller/dashboardinstance_controller_test.go
- Feature: envtest specs for DashboardInstance reconcile + resource defaulting/override (#1605).
- If removed: CI `make test` loses regression coverage for the dashboard Deployment shape.
- Current: OK.
- Location: OK.

### probaitio-operator/internal/controller/distress.go
- Feature: Cluster-health probe (node NotReady/pressure, session-pod cap) that flips the global `distress` flag so the RemoteSession reconciler stops creating pods when the fragile single-node hub is loaded; fail-safe to distress when node reads fail.
- If removed: churn safety loses its cluster-level yield signal; remotesession_controller.go's `distress.Load()` branch and the `nodes` RBAC marker become dangling.
- Current: OK.
- Location: OK.

### probaitio-operator/internal/controller/invariants.go
- Feature: Single source of truth for churn-safety constants (create rate bucket, pod caps, fast-exit backoff/quarantine, labels) per MVP plan §9.
- If removed: remotesession_controller.go, pod.go, distress.go all fail to compile — every safety bound disappears.
- Current: OK — constants match documented rationale; labels consumed consistently (PoolLabel/SessionLabel/ClaimedLabel).
- Location: OK.

### probaitio-operator/internal/controller/pod.go
- Feature: Builds the single-use session Pod: remote-control container + cred-sync and artifact-ship native sidecars, restricted securityContext, projected-token isolation, activeDeadline.
- If removed: RemoteSession reconciler cannot create session pods at all.
- Current: FINDING — line 210 hardcodes `ServiceAccountName: "probaitio-dispatch"`, but the kustomize `namePrefix: probaitio-operator-` (config/default/kustomization.yaml:17) renders the SA as `probaitio-operator-probaitio-dispatch` (confirmed via `kubectl kustomize config/default`), so a stock `make deploy` yields session pods rejected at admission for a missing SA. Either the dispatch SA trio must be prefix-exempt (as `config/dispatch-rbac.yaml` deliberately is — its header comment even says "standalone … so it is not name-prefixed") or the name must be configurable/prefixed in code.
- Location: OK.

### probaitio-operator/internal/controller/podlog.go
- Feature: Bounded pods/log scrape (client-go, not cached client) that extracts the `claude.ai/code` registration URL from remote-control output for RemoteSession status.
- If removed: users never get the session join link; `pods/log` RBAC marker dangles.
- Current: OK — tail/byte/timeout bounds; regex robust to log decoration.
- Location: OK.

### probaitio-operator/internal/controller/remotesession_controller.go
- Feature: Core reconciler — churn-safe warm pool of single-use `claude remote-control` pods: duration-based fast-exit detection, backoff/quarantine, cluster cap, distress yield, refill-on-claim, registration-URL surfacing.
- If removed: the entire remote-session product path dies.
- Current: OK — headless mode explicitly deferred (line 53); RBAC markers consistent with role.yaml.
- Location: OK.

### probaitio-operator/internal/controller/remotesession_controller_test.go
- Feature: envtest specs for reconcile + session-pod shape: container trio, resource defaults/overrides (#1717), member attribution (#1999), ingest wiring + token-secret reference (#2000/#2067).
- If removed: CI loses the only regression net over pod.go's security/wiring invariants.
- Current: OK — note it asserts container names, not the SA name, which is why FINDINGS 1 is invisible to tests.
- Location: OK.

### probaitio-operator/internal/controller/suite_test.go
- Feature: Ginkgo/envtest bootstrap for the controller package (CRDs from config/crd/bases, envtest binary autodiscovery).
- If removed: both controller test files cannot run.
- Current: OK (stock kubebuilder v4 shape).
- Location: OK.

### probaitio-operator/test/e2e/e2e_suite_test.go
- Feature: e2e suite bootstrap — builds/loads the manager image into Kind, optional cert-manager install; run by `.github/workflows/test-e2e.yml` via `make test-e2e`.
- If removed: e2e CI job dies.
- Current: OK (scaffold; `projectImage example.com/probaitio-operator:v0.0.1` is Kind-local only, intentional).
- Location: OK.

### probaitio-operator/test/e2e/e2e_test.go
- Feature: e2e specs — manager deploys and runs; protected metrics endpoint serves via token + curl pod.
- If removed: no cluster-level smoke of deploy manifests (the only place the rendered config/default is exercised).
- Current: OK as far as it goes — still the stock manager/metrics scaffold; it never creates a RemoteSession/DashboardInstance CR, so rendered-manifest bugs like FINDINGS 1 pass e2e. Coverage gap, not stale content.
- Location: OK.

### probaitio-operator/test/utils/utils.go
- Feature: e2e helpers — Run/command plumbing, Kind image load, cert-manager and Prometheus-operator install/uninstall, metrics token helpers.
- If removed: both e2e files fail to compile.
- Current: OK (Prometheus helpers currently uncalled — standard scaffold spares for the commented-out `../prometheus` overlay).
- Location: OK.

FINDINGS:
1. Deploy-rendered dispatch ServiceAccount name mismatch: `internal/controller/pod.go:210` hardcodes `ServiceAccountName: "probaitio-dispatch"`, but `config/default/kustomization.yaml:17` (`namePrefix: probaitio-operator-`) renders `config/rbac/dispatch_service_account.yaml` / `dispatch_role.yaml` / `dispatch_role_binding.yaml` as `probaitio-operator-probaitio-dispatch` (verified with `kubectl kustomize config/default`). Under a stock `make deploy`, session-pod creation is rejected at admission (SA not found) — or, if the unprefixed SA was hand-created on the live cluster, it silently runs with no bound Role, breaking cred-sync write-back and claim-labeling. The repo already knows the pattern: `config/dispatch-rbac.yaml` is deliberately kept standalone "so it is not name-prefixed"; the dispatch trio needs the same treatment or a configurable/prefixed name in pod.go. Neither envtest (asserts container names only) nor e2e (never creates a RemoteSession) catches this.


### — group: periphery (27 files) —

### deploy/arc/README.md
- Feature: CI runner pool operations — source of truth for the ARC (actions-runner-controller) scale sets that host ALL GitHub Actions CI (spoke + hub clusters), incl. hub bring-up runbook.
- If removed: operators lose the only documented install/apply commands and the `runs-on`→file map; every workflow depends on the installs it describes (all 29 `runs-on:` lines across 20 workflows target `arc-runner-set`/`arc-dind`).
- Current: OK — table (min/max, scale-set names, chart 0.14.2) matches all four values files; "hub is opt-in, no workflow targets it" verified (no workflow uses `arc-runner-set-hub`/`arc-dind-hub`).
- Location: OK.

### deploy/arc/controller-values.yaml
- Feature: Helm values for the shared ARC controller (`arc` in `arc-systems`), both clusters — OpenShift restricted-SCC hardening.
- If removed: controller reinstall/upgrade becomes irreproducible (values previously lived only in-cluster, per its own header); referenced by README apply commands.
- Current: OK.
- Location: OK.

### deploy/arc/dind-scale-set-values.yaml
- Feature: Spoke `arc-dind` privileged Docker-in-Docker scale set for docker-publish, cold-load, browser-compat jobs (`runs-on: arc-dind` in 3 workflows).
- If removed: image publishing and browser CI jobs have no runner definition to reproduce; docker-publish.yml:41, cold-load.yml:66, browser-compat.yml:74 target it.
- Current: OK — overlay2 rationale, digest pin, and job list all match reality.
- Location: OK.

### deploy/arc/hub/dind-scale-set-values.yaml
- Feature: Hub-cluster opt-in sibling of `arc-dind` (`runs-on: arc-dind-hub`).
- If removed: hub dind capacity (#2440/#2441) unreproducible; no workflow targets it yet (opt-in by design), so removal only forfeits standby capacity.
- Current: OK — verified in sync with spoke (same dind digest, same template) as its header requires.
- Location: OK.

### deploy/arc/hub/runner-scale-set-values.yaml
- Feature: Hub-cluster opt-in restricted runner set (`runs-on: arc-runner-set-hub`).
- If removed: same as above — standby hub capacity only; no workflow targets it yet.
- Current: OK — pins `runnerScaleSetName`, min 0 / max 6 matches README.
- Location: OK.

### deploy/arc/runner-scale-set-values.yaml
- Feature: Spoke `arc-runner-set` — the DEFAULT scale set carrying the bulk of CI (26 of 29 `runs-on:` lines: ci/test/pr-nonempty/pages-publish-*/release-gate/etc.).
- If removed: the definition of the runner pool every required check runs on is unreproducible — highest-blast-radius file in the group.
- Current: FINDING — stale header at deploy/arc/runner-scale-set-values.yaml:6-7: "The minimal runner image ships no Node/gh, so workflows add actions/setup-node and the .github/actions/ensure-gh installer" — but the template's runner container is the baked `chd-ci-runner` image whose Dockerfile bakes Node 22.22.3 + gh 2.94.0 precisely because the stock image ships none. Comment describes the pre-baked-image era.
- Location: OK.

### deploy/arc/runner-image/Dockerfile
- Feature: Baked `chd-ci-runner` CI runner image (Node + gh + Playwright browsers pre-installed) used by all four scale sets.
- If removed: the reference copy for the in-cluster build vanishes; buildconfig.yaml's inlined copy would drift with nothing to sync against.
- Current: OK — PLAYWRIGHT_VERSION=1.60.0 matches package-lock.json resolved `@playwright/test` 1.60.0 (package-lock.json:861); inlined buildconfig copy verified command-identical.
- Location: OK.

### deploy/arc/runner-image/buildconfig.yaml
- Feature: OpenShift ImageStream + BuildConfig that builds `chd-ci-runner` in-cluster (Dockerfile inlined to avoid a git source secret).
- If removed: no reproducible path to rebuild the runner image both scale-set templates pull (`image-registry…/arc-runners/chd-ci-runner:latest`).
- Current: OK — inline dockerfile in sync with the sibling Dockerfile (same digest, ARGs, RUN steps).
- Location: OK.

### data/external-guidance/ (family: README.md + 3 snapshot JSONs)
- Feature: Committed external-guidance snapshots powering recommendation "Learn More" attachments (evidence-backed citations, epic #866).
- If removed: `src/lib/external-guidance-registry.ts` (ids at :164/:173/:198 match the 3 files exactly) and the registry/snapshot coverage + drift-guard tests fail; consumers are compile-time, not runtime fetches.
- Current: OK — regenerable: generator is `scripts/ingest-guidance.mjs` (`npm run ingest:guidance`), auto-refreshed weekly by `.github/workflows/ingest-guidance.yml`; freshest fetchedAt 2026-07-11, oldest (anthropic-usage-limits) 2026-06-12 = 40 days, under the 45-day stale flag.
- Location: OK.

### data/proof-receipt-draft.json
- Feature: Sidecar draft receipt from a `scripts/proof-batch.mjs` run — the input to `--finalize` so external review needn't re-run the experiment.
- If removed: nothing breaks — only writer is proof-batch.mjs:733 (regenerates on every non-dry run); only reader is `--finalize` (proof-batch.mjs:419), which takes an explicit path.
- Current: FINDING (minor) — the committed draft (repo-map-context-waste, no `externalReviewRef`) is already finalized: both `data/proof-receipts.jsonl` entries carry the same `experimentRef` with externalReviewRef set (#1078 and docs/v0.4-proof-external-review-2083.md). The committed copy is spent residue; harmless but stale.
- Location: OK (data/ is where the generator writes it).

### data/proof-receipts.jsonl
- Feature: Append-only finalized proof receipts (v0.4 receipt-or-null publish gate) — feeds shadow-calls provenance cells.
- If removed: `scripts/ingest.mjs:452` (PROOF_RECEIPTS_PATH) and `src/lib/parse-shadow-calls.ts:1490/1506` lose their (source, axis) provenance fold (#2151); the repo-map-context-waste null verdict evidence disappears from the product surface.
- Current: OK — 2 records, both with externalReviewRef; generator `scripts/proof-batch.mjs` appends (not regenerable — it is the durable record, correctly committed).
- Location: OK.

### tools/cloud-capture/README.md
- Feature: Docs for the cloud/workstation transcript-publishing hook (central git hub, native `projects/<slug>/<id>.jsonl` layout).
- If removed: install/env-var contract (CLAUDE_HUB_TOKEN handling, pinned-path security rationale) undocumented; REFERENCES.md:109 points here.
- Current: OK — matches install.sh/publish-claude.sh behavior incl. the no-path-probing security design (#1430).
- Location: OK.

### tools/cloud-capture/install.sh
- Feature: Installer that copies publish-claude.sh into a repo's or user's `.claude/hooks/` and registers Stop/SessionEnd hooks.
- If removed: `src/lib/cloud-capture-hook.test.ts:20` fails (tests the installer directly, incl. idempotent re-registration at :855); documented install path breaks.
- Current: OK — pinned-flavor hook command (no runtime path probing) as documented.
- Location: OK.

### tools/cloud-capture/publish-claude.sh
- Feature: The publisher itself — hook mode + `--sync` batch mode; scrub/dedup/push with inline credential helper (token never in .git/config).
- If removed: `src/lib/cloud-capture-hook.test.ts:19` fails (extensive behavior tests); any deployed hook copies orphaned with no upstream.
- Current: OK.
- Location: OK.

### bin/coding-agent-dashboard.mjs
- Feature: npm-bin CLI (`npx coding-agent-dashboard serve|recs|stop`) — thin launcher for the published container image + statusline recs printer; part of the vendor-neutral rename (README.md:33).
- If removed: `package.json` `bin` entry (line 9) dangles, `scripts/recommendations-statusline.test.mjs:138` fails, `docs/coding-agent-dashboard-cli.md` orphaned.
- Current: OK.
- Location: OK.

### commands/dashboard.md
- Feature: The `/dashboard` Claude Code plugin command (start/status/stop via `plugin-ctl.mjs`).
- If removed: plugin loses its primary command; `pages-publish-plugin.yml:13` ships `commands/` in every mirror-repo publish; referenced `scripts/plugin-ctl.mjs` exists.
- Current: OK.
- Location: OK (plugin payload expects it at repo root).

### .claude/agents/data-pipeline.md
- Feature: Repo-local component-owner subagent (parsers + detectors, one owner so output-shape changes don't drift).
- If removed: harness-only loss — Claude Code sessions in this repo lose the spawnable owner; no code/CI consumer (greps of docs/, scripts/*.test.mjs found none).
- Current: OK — scope matches real dirs (`src/lib/parse-*.ts`, detectors).
- Location: OK.

### .claude/agents/env-skills.md
- Feature: Component-owner subagent for the `~/.claude` environment tree (explicitly a different repo, shpwrck/claude).
- If removed: same harness-only loss.
- Current: OK — correctly flags the cross-repo boundary, matching the meta-issue mirror convention.
- Location: OK (arguably duplicates `~/.claude`-side ownership, but keeping the spawn definition where sessions run is defensible).

### .claude/agents/operator.md
- Feature: Component-owner subagent for the `probaitio-operator/` Go/k8s sub-repo; encodes the ADR 0010 reuse-over-build default.
- If removed: harness-only loss.
- Current: OK — `probaitio-operator/` exists at repo root.
- Location: OK.

### .claude/agents/server-api.md
- Feature: Component-owner subagent for server.mjs / ingest / `/api/*` / api-client seam.
- If removed: harness-only loss.
- Current: OK.
- Location: OK.

### .claude/agents/spa-frontend.md
- Feature: Component-owner subagent for the React SPA, enforcing spa-boundary + bundle budget.
- If removed: harness-only loss.
- Current: OK.
- Location: OK.

### .claude/settings.json
- Feature: Repo-local Claude Code settings — pins repo sessions to `claude-opus-4-8[1m]` (repo pin wins over saved default, deliberate per project practice).
- If removed: repo sessions fall back to the user/global default model.
- Current: OK on the pin; note `switchModelsOnFlag` is not a settings key I can trace to any harness doc or repo consumer (grep finds no reader) — possible no-op key, unverifiable from this checkout so not counted as a defect.
- Location: OK.

### .claude-plugin/marketplace.json
- Feature: Marketplace manifest so `/plugin marketplace add shpwrck/claude-history-dashboard-plugin` resolves (source `.` = mirror-repo root).
- If removed: marketplace install path breaks; shipped by `pages-publish-plugin.yml:12` on every master push; exercised by `scripts/plugin-mcp-payload.test.mjs`.
- Current: OK.
- Location: OK.

### .claude-plugin/plugin.json
- Feature: Plugin manifest — inline `mcpServers` (mcp-shim.mjs), plugin identity/metadata for the published bundle.
- If removed: plugin uninstallable; `scripts/mcp-shim-isolation.test.mjs:78-108` and `scripts/plugin-mcp-payload.test.mjs:159` fail; pages-publish payload incomplete.
- Current: version `0.3.3` vs package.json `0.5.0` — skew already filed as #2950 (not refiled). Otherwise OK; `repository` pointing at the `-plugin` mirror repo is intentional (that repo is the install source).
- Location: OK.

FINDINGS:
1. deploy/arc/runner-scale-set-values.yaml:6-7 — stale header claims the runner image "ships no Node/gh" requiring setup-node/ensure-gh, but the template runs the baked `chd-ci-runner` image that bakes Node 22.22.3 + gh 2.94.0 (deploy/arc/runner-image/Dockerfile); comment predates the baked image and misleads anyone tuning the scale set.
2. data/proof-receipt-draft.json — committed draft is spent residue: its experimentRef is already finalized twice in data/proof-receipts.jsonl (externalReviewRef #1078 and docs/v0.4-proof-external-review-2083.md), so the committed copy with empty externalReviewRef is stale; harmless (regenerated by every proof-batch run) but should be gitignored or removed from tracking.
3. (already filed #2950 — not refiled) .claude-plugin/plugin.json version 0.3.3 lags package.json 0.5.0.
