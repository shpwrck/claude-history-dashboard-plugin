# Adding a recommendation detector

The recommendations engine turns each computed *signal* (cache hit rate,
native-tool bypass, dangerous commands, …) into a ranked, actionable
`Recommendation`. This guide is the recipe for adding a new one.

The engine is **pure** (`buildRecommendations(input, now)` depends only on its
argument) and **static** — the set of detectors is fixed at build time with
hand-written imports, no runtime rule store (see
[ADR 0002](./adr/0002-dynamic-recommendation-rule-engine.md)).

## The module layout

```
src/lib/detectors/
  types.ts        # Recommendation / RecommendationInput / Detector  (leaf — no engine imports)
  shared.ts       # thresholds, severity scaling, live-settings + CLAUDE.md helpers
  index.ts        # the static barrel: export const DETECTORS: Detector[]
  <category>/<id>.ts   # one file per detector — the ONLY place a recommendation lives
src/lib/recommendations.ts   # buildRecommendations + the assembleRecommendationInput
                             # mapper + per-project attribution helpers; re-exports
                             # the types/helpers for back-compat
```

Every recommendation is a per-file detector under `detectors/<category>/`. As of
#507 there are no more "legacy in-file rules" — the 20 that used to live in
`recommendations.ts` were ported into the catalog, so `buildRecommendations` now
loops only `DETECTORS`. `recommendations.ts` holds engine plumbing
(`buildRecommendations`, `assembleRecommendationInput`, the attribution helpers)
and the back-compat re-exports — no rule bodies.

Import direction is a DAG (`types ← shared ← detectors/* ← index ← recommendations`),
so detector files never import `recommendations.ts` — that is what keeps the
graph cycle-free. Import types from `../types`, helpers from `../shared`, and
parsers/pricing from `../../parse-*` / `../../pricing`.

> **Back-compat:** the barrel array is `DETECTORS`; `NEW_DETECTORS` remains
> exported as an alias (`export const NEW_DETECTORS = DETECTORS`) for older
> importers. Prefer `DETECTORS` in new code.
>
> **Dual-emit detectors:** a detector's `id` MUST equal the id its rule emits,
> with two documented exceptions whose single rule body branches into a second
> id — `safety.dangerous-bypass` (also emits `safety.dangerous-commands`) and
> `reliability.api-errors` (also emits `reliability.rate-limits`). These are
> kept as ONE detector each; the registry self-test allowlists their alternates.

## Recipe

### 1. Is the data already in `RecommendationInput`?

`RecommendationInput` already carries `tokenData`, `toolData`, `sessions`,
`projects`, `permissionRows`, `apiErrors`, `liveConfig`, `assistantFeatures`,
`timelines`, `agentSettings`, `attribution`, `runtimeEvents`,
`toolInventories`, and optional organization aggregates such as
`organizationIdentity` and `reviewEvents`. If your signal derives from one of
these (directly, or via an existing `parse-*.ts` function you call inside the
rule), **skip to step 2** — no plumbing needed.

If you need a brand-new data source, how you wire it depends on its shape:

**A per-session signal** (parsed from a session transcript) is a ONE-file change
(#524). Add a descriptor to `SESSION_SIGNALS` (`src/lib/signals/index.ts`,
`makeSessionSignals`) with its `column`, `parse`, `aggregate`, and `datasetKey`.
That single entry drives — with no other edits — the parse, the JSON
persistence, the `content_hash`, the SQLite column + additive migration
(`src/lib/signals/schema.ts`), the `assembleDataset()` read-back, AND the
`RecommendationInput` field at the ingest call site (the ingest builder spreads
every signal `datasetKey` into the engine input). The only other step:

1. Add the matching **optional** field to `RecommendationInput` in
   `src/lib/detectors/types.ts` (optional so existing fixtures and call sites keep
   compiling; `undefined` must mean "emit nothing"). This is the type contract the
   detector reads; `assembleRecommendationInput()` passes it through automatically
   (it spreads — it does not re-list fields).

