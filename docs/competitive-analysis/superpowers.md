# Superpowers (obra/Superpowers)

## Source

- URL: https://github.com/obra/Superpowers
- Date captured: 2026-06-17
- Category: Adjacent product / Inspiration (prescriptive agent methodology + cross-harness skills framework)
- Related issues: #1874 (this note); docs-tracking #926

## What It Is

A cross-harness **agentic skills + software-development methodology** framework by
Jesse Vincent (`obra`, of Prime Radiant; creator of Request Tracker and
Keyboardio). Tagline, verbatim:

> "An agentic skills framework & software development methodology that works."

It ships ~14 composable **skills**, each a single `SKILL.md` file — Markdown with
YAML frontmatter and a few hundred words — that encode one engineering practice:
`test-driven-development`, `systematic-debugging`, `brainstorming`,
`writing-plans`, `subagent-driven-development`, `verification-before-completion`,
`writing-skills` (the meta-skill for authoring more), `using-superpowers` (the
bootstrap). A sub-2,000-token bootstrap document injects the methodology at
session start and tells the agent to invoke a relevant skill before doing
anything else.

The signature mechanic is the **Iron Law + Red Flags** pattern: each skill opens
with a capitalized non-negotiable rule (e.g. `NO PRODUCTION CODE WITHOUT A
FAILING TEST FIRST`, `NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE`)
followed by a table of the rationalizations agents use to dodge it ("should",
"probably", "just this once"). The stated philosophy: agents lack *discipline*,
not capability, and "that discipline can be distributed as plain text" — the Iron
Laws are anti-rationalization barriers, not tutorials.

The end-to-end loop it orchestrates: brainstorm → git worktree → written plan →
subagent-driven implementation with TDD inside → fresh-agent code review →
finishing/verification; the next phase will not begin until the previous one is
done.

Distribution: a **plugin** across many harnesses (Claude Code via the official
Anthropic marketplace or the Superpowers marketplace; plus Cursor, Codex,
Antigravity, Gemini CLI, GitHub Copilot CLI, Kimi Code, OpenCode, Pi) through
thin host-specific manifests over a portable `skills/` directory. MIT licensed;
mostly Shell + JavaScript. No MCP integration. Optional, env-disablable telemetry
(`SUPERPOWERS_DISABLE_TELEMETRY`). It does **not** read or analyze session
history — it operates purely through hooks and skill invocation inside new
conversations.

## User Job

Make a coding agent *behave* like a disciplined senior engineer in the moment —
design before code, tests before implementation, root-cause before fix, evidence
before "done" — by injecting prescriptive guardrails at the start of and during a
task. It is about **prescribing** good agent behaviour up front, not measuring
whether that behaviour paid off afterward.

## What It Does Well

- **Codified agent-behaviour discipline as portable plain text.** The Iron
  Law + Red Flags format is a clean, reusable way to express a workflow/
  reliability rule that an agent will actually follow — the same problem space
  our recommendation engine targets, solved on the *prescription* side.
- **Cross-harness from day one.** Host-agnostic skills behind thin per-harness
  manifests — the same skills-as-portable-Markdown mechanic we use for
  `~/.agents/skills`, and aligned with our vendor-neutral / any-harness stance.
- **End-to-end methodology, not a single tip.** It composes the phases
  (brainstorm/plan/implement/review/verify) into one enforced loop with hard
  gates between phases, including subagent-driven implementation and git-worktree
  isolation — practices we run by hand (see our `tdd`, `diagnose`, `grill-me`,
  `verify`, `write-a-skill` skills and the worktree discipline in `AGENTS.md`).
- **A real, mineable corpus of best-practice content** with a large mindshare
  (Anthropic-marketplace plugin, very high star count), making it a credible
  reference vocabulary for what the field considers "good agent behaviour."

## Where Claude History Dashboard Is Stronger

- **Evidence vs. assertion.** Superpowers asserts best practice a priori as fixed
  text; it has no feedback loop proving an Iron Law actually lowers cost or raises
  accuracy on a given codebase/agent. Our v0.4 proof-engine pivot is exactly that
  causal loop (shadow / replay / race over real history). We can *measure* what it
  *prescribes*.
- **No history, analytics, cost, or evaluation layer at all.** It never reads
  `~/.claude`. Our entire observability + coaching product — cost, context health,
  retries, tool usage, permissions, file impact, sessions, recommendations — is
  absent here, and our local-history moat is untouched.
- **Recommendations are derived, not hand-authored.** Our recs come from
  measured agent behaviour in real sessions; its skills are curated by a
  maintainer who "doesn't generally accept contributions of new skills." We adapt
  to the user's actual history; it ships one fixed opinion to everyone.

## Product Implications

- **Between a source of recs and a competitor — and that is the useful tension.**
  On the *analytics* axis it is not a rival (no history, no measurement). On the
  *coaching/recs* axis it is the closest **prescriptive** analog to what our recs
  engine delivers — so it is both a content source and a positioning foil.
- **Mine its skill corpus as candidate recommendation rules.** Its Iron Laws map
  cleanly onto our recs taxonomy (workflow, context, reliability, safety):
  test-first, verify-before-done, root-cause-before-fix, design-before-code. They
  are a curated input to the dynamic rule engine (#189) and external-guidance
  ingestion (#656) — and a vocabulary cross-check for our rule naming.
- **It is the ideal thing to measure.** Each Iron Law is a falsifiable hypothesis
  ("test-first reduces rework cost", "fresh-agent review catches more defects").
  Our proof loop can validate or refute them on real sessions — turning a
  prescriptive framework into evidence. This is the sharpest expression of the
  proof-engine moat (v0.4): we don't argue methodology, we adjudicate it.
- **"Instrument it, don't fight it"** — the same response we settled on for
  Omnigent and rh-agent. Superpowers *produces* disciplined sessions; we *analyze*
  whatever sessions exist, across harnesses. Its adoption grows the corpus our
  engine reads.

## Existing Coverage

| Observation | Status | Evidence / issue |
|---|---|---|
| Prescriptive agent-behaviour discipline (Iron Laws) overlaps our recs job | No action | Positioning context; coaching-axis foil, not an analytics rival |
| Skill corpus is a candidate input to recommendation rules | Backlog | Dynamic rule engine #189; external-guidance ingestion #656 |
| "Validate a prescribed skill on real history" is our differentiator | Backlog | v0.4 proof-engine pivot (shadow/replay/race); no new issue needed |
| No history/analytics/cost/eval layer (pure prescription) | No action | Our observability + local-history moat is uncontested |
| Cross-harness skills-as-Markdown distribution mechanic | No action | We already ship recs-as-skills via `~/.agents/skills`; note only |

## Follow-up

- Backlog issue: none new — its rule-mining value is already covered by #189 /
  #656, and the "measure what it prescribes" angle is the existing v0.4 proof
  pivot. Re-evaluate only if we decide to seed a recs ruleset directly from its
  Iron Laws (then file a child of #189).
- Documentation issue: tracked under docs #926; this note files #1874.
- Non-goal: do not re-file Superpowers as a build item or attempt to clone its
  prescriptive framework — our wedge is measurement of methodology, not shipping
  another fixed one.
