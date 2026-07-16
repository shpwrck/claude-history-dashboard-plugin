# Decision: the seven maintenance surfaces as a recs grouping vocabulary

Evaluation of issue #1881 (epic #1910). Source framework: the *AI Agent
Maintenance* essay, captured in
[`agent-maintenance.md`](./agent-maintenance.md), which proposes a seven-surface
maintenance taxonomy — **Job, Diet, Memory, Tools, Reach, Proof, Value**.

The ask: should the recommendation engine adopt those seven surfaces as the
grouping/labeling vocabulary for the Recommendations view, in place of (or
alongside) "the current workflow/context/reliability/safety axes"?

## Decision

**Partial-map. Reject as a replacement vocabulary; adopt as a narrative /
positioning lens only.**

- Keep the engine's existing `RecCategory` data taxonomy and the `ActionDomain`
  presentation grouping unchanged. Do **not** relabel detectors or re-group the
  Recommendations view by the seven surfaces.
- Adopt the surface vocabulary as a **documentation and marketing lens** — a
  legible way to *describe* what the engine already measures to a non-engineer
  audience — and as a **gap checklist** that points at existing epic members.
- Per the issue's own guard ("this is evaluation-first; do not refactor the rec
  category model before the mapping is agreed"), this note ships the mapping; no
  engine or UI code changes.

## Why the premise needed correcting first

The issue and the essay both describe the engine as having "workflow / context /
reliability / safety axes." That is no longer the live model. Two distinct,
already-shipped taxonomies exist:

1. **`RecCategory`** (`src/lib/detectors/rec-enums.ts`, re-exported by
   `src/lib/detectors/types.ts`) — the *data* taxonomy each detector tags itself
   with. Nine canonical values, not four:
   `cost`, `context`, `workflow`, `safety`, `security`, `reliability`, `speed`,
   `activity`, `maintenance`. Maintenance is live: the registry includes
   `maintenance.memory-hygiene`, `maintenance.doc-hygiene`, and
   `maintenance.skill-hook-integrity`. Display labels live in
   `src/components/recommendation-display.ts` (`CATEGORY_LABEL`).
2. **`ActionDomain`** (`src/types.ts`, with the canonical registry in
   `src/lib/domain-registry.ts`) — the separate nine-value *presentation*
   taxonomy. Its six action domains organize the nav sidebar and digest into
   product-legible, outcome-first buckets: *Stay safe, Cut cost, Fail less, Go
   faster, Tame context, Clean workflow*. The remaining three structural buckets
   are *Overview, Find,* and *Raw data*.

So the seven surfaces are not competing with four engineering axes; they are
competing with an outcome-first presentation layer (`ActionDomain`) that was
purpose-built for exactly the "product-legible" goal the essay names — and which
is already wired into nav grouping and digest ranking. The Recommendations view
itself does **not** currently group by category at all: it ranks by
severity/impact (top rec + "Everything else" + a critical/warning/info filter),
with category shown only as a per-card label. There is no existing
"group-by-category" UI for the seven surfaces to replace.

## Mapping: seven surfaces → existing model

`✓` = backed by shipped detectors; `~` = partial / adjacent; `gap` = no detector
yet.

| Surface | Maps to `RecCategory` | Closest `ActionDomain` | Backing detectors | Status |
|---|---|---|---|---|
| **Diet** (context/token bloat) | `context`, `cost` | Tame context / Cut cost | context- and cost-category detectors | ✓ |
| **Tools** (tool-surface trim) | `workflow`, `cost` | Clean workflow | tool-surface and MCP workflow detectors | ✓ |
| **Memory** (durable memory, docs, config, and hook hygiene) | `maintenance` | Clean workflow | `maintenance.memory-hygiene`, `maintenance.doc-hygiene`, `maintenance.skill-hook-integrity` | ✓ |
| **Proof** (does the change help?) | — | — | v0.4 proof-engine (deferred) | gap |
| **Value** (is it worth the spend?) | `cost` | Cut cost | cost/reclaim dollarization | ~ |
| **Job** (task-fit / right model & scope) | `workflow`, `speed` | Go faster / Clean workflow | model-pin, speed detectors | ~ |
| **Reach** (integration / connectivity surface) | — | — | none | gap |

What the mapping exposes, and why a 1:1 relabel is wrong:

- **No clean bijection.** `Diet`, `Tools`, and `Value` overlap multiple data
  categories. `Memory` has a dedicated `maintenance` category, but shares the
  Clean workflow action domain with `Tools` and `Job`. Relabeling either taxonomy
  would therefore split one detector across surfaces or merge several surfaces
  into one, losing resolution.
- **Categories with no surface.** `safety`, `security`, `reliability`, and
  `activity` — four of the nine, including the two highest-trust categories —
  have no home in the seven. `safety` *leads* the nav and digest (#491);
  demoting it into an essay taxonomy that omits it would be a regression.
- **Surfaces with no detector.** `Reach` has zero backing signal, and `Proof`
  is the deferred v0.4 work. Adopting them as top-level groups would ship empty
  buckets.

## Load-bearing reasons not to refactor the data model

`RecCategory` is not just a label — it is keyed off detector rule ids and is
relied on by the reclaim/dedup rollups (`rollupReclaim`, per-category
`byCategory` in `src/lib/recommendations.ts`) and the CLAUDE.md-suppression /
auditability machinery. Renaming or re-bucketing it is an invasive,
cross-cutting change with test, suppression, and reclaim-accounting blast radius,
for a vocabulary that doesn't map cleanly. The cost/benefit is clearly negative.

## What we adopt instead

1. **Narrative lens (docs + SPA copy).** The surface vocabulary is genuinely good
   for *explaining* the engine to a non-engineer: "we audit your agent's Diet,
   Tools, and Memory and prove the Value." Use it in positioning/marketing copy
   and onboarding prose, mapping back to the live categories via the table above.
   This is the essay's real product gift and it costs nothing structural.
2. **Gap checklist → existing work.** The `gap`/`~` rows are a useful
   completeness check, not new scope; where follow-up is already planned it has
   an existing home:
   - *Proof / Value* → the v0.4 proof-engine pivot (dollarize every category).
   - The essay's "last ten runs" audit baseline → **#1882** (rolling "last N
     runs" maintenance-audit recommendation), already an epic member.
3. **Revisit trigger.** If `ActionDomain` is ever reworked (e.g. the #1591
   page-header / #604 nav-legibility work revisits the outcome-first buckets),
   re-weigh the surface names *as candidate `DOMAIN_LABEL` copy* at that point —
   that is the layer where "product-legible grouping" actually lives, and the
   only place a rename would be cheap. It is explicitly **not** a `RecCategory`
   change.

## Acceptance check (issue #1881)

- [x] Short decision note with adopt / partial-map / reject verdict — **this
  file** (partial-map).
- [x] Mapping from existing rec categories to the seven surfaces — the table
  above, grounded in the live nine-value `RecCategory` and nine-value
  `ActionDomain` models.
- [n/a] "If adopted: the recs engine emits/labels findings under the surface
  taxonomy and the Recommendations view groups by it" — not triggered; the
  verdict is partial-map/reject-as-replacement, and the issue forbids refactoring
  the category model before the mapping is agreed.
