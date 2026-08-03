import { describe, it, expect } from 'vitest';
import {
  detector,
  measureReclaimPasteWorkload,
} from './reclaim-potential';
import { detector as crossSessionReread } from './cross-session-reread';
import { detector as repoMapContextWaste } from './repo-map-context-waste';
import { validateRecommendationProvenance } from '../provenance';
import { validateFixSnippet } from '../fix-validity';
import type { RecommendationInput } from '../types';
import type { ToolCall, ToolUsageData } from '../../parse-tools';
import type { LiveConfig, SessionTokenData, Session } from '../../../types';

const OPUS = 'claude-opus-4-8';

const bashCall = (command: string, bytes: number, ts = 't'): ToolCall => ({
  timestamp: ts,
  toolName: 'Bash',
  input: { command },
  toolUseId: 'u',
  isError: null,
  resultBytes: bytes,
  commandFingerprint: command,
});

const readCall = (path: string, bytes: number): ToolCall => ({
  timestamp: 't',
  toolName: 'Read',
  input: { file_path: path },
  toolUseId: 'u',
  isError: null,
  resultBytes: bytes,
});

const session = (id: string, calls: ToolCall[]): ToolUsageData => ({ sessionId: id, calls });

const tokenSession = (id: string, cacheReadTokens = 100_000): SessionTokenData =>
  ({
    sessionId: id,
    entrypoint: 'cli',
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: cacheReadTokens,
    model: OPUS,
    messageCount: 1,
    entries: [
      {
        timestamp: 't',
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheCreation1hTokens: 0,
        cacheReadTokens,
        webSearchRequests: 0,
        webFetchRequests: 0,
        model: OPUS,
      },
    ],
    compactionEvents: [],
    hasUnknownModel: false,
  }) as unknown as SessionTokenData;

/** A Session carrying pasted blocks in its entries. */
const pasteSession = (
  id: string,
  pastes: { content: string; startTime?: number }[]
): Session =>
  ({
    sessionId: id,
    project: 'p',
    projectShort: 'p',
    startTime: pastes[0]?.startTime ?? 1,
    endTime: 1,
    duration: 0,
    messageCount: pastes.length,
    entries: pastes.map((p, i) => ({
      display: 'd',
      timestamp: p.startTime ?? 1,
      project: 'p',
      sessionId: id,
      pastedContents: {
        [`${i}`]: { id: i, type: 'text', content: p.content },
      },
    })),
  }) as unknown as Session;

function input(overrides: Partial<RecommendationInput> = {}): RecommendationInput {
  return {
    tokenData: [],
    toolData: [],
    sessions: [],
    projects: [],
    permissionRows: [],
    apiErrors: [],
    liveConfig: null,
    ...overrides,
  };
}

