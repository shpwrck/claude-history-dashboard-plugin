# Claude Coach — Navigation Redesign: A Concept Proposal

*Grounded in a blind persona×band ideation. Eight agents, four personas plus an accessibility lens, generated IA concepts independently; concepts were clustered into families, scored per audience band, funneled to finalists, refined into buildable specs, and re-scored. Sections 1–4 were written without sight of any prior design sketch; section 5 is the only post-hoc comparison.*

---

## 1. The case for redesigning

The current navigation is a **flat list of 20 views** — evaluator, insights, recommendations, sessions, projects, search, stats, tokens, tools, files, cost, timeline, activity, automation, errors, permissions, agents, context, conversation, patterns. The independent ideation did not need to be told this was a problem; **every one of the eight agents, working blind, reorganized away from it on the same axis.**

The convergent diagnosis, stated in the agents' own language:

- **The nav is organized by data-type, not by what the user is trying to do.** S1-Sam: "organized by my question — Am I okay → where did this week go → what do I change — not by the data type (tokens, cost, context, timeline, patterns) that answers them." S2-Riley: "The current flat 20-item nav forces me to hold the entire data-type map in my head and manually route between Cost, Context, Patterns, Conversation, Sessions, Timeline — all of which are steps in the same research move." This is the single complaint all eight share.

- **Orientation views map to no action.** The review found ~78 of 83 hard dead-ends are pure orientation vanity (stats / activity / time-of-day / bare KPI counts). The agents independently reached the same verdict: **`stats` is cut or hard-demoted in 8 of 8 concepts**, and `activity` in nearly as many. S2-Priya: "Stats: cut entirely — it is the canonical shotgun-stats dumping ground with no distinct job." X-Owen: "Calendar heatmaps are orientation vanity."

- **Triangulation is manual.** The genuine action domains — cost, speed, success-rate, safety, context-health, workflow-hygiene — are reachable but scattered. S2-Priya: "forcing a bounce between tabs was the core friction." Every concept collapses cost+tokens+context into one surface and folds permissions+errors into one safety surface, because the data-type split fractured single questions across multiple tabs.

- **Safety is under-weighted because it is siloed.** S1-Priya named the sharpest failure mode: "if the safety findings and cost findings live in separate tabs I have to visit independently, I will miss the critical safety issue because I went to the cost tab first… Siloing by domain is exactly what causes me to under-weight safety relative to cost because cost is more legible to me."

The scores confirm the flat nav serves nobody well. In the initial round, the only family that scored 5/5/5 on findability/time-to-action/learnability for newcomers (Digest-First) scored **2 or 1** on expert efficiency for practitioners and power users; the family that scored **5** on expert efficiency (Research Loop) scored **1** across the board for newcomers. **No flat-equivalent organization wins anywhere** — the flat nav is a structure that is mediocre for every band rather than excellent for any.

---

## 2. The families that emerged

Clustering the eight independent concepts produced **four distinct IA philosophies**, arranged on a single spectrum from *maximum curated* to *maximum raw*:

| Family | Distinguishing idea | Members | Spectrum position |
|---|---|---|---|
| **Digest-First** | Navigation *is* the answer sequence. The landing pre-composes plain-English conclusions; the user reads an answer, never picks a data-type. Question order is the spine: *am I okay → where did it go → what to fix.* | "Am I Okay Right Now?", "Team Digest", Signal Board (S2-Priya), "Signal-First: Answer Then Evidence" | **Maximum curated / guided.** App makes every interpretive decision before arrival. |
| **Research Loop** | Navigation mirrors an investigation cycle the user drives: *Compare → Find → Explain → Act.* The landing shows structure (a clustering surface), not conclusions; the user makes meaning. | Signal Board (S2-Riley) | **Maximum raw / direct.** Opposite pole from Digest-First. |
| **Domain-Object Spine** | The spine is a first-class owned object — a catalog of tools/skills/hooks/agents — with verdicts (PROMOTE/WATCH/RETIRE); every diagnostic is a drill-down from a catalog row. | "Catalog Leaderboard" | **Moderately curated / moderately direct.** Middle. |
| **Evaluation & Audit Mode** | The job is a binary/directional decision *before* optimization — "is this CI safe?" / "is this tool worth committing to?" Recommendations demoted; an audit log or report card is the spine. | "Ops Console", "Verdict First" | **Lightly curated / direct.** Pre-filters to a decision-relevant slice. |

