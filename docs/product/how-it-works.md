# How it works

Probaitio reads your Claude Code (and Codex) session history **on your own
machine** and tells you, with evidence, how to make your AI coding agent
cheaper, faster, and more accurate. No data passes through any Probaitio server:
the engine runs locally, against the files already on your disk. There is no
network call in the local path to opt out of — there is no remote path to begin
with. (Full model: [Privacy & data use](./privacy-and-data.md).)

## The three pillars

Probaitio is one engine in three movements. Each builds on the last.

### 1. Observe — make the bill legible

The engine parses the artifacts Claude Code already writes under `~/.claude/`:
session transcripts, the usage ledger, settings, skills, agents, commands, MCP
config. It prices every token component (input, output, cache-creation,
1h-cache-creation, cache-read) with per-entry math and reconstructs cost,
context growth, tool usage, and session-level forensics. (The authoritative map
of every artifact read and the parser that consumes it is
[`REFERENCES.md`](../../REFERENCES.md).)

This layer is commoditized — Anthropic ships per-user cost APIs and there are
several free trackers. Probaitio treats it as the **ruler**, not the headline:
the substrate every proof is priced against.

### 2. Experiment — run controlled trials on your own work

From the observed history the engine derives **recommendations** — auditable,
evidence-backed findings ("this pattern is costing you", "down-model this task
class"). A recommendation is not advice; it is a structured claim with cited
provenance, an estimated impact, and (where one is genuinely copy-paste-safe) a
ready-to-apply fix.

To go beyond *suggesting* a change, the engine can **run the change as a trial**
in a jailed, reproducible worktree:

- **Shadow calls** — after a task, re-run it a varied way in a sandbox and log
  the comparison.
- **Replay** — re-run an *actual past task* at its base commit, two ways, and
  blind-judge the outcomes.
- **`/race`** — race the *current* goal two ways at once and merge the winner.

The experiment apparatus (jailed worktrees, matched pairs, objective gates) is
the part a competitor cannot cheaply copy.

### 3. Prove — turn a trial into a causal verdict

A trial becomes a **proof receipt**: a sealed artifact with an effect size,
quantified uncertainty, a dollar figure, and an explicit model-version scope —
or an honest null. Reading one is its own page:
[Reading a proof receipt](./reading-a-proof-receipt.md).

## How a recommendation is shaped

Every recommendation the engine emits carries:

- `category` (cost / context / reliability / safety / workflow / …) and
  `severity` (`critical` / `warning` / `info`);
- a quantified impact where one is honest — `estSavingsUsd`, or
  `estTimeReclaimedMin` when there is no honest dollar unit;
- `evidence` (human-readable rows) and `evidenceRefs` (structured anchors to the
  exact session turn / tool call);
- `provenance` — the directly-observed facts, each citing its artifact/field,
  the inference drawn from them, and an `asOf` date so a stale signal is demoted
  to "as of \<date\>" rather than asserted as current state;
- an optional `fix` with a `fixKind`: `validated` (self-contained, copy-paste
  safe), `illustrative` (an example to adapt), or `manual`.

This is the auditable-claims contract — see
[`docs/adding-a-recommendation.md`](../adding-a-recommendation.md).

## One engine, several envelopes

The same engine ships in tiers differentiated by **data locality**, not by
feature (ADR [0014](../adr/0014-tiered-delivery-model.md)):

- **Local dashboard** — the full engine, reading your live `~/.claude` on your
  machine.
- **Upload-only SPA** — a static marketing build that parses files you drop in,
  in your browser, statelessly. No `~/.claude` mount, no `/api/*`.
- **Self-hostable server** — the local engine, deployable on your own
  infrastructure.

What a feature is allowed to send externally is governed, not assumed — see
[Privacy & data use](./privacy-and-data.md).

## Vendor- and harness-neutral

Probaitio sits above any single harness. The cross-harness contract — the
vendor-neutral work queue and role skills that already run on both Claude Code
and Codex — is first-class. Model vendors are structurally conflicted out of
telling you to spend less; an independent layer is not.
