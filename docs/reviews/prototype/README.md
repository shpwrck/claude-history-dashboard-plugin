# Nav redesign prototypes

Throwaway clickable mocks for the nav redesign in **#490**. Pure static
HTML/CSS/JS — no build, no dependencies, not wired into the app. Two mocks:

| File | Concept | Status |
|---|---|---|
| `digest-led-nav.html` | **Digest-Default, Raw-Peer** — the concept the blind persona×band funnel landed on | **current recommendation** |
| `outcome-first-nav.html` | the earlier **6 outcome cards** sketch | superseded (kept for the contrast it shows) |

## Run

```bash
python3 -m http.server 8099 --bind 127.0.0.1 -d docs/reviews/prototype
# open http://127.0.0.1:8099/digest-led-nav.html   (or outcome-first-nav.html)
```

(`file://` is fine in most browsers too; the http server just avoids a favicon
nag.)

## digest-led-nav.html — what to try

- **Home-structure toggle** (top strip) — flip the home between **Digest spine
  (proposed)** / **6 outcome cards** / **Flat 20 views** to feel why one ranked
  answer beats six co-equal doors (the cards view spells out the "which door?"
  trap — open Cut Cost, miss the critical Stay Safe finding).
- **"I'm a:" Newcomer / Expert toggle** — band-adaptation via *disclosure depth*,
  not a persona picker. Newcomer lands on the digest with the raw rail collapsed;
  Expert gets the rail expanded and a sticky "resume where you left off" banner.
- **The digest spine** reads top-to-bottom: *verdict (safety-first) → where it
  went → what to fix* (ranked across all six domains).
- **The raw peer rail** (left) — every view is a first-class, deep-linkable
  destination; digest findings and rail both land in the same raw view (one URL
  space).

## outcome-first-nav.html — what to try

- **Before / After toggle** (top strip) — flip between the current flat 20-view
  sidebar and the proposed outcome-first home.
- **6 outcome cards** — Cut Cost · Go Faster · Fail Less · Stay Safe · Tame
  Context · Clean Workflow. Each shows a top finding, KPIs (click one → drill
  to the full view), and the standardized action (Copy / Apply / navigate).
- **Recommendations tab** — the standalone cross-domain ranked list.
- **Raw-data drawer** — where the demoted orientation surfaces (stats, activity,
  time-of-day) live, off the action path.

## Screenshots

- `screenshot-digest-newcomer.png` — the digest spine (Newcomer band)
- `screenshot-digest-expert.png` — Expert band: raw rail expanded + resume banner
- `screenshot-after-home.png` — the earlier outcome-first 6-card home
- `screenshot-before-flat.png` — the current flat nav, for contrast

Design rationale: `../nav-redesign-funnel.md` (digest-led, current) and
`../nav-redesign-outcome-first.md` (earlier sketch). Data behind it:
`../per-view-detail.md`, `../per-view-synthesis.md`.
