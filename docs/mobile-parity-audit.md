# Mobile-parity audit — top-level nav views

Tracks issue #256 (part of the parity-audit umbrella #254). Records a
desktop-vs-mobile parity verdict for each of the 18 top-level navigation views,
so mobile usability is a deliberate, recorded check rather than an incidental
one. Breakages are tracked as their own follow-up `ui` issues — this document
only audits and records; it does not fix.

## Method

Driven with Playwright against a live build (real data: 194 sessions, 670
entries) at two viewports:

- **Desktop** — 1440 × 900, pointer.
- **Mobile** — 390 × 844, touch, portrait (iPhone-class narrow viewport).

Each view was navigated via its nav button and checked for:

1. **Renders** — the view's heading and content mount with data.
2. **No page-level horizontal overflow** — `documentElement.scrollWidth <=
   clientWidth` (no whole-page sideways scroll).
3. **No clipped content** — any element wider than the viewport must sit inside
   a horizontally-scrollable container (`overflow-x: auto/scroll` with
   `scrollWidth > clientWidth`); content that overflows *without* such a
   container is a fail.
4. **Controls reachable & tappable** — including the nav itself.

**Verdict legend:** `PASS` = meets all hard criteria. `PASS*` = meets all hard
criteria, with a soft UX note (e.g. a wide data table that scrolls horizontally
inside its card rather than reflowing). `FAIL` = clipped content, page-level
horizontal overflow, or an unreachable control.

## Result summary

- **Desktop:** 18 / 18 **PASS**, no page-level horizontal overflow, all headings
  and content render.
- **Mobile:** 18 / 18 pass the hard criteria — **zero** page-level horizontal
  overflow and **zero** clipped/inaccessible content on any view. The sidebar
  collapses into a hamburger drawer (top-left ☰), so navigation stays reachable.
- **No hard failures.** 13 views carry a soft `PASS*` note: wide data tables (11
  views) and two filter `<select>`s (Search, Timeline) exceed the 390px viewport
  but remain fully usable by scrolling horizontally within their own
  container/card. This is the only systemic mobile-UX gap and is tracked as a
  follow-up enhancement (see below), not a breakage.

## Per-view verdict

