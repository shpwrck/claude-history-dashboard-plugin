# Spike: does any transcript event carry per-tool (PreToolUse/Bash) hook timing?

**Issue:** #134 · **Verdict: ✗ NOT FOUND** · Investigated 2026-05-31

## TL;DR

There is **no persisted per-tool (PreToolUse/PostToolUse/Bash) hook-timing data**
in `~/.claude` transcripts. The only hook-timing event type written to disk is
`stop_hook_summary` (Stop hooks) — and it carries no hook *name*, and a
`durationMs` on only ~6% of entries. So Marcus's literal question — *"which hook
adds 4s to every Bash call?"* — **cannot be answered from the data the dashboard
reads.** The per-hook-latency feature ask (#134) should be closed as unsupported
by the data.

## Exhaustion evidence

### 1. Every `type:"system"` subtype, enumerated

Across **363 transcript files / 475 `type:"system"` lines** in
`~/.claude/projects/**/*.jsonl`:

| count | subtype | parsed by `parse-runtime-events.ts`? | carries hook timing? |
| --- | --- | --- | --- |
| 286 | `stop_hook_summary` | ✓ yes | Caveat: Stop hooks only; see below |
| 85 | `turn_duration` | ✓ yes | no |
| 56 | `api_error` | no (ignored) | no |
| 20 | `away_summary` | ✓ yes | no |
| 16 | `local_command` | no (ignored) | no |
| 6 | `informational` | no (ignored) | no |
| 3 | `bridge_status` | no (ignored) | no |
| 3 | `scheduled_task_fire` | ✓ yes | no |

`stop_hook_summary` is the **sole** hook-bearing subtype. (`REFERENCES.md`
already notes the parser "pulls four subtypes … most other `type:"system"`
lines are ignored" — accurate; the four ignored ones above carry no hook
timing, so no REFERENCES change is warranted.)

### 2. No PreToolUse/PostToolUse timing under *any* top-level type

Searching every transcript line (all types) for `PreToolUse` (65),
`PostToolUse` (163), `hook_response` (78), `hook_started` (4) finds matches —
but **all are incidental mentions, never timing events**:

| where | what it actually is |
| --- | --- |
| `type:user` → `message` / `toolUseResult` (161) | tool results: source code & file content (e.g. the dashboard's own `recommendations.ts`, settings examples) that happen to contain the strings |
| `type:attachment` → `attachment` (87) | edited-file snippets (source code) |
| `type:assistant` → `message` (49) | assistant `tool_use` commands / text mentioning hooks |
| `type:queue-operation` → `content` (7) | a review prompt listing changed files |

Zero are persisted per-tool hook-timing records.

### 3. `stop_hook_summary` confirms the prior #134 investigation

286 events / 287 `hookInfos`: **6%** carry `durationMs`, **0%** carry a
`name`/`id` (identity is only the raw `command` string), and
`preventedContinuation` is per-event, not per-hook. So even for Stop hooks, a
dense, named, per-hook latency table isn't supportable.

## The one nuance: timing exists *transiently* in the live stream, not on disk

The live `claude` stream-json **does** emit `hook_started` / `hook_progress` /
`hook_response` events with a `hook_event` field (`SessionStart`, and by
extension `PreToolUse`/`PostToolUse`), observed directly when running
`claude -p`. A started→response pair could in principle be timed. **But these
events are never persisted to the transcript `.jsonl`** (0 of 475 system lines)
— they are ephemeral. The dashboard reads persisted transcripts, so this data
is out of reach for it.

## Recommendation

- **Close #134 as unsupported by the data.** Per-tool/PreToolUse hook latency is
  not in any transcript the dashboard reads; the Stop-hook data is too sparse
  and unnamed to build the requested per-hook table on.
- If per-Bash-call hook latency ever becomes a hard requirement, it would need a
  **different architecture** — capturing the live `hook_started`/`hook_response`
  stream at run time (e.g. a hook or stream tap that writes its own timing log),
  not parsing transcripts. That is a separate, larger piece of work and is not
  recommended on the strength of this one ask.

## Frozen receipt and reproduction

The published numbers above are bound to the minimized, redacted receipt at
[`fixtures/hook-timing-spike/receipt.json`](../fixtures/hook-timing-spike/receipt.json):

- schema version `1`;
- receipt revision `hook-timing-spike/2026-05-31/redacted-r1`;
- source snapshot `claude-projects-2026-05-31-redacted-r1`, captured
  `2026-05-31T23:59:59.000Z` from `~/.claude/projects/**/*.jsonl`.

The receipt retains one atomic pseudonymous file id, subtype code, search-row
type/mask, or Stop-hook-info tuple per observation. It contains no raw transcript
text, prompt, command, hook command, path, or session id, and it stores no
published totals. The analyzer is bounded and refuses any other schema/revision,
so it recomputes every number rather than trusting a copied aggregate:

```sh
node scripts/audits/hook-timing-receipt.mjs fixtures/hook-timing-spike/receipt.json
```

Canonical output (kept equal to a fresh recomputation by
`scripts/audits/hook-timing-receipt.test.mjs`):

<!-- hook-timing-receipt-output:start -->
```json
{
  "schemaVersion": 1,
  "receiptRevision": "hook-timing-spike/2026-05-31/redacted-r1",
  "sourceSnapshotId": "claude-projects-2026-05-31-redacted-r1",
  "transcriptFiles": 363,
  "systemLines": 475,
  "systemSubtypes": {
    "stop_hook_summary": 286,
    "turn_duration": 85,
    "api_error": 56,
    "away_summary": 20,
    "local_command": 16,
    "informational": 6,
    "bridge_status": 3,
    "scheduled_task_fire": 3
  },
  "hookStringHits": {
    "PreToolUse": 65,
    "PostToolUse": 163,
    "hook_response": 78,
    "hook_started": 4
  },
  "hookStringClassifications": {
    "type:user -> message/toolUseResult": 161,
    "type:attachment -> attachment": 87,
    "type:assistant -> message": 49,
    "type:queue-operation -> content": 7
  },
  "persistedPerToolHookTimingEvents": 0,
  "stopHookEvents": 286,
  "hookInfos": 287,
  "hookInfosWithDurationMs": 17,
  "hookInfosWithDurationPct": 6,
  "hookInfosWithNameOrId": 0,
  "hookInfosWithNameOrIdPct": 0
}
```
<!-- hook-timing-receipt-output:end -->