**A non-signal source** — a derived aggregate (`sessions`/`projects`, grouped
from `entries`) or `liveConfig` (assembled apart from the per-session blobs) —
still takes the manual path: add the optional field to `RecommendationInput`,
then supply it explicitly where the input is built — `assembleRecommendations` in
`scripts/ingest.mjs` and, if the client view needs parity, the props in
`src/components/Recommendations.tsx` (threaded from `src/App.tsx`).

Any signal already in the dataset (see [`REFERENCES.md`](../REFERENCES.md)) needs
**no new server-side computation** — it is already computed at ingest.

### 2. Write the detector

Create `src/lib/detectors/<category>/<id>.ts`:

```ts
import type { Detector } from '../types';
import { claudeMdMarksApplied, fmtUsd, MIN_SAVINGS_USD } from '../shared';

// CLAUDE.md suppression markers — only if the fix targets CLAUDE.md (#173).
const MARKERS = {
  headings: [/^##\s+Web-search discipline\b/i],
  bodyPhrases: ['Prefer web_fetch for stable URLs'],
};

export const detector: Detector = {
  id: 'cost.web-search-spend',          // MUST equal the id the rule emits
                                        // (except documented dual-emit detectors)
  category: 'cost',
  dataDeps: ['tokenData', 'liveConfig'], // documentation/introspection only
  rule(input) {
    if (claudeMdMarksApplied(input.liveConfig, MARKERS)) return null; // self-suppress
    // …compute the signal from input…
    const savings = 0;
    if (savings < MIN_SAVINGS_USD) return null;  // gate on a noise floor
    return {
      id: 'cost.web-search-spend',
      category: 'cost',
      severity: 'info',
      title: '…',
      detail: '…concrete numbers…',
      action: '…what to do…',
      estSavingsUsd: savings,
      view: 'cost',
      fix: { target: 'CLAUDE.md', label: '…', note: '…', snippet: '…', appliedMarkers: MARKERS },
    };
  },
};
```

Rules:

- **Respect the [`/doctor` boundary](./doctor-vs-recs.md).** Do not add detectors that reimplement Claude Code `/doctor`'s live host probes or self-fix surface; keep recommendations artifact-backed and recommend-only.
- **Return `null` for "nothing worth saying"** — never a zero-impact finding.
- **Gate on a minimum effect size** (`MIN_SAVINGS_USD`, an affected count, …).
- **Use `estSavingsUsd` for ranking; use `savingsAttribution` for calibration.**
  A plain detector estimate is Tier 0 and may leave `savingsAttribution`
  undefined. When a detector can name the measured intervention, the observable
  signature, and either a before/after comparison or controlled ablation, attach
  `savingsAttribution` with the appropriate tier:
  - `tier-0-estimate` — heuristic or model-swap estimate only.
  - `tier-1-before-after` — observed baseline vs comparison window.
  - `tier-2-ablation` — controlled replay/ablation result.
  Keep `estSavingsUsd` as the stable ordering value until ranking semantics are
  intentionally changed; `realizedSavingsUsd` is evidence metadata, not an
  automatic replacement for ranking.
- **Only emit a `fix` when a genuine snippet exists** — never fabricate a config
  key. If your fix is real, wire **self-suppression** so it stops nagging once
  applied: `claudeMdMarksApplied(...)` for CLAUDE.md prose fixes, or
  `permissionsContain(...)` / a settings-key check for `settings.json` fixes
  (ADR 0002 §1/§3).
- **Keep CLAUDE.md `appliedMarkers` specific.** Marker coverage is only an
  honest lower bound when unrelated prose cannot accidentally suppress a
  finding. Every CLAUDE.md prose fix must declare at least one anchored heading
  regex (for example `/^##\s+Web-search discipline\b/i`) and distinctive
  `bodyPhrases` entries of four or more words. Do not use bare common words or
  tiny phrases like `cache`, `error`, `/clear`, or `prefer web_fetch`; use text
  that appears in the pasted snippet and would be unlikely to exist by accident.

### 3. Register it

In `src/lib/detectors/index.ts`, add the import and append it to its category
group in `DETECTORS`:

```ts
import { detector as webSearchSpend } from './cost/web-search-spend';
export const DETECTORS: Detector[] = [/* …cost group… */ webSearchSpend /* … */];
```

