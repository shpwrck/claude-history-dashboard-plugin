# Privacy & data use

Probaitio's strongest claim is structural: **it is not in your data path.** The
local engine reads the files already on your disk and runs entirely on your
machine. There is no Probaitio server in the loop to anonymize data at, because
no data is sent to one.

## What Probaitio reads / what never leaves

| Probaitio reads (locally) | Probaitio never sends anywhere |
|---|---|
| Session transcripts under `~/.claude/projects/` | The contents of your code files |
| The usage / token ledger | Your API keys or credentials |
| `~/.claude.json` and settings | Raw `CLAUDE.md` bodies, prompt text, diff hunks |
| Skills, agents, commands, MCP config | Conversation content |
| `/insights` outputs you generated, when present | Anything — the local engine makes no network call |

The authoritative map of every artifact read and the parser that consumes it is
[`REFERENCES.md`](../../REFERENCES.md).

## The delivery envelopes, by data locality

The same engine ships in tiers that differ in *where the data lives*, not in
features (ADR [0014](../adr/0014-tiered-delivery-model.md)):

- **Local dashboard** — the full engine, reading your live `~/.claude` on your
  own machine. Nothing leaves.
- **Upload-only SPA** — the public marketing build parses files you drop in,
  **in your browser, statelessly**. It has no `~/.claude` mount and no `/api/*`
  surface; any new server call is blocked by a CI boundary check
  (`spa-boundary`). Nothing is stored server-side.
- **Self-hostable server** — the local engine deployed on infrastructure you
  control.

## Governance: when an external call is even possible

The "no `api.anthropic.com`" rule is **scoped, not blanket** — and the scope is
the default:

- **Free, automatic, and local analysis paths stay local** and must not call the
  Anthropic API. This is the recommendation engine, the dashboard, and the
  `/recs` path (ADR [0005](../adr/0005-recs-adoption-measurable-impact.md)).
- A server component may call Anthropic **only** under the governance invariant
  in ADR [0008](../adr/0008-server-llm-usage-governance.md): the call site is
  registered, the feature is **opt-in**, it uses an explicitly configured
  Console API key, content passes an egress scrub, and spend is capped.
- The user's subscription **OAuth credential must never send `~/.claude`-derived
  content** — by construction.
- Any feature needing network, external, or non-`~/.claude` data is
  **off by default and env-gated**: with the flag off, behavior is
  byte-identical to a build that lacks the feature.

In-session model invocation added in v0.6.0 stays inside the free/local lane:
the in-session tier is **local-models-only** by decision, so ADR 0008 does not
even apply to it. See
[Tiered model-invocation](./features/tiered-model-invocation.md).

## Adoption receipts: allowlisted by construction

When the engine records whether a recommendation was surfaced or adopted, it
writes an append-only, dashboard-owned ledger with only two record kinds, each
restricted to an **allowlist of fields**. Repo paths, cwd, diff hunks, prompt
text, and raw `CLAUDE.md` bodies are not valid receipt fields and are dropped
before append — on both write *and* read, so a hand-edited or legacy line can
never surface a field outside the allowlist. Writes are skipped entirely when the
shadow-calls kill switch is set. Details:
[`docs/recs-adoption-receipts.md`](../recs-adoption-receipts.md).

## Mid-session fixes are opt-in and append-only

If you opt in mid-session to "apply this fix to my project `CLAUDE.md`", the
write is **append-only** (existing content preserved byte-for-byte), targets the
**per-project** `CLAUDE.md` you are working in, and **never** writes the global
`~/.claude/CLAUDE.md`. Auto-apply is out: the engine proposes; you decide.
