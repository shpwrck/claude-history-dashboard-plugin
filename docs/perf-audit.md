# App perf + dedup audit

Issue #9 — scoped audit + a small batch of focused fixes (no sweeping refactor).

## 1. Bundle profile (gzipped)

Source: `npx vite build` output.

### Before

| Chunk                              | Raw     | Gz       |
| ---------------------------------- | ------- | -------- |
| `index-*.js` (entry)               | 225 kB  | **70.41 kB** |
| `recharts-*.js`                    | 374 kB  | 109.02 kB    |
| `Recommendations-*.js`             | 30 kB   | 9.64 kB      |
| `Insights-*.js`                    | 17 kB   | 4.99 kB      |
| `TokenUsage-*.js`                  | 16 kB   | 3.92 kB     |
| `ErrorRetry-*.js`                  | 12 kB   | 2.86 kB     |
| `AgentSkill-*.js`                  | 12 kB   | 2.70 kB     |
| (other per-view chunks)            | …       | …            |
| **Total JS**                       | ~770 kB | ~226 kB      |

### After (this PR)

| Chunk                              | Raw     | Gz           | Delta vs before |
| ---------------------------------- | ------- | ------------ | --------------- |
| `index-*.js` (entry)               | 202 kB  | **63.83 kB** | **−6.58 kB gz** |
| `recharts-*.js`                    | 374 kB  | 109.02 kB    | 0               |
| `Recommendations-*.js`             | 30 kB   | 9.67 kB      | +0.03           |
| `Insights-*.js`                    | 17 kB   | 4.99 kB      | 0               |
| `TokenUsage-*.js`                  | 16 kB   | 3.93 kB      | +0.01           |
| `parse-tools-*.js` (new)           | 5.15 kB | 1.99 kB      | new chunk       |
| `parse-errors-*.js` (new)          | 4.54 kB | 1.75 kB      | new chunk       |
| `parse-agents-*.js` (new)          | 3.91 kB | 1.31 kB      | new chunk       |
| `parse-sessions-*.js` (new)        | 3.59 kB | 1.44 kB      | new chunk       |
| `parse-permissions-*.js` (new)     | 3.55 kB | 1.59 kB      | new chunk       |
| `parse-runtime-events-*.js` (new)  | 2.65 kB | 1.11 kB      | new chunk       |
| `parse-timeline-*.js` (new)        | 2.06 kB | 0.83 kB      | new chunk       |
| `parse-utils-*.js` (new)           | 0.25 kB | 0.19 kB      | new chunk       |

Net change on the **hot path** (entry chunk + Insights, the default view): the
~10 kB raw of session/upload parsers no longer ship in the entry chunk; they're
fetched only when the user opens the Upload modal. The Insights chunk itself is
prefetched in parallel with the dataset fetch so first paint of the default
view is not gated on a cold-start lazy import.

Dataset payload: removed the unused `titles` top-level map from
`/api/dataset.json`. Title is already inlined on each derived entry
(`entries[i].title`), so the duplicate field saved both bytes-on-the-wire and a
second source of truth for the same data.

## 2. Duplication audit

I cross-referenced `StatCard` labels across every view. Findings:

### Hard duplicates (same label, same data, ≥2 views)

| Stat                       | Appears in                                       | Proposed canonical home                       |
| -------------------------- | ------------------------------------------------ | --------------------------------------------- |
| **Sessions Analyzed**      | `ToolUsage`, `CostAttribution`, `ContextHealth`  | OK to keep — each view answers a question about its own filtered subset (tool-data sessions vs. token-data sessions). Not a true dupe; the underlying count differs. |
| **Total Est. Cost**        | `CostAttribution`, `ContextHealth`               | Canonical home is `TokenUsage` (`Est. Cost`) + `CostAttribution`. `ContextHealth` uses it as a denominator for "Context-read cost (% of total spend)"; keep it inline there because removing it would orphan the percentage. |

### Soft duplicates (different label, overlapping signal)

| Stat                                        | Locations                                                                       | Note |
| ------------------------------------------- | ------------------------------------------------------------------------------- | ---- |
| Session count                               | `Layout` header (`N sessions`), `UsageStats` (`Total Sessions`), `ContextHealth` (`Sessions Analyzed`), `ToolUsage` (`Sessions Analyzed`) | `Layout` header is the canonical global; view-level "Sessions Analyzed" is the *filtered* count for that view's source. Keep both. |
| Token totals (input/output/cache)           | `TokenUsage` (per-bucket cards) only                                            | Canonical home `TokenUsage`. Other views correctly refer to *derived* totals (total cost, cache hit rate) rather than the raw bucket counts. |
| Cost                                        | `TokenUsage` (`Est. Cost`), `CostAttribution` (`Total Est. Cost`), `Recommendations` (`Recoverable Spend`) | All three are intentional and answer different questions: total / attributed-by-tool / addressable. Not a dupe. |

### Wire-level duplication

