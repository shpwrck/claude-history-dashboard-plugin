# User stories, personas, and IA brainstorm

> **As of 2026-07-22 — point-in-time brainstorm, some structural claims are stale.**
> This doc reflects an early IA snapshot: the nav shell it names (`src/components/Layout.tsx`)
> no longer exists — layout/nav now live in `PFLayout.tsx` + `src/lib/nav-prefs.ts` — and the
> "eighteen top-level views" count has since grown to ~31 (see `nav-prefs.ts` `NAV_ITEMS`).
> The persona/IA *reasoning* below is preserved as a 2026-05 brainstorm record; treat the
> specific file names and view counts as historical, not current.

**Status:** Brainstorm + first code change. The persona/IA spec stays
narrative; the single code change so far is flipping the default
landing route from `insights` to `recommendations` (see §6 for the
rationale). The point of the doc is to stop ourselves from adding
"view #19" and instead ask: *whose job does that serve?*

The dashboard today is a smart pile of stats — eighteen top-level views
(see `src/components/Layout.tsx`), each technically excellent in
isolation, each rendering a slightly different cross-section of the
same `dataset.json`. Until this PR, new visitors landed on `Insights`
and saw a wall of charts they had to narrate themselves; worse,
Insights is only as fresh as the last CLI `/insights` run because
`~/.claude/usage-data/` only updates when that skill runs. That is
the "shotgun" feeling we want to fix.

This document does four things:

1. Names the **people** the dashboard should serve, and the **jobs**
   they bring with them — across three skill bands.
2. Audits the current views against those jobs.
3. Proposes a re-bucketed IA driven by jobs, not by data sources.
4. States which views actually serve which persona × skill-band cell,
   so we can argue from evidence the next time someone proposes a
   nineteenth top-level view.

---

## 1. Personas

