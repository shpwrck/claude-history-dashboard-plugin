# Nav redesign — outcome-first (working proposal)

> Decided in brainstorm 2026-06-03, built on `per-view-synthesis.md`.
> Direction: **outcome-first** · orientation → **Raw-data drawer** ·
> discovery = **global utility** · speed = **top-level now** (force the wiring).
>
> **⚠️ Refined by the blind persona×band funnel** (see `nav-redesign-funnel.md`).
> The funnel validated this doc's core bet 8/8 (organize by action-domain,
> orientation→drawer, copy/write ladder, search-as-utility) but **superseded the
> 6-co-equal-card home** with a **ranked digest spine** (verdict→where→fix,
> safety-first) over a first-class raw peer layer — six parallel doors still
> force a "which door?" pick and risk missing a safety finding behind a cost
> tab. The taxonomy here stands; the *home structure* is now the funnel's
> "Digest-Default, Raw-Peer." Epic #490 reflects the refined concept.

## Shape

```
┌─ chrome ──────────────────────────────────────────────┐
│ Claude Coach   [ 🔍 Find session/project… ]   ⚙︎       │   ← global discovery utility
│ nav:  Home · Recommendations · Raw data               │   ← Recommendations = standalone peer
├───────────────────────────────────────────────────────┤
│  HOME = 6 outcome dashboards                          │
│  ┌─ Cut Cost ─┐ ┌─ Go Faster ┐ ┌─ Fail Less ┐         │
│  ┌─ Stay Safe ┐ ┌─ Tame Ctx ─┐ ┌─ Clean WF ─┐         │
├───────────────────────────────────────────────────────┤
│  ▸ Raw data (stats · activity · time-of-day · trends) │   ← demoted, collapsed
└───────────────────────────────────────────────────────┘

Recommendations (standalone): cross-domain ranked list; each rec → its domain card / view.
```

Each outcome card is **thin**: 2–4 KPIs *each wired to a destination*, the single
highest-value finding for that domain (from the rec engine), a Copy-fix / Apply
where one exists, and an **Open full view →** link to the existing detailed view.
The 22 current views are **preserved as drill-down targets**, not deleted.

## The 6 outcome dashboards → drill-downs

| Outcome card | Top wired KPIs (each links somewhere) | Headline finding source | Drill-down views |
|---|---|---|---|
| **Cut Cost** | spend vs cap (BudgetGauge), top-3 expensive sessions, biggest swap-ceiling saving **+ Apply** | cheaper-model routing, recoverable spend | cost (CostAttribution), tokens (TokenUsage) |
| **Go Faster** | p95 latency → slowest session, hook overhead, retry-pressure | *(thin — see Speed note)* | evaluator, agents (runtime telemetry), conversation (latency) |
| **Fail Less** | error rate → errored sessions, worst tool by error rate, top friction | API-error / retry-storm detectors | errors (ErrorRetry), tools (effectiveness) |
| **Stay Safe** | bypass-mode count → those sessions, unattended runs, PolicyBuilder diff inline | unattended/bypass detectors | permissions (+PolicyBuilder), automation |
| **Tame Context** | worst cache-hit session, top compaction-risk session **+ copyable `/compact`**, worst `@path` to pin | compaction-risk card | context (ContextHealth), files (FileImpact) |
| **Clean Workflow** | unused skills/agents/MCP count **+ prune snippet**, native-tool bypass, CLAUDE.md bloat | config-hygiene + bloat detectors | config-hygiene, tools (catalog), agents (skills/MCP), patterns |

**Cross-domain views** (`agents`, `tokens`, `automation`, `patterns`) stay **whole**
and are reachable from *multiple* cards (Q3 = Candidate-3 answer): e.g. `tokens`
is a drill-down for both Cut Cost and Tame Context; `agents` for Go Faster, Fail
Less, Cut Cost, and Clean Workflow.

**Global utility (chrome, not a domain):** `search` + `sessions` + `projects` +
`timeline` + the `SessionIdLink`/`onOpenSession` fabric. Pinned "Find" affordance.

**Raw-data drawer (demoted):** `stats`, `activity`, time-of-day heatmaps,
conversation-shape counts, insights narrative/big-wins. Their few actionable
slices are redistributed (project-distribution → Cut Cost; friction → Fail Less).

## Two orthogonal workstreams (don't conflate)

1. **Nav restructure** — the above. Pure information architecture.
2. **"Wiring abandoned one step short" sweep** — independent of nav. The domains
   are *reachable* (≈0 hard dead-ends) but a large "low" tier computed the exact
   fix and withheld the affordance: swap-ceiling rows with no Apply, copyable
   `/compact`/`@path` with no CopyButton, status codes with no guidance, KPI
   tiles that don't link to their rows, false affordances (clickable styling, no
   handler). A reusable CopyButton + onClick sweep converts the most dead-ends
   for the least effort, and it's what makes the thin outcome cards non-empty.

## Speed note (accepted risk)

`Go Faster` is top-level by choice to force the work, but it's the poorest-
instrumented domain today (Evaluator latency dead, hook-overhead tiles dead,
velocity cell is a false affordance, thin rec-engine latency detection). Expect
it to start sparse; seed it from the dead speed data points as the wiring backlog.

## Settled forks

- **Q3 — cross-domain views:** kept whole, reachable from multiple cards (Candidate-3 model). `tokens`, `agents`, `automation`, `patterns` are not filed under one heading.
- **Q5 — Recommendations stays standalone.** It remains a full top-level peer destination alongside the 6 outcome cards — the canonical *cross-domain ranked* list ("what's the single #1 thing to fix right now"), which the per-domain cards structurally can't provide. Home is the 6-card outcome grid; Recommendations sits beside it in the chrome. The two are complementary: cards = entry *by outcome*, Recommendations = ranked *across* outcomes. (No "Top Actions" strip needed — Recommendations already is it.)
- **Q6 — 3-tier affordance ladder, write where safe.** Every actionable datum standardizes on one of:
  1. **Navigate** — drill to the detail view / session (the `onOpenSession` / `onNavigate` fabric). The floor; every datum gets at least this.
  2. **Copy** — `CopyButton` for any snippet the app already computes (`/compact`, `@path` pin, prune command, cheaper-model key, `json.tool` repair).
  3. **In-app write** — the PolicyBuilder model (preview diff → confirm → write `settings.json`) for *safe* config changes, extended to model-routing and resource-pruning where the patch is unambiguous.
  - **SPA-mode degradation:** SPA can't write to `~/.claude`, so tier-3 writes **degrade to tier-2 copy** there (gated through `src/lib/api-client.ts` per the sample-boundary contract). No card may depend on a write that has no copy fallback.
