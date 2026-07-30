/**
 * Tests for src/lib/parse-debug.ts (issue #569).
 *
 * Inline fixtures are shaped to mirror the gen-mock.mjs output from the
 * proto/539-debug branch. Real Claude Code debug logs have:
 *   - ISO-8601 timestamps with ms precision
 *   - `[DEBUG]`/`[WARN]`/`[ERROR]` level prefixes
 *   - `[API REQUEST] /v1/messages x-client-request-id=<uuid> source=<src>`
 *   - `Stream started - received first chunk`
 *   - `API error (attempt N/11): ...`
 *   - `Slow first byte: no stream chunk 30.0s after request sent (attempt N)`
 *   - `Fast mode unavailable: Fast mode is not available in the Agent SDK`
 *   - `attribution header x-anthropic-billing-header: ...; cc_entrypoint=sdk-cli; ...`
 */

import { describe, it, expect } from 'vitest';
import { parseDebugLog, parseDebugDir } from './parse-debug';
import type { DebugSessionMetrics } from './parse-debug';
import { mkdtempSync, writeFileSync, symlinkSync } from 'node:fs';
import { DEFAULT_ARTIFACT_MAX_FILE_BYTES } from './bounded-fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** Base timestamp used as t=0 in generated fixtures (ms). */
const BASE_MS = Date.parse('2026-05-30T14:00:00.000Z');

function ts(offsetMs: number): string {
  return new Date(BASE_MS + offsetMs).toISOString();
}

/** Build a single healthy request pair (request -> first chunk). */
function requestChunkPair(reqOffset: number, ttfbMs: number): string[] {
  return [
    `${ts(reqOffset)} [DEBUG] [API REQUEST] /v1/messages x-client-request-id=00000000-0000-0000-0000-000000000001 source=repl_main_thread`,
    `${ts(reqOffset + ttfbMs)} [DEBUG] Stream started - received first chunk`,
  ];
}

/** Build a retry storm block (no successful chunk at the end). */
function retryStorm(
  startOffset: number,
  maxAttempt: number,
  stalls: number
): string[] {
  const lines: string[] = [];
  let t = startOffset;
  for (let attempt = 1; attempt <= maxAttempt; attempt++) {
    lines.push(
      `${ts(t)} [DEBUG] [API REQUEST] /v1/messages x-client-request-id=00000000-0000-0000-0000-000000000099 source=repl_main_thread`
    );
    t += 30_000;
    if (attempt <= stalls) {
      lines.push(
        `${ts(t)} [WARN] Slow first byte: no stream chunk 30.0s after request sent (attempt ${attempt})`
      );
    }
    t += 9_000;
    lines.push(
      `${ts(t)} [ERROR] API error (attempt ${attempt}/11): undefined Connection error.`
    );
    t += 1_000;
  }
  return lines;
}

/** Build a fast-mode-lost block (N requests, each preceded by Fast mode unavailable). */
function fastModeBlock(startOffset: number, count: number, ttfbMs: number): string[] {
  const lines: string[] = [];
  let t = startOffset;
  for (let i = 0; i < count; i++) {
    lines.push(
      `${ts(t)} [DEBUG] Fast mode unavailable: Fast mode is not available in the Agent SDK`
    );
    t += 1;
    lines.push(
      `${ts(t)} [DEBUG] [API REQUEST] /v1/messages x-client-request-id=00000000-0000-0000-0000-00000000000${i} source=sdk_cli`
    );
    t += ttfbMs;
    lines.push(`${ts(t)} [DEBUG] Stream started - received first chunk`);
    t += 5_000;
  }
  return lines;
}

// ---------------------------------------------------------------------------
// parseDebugLog — basic correctness
// ---------------------------------------------------------------------------