describe('context.reclaim-potential', () => {
  it('fires on a duplicate large Bash output with evidence, provenance, and a validated-template fix', () => {
    const toolData = [
      session('s1', [
        bashCall('cat huge.log', 800_000),
        bashCall('cat huge.log', 800_000),
        bashCall('cat huge.log', 800_000),
      ]),
    ];
    const rec = detector.rule(input({ toolData, tokenData: [tokenSession('s1')] }), 0);

    expect(rec).not.toBeNull();
    expect(rec!.id).toBe('context.reclaim-potential');
    expect(rec!.category).toBe('context');
    expect(rec!.estSavingsUsd!).toBeGreaterThan(0.05);
    expect(rec!.affected).toBeGreaterThanOrEqual(1);
    expect(rec!.evidence!.join(' ')).toContain('Bash');
    // Provenance well-formed and on the allowlist.
    expect(validateRecommendationProvenance(rec!)).toEqual([]);
    // Fix is an illustrative discipline note, not validated config.
    expect(rec!.fix!.fixKind).toBe('illustrative');
    expect(validateFixSnippet(rec!.fix!)).toEqual([]);
    expect(rec!.fix!.snippet).toContain('Context reclaim discipline');
  });

  it('fires on re-pasted file content across user turns', () => {
    const block = 'X'.repeat(400_000);
    const sessions = [
      pasteSession('p1', [{ content: block }]),
      pasteSession('p2', [{ content: block }]),
      pasteSession('p3', [{ content: block }]),
    ];
    const rec = detector.rule(
      input({ sessions, tokenData: [tokenSession('p1'), tokenSession('p2'), tokenSession('p3')] }),
      0
    );
    expect(rec).not.toBeNull();
    expect(rec!.evidence!.join(' ')).toContain('re-pasted');
  });

  it('preserves whitespace-normalized duplicate identity and preview output (#3187)', () => {
    const tail = 'x'.repeat(400_000);
    const sessions = [
      pasteSession('p1', [{ content: `  Alpha\n\t beta   ${tail}\n` }]),
      pasteSession('p2', [{ content: `Alpha beta ${tail}` }]),
    ];

    const rec = detector.rule(
      input({ sessions, tokenData: [tokenSession('p1')] }),
      0
    );

    expect(rec).not.toBeNull();
    expect(rec!.affected).toBe(1);
    expect(rec!.evidence).toEqual([
      expect.stringContaining('("Alpha beta xxxxxxxxxxxxxxxxxxxxxxxxxxxxx…")'),
    ]);
  });

  it('keeps distinct blocks separate when their primary portable digests collide (#3187)', () => {
    // These fixed-length prefixes are a pinned FNV-1a collision. Appending the
    // same suffix preserves the collision, so the secondary bounded discriminator
    // must keep both duplicate groups separate.
    const suffix = 'X'.repeat(400_000);
    const first = `fqftnvslbgfe${suffix}`;
    const second = `gsstgxoocizp${suffix}`;
    const sessions = [
      pasteSession('p1', [{ content: first }]),
      pasteSession('p2', [{ content: first }]),
      pasteSession('p3', [{ content: second }]),
      pasteSession('p4', [{ content: second }]),
    ];

    const rec = detector.rule(
      input({ sessions, tokenData: [tokenSession('p1')] }),
      0
    );

    expect(rec).not.toBeNull();
    expect(rec!.affected).toBe(2);
    expect(rec!.evidence).toEqual(
      expect.arrayContaining([
        expect.stringContaining('fqftnvslbgfe'),
        expect.stringContaining('gsstgxoocizp'),
      ])
    );
  });

  it('bounds retained paste metadata for many large unique blocks (#3187)', () => {
    const blockCount = 128;
    const blockChars = 32 * 1024;
    const sessions = Array.from({ length: blockCount }, (_, index) =>
      pasteSession(`unique-${index}`, [
        { content: `${index.toString().padStart(4, '0')}:${'x'.repeat(blockChars)}` },
      ])
    );

    const started = performance.now();
    const workload = measureReclaimPasteWorkload(sessions);
    const elapsedMs = performance.now() - started;

    expect(workload.blocks).toBe(blockCount);
    expect(workload.uniqueBlocks).toBe(blockCount);
    expect(workload.normalizedCodeUnits).toBeGreaterThan(
      blockCount * blockChars
    );
    // Keys, independent collision discriminators, and the 40-character preview
    // stay below 250 UTF-16 code units per unique block; the ~4 MiB normalized
    // corpus is streamed and never retained as Map keys or samples.
    expect(workload.retainedMetadataCodeUnits).toBeLessThanOrEqual(
      blockCount * 250
    );
    expect(elapsedMs).toBeLessThan(750);
  });

  it('stays silent below the dollar floor (min-effect gate — no zero-impact findings)', () => {
    // A single tiny duplicate output: reclaim is a handful of tokens, well under
    // MIN_SAVINGS_USD at the cache-read residual rate.
    const toolData = [session('s1', [bashCall('echo hi', 40), bashCall('echo hi', 40)])];
    expect(detector.rule(input({ toolData, tokenData: [tokenSession('s1')] }), 0)).toBeNull();
  });

  it('does not flag a one-off paste (needs a repeat to be reclaim)', () => {
    const sessions = [pasteSession('p1', [{ content: 'Y'.repeat(400_000) }])];
    expect(
      detector.rule(input({ sessions, tokenData: [tokenSession('p1')] }), 0)
    ).toBeNull();
  });

  it('demotes to "as of <date>" / stale when the newest contributing data is old', () => {
    const now = Date.parse('2026-06-24T00:00:00Z');
    const oldTs = '2026-01-01T00:00:00Z';
    const toolData = [
      session('s1', [
        bashCall('cat huge.log', 800_000, oldTs),
        bashCall('cat huge.log', 800_000, oldTs),
        bashCall('cat huge.log', 800_000, oldTs),
      ]),
    ];
    const sessions = [
      ({ sessionId: 's1', project: 'p', projectShort: 'p', startTime: Date.parse(oldTs), endTime: Date.parse(oldTs), duration: 0, messageCount: 0, entries: [] }) as unknown as Session,
    ];
    const rec = detector.rule(input({ toolData, sessions, tokenData: [tokenSession('s1')] }), now);
    expect(rec).not.toBeNull();
    expect(rec!.provenance!.stale).toBe(true);
    expect(rec!.provenance!.asOf).toBe('2026-01-01');
    expect(rec!.detail).toContain('as of 2026-01-01');
  });

  it('self-suppresses once a reclaim-discipline section is present in CLAUDE.md', () => {
    const toolData = [
      session('s1', [
        bashCall('cat huge.log', 800_000),
        bashCall('cat huge.log', 800_000),
      ]),
    ];
    const liveConfig = {
      claudeMd: {
        global:
          '## Context reclaim discipline\n\nCache or reference these large tool outputs and pasted blocks instead of re-ingesting them:\n- Bash result re-fetched 2x',
      },
    } as unknown as LiveConfig;
    expect(
      detector.rule(input({ toolData, tokenData: [tokenSession('s1')], liveConfig }), 0)
    ).toBeNull();
  });

  // ── Non-overlap boundary (the core acceptance criterion) ──────────────────
  describe('non-overlap with file-Read detectors', () => {
    it('ignores file Read/Edit/Write tool results entirely (no double-booking)', () => {
      // The SAME bytes that cross-session-reread / repo-map-context-waste count
      // are file READs — this detector must never count them.
      const toolData = [
        session('s1', [readCall('docs/guide.md', 800_000), readCall('docs/guide.md', 800_000)]),
      ];
      expect(
        detector.rule(input({ toolData, tokenData: [tokenSession('s1')] }), 0)
      ).toBeNull();
    });

    it("reclaim-potential's inputs are invisible to cross-session-reread and repo-map-context-waste", () => {
      // A corpus made ONLY of reclaim-potential's buckets: duplicate non-file
      // tool outputs + re-pasted content, with NO file Read calls and NO repoMap.
      const toolData = Array.from({ length: 6 }, (_, i) =>
        session(`s${i}`, [
          bashCall('cat huge.log', 800_000),
          bashCall('cat huge.log', 800_000),
        ])
      );
      const tokenData = Array.from({ length: 6 }, (_, i) => tokenSession(`s${i}`));
      const block = 'Z'.repeat(400_000);
      const sessions = Array.from({ length: 6 }, (_, i) => pasteSession(`s${i}`, [{ content: block }]));
      const inp = input({ toolData, tokenData, sessions });

      // reclaim-potential fires...
      expect(detector.rule(inp, 0)).not.toBeNull();
      // ...but neither file-Read detector sees anything here (their token
      // population — file Reads / repoMap — is empty), so no item is double-booked.
      expect(crossSessionReread.rule(inp, 0)).toBeNull();
      expect(repoMapContextWaste.rule(inp, 0)).toBeNull();
    });

    it('cross-session-reread fires on file Reads while reclaim-potential stays silent on the same input', () => {
      // The inverse: a doc cold-read across sessions is the file-Read detector's
      // territory; reclaim-potential must NOT also count it.
      const toolData = Array.from({ length: 6 }, (_, i) =>
        session(`d${i}`, [readCall('docs/guide.md', 200_000)])
      );
      const tokenData = Array.from({ length: 6 }, (_, i) => tokenSession(`d${i}`));
      const inp = input({ toolData, tokenData });

      expect(crossSessionReread.rule(inp, 0)).not.toBeNull();
      expect(detector.rule(inp, 0)).toBeNull();
    });
  });
});
