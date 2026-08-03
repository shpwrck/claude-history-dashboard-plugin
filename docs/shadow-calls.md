# Shadow calls — operator guide

Shadow calls run real work two ways — your normal answer (**Main**) and one varied
**Shadow** — to learn which of Claude's features actually help, and feed that back into the
recommendation engine. This is the operator's-eye view; the design rationale is
[ADR 0004](./adr/0004-shadow-calls-experiment-engine.md).

> **Where the code lives.** The *engine* is "meta" tooling under `~/.claude/shadow-calls/`
> (not this repo) — see `~/.claude/shadow-calls/SCHEMA.md` and `lib/*.mjs`. This repo owns
> only the *consumer*: `src/lib/parse-shadow-calls.ts` + the `workflow.shadow-axis-wins`
> detector. The split is deliberate (ADR 0004 §2).

## Kill switch — stop everything

If you ever want shadow activity to stop, one flip disables **all** of it (live + replay)
and silences the recs auto-inject:

```bash
node ~/.claude/shadow-calls/lib/killswitch.mjs off      # engage — nothing runs
node ~/.claude/shadow-calls/lib/killswitch.mjs status   # ENABLED / DISABLED + reason
node ~/.claude/shadow-calls/lib/killswitch.mjs on       # re-enable
```

Equivalent: `export SHADOW_CALLS_OFF=1` (per-shell), or create the file
`~/.claude/shadow-calls/OFF`. It is checked **first** inside `budget.decide()` — the one
chokepoint both live and replay pass through — so when engaged nothing even fetches usage,
let alone spends tokens. Default is enabled; engaging is always safe and instant.

## Consent mode — opt out before each run

Separate from the all-or-nothing kill switch, **consent mode** controls the per-run UX:

```bash
node ~/.claude/shadow-calls/lib/mode.mjs get            # current mode
node ~/.claude/shadow-calls/lib/mode.mjs set ask        # ask | notify | auto
```

- **`notify`** (default) — the agent tells you in one line what it's about to run (axis +
  rough cost + kill-switch reminder), then proceeds without waiting; you can kill it
  mid-flight.
- **`ask`** — same one-liner, but as a question; the shadow runs only if you approve, and is
  skipped entirely on unattended runs.
- **`auto`** — no prompt; the result line appears after.

Also settable via `SHADOW_CALLS_MODE`. The kill switch outranks all three (when engaged the
firing path never reaches the consent step).

## What a live shadow looks like

1. You give a substantial prompt; the agent does the work and **delivers the Main answer in
   full** (unchanged — a shadow never edits what you got).
2. The agent runs the **content egress preflight** (`egress-preflight.mjs`, #3296) on the
   task/context text BEFORE budget or consent. Shadow workers and the judge run on the
   subscription OAuth credential, and ADR 0008's invariant forbids that credential from
   transmitting `~/.claude`-derived content — so a task whose content carries a path into
   `~/.claude`/`~/.codex`, credential material, or a transcript excerpt is **skipped
   fail-closed**, and the skip reason records only the matched class names
   (`claude-path`, `credential`, `transcript-excerpt`), never the matched text. The same
   check is enforced structurally inside `buildWorkerLaunch` (throws before any launch
   contract exists) and `buildJudgePayload` (degrades to the honest-null verdict path), so
   no flow can forget it; the Tier-B local loopback lane is exempt (no credential seeded,
   egress pinned to `127.0.0.1`, so local-only analysis of `~/.claude` content stays
   allowed per ADR 0018).
3. The agent checks the budget (`budget.mjs decide live`). If it's not allowed (window busy,
   cap hit, or kill switch), it silently skips.
4. If allowed, it applies your **consent mode** (notify/ask/auto), picks the next rotation
   axis (`axes.mjs pickAxis`), and fires **one background worktree subagent** that redoes the
   same task with just that axis varied.
5. When it returns: metrics + an LLM-judge decide a winner (judge inputs pass the same
   egress preflight); a `mode:"live"` record is appended to
   `~/.claude/shadow-calls/ledger.jsonl`; you see a one-line note like
   `shadow [haiku] matched at 1/8 cost — logged`.

## What a replay looks like

Replay re-runs *past* tasks when your 5-hour window is idle (the inverse of the live gate),
turning unused-but-paid-for capacity into experiments. It is **not scheduled by default** —
enable it when you want it:

```bash
node ~/.claude/shadow-calls/lib/driver.mjs plan 3      # dry-run: what it WOULD replay now
node ~/.claude/shadow-calls/lib/driver.mjs contract    # the loop a /schedule or /loop drives
```

Each replay reconstructs the task at its base commit in an isolated worktree, runs a cold
control + the varied attempt, judges, and logs a `mode:"replay"` record. Replayed tasks
pass the same fail-closed egress preflight as live shadows (#3296): a past task whose
prompt or context embeds `~/.claude`-derived or secret-bearing content is skipped with a
classes-only reason instead of being resent on the subscription credential.

## Inspecting the ledger

```bash
node ~/.claude/shadow-calls/lib/ledger.mjs stats       # counts by mode + axis, current state
```

Once experiments accumulate, the dashboard's **Recommendations** view surfaces the
`workflow.shadow-axis-wins` finding: "adopt axis X — it out-performed your default."
Live-confirmed wins show as `warning`; replay-only evidence as `info` (cold-start caveat).

### Discovery — proposing new rule classes (#530)

A second detector, `workflow.uncovered-shadow-axis`, closes the loop: it cross-references
each strong shadow win against the existing rule catalog and, when an axis wins consistently
but **no rule covers it**, surfaces a recommendation whose fix is the `gh issue` command to
propose a dedicated detector. That proposal rides the standing engine-gap feedback loop into
a `[shadow-discovery]` backlog issue — so patterns the engine doesn't yet know about become
candidate rules instead of sitting unnoticed in the ledger. (Richer, free-form LLM discovery
is a documented out-of-band follow-up; see ADR 0004 §8.)

## Budget at a glance

| Mode | Runs when | Caps |
|---|---|---|
| live | 5h utilisation ≤ 60 % | ≤ 3 / 5h; forces cheap-model axis ≥ 40 % |
| replay | 5h utilisation < 50 % (idle) | shares one weekly cap with live |

All thresholds are env-overridable (`SC_LIVE_SKIP_ABOVE`, `SC_REPLAY_BELOW`,
`SC_WEEKLY_CAP`, `SC_LIVE_CAP_5H`, `SC_TIGHT_ABOVE`). The kill switch overrides all of them.
