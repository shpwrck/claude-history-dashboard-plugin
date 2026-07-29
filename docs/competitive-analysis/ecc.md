# ECC (affaan-m/ECC)

## Source

- URL: https://github.com/affaan-m/ECC — website https://ecc.tools
- Date captured: 2026-07-29
- Category: Adjacent product (supply-side agent harness OS) / Inspiration — **not** a direct dashboard competitor
- Related issues: #3440 (this note); recon output filed as #3443, #3444, #3445, #3446, #3447, #3448, and shpwrck/agent-skills#23, #24
- Release/watch cadence: daily pushes; 2.x line, release notes under `docs/releases/`
- Last checked: 2026-07-29

## What It Is

> "The agent harness performance optimization system. Skills, instincts, memory,
> security, and research-first development for Claude Code, Codex, Opencode,
> Cursor and beyond."

A prescriptive engineering methodology plus toolbox, installed *into* the harness:
281 skills, 67 agents, 94 slash-command shims, hooks, and language/framework rule
packs, targeting Claude Code, Codex, Cursor, OpenCode, Gemini CLI, Zed and Kimi.
The pitch is the loop "plan → test → implement → review → verify → remember →
improve" — the agent does not improvise its own workflow.

Scale and distribution, from the GitHub API on the capture date:

| | |
|---|---|
| Created | 2026-01-18 (~6 months old) |
| Stars / forks / watchers | 235,247 / 35,833 / 1,224 |
| License | MIT |
| Last push | 2026-07-29 (daily) |
| Distribution | Claude Code plugin (`ecc@ecc`), npm (`ecc-universal`, `ecc-agentshield`), GitHub App, Discord, 12 translated READMEs |
| Commercial | Pro $19/seat/mo; Enterprise custom — hosted GitHub App doing config/harness security scanning (AgentShield) |

235k stars in six months would place it near the all-time GitHub top tier. The
number is what the API reports; star provenance has not been independently
verified and should not be treated as 235k active users without further evidence.

**AgentShield's advertised 102-rule engine is not in the open repository.**
`SECURITY.md:50` says so outright; every other reference to it (`README.md:740`,
`docs/ECC-PRO-SECURITY-ROADMAP.md:237,261`) is prose. The OSS repo is the funnel;
the paid scanner is closed and cannot be inspected or compared rule-by-rule.

## User Job

"Make my coding agent behave like a disciplined senior engineer, on whichever
harness I use." It is a **supply-side** product: it ships the methodology,
skills, and enforcement the agent runs *with*.

The dashboard's job is the demand side of the same relationship: "tell me — with
evidence from my own history — which of those changes actually paid off." ECC
supplies practice; we measure it. That distinction is the whole competitive
story.

## What It Does Well

- **Distribution.** Plugin + npm + GitHub App + Discord + marketplace + i18n, with
  an explicit "official sources only" supply-chain warning in the README. This is
  the most complete distribution surface in the category by a wide margin.
- **Cross-harness reach.** Seven harnesses via per-target adapters, with install
  profiles (`manifests/install-profiles.json`) and an install/repair state machine.
- **Prose-artifact CI.** `tests/` validates skills, agent instructions, hooks,
  commands, and doc surfaces — including a Unicode-safety scan
  (`scripts/ci/check-unicode-safety.js`) and a personal-path scan. Testing
  Markdown as a build artifact is a discipline worth having.
- **Hook craft.** One-registration in-process dispatchers, per-hook enable gating,
  and a `/tmp` session-bridge aggregate so PostToolUse hooks never rescan large
  JSONL.
- **Instrumentation reach into cost.** `scripts/hooks/cost-tracker.js` sums
  per-turn usage from the session transcript into `~/.claude/metrics/costs.jsonl`;
  `ecc-metrics-bridge.js` + `ecc-context-monitor.js` maintain a live session
  aggregate and inject agent-facing warnings at context-% and cost thresholds
  ($5 / $10 / $50).