| # | View | File | Desktop | Mobile | Notes |
|---|---|---|---|---|---|
| 1 | Insights | `Insights.tsx` | PASS | PASS | Cards/charts reflow cleanly |
| 2 | Recommendations | `Recommendations.tsx` | PASS | PASS | Ranked cards stack |
| 3 | Sessions | `SessionList.tsx` | PASS | PASS | List reflows |
| 4 | Projects | `ProjectBreakdown.tsx` | PASS | PASS | — |
| 5 | Search | `SearchView.tsx` | PASS | PASS* | Filter `<select>` (~437px) wider than viewport; scrolls within its row |
| 6 | Stats | `UsageStats.tsx` | PASS | PASS | Pies/cards reflow |
| 7 | Tokens | `TokenUsage.tsx` | PASS | PASS | Hide-columns (#271): primary cols only <`sm`, secondary restored at ≥`sm` |
| 8 | Tool Usage | `ToolUsage.tsx` | PASS | PASS* | Wide table (~748px) scrolls horizontally in-card |
| 9 | File Impact | `FileImpact.tsx` | PASS | PASS* | Wide table (~1046px — long file paths) scrolls horizontally in-card |
| 10 | Cost | `CostAttribution.tsx` | PASS | PASS | Hide-columns (#271): primary cols only <`sm`, secondary restored at ≥`sm` |
| 11 | Timeline | `SessionTimeline.tsx` | PASS | PASS* | Filter `<select>` (~442px) wider than viewport; scrolls within its row |
| 12 | Activity | `ProjectActivity.tsx` | PASS | PASS | Hide-columns (#271): primary cols only <`sm`, secondary restored at ≥`sm` |
| 13 | Errors | `ErrorRetry.tsx` | PASS | PASS | Hide-columns (#272): primary cols only <`sm`, secondary restored at ≥`sm` |
| 14 | Permissions | `Permissions.tsx` | PASS | PASS | Hide-columns (#272): primary cols only <`sm`, secondary restored at ≥`sm` |
| 15 | Agents | `AgentSkill.tsx` | PASS | PASS | Hide-columns (#272): primary cols only <`sm`, secondary restored at ≥`sm` |
| 16 | Context Health | `ContextHealth.tsx` | PASS | PASS* | Table (~685px) scrolls horizontally in-card |
| 17 | Conversation | `ConversationPatterns.tsx` | PASS | PASS* | Table (~477px) scrolls horizontally in-card |
| 18 | Patterns | `SessionPatterns.tsx` | PASS | PASS* | Table (~652px) scrolls horizontally in-card |

## Follow-up issues

No view had a hard failure, so no per-view breakage issues were filed. The one
systemic soft gap — wide data tables and two filter `<select>`s requiring
horizontal scroll on a 390px viewport rather than reflowing to a stacked /
card layout — is captured as a single `ui` enhancement issue (the views share
one root cause: `<table class="w-full text-sm">` inside an `overflow-x-auto`
wrapper does not card-ize on narrow viewports):

- #258 — Reflow wide data tables (and over-wide filter selects) for narrow
  mobile viewports instead of horizontal-scroll-in-card.

## Re-running this audit

The audit is deterministic and can be reproduced against any live build: load
the dashboard, then for each nav view resize to 1440×900 and 390×844 and assert
(2) and (3) above. The modal / non-nav views (Settings and File Upload)
plus a reusable mobile-viewport smoke check are covered below, both under #257.

---

# Mobile-parity audit — modal / non-nav views (#257)

Extends the audit above to the views that aren't reached through the top-level
nav: **Settings** (⚙) and **File Upload** ("Upload Data…"). Same method and verdict legend as the nav
audit; both viewports driven against a live build (Playwright at 1440×900 and
the 390×844 smoke spec below).

| # | View | File | Trigger | Desktop | Mobile | Notes |
|---|---|---|---|---|---|---|
| 1 | Settings | `Settings.tsx` | ⚙ button (sidebar / mobile top bar) | PASS | PASS | Centered `role="dialog"` overlay; no page-level overflow at either viewport |
| 2 | File Upload | `FileUpload.tsx` | "Upload Data…" button | PASS | PASS | Centered `fixed inset-0` overlay; no page-level overflow at either viewport |

**No hard failures** on either modal view at either viewport, so no
follow-up `ui` breakage issues were filed (per the audit's record-don't-fix
contract).

## Reusable mobile smoke check

`e2e/mobile-smoke.spec.ts` is the durable regression guard the audit produced.
At a ~390px viewport it loads **every** top-level nav view *and* the three modal
views and asserts (a) no page-level horizontal overflow
(`documentElement.scrollWidth <= clientWidth`) and (b) the primary nav stays
reachable (the hamburger drawer opens). A future view that breaks the mobile
layout fails here instead of silently shipping.

### Pixel-level visual pilot

Issue #1112 adds a separate, opt-in screenshot pilot documented in
[`docs/mobile-visual-regression-pilot.md`](./mobile-visual-regression-pilot.md).
It captures first-viewport baselines for a few high-signal views and proves a
deliberate spacing drift is detected. It is not wired into browser-compat CI.

### Running it

The harness (`@playwright/test`, `playwright.config.ts`) runs against an
**already-served** build — it does not start the app, because the dashboard
serves live `~/.claude` data via `scripts/server.mjs` / the container, not
`vite preview`. Point it at a running build and run the spec:

```sh
npx playwright install chromium          # one-time browser download
PLAYWRIGHT_BASE_URL=http://127.0.0.1:5173 npm run test:e2e
```

`PLAYWRIGHT_BASE_URL` defaults to `http://127.0.0.1:5173` (the local container
port), so against the default deploy `npm run test:e2e` alone works. The
browser-compat workflow now runs the functional smoke suite against the SPA
sample-data bundle; the #1112 visual snapshot pilot remains local/manual.
