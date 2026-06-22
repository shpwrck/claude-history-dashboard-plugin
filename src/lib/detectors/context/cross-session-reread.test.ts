import { describe, it, expect } from 'vitest';
import { detector } from './cross-session-reread';
import { validateRecommendationProvenance } from '../provenance';
import { validateFixSnippet } from '../fix-validity';
import type { RecommendationInput } from '../types';
import type { ToolCall, ToolUsageData } from '../../parse-tools';
import type { LiveConfig, SessionTokenData } from '../../../types';

const OPUS = 'claude-opus-4-8';

const readCall = (path: string, bytes: number): ToolCall => ({
  timestamp: 't',
  toolName: 'Read',
  input: { file_path: path },
  toolUseId: 'u',
  isError: null,
  resultBytes: bytes,
});

const editCall = (path: string): ToolCall => ({
  timestamp: 't',
  toolName: 'Edit',
  input: { file_path: path },
  toolUseId: 'u',
  isError: null,
  resultBytes: 0,
});

const session = (id: string, calls: ToolCall[]): ToolUsageData => ({ sessionId: id, calls });

/** Token session carrying enough cache-read tokens to ground the residual rate. */
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

/** N sessions each cold-reading `path` once at `bytes`. */
function coldReadAcross(path: string, n: number, bytes: number): {
  toolData: ToolUsageData[];
  tokenData: SessionTokenData[];
} {
  const toolData: ToolUsageData[] = [];
  const tokenData: SessionTokenData[] = [];
  for (let i = 0; i < n; i += 1) {
    toolData.push(session(`s${i}`, [readCall(path, bytes)]));
    tokenData.push(tokenSession(`s${i}`));
  }
  return { toolData, tokenData };
}

describe('context.cross-session-reread', () => {
  it('fires on a read-only doc cold-read across many sessions with a NET dollar saving', () => {
    const { toolData, tokenData } = coldReadAcross('docs/guide.md', 6, 200_000);
    const rec = detector.rule(input({ toolData, tokenData }), 0);

    expect(rec).not.toBeNull();
    expect(rec!.id).toBe('context.cross-session-reread');
    expect(rec!.category).toBe('context');
    expect(rec!.estSavingsUsd!).toBeGreaterThan(0.05);
    expect(rec!.affected).toBe(1);
    expect(rec!.evidence!.join(' ')).toContain('docs/guide.md');
    // Provenance is well-formed and the detector is on the allowlist.
    expect(validateRecommendationProvenance(rec!)).toEqual([]);
    // The fix is an illustrative template (human-authored note), not validated config.
    expect(rec!.fix!.fixKind).toBe('illustrative');
    expect(validateFixSnippet(rec!.fix!)).toEqual([]);
    expect(rec!.fix!.snippet).toContain('Distilled reference notes');
  });

  it('does NOT recommend a doc whose eager note-load exceeds the tax (NET <= 0)', () => {
    // Read cold in only 3 sessions, but the corpus has 30 sessions — the
    // distilled note loads eagerly into all 30, so eager-load > recovered tax.
    const toolData: ToolUsageData[] = [];
    const tokenData: SessionTokenData[] = [];
    for (let i = 0; i < 3; i += 1) {
      toolData.push(session(`r${i}`, [readCall('docs/rare.md', 80_000)]));
      tokenData.push(tokenSession(`r${i}`));
    }
    // 27 more sessions that never read the doc but still load CLAUDE.md eagerly.
    for (let i = 0; i < 27; i += 1) tokenData.push(tokenSession(`other${i}`));

    expect(detector.rule(input({ toolData, tokenData }), 0)).toBeNull();
  });

  it('skips docs that are edited (stability gate — only read-only docs are pinnable)', () => {
    const { toolData, tokenData } = coldReadAcross('docs/guide.md', 6, 80_000);
    // One session also edits the doc — it churns, so it is not stable to pin.
    toolData[0] = session('s0', [readCall('docs/guide.md', 80_000), editCall('docs/guide.md')]);

    expect(detector.rule(input({ toolData, tokenData }), 0)).toBeNull();
  });

  it('ignores code files — dedup boundary vs repo-map-context-waste', () => {
    const { toolData, tokenData } = coldReadAcross('src/lib/foo.ts', 6, 80_000);

    expect(detector.rule(input({ toolData, tokenData }), 0)).toBeNull();
  });

  it('stays silent once a distilled-notes section is present in CLAUDE.md', () => {
    const { toolData, tokenData } = coldReadAcross('docs/guide.md', 6, 80_000);
    const liveConfig = {
      claudeMd: {
        global:
          '## Distilled reference notes\n\nDistill these docs once here instead of re-reading them cold each session:\n- docs/guide.md: key facts',
      },
    } as unknown as LiveConfig;

    expect(detector.rule(input({ toolData, tokenData, liveConfig }), 0)).toBeNull();
  });
});
