# Competitive analysis: Helmdeck

**Subject:** [`tosin2013/helmdeck`](https://github.com/tosin2013/helmdeck)
**Date:** 2026-06-09
**Verdict:** Adjacent, not a direct competitor. Different layer of the AI-agent
stack. There is one real overlap worth watching (the cost/efficiency story) and a
few patterns worth borrowing.

## TL;DR

Helmdeck is a **self-hosted runtime that serves typed tools to AI agents**. We are
a **self-hosted dashboard that observes and coaches an existing agent** (Claude
Code). Helmdeck sits *in the agent's execution path* (it is the thing the model
calls); we sit *beside the agent's history* (we read what already happened). They
do not substitute for each other, and a user could run both at once with no
conflict.

The honest competitive surface is narrow:

- **Shared premise:** local-first, privacy-conscious, "your data / your machine,
  no phoning home." Both court the air-gapped / security-conscious / can't-use-
  cloud crowd.
- **Shared headline metric:** *cost*. Helmdeck's entire pitch is dollar savings
  ("~5× cheaper"). Our v0.4 direction (see
  [`docs/v0.3-efficiency-accounting.md`](../v0.3-efficiency-accounting.md) and the
  efficiency-accounting work) is also dollar-centric. We measure the bill;
  helmdeck lowers it. That makes them a *complement* more than a rival — but it
  also means they own the "save money on agents" narrative we are only starting
  to claim.

## What Helmdeck is

> "A self-hosted, containerized platform for AI agents, exposed as Capability
> Packs — schema-validated, one-shot JSON tools — and native MCP."

Core idea: wrap messy multi-step work (browser sessions, desktop actions, git,
code edits, credentialed SaaS logins) behind **single typed REST/MCP calls** so
that *small, open-weight models* (7B–30B, Ollama/LocalLLaMA, gpt-oss-120b) can
drive them reliably. Their thesis, quoted:

> "Smart models thrive on bash and a README. Weak models stall on open-ended
> interfaces. Helmdeck closes that gap by hiding browser sessions, desktop
> actions, credentials, and multi-step workflows behind single typed REST / MCP
> calls."

Explicitly positions *against* Cursor, Aider, and native Anthropic Computer Use —
and explicitly *not* against frontier models: "built for the other 99% of
deployments — local 7B models, air-gapped environments, and teams that can't send
credentials to a cloud API."

### Key facts

| Dimension | Helmdeck |
|---|---|
| Layer | Agent **runtime / tool server** (in the call path) |
| Primary language | Go (~87%); React/TS UI (~5%) |
| Distribution | Single static Go binary with embedded React UI; Docker Compose (dev), Helm/K8s (v1.0, planned) |
| License | Apache 2.0 |
| Maturity | v0.26.0 latest; ~524 commits; 49 ADRs; ~98 open issues; **~4 stars / 5 forks** (early) |
| Headline | "Same outcome, ~5× cheaper" on small models |
| Security | AES-256-GCM credential vault; `${vault:NAME}` placeholder injection so the model never sees secrets; MCP-level audit log; static-password dev → OIDC SSO (roadmap) |
| Surface | 53 capability packs, 21 pipelines, community pack marketplace (`helmdeck pack install`), routing meta-pack, memory store, intent-decomposition planner |

### Their cost table (as published)

| Task | "Traditional" | Helmdeck (gpt-oss-120b) | Claimed savings |
|---|---|---|---|
| Browser scrape + GitHub comment | $0.25 | $0.005 | 50× |
| Code edit loop (6 steps) | $0.35 | $0.07 | 5× |
| Multi-step browser test | $0.20 | $0.03 | 6.7× |
| PDF → structured Markdown | $1.00 | $0.003 | 333× |

Treat these as marketing figures (self-reported, no methodology shown, ~4 stars
of external validation). The *direction* is credible — routing work to a small
local model is obviously cheaper than a frontier API — but the multipliers are
not independently grounded.

## What we are (for contrast)

Claude History Dashboard reads `~/.claude` **live** and surfaces token usage,
cost attribution, context health, tool/error/file activity, conversation
patterns, native `/insights`, and a **recommendation engine** that turns usage
history into agent-behaviour changes. We do not execute the agent; we explain and
improve it after the fact. Our moat is *Claude Code-specific* depth — we parse its
transcript format, its subagent merges, its `/insights` output — none of which
helmdeck touches.

## Head-to-head

