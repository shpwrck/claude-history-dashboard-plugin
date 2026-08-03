# Perf sprint — baseline (cycle 1)

> **Status: historical measurement, not a current host baseline.** This cycle
> was measured on 2026-05-29 at `965e472e` against the running container
> (`ghcr.io/shpwrck/claude-history-dashboard:latest`, podman, port 5173) with
> that day's live `~/.claude` mounted read-only. The timings and conclusions
> below describe only that recorded corpus scale. They must not be treated as
> current without a new full benchmark run.

Measurement basis (2026-05-29):

- 40 project directories under `~/.claude/projects`
- 213 `.jsonl` files total (sessions + subagents), recorded as 82 MB on disk
- Largest single session file: 25.5 MB
- Server reports `total=100` sessions in the SQLite ingest cache

Freshness check only (2026-08-03; **not** a timing re-measurement): the same
host now has 1,530 `.jsonl` files totaling 531,724,012 bytes (531.7 MB decimal;
507.1 MiB), or 7.2x the files and approximately 6.5x when the historical 82 MB
record is interpreted as decimal units. This does not recertify the timing or
current session count; it records that the original measurement corpus has
drifted.

Count and apparent bytes come from one exact file set; a second command
independently reproduced the byte total:

```sh
find ~/.claude/projects -type f -name '*.jsonl' -printf '%s\n' |
  awk '{ files += 1; bytes += $1 } END { printf "%d %d\n", files, bytes }'
find ~/.claude/projects -type f -name '*.jsonl' -print0 |
  du --files0-from=- -cb | tail -1
```

These returned `1530 531724012` and `531724012 total`, respectively. An earlier
draft's 210,148,980-byte value is superseded: it came from an independent byte
probe that was not bound to the counted file set and could not be reproduced.

## Browser baseline (Playwright)

- **navTotal** 255 ms
- **domContentLoaded** 254 ms
- **First Contentful Paint** 3,448 ms (spinner)
- **Time-to-real-data** ≈ 20,000 ms (dataset arrival)
- bodyLoadedBytes at first paint: 18,619

## `/api/dataset.json` timing (consistent across 3 sequential hits)

| hit | encoding | size | total | TTFB | download | X-Ingest | status |
|-----|----------|------|-------|------|----------|----------|--------|
| 1 | identity | 8.66 MB | 19.6 s | 19.6 s | small | total=100;reparsed=2;removed=0 | 200 |
| 2 | br | 1.04 MB | 19.6 s | 19.6 s | 37 ms | total=100;reparsed=2;removed=0 | 200 |
| 3 | br + If-None-Match | 0 | **5 ms** | 5 ms | 0 | total=100;reparsed=0;removed=0 | 304 |

Brotli-11 buffer is cached (1.04 MB precomputed), so wire cost is fine. The hot path is **server compute on every request**: `ingest()` re-scans the filesystem, detects 2 changed sessions (mtime-bumping live transcripts), re-parses them (one is 25 MB), then `assembleDataset()` re-reads + JSON.parses every blob from SQLite, then brotli-11 the 8.3MB JSON string.

The 304 path is fast — proves the brotli buffer + ETag pipeline is correct. The problem is that the cache gets invalidated every request because the live session's mtime keeps moving.

## Top hypotheses, ranked

| # | Hypothesis | Confidence | Where to look |
|---|------------|-----------|---------------|
| H1 | Brotli-11 on the rebuilt 8.3MB JSON dominates the 19s wall clock | high | `scripts/server.mjs::buildDatasetCache` (level 11 on every rebuild) |
| H2 | `assembleDataset()` JSON.parses every blob × every column × every session on every rebuild, even unchanged ones | high | `scripts/ingest.mjs::assembleDataset` |
| H3 | Re-parsing the 25MB session blob from scratch on every mtime tick is expensive even when only the tail grew | high | `scripts/ingest.mjs::ingestOne` (no append-only parse) |
| H4 | The whole pipeline runs synchronously on the HTTP thread, blocking all other requests during the rebuild | medium | `scripts/server.mjs::createServer` (sync ingest in handler) |
| H5 | Default-route Recommendations.tsx receives the full token/tool/timeline arrays and does heavy reduce passes on every render | medium | `src/components/Recommendations.tsx` |
| H6 | Client-side `groupBySessions` + `groupByProjects` chain through every history entry, then triggers 12+ setStates → 12+ re-renders | medium | `src/App.tsx::reloadFromDisk` + `src/lib/parse-history.ts` |
| H7 | The 25MB monster session is itself worth special-casing (chunked parse / cap) | low-medium | `~/.claude/projects/.../<25MB>.jsonl` |
| H8 | `buildManifest()` and other live endpoints don't impact first-data path but the client may still call them | low | `src/App.tsx`, network panel |

## Stop condition for cycle 1 fixes

Target: TTFB on a warm-cache `/api/dataset.json` request **under 1 second** when `reparsed≤2`. Stretch: under 300ms.

Time-to-real-data in the browser target: **under 3 seconds** end-to-end.

If we hit those, move to the client-side render hypotheses (H5, H6).