## Where Claude History Dashboard Is Stronger

- **Epistemics — the load-bearing difference.** ECC's `continuous-learning-v2`
  scores learned "instincts" by *frequency*: 1-2 observations = 0.3 confidence,
  11+ = 0.85, +0.05 per confirmation, −0.02/week decay
  (`skills/continuous-learning-v2/agents/observer.md:130-140`). There is no
  control, no baseline, no counterfactual. That is frequency dressed as
  probability — precisely the claim class `claimClass`/`proofTier` (ADR 0017,
  `src/lib/detectors/types.ts:399-416`) exists to keep out of our output. Our
  asOf/staleness demotion and suppression transitions handle decay more honestly
  than a fixed weekly decrement.
- **Observation substrate.** They capture behaviour through PreToolUse/PostToolUse
  hooks into `observations.jsonl`, paying a per-tool-call cost and seeing only
  what a hook sees. We read the real transcripts — strictly richer, at zero
  runtime cost to the user's session. Their capture file carries the scars of the
  approach (ReDoS #2278, SIGALRM bail #2300, counter race #2296).
- **Usage dedupe correctness.** Their `cost-tracker.js:103-147` dedupes usage by
  message id with last-write-wins; our `parse-sessions.ts:270-306` max-merges per
  field. Their current behaviour is the bug we fixed in #457.
- **Analytics surface.** Their "dashboard" (`scripts/dashboard-web.js`,
  `ecc_dashboard.py`) is a *capabilities browser* — a catalogue of their own
  agents/skills/commands on :3456. No session analytics, no cost attribution over
  history, no `/insights` ingestion, no context-health, timeline, or error/retry
  views. The pricing page advertises no usage analytics or team observability.
- **Independence.** `SPONSORING.md` sells README placement at $200/$800/$3,700
  tiers. Paid placement is incompatible with an independent proof engine, and we
  should keep saying so.

## Product Implications

The recon's most useful output was **not** a list of things to copy. Combing ECC
across eight dimensions produced 45 candidates; adversarial verification rejected
18 and promoted 27 (2 adopt-as-is, 25 adapt), and the survivors were
overwhelmingly *defects in our own tree that ECC's checklist exposed*:

1. `src/lib/context-health.ts:12` hardcodes `OVER_WINDOW = 200_000` across seven
   call sites, so a 1M-window session peaking at 400K scores 100% and is flagged
   over-window — a manufactured false finding (#3443).
2. `groupWorktrees` (`src/lib/parse-history.ts:204`) keys on `/.claude/worktrees/`
   while ours live at `<repo>/.worktrees/` — it matches zero of them, silently
   splitting per-project cost and recommendations (#3444).
3. 20 of 48 `scripts/*.test.mjs` never execute in any of our 17 workflows (#3445).
4. `.claude-plugin/plugin.json:11` asserts `"license": "MIT"` to the marketplace
   with no LICENSE file backing it (owner decision pending).

Attribution exposure is minimal: exactly one adopted item would copy ECC code
(the invisible-codepoint table in `scripts/ci/check-unicode-safety.js:109-143`,
MIT, noted in shpwrck/agent-skills#23). Everything else is idea-adoption or clean
reimplementation.

**Positioning.** ECC is the strongest evidence yet that the supply side of this
market is being commoditized fast and at enormous scale. It is also the strongest
evidence that the *measurement* side is not: with 235k stars, six months of daily
commits, and a paid tier, they still ship no controlled experiment, no baseline,
and no counterfactual. That gap is the moat, and it widens when we resist
importing their heuristics for the sake of feature parity.

**Inverse framing.** ECC users write exactly the `~/.claude` artifacts we consume.
At their install base, ECC is plausibly a feedstock and distribution channel — an
ECC-aware view or a plugin-marketplace presence reaches their audience without
competing with them.

**No derivation in either direction.** A probe of the clone for 16 of our
coinages — `leave-behind`, `shadow-calls`, `burn-epic`, `route-loose`,
`cwd-anchor`, `runbook-autofire`, `expiresWhen`, `revalidateEvery`, `agent-sig`,
`claude-history-dashboard`, `Claude Coach`, `split-skill`, `groom-release` and
others — returned zero hits, and there is zero overlap between their 281 skill
names and the 61 in `~/.agents/skills`. Independent convergence.

## Existing Coverage

| Observation | Status | Evidence / issue |
|---|---|---|
| Per-model context window vs hardcoded 200K | Gap | #3443 |
| Canonical repo identity (worktrees/clones collapse) | Gap | #3444 |
| Auto-discovering script test suites in CI | Gap | #3445 |
| Revertible policy writes (receipt + un-merge) | Gap | #3446 |
| Manifest version parity | Gap | #3447 |
| Personal-path publish gate + npm `files` allowlist | Gap | #3448 |
| Widened hidden-instruction codepoint set | Gap | shpwrck/agent-skills#23 |
| SKILL.md multi-line description validation | Gap | shpwrck/agent-skills#24 |
| LICENSE file / license reconciliation | Deferred | Owner decision (MIT vs source-available) pending |
| Credential-path deny vocabulary + secret-read detector | Backlog | Promote on next permissions/policy sprint; `parse-tools.ts:95` already records `file_path` |
| Cross-project spread as a scoping signal | Deferred | Blocked on #3444; import as scope/phrasing only, never as a proof tier |
| Statusline ground-truth cost capture | Deferred | ECC ships only the reader; we would build the producer |
| Instinct confidence model | No action | Declined on positioning — frequency without a control; conflicts with ADR 0017 |
| Hook-based observation capture pipeline | No action | We read real transcripts; strictly richer at zero session cost |
| Message-id usage dedupe | Implemented (better) | `parse-sessions.ts:270-306` max-merges; theirs is the #457 bug |
| Tool-loop detection | Implemented | `detectRetryGroups`, `parse-file-reread`, `repeated-commands`, `live-session.ts:272` |
| Structured plan/reject channel ("Plan Canvas") | Implemented | `RejectControl.tsx`, `reject-reason.ts`, `reject-signals.jsonl` |
| Prose-invariant assertion technique | Implemented | `hooks/recs-delivery-registration.test.mjs:82-105` |
| Public shields.io endpoint badges from our API | No action | Publicly fetchable endpoint derived from private transcripts contradicts local-only |
| Tiered sponsorship / paid README placement | No action | Incompatible with an independence claim |

## Release / Watch Signals

- **Meaningful signals — the encroachment triggers.** Promote this note to
  direct-competitor tier if either lands:
  1. `scripts/hooks/cost-tracker.js` grows a **UI** — any view over
     `~/.claude/metrics/costs.jsonl` turns their instrumentation into an
     analytics product.
  2. Instinct scoring gains a **control arm, baseline, or holdout** — the moment
     they measure rather than count, the positioning collision is real.
- Secondary: AgentShield rules opening up (today closed, `SECURITY.md:50`); any
  hosted/team aggregation appearing on ecc.tools/pricing; `continuous-learning`
  moving from confidence scores to outcome deltas.
- Notable release signals: `docs/releases/`, the 2.1 line (Plan Canvas, Kimi
  harness support), `CHANGELOG.md` "Unreleased".
- No-action notes: skill-count growth, harness-target count, star count, and i18n
  expansion are distribution signals, not product-overlap signals — they do not
  move this note's tier on their own.

## Follow-up

- Backlog issues: #3443, #3444, #3445 (P1); #3446, #3447, #3448 (P2);
  shpwrck/agent-skills#23, #24 (P2).
- Documentation issue: #3440 (this note); index entry added under *Adjacent
  Sources* in [README.md](./README.md).
- Owner decision outstanding: repository license (MIT vs source-available), which
  gates the LICENSE issue, the README masthead, and any marketplace work.