| | Helmdeck | Claude History Dashboard |
|---|---|---|
| **Job to be done** | Let weak models do strong-model work, cheaply | Show *what* an agent did and *how to do it better/cheaper* |
| **Position in stack** | In the execution path (tool server) | Beside the history (read-only observer) |
| **Coupling** | Model-agnostic, MCP-native | Claude Code-specific |
| **Cost angle** | *Lowers* the bill (route to cheap models) | *Measures & explains* the bill |
| **Privacy stance** | Local/air-gapped; vault keeps secrets from the model | Local-only; never sends content to api.anthropic.com (scoped free/local rule) |
| **Distribution** | Go binary + Docker/Helm | Node server + React SPA + Docker; SPA-only flavor |
| **Maturity** | Broad surface, very early adoption | Narrower surface, deeper Claude integration |

## Where they actually overlap (and where they don't)

**Genuine overlap — two items:**
1. **The cost/efficiency narrative.** Both lead with dollars. If we ship v0.4's
   "dollarize every category + bill-coverage denominator," we are competing for
   the same mindshare ("control your agent spend") even though the mechanism
   differs (we advise; they reroute).
2. **The local-first / privacy buyer.** Same target persona: security-conscious,
   self-hosted, distrustful of cloud. Whoever that buyer evaluates first frames
   the category.

**Not overlapping (don't force it):**
- We have no tool-serving / MCP-execution story and shouldn't grow one to "match"
  — that's a different product.
- They have **no analytics/observability dashboard** (their UIs are a pack test
  runner, a config console, and a routing-memory visualizer — operational, not
  retrospective-analytics). They are not building toward what we do.

## Threats

- **Low, today.** 4 stars; no analytics ambitions; orthogonal layer. They cannot
  observe a Claude Code session the way we do.
- **Latent: category framing on "agent cost."** If helmdeck (or a similar runtime)
  becomes the default answer to "how do I spend less on agents," our measurement-
  and-advice framing risks looking passive ("you just *tell* me; they *fix* it").
  Our counter is that you can't reroute what you can't see, and that frontier-model
  users — our actual base — can't simply swap to a 7B model.
- **Latent: they're a complement that could ship a thin dashboard.** A runtime that
  already brokers every tool call is well-placed to add usage analytics. Their MCP
  audit log is the seed. Worth monitoring their roadmap for an "analytics"/"usage"
  pack.

## Opportunities / what to borrow

1. **Lead with a concrete, sourced cost table.** Their published before/after
   table is the most persuasive thing on their page, *despite* being unsourced.
   We have the opposite asset: **real, parsed bills** ($9,447/mo in the reference
   data). A *methodologically honest* savings table — "here's your actual spend,
   here's the reclaimable slice, here's the lever" — beats their marketing numbers
   on credibility. This is the v0.4 efficiency-accounting work; helmdeck validates
   the demand for it.
2. **Name the lever, not just the number.** Helmdeck's pitch is "route to a cheaper
   model." Our recs engine should be equally blunt about *which* lever (Batch API
   −50%, cache discipline, model downshift) maps to *which* dollars. Today the
   engine monetizes only the `cost` category; helmdeck's clarity is a reminder that
   a savings claim needs an attached action.
3. **"Complement, not competitor" is a positioning gift.** If small-model runtimes
   grow, the people running them still need to *see* whether the reroute actually
   saved money. A future "observe any agent, not just Claude Code" angle could
   literally sit on top of helmdeck's audit log. Not a near-term bet, but the
   adjacency is friendly, not hostile.
4. **ADR discipline as a trust signal.** 49 ADRs on a 4-star repo is a strong
   "this is seriously engineered" signal to technical buyers. We already keep ADRs
   (`docs/adr/`); keep leaning on them in any public-facing material.

## Bottom line

Helmdeck is **not a competitor to chase** — it is a different layer with a friendly
adjacency. The single thing to internalize: they have planted a flag on **"agents,
but cheaper,"** and they did it with a vivid (if unsourced) cost table. Our v0.4
dollarization work is how we plant our own flag on the same hill — with the
advantage that our numbers are *real and parsed from the user's own history*, not
illustrative. Measure the bill so credibly that "what do I do about it" becomes the
obvious next question — that's the half helmdeck can't answer for a frontier-model
user, and the half we own.

## Sources

- Helmdeck README and repo: https://github.com/tosin2013/helmdeck (fetched
  2026-06-09)
- Our positioning: [`README.md`](../../README.md),
  [`docs/v0.3-efficiency-accounting.md`](../v0.3-efficiency-accounting.md), project
  memory ("North Star is a compass; context = 84% of bill")