The emit order of `DETECTORS` is load-bearing: `buildRecommendations` evaluates
detectors in array order, then stable-sorts by (severity → estimated savings →
affected count), so for equal-priority ties the surfaced order is the array
order. Append new detectors to the relevant section rather than reshuffling
existing entries.

### 4. Test it (red → green)

Add a test to `src/lib/recommendations.test.ts` (or a co-located test). Assert it
**fires** on a triggering input and **stays silent** below the gate / when its
fix is already applied. Use the `baseInput(...)` helper there.

### 5. Gate

```
npm run lint && npx vite build && npx vitest run
```

`npm run build` (type-checks + bundles, #978). The server also imports the engine
through the Node TS loader, so a quick server-path check is worthwhile:
`curl -s http://127.0.0.1:<port>/api/recommendations.json` returns 200 and your
`id` appears when the threshold is met.

## Auditability contract (required)

A recommendation is an **auditable product claim**, not vibes or generic advice —
agents consume `/api/recommendations.json` as operating guidance via `/recs`, so a
false claim or an unsafe copy-paste fix directly erodes trust (epic #866; the
2026-06-10 audit, #1049). Every new or changed detector must hold to this:

- **Evidence-backed and reproducible.** State the concrete numbers behind the
  finding and cite the artifact/parsed field they came from. Prefer attaching a
  structured `provenance` (`RecProvenance` in `detectors/types.ts`, validated by
  `detectors/provenance.ts`): observed facts each citing their source, the
  inference kept separate, and an `asOf` date for time-derived data. Migrated
  detectors go on the `PROVENANCE_DETECTORS` allowlist so the contract test
  enforces shape.
- **Fix snippets are a product surface — declare how safe they are.** Set
  `fixKind` (`detectors/types.ts`): `'validated'` (default) is copy-paste-safe
  self-contained config; `'illustrative'` is a template the user must adapt (a
  hook running their own `npm run …`); `'manual'` depends on an external tool
  (e.g. a `claude-team` CLI). A `validated` snippet must pass
  `validateFixSnippet` (`detectors/fix-validity.ts`) — no non-portable external
  reference. The UI only offers one-click copy for `validated` fixes.
- **Don't phrase history as current state.** If the signal is historical or
  derives from a timestamped/stale artifact, demote present-tense wording
  ("is/this week/currently") to "as of \<date\>" or suppress until refreshed, and
  reconcile against current `liveConfig` before asserting a present-tense action
  (see `activity-trend`, `hook-errors`, `idle-mcp-tools`, #1102).
- **Keep the JSON export strict-parser-valid.** Any served/exported body goes
  through `safeJsonStringify` (`src/lib/json-safe.ts`, #1104) so lone surrogates
  don't break strict consumers.
- **Declare your proof posture ([ADR 0017](./adr/0017-proof-tier-ladder-and-premise-gate.md)).**
  Set `claimClass` and `proofTier` (`detectors/types.ts`). An `'accounting'`
  claim *measures what happened* ("you re-paid $X") — its proof is the arithmetic
  on the cited artifact, so it sits at `proofTier:'accounting'` and needs no
  experiment. A `'causal'` claim asserts a counterfactual ("doing X *will* reduce
  your cost"); it may assert that cost win above the `'accounting'` tier only when
  it carries the matching backing — `'observational'` (shadow-calls / replay /
  on-real-history A-B) or `'causal-proof'` (a pre-registered jailed matched-pair
  fixture batch + external review). Default to `'accounting'`; never phrase a
  measurement as a proven causal saving. The heavyweight `'causal-proof'` tier is
  **rationed**: promote a claim to it only when `value(certainty) > cost(proof)`
  **and** the pattern fires on real history with a material **`premiseUsdPerMo`**
  — no priced premise, no full proof (the #890/#2083 lesson: a NULL on a $0/mo
  pattern is wasted spend). When a causal question "can't be measured at this
  scale," retarget the apparatus at a naturally-large, priced pattern rather than
  inflating fixtures to clear the MDE.

### Tests these require

Beyond fires/stays-silent, a detector touching the above must test: evidence /
provenance shape (if on the allowlist), stale-data demotion **and** suppression,
fix-snippet validity (validated passes the gate; templates/external are
non-validated), and false-positive guards for any honest-language signal. These
run in the standard `npx vitest run` gate.