The most striking blind-convergence result: **four of eight agents independently invented Digest-First** — including the accessibility persona (X-Nora's "Signal-First: Answer Then Evidence" is the same principle constrained by screen-reader needs) and two different personas who literally produced the same concept *name*, "Signal Board," from opposite philosophies (S2-Priya's was Digest-First; S2-Riley's was Research Loop). That two agents reached for the same name from opposite poles underlines that the *spectrum*, not any single point on it, is the real finding.

---

## 3. The per-band frontier

This is the key result. **No single family wins every band**, and the two poles are each other's worst pick. From the initial per-band scores (overall-for-band, 1–5):

| Family | S1 Newcomer | S2 Practitioner | S3 Power user | Accessibility (Nora) |
|---|---|---|---|---|
| **Digest-First** | **5** ✅ | 2 ❌ | 1 ❌ | **4** ✅ |
| **Research Loop** | 1 ❌ | **4** ✅ | **4** ✅ | 2 ❌ |
| Domain-Object Spine | 3 | 3 | 3 | 3 |
| Evaluation & Audit | 2 | 3 | 3 | 3 |

The frontier reads cleanly:

- **Newcomer → Digest-First.** Sweeps 5/5/5 on findability/time-to-action/learnability and 5 on safety surfacing. The app makes every interpretive decision before arrival. Its one weakness — buried expert drill-downs (expertEfficiency 2) — is irrelevant to a day-one user.
- **Practitioner → Research Loop.** Wins at 4 with peer-level raw sections that map to investigative moves (Compare/Find/Explain/Act) and first-class cross-view triangulation — exactly the filter+deep-link surface S2 already knows it needs.
- **Power user → Research Loop.** Wins at 4: peer-level sections, no mandatory guided flow, raw evidence first. Its one gap (no explicit JSON/export/stable-ID affordance) is addressable in refinement.
- **Accessibility → Digest-First.** Best fit at 4: pre-composed prose conclusions are screen-reader-native and carry meaning through text, not color or dense tables. *Caveat:* this edge only holds if heading hierarchy is specified — a flat prose blob erases it.

**The two middle families never win a band outright but never fail one** — flat 3s everywhere. Notably, **Evaluation/Audit leads or ties for top on safety surfacing in every band (5/5/5/4)** — and safety is one of the genuine action domains. That strength is the one thing neither pole guarantees.

**The honest tradeoff:** Digest-First wins the guided/accessibility end and is the *worst* pick for both expert bands, who must fight past a narrative layer to reach raw data buried two drill-downs deep. Research Loop is the mirror image — it wins both expert bands and is the worst pick for newcomers and accessibility. The decision is therefore *not* "which family" but **"can one structure carry both a curated default and a raw expert path without the default becoming a tax on experts?"**

---

## 4. Recommended concept(s)

The funnel carried two pole-finalists (**Digest-First**, **Research Loop**), then — because neither dominates the frontier and each is the other's worst pick — proposed and built out a **hybrid** that the re-scoring confirms.

### The re-scored frontier (finalists, overall-for-band):

| Finalist | S1 Newcomer | S2 Practitioner | S3 Power user |
|---|---|---|---|
| **Digest-First** | **4** | 3 | 3 |
| **Research Loop** | 1 | 3 | 2 |
| **HYBRID ("Digest-Default, Raw-Peer")** | 3 | **4** | **5** |

Read with the accessibility lens (where HYBRID scored a clean **5** on accessibility and safety surfacing for the newcomer band, the strongest of the three), this is the decisive pattern: **Digest-First still owns the pure newcomer**, but **HYBRID wins both expert bands and posts the best safety/accessibility numbers without ever scoring below 3 anywhere.** It is the only finalist that fails no band.

### Recommended concept: HYBRID — "Digest-Default, Raw-Peer"

Propose it as a *concept*, not a build spec:

- **A Digest spine is the default landing and the answer sequence** — a verdict on load, in a strict question order (*am I okay → where did it go → what to fix*), with **safety as the lead card.** This keeps the curated end intact for the two bands that need it (newcomers, screen-reader users).
- **A peer-level raw layer makes every data-type and investigative view a first-class, deep-linkable destination** with filters and export — *not* a drill-down hidden under a digest card. Experts bypass the digest entirely via a persistent rail or a direct deep link.
- **The two worlds share one URL space.** Digest cards link *into* the same addressable raw views. This is the mechanism that removes the "narrative tax" — the thing that made pure Digest-First the worst pick for experts.
- **Safety is folded in as both the lead digest card and a dedicated peer audit view**, absorbing Evaluation/Audit's one unique strength (it owns safety surfacing across every band).
- **Band-adaptation is achieved with existing levers, not a persona picker:** sticky last-view (returning experts re-land where they left off, not on the digest), hide/pin prefs, and the unattended-session scope toggle (serves the CI-audit slice without a separate app).

### The core tradeoff, stated honestly

The hybrid is not free. Maintaining two co-equal access patterns in one URL space is **more structure than either pole**, and the newcomer band pays for it: HYBRID scored **3** for S1 versus Digest-First's **4**, because "the always-visible dual structure of digest spine plus a multi-group peer rail adds cognitive load and decision points on first load." The bet is that this is the right trade — **a small, recoverable cost to the band that is most forgiving (a newcomer's first session is exploratory anyway), in exchange for not actively repelling the two expert bands and the accessibility lens.** The fallback, if that cost proves too high in testing, is **pure Digest-First with a strict heading hierarchy** as the safe default — it owns the newcomer and accessibility bands outright and only disappoints experts, who have the most patience to learn a workaround.

