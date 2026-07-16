# history.d session parts

## Context

Claude Code's legacy prompt history is a single `~/.claude/history.jsonl` file.
The dashboard still needs to read that file because older installs and older
sessions may never be split into per-session files. For newer split history, the
dashboard also reads `~/.claude/history.d/<sessionId>.jsonl`.

## File contract

- `history.jsonl` remains the legacy flat prompt log.
- `history.d/<sessionId>.jsonl` is the per-session prompt-history part for one
  session.
- A part should contain entries whose `sessionId` matches the filename stem, but
  ingest treats each entry's own `sessionId` as the source of truth so a
  producer mistake cannot corrupt unrelated sessions by filename alone.
- Each file is newline-delimited JSON using the same `HistoryEntry` shape already
  consumed by `parseHistoryJsonl`.

## Merge semantics

For each configured source root:

1. Parse every `history.d/*.jsonl` part in deterministic `relPath` order.
2. Parse legacy `history.jsonl` when it exists.
3. A session present in any part is owned by the part entries. All legacy entries
   for that session are suppressed.
4. A session absent from parts falls back to legacy `history.jsonl`.
5. Transcript-derived entries stay authoritative over both history sources. The
   existing transcript-session suppression still runs after the part-vs-legacy
   merge.

This gives writers a safe migration path: they can add or replace one
per-session part without rewriting the shared flat file, and the dashboard will
not double-count that session.

## Compatibility

Missing `history.d` and missing `history.jsonl` both degrade to empty input.
Malformed lines are skipped by the JSONL parser, and a malformed or oversized
history file is isolated to that file rather than aborting the whole dataset
assembly.
