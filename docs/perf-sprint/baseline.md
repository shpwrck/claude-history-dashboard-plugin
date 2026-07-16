# Perf sprint — baseline (cycle 1)

Measured against the running container (`ghcr.io/shpwrck/claude-history-dashboard:latest`, podman, port 5173) with the live `~/.claude` mounted RO.

Data shape:
- 40 project directories under `~/.claude/projects`
- 213 `.jsonl` files total (sessions + subagents), 82MB on disk
- Largest single session file: 25.5 MB
- Server reports `total=100` sessions in the SQLite ingest cache

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