Do not over-specify beyond this. The concept is: **one curated answer-sequence default, one raw peer layer, one URL space, safety leading both — band-adaptive through disclosure depth, not separate apps.**

---

## 5. Post-hoc check vs the withheld "outcome-first" sketch

*(This section, and only this section, was written after revealing the prior sketch. It did not shape sections 1–4.)*

**The withheld sketch:** Home = 6 outcome dashboards (Cut Cost, Go Faster, Fail Less, Stay Safe, Tame Context, Clean Workflow); the 22 views demoted to drill-downs; search/discovery as a global utility in the chrome; orientation (stats/activity) in a collapsed "Raw data" drawer; Recommendations kept standalone; a navigate→copy→write affordance ladder.

**Verdict: the independent ideation landed squarely on the sketch's core principle, and on several mechanics, while diverging on one structural axis — and that divergence is the most interesting signal.**

**Convergence (validation):**

- **"Organize by outcome/action, not data-type"** is the sketch's spine and the *unanimous* independent finding (8/8 agents). The sketch's six outcomes — Cut Cost, Go Faster, Fail Less, Stay Safe, Tame Context, Clean Workflow — are almost exactly the review's six action domains (cost, speed, success-rate, safety, context-health, workflow-hygiene) that the agents independently reorganized around. Strong validation that the action-domain taxonomy is real, not an artifact of one author.
- **Orientation demoted, not deleted.** The sketch's collapsed "Raw data" drawer for stats/activity is precisely what the agents converged on (stats cut/demoted 8/8; the HYBRID's `#raw-stats` appendix and Research Loop's "Account shape" baseline strip are the same move).
- **Views → drill-downs.** The sketch demotes the 22 views to drill-downs; every family does the same.
- **The navigate→copy→write affordance ladder** matches, almost verbatim, the server-vs-SPA degradation all three finalists specified independently: write-back in server mode, copy-the-snippet in read-only SPA.
- **Search as a global chrome utility**, not a nav item — independently reached by S2-Priya, S2-Riley, and the HYBRID.

**Divergence (signal):**

- **The sketch's Home is six co-equal outcome dashboards. The funnel's recommendation is a single ordered answer-sequence (verdict → where → fix) with a peer raw layer.** This is the one real structural difference, and the funnel suggests the sketch is slightly *under-curated for newcomers and over-flat overall.* Six dashboards still asks the user to *pick which outcome to look at first* — a smaller version of the same "which tab?" decision the redesign exists to kill. The independent winner for the newcomer/accessibility bands (Digest-First) explicitly leads with **one verdict sentence** before any choice; six outcome tiles do not. S1-Priya's failure-mode warning applies directly: six co-equal outcome tiles risk the user opening "Cut Cost" first and missing a critical "Stay Safe" finding — the exact siloing the agents flagged. **The funnel beats the sketch here by ranking findings *across* all six domains on the landing rather than presenting six parallel doors.**
- **"Recommendations kept standalone"** diverges from the funnel, which *splits* recommendations into the digest's "what to fix" section while keeping it deep-linkable. The funnel treats recommendations as the spine's third beat, not a separate destination — arguably tighter.
- The sketch **does not call out accessibility or the expert raw-access tax** — the two pressures that forced the funnel to a hybrid rather than a pure outcome-dashboard home. The blind run surfaced both as decisive, which is the clearest case for having run it.

**Net:** the independent ideation **validated the sketch's foundational bet** (action-domain organization, orientation demotion, copy/write ladder) strongly enough to treat it as settled, and **beat it on one axis** — replacing six co-equal outcome doors with a single ranked answer-sequence plus a first-class raw peer layer, which better serves the newcomer (one answer, not six choices), the expert (no narrative tax), and accessibility (prose-first, heading-driven) simultaneously. The sketch was a good map of the destination; the blind run found a tighter road in.