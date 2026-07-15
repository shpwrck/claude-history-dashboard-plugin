import { describe, it, expect } from 'vitest';
import { detector } from './native-bypass';
import type { RecommendationInput } from '../types';
import type { LiveConfig, SessionTokenData } from '../../../types';
import type { ToolUsageData, ToolCall } from '../../parse-tools';
import { runReclaimCascade } from '../../reclaim';
import { validateRecommendationProvenance } from '../provenance';
import { effectiveFixKind, validateFixSnippet } from '../fix-validity';

// 12 `grep` bash bypass commands (clears MIN_BYPASS_CALLS=10), each returning
// 400 chars of result → 12 × 400 = 4800 bytes → /4 = 1200 direct waste tokens.
const grepCall = (i: number): ToolCall => ({
  timestamp: `2026-01-01T00:00:${String(i).padStart(2, '0')}Z`,
  toolName: 'Bash',
  input: { command: 'grep -rn foo src/' },
  toolUseId: `u${i}`,
  isError: null,
  resultBytes: 400,
});
const toolData: ToolUsageData[] = [
  { sessionId: 's1', calls: Array.from({ length: 12 }, (_, i) => grepCall(i)) },
];

const tokenData: SessionTokenData[] = [
  ({
    sessionId: 's1',
    totalInputTokens: 100_000,
    entries: [
      {
        timestamp: 't',
        model: 'claude-opus-4-7',
        inputTokens: 100_000,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheCreation1hTokens: 0,
        cacheReadTokens: 0,
        webSearchRequests: 0,
        webFetchRequests: 0,
      },
    ],
    compactionEvents: [],
  } as unknown as SessionTokenData),
];

const input = (overrides?: Partial<RecommendationInput>): RecommendationInput => ({
  tokenData,
  toolData,
  sessions: [],
  projects: [],
  permissionRows: [],
  apiErrors: [],
  liveConfig: null,
  ...overrides,
});

const config = (
  permissions: { ask?: string[]; deny?: string[] } = {},
  global: string | null = null
): LiveConfig =>
  ({
    settings: { permissions },
    projectSettings: {},
    claudeMd: { global, perProject: {} },
    plugins: [],
    mcpServers: [],
    skills: [],
    subagents: [],
    commands: [],
  }) as unknown as LiveConfig;

const commandData = (
  command: string,
  count = 12,
  startMs = Date.parse('2026-01-01T00:00:00Z')
): ToolUsageData[] => [
  {
    sessionId: 's1',
    calls: Array.from({ length: count }, (_, index) => ({
      ...grepCall(index),
      timestamp: new Date(startMs + index * 1_000).toISOString(),
      input: { command },
    })),
  },
];

describe('workflow.native-bypass (#951)', () => {
  it('gates and reports affected on distinct calls, not overlapping category matches', () => {
    const dualCategoryCommand =
      'find src -name "*.ts" && grep TODO src/index.ts';
    const sixCalls = commandData(dualCategoryCommand, 6);

    expect(detector.rule(input({ toolData: sixCalls }), 0)).toBeNull();

    const rec = detector.rule(
      input({ toolData: commandData(dualCategoryCommand, 10) }),
      0
    )!;
    expect(rec.affected).toBe(10);
    expect(rec.detail).toContain('10 distinct native-tool-bypass Bash call(s)');
    expect(rec.detail).toContain('20 category match(es)');
    expect(rec.evidence).toEqual(
      expect.arrayContaining([
        'find → Glob: 10 category match(es)',
        'grep → Grep: 10 category match(es)',
      ])
    );
    expect(rec.provenance?.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          claim: '10 distinct native-tool bypass Bash call(s) were recorded',
          value: 10,
        }),
        expect.objectContaining({
          claim: 'Those calls produced 20 native-tool bypass category match(es)',
          value: 20,
        }),
      ])
    );
  });

  it('counts each multi-category result payload once in reclaim evidence', () => {
    const rec = detector.rule(
      input({
        toolData: commandData(
          'find src -name "*.ts" && grep TODO src/index.ts',
          10
        ),
      }),
      0
    )!;
    const resultBytesObservation = rec.provenance?.observations.find(
      (observation) =>
        observation.field ===
        'toolData[].calls[].resultBytes joined by sessionId to tokenData[].entries[].inputTokens'
    );
    const resultCallsObservation = rec.provenance?.observations.find(
      (observation) =>
        observation.field ===
        'count(toolData[].calls[].resultBytes > 0) joined by sessionId to tokenData[].entries[].inputTokens'
    );

    expect({
      affected: rec.affected,
      evidenceTokens: rec.reclaim?.evidenceTokens,
      resultCharacters: resultBytesObservation?.value,
      resultBearingCalls: resultCallsObservation?.value,
    }).toEqual({
      affected: 10,
      evidenceTokens: 1_000,
      resultCharacters: 4_000,
      resultBearingCalls: 10,
    });
    expect(resultBytesObservation?.claim).toContain(
      'were counted once per call'
    );
    expect(resultCallsObservation?.claim).toContain(
      '10 result-bearing Bash call(s) supplied those linked result characters'
    );
  });

  it('reports only result-bearing calls joined to token data in reclaim provenance', () => {
    const dualCategoryCommand =
      'find src -name "*.ts" && grep TODO src/index.ts';
    const linkedCalls = commandData(dualCategoryCommand, 5)[0].calls;
    const unlinkedCalls = commandData(dualCategoryCommand, 5)[0].calls;
    const rec = detector.rule(
      input({
        toolData: [
          { sessionId: 's1', calls: linkedCalls },
          { sessionId: 's2', calls: unlinkedCalls },
        ],
      }),
      0
    )!;
    const resultBytesObservation = rec.provenance?.observations.find(
      (observation) =>
        observation.field ===
        'toolData[].calls[].resultBytes joined by sessionId to tokenData[].entries[].inputTokens'
    );
    const resultCallsObservation = rec.provenance?.observations.find(
      (observation) =>
        observation.field ===
        'count(toolData[].calls[].resultBytes > 0) joined by sessionId to tokenData[].entries[].inputTokens'
    );

    expect(rec.affected).toBe(10);
    expect(rec.reclaim?.evidenceTokens).toBe(500);
    expect(resultBytesObservation).toMatchObject({ value: 2_000 });
    expect(resultCallsObservation).toMatchObject({ value: 5 });
    expect(resultCallsObservation?.claim).toContain(
      '5 result-bearing Bash call(s) supplied those linked result characters'
    );
  });

  it('fires and emits a workflow ReclaimClaim (direct byte delta)', () => {
    const rec = detector.rule(input(), 0);
    expect(rec?.id).toBe('workflow.native-bypass');
    expect(rec?.reclaim).toBeDefined();
    expect(rec?.reclaim?.category).toBe('workflow');
    expect(rec?.reclaim?.cause).toBe('workflow-rework');
    expect(rec?.reclaim?.orderKey).toBeGreaterThanOrEqual(10);
    expect(rec?.reclaim?.orderKey).toBeLessThan(40);
    // 4800 bypass result bytes / 4 = 1200 direct tokens.
    expect(rec?.reclaim?.evidenceTokens).toBe(1200);
    expect(rec?.reclaim?.counterfactual.kind).toBe('scaleTokens');
    expect(rec?.claimClass).toBe('causal');
    expect(rec?.proofTier).toBe('auditable');
    expect(rec?.provenance?.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: 4_800 }),
        expect.objectContaining({ value: 1_200 }),
      ])
    );
  });

  it('books the byte delta through the cascade and preserves the identity', () => {
    const rec = detector.rule(input(), 0);
    const result = runReclaimCascade([rec!.reclaim!], tokenData);
    expect(result.total).toBeGreaterThan(0);
    expect(result.byCategory.workflow).toBeCloseTo(result.total, 9);
    expect(result.billOriginal - result.billFinal).toBeCloseTo(result.total, 9);
  });

  it('audits the unrounded reclaim request separately from coverage metadata', () => {
    const oddBytes = commandData('grep foo src', 10).map((session) => ({
      ...session,
      calls: session.calls.map((call, index) => ({
        ...call,
        resultBytes: index === 0 ? 13 : 0,
      })),
    }));
    const rec = detector.rule(input({ toolData: oddBytes }), 0)!;

    expect(rec.reclaim?.evidenceTokens).toBe(3);
    expect(rec.reclaim?.counterfactual).toMatchObject({
      kind: 'scaleTokens',
      poolDeltaFrac: { input: 3.25 / 100_000 },
    });
    expect(rec.provenance?.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: 13 }),
        expect.objectContaining({ value: 3.25 }),
      ])
    );
    expect(
      rec.provenance?.observations.some((observation) =>
        observation.claim.includes('booked')
      )
    ).toBe(false);
  });

  it('omits the claim when no token data resolves the bypassing session', () => {
    const rec = detector.rule(input({ tokenData: [] }), 0);
    expect(rec?.id).toBe('workflow.native-bypass');
    expect(rec?.reclaim).toBeUndefined();
  });

  it('offers illustrative CLAUDE.md guidance only for observed categories', () => {
    const rec = detector.rule(input(), 0);
    expect(rec?.view).toBe('tools');
    expect(rec?.fix?.target).toBe('CLAUDE.md');
    expect(effectiveFixKind(rec!.fix!)).toBe('illustrative');
    expect(validateFixSnippet(rec!.fix!)).toEqual([]);
    expect(rec?.fix?.snippet).toContain('Bash `grep`');
    expect(rec?.fix?.snippet).not.toContain('Bash `find`');
    expect(rec?.fix?.snippet).not.toContain('Bash `cat`');
    expect(rec?.fix?.snippet).not.toContain('permissions');
    expect(rec?.fix?.snippet).not.toMatch(/Bash\([^)]*:\*\)/);
  });

  it('suppresses on a complete matching ask or deny policy, but not an unrelated one', () => {
    expect(
      detector.rule(
        input({ liveConfig: config({ deny: ['Bash(grep:*)'] }) }),
        0
      )
    ).toBeNull();
    expect(
      detector.rule(
        input({ liveConfig: config({ ask: ['Bash(grep:*)'] }) }),
        0
      )
    ).toBeNull();
    expect(
      detector.rule(
        input({ liveConfig: config({ deny: ['Bash(find:*)'] }) }),
        0
      )
    ).not.toBeNull();

    expect(
      detector.rule(
        input({ liveConfig: config({ deny: ['Bash'] }) }),
        0
      )
    ).toBeNull();
    expect(
      detector.rule(
        input({ liveConfig: config({ ask: ['Bash'] }) }),
        0
      )
    ).toBeNull();
    expect(
      detector.rule(
        input({
          toolData: commandData('cd /tmp'),
          liveConfig: config({ deny: ['Bash'] }),
        }),
        0
      )
    ).toBeNull();
    expect(
      detector.rule(
        input({
          toolData: commandData('FOO=1 rg foo src'),
          liveConfig: config({ ask: ['Bash'] }),
        }),
        0
      )
    ).toBeNull();

    const mixedMapped: ToolUsageData[] = [
      {
        sessionId: 's1',
        calls: [
          ...commandData('grep foo src', 6)[0].calls,
          ...commandData('find . -name "*.ts"', 6)[0].calls.map(
            (call, index) => ({ ...call, toolUseId: `find-${index}` })
          ),
        ],
      },
    ];
    expect(
      detector.rule(
        input({
          toolData: mixedMapped,
          liveConfig: config({
            deny: ['Bash(grep:*)'],
            ask: ['Bash(find:*)'],
          }),
        }),
        0
      )
    ).toBeNull();
  });

  it('never hides a category that still prevents complete policy suppression', () => {
    const commands = [
      'grep foo src',
      'find src -name "*.ts"',
      'cat README.md',
      'sed -n 1p README.md',
      'awk "{print $1}" data.txt',
    ];
    const allCategories: ToolUsageData[] = [
      {
        sessionId: 's1',
        calls: commands.flatMap((command, commandIndex) =>
          commandData(command, 2)[0].calls.map((call, callIndex) => ({
            ...call,
            toolUseId: `category-${commandIndex}-${callIndex}`,
          }))
        ),
      },
    ];
    const visibleFour = [
      'Bash(grep:*)',
      'Bash(find:*)',
      'Bash(cat:*)',
      'Bash(sed:*)',
    ];
    const rec = detector.rule(
      input({
        toolData: allCategories,
        liveConfig: config({ ask: visibleFour }),
      }),
      0
    );

    expect(rec).not.toBeNull();
    expect(rec?.detail).toContain('awk (2)');
    expect(rec?.evidence).toContain(
      'awk → Read/Edit: 2 category match(es)'
    );
    expect(rec?.fix?.snippet).toContain('Bash `awk`');
    expect(
      detector.rule(
        input({
          toolData: allCategories,
          liveConfig: config({ ask: [...visibleFour, 'Bash(awk:*)'] }),
        }),
        0
      )
    ).toBeNull();
  });

  it('requires policy coverage for the observed alias, not its collapsed category', () => {
    expect(
      detector.rule(
        input({
          toolData: commandData('rg foo src'),
          liveConfig: config({ deny: ['Bash(grep:*)'] }),
        }),
        0
      )
    ).not.toBeNull();
    expect(
      detector.rule(
        input({
          toolData: commandData('rg foo src'),
          liveConfig: config({ ask: ['Bash(rg:*)'] }),
        }),
        0
      )
    ).toBeNull();
    expect(
      detector.rule(
        input({
          toolData: commandData('head README.md'),
          liveConfig: config({ deny: ['Bash(cat:*)'] }),
        }),
        0
      )
    ).not.toBeNull();
    expect(
      detector.rule(
        input({
          toolData: commandData('head README.md'),
          liveConfig: config({ ask: ['Bash(head:*)'] }),
        }),
        0
      )
    ).toBeNull();

    expect(
      detector.rule(
        input({
          toolData: commandData('FOO=1 rg foo src'),
          liveConfig: config({ ask: ['Bash(rg:*)'] }),
        }),
        0
      )
    ).not.toBeNull();

    const newlineBulk = commandData('grep\nfoo src').map((session) => ({
      ...session,
      calls: session.calls.map((call) => ({
        ...call,
        input: {},
        commandHead: 'grep',
        commandPreview: 'grep foo src',
        commandBypassCategories: ['grep'] as const,
      })),
    }));
    expect(
      detector.rule(
        input({
          toolData: newlineBulk,
          liveConfig: config({ deny: ['Bash(grep:*)'] }),
        }),
        0
      )
    ).not.toBeNull();
  });

  it('names observed aliases in guidance instead of collapsed categories', () => {
    const rg = detector.rule(input({ toolData: commandData('rg foo src') }), 0);
    expect(rg?.fix?.snippet).toContain('Bash `rg`');
    expect(rg?.fix?.snippet).not.toContain('Bash `grep`');

    const envRg = detector.rule(
      input({ toolData: commandData('FOO=1 rg foo src') }),
      0
    );
    expect(envRg?.fix?.snippet).toContain('Bash `rg`');
    expect(envRg?.fix?.snippet).not.toContain('Bash `grep`');

    for (const command of [
      'env FOO=1 rg foo src',
      'true && rg foo src',
      'find src -name "*.ts" && rg foo src',
    ]) {
      const wrapped = detector.rule(
        input({ toolData: commandData(command) }),
        0
      );
      expect(wrapped?.fix?.snippet).toContain('Bash `rg`');
      expect(wrapped?.fix?.snippet).not.toContain('Bash `grep`');
    }

    const head = detector.rule(
      input({ toolData: commandData('head README.md') }),
      0
    );
    expect(head?.fix?.snippet).toContain('Bash `head`');
    expect(head?.fix?.snippet).not.toContain('Bash `cat`');
  });

  it('self-suppresses only when the complete guidance markers are present', () => {
    const rec = detector.rule(input(), 0)!;
    expect(rec.fix?.appliedMarkers).toEqual(detector.appliedMarkers);
    expect(
      detector.rule(input({ liveConfig: config({}, rec.fix!.snippet) }), 0)
    ).toBeNull();
    expect(
      detector.rule(
        input({
          liveConfig: config(
            {},
            '## Prefer native tools and path-safe shell usage\n\nUnrelated prose.'
          ),
        }),
        0
      )
    ).not.toBeNull();
    expect(
      detector.rule(
        input({
          liveConfig: config(
            {},
            'Choose native tools or path-safe alternatives before Bash, but this has no heading.'
          ),
        }),
        0
      )
    ).not.toBeNull();
  });

  it('does not invent fallback categories or let unrelated policy hide cd guidance', () => {
    const grepGuidance = detector.rule(input(), 0)!.fix!.snippet;
    const rec = detector.rule(
      input({
        toolData: commandData('cd /tmp'),
        liveConfig: config({
          deny: ['Bash(grep:*)', 'Bash(find:*)', 'Bash(cat:*)'],
        }),
      }),
      0
    );

    expect(rec).not.toBeNull();
    expect(rec?.fix?.snippet).toContain('Avoid a standalone Bash `cd` command');
    expect(rec?.fix?.snippet).toContain('`cd <dir> && <cmd>`');
    expect(rec?.fix?.snippet).not.toContain('Bash `grep`');
    expect(rec?.fix?.snippet).not.toContain('Bash `find`');
    expect(rec?.fix?.snippet).not.toContain('Bash `cat`');

    // The policy sentence is universal even though its examples name only the
    // observed grep category, so the same static marker consistently covers a
    // later path-safety finding (detector, append path, and scorecard agree).
    expect(
      detector.rule(
        input({
          toolData: commandData('cd /tmp'),
          liveConfig: config({}, grepGuidance),
        }),
        0
      )
    ).toBeNull();
    // A legacy category-specific grep snippet did not state that universal
    // policy, so it must not falsely suppress a later cd finding.
    expect(
      detector.rule(
        input({
          toolData: commandData('cd /tmp'),
          liveConfig: config(
            {},
            '## Prefer native tools over shell equivalents\n\n' +
              'Native tools are faster, cost fewer context tokens.\n\n' +
              '- Use the native Grep tool instead of Bash `grep`.'
          ),
        }),
        0
      )
    ).not.toBeNull();
    expect(
      detector.rule(
        input({
          toolData: commandData('cd /tmp'),
          liveConfig: config({}, rec!.fix!.snippet),
        }),
        0
      )
    ).toBeNull();
  });

  it('does not let a mapped policy hide guidance for an unmappable observed category', () => {
    const mixed: ToolUsageData[] = [
      {
        sessionId: 's1',
        calls: [
          ...commandData('grep foo src', 6)[0].calls,
          ...commandData('cd /tmp', 6)[0].calls.map((call, index) => ({
            ...call,
            toolUseId: `cd-${index}`,
          })),
        ],
      },
    ];

    expect(
      detector.rule(
        input({
          toolData: mixed,
          liveConfig: config({ deny: ['Bash(grep:*)'] }),
        }),
        0
      )
    ).not.toBeNull();
  });

  it('cites dated category evidence and demotes stale wording', () => {
    const fresh = detector.rule(
      input(),
      Date.parse('2026-01-02T00:00:00Z')
    )!;
    expect(fresh.detail).toMatch(/^Through 2026-01-01,/);
    expect(fresh.provenance?.asOf).toBe('2026-01-01');
    expect(fresh.provenance?.stale).toBe(false);
    expect(fresh.provenance?.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'parse-tools',
          value: 'grep=12',
        }),
        expect.objectContaining({ value: '12/12' }),
      ])
    );
    expect(validateRecommendationProvenance(fresh)).toEqual([]);

    const stale = detector.rule(
      input(),
      Date.parse('2026-02-15T00:00:00Z')
    )!;
    expect(stale.detail).toMatch(/^As of 2026-01-01,/);
    expect(stale.provenance?.stale).toBe(true);

    const partialDates = commandData('grep foo src').map((session) => ({
      ...session,
      calls: session.calls.map((call, index) => ({
        ...call,
        timestamp: index === 0 ? call.timestamp : '',
      })),
    }));
    const incomplete = detector.rule(
      input({ toolData: partialDates }),
      Date.parse('2026-02-15T00:00:00Z')
    )!;
    expect(incomplete.detail).toMatch(/^The available tool history recorded/);
    expect(incomplete.provenance?.asOf).toBeUndefined();
    expect(incomplete.provenance?.stale).toBeUndefined();
    expect(incomplete.provenance?.observations).toEqual(
      expect.arrayContaining([expect.objectContaining({ value: '1/12' })])
    );

    const future = detector.rule(
      input({
        toolData: commandData(
          'grep foo src',
          12,
          Date.parse('2099-01-01T00:00:00Z')
        ),
      }),
      Date.parse('2026-02-15T00:00:00Z')
    )!;
    expect(future.detail).toMatch(/^The available tool history recorded/);
    expect(future.provenance?.asOf).toBeUndefined();
    expect(future.provenance?.stale).toBeUndefined();
  });

  it('stays silent below the bypass-call floor', () => {
    const few: ToolUsageData[] = [
      { sessionId: 's1', calls: Array.from({ length: 3 }, (_, i) => grepCall(i)) },
    ];
    expect(detector.rule(input({ toolData: few }), 0)).toBeNull();
  });
});