| Field                                                | Status                  | Action                                                  |
| ---------------------------------------------------- | ----------------------- | ------------------------------------------------------- |
| `titles` (top-level map on `/api/dataset.json`)      | Unused by client; duplicates `entries[i].title` | **Removed** in this PR. |
| Parser modules eagerly imported in `App.tsx`         | Only used inside upload handlers; loaded on every page-load | **Now lazy** (this PR). |

**Conclusion**: the surface-level "same stat in multiple places" complaint
mostly resolves to *different filtered counts under similar labels* rather than
true duplication. The single concrete wire dupe (`titles`) is now gone. The
deeper question — whether the 17 nav views can be consolidated into fewer
landing surfaces — is out of scope for a perf pass and is left to follow-up.

## 3. What this PR changed

1. **`src/App.tsx` — lazy parsers.** The seven session/history parser modules
   (`parse-tools`, `parse-errors`, `parse-agents`, `parse-permissions`,
   `parse-runtime-events`, `parse-timeline`, `parse-sessions`) were eagerly
   imported at the top of `App.tsx` even though they only run inside
   `handleSessionFiles` (i.e. when the user uploads files). The `/api/dataset.json`
   path the dashboard actually uses doesn't touch them. They now load via
   `Promise.all([import(...), ...])` inside the upload handler so they live
   in their own chunks. Entry chunk: **70.41 → 63.83 kB gz** (−9.3%).
2. **`src/App.tsx` — Insights prefetch.** Added a fire-and-forget
   `import('./components/Insights')` next to the on-mount `reloadFromDisk()`
   call, so the default view's chunk downloads in parallel with the dataset
   fetch rather than serially after it.
3. **`scripts/ingest.mjs` — drop `titles` from dataset payload.** Title is
   already inlined into each derived entry, making the separate map redundant.
   One field gone, one less source of truth.

## 4. Punted to follow-up

Out of scope for a small perf pass; worth tracking:

- **Recharts chunk (109 kB gz).** Still the heaviest dep by far. Worth
  investigating whether the small/simple charts (heatmap, pie) can be replaced
  by hand-rolled SVG to keep recharts off the critical path entirely. Currently
  loaded only when a chart view opens, but every chart view drags it in.
- **`Recommendations` chunk (9.67 kB gz).** The `recommendations.ts` lib is
  839 lines. Could likely be sub-split by category (cost / context / safety /
  reliability) and lazy-loaded per recommendation surface.
- **Nav consolidation.** 17 nav items is a lot; many overlap conceptually
  (`Cost` + `Tokens` + `Context Health` all answer cost-shaped questions).
  Merging would naturally remove the soft-duplicate stat cards. Needs design,
  not a perf patch.
- **Dataset payload size.** For users with many large sessions, the dataset
  JSON can grow unbounded. A streaming/paginated endpoint or per-section
  endpoints would help — but it's already brotli-compressed and ETag-cached on
  the server, so this is a "later" concern.

---

## 5. #328 re-measurement — recharts vs. the cold-load critical path

Issue #328 asked to audit and reduce app bundle / runtime weight, with the
recharts chunk and view lazy-loading specifically called out. The groomed
acceptance was **measure-first**: only land a change if recharts is actually on
the initial critical path; if it's already off-path, document the finding and
make no speculative change.

### Measurement (`npx vite build`, this branch)

| What | Value |
| --- | --- |
| Entry chunk `index-*.js` (raw / gz) | ~250 kB / **~78 kB gz** |
| recharts chunk `BarChart-*.js` (raw / gz) | 338 kB / **~101 kB gz** |
| Chunks preloaded by `dist/index.html` on cold load | **only** `index-*.js` |
| recharts preloaded on cold load? | **No** |
| Default landing view | `recommendations` (lazy + prefetched via `App.tsx`) |
| Does `Recommendations.tsx` import a chart? | **No** |
| `grep recharts dist/assets/index-*.js` | **no match** (entry is clean) |

### Finding

recharts is **already off the cold-load critical path.** `App.tsx` wraps every
view in `React.lazy`, the default Recommendations view pulls no chart, and
`index.html` preloads only the entry chunk. This is the state #160 established
by *removing* the `manualChunks` rule (see the chunking note in
`vite.config.ts`) — the recharts chunk now buckets behind `AccessibleChart`,
which is itself behind a dynamic import. First paint fetches the entry
(~78 kB gz) + CSS (~9 kB gz) + the lazy Recommendations chunk; recharts
(~101 kB gz) loads only when a user first opens a chart view.

**No app-code change is warranted** — a speculative refactor here would move no
real number and risk re-introducing the #160 regression.

### What this PR does instead: lock in the win

The #160 result was protected only by a prose "sanity check" comment in
`vite.config.ts`. This PR codifies it as a CI guard: a step in the `build` job
(`Assert recharts stays off the entry (cold-load) chunk`) greps the emitted
entry chunk and fails the build if `recharts` reappears there. So a future eager
chart import or chunking regression fails CI loudly instead of silently
re-bloating first paint.

The genuine remaining reductions (replacing simple charts with hand-rolled SVG
to drop recharts entirely; sub-splitting `recommendations.ts`) are already
tracked in §4 above and remain follow-ups — they are larger design changes, not
this measure-first pass.
