import { describe, expect, it } from 'vitest';
import { detector } from './value-of-agent-handoff';
import {
  buildRecommendations,
  filterRecommendationsByProject,
} from '../../recommendations';
import { validateFixSnippet } from '../fix-validity';
import { validateRecommendationProvenance } from '../provenance';
import { computeSuppressionTransitions } from '../suppression-transition';
import type { RecommendationInput } from '../types';
import type { ToolCall, ToolUsageData } from '../../parse-tools';
import type { SessionTimeline, TimelineEntry } from '../../parse-timeline';
import { slimSessionTimeline, isRediscoveryText } from '../../parse-timeline';
import type { LiveConfig, SessionTokenData } from '../../../types';

const NOW = Date.parse('2026-07-09T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

function at(base: number, offsetMin: number): string {
  return new Date(base + offsetMin * 60_000).toISOString();
}

function bash(command: string, timestamp: string, toolUseId = 'durable-1'): ToolCall {
  return {
    timestamp,
    toolName: 'Bash',
    input: { command },
    toolUseId,
    isError: false,
    resultBytes: 1200,
  };
}

function writeRunbook(
  filePath: string,
  timestamp: string,
  options: {
    marker?: boolean;
    isError?: boolean;
    toolName?: 'Write' | 'Edit' | 'MultiEdit';
  } = {}
): ToolCall {
  return {
    timestamp,
    toolName: options.toolName ?? 'Write',
    input: { file_path: filePath },
    toolUseId: 'runbook-1',
    isError: options.isError ?? false,
    resultBytes: 0,
    ...(options.marker === false ? {} : { leaveBehindStructure: 'v1' as const }),
  };
}

function toolSession(sessionId: string, calls: ToolCall[]): ToolUsageData {
  return { sessionId, calls };
}

function timeline(sessionId: string, base: number, entries: TimelineEntry[]): SessionTimeline {
  return {
    sessionId,
    startTime: at(base, 0),
    endTime: entries[entries.length - 1]?.timestamp ?? at(base, 0),
    entries,
  };
}

function user(timestamp: string, summary: string): TimelineEntry {
  return { timestamp, kind: 'user', summary };
}

// Mirrors what the parser sets: the `rediscovery` boolean is derived from the
// full turn text at parse time (see parse-timeline.isRediscoveryText), so it
// survives slimSessionTimeline. Used to build production-shape (slim) fixtures.
function redUser(timestamp: string, summary: string): TimelineEntry {
  return {
    timestamp,
    kind: 'user',
    summary,
    ...(isRediscoveryText(summary) ? { rediscovery: true } : {}),
  };
}

function assistant(timestamp: string, summary: string): TimelineEntry {
  return { timestamp, kind: 'assistant', summary };
}

function sessionMeta(sessionId: string, project = '/repo/app'): RecommendationInput['sessions'][number] {
  return { sessionId, project, projectShort: 'app' } as unknown as RecommendationInput['sessions'][number];
}

function tokenMeta(sessionId: string, contextToolResultTokensSum = 4000): SessionTokenData {
  return {
    sessionId,
    project: '/repo/app',
    entrypoint: 'cli',
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 0,
    contextToolResultTokensSum,
    model: 'claude-opus-4-8',
    messageCount: 1,
    entries: [
      {
        timestamp: '2026-07-01T00:00:00.000Z',
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheCreation1hTokens: 0,
        cacheReadTokens: 0,
        webSearchRequests: 0,
        webFetchRequests: 0,
        model: 'claude-opus-4-8',
        toolUseIds: ['durable-1'],
        toolResultBytes: 1200,
      },
    ],
    compactionEvents: [],
    hasUnknownModel: false,
  } as unknown as SessionTokenData;
}

function liveConfig(claudeMd: string | null = null): LiveConfig {
  return {
    settings: {},
    settingsHealth: null,
    claudeMd: { global: claudeMd, perProject: {} },
    plugins: [],
    mcpServers: [],
    skills: [],
    subagents: [],
    commands: [],
  } as unknown as LiveConfig;
}

function input(over: Partial<RecommendationInput> = {}): RecommendationInput {
  return {
    tokenData: [],
    toolData: [],
    sessions: [],
    projects: [],
    permissionRows: [],
    apiErrors: [],
    liveConfig: liveConfig(),
    ...over,
  };
}

const durableCommand =
  "ssh deploy@app 'sudo tee /etc/app/config.yaml >/dev/null && sudo systemctl restart app'";

describe('workflow.value-of-agent-handoff', () => {
  it('fires with evidence for a durable-state mutation and bills rediscovery to the right prior session', () => {
    const setupBase = Date.parse('2026-07-01T10:00:00.000Z');
    const rediscoveryBase = Date.parse('2026-07-03T10:00:00.000Z');
    const rec = detector.rule(
      input({
        toolData: [
          toolSession('setup-old', [
            bash('kubectl apply -f old.yaml', at(setupBase - DAY, 0), 'old-durable'),
          ]),
          toolSession('setup-new', [bash(durableCommand, at(setupBase, 0), 'new-durable')]),
        ],
        timelines: [
          timeline('rediscover-new', rediscoveryBase, [
            user(at(rediscoveryBase, 0), 'where is the remote config for this service?'),
            assistant(at(rediscoveryBase, 9), 'I need to find how this was set up and where the state lives.'),
            user(at(rediscoveryBase, 18), 'which template created the deployed config?'),
          ]),
        ],
        sessions: [
          sessionMeta('setup-old'),
          sessionMeta('setup-new'),
          sessionMeta('rediscover-new'),
        ],
        tokenData: [tokenMeta('setup-new'), tokenMeta('rediscover-new')],
      }),
      NOW
    );

    expect(rec?.id).toBe('workflow.value-of-agent-handoff');
    expect(rec?.affected).toBe(2);
    expect(rec?.estTimeReclaimedMin).toBeGreaterThan(30);
    expect(rec?.evidence?.[1]).toContain('setup-n');
    expect(rec?.evidence?.[1]).toContain('rediscover');
    expect(rec?.provenance?.observations.some((o) => String(o.value).includes('new-durable'))).toBe(true);
    expect(rec?.provenance?.observations.some((o) => o.field?.includes('TokenEntry.toolUseIds'))).toBe(true);
    expect(validateRecommendationProvenance(rec!)).toEqual([]);
  });

  it('fires cold-start from the pre-signal alone with a conservative hypothesis floor', () => {
    const setupBase = Date.parse('2026-07-01T10:00:00.000Z');
    const rec = detector.rule(
      input({
        toolData: [toolSession('setup-day-one', [bash(durableCommand, at(setupBase, 0))])],
        sessions: [sessionMeta('setup-day-one')],
        tokenData: [tokenMeta('setup-day-one')],
      }),
      NOW
    );

    expect(rec?.estTimeReclaimedMin).toBe(15);
    expect(rec?.detail).toMatch(/cold-start pre-signal/i);
    expect(rec?.detail).toMatch(/hypothesis/i);
    expect(rec?.detail).not.toMatch(/\bproven\b/i);
    expect(rec?.claimClass).toBe('causal');
    expect(rec?.proofTier).toBe('auditable');
    expect(rec?.provenance?.observations[2].claim).toMatch(/conservative preset floor/i);
  });

  it('demotes stale signals to "As of <date>" with provenance.asOf and stale=true', () => {
    const oldBase = Date.parse('2026-04-01T10:00:00.000Z');
    const rec = detector.rule(
      input({
        toolData: [toolSession('setup-old', [bash(durableCommand, at(oldBase, 0))])],
        sessions: [sessionMeta('setup-old')],
      }),
      NOW
    );

    expect(rec?.detail).toMatch(/^As of 2026-04-01,/);
    expect(rec?.provenance?.asOf).toBe('2026-04-01');
    expect(rec?.provenance?.stale).toBe(true);
    expect(validateRecommendationProvenance(rec!)).toEqual([]);
  });

  it('suppresses when there is no durable-state mutation', () => {
    const rec = detector.rule(
      input({
        toolData: [toolSession('local-only', [bash('npm test', '2026-07-01T00:00:00.000Z')])],
        sessions: [sessionMeta('local-only')],
      }),
      NOW
    );

    expect(rec).toBeNull();
  });

  it('uses precomputed durable truth after the full Bash body is stripped', () => {
    const setupBase = Date.parse('2026-07-01T10:00:00.000Z');
    const strippedCall: ToolCall = {
      ...bash('preview only', at(setupBase, 0), 'buried-durable'),
      input: {},
      commandPreview: 'echo preparing-local-input '.repeat(8).slice(0, 200),
      commandDurableKind: 'remote-state',
    };
    const rec = detector.rule(
      input({
        toolData: [toolSession('setup-stripped', [strippedCall])],
        sessions: [sessionMeta('setup-stripped')],
      }),
      NOW
    );

    expect(rec?.id).toBe('workflow.value-of-agent-handoff');
    expect(rec?.evidence?.[0]).toContain('full Bash command (body omitted)');
    expect(rec?.provenance?.observations.some(
      (observation) => observation.field === 'ToolCall.commandDurableKind'
    )).toBe(true);
  });

  it('does not treat a transcript-only structural candidate as committed evidence', () => {
    const setupBase = Date.parse('2026-07-01T10:00:00.000Z');
    const detectorInput = input({
        toolData: [
          toolSession('setup-with-runbook', [
            bash(durableCommand, at(setupBase, 0)),
            writeRunbook(
              'docs/runbooks/app-production/README.md',
              at(setupBase, 2)
            ),
          ]),
        ],
        sessions: [sessionMeta('setup-with-runbook')],
      });
    const rec = detector
      .emitAll?.(detectorInput, NOW)
      .find((item) => item.id === 'workflow.leave-behind-candidate-verification');

    expect(rec?.id).toBe('workflow.leave-behind-candidate-verification');
    expect(rec?.evidence?.join(' ')).toMatch(
      /1 structural candidate observation.*Git HEAD is unobserved/i
    );
    expect(rec?.action).toMatch(/verify.*tracked at HEAD/i);
    expect(rec?.action).toMatch(/covers the durable mutation/i);
    expect(rec?.estTimeReclaimedMin).toBeUndefined();
    expect(rec?.claimClass).toBe('accounting');
    expect(validateRecommendationProvenance(rec!)).toEqual([]);
  });

  it('does not suppress for a path-only runbook Write without structural proof', () => {
    const setupBase = Date.parse('2026-07-01T10:00:00.000Z');
    const rec = detector.rule(
      input({
        toolData: [
          toolSession('setup-with-half-runbook', [
            bash(durableCommand, at(setupBase, 0)),
            writeRunbook(
              'docs/runbooks/app-production/README.md',
              at(setupBase, 2),
              { marker: false }
            ),
          ]),
        ],
        sessions: [sessionMeta('setup-with-half-runbook')],
      }),
      NOW
    );

    expect(rec?.id).toBe('workflow.value-of-agent-handoff');
  });

  it('does not suppress when a conformant leave-behind Write failed', () => {
    const setupBase = Date.parse('2026-07-01T10:00:00.000Z');
    const rec = detector.rule(
      input({
        toolData: [
          toolSession('setup-with-failed-runbook', [
            bash(durableCommand, at(setupBase, 0)),
            writeRunbook(
              'docs/runbooks/app-production/README.md',
              at(setupBase, 2),
              { isError: true }
            ),
          ]),
        ],
        sessions: [sessionMeta('setup-with-failed-runbook')],
      }),
      NOW
    );

    expect(rec?.id).toBe('workflow.value-of-agent-handoff');
  });

  it.each([
    { toolName: 'Write' as const, label: 'a later nonconformant full Write' },
    { toolName: 'Edit' as const, label: 'a later partial Edit' },
    { toolName: 'MultiEdit' as const, label: 'a later partial MultiEdit' },
  ])('invalidates candidate evidence after $label', ({ toolName }) => {
    const setupBase = Date.parse('2026-07-01T10:00:00.000Z');
    const rec = detector.rule(
      input({
        toolData: [
          toolSession('setup-overwritten-runbook', [
            bash(durableCommand, at(setupBase, 0)),
            writeRunbook(
              'docs/runbooks/app-production/README.md',
              at(setupBase, 2)
            ),
            writeRunbook(
              'docs/runbooks/app-production/README.md',
              at(setupBase, 3),
              { marker: false, toolName }
            ),
          ]),
        ],
        sessions: [sessionMeta('setup-overwritten-runbook')],
      }),
      NOW
    );

    expect(rec?.id).toBe('workflow.value-of-agent-handoff');
    expect(rec?.evidence?.join(' ')).not.toMatch(/final structural candidate/i);
    expect(rec?.estTimeReclaimedMin).toBe(15);
  });

  it.each(['Write', 'Edit', 'MultiEdit'] as const)(
    'invalidates candidate evidence after a later same-project %s in another session',
    (toolName) => {
      const setupBase = Date.parse('2026-07-01T10:00:00.000Z');
      const detectorInput = input({
        // Deliberately reverse the session rows: timestamps, not array order,
        // prove that the invalidation happened later.
        toolData: [
          toolSession('later-editor', [
            writeRunbook(
              '/workspace/repo/docs/runbooks/app-production/README.md',
              at(setupBase, 3),
              { marker: false, toolName }
            ),
          ]),
          toolSession('setup-with-candidate', [
            bash(durableCommand, at(setupBase, 0)),
            writeRunbook(
              'docs/runbooks/app-production/README.md',
              at(setupBase, 2)
            ),
          ]),
        ],
        sessions: [
          sessionMeta('setup-with-candidate'),
          sessionMeta('later-editor'),
        ],
      });
      const recommendations = detector.emitAll?.(detectorInput, NOW) ?? [];

      expect(recommendations.map((rec) => rec.id)).toEqual([
        'workflow.value-of-agent-handoff',
      ]);
      expect(recommendations[0].evidence?.join(' ')).toContain('later-ed');
      expect(recommendations[0].provenance?.observations.some(
        (observation) => observation.claim.includes('latest observed invalidated state')
      )).toBe(true);
    }
  );

  it('does not cross-invalidate a candidate from another project', () => {
    const setupBase = Date.parse('2026-07-01T10:00:00.000Z');
    const detectorInput = input({
      toolData: [
        toolSession('setup-alpha', [
          bash(durableCommand, at(setupBase, 0)),
          writeRunbook('docs/runbooks/app-production/README.md', at(setupBase, 2)),
        ]),
        toolSession('editor-beta', [
          writeRunbook('docs/runbooks/app-production/README.md', at(setupBase, 3), {
            marker: false,
            toolName: 'Edit',
          }),
        ]),
      ],
      sessions: [
        sessionMeta('setup-alpha', '/repo/alpha'),
        sessionMeta('editor-beta', '/repo/beta'),
      ],
    });

    expect(detector.emitAll?.(detectorInput, NOW).map((rec) => rec.id)).toEqual([
      'workflow.leave-behind-candidate-verification',
    ]);
  });

  it('restores candidate evidence after a later conformant same-project Write', () => {
    const setupBase = Date.parse('2026-07-01T10:00:00.000Z');
    const detectorInput = input({
      toolData: [
        toolSession('setup-with-candidate', [
          bash(durableCommand, at(setupBase, 0)),
          writeRunbook(
            'docs/runbooks/app-production/README.md',
            at(setupBase, 2)
          ),
        ]),
        toolSession('later-editor', [
          writeRunbook(
            'docs/runbooks/app-production/README.md',
            at(setupBase, 3),
            { marker: false, toolName: 'Edit' }
          ),
          writeRunbook(
            'docs/runbooks/app-production/README.md',
            at(setupBase, 4)
          ),
        ]),
      ],
      sessions: [
        sessionMeta('setup-with-candidate'),
        sessionMeta('later-editor'),
      ],
    });

    expect(detector.emitAll?.(detectorInput, NOW).map((rec) => rec.id)).toEqual([
      'workflow.leave-behind-candidate-verification',
    ]);
  });

  it('dates an invalidated candidate from the deciding later transition', () => {
    const setupBase = Date.parse('2026-02-01T10:00:00.000Z');
    const invalidatedAt = '2026-05-01T10:00:00.000Z';
    const rec = detector.rule(
      input({
        toolData: [
          toolSession('old-setup', [
            bash(durableCommand, at(setupBase, 0)),
            writeRunbook(
              'docs/runbooks/app-production/README.md',
              at(setupBase, 2)
            ),
          ]),
          toolSession('later-editor', [
            writeRunbook(
              'docs/runbooks/app-production/README.md',
              invalidatedAt,
              { marker: false, toolName: 'Edit' }
            ),
          ]),
        ],
        sessions: [sessionMeta('old-setup'), sessionMeta('later-editor')],
      }),
      NOW
    );

    expect(rec?.id).toBe('workflow.value-of-agent-handoff');
    expect(rec?.detail).toMatch(/^As of 2026-05-01,/);
    expect(rec?.provenance?.asOf).toBe('2026-05-01');
    expect(rec?.provenance?.observations.some(
      (observation) => observation.source.includes('sessions')
    )).toBe(true);
  });

  it('dates and cites a candidate from the deciding later restoration', () => {
    const setupBase = Date.parse('2026-02-01T10:00:00.000Z');
    const detectorInput = input({
      toolData: [
        toolSession('old-setup', [
          bash(durableCommand, at(setupBase, 0)),
          writeRunbook(
            'docs/runbooks/app-production/README.md',
            at(setupBase, 2)
          ),
        ]),
        toolSession('middle-editor', [
          writeRunbook(
            'docs/runbooks/app-production/README.md',
            '2026-04-01T10:00:00.000Z',
            { marker: false, toolName: 'Edit' }
          ),
        ]),
        toolSession('restorer-latest', [
          writeRunbook(
            'docs/runbooks/app-production/README.md',
            '2026-07-08T10:00:00.000Z'
          ),
        ]),
      ],
      sessions: [
        sessionMeta('old-setup'),
        sessionMeta('middle-editor'),
        sessionMeta('restorer-latest'),
      ],
    });
    const rec = detector
      .emitAll?.(detectorInput, NOW)
      .find((item) => item.id === 'workflow.leave-behind-candidate-verification');

    expect(rec?.provenance?.asOf).toBe('2026-07-08');
    expect(rec?.evidence?.join(' ')).toContain('restorer');
    expect(rec?.provenance?.observations.some(
      (observation) => observation.claim.includes('latest observed conformant Write candidate')
    )).toBe(true);
  });

  it('cites the latest candidate when a project has multiple durable sessions', () => {
    const oldBase = Date.parse('2026-02-01T10:00:00.000Z');
    const newBase = Date.parse('2026-07-08T10:00:00.000Z');
    const rec = detector.rule(
      input({
        toolData: [
          toolSession('old-candidate', [
            bash(durableCommand, at(oldBase, 0)),
            writeRunbook(
              'docs/runbooks/old-production/README.md',
              at(oldBase, 2)
            ),
          ]),
          toolSession('newer-candidate', [
            bash(durableCommand, at(newBase, 0)),
            writeRunbook(
              'docs/runbooks/new-production/README.md',
              at(newBase, 2)
            ),
          ]),
        ],
        sessions: [
          sessionMeta('old-candidate'),
          sessionMeta('newer-candidate'),
        ],
      }),
      NOW
    );

    expect(rec?.id).toBe('workflow.leave-behind-candidate-verification');
    expect(rec?.evidence?.[0]).toContain('newer-ca');
    expect(rec?.evidence?.[1]).toContain('newer-ca');
    expect(rec?.action).toContain('docs/runbooks/new-production/README.md');
    expect(rec?.action).not.toContain('docs/runbooks/old-production/README.md');
    expect(rec?.provenance?.asOf).toBe('2026-07-08');
  });

  it('does not invent order for conflicting cross-session transitions at the same timestamp', () => {
    const setupBase = Date.parse('2026-07-01T10:00:00.000Z');
    const detectorInput = input({
      toolData: [
        toolSession('setup-with-candidate', [
          bash(durableCommand, at(setupBase, 0)),
          writeRunbook(
            'docs/runbooks/app-production/README.md',
            at(setupBase, 2)
          ),
        ]),
        toolSession('same-time-editor', [
          writeRunbook(
            'docs/runbooks/app-production/README.md',
            at(setupBase, 3),
            { marker: false, toolName: 'Edit' }
          ),
        ]),
        toolSession('same-time-writer', [
          writeRunbook(
            'docs/runbooks/app-production/README.md',
            at(setupBase, 3)
          ),
        ]),
      ],
      sessions: [
        sessionMeta('setup-with-candidate'),
        sessionMeta('same-time-editor'),
        sessionMeta('same-time-writer'),
      ],
    });

    const recommendations = detector.emitAll?.(detectorInput, NOW) ?? [];
    expect(recommendations.map((rec) => rec.id)).toEqual([
      'workflow.leave-behind-candidate-verification',
    ]);
    const verification = recommendations[0];
    expect(verification.detail).toMatch(
      /conflicting candidate and invalidation transitions that cannot be ordered/i
    );
    expect(verification.evidence?.join(' ')).toMatch(/state conflict.*unordered/i);
    expect(verification.detail).not.toMatch(/latest observed same-project file state/i);
    expect(verification.evidence?.join(' ')).not.toMatch(/final structural candidate/i);
    expect(verification.provenance?.inference).toMatch(/final state.*not claimed/i);
  });

  it('keeps an equal-time cross-session candidate when the durable session ended invalidated', () => {
    const setupBase = Date.parse('2026-07-01T10:00:00.000Z');
    const sameTimestamp = at(setupBase, 3);
    const detectorInput = input({
      toolData: [
        toolSession('setup-invalidated', [
          bash(durableCommand, at(setupBase, 0)),
          writeRunbook(
            'docs/runbooks/app-production/README.md',
            sameTimestamp,
            { marker: false }
          ),
        ]),
        toolSession('same-time-writer', [
          writeRunbook(
            'docs/runbooks/app-production/README.md',
            sameTimestamp
          ),
        ]),
      ],
      sessions: [
        sessionMeta('setup-invalidated'),
        sessionMeta('same-time-writer'),
      ],
    });

    const recommendations = detector.emitAll?.(detectorInput, NOW) ?? [];
    expect(recommendations.map((rec) => rec.id)).toEqual([
      'workflow.leave-behind-candidate-verification',
    ]);
    expect(recommendations[0].detail).toMatch(
      /conflicting candidate and invalidation transitions that cannot be ordered/i
    );
  });

  it('does not book missing-artifact savings across an unparseable cross-session timestamp', () => {
    const setupBase = Date.parse('2026-07-01T10:00:00.000Z');
    const detectorInput = input({
      toolData: [
        toolSession('setup-invalidated', [
          bash(durableCommand, at(setupBase, 0)),
          writeRunbook(
            'docs/runbooks/app-production/README.md',
            at(setupBase, 2),
            { marker: false }
          ),
        ]),
        toolSession('unknown-time-writer', [
          writeRunbook(
            'docs/runbooks/app-production/README.md',
            'timestamp-unavailable'
          ),
        ]),
      ],
      sessions: [
        sessionMeta('setup-invalidated'),
        sessionMeta('unknown-time-writer'),
      ],
    });

    const recommendations = detector.emitAll?.(detectorInput, NOW) ?? [];
    expect(recommendations.map((rec) => rec.id)).toEqual([
      'workflow.leave-behind-candidate-verification',
    ]);
    expect(recommendations[0].detail).toMatch(/missing or unparseable timestamps/i);
    expect(recommendations[0].estTimeReclaimedMin).toBeUndefined();
    expect(recommendations[0].provenance?.inference).toMatch(
      /timestamps tie or are unavailable/i
    );
  });

  it.each([
    {
      label: 'a final Edit',
      laterCalls: (timestamp: string) => [
        writeRunbook('docs/runbooks/app-production/README.md', timestamp),
        writeRunbook('docs/runbooks/app-production/README.md', timestamp, {
          marker: false,
          toolName: 'Edit' as const,
        }),
      ],
      expected: ['workflow.value-of-agent-handoff'],
    },
    {
      label: 'a final conformant Write',
      laterCalls: (timestamp: string) => [
        writeRunbook('docs/runbooks/app-production/README.md', timestamp, {
          marker: false,
          toolName: 'Edit' as const,
        }),
        writeRunbook('docs/runbooks/app-production/README.md', timestamp),
      ],
      expected: ['workflow.leave-behind-candidate-verification'],
    },
  ])(
    'uses transcript call order within one same-timestamp session: $label wins',
    ({ laterCalls, expected }) => {
      const setupBase = Date.parse('2026-07-01T10:00:00.000Z');
      const sameTimestamp = at(setupBase, 3);
      const detectorInput = input({
        toolData: [
          toolSession('setup-with-candidate', [
            bash(durableCommand, at(setupBase, 0)),
            writeRunbook(
              'docs/runbooks/app-production/README.md',
              at(setupBase, 2)
            ),
          ]),
          toolSession('same-message-editor', laterCalls(sameTimestamp)),
        ],
        sessions: [
          sessionMeta('setup-with-candidate'),
          sessionMeta('same-message-editor'),
        ],
      });

      expect(detector.emitAll?.(detectorInput, NOW).map((rec) => rec.id)).toEqual(
        expected
      );
    }
  );

  it.each([
    {
      candidatePath: 'docs/runbooks/app-production/README.md',
      invalidationPath: '/workspace/repo/docs/runbooks/app-production/README.md',
    },
    {
      candidatePath: '/workspace/repo/docs/runbooks/app-production/README.md',
      invalidationPath: 'docs/runbooks/app-production/README.md',
    },
  ])(
    'invalidates a candidate across relative/absolute aliases ($candidatePath)',
    ({ candidatePath, invalidationPath }) => {
      const setupBase = Date.parse('2026-07-01T10:00:00.000Z');
      const rec = detector.rule(
        input({
          toolData: [
            toolSession('setup-path-alias', [
              bash(durableCommand, at(setupBase, 0)),
              writeRunbook(candidatePath, at(setupBase, 2)),
              writeRunbook(invalidationPath, at(setupBase, 3), {
                marker: false,
                toolName: 'Edit',
              }),
            ]),
          ],
          sessions: [sessionMeta('setup-path-alias')],
        }),
        NOW
      );

      expect(rec?.title).toBe('Leave a handoff when agents establish durable state');
      expect(rec?.evidence?.join(' ')).not.toMatch(/final structural candidate/i);
    }
  );

  it('does not let a candidate written before a later durable mutation displace the missing-write signal', () => {
    const setupBase = Date.parse('2026-07-01T10:00:00.000Z');
    const rec = detector.rule(
      input({
        toolData: [
          toolSession('setup-after-runbook', [
            writeRunbook(
              'docs/runbooks/app-production/README.md',
              at(setupBase, 5)
            ),
            bash(durableCommand, at(setupBase, 2)),
          ]),
        ],
        sessions: [sessionMeta('setup-after-runbook')],
      }),
      NOW
    );

    expect(rec?.title).toBe('Leave a handoff when agents establish durable state');
    expect(rec?.estTimeReclaimedMin).toBe(15);
    expect(rec?.provenance?.observations[0].claim).toMatch(
      /did not end with an uninvalidated v1 structural candidate written after the latest durable external-state mutation/i
    );
    expect(rec?.evidence?.join(' ')).toMatch(
      /without an uninvalidated final v1 structural candidate written after the latest durable mutation/i
    );
    expect(rec?.detail).toMatch(
      /without an uninvalidated final v1 structural candidate written after the latest durable mutation/i
    );
    expect(rec?.provenance?.observations[0].claim).not.toMatch(
      /no successful final full-file Write.*same transcript/i
    );
  });

  it.each([
    { isError: true as const, label: 'failed' },
    { isError: null, label: 'result-less' },
  ])(
    'does not let a later $label mutation attempt invalidate a successful final candidate',
    ({ isError }) => {
      const setupBase = Date.parse('2026-07-01T10:00:00.000Z');
      const laterAttempt = {
        ...bash(durableCommand, at(setupBase, 3), 'later-attempt'),
        isError,
      };
      const detectorInput = input({
        toolData: [
          toolSession('setup-with-later-attempt', [
            bash(durableCommand, at(setupBase, 0)),
            writeRunbook(
              'docs/runbooks/app-production/README.md',
              at(setupBase, 2)
            ),
            laterAttempt,
          ]),
        ],
        sessions: [sessionMeta('setup-with-later-attempt')],
      });

      const recommendations = detector.emitAll?.(detectorInput, NOW) ?? [];
      expect(recommendations.map((item) => item.id)).toEqual([
        'workflow.leave-behind-candidate-verification',
      ]);
      expect(recommendations[0].estTimeReclaimedMin).toBeUndefined();
    }
  );

  it('suppresses when the durable-state handoff guidance already exists in CLAUDE.md', () => {
    const setupBase = Date.parse('2026-07-01T10:00:00.000Z');
    const rec = detector.rule(
      input({
        toolData: [toolSession('setup-day-one', [bash(durableCommand, at(setupBase, 0))])],
        sessions: [sessionMeta('setup-day-one')],
        liveConfig: liveConfig(
          '## Durable state handoff\n\nDurable external state changes need a handoff artifact.'
        ),
      }),
      NOW
    );

    expect(rec).toBeNull();
  });

  it('keeps candidate verification independent of existing CLAUDE.md guidance', () => {
    const setupBase = Date.parse('2026-07-01T10:00:00.000Z');
    const detectorInput = input({
        toolData: [
          toolSession('setup-with-runbook', [
            bash(durableCommand, at(setupBase, 0)),
            writeRunbook(
              'docs/runbooks/app-production/README.md',
              at(setupBase, 2)
            ),
          ]),
        ],
        sessions: [sessionMeta('setup-with-runbook')],
        liveConfig: liveConfig(
          '## Durable state handoff\n\nDurable external state changes need a handoff artifact.'
        ),
      });
    const rec = detector
      .emitAll?.(detectorInput, NOW)
      .find((item) => item.id === 'workflow.leave-behind-candidate-verification');

    expect(rec?.title).toBe('Verify the leave-behind candidate reached Git');
    expect(rec?.claimClass).toBe('accounting');
  });

  it('records marker suppression for the main finding while candidate verification stays visible', async () => {
    const setupBase = Date.parse('2026-07-01T10:00:00.000Z');
    const detectorInput = input({
      toolData: [
        toolSession('setup-without-runbook', [
          bash(durableCommand, at(setupBase, 0), 'missing-handoff'),
        ]),
        toolSession('setup-with-runbook', [
          bash(durableCommand, at(setupBase, 0), 'candidate-handoff'),
          writeRunbook(
            'docs/runbooks/app-production/README.md',
            at(setupBase, 2)
          ),
        ]),
      ],
      sessions: [
        sessionMeta('setup-without-runbook'),
        sessionMeta('setup-with-runbook'),
      ],
      liveConfig: liveConfig(
        '## Durable state handoff\n\nDurable external state changes need a handoff artifact.'
      ),
    });

    expect(detector.rule(detectorInput, NOW)?.id).toBe(
      'workflow.leave-behind-candidate-verification'
    );
    expect(detector.emitAll?.(detectorInput, NOW).map((rec) => rec.id)).toEqual([
      'workflow.leave-behind-candidate-verification',
    ]);

    const result = await computeSuppressionTransitions(
      detectorInput,
      {
        surfacedFindingIds: ['workflow.value-of-agent-handoff'],
        suppressedFindingIds: [],
      },
      [detector],
      NOW
    );

    expect(result.transitions.map((transition) => transition.findingId)).toEqual([
      'workflow.value-of-agent-handoff',
    ]);
  });

  it('does not invent suppression when candidate verification is visible in both runs', async () => {
    const setupBase = Date.parse('2026-07-01T10:00:00.000Z');
    const detectorInput = input({
      toolData: [
        toolSession('setup-with-runbook', [
          bash(durableCommand, at(setupBase, 0)),
          writeRunbook('docs/runbooks/app-production/README.md', at(setupBase, 2)),
        ]),
      ],
      sessions: [sessionMeta('setup-with-runbook')],
      liveConfig: liveConfig(
        '## Durable state handoff\n\nDurable external state changes need a handoff artifact.'
      ),
    });

    const result = await computeSuppressionTransitions(
      detectorInput,
      {
        surfacedFindingIds: ['workflow.leave-behind-candidate-verification'],
        suppressedFindingIds: [],
      },
      [detector],
      NOW
    );

    expect(result.transitions).toEqual([]);
    expect(result.organic).toEqual([]);
  });

  it('emits the main and candidate findings once each when both apply', () => {
    const setupBase = Date.parse('2026-07-01T10:00:00.000Z');
    const detectorInput = input({
      toolData: [
        toolSession('setup-without-runbook', [
          bash(durableCommand, at(setupBase, 0), 'missing-handoff'),
        ]),
        toolSession('setup-with-runbook', [
          bash(durableCommand, at(setupBase, 0), 'candidate-handoff'),
          writeRunbook('docs/runbooks/app-production/README.md', at(setupBase, 2)),
        ]),
      ],
      sessions: [
        sessionMeta('setup-without-runbook'),
        sessionMeta('setup-with-runbook'),
      ],
    });

    expect(detector.emitAll?.(detectorInput, NOW).map((rec) => rec.id)).toEqual([
      'workflow.value-of-agent-handoff',
      'workflow.leave-behind-candidate-verification',
    ]);
  });

  it('leads both finding evidence rows with session ids for project filtering', () => {
    const setupBase = Date.parse('2026-07-01T10:00:00.000Z');
    const detectorInput = input({
      toolData: [
        toolSession('aaaaaaaa-missing', [
          bash(durableCommand, at(setupBase, 0), 'missing-handoff'),
        ]),
        toolSession('cccccccc-candidate', [
          bash(durableCommand, at(setupBase, 0), 'candidate-handoff'),
          writeRunbook('docs/runbooks/app-production/README.md', at(setupBase, 2)),
        ]),
      ],
      sessions: [
        sessionMeta('aaaaaaaa-missing', '/repo/alpha'),
        sessionMeta('cccccccc-candidate', '/repo/alpha'),
        sessionMeta('bbbbbbbb-other', '/repo/beta'),
      ],
    });
    const recommendations = detector.emitAll?.(detectorInput, NOW) ?? [];

    expect(recommendations.map((rec) => rec.id)).toEqual([
      'workflow.value-of-agent-handoff',
      'workflow.leave-behind-candidate-verification',
    ]);
    expect(recommendations.map((rec) => rec.evidence?.[0])).toEqual([
      expect.stringMatching(/^aaaaaaaa[\s,]/),
      expect.stringMatching(/^cccccccc[\s,]/),
    ]);
    expect(
      filterRecommendationsByProject(
        recommendations,
        '/repo/alpha',
        detectorInput.sessions
      ).map((rec) => rec.id)
    ).toEqual(recommendations.map((rec) => rec.id));
    expect(
      filterRecommendationsByProject(
        recommendations,
        '/repo/beta',
        detectorInput.sessions
      )
    ).toEqual([]);
  });

  it('ships an illustrative fix snippet that passes fix-validity', () => {
    const setupBase = Date.parse('2026-07-01T10:00:00.000Z');
    const rec = detector.rule(
      input({
        toolData: [toolSession('setup-day-one', [bash(durableCommand, at(setupBase, 0))])],
        sessions: [sessionMeta('setup-day-one')],
      }),
      NOW
    )!;

    expect(rec.fix?.target).toBe('CLAUDE.md');
    expect(rec.fix?.fixKind).toBe('illustrative');
    expect(validateFixSnippet(rec.fix!)).toEqual([]);
  });

  it('is registered so buildRecommendations can surface it for /api/recommendations.json', () => {
    const setupBase = Date.parse('2026-07-01T10:00:00.000Z');
    const recs = buildRecommendations(
      input({
        toolData: [toolSession('setup-day-one', [bash(durableCommand, at(setupBase, 0))])],
        sessions: [sessionMeta('setup-day-one')],
      }),
      NOW
    );

    expect(recs.some((rec) => rec.id === 'workflow.value-of-agent-handoff')).toBe(true);
  });

  it('bills rediscovery on a SLIM timeline (no summary, parser-set flag) — the production surface (#2312, finding 1)', () => {
    const setupBase = Date.parse('2026-07-01T10:00:00.000Z');
    const rediscoveryBase = Date.parse('2026-07-03T10:00:00.000Z');
    // Build a rediscovery timeline, then slim it: summary is stripped exactly as
    // the bulk/server dataset does, leaving only the parser-set `rediscovery`
    // flag. Before the fix the detector read `summary` and this billed nothing.
    const slim = slimSessionTimeline(
      timeline('rediscover-new', rediscoveryBase, [
        redUser(at(rediscoveryBase, 0), 'where is the remote config for this service?'),
        redUser(at(rediscoveryBase, 9), 'which template created the deployed config?'),
        redUser(at(rediscoveryBase, 18), 'find the setup for the deployed service'),
      ])
    );
    // Guard: the fixture is genuinely slim (no summary) yet keeps the flag.
    expect(slim.slim).toBe(true);
    expect(slim.entries[0].summary).toBeUndefined();
    expect(slim.entries[0].rediscovery).toBe(true);

    const rec = detector.rule(
      input({
        toolData: [toolSession('setup-new', [bash(durableCommand, at(setupBase, 0), 'new-durable')])],
        timelines: [slim],
        sessions: [sessionMeta('setup-new'), sessionMeta('rediscover-new')],
        tokenData: [tokenMeta('setup-new'), tokenMeta('rediscover-new')],
      }),
      NOW
    );

    // The rediscovery half is alive on the slim surface: warning severity and a
    // "billed back" evidence line, not the cold-start info path.
    expect(rec?.severity).toBe('warning');
    expect(rec?.evidence?.[1]).toContain('billed back');
    expect(validateRecommendationProvenance(rec!)).toEqual([]);
  });

  it('reports the real observed minutes for a sub-15-minute burst, not the preset floor (#2312, finding 2)', () => {
    const setupBase = Date.parse('2026-07-01T10:00:00.000Z');
    const rediscoveryBase = Date.parse('2026-07-03T10:00:00.000Z');
    // Burst spans only 8 minutes end-to-end — below the 15-minute preset.
    const rec = detector.rule(
      input({
        toolData: [toolSession('setup-new', [bash(durableCommand, at(setupBase, 0), 'new-durable')])],
        timelines: [
          timeline('rediscover-new', rediscoveryBase, [
            redUser(at(rediscoveryBase, 0), 'where is the remote config for this service?'),
            redUser(at(rediscoveryBase, 4), 'which template created the deployed config?'),
            redUser(at(rediscoveryBase, 8), 'find the setup for the deployed service'),
          ]),
        ],
        sessions: [sessionMeta('setup-new'), sessionMeta('rediscover-new')],
        tokenData: [tokenMeta('setup-new'), tokenMeta('rediscover-new')],
      }),
      NOW
    )!;

    // The observed figure surfaced everywhere labeled "observed" is the REAL 8,
    // never floored up to the 15-minute preset.
    expect(rec.detail).toContain('8 minute(s) observed');
    const observedObs = rec.provenance?.observations[2];
    expect(observedObs?.value).toBe(8);
    expect(observedObs?.claim).toContain('observed');
    // The 15-minute floor lives ONLY in the hypothesis total: one pre-signal
    // (15) + one burst floored at 15 = 30.
    expect(rec.estTimeReclaimedMin).toBe(30);
    expect(rec.detail).toContain('per rediscovery burst');
    expect(rec.detail).toContain('observed span when longer');
  });

  it('stays silent for a routine project-level install (npm/pip/yarn are not durable state) (#2312, finding 3)', () => {
    for (const cmd of ['npm install', 'pip install requests', 'yarn add left-pad', 'cargo add serde']) {
      const rec = detector.rule(
        input({
          toolData: [toolSession('routine', [bash(cmd, '2026-07-01T00:00:00.000Z')])],
          sessions: [sessionMeta('routine')],
        }),
        NOW
      );
      expect(rec, `expected silence for "${cmd}"`).toBeNull();
    }
  });

  it('still fires for a genuinely durable system-level install (apt) (#2312, finding 3)', () => {
    const rec = detector.rule(
      input({
        toolData: [
          toolSession('setup-apt', [
            bash('sudo apt-get install -y nginx', '2026-07-01T10:00:00.000Z', 'apt-durable'),
          ]),
        ],
        sessions: [sessionMeta('setup-apt')],
      }),
      NOW
    );
    expect(rec?.id).toBe('workflow.value-of-agent-handoff');
  });
});