describe('parseDebugLog — empty / minimal input', () => {
  it('returns all-zero metrics for an empty string', () => {
    const m = parseDebugLog('', 'test-session-id');
    expect(m.sessionId).toBe('test-session-id');
    expect(m.ttfbP50).toBe(0);
    expect(m.ttfbP90).toBe(0);
    expect(m.ttfbMax).toBe(0);
    expect(m.ttfbSampleCount).toBe(0);
    expect(m.maxRetryAttempt).toBe(0);
    expect(m.slowFirstByteCount).toBe(0);
    expect(m.fastModeLostCount).toBe(0);
    expect(m.isSdkCli).toBeUndefined();
  });

  it('returns all-zero metrics for a file with no recognised lines', () => {
    const text = [
      '2026-05-30T14:00:00.000Z [DEBUG] LSP Diagnostics: getLSPDiagnosticAttachments called',
      '2026-05-30T14:00:00.001Z [DEBUG] Hooks: Found 0 total hooks in registry',
    ].join('\n');
    const m = parseDebugLog(text, 'sess-abc');
    expect(m.ttfbSampleCount).toBe(0);
    expect(m.maxRetryAttempt).toBe(0);
    expect(m.fastModeLostCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// TTFB percentile math
// ---------------------------------------------------------------------------

describe('parseDebugLog — TTFB percentile math', () => {
  it('computes correct p50/p90/max for a healthy interactive session', () => {
    // 18 requests with deterministic TTFB values: 700, 800, ..., 2450 ms (step 100).
    // That gives a predictable sorted array we can hand-check.
    const lines: string[] = [];
    let offset = 0;
    for (let i = 0; i < 18; i++) {
      const ttfb = 700 + i * 100; // 700 to 2400 ms
      lines.push(...requestChunkPair(offset, ttfb));
      offset += ttfb + 3000;
    }
    const m = parseDebugLog(lines.join('\n'), 'healthy-session');

    // Sorted ttfbs: [700, 800, 900, ..., 2400] (18 values, step 100)
    // p50 = floor(0.5 * 18) = idx 9 = 700 + 9*100 = 1600
    // p90 = floor(0.9 * 18) = idx 16 = 700 + 16*100 = 2300
    // max = 2400
    expect(m.ttfbSampleCount).toBe(18);
    expect(m.ttfbP50).toBe(1600);
    expect(m.ttfbP90).toBe(2300);
    expect(m.ttfbMax).toBe(2400);
    expect(m.maxRetryAttempt).toBe(0);
    expect(m.fastModeLostCount).toBe(0);
    expect(m.isSdkCli).toBeUndefined();
  });

  it('handles a single-request session (p50 = p90 = max)', () => {
    const lines = requestChunkPair(0, 1234);
    const m = parseDebugLog(lines.join('\n'), 'single');
    expect(m.ttfbSampleCount).toBe(1);
    expect(m.ttfbP50).toBe(1234);
    expect(m.ttfbP90).toBe(1234);
    expect(m.ttfbMax).toBe(1234);
  });

  it('discards a request with no matching first-chunk (open window)', () => {
    // Three completed pairs followed by an unclosed request.
    const lines = [
      ...requestChunkPair(0, 500),
      ...requestChunkPair(4000, 600),
      ...requestChunkPair(8000, 700),
      `${ts(15000)} [DEBUG] [API REQUEST] /v1/messages x-client-request-id=orphan source=repl_main_thread`,
      // EOF — no matching Stream started line
    ];
    const m = parseDebugLog(lines.join('\n'), 'partial');
    expect(m.ttfbSampleCount).toBe(3);
    expect(m.ttfbMax).toBe(700);
  });

  it('handles out-of-order / negative delta lines by discarding them', () => {
    // Manufacture a negative delta by swapping chunk before request.
    const lines = [
      `${ts(1000)} [DEBUG] Stream started - received first chunk`,
      `${ts(2000)} [DEBUG] [API REQUEST] /v1/messages x-client-request-id=id1 source=repl_main_thread`,
      `${ts(3000)} [DEBUG] Stream started - received first chunk`,
    ];
    const m = parseDebugLog(lines.join('\n'), 'out-of-order');
    // The first chunk has no open window (skipped). The second request->chunk is valid.
    expect(m.ttfbSampleCount).toBe(1);
    expect(m.ttfbP50).toBe(1000);
  });
});

// ---------------------------------------------------------------------------
// Retry-attempt extraction
// ---------------------------------------------------------------------------

describe('parseDebugLog — retry attempt extraction', () => {
  it('extracts maxRetryAttempt from retry storm, counts slow-first-byte stalls', () => {
    // 5 healthy pairs, then a storm climbing to attempt 11 with 6 slow stalls.
    const lines: string[] = [];
    let offset = 0;
    for (let i = 0; i < 5; i++) {
      lines.push(...requestChunkPair(offset, 800));
      offset += 800 + 4000;
    }
    lines.push(...retryStorm(offset, 11, 6));

    const m = parseDebugLog(lines.join('\n'), 'retry-storm');
    expect(m.maxRetryAttempt).toBe(11);
    expect(m.slowFirstByteCount).toBe(6);
    // TTFB samples come only from the 5 successful pairs (no chunk after storm).
    expect(m.ttfbSampleCount).toBe(5);
  });

  it('picks the highest attempt number when multiple retry lines are present', () => {
    const text = [
      `${ts(0)} [ERROR] API error (attempt 3/11): Connection error.`,
      `${ts(1)} [ERROR] API error (attempt 7/11): Connection error.`,
      `${ts(2)} [ERROR] API error (attempt 2/11): Connection error.`,
    ].join('\n');
    const m = parseDebugLog(text, 'multi-attempt');
    expect(m.maxRetryAttempt).toBe(7);
  });

  it('does not misfire on lines that contain "attempt" but not the retry pattern', () => {
    const text = [
      `${ts(0)} [DEBUG] attempt to connect`,
      `${ts(1)} [INFO] First attempt is underway`,
    ].join('\n');
    const m = parseDebugLog(text, 'no-retry');
    expect(m.maxRetryAttempt).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Slow-first-byte counting
// ---------------------------------------------------------------------------

describe('parseDebugLog — slow first byte counting', () => {
  it('counts each distinct Slow first byte line', () => {
    const text = [
      `${ts(0)} [WARN] Slow first byte: no stream chunk 30.0s after request sent (attempt 1)`,
      `${ts(1)} [WARN] Slow first byte: no stream chunk 30.0s after request sent (attempt 2)`,
      `${ts(2)} [WARN] Slow first byte: no stream chunk 30.0s after request sent (attempt 3)`,
    ].join('\n');
    const m = parseDebugLog(text, 'slow-stalls');
    expect(m.slowFirstByteCount).toBe(3);
  });

  it('returns 0 when no slow stalls present', () => {
    const lines = requestChunkPair(0, 900);
    expect(parseDebugLog(lines.join('\n'), 'fast').slowFirstByteCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Fast-mode-lost counting
// ---------------------------------------------------------------------------

describe('parseDebugLog — fast mode lost counting', () => {
  it('counts Fast mode unavailable lines and sets isSdkCli from source=sdk_cli', () => {
    // 22 requests, each preceded by a Fast mode unavailable line.
    const lines = fastModeBlock(0, 22, 2000);
    const m = parseDebugLog(lines.join('\n'), 'sdk-session');

    expect(m.fastModeLostCount).toBe(22);
    expect(m.ttfbSampleCount).toBe(22);
    // All TTFBs are ~2000ms; p50/p90/max should all be near 2000.
    expect(m.ttfbP50).toBe(2000);
    expect(m.ttfbP90).toBe(2000);
    expect(m.ttfbMax).toBe(2000);
    // isSdkCli detected from source=sdk_cli on request lines.
    expect(m.isSdkCli).toBe(true);
  });

  it('sets isSdkCli from cc_entrypoint=sdk-cli in attribution header', () => {
    const text = [
      `${ts(0)} [DEBUG] attribution header x-anthropic-billing-header: cc_version=2.1.152.983; cc_entrypoint=sdk-cli; cch=00000;`,
      `${ts(1)} [DEBUG] Fast mode unavailable: Fast mode is not available in the Agent SDK`,
      ...requestChunkPair(10, 1800),
    ].join('\n');
    const m = parseDebugLog(text, 'sdk-header');
    expect(m.isSdkCli).toBe(true);
    expect(m.fastModeLostCount).toBe(1);
  });

  it('leaves isSdkCli undefined when no SDK signal is present', () => {
    const lines = requestChunkPair(0, 700);
    const m = parseDebugLog(lines.join('\n'), 'cli-session');
    expect(m.isSdkCli).toBeUndefined();
  });

  it('sets isSdkCli from bare source=sdk on request lines', () => {
    const text = [
      `${ts(0)} [DEBUG] [API REQUEST] /v1/messages x-client-request-id=id1 source=sdk`,
      `${ts(1000)} [DEBUG] Stream started - received first chunk`,
    ].join('\n');
    const m = parseDebugLog(text, 'sdk-bare');
    expect(m.isSdkCli).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Combined realistic fixture — retry storm + recovery
// ---------------------------------------------------------------------------

describe('parseDebugLog — realistic retry storm session (mirrors gen-mock retryStorm)', () => {
  it('correctly attributes TTFB only to completed pairs, not storm requests', () => {
    const lines: string[] = [];
    let offset = 0;

    // 5 healthy pairs (TTFB ~800ms each).
    for (let i = 0; i < 5; i++) {
      lines.push(...requestChunkPair(offset, 800));
      offset += 800 + 4000;
    }

    // Retry storm: 11 attempts, 11 slow stalls.
    lines.push(...retryStorm(offset, 11, 11));
    offset += 11 * (30_000 + 9_000 + 1_000);

    // Recovery: 1 successful pair.
    lines.push(...requestChunkPair(offset, 1100));

    const m = parseDebugLog(lines.join('\n'), 'storm-session');
    expect(m.ttfbSampleCount).toBe(6); // 5 healthy + 1 recovery
    expect(m.maxRetryAttempt).toBe(11);
    expect(m.slowFirstByteCount).toBe(11);
    expect(m.fastModeLostCount).toBe(0);
    expect(m.isSdkCli).toBeUndefined();
    // Max TTFB is the recovery pair (1100ms > 800ms).
    expect(m.ttfbMax).toBe(1100);
  });
});

// ---------------------------------------------------------------------------
// Malformed / partial log tolerance
// ---------------------------------------------------------------------------

describe('parseDebugLog — malformed / partial log tolerance', () => {
  it('skips lines without a valid timestamp gracefully', () => {
    const text = [
      'no timestamp at all — should be skipped',
      `${ts(0)} [DEBUG] [API REQUEST] /v1/messages x-client-request-id=id source=repl_main_thread`,
      'another bad line',
      `${ts(500)} [DEBUG] Stream started - received first chunk`,
    ].join('\n');
    const m = parseDebugLog(text, 'malformed');
    // Request line has a valid timestamp so the window is opened;
    // chunk line has a valid timestamp so the delta is computed.
    expect(m.ttfbSampleCount).toBe(1);
    expect(m.ttfbP50).toBe(500);
  });

  it('handles completely empty lines without throwing', () => {
    const text = '\n\n\n';
    expect(() => parseDebugLog(text, 'empty-lines')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// parseDebugDir — filesystem scanning
// ---------------------------------------------------------------------------

describe('parseDebugDir', () => {
  it('returns [] for a non-existent directory', () => {
    expect(parseDebugDir('/tmp/does-not-exist-xyzzy-12345')).toEqual([]);
  });

  it('reads *.txt files, derives sessionId from filename, skips non-.txt', () => {
    const dir = mkdtempSync(join(tmpdir(), 'parse-debug-test-'));

    // Write two session files.
    const sess1Id = 'aaaaaaaa-1111-2222-3333-444444444444';
    const sess2Id = 'bbbbbbbb-5555-6666-7777-888888888888';

    writeFileSync(
      join(dir, `${sess1Id}.txt`),
      requestChunkPair(0, 700).join('\n') + '\n'
    );
    writeFileSync(
      join(dir, `${sess2Id}.txt`),
      [
        `${ts(0)} [DEBUG] Fast mode unavailable: Fast mode is not available in the Agent SDK`,
        ...requestChunkPair(1, 2000),
      ].join('\n') + '\n'
    );

    // Write a non-.txt file that should be ignored.
    writeFileSync(join(dir, 'latest'), 'symlink-target-content');
    writeFileSync(join(dir, 'notes.json'), '{"ignored": true}');

    const results = parseDebugDir(dir);

    expect(results).toHaveLength(2);
    const ids = results.map((r) => r.sessionId).sort();
    expect(ids).toEqual([sess1Id, sess2Id].sort());

    const sess1 = results.find((r) => r.sessionId === sess1Id)!;
    expect(sess1.ttfbSampleCount).toBe(1);
    expect(sess1.ttfbP50).toBe(700);

    const sess2 = results.find((r) => r.sessionId === sess2Id)!;
    expect(sess2.fastModeLostCount).toBe(1);
    expect(sess2.isSdkCli).toBeUndefined(); // source= on request line used sdk_cli not sdk
    expect(sess2.ttfbSampleCount).toBe(1);
  });

  it('returns [] for an empty directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'parse-debug-empty-'));
    expect(parseDebugDir(dir)).toEqual([]);
  });

  it('skips debug logs above the configured byte cap', () => {
    const dir = mkdtempSync(join(tmpdir(), 'parse-debug-cap-'));
    const smallId = 'cccccccc-1111-2222-3333-444444444444';
    const largeId = 'dddddddd-1111-2222-3333-444444444444';
    writeFileSync(join(dir, `${smallId}.txt`), requestChunkPair(0, 700).join('\n'));
    writeFileSync(
      join(dir, `${largeId}.txt`),
      `${requestChunkPair(0, 700).join('\n')}\n${'x'.repeat(2_048)}`
    );

    const results = parseDebugDir(dir, { maxFileBytes: 512 });

    expect(results.map((r) => r.sessionId)).toEqual([smallId]);
  });
});

// ---------------------------------------------------------------------------
// DebugSessionMetrics interface shape
// ---------------------------------------------------------------------------

describe('DebugSessionMetrics interface', () => {
  it('has all required fields with correct types on a real parse result', () => {
    const m: DebugSessionMetrics = parseDebugLog(
      requestChunkPair(0, 1000).join('\n'),
      'type-check-session'
    );
    // These assertions serve as a compile-time + runtime type guard.
    expect(typeof m.sessionId).toBe('string');
    expect(typeof m.ttfbP50).toBe('number');
    expect(typeof m.ttfbP90).toBe('number');
    expect(typeof m.ttfbMax).toBe('number');
    expect(typeof m.ttfbSampleCount).toBe('number');
    expect(typeof m.maxRetryAttempt).toBe('number');
    expect(typeof m.slowFirstByteCount).toBe('number');
    expect(typeof m.fastModeLostCount).toBe('number');
    // isSdkCli is optional — may be boolean or undefined.
    expect(m.isSdkCli === undefined || typeof m.isSdkCli === 'boolean').toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Directory boundary + finite defaults (#3378)
// ---------------------------------------------------------------------------

describe('parseDebugDir — the debug directory is the boundary (#3378)', () => {
  it('refuses a symlinked log pointing outside the directory', () => {
    const outside = mkdtempSync(join(tmpdir(), 'debug-outside-'));
    const dir = mkdtempSync(join(tmpdir(), 'debug-boundary-'));
    const target = join(outside, 'stolen.txt');
    writeFileSync(target, '[DEBUG] stolen\n');
    symlinkSync(target, join(dir, 'linked.txt'));
    // A real sibling proves the parser works on this fixture otherwise.
    writeFileSync(join(dir, 'real.txt'), '[DEBUG] real\n');

    const out = parseDebugDir(dir);
    expect(out.map((m) => m.sessionId)).toEqual(['real']);
  });

  it('applies a finite per-file byte cap by default', () => {
    const dir = mkdtempSync(join(tmpdir(), 'debug-cap-'));
    writeFileSync(join(dir, 'big.txt'), 'x'.repeat(DEFAULT_ARTIFACT_MAX_FILE_BYTES + 100));
    // Before #3378 the default was -1 — no cap at all.
    expect(parseDebugDir(dir)).toEqual([]);
    expect(
      parseDebugDir(dir, { maxFileBytes: DEFAULT_ARTIFACT_MAX_FILE_BYTES + 1000 })
    ).toHaveLength(1);
  });
});

/**
 * Ingestion budget observability + bounded line parsing (#3140).
 *
 * The byte and entry caps themselves landed with #3151/#3152/#3378, so what was
 * still missing was (a) any way to SEE what the budget refused and (b) the
 * whole-file line-array duplication: `parseDebugLog` split each fully-read file
 * into one string per line and held them all live alongside the file text.
 *
 * Measured at `parseDebugDir` (the shape `scripts/ingest.mjs` calls) over 40
 * files of 5,000 lines: the pre-fix path made 40 `split('\n')` calls allocating
 * 200,000 line strings; the bounded path allocates none, with byte-identical
 * output.
 */
describe('debug ingest budget observability (#3140)', () => {
  function tmpDir(): string {
    return mkdtempSync(join(tmpdir(), 'debug-budget-'));
  }

  it('reports each file the budget refused', () => {
    const dir = tmpDir();
    const ts = '2026-01-01T00:00:00.000Z';
    writeFileSync(
      join(dir, 'aaaaaaaa-0000-0000-0000-000000000001.txt'),
      `${ts} [API REQUEST] /v1/messages\n${ts} Stream started - received first chunk\n`
    );
    writeFileSync(join(dir, 'big-1.txt'), 'x'.repeat(4096));
    writeFileSync(join(dir, 'big-2.txt'), 'x'.repeat(4096));

    const skipped: string[] = [];
    const metrics = parseDebugDir(dir, {
      maxFileBytes: 1024,
      onSkip: (filename) => skipped.push(filename),
    });

    // The under-budget log still parses; both oversized ones are reported rather
    // than vanishing into an empty result.
    expect(metrics).toHaveLength(1);
    expect(skipped.sort()).toEqual(['big-1.txt', 'big-2.txt']);
  });

  it('does not fire onSkip when nothing is refused', () => {
    const dir = tmpDir();
    const ts = '2026-01-01T00:00:00.000Z';
    writeFileSync(
      join(dir, 'aaaaaaaa-0000-0000-0000-000000000002.txt'),
      `${ts} [API REQUEST] /v1/messages\n${ts} Stream started - received first chunk\n`
    );
    const skipped: string[] = [];
    const metrics = parseDebugDir(dir, { onSkip: (f) => skipped.push(f) });
    expect(metrics).toHaveLength(1);
    expect(skipped).toEqual([]);
  });

  it('reports DIRECTORY-cap truncation, which no per-file callback can see', () => {
    const dir = tmpDir();
    const ts = '2026-01-01T00:00:00.000Z';
    for (let i = 0; i < 6; i++) {
      writeFileSync(
        join(dir, `aaaaaaaa-0000-0000-0000-00000000000${i}.txt`),
        `${ts} [API REQUEST] /v1/messages\n${ts} Stream started - received first chunk\n`
      );
    }
    const skipped: string[] = [];
    let truncation: { scanned: number; cap: number } | null = null;
    const metrics = parseDebugDir(dir, {
      maxEntries: 2,
      onSkip: (f) => skipped.push(f),
      onDirectoryTruncated: (info) => {
        truncation = info;
      },
    });
    // The omitted names are never returned, so onSkip cannot fire for them —
    // without the truncation signal this looks like a complete 2-file corpus.
    expect(metrics.length).toBeLessThanOrEqual(2);
    expect(skipped).toEqual([]);
    expect(truncation).not.toBeNull();
    expect(truncation!.cap).toBe(2);
    expect(truncation!.scanned).toBe(2);
  });

  it('does not report truncation when the directory fits the cap', () => {
    const dir = tmpDir();
    const ts = '2026-01-01T00:00:00.000Z';
    for (let i = 0; i < 2; i++) {
      writeFileSync(
        join(dir, `bbbbbbbb-0000-0000-0000-00000000000${i}.txt`),
        `${ts} [API REQUEST] /v1/messages\n${ts} Stream started - received first chunk\n`
      );
    }
    let truncated = false;
    // Exactly at the cap must NOT report truncation — the boundary case that a
    // naive `length === cap` check gets wrong.
    parseDebugDir(dir, {
      maxEntries: 2,
      onDirectoryTruncated: () => {
        truncated = true;
      },
    });
    expect(truncated).toBe(false);
  });

  it('never materializes a whole-file line array', () => {
    const ts = (s: number) =>
      new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();
    const lines: string[] = [];
    for (let i = 0; i < 2000; i++) {
      lines.push(
        i % 2 === 0
          ? `${ts(i)} [API REQUEST] /v1/messages`
          : `${ts(i)} Stream started - received first chunk`
      );
    }
    const text = lines.join('\n');

    // Count real newline-splits performed by the parser. The pre-fix
    // implementation allocated one string per line for the entire file.
    const original = String.prototype.split;
    let allocatedLineStrings = 0;
    try {
      (String.prototype as unknown as { split: unknown }).split = function (
        this: string,
        ...args: unknown[]
      ) {
        const out = (original as unknown as (...a: unknown[]) => string[]).apply(
          this,
          args
        );
        if (args[0] === '\n') allocatedLineStrings += out.length;
        return out;
      };
      const metrics = parseDebugLog(text, 'session-1');
      expect(metrics.ttfbSampleCount).toBe(1000);
    } finally {
      (String.prototype as unknown as { split: unknown }).split = original;
    }
    expect(allocatedLineStrings).toBe(0);
  });

  it('parses identically to a split-based walk', () => {
    const ts = (s: number) =>
      new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();
    // Trailing newline, a blank line, and a no-timestamp line: the segment cases
    // where an indexOf walk could drift from split('\n').
    const text =
      `${ts(0)} [API REQUEST] /v1/messages source=sdk\n` +
      `\n` +
      `no timestamp here\n` +
      `${ts(3)} Stream started - received first chunk\n` +
      `${ts(4)} API error (attempt 7/11): boom\n` +
      `${ts(5)} Slow first byte: no stream chunk 30.0s after request sent\n` +
      `${ts(6)} Fast mode unavailable: not available in the Agent SDK\n`;
    const metrics = parseDebugLog(text, 'session-2');
    expect(metrics.ttfbSampleCount).toBe(1);
    expect(metrics.ttfbMax).toBe(3000);
    expect(metrics.maxRetryAttempt).toBe(7);
    expect(metrics.slowFirstByteCount).toBe(1);
    expect(metrics.fastModeLostCount).toBe(1);
    expect(metrics.isSdkCli).toBe(true);
  });
});