Twelve personas (P11–P12 are short vignettes added to exemplify the
**Scope axes** section that follows §1). They are distinct enough that
an IA decision can be checked against them ("would the team lead
actually go there to answer that?"). Two of them are the same human at
different times of day
(*Solo Dev* in the morning vs *Cost-Conscious Solo* on Friday afternoon),
and that is fine — the *jobs* are different. Two more (P3 Quentin and
P8 Marcus) both build skills, but for different audiences: Quentin
publishes to the ecosystem and needs *attribution*; Marcus owns an
internal portfolio and needs *pruning evidence*. One (P9 Nora) brings
the same jobs as everyone else but at 200%+ zoom and with limited
reading bandwidth — she's a check on whether the IA holds up when text
density and colour-only signals are off the table.

### P1. Sam — Solo Dev on a Pro plan

A working developer using Claude Code 4-8 hours a day on personal +
client work. Pays $20/month. Lives inside the rolling 5-hour session
window and the weekly cap.

- **JTBD:** *When I'm mid-session, I want to know how close I am to
  burning the session window, so that I can decide whether to keep
  pushing or compact-and-shift.*
- **Top questions:**
  1. Am I about to hit the 5-hour window?
  2. Which of today's sessions blew the most tokens, and why?
  3. Was that big spend on real work, or a runaway re-read loop?
  4. Did my context spill past 200K and start evicting?
  5. Is my current project trending hotter than last week?
- **Success signal:** A single number ("you're at 62% of your weekly
  cap, on pace for 95% by Friday") plus *the one* most expensive
  session of the day, one click away.

### P2. Priya — Tech lead instrumenting a team

Manages 4-10 engineers using Claude Code on a shared codebase. Pays
the org bill. Cares about consistency, safety, and ROI across the
team — not the individual session-level micro-detail.

- **JTBD:** *When I review last week's Claude usage, I want to spot
  which engineers/projects are wasteful or unsafe, so that I can
  coach + tune our shared `CLAUDE.md` and `settings.json`.*
- **Top questions:**
  1. Which projects are dominating spend, and is that proportional to
     output?
  2. Are dangerous commands running under `bypassPermissions` anywhere?
  3. Which tools are causing the most permission prompts (= friction)?
  4. Which sessions retried the same broken tool 10+ times?
  5. What changed week-over-week — new file-churn hotspots, new error
     patterns?
- **Success signal:** A weekly digest she could screenshot into Slack.
  Top 3 projects by spend, top 3 safety findings, top 3 reliability
  findings, each with a copy-pasteable fix.

### P3. Quentin — Plugin / skill author

Built a custom skill or MCP server and wants evidence that it earns
its keep. Cares about *attribution*: did invoking my skill actually
shorten the session, or did people retry their old workflow anyway?

- **JTBD:** *When I ship a new skill or sub-agent, I want to see how
  often it's actually invoked and whether sessions that use it close
  faster/cheaper, so that I know it's pulling its weight.*
- **Top questions:**
  1. How often is my agent / skill / MCP server invoked?
  2. Do sessions that use it finish faster than sessions that don't?
  3. Does it error or get retried more than the native equivalent?
  4. Is anyone re-implementing what my skill does in raw Bash because
     they don't know it exists?
  5. Has my invocation rate grown or decayed since the last release?
- **Success signal:** A bar chart per skill/agent: invocations,
  median session cost with/without, error rate. The `AgentSkill.tsx`
  view already has the bones of this — Quentin needs it foregrounded,
  not buried.

### P4. Devi — DevOps wiring up auto-approvals

Runs Claude Code unattended in CI / cron / SDK-CLI mode to do ops work
(rotate credentials, run migrations, draft PRs). Pays in 429s and in
"the agent did something destructive at 3am" incidents.

- **JTBD:** *When I tighten my unattended-run settings, I want to know
  exactly which commands ran with prompts bypassed, so that I can
  allowlist the safe ones and deny the destructive ones.*
- **Top questions:**
  1. Which automated sessions used `bypassPermissions`?
  2. What destructive command patterns (`rm -rf`, `git reset --hard`,
     `curl | sh`) ran without confirmation?
  3. Which automated runs hit rate-limit (429/529) errors?
  4. Are my automated sessions on the most expensive model when they
     could be on Haiku?
  5. Where are my automated runs reading files they don't need?
- **Success signal:** A copy-pasteable `permissions.deny` block (the
  recommendations engine already emits this — see
  `ruleDangerousBypass` in `src/lib/recommendations.ts`) plus a
  one-click "allowlist the safe variants of Bash" snippet (already
  there in `rulePromptFriction`).

### P5. Riley — Researcher comparing prompt patterns

A power user — researcher, content creator, prompt engineer — who
runs many sessions across many projects and wants to learn *what kind
of session goes well*. Less interested in cost, more interested in
shape.

- **JTBD:** *When I compare sessions, I want to see which "shapes"
  (rapid vs sparse rhythm, tool-heavy vs talk-heavy, retried-or-not)
  produced the best outcomes, so that I can prompt differently next
  time.*
- **Top questions:**
  1. Which sessions did I rate (or `/insights` rated) as most
     "satisfying"?
  2. What did those sessions have in common — pattern, hour of day,
     tool mix?
  3. Which projects have the highest "rework" signature
     (file-churn + retry storms)?
  4. Which prompt shapes hit compaction earliest?
  5. Are my "best" sessions short and tool-heavy, or long and
     conversational?
- **Success signal:** A clustering view that says "your top-N
  sessions share this shape" with the matching `/insights` satisfaction
  signal overlaid. `SessionPatterns.tsx` already does the clustering;
  it needs the outcome overlay.

### P6. Casey — Cost-conscious solo

The same human as Sam, but on Friday afternoon staring at the bill.
Wants to *downshift* — same work, less money — without losing the
quality they're used to.

- **JTBD:** *When I review last week's spend, I want a ranked list of
  the cheapest changes I can make this Monday, so that next week
  costs less without me having to re-learn how I work.*
- **Top questions:**
  1. How much of last week's spend was on Opus when Sonnet/Haiku
     would have done?
  2. How much went to the 1-hour cache vs 5-minute cache?
  3. Which sessions had > 50% of their tokens read back from cache
     (good) vs from scratch (bad)?
  4. Which automated runs are cheapest-to-downshift?
  5. What's the dollar value of the top 3 recommendations if I
     applied them?
- **Success signal:** Three dollar amounts: "applying these three
  CLAUDE.md / settings.json snippets saves an estimated $X/week."
  The `totalEstimatedSavings()` helper in `recommendations.ts` already
  computes this — Casey needs it surfaced as the *first thing she
  sees*, not a sidebar.

### P7. Owen — Codex refugee / multi-CLI evaluator

A working developer who has been using OpenAI's Codex CLI (or another
agentic coding tool) and is now trial-running Claude Code in parallel.
Arrives with strong opinions about token cost, tool-call latency, and
"how much yak-shaving does this agent do between useful edits." Wants
to make an evidence-based call: migrate fully, keep both, or bounce.

- **JTBD:** *When I run the same kind of task in both Claude Code and
  my old CLI, I want hard numbers on cost, latency, and rework, so
  that I can decide which agent to commit to (or where to route which
  workload).*
- **Top questions:**
  1. What does an average task actually cost me in Claude Code, end-
     to-end? (Not per-token — per-completed-task.)
  2. How much of a session is real progress vs the agent re-reading
     files it already read?
  3. What's my tool-call latency distribution — is the agent waiting
     on me or am I waiting on tools?
  4. How often does Claude Code retry the same broken tool call vs
     just failing fast?
  5. Which of my projects would obviously stay on the other CLI, and
     which clearly belong on Claude Code?
- **Success signal:** A one-screen "agent report card" — median task
  cost, p50/p95 tool-call latency, retry storm rate, reread-loop
  fraction — that a skeptic could screenshot and argue with. The
  `parse-tool-effectiveness.ts` + `parse-runtime-events.ts` libraries
  already compute most of this; Owen needs it pulled into a single
  comparison-ready surface, not scattered across Tools / Errors /
  Agents / Context Health.

### P8. Marcus — Internal tooling engineer (skill / plugin / hook author)

Builds plugins, skills, sub-agents, and hooks for his team's Claude
Code stack. Different from Quentin (P3) in audience and motivation:
Quentin publishes outward and wants *attribution*; Marcus owns a
maintained portfolio and wants *pruning evidence*. The Tool
Effectiveness panel (issue #106), Tool Catalog Utilization (#112), and
Agent Effectiveness (#109) views are direct service for this persona.

- **JTBD:** *When I review my team's Claude usage at the end of a
  sprint, I want to see which of MY tools/agents/skills/hooks are
  earning their slot and which are dead weight, so that I can deprecate
  the duds and double down on the winners.*
- **Top questions:**
  1. Which of my skills/agents fired at all this week? Which haven't
     fired in 30 days?
  2. For the ones that fired, what's the effectiveness score and
     trend?
  3. Are my hooks adding latency that outweighs their value (e.g. a
     pre-commit hook that adds 4s to every Bash call)?
  4. Is the team re-implementing in raw Bash what one of my skills
     already does — i.e. discovery failure on my side?
  5. Which entry in my catalog should I retire *this sprint*?
- **Success signal:** A "Catalog utilization" leaderboard — every
  custom tool/skill/agent/hook with invocations, last-fired, score,
  and a clear "retire candidate" or "promote candidate" verdict.
  `parse-tool-effectiveness.ts` and the upcoming Tool Catalog
  Utilization work (#112) supply the inputs; Marcus needs the verdict
  rendered, not the raw table.

### P9. Nora — Accessibility-first user

A working developer with low vision and partial hearing loss. Lives at
200%+ browser zoom and reads in short bursts because more text means
more fatigue. Drives the dashboard from the keyboard more than the
mouse, and relies on a screen reader for charts and dense tables. Has
the same jobs-to-be-done as the other human personas on this list —
she's only different in *how* the dashboard has to present the answer.

- **JTBD:** *When I open the dashboard, I want the one thing that
  matters right now in a few large, plain words, so that my limited
  reading bandwidth goes to the insight, not to parsing the UI.*
- **Top questions:**
  1. What is THE one thing I should act on first — just one?
  2. Can I read this surface at 200% zoom without horizontal scroll
     or text clipping?
  3. Is every chart paired with a text-equivalent summary my screen
     reader can announce?
  4. Are severity / status signals conveyed by something other than
     colour alone?
  5. Can I drive every interaction from the keyboard, including
     dismissing modals and copying `fix` snippets?
- **Success signal:** The Act landing renders cleanly at 200% zoom
  with no horizontal scroll; every chart has an accessible name (e.g.
  `role="img"` + `aria-label`) summarising the headline number; every
  severity dot is paired with a textual label, not colour alone; every
  interactive element is keyboard-reachable; and the top recommendation
  reads as one short sentence above the fold. Recommendations is
  already closest to this — its cards are mostly text and the `fix`
  Copy button is keyboard-operable — but a sweep is needed to ensure
  no severity/category signal is colour-only and that the denser views
  (Timeline, Patterns, Insights charts) are not screen-reader
  dead-ends. Pairs naturally with the Newcomer skill band in §2: both
  need plain-English labels and ranked cards over scatter plots.

### P10. Aya — A Claude Code agent itself (machine consumer)

The dashboard's own data, consumed by an agent reading it on a human's
behalf — via a future MCP server, a screenshot of a chart, or a curl
against `/api/dataset.json`. Lower priority than the human personas,
but worth naming because it forces a design constraint: every view's
underlying data must be machine-extractable, not just chart-ware.

- **JTBD:** *When my human asks "am I about to hit my cap?" or "which
  of my skills are dead weight?", I want to read the dashboard's
  computed signals directly, so that I can answer without re-deriving
  them from raw transcripts.*
- **Top questions:**
  1. Is there a stable, versioned JSON endpoint for every chart in the
     UI?
  2. Can I get the same recommendations the human sees, with the same
     `fix` snippets, as structured data?
  3. Can I subscribe to changes (or at least poll cheaply) instead of
     re-parsing `~/.claude` myself?
  4. Are the signals self-describing — units, time window, confidence
     — or do I have to guess?
  5. If I screenshot a view, can I extract its semantics from a
     `data-*` attribute or alt-text?
- **Success signal:** A machine-readable mirror of every view —
  minimum `/api/dataset.json` (already exists) plus
  `/api/recommendations.json` and per-view JSON endpoints — documented
  enough that an MCP server can be a thin wrapper. This is a
  *constraint on every other view*, not a view of its own: don't ship
  a chart whose data isn't also exportable.

### P11. Tariq — Monorepo maintainer *(project-user-dominant)*

Owns one large repo and configures Claude Code entirely at the project
level: the repo's `CLAUDE.md`, `.claude/skills/`, `.claude/agents/`, and
the project's MCP enablements in `~/.claude.json`. Rarely touches
`~/.claude` globals — his teammates each keep their own. Almost every
session he cares about lives in this one repo.

- **JTBD:** *When I review my repo's Claude usage, I want findings scoped
  to THIS project's config, so that "you never use skill X" means X as my
  repo defines it — not a global skill I deliberately don't install here.*
- **Scope:** **project-user.** A global-pitched rec ("you have 12 skills
  installed and use 2") is noise to him; he wants "in this repo, 2 of the
  4 project skills fired this sprint."

### P12. Gabriela — Consultant hopping repos *(global-user-dominant)*

Bounces across 15+ client repos a week and keeps all her tooling global:
`~/.claude/settings.json`, `~/.claude/skills/`, and global `mcpServers`
in `~/.claude.json`. Most repos carry no project `CLAUDE.md` of hers at
all. She experiences the dashboard as an account-wide rollup, not a
per-repo one.

- **JTBD:** *When I look at my week, I want usage rolled up across every
  repo against my global config, so that "this skill never fires" is a
  true statement about my whole account — not a per-repo accident.*
- **Scope:** **global-user.** Per-project recs ("in repo Y you didn't use
  Z") feel noisy and unactionable — she'd never tune one client's repo for
  her own tooling. She wants the coarsest globally-true statement.

---

## Scope axes

The personas above name *who* uses the dashboard; this axis names *at what
scope* they experience it. It cuts across all of them and is load-bearing
for rec phrasing and IA, because the pattern × resource recommendation
engine rolls usage up to the **coarsest true statement** — so a finding
must be pitched at the scope the reader actually operates at.

- **Project-user** — lives in one repo. Their config is the project's
  `CLAUDE.md`, `.claude/skills/`, `.claude/agents/`, and the project's
  `mcpServers` / `enabledMcpjsonServers` in `~/.claude.json`. A finding
  should read "in *this* repo…". A global-pitched rec ("you never use X")
  mis-fires — X may be something they deliberately don't install here.
- **Global-user** — flips through many repos. Their config is
  `~/.claude/settings.json`, `~/.claude/skills/`, `~/.claude/agents/`, and
  global `mcpServers` in `~/.claude.json`. A finding should be a statement
  about the whole account; per-project recs feel noisy because they'd
  never tune one repo for their own tooling.

Most personas are really *both* at different moments, but each leans one
way. Per-persona tags:

| Persona | Scope lean | Why |
|---|---|---|
| P1 Sam | both *(global-leaning)* | Personal + client repos, but lives in the account-level session/weekly window |
| P2 Priya | both *(project-leaning)* | Tunes a shared repo's `CLAUDE.md`, but owns the team-wide `settings.json` |
| P3 Quentin | global | Publishes skills to the ecosystem from `~/.claude/skills/` |
| P4 Devi | both *(global-leaning)* | Unattended-run permissions usually live in global settings, sometimes per-project CI |
| P5 Riley | global | Compares sessions across many projects |
| P6 Casey | global | Reasons about the account-level bill |
| P7 Owen | both *(global-leaning)* | Evaluates Claude Code account-wide, then routes specific projects |
| P8 Marcus | global | Owns a catalog spanning the team's repos |
| P9 Nora | both | Scope-agnostic — her needs are presentational, at whatever scope the answer lives |
| P10 Aya | both | Reads whatever the dashboard exposes; scope follows the question asked |
| P11 Tariq | project | Configures and works entirely inside one repo |
| P12 Gabriela | global | All-global tooling across 15+ client repos |

**How to use it:** when arguing a view's home or a rec's wording, name the
scope, not just the persona — "would the *project-user variant* of Priya
actually go here, or only the team-global one?" If a rec can't be phrased
truthfully at the reader's scope, it belongs at a coarser one.

### Form factor — desktop / mobile

The scope axis above names *where* (project vs account) a reader operates; this
companion axis names *on what device*. It cuts across every persona and skill
level, and it is load-bearing for view layout the same way scope is for rec
phrasing: a view or control pitched only for a wide pointer viewport mis-serves
the reader who pulled the dashboard up on a phone to answer one quick question.

- **Desktop** — wide viewport, pointer, lots of horizontal room. The implicit
  default the views are built and verified against: multi-column tables,
  side-by-side charts, hover affordances. This is where deep, multi-view
  triangulation (the Practitioner's mode) actually happens.
- **Mobile** — narrow viewport (~375–430px), touch, portrait-first. A reader
  here wants one answer fast, can't hover, and can't read a 12-column table
  without side-scrolling. The canonical mobile job is the glance — "am I about
  to hit my session/weekly cap?" (gap G1) — checked between other things, not a
  working session. Layouts must reflow (stack, not side-scroll), controls must
  be tap-sized, and the primary answer must survive without the surrounding
  chrome.

Most personas live on desktop while *working* but reach for mobile for the
glance-jobs. Per-persona tags (*mobile-glance* = leans desktop but has a real
phone-checked job):

| Persona | Form-factor lean | Why |
|---|---|---|
| P1 Sam | desktop *(mobile-glance)* | Codes on desktop, but checks "am I near my cap?" (G1) from his phone |
| P2 Priya | desktop | Instruments a team from a workstation; reads dense multi-view comparisons |
| P3 Quentin | desktop | Authoring skills/plugins is a pointer-and-keyboard job |
| P4 Devi | desktop *(mobile-glance)* | Wires permissions on desktop, but may eyeball an unattended run's status on mobile |
| P5 Riley | desktop | Cross-session research needs side-by-side density |
| P6 Casey | desktop *(mobile-glance)* | The "what's my bill / am I about to overspend?" glance is a phone job |
| P7 Owen | desktop | Account-wide CLI evaluation is a sit-down comparison |
| P8 Marcus | desktop | Curating a catalog spans many dense views |
| P9 Nora | agnostic | Form-factor-agnostic the way she's scope-agnostic — her needs are presentational (zoom, contrast, semantics) at whatever device the answer lives on |
| P10 Aya | n/a | A machine consumer reads the data contract, not a viewport — form factor doesn't apply |
| P11 Tariq | desktop | Configures and works entirely inside one repo at a workstation |
| P12 Gabriela | desktop *(mobile-glance)* | All-global tooling from a laptop, but hops between client sites and may check on her phone |

**How to use it:** when speccing or verifying a feature, name the form factor,
not just the persona — "does the *mobile-glance* variant of Sam get his answer
on a 390px screen, or only the desktop one?" If a view's primary job is a
glance-job (G1, G2), it must *pass* on mobile, not merely "not break." A feature
that only works at a wide pointer viewport is unfinished the same way a rec
phrased only at the wrong scope is. The per-view mobile parity check lives in
[`mobile-parity-audit.md`](./mobile-parity-audit.md).

---

## 2. Skill levels

The personas above all assume a baseline of competence with Claude
Code. In practice, every persona shows up at three different skill
bands, and the dashboard today is implicitly tuned for one of them
(the Practitioner). A persona × skill-level cell is what an IA
decision really has to satisfy.

### S1. Newcomer

First week, maybe first day. Doesn't yet know what a "compaction
event" is, why cache reads are good, or what the difference is between
`bypassPermissions` and `acceptEdits`. Probably arrived from a tweet
or a teammate's recommendation.

- **Needs:** Labels in plain English. A glossary tooltip on every
  jargon term. A "what is this view for?" caption above each chart.
  Sane defaults (the right time range pre-selected). Fewer choices —
  cards over tables, ranked lists over scatter plots. Top-of-funnel
  framing: *"Here's the one thing to look at first."*
- **Over-served by today's UI:** Recommendations is excellent here —
  every row has plain-English explanation and a `fix` snippet that
  works as documentation even if you never paste it.
- **Under-served by today's UI:** Insights, Stats, Tokens, Context
  Health all assume you know what the axes mean. Conversation /
  Patterns are nearly opaque without prior knowledge.

### S2. Practitioner

The dashboard's current implicit audience. Comfortable reading raw
stats, knows what cache reads are, can interpret a model-mix
recommendation, will happily switch between five views to triangulate
a question.

- **Needs:** Raw numbers visible, filters, multi-view comparison,
  the ability to deep-link from one view to another (already partly
  there via `Recommendations` `view` field).
- **Over-served by today's UI:** Most of it — the Practitioner is the
  audience the views were written for.
- **Under-served by today's UI:** Cross-view comparison is awkward
  (you can't put two charts side by side), and there's no WoW delta
  *anywhere* — see gap G2.

### S3. Power user

Wants the data. Will write their own Grafana board if you don't ship
JSON endpoints. Considers any chart they can't reproduce from the
dataset a black box. Cares about reproducibility (committing CLAUDE.md
recipes), batch analysis, scripting against the data.

- **Needs:** Raw JSON export of every view (`curl /api/dataset.json`,
  already exists; per-view endpoints, not yet). Queryable timelines.
  CLAUDE.md / settings.json snippets that are committable as-is.
  Stable IDs for sessions, recommendations, and tools so they can
  diff across snapshots.
- **Over-served by today's UI:** Insights' narrative summary is just
  noise for this band — they want the underlying signals.
- **Under-served by today's UI:** No documented JSON contract for
  individual views; no diff/delta API; no "subscribe to changes."
  Overlaps with what persona P10 (agents-as-consumers) needs — same
  capability, different audience.

### Cross-cutting implication

The five-section IA in §6 has to *not* break the Newcomer while still
serving the Power user. The cleanest way to do that is to keep the
**Act** landing aggressively curated (Newcomer-friendly: ranked,
labelled, with explanations) and let the rest of the nav fan out into
denser views (Practitioner default, Power-user-extensible via
exports). Insights stays as the "story for skim-readers" surface, one
click away.

---

## 3. View audit

Walking the 18 top-level views (in `Layout.tsx` order) plus the
modal-y views (`Settings`, `AskClaude`, `FileUpload`). For each: one
line on what it does, the personas it serves, and the jobs it answers.
Orphans are called out explicitly.

| View | File | Job served | Personas | Verdict |
|---|---|---|---|---|
| **Insights** | `Insights.tsx` (composes `InsightsReport` + `InsightsMetrics`) | "Tell me a story about my Claude Code use" — narrative + charts mirroring `/insights` | Sam, Riley (skim), Priya (skim) | Keep, but as a landing-page summary, not the dumping ground for every chart |
| **Recommendations** | `Recommendations.tsx` (engine in `lib/recommendations.ts`) | "What should I change this week, with copy-paste fixes" — ranked, dollar-quantified, with `fix` snippets | Casey, Devi, Priya, Sam | **Keep + promote.** This is the most opinionated, most actionable view in the app. It should be the default landing page, not Insights |
| **Sessions** | `SessionList.tsx` | "Browse a session in detail" | Sam, Riley, Priya | Keep |
| **Projects** | `ProjectBreakdown.tsx` | "Per-project rollup + activity heatmap" | Priya, Sam | Keep — but merge the heatmap into Activity |
| **Search** | `SearchView.tsx` | "Find a specific prompt across all my history" | Riley, Sam | Keep |
| **Stats** | `UsageStats.tsx` | "Usage-by-day, tool-counts pie, project-counts pie — the most generic 'overview' view" | None cleanly | **ORPHAN — candidate to retire.** Every chart here is duplicated more usefully in Insights, Tokens, or Activity. It's the canonical "shotgun stats" view |
| **Tokens** | `TokenUsage.tsx` | "Token + cost breakdowns with model-swap math" | Casey, Sam, Devi | Keep — merge with Cost (see consolidation #2) |
| **Tool Usage** | `ToolUsage.tsx` | "Which tools fire, native-bypass detector, repeated commands, tool effectiveness" | Quentin, Priya, Devi | Keep |
| **File Impact** | `FileImpact.tsx` | "Which files get re-read or churned, with reread spans" | Sam, Priya | Keep — folds nicely under a "Workflow" section |
| **Cost** | `CostAttribution.tsx` | "Cost by tool / project / session" | Casey, Priya | **Merge into Tokens.** Same numbers, different pivot; current split forces Casey to bounce between two views |
| **Timeline** | `SessionTimeline.tsx` | "Per-session event stream with inter-message deltas" | Riley, Sam (debugging) | Keep — but it's a *drill-down*, not a top-level view. Move under Sessions |
| **Activity** | `ProjectActivity.tsx` | "Calendar / hour-of-day heatmap + project momentum" | Sam, Priya | Keep |
| **Errors** | `ErrorRetry.tsx` | "Tool error rates, API error statuses, retry pressure, retry sequences" | Devi, Priya, Sam | Keep |
| **Permissions** | `Permissions.tsx` | "Permission-mode entries, dangerous commands, prompt-prone tools, safety scores" | Devi, Priya | Keep |
| **Agents** | `AgentSkill.tsx` | "Sub-agents + skills invoked, MCP usage, turn latency, automation feed" | Quentin, Priya | Keep — this is Quentin's home view and deserves more prominence |
| **Context Health** | `ContextHealth.tsx` | "Context growth, cache efficiency, compaction risk, session health score" | Sam, Casey, Priya | Keep — merge with Tokens (see consolidation #2) |
| **Conversation** | `ConversationPatterns.tsx` | "Turn structure, latency histogram, question/code-block ratios" | Riley | Keep — rename **Rhythm Lab** (turn texture). *C4 reversed (#142): different research question from Shape, not an orphan* |
| **Patterns** | `SessionPatterns.tsx` | "Cluster sessions by shape, rank top/bottom" | Riley | Keep — rename **Shape Atlas** (arc shape). *C4 reversed (#142): keep both lenses, grouped under Analysis* |

Modal / non-nav views:

| View | File | Purpose | Verdict |
|---|---|---|---|
| **Settings** | `Settings.tsx` | API key + default model for Ask Claude | Keep as modal |
| **Ask Claude** | `AskClaude.tsx` | Free-form "ask my dashboard questions" using the user's own key | Keep — but only valuable once the dashboard surfaces *less* on its own. Today it competes with Insights instead of complementing it |
| **File Upload** | `FileUpload.tsx` | One-shot upload for someone without server access | Keep |

### Tally

- **Keep as top-level:** Recommendations, Insights, Sessions, Projects,
  Search, Tools, Files, Activity, Errors, Permissions, Agents,
  Patterns. **(12)**
- **Demote to drill-down:** Timeline (under Sessions).
- **Merge:** Cost + Context Health → Tokens (or, better, the new
  "Spend & Risk" view in §6). Conversation → Patterns.
- **Retire outright:** Stats. Every chart in it appears more usefully
  elsewhere.

That gets us from 18 → 11 top-level views before we even re-bucket.

**Scope lens:** some of these views are inherently *project-scoped*
(Projects, Activity's per-project momentum, File Impact) while others
roll up to the *account/global* level (Recommendations, Tokens/Cost,
Insights). When deciding a view's home — or whether an orphan earns its
slot — argue it against the reader's scope tag (see **Scope axes**): a
view that only answers a project-user's question shouldn't be pitched as
a global landing, and a global rollup shouldn't be buried as if it were
one repo's concern. "Would the *project-user variant* of this persona
actually go here?" is the test.

---

## 4. Gaps — jobs no view serves well

The audit makes the *missing* views obvious.

### G1. "Am I about to hit my session/weekly cap?" (Sam, Casey)

No view answers this. There is `lib/cost-trend.ts` and there is the
`session-usage` skill that reads live rate-limit headers, but the
dashboard has no native widget that says **"you're 62% through this
week's cap, on pace for 95% by Friday."** This is the single most
common question a Pro-plan user asks themselves mid-day.

**Action:** Add a `BudgetGauge` component to the landing page —
weekly cap %, session-window %, projected end-of-week. Pull from the
same headers the `session-usage` skill uses.

### G2. "What changed this week vs last week?" (Priya, Casey)

The closest we have is `lib/cost-trend.ts` for cost, but there is no
*delta view* anywhere. Priya wants "we burned 1.7× last week and
here's where the delta came from." Casey wants "I downshifted to
Sonnet on Monday — did the bill actually drop?"

**Action:** A `WeeklyDelta` view (or a banner across Recommendations)
showing top-3 movers WoW for cost, errors, retry storms.

### G3. "Which skills/agents are pulling their weight?" (Quentin)

`AgentSkill.tsx` shows invocations and effectiveness, but does not
have the **with-vs-without** comparison Quentin actually wants
("sessions invoking my skill cost $X median, sessions not invoking
it cost $Y median"). The `parse-agent-effectiveness.ts` library has
the raw signals — it needs a comparative view on top.

**Action:** Add a "Skill ROI" panel inside Agents.

### G4. "Show me my session right now while it's running" (Sam)

The whole dashboard is retrospective. Nothing surfaces the
**in-flight** session. The live server reads `~/.claude` every
request, so the data is there — we just don't render an "active
session" view.

**Action:** A `LiveSession` widget on the landing page when an active
transcript is detected.

### G5. "What's safe to allowlist?" (Devi)

`rulePromptFriction` in `recommendations.ts` emits a great Bash
allowlist snippet, but the *interactive* "scan my transcripts and
propose this list" lives in the external `fewer-permission-prompts`
skill, not the dashboard. Devi would benefit from running that *in
the UI*.

**Action:** Promote the existing recommendation's `fix` snippet into
a dedicated "Allowlist builder" panel in Permissions, with a
copy-pasteable diff of `settings.json`.

---

## 5. Consolidation moves

Five concrete moves, in priority order. Each replaces a vague "more
charts" feeling with a job-shaped answer.

### C1. Make **Recommendations** the default landing page, not Insights.

Insights is a *story*. Recommendations is *what to do about it*.
Today, a new visitor lands on Insights and has to scroll through
charts to find the action. Flip them: Recommendations first
(ranked, with $-quantified `fix` snippets), Insights as the
"narrative" tab one click away.

Why this works: every persona except Riley (the researcher) opens
the dashboard with an *action* in mind, not a story. Insights stays
intact and on the nav; we just stop making it the default.

### C2. Merge **Tokens + Cost + Context Health** into a single "Spend & Risk" view.

*Reconciled per #142 (Sam P1, Casey P6, Priya P2): keep the merge, with
the three amendments below — these supersede the original noun-labelled
three-tab shape.*

These three views all answer the same fundamental Casey/Sam question:
*"why is this week expensive?"* — but they slice the same data three
ways and force the user to bounce between tabs.

- Tokens has the time-series + the model-swap math.
- Cost has the by-tool / by-project / by-session pivots.
- Context Health has the cache-efficiency + compaction-risk
  *explanation* for why a session was expensive.

One view, three sections. Reconciled decisions:

- **Tab labels are verbs, not nouns (Casey).** Label the three sections
  **"Did I downshift?"** (time-series + model-swap math), **"Where did
  it go?"** (by tool, by project, top sessions), and **"Why so much?"**
  (cache efficiency, context growth, compaction risk) — *not* the noun
  labels "Spend / Where it went / Why it was expensive".
- **Context-spill is a landing yes/no, not tab #3 (Sam).** Surface
  *"did context spill past 200K?"* as a yes/no badge on the view's
  landing, so Sam learns a session blew the window without opening the
  third ("Why so much?") tab.
- **Split the "Risk" label (Priya).** "Risk" conflates two unrelated
  semantics — risk-as-cache (am I wasting money on cache misses /
  compaction?) versus risk-as-`rm -rf` (did something dangerous run?).
  Only the spend-side sense belongs in Spend & Risk; the dangerous-
  command sense stays in **Safety**. Don't let one "Risk" word imply
  both.

All the recommendations whose `view` field currently points to `cost`,
`tokens`, or `context` deep-link into this one page.

### C3. Move **Timeline** under **Sessions** as a tab.

`SessionTimeline.tsx` only makes sense for a specific session —
that's exactly what `SessionList.tsx` already opens to. Having it as
a top-level nav item is a vestige of when sessions were not browsable
in detail. Make it a "Timeline" tab inside the session detail page.

### C4. ~~Absorb **Conversation Patterns** into **Patterns**.~~ — **Reversed (#142).**

*Reconciled per #142 (Riley P5): do **not** merge.* The original move
claimed both views "answer 'what shape are my sessions?'" — but they
don't. `SessionPatterns.tsx` (timeline-shape clustering) answers *arc
shape*; `ConversationPatterns.tsx` (turn structure, latency histogram)
answers *turn texture*. Those are different research questions, and
collapsing them loses a lens Riley relies on.

Keep both, renamed for what they actually answer, grouped under a single
**Analysis** section:

- **Shape Atlas** — `SessionPatterns.tsx`, the arc-shape clusters
  (*"what shape do my sessions take?"*).
- **Rhythm Lab** — `ConversationPatterns.tsx`, turn texture + latency
  (*"what's the turn-by-turn rhythm?"*).

The original "same data, half the nav noise" rationale doesn't hold:
it's different data answering different questions. Two leaves is the
correct price for keeping both lenses.

### C5. Retire **Stats** entirely.

`UsageStats.tsx` is the canonical shotgun-stats view: an activity-by-
day bar chart (already in Activity), a tool-counts pie (already in
Tools), a project-counts pie (already in Projects). Every chart has a
better home elsewhere. Delete the view, redirect any
`view: 'stats'` deep-links to Activity.

### C6 (bonus). Promote the **Recommendations $-savings** number to a global header chip.

`totalEstimatedSavings()` already exists. Show it at the top of every
page: **"$X recoverable — 3 fixes"**. Sam, Casey, and Priya all
benefit from never losing sight of the action lever.

---

## 6. Revised top-level IA

The original five-section nav (Act / Spend / Workflow / Safety /
Explore) holds up under the expanded persona set, but two things
sharpen: **Workflow** gets meaningfully heavier (it has to serve both
Quentin's attribution job *and* Marcus's pruning job), and Owen
(P7, Codex refugee) wants something none of the five sections cleanly
deliver — a one-screen "agent report card" comparing his Claude Code
runs to whatever he was using before. The fix is not a sixth section;
it's a new view inside **Act**.

### What we re-checked against the expanded set

- **Codex refugees (Owen):** They want a comparison-shaped landing,
  not a story and not a charts dump. Putting them on the existing
  **Recommendations** landing works only halfway — Recommendations
  answers "what should I change?" but not "is this thing worth using
  in the first place?". We add an **Agent Report Card** card *to the
  Act landing*, summarising median task cost, p50/p95 tool-call
  latency, retry storm rate, and reread-loop fraction. Owen can
  screenshot it. Sam and Casey benefit too — same numbers, same
  surface.
- **Plugin/skill authors (Quentin + Marcus):** Two adjacent jobs,
  same data spine. We keep both inside **Workflow → Agents**, but
  the Agents view splits into two clearly labelled panels:
  *Attribution* (Quentin: who used my skill, did it shorten the
  session?) and *Catalog Utilization* (Marcus: which of my entries
  fired this sprint, which are retire-candidates?). Issues #106 / #109
  / #112 land into the Catalog Utilization panel.
- **Newcomers:** The 5-section nav is still legible — five top-level
  labels, every label is a verb-phrase job. The risk is the **Act**
  landing being too dense once we add the Agent Report Card and the
  Budget Gauge. Mitigation: ranked cards, not side-by-side charts;
  each card collapses to a one-liner with a "more" affordance.
- **Power users + Aya (P10, agents):** No nav change addresses them
  directly. They need a *constraint*: every view in every section
  must back onto a stable JSON endpoint. The nav doesn't get a new
  section; the spec does (see "Cross-cutting requirements" below).

### Is "Recommendations" still the right landing?

Yes — with a caveat. Recommendations remains the right *default*
because it is:

- always fresh from the parsed dataset (no `/insights` slash-command
  dependency, no stale `~/.claude/usage-data/` files),
- ranked across all categories, so a critical safety finding always
  beats a cosmetic cost finding,
- already action-shaped — every row ships with a `fix` snippet.

The caveat is that Owen and Marcus don't open the app to *fix* — they
open it to *evaluate*. So the landing isn't *just* Recommendations
anymore; it's the **Act** surface, which has Recommendations as its
spine plus three sibling cards (Budget Gauge, Weekly Delta, Agent
Report Card). The static default route still resolves to
`recommendations` for now — that view is the most-actionable, most
always-fresh, and the most reasonable thing for *any* persona to see
first. Promoting the whole **Act** surface as a composite landing is
a follow-up once those sibling cards exist.

For Newcomers specifically: Recommendations is the kindest first
surface in the whole app — every row has plain-English framing and a
copy-pasteable fix that doubles as documentation.

### Act *(default landing)*
*"What should I change this week — and is this agent even worth it?"*

- **Recommendations** — ranked, $-quantified, with copy-pasteable
  fixes. *(spine of the landing, today's default route)*
- **Budget Gauge** — weekly cap %, session-window %, projected
  end-of-week. *(new — fills gap G1)*
- **Weekly Delta** — top-3 movers WoW. *(new — fills gap G2)*
- **Agent Report Card** — median task cost, p50/p95 tool-call
  latency, retry storm rate, reread-loop fraction.
  *(new — serves Owen, P7; data exists in `parse-tool-effectiveness.ts`
  + `parse-runtime-events.ts`)*

Serves: **Sam, Casey, Priya, Devi, Owen.** (Newcomer-friendly by
construction — ranked cards, plain labels, every row explains itself.)

### Spend
*"Why was this week expensive, and what would Haiku save?"*

- **Spend & Risk** — merged Tokens + Cost + Context Health.
  *(consolidation C2, reconciled per revised §5)*
  - Tabs (verb labels): *Did I downshift?* · *Where did it go?* ·
    *Why so much?*
  - Landing badge: *did context spill past 200K?* (yes/no, not buried
    in a tab). "Risk" here is spend/cache risk only — dangerous-command
    risk lives in **Safety**.

Serves: **Casey, Sam, Priya, Owen** (per-task cost comparison).

### Workflow
*"Where is my agent doing busywork — and is my own tooling earning
its slot?"*

This is the section that grows the most under the expanded persona
set. It is now home to two distinct jobs that share a data spine.

- **Tools** — `ToolUsage.tsx`, with the existing native-bypass +
  effectiveness panels.
- **Files** — `FileImpact.tsx`, churn + redundant reads.
- **Agents** — `AgentSkill.tsx`, restructured into two clearly
  labelled panels:
  - *Attribution* — Quentin's panel. With-vs-without comparison per
    skill/agent/MCP. *(fills gap G3)*
  - *Catalog Utilization* — Marcus's panel. Every custom entry +
    last-fired, effectiveness, retire/promote verdict. *(lands
    #106 / #109 / #112)*

Serves: **Quentin, Marcus, Sam, Priya, Owen.**

### Safety
*"What ran without permission, and what should be allowlisted?"*

- **Permissions** — modes, dangerous commands, safety scores,
  **plus** the new "Allowlist builder" panel. *(fills gap G5)*
- **Errors** — `ErrorRetry.tsx`, tool error rates + API error
  statuses.

Serves: **Devi, Priya.**

### Explore
*"Tell me a story / let me poke around."*

- **Insights** — narrative `/insights` report. *(no longer default;
  also: only as fresh as the last `/insights` run, which is exactly
  why it can't be the landing — the `~/.claude/usage-data/` directory
  only updates when the CLI skill runs)*
- **Sessions** — list + drill-down. **Timeline** moves here as a tab
  under each session. *(consolidation C3)*
- **Search** — full-text search.
- **Projects** — per-project rollup. Activity heatmap absorbs into
  the per-project drill-down.
- **Activity** — calendar + hour heatmap (the global view).
- **Shape Atlas** + **Rhythm Lab** — the two pattern views kept
  separate and renamed under an **Analysis** grouping. *(C4 reversed
  per revised §5 — they answer different research questions; not
  merged)*

Serves: **Riley, Sam (browsing), Priya (drill-down), Marcus
(post-hoc inspection of which sessions invoked his skills).**

### Cross-cutting requirements (for Power users + Aya)

These aren't nav items — they're constraints on every nav item:

- Every chart's underlying data must be reachable as JSON. Minimum:
  `/api/dataset.json` (exists) + `/api/recommendations.json` (TODO).
  Per-view endpoints follow.
- Stable IDs for sessions, recommendations, and custom tools, so
  power users and agents can diff across snapshots.
- `fix` snippets stay copy-pasteable as committed files — no
  rewrites that require a UI.

### What got dropped

- **Stats** — retired entirely (consolidation C5).
- **Cost** — merged into Spend & Risk.
- **Context Health** — merged into Spend & Risk.
- **Tokens** — merged into Spend & Risk.
- **Conversation** — *not* dropped: kept as **Rhythm Lab** under
  Analysis (C4 reversed, see §5).
- **Timeline** — demoted to a tab under Sessions.

**Net:** 18 top-level views → ~13 leaves (the C4 reversal keeps the
Rhythm Lab leaf rather than absorbing it), with the action-first views
(now including Owen's report card) in front and the exploration views in
back. The "shotgun" feeling goes
away because every section answers one question, and the expanded
persona set didn't force a sixth section — it forced one new card
inside **Act** and a two-panel split inside **Agents**.

---

## 7. What we are NOT recommending

Worth saying out loud, so the next contributor doesn't undo this:

- **Don't add a Compaction Risk top-level view.** It is a *signal*
  used by Recommendations and a *panel* inside Spend & Risk. It is
  not its own job.
- **Don't add a Model Recommendation top-level view.** Same — it is
  the engine behind a *recommendation*, not a destination.
- **Don't split Recommendations by category** (Cost tab, Safety
  tab…). The ranking is the whole point. A user with a critical
  safety finding and a $0.05 cost finding should see the safety one
  on top, not have to know to click "Safety" to find it.
- **Don't move Ask Claude to the top nav.** It is a fallback for
  "the dashboard didn't anticipate my question." If we're surfacing
  the right jobs, it's secondary.

---

## 8. How to use this document

If you're about to add a new view, panel, or chart:

1. Name the persona who asked for it. If you can't, the work
   probably belongs in `lib/` not `components/`.
2. Name the job (`When I X, I want Y, so that Z`).
3. Find the existing section it belongs to. If it doesn't fit, this
   document is wrong — update it first.
4. If the new thing replaces something, *delete the old thing in the
   same PR*. The whole point is to fight accretion.
