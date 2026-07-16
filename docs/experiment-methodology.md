# Experiment methodology

Status: shared operating method for headless Claude Code proof experiments.
Worked example: #1310. Release-gate context: #995 and
[`v0.4-proof-preregistration.md`](./v0.4-proof-preregistration.md).

This document covers cost measurement for headless `claude -p` experiments. Its
main purpose is preventing prompt-cache warmth from masquerading as treatment
effect. A proof receipt can still report quality, latency, and objective gates,
but dollar and token deltas need the cache controls below before they are
credible.

## The confound

Claude Code sessions share a large system/tools prefix. In #1310, that prefix was
about 20k tokens and had a 1h prompt-cache TTL. The first arm to run after a cold
cache paid the cache-write premium, while later arms mostly paid cache reads. The
raw result looked like a large cost saving, but the apparent effect was cache
state, not the experimental treatment.

Treat arm order, cache lineage, and warm-up equivalence as part of the experiment
design. Do not read a cost result until they are controlled or decomposed.

## Required controls

### 1. Fork cache lineage per arm

Give every arm its own cache lineage with an arm-specific appended system prompt:

```bash
claude -p "$TASK" \
  --append-system-prompt "experiment-arm: treatment-$(uuidgen)"
```

Prompt caching matches exact prefix content. The added arm salt makes the
measured tail segment distinct for each arm, so one arm cannot inherit the other
arm's warm tail cache. #1310 verified this by running a nonce arm: it went cold
even while the shared cache was warm.

Caveat: this forks only the tail cache segment. In #1310 that tail was about
2.8k tokens; the leading roughly 18k-token tools/system block stayed shared. That
is acceptable when the leading block is equally warm for all arms. If it is not,
use the disabled-cache path below or explicitly report the shared-prefix
decomposition.

### 2. Warm up with the exact measured command

Warm-up runs must match measured runs byte-for-byte for every flag that can
change the prompt prefix. That includes `--allowedTools`, MCP/tool availability,
model flags, appended system prompt content, and any harness setting that changes
tool definitions.

A mismatched warm-up warms the wrong lineage. #1310's isolation check caught this
case: the warm-up omitted the measured tool restriction, so it created a different
cached prefix than the measured command used.

### 3. Interleave batches across arms

Run each task x repetition batch across all arms before moving to the next batch:

```text
task A rep 1: control, treatment
task A rep 2: treatment, control
task B rep 1: control, treatment
...
```

The exact randomization can vary, but run order must not correlate with arm. If a
warm-up mistake survives, interleaving degrades it into symmetric cold/warm noise
instead of a one-sided confound.

### 4. Use disabled caching when purity matters more than realism

For a maximum-purity cost comparison, run with prompt caching disabled:

```bash
DISABLE_PROMPT_CACHING=1 claude -p "$TASK"
```

#1310 verified that this bills the full prefix as plain input with zero
cache-write or cache-read traffic. Every run is identically cold. This is useful
for isolating behavioral effects, but it changes the economics being measured:
there is no cache-write premium, multi-turn runs cost more, and the result is
less representative of normal Claude Code usage.

### 5. Decompose cost analytically as a backstop

When a historical experiment did not fully control cache state, use the
dashboard's `TokenEntry` breakdown to separate fixed baseline cost from
treatment-sensitive cost:

- `src/lib/parse-sessions.ts` records input, output, cache creation, 1h cache
  creation, and cache read tokens per transcript entry.
- `estimateCost` in `src/lib/parse-sessions.ts` and `entryCost` in
  `src/lib/cost-trend.ts` price those components with the same per-entry math.
- In #1310, transcript-priced sessions matched CLI-billed cost within less than
  1% across 18 runs; the residual was attributable to Haiku side-calls that do
  not appear in the transcript entries.

That decomposition lets the analysis drop a fixed shared-prefix baseline and
compare output dollars, per-turn cache writes, and cache reads separately. It is
a backstop, not a license to skip cache controls in new runs.

## Minimum receipt notes

Any proof or null receipt that reports cost from headless Claude Code experiments
must state:

- whether per-arm cache forking was used and what salt format was applied;
- whether warm-ups used the exact measured command;
- how batches were interleaved or randomized across arms;
- whether `DISABLE_PROMPT_CACHING=1` was used;
- whether final dollars are raw billed cost, transcript-priced cost, or an
  analytical decomposition; and
- which commit or issue contains the worked run log.

If any item is missing, treat the cost result as exploratory until rerun or
decomposed.
