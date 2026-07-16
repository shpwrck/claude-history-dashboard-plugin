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
import {
  deriveBashCommandSignals,
  stripToolCommandBodies,
  type ToolCall,
  type ToolUsageData,
} from '../../parse-tools';
import type { SessionTimeline, TimelineEntry } from '../../parse-timeline';
import { slimSessionTimeline, isRediscoveryText } from '../../parse-timeline';
import { projectIdentityKey } from '../../project-identity';
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
    ...deriveBashCommandSignals(command),
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
  "ssh deploy@app 'sudo tee /etc/app/config.yaml >/dev/null'";

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
    expect(
      rec?.provenance?.observations.find(
        (observation) => observation.value === 'rediscover-new'
      )?.claim
    ).toMatch(/determines aggregate freshness as of 2026-07-03/i);
    expect(validateRecommendationProvenance(rec!)).toEqual([]);
  });

  it('does not bill rediscovery across sessions whose project identity is unresolved', () => {
    const setupBase = Date.parse('2026-07-01T10:00:00.000Z');
    const rediscoveryBase = Date.parse('2026-07-03T10:00:00.000Z');
    const rec = detector.rule(
      input({
        toolData: [
          toolSession('mutation-without-project', [
            bash(durableCommand, at(setupBase, 0), 'unknown-project-mutation'),
          ]),
        ],
        timelines: [
          timeline('unrelated-without-project', rediscoveryBase, [
            redUser(at(rediscoveryBase, 0), 'where is the remote config for this service?'),
            redUser(at(rediscoveryBase, 8), 'which template created the deployed config?'),
          ]),
        ],
        // Deliberately no sessions/tokenData project join for either transcript.
        sessions: [],
        tokenData: [],
      }),
      NOW
    );

    expect(rec?.id).toBe('workflow.value-of-agent-handoff');
    expect(rec?.severity).toBe('info');
    expect(rec?.estTimeReclaimedMin).toBe(15);
    expect(rec?.detail).toMatch(/cold-start pre-signal/i);
    expect(rec?.detail).not.toMatch(/later session\(s\).*re-discovering/i);
    expect(rec?.detail).toMatch(/unresolved project identity/i);
    expect(rec?.detail).not.toContain('unknown-project:');
    expect(rec?.evidence?.join(' ')).not.toMatch(/billed back/i);
    expect(rec?.evidence?.join(' ')).not.toContain('unknown-project:');
    expect(
      rec?.provenance?.observations.find((observation) =>
        observation.claim.includes('project identity was unresolved')
      )
    ).toMatchObject({ value: 'unresolved' });
    expect(rec?.provenance?.observations).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          claim: expect.stringContaining('used project identity "unknown-project:'),
        }),
      ])
    );
  });

  it('falls back to valid token-data identity when session metadata is relative', () => {
    const setupBase = Date.parse('2026-07-01T10:00:00.000Z');
    const rediscoveryBase = Date.parse('2026-07-03T10:00:00.000Z');
    const detectorInput = input({
      toolData: [
        toolSession('setup-relative-project', [
          bash(durableCommand, at(setupBase, 0), 'relative-project-mutation'),
        ]),
      ],
      timelines: [
        timeline('rediscover-relative-project', rediscoveryBase, [
          redUser(at(rediscoveryBase, 0), 'where is the remote config for this service?'),
          redUser(at(rediscoveryBase, 8), 'which template created the deployed config?'),
        ]),
      ],
      sessions: [
        sessionMeta('setup-relative-project', 'repo'),
        sessionMeta('rediscover-relative-project', 'repo'),
      ],
      tokenData: [
        tokenMeta('setup-relative-project'),
        tokenMeta('rediscover-relative-project'),
      ],
    });
    const rec = detector.rule(detectorInput, NOW);

    expect(rec?.severity).toBe('warning');
    expect(rec?.evidence?.join(' ')).toMatch(/billed back/i);
    expect(rec?.estTimeReclaimedMin).toBeGreaterThan(15);
    expect(
      filterRecommendationsByProject(
        [rec!],
        '/repo/app',
        detectorInput.sessions,
        detectorInput.tokenData
      ).map((finding) => finding.id)
    ).toEqual(['workflow.value-of-agent-handoff']);
    expect(
      filterRecommendationsByProject(
        [rec!],
        'repo',
        detectorInput.sessions,
        detectorInput.tokenData
      )
    ).toEqual([]);
  });

  it('fails a cross-source project identity conflict closed', () => {
    const setupBase = Date.parse('2026-07-01T10:00:00.000Z');
    const rediscoveryBase = Date.parse('2026-07-03T10:00:00.000Z');
    const detectorInput = input({
      toolData: [
        toolSession('setup-conflicting-project', [
          bash(durableCommand, at(setupBase, 0), 'conflicting-project-mutation'),
        ]),
      ],
      timelines: [
        timeline('rediscover-conflicting-project', rediscoveryBase, [
          redUser(at(rediscoveryBase, 0), 'where is the remote config for this service?'),
          redUser(at(rediscoveryBase, 8), 'which template created the deployed config?'),
        ]),
      ],
      sessions: [
        sessionMeta('setup-conflicting-project', '/repo/app'),
        sessionMeta('rediscover-conflicting-project', '/repo/app'),
      ],
      tokenData: [
        { ...tokenMeta('setup-conflicting-project'), project: '/repo/other' },
        {
          ...tokenMeta('rediscover-conflicting-project'),
          project: '/repo/other',
        },
      ],
    });
    const rec = detector.rule(detectorInput, NOW);

    expect(rec?.severity).toBe('info');
    expect(rec?.detail).toMatch(/unresolved project identity/i);
    expect(rec?.evidence?.join(' ')).not.toMatch(/billed back/i);
    expect(rec?.estTimeReclaimedMin).toBe(15);
    for (const project of ['/repo/app', '/repo/other']) {
      expect(
        filterRecommendationsByProject(
          [rec!],
          project,
          detectorInput.sessions,
          detectorInput.tokenData
        )
      ).toEqual([]);
    }
  });

  it.each(['repo', './repo', String.raw`\\\server\share\repo`])(
    'keeps equal unresolved project spelling session-local: %s',
    (project) => {
      const setupBase = Date.parse('2026-07-01T10:00:00.000Z');
      expect(projectIdentityKey(project)).toBeNull();
      const recommendations =
        detector.emitAll?.(
          input({
            toolData: [
              toolSession('unresolved-project-writer', [
                bash(durableCommand, at(setupBase, 0)),
                writeRunbook(
                  'docs/runbooks/app-production/README.md',
                  at(setupBase, 2)
                ),
              ]),
              toolSession('unresolved-project-editor', [
                writeRunbook(
                  'docs/runbooks/app-production/README.md',
                  at(setupBase, 3),
                  { marker: false, toolName: 'Edit' }
                ),
              ]),
            ],
            sessions: [
              sessionMeta('unresolved-project-writer', project),
              sessionMeta('unresolved-project-editor', project),
            ],
          }),
          NOW
        ) ?? [];

      expect(recommendations.map((rec) => rec.id)).toEqual([
        'workflow.leave-behind-candidate-verification',
      ]);
      expect(recommendations[0].provenance?.observations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ value: 'unresolved' }),
        ])
      );
      expect(
        recommendations[0].provenance?.observations.some((observation) =>
          observation.claim.includes('same-project grouping')
        )
      ).toBe(false);
    }
  );

  it('keeps same-transcript candidate timing auditable when project identity is unresolved', () => {
    const setupBase = Date.parse('2026-07-01T10:00:00.000Z');
    const rec = detector.rule(
      input({
        toolData: [
          toolSession('candidate-without-project', [
            bash(durableCommand, at(setupBase, 0), 'unknown-project-mutation'),
            {
              ...writeRunbook(
                'docs/runbooks/app-production/README.md',
                at(setupBase, 2)
              ),
              toolUseId: 'unknown-project-candidate',
            },
          ]),
        ],
        sessions: [],
        tokenData: [],
      }),
      NOW
    );

    expect(rec?.id).toBe('workflow.leave-behind-candidate-verification');
    expect(rec?.detail).toMatch(/unresolved project identity/i);
    expect(rec?.detail).not.toMatch(/lacks complete timestamp evidence/i);
    expect(rec?.evidence?.join(' ')).toContain('unknown-project-candidate');
    expect(rec?.provenance?.asOf).toBe('2026-07-01');
    expect(
      rec?.provenance?.observations.find(
        (observation) => observation.value === 'unknown-project-candidate'
      )?.claim
    ).toMatch(/candidate (?:is )?proven after the durable mutation/i);
  });

  it('does not project a tool-only unresolved finding through a colliding short id', () => {
    const setupBase = Date.parse('2026-07-01T10:00:00.000Z');
    const detectorInput = input({
      toolData: [
        toolSession('deadbeef-unresolved', [
          bash(durableCommand, at(setupBase, 0), 'unresolved-mutation'),
        ]),
      ],
      sessions: [sessionMeta('deadbeef-known', '/repo/fallback')],
      tokenData: [],
    });
    const rec = detector.rule(detectorInput, NOW)!;

    expect(rec.detail).toMatch(/unresolved project identity/i);
    expect(rec.evidence?.[0]).toMatch(/^unresolved-project\(/);
    expect(
      filterRecommendationsByProject(
        [rec],
        '/repo/fallback',
        detectorInput.sessions,
        detectorInput.tokenData
      )
    ).toEqual([]);
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

  it('cites the exact event that determines aggregate as-of freshness', () => {
    const rec = detector.rule(
      input({
        toolData: [
          toolSession('older-exact-mutation', [
            bash(
              durableCommand,
              '2026-06-01T10:00:00.000Z',
              'older-exact-mutation'
            ),
          ]),
          toolSession('latest-exact-mutation', [
            bash(
              durableCommand,
              '2026-07-08T10:00:00.000Z',
              'latest-exact-mutation'
            ),
          ]),
        ],
        sessions: [
          sessionMeta('older-exact-mutation'),
          sessionMeta('latest-exact-mutation'),
        ],
      }),
      NOW
    );

    expect(rec?.provenance?.asOf).toBe('2026-07-08');
    expect(
      rec?.provenance?.observations.find(
        (observation) => observation.value === 'latest-exact-mutation'
      )?.claim
    ).toMatch(/determines aggregate freshness.*2026-07-08/i);
  });

  it('does not date a rollup when one relevant durable mutation timestamp is unavailable', () => {
    const knownBase = Date.parse('2026-02-01T10:00:00.000Z');
    const rec = detector.rule(
      input({
        toolData: [
          toolSession('known-stale-mutation', [
            bash(durableCommand, at(knownBase, 0), 'known-mutation'),
          ]),
          toolSession('unknown-time-mutation', [
            bash(durableCommand, 'timestamp-unavailable', 'unknown-mutation'),
          ]),
        ],
        sessions: [
          sessionMeta('known-stale-mutation'),
          sessionMeta('unknown-time-mutation'),
        ],
      }),
      NOW
    );

    expect(rec?.id).toBe('workflow.value-of-agent-handoff');
    expect(rec?.affected).toBe(2);
    expect(rec?.estTimeReclaimedMin).toBe(30);
    expect(rec?.detail).not.toMatch(/^As of /);
    expect(rec?.detail).toMatch(/aggregate freshness cannot be established/i);
    expect(rec?.evidence?.join(' ')).toMatch(
      /unknown-mutation.*timestamp unavailable/i
    );
    expect(rec?.provenance?.asOf).toBeUndefined();
    expect(rec?.provenance?.stale).toBeUndefined();
    expect(rec?.provenance?.observations.some(
      (observation) =>
        observation.value === 'unknown-mutation' &&
        observation.claim.includes('aggregate freshness is not claimed')
    )).toBe(true);
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

  it('does not resurrect an analyzed durable negative from a truncated bulk preview', () => {
    const setupBase = Date.parse('2026-07-01T10:00:00.000Z');
    const command = `kubectl apply -f prod.yaml ${'x'.repeat(220)} || true`;
    const strippedCall: ToolCall = {
      ...bash(command, at(setupBase, 0), 'dead-durable'),
      input: {},
    };

    expect(strippedCall.commandDurableKind).toBeUndefined();
    expect(
      (strippedCall as ToolCall & { commandAnalysisComplete?: true })
        .commandAnalysisComplete
    ).toBe(true);
    expect(
      detector.rule(
        input({
          toolData: [toolSession('setup-analyzed-negative', [strippedCall])],
          sessions: [sessionMeta('setup-analyzed-negative')],
        }),
        NOW
      )
    ).toBeNull();
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
      /1 candidate state association.*Git HEAD is unobserved/i
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

  it.each([
    {
      label: 'a successful rm command',
      call: bash(
        'rm docs/runbooks/app-production/README.md',
        '2026-07-01T10:03:00.000Z',
        'remove-runbook'
      ),
    },
    {
      label: 'a successful forced rm command',
      call: bash(
        'rm -f docs/runbooks/app-production/README.md',
        '2026-07-01T10:03:00.000Z',
        'force-remove-runbook'
      ),
    },
    {
      label: 'a successful recursive forced rm command',
      call: bash(
        'rm -rf docs/runbooks/app-production/README.md',
        '2026-07-01T10:03:00.000Z',
        'recursive-force-remove-runbook'
      ),
    },
    {
      label: 'a wrapped successful mv command that removes the canonical path',
      call: bash(
        'sudo env LC_ALL=C mv docs/runbooks/app-production/README.md /tmp/old-runbook.md',
        '2026-07-01T10:03:00.000Z',
        'move-runbook'
      ),
    },
    {
      label: 'a target-directory mv overwrite of the canonical path',
      call: bash(
        'mv -t docs/runbooks/app-production /tmp/README.md',
        '2026-07-01T10:03:00.000Z',
        'target-directory-overwrite'
      ),
    },
    {
      label: 'a successful git rm command',
      call: bash(
        'git rm docs/runbooks/app-production/README.md',
        '2026-07-01T10:03:00.000Z',
        'git-remove-runbook'
      ),
    },
    {
      label: 'a parser-proven shell overwrite after the bulk command is stripped',
      call: {
        ...bash('', '2026-07-01T10:03:00.000Z', 'overwrite-runbook'),
        input: {},
        commandPreview:
          'printf replacement > docs/runbooks/app-production/README.md',
        leaveBehindMutationPath:
          'docs/runbooks/app-production/README.md',
      },
    },
    {
      label: 'a parser-proven byte-producing append',
      call: bash(
        'printf replacement >> docs/runbooks/app-production/README.md',
        '2026-07-01T10:03:00.000Z',
        'append-runbook'
      ),
    },
    {
      label: 'a parser-proven combined stdout/stderr overwrite',
      call: bash(
        'echo replacement &> docs/runbooks/app-production/README.md',
        '2026-07-01T10:03:00.000Z',
        'combined-overwrite-runbook'
      ),
    },
    {
      label: 'a parser-proven append-mode tee pipeline',
      call: bash(
        'printf replacement | tee -a docs/runbooks/app-production/README.md',
        '2026-07-01T10:03:00.000Z',
        'append-tee-runbook'
      ),
    },
  ])('invalidates candidate evidence after $label', ({ call }) => {
    const setupBase = Date.parse('2026-07-01T10:00:00.000Z');
    const detectorInput = input({
      toolData: [
        toolSession('setup-then-shell-mutation', [
          bash(durableCommand, at(setupBase, 0)),
          writeRunbook(
            'docs/runbooks/app-production/README.md',
            at(setupBase, 2)
          ),
          call,
        ]),
      ],
      sessions: [sessionMeta('setup-then-shell-mutation')],
    });

    const recommendations = detector.emitAll?.(detectorInput, NOW) ?? [];
    expect(recommendations.map((rec) => rec.id)).toEqual([
      'workflow.value-of-agent-handoff',
    ]);
    expect(recommendations[0].evidence?.join(' ')).toMatch(
      /successful Bash.*established the latest observed invalidated state/i
    );
    expect(
      recommendations[0].provenance?.observations.find((observation) =>
        observation.claim.includes('latest observed invalidated state')
      )?.field
    ).toContain('leaveBehindMutationPath');
  });

  it('invalidates every prior candidate touched by one multi-path Bash mutation', () => {
    const setupBase = Date.parse('2026-07-01T10:00:00.000Z');
    const detectorInput = input({
      toolData: [
        toolSession('multi-path-shell-mutation', [
          bash(durableCommand, at(setupBase, 0)),
          writeRunbook('docs/runbooks/scope-a/README.md', at(setupBase, 1)),
          writeRunbook('docs/runbooks/scope-b/README.md', at(setupBase, 2)),
          bash(
            'rm docs/runbooks/scope-a/README.md docs/runbooks/scope-b/README.md',
            at(setupBase, 3),
            'remove-both-runbooks'
          ),
        ]),
      ],
      sessions: [sessionMeta('multi-path-shell-mutation')],
    });

    const recommendations = detector.emitAll?.(detectorInput, NOW) ?? [];
    expect(recommendations.map((rec) => rec.id)).toEqual([
      'workflow.value-of-agent-handoff',
    ]);
    expect(
      recommendations[0].provenance?.observations.some((observation) =>
        observation.field?.includes('leaveBehindMutationPaths')
      )
    ).toBe(true);
  });

  it('treats a truncated multi-path proof as an uncertainty barrier', () => {
    const setupBase = Date.parse('2026-07-01T10:00:00.000Z');
    const candidatePath = 'docs/runbooks/scope-overflow/README.md';
    const earlierPaths = Array.from(
      { length: 128 },
      (_, index) =>
        `docs/runbooks/scope-${String(index).padStart(3, '0')}/README.md`
    );
    const overflowMutation = bash(
      `rm ${[...earlierPaths, candidatePath].join(' ')}`,
      at(setupBase, 3),
      'overflow-runbook-removal'
    );
    expect(overflowMutation.leaveBehindMutationPaths).toHaveLength(128);
    expect(overflowMutation.leaveBehindMutationPaths).not.toContain(candidatePath);
    expect(overflowMutation.leaveBehindMutationPathsTruncated).toBe(true);

    const recommendations =
      detector.emitAll?.(
        input({
          toolData: [
            toolSession('overflow-shell-mutation', [
              bash(durableCommand, at(setupBase, 0)),
              writeRunbook(candidatePath, at(setupBase, 2)),
              overflowMutation,
            ]),
          ],
          sessions: [sessionMeta('overflow-shell-mutation')],
        }),
        NOW
      ) ?? [];

    expect(recommendations.map((rec) => rec.id)).toEqual([
      'workflow.leave-behind-candidate-verification',
    ]);
    expect(recommendations[0].evidence?.join(' ')).not.toMatch(
      /latest observed invalidated state/i
    );
  });

  it('treats bounded command analysis as a same-session uncertainty barrier before and after stripping', () => {
    const setupBase = Date.parse('2026-07-01T10:00:00.000Z');
    const candidatePath = 'docs/runbooks/analysis-bound/README.md';
    const boundedMutation = bash(
      `rm ${candidatePath}; ${'x'.repeat(70 * 1024)}`,
      at(setupBase, 3),
      'bounded-analysis-removal'
    );
    expect(boundedMutation.commandAnalysisTruncated).toBe(true);
    expect(boundedMutation.leaveBehindMutationPathsTruncated).toBeUndefined();

    const session = toolSession('bounded-analysis-session', [
      bash(durableCommand, at(setupBase, 0)),
      {
        ...writeRunbook(candidatePath, at(setupBase, 2)),
        toolUseId: 'candidate-before-analysis-bound',
      },
      boundedMutation,
    ]);
    const rawRecommendations =
      detector.emitAll?.(
        input({
          toolData: [session],
          sessions: [sessionMeta('bounded-analysis-session')],
        }),
        NOW
      ) ?? [];
    const strippedSession = stripToolCommandBodies(session);
    expect(strippedSession.calls.at(-1)?.commandAnalysisTruncated).toBe(true);
    const strippedRecommendations =
      detector.emitAll?.(
        input({
          toolData: [strippedSession],
          sessions: [sessionMeta('bounded-analysis-session')],
        }),
        NOW
      ) ?? [];

    expect(strippedRecommendations).toEqual(rawRecommendations);
    expect(rawRecommendations.map((rec) => rec.id)).toEqual([
      'workflow.leave-behind-candidate-verification',
    ]);
    expect(rawRecommendations[0].detail).toMatch(
      /static command analysis resource bound/i
    );
    expect(rawRecommendations[0].evidence?.join(' ')).not.toMatch(
      /latest observed invalidated state/i
    );
    expect(rawRecommendations[0].evidence?.join(' ')).toContain(
      'tool_use_id candidate-before-analysis-bound'
    );
    expect(rawRecommendations[0].evidence?.join(' ')).toContain(candidatePath);
  });

  it('does not invent a conformant candidate when bounded analysis follows an invalidated path', () => {
    const setupBase = Date.parse('2026-07-01T10:00:00.000Z');
    const path = 'docs/runbooks/invalidated-before-bound/README.md';
    const boundedMutation = bash(
      `rm ${path}; ${'x'.repeat(70 * 1024)}`,
      at(setupBase, 3),
      'bounded-after-invalidation'
    );
    const session = toolSession('invalidated-before-bound', [
      bash(durableCommand, at(setupBase, 0)),
      writeRunbook(path, at(setupBase, 2), {
        marker: false,
        toolName: 'Edit',
      }),
      boundedMutation,
    ]);

    expect(boundedMutation.commandAnalysisTruncated).toBe(true);
    for (const toolSessionData of [session, stripToolCommandBodies(session)]) {
      const recommendations =
        detector.emitAll?.(
          input({
            toolData: [toolSessionData],
            sessions: [sessionMeta('invalidated-before-bound')],
          }),
          NOW
        ) ?? [];

      expect(recommendations).toEqual([]);
    }
  });

  it('clears candidate provenance when invalidation precedes a same-session analysis barrier', () => {
    const setupBase = Date.parse('2026-07-01T10:00:00.000Z');
    const path = 'docs/runbooks/candidate-invalidated-before-bound/README.md';
    const boundedMutation = bash(
      `rm ${path}; ${'x'.repeat(70 * 1024)}`,
      at(setupBase, 4),
      'bounded-after-candidate-invalidation'
    );
    const session = toolSession('candidate-invalidated-before-bound', [
      bash(durableCommand, at(setupBase, 0)),
      writeRunbook(path, at(setupBase, 1)),
      writeRunbook(path, at(setupBase, 2), {
        marker: false,
        toolName: 'Edit',
      }),
      boundedMutation,
    ]);

    for (const toolSessionData of [session, stripToolCommandBodies(session)]) {
      const recommendations =
        detector.emitAll?.(
          input({
            toolData: [toolSessionData],
            sessions: [sessionMeta('candidate-invalidated-before-bound')],
          }),
          NOW
        ) ?? [];

      expect(recommendations).toEqual([]);
    }
  });

  it('does not carry a pre-mutation candidate through a later analysis barrier', () => {
    const setupBase = Date.parse('2026-07-01T10:00:00.000Z');
    const path = 'docs/runbooks/candidate-before-mutation-bound/README.md';
    const boundedMutation = bash(
      `rm ${path}; ${'x'.repeat(70 * 1024)}`,
      at(setupBase, 4),
      'bounded-after-later-mutation'
    );
    const session = toolSession('candidate-before-mutation-bound', [
      writeRunbook(path, at(setupBase, 0)),
      bash(durableCommand, at(setupBase, 1)),
      boundedMutation,
    ]);

    for (const toolSessionData of [session, stripToolCommandBodies(session)]) {
      const recommendations =
        detector.emitAll?.(
          input({
            toolData: [toolSessionData],
            sessions: [sessionMeta('candidate-before-mutation-bound')],
          }),
          NOW
        ) ?? [];

      expect(recommendations).toEqual([]);
    }
  });

  it('applies a bounded command-analysis barrier across sessions in one project', () => {
    const setupBase = Date.parse('2026-07-01T10:00:00.000Z');
    const candidatePath = 'docs/runbooks/cross-session-analysis-bound/README.md';
    const boundedMutation = bash(
      `rm ${candidatePath}; ${'x'.repeat(70 * 1024)}`,
      at(setupBase, 4),
      'cross-session-analysis-bound'
    );
    const cleanupSession = toolSession('bounded-analysis-cleanup', [
      boundedMutation,
    ]);
    const candidateSession = toolSession('bounded-analysis-writer', [
      bash(durableCommand, at(setupBase, 0)),
      {
        ...writeRunbook(candidatePath, at(setupBase, 2)),
        toolUseId: 'cross-candidate-before-analysis-bound',
      },
    ]);

    for (const cleanup of [
      cleanupSession,
      stripToolCommandBodies(cleanupSession),
    ]) {
      const recommendations =
        detector.emitAll?.(
          input({
            toolData: [candidateSession, cleanup],
            sessions: [
              sessionMeta('bounded-analysis-writer'),
              sessionMeta('bounded-analysis-cleanup'),
            ],
          }),
          NOW
        ) ?? [];

      expect(recommendations.map((rec) => rec.id)).toEqual([
        'workflow.leave-behind-candidate-verification',
      ]);
      expect(recommendations[0].detail).toMatch(
        /static command analysis resource bound/i
      );
      expect(recommendations[0].evidence?.join(' ')).not.toMatch(
        /latest observed invalidated state/i
      );
      expect(recommendations[0].evidence?.join(' ')).toContain(
        'tool_use_id cross-candidate-before-analysis-bound'
      );
      expect(recommendations[0].evidence?.join(' ')).toContain(candidatePath);
    }
  });

  it('does not invent a cross-session candidate when bounded analysis follows an invalidated path', () => {
    const setupBase = Date.parse('2026-07-01T10:00:00.000Z');
    const path = 'docs/runbooks/cross-invalidated-before-bound/README.md';
    const boundedMutation = bash(
      `rm ${path}; ${'x'.repeat(70 * 1024)}`,
      at(setupBase, 4),
      'cross-bounded-after-invalidation'
    );
    const invalidatedSession = toolSession('cross-invalidated-origin', [
      bash(durableCommand, at(setupBase, 0)),
      writeRunbook(path, at(setupBase, 2), {
        marker: false,
        toolName: 'Edit',
      }),
    ]);
    const cleanupSession = toolSession('cross-bounded-cleanup', [
      boundedMutation,
    ]);

    expect(boundedMutation.commandAnalysisTruncated).toBe(true);
    for (const cleanup of [
      cleanupSession,
      stripToolCommandBodies(cleanupSession),
    ]) {
      const recommendations =
        detector.emitAll?.(
          input({
            toolData: [invalidatedSession, cleanup],
            sessions: [
              sessionMeta('cross-invalidated-origin'),
              sessionMeta('cross-bounded-cleanup'),
            ],
          }),
          NOW
        ) ?? [];

      expect(recommendations).toEqual([]);
    }
  });

  it('clears cross-session candidate provenance before a later analysis barrier', () => {
    const setupBase = Date.parse('2026-07-01T10:00:00.000Z');
    const path = 'docs/runbooks/cross-candidate-invalidated-bound/README.md';
    const boundedMutation = bash(
      `rm ${path}; ${'x'.repeat(70 * 1024)}`,
      at(setupBase, 4),
      'cross-bounded-after-candidate-invalidation'
    );
    const candidateSession = toolSession('cross-candidate-origin', [
      bash(durableCommand, at(setupBase, 0)),
      writeRunbook(path, at(setupBase, 1)),
    ]);
    const invalidationSession = toolSession('cross-candidate-invalidator', [
      writeRunbook(path, at(setupBase, 2), {
        marker: false,
        toolName: 'Edit',
      }),
    ]);
    const cleanupSession = toolSession('cross-candidate-bounded-cleanup', [
      boundedMutation,
    ]);

    for (const cleanup of [
      cleanupSession,
      stripToolCommandBodies(cleanupSession),
    ]) {
      const recommendations =
        detector.emitAll?.(
          input({
            toolData: [candidateSession, invalidationSession, cleanup],
            sessions: [
              sessionMeta('cross-candidate-origin'),
              sessionMeta('cross-candidate-invalidator'),
              sessionMeta('cross-candidate-bounded-cleanup'),
            ],
          }),
          NOW
        ) ?? [];

      expect(recommendations).toEqual([]);
    }
  });

  it('applies a truncated mutation barrier across sessions in one project', () => {
    const setupBase = Date.parse('2026-07-01T10:00:00.000Z');
    const candidatePath = 'docs/runbooks/cross-session-overflow/README.md';
    const overflowPaths = Array.from(
      { length: 128 },
      (_, index) =>
        `docs/runbooks/other-${String(index).padStart(3, '0')}/README.md`
    );
    const overflowMutation = bash(
      `rm ${[...overflowPaths, candidatePath].join(' ')}`,
      at(setupBase, 4),
      'cross-session-overflow-removal'
    );

    const recommendations =
      detector.emitAll?.(
        input({
          toolData: [
            toolSession('overflow-candidate-writer', [
              bash(durableCommand, at(setupBase, 0)),
              writeRunbook(candidatePath, at(setupBase, 2)),
            ]),
            toolSession('overflow-cleanup', [overflowMutation]),
          ],
          sessions: [
            sessionMeta('overflow-candidate-writer'),
            sessionMeta('overflow-cleanup'),
          ],
        }),
        NOW
      ) ?? [];

    expect(overflowMutation.leaveBehindMutationPathsTruncated).toBe(true);
    expect(recommendations.map((rec) => rec.id)).toEqual([
      'workflow.leave-behind-candidate-verification',
    ]);
    expect(recommendations[0].evidence?.join(' ')).not.toMatch(
      /latest observed invalidated state/i
    );
  });

  it('does not claim an unrelated candidate was in a truncated mutation tail', () => {
    const setupBase = Date.parse('2026-07-01T10:00:00.000Z');
    const candidatePath = 'docs/runbooks/candidate/README.md';
    const unrelatedPaths = Array.from(
      { length: 129 },
      (_, index) =>
        `docs/runbooks/other-${String(index).padStart(3, '0')}/README.md`
    );
    const overflowMutation = bash(
      `rm ${unrelatedPaths.join(' ')}`,
      at(setupBase, 4),
      'unrelated-overflow-removal'
    );

    const recommendations =
      detector.emitAll?.(
        input({
          toolData: [
            toolSession('candidate-writer', [
              bash(durableCommand, at(setupBase, 0)),
              writeRunbook(candidatePath, at(setupBase, 2)),
            ]),
            toolSession('unrelated-cleanup', [overflowMutation]),
          ],
          sessions: [
            sessionMeta('candidate-writer'),
            sessionMeta('unrelated-cleanup'),
          ],
        }),
        NOW
      ) ?? [];

    expect(overflowMutation.leaveBehindMutationPathsTruncated).toBe(true);
    expect(recommendations.map((rec) => rec.id)).toEqual([
      'workflow.leave-behind-candidate-verification',
    ]);
    expect(recommendations[0].detail).toMatch(/persisted path bound/i);
    expect(recommendations[0].detail).not.toMatch(
      /conflicting candidate and invalidation|timestamps are equal/i
    );
    const claims = recommendations[0].provenance?.observations
      .map((observation) => observation.claim)
      .join(' ');
    expect(claims).not.toMatch(/latest observed invalidated state/i);
    expect(claims).not.toMatch(/established.*invalidated state/i);
  });

  it('does not reparse a newline-flattened bulk preview as heredoc execution', () => {
    const setupBase = Date.parse('2026-07-01T10:00:00.000Z');
    const detectorInput = input({
      toolData: [
        toolSession('flattened-heredoc-preview', [
          bash(durableCommand, at(setupBase, 0)),
          writeRunbook(
            'docs/runbooks/app-production/README.md',
            at(setupBase, 2)
          ),
          {
            ...bash('', at(setupBase, 3), 'heredoc-preview'),
            input: {},
            commandPreview:
              "cat <<'EOF' > notes.txt prose; rm docs/runbooks/app-production/README.md EOF",
            leaveBehindMutationPath: undefined,
          },
        ]),
      ],
      sessions: [sessionMeta('flattened-heredoc-preview')],
    });

    expect(detector.emitAll?.(detectorInput, NOW).map((rec) => rec.id)).toEqual([
      'workflow.leave-behind-candidate-verification',
    ]);
  });

  it.each([
    'false && rm docs/runbooks/app-production/README.md || true',
    'if false; then rm docs/runbooks/app-production/README.md; fi',
    'git rm -n docs/runbooks/app-production/README.md',
    'rm --help docs/runbooks/app-production/README.md',
    'exit 0; rm docs/runbooks/app-production/README.md',
    'exec true; rm docs/runbooks/app-production/README.md',
    'command exec true; rm docs/runbooks/app-production/README.md',
    'builtin exec true; rm docs/runbooks/app-production/README.md',
    'set -n; rm docs/runbooks/app-production/README.md',
    'set -o noexec; rm docs/runbooks/app-production/README.md',
    "trap 'exit 0' DEBUG; rm docs/runbooks/app-production/README.md",
    "eval 'exec true'; rm docs/runbooks/app-production/README.md",
    "eval 'exit 0'; rm docs/runbooks/app-production/README.md",
    'source /tmp/exits-zero.sh; rm docs/runbooks/app-production/README.md',
    "alias rm='true'; rm docs/runbooks/app-production/README.md",
    '! rm docs/runbooks/app-production/README.md',
    'rm docs/runbooks/app-production/README.md | cat',
    'rm docs/runbooks/app-production/README.md |& cat',
    'rm docs/runbooks/app-production/README.md &',
    'coproc true > docs/runbooks/app-production/README.md',
    'time ! true > docs/runbooks/app-production/README.md',
    'time coproc true > docs/runbooks/app-production/README.md',
    'true > >(cat > docs/runbooks/app-production/README.md )',
    'echo $(true > docs/runbooks/app-production/README.md )',
    'echo `true > docs/runbooks/app-production/README.md `',
    'rm "$(printf -- --help)" docs/runbooks/app-production/README.md',
    'rm "`printf -- --help`" docs/runbooks/app-production/README.md',
    'rm $MAYBE_OPTION docs/runbooks/app-production/README.md',
    'rm "${opt:=-i}" docs/runbooks/app-production/README.md </dev/null',
    'rm {--help,unused} docs/runbooks/app-production/README.md',
    "rm $'--help' docs/runbooks/app-production/README.md",
    "rm $'\\x2d\\x2dhelp' docs/runbooks/app-production/README.md",
    'rm $"docs/runbooks/app-production/README.md"',
    'LANG=fr_FR.UTF-8 rm $"docs/runbooks/app-production/README.md"',
    'env LANG=fr_FR.UTF-8 rm $"docs/runbooks/app-production/README.md"',
    'rm * docs/runbooks/app-production/README.md',
    'rm ? docs/runbooks/app-production/README.md',
    'rm [a-z] docs/runbooks/app-production/README.md',
    'rm docs/runbooks/app-production/README.md "${ exit 0; }"',
    "rm 'docs\\runbooks\\app-production\\README.md'",
    "true > 'docs\\runbooks\\app-production\\README.md'",
    'true > "docs\\/runbooks/app-production/README.md"',
    'rm docs/runbooks/app-production/README.md; true',
    'git rm docs/runbooks/app-production/README.md; echo $(date)',
    'command -v rm docs/runbooks/app-production/README.md',
    'command -V rm docs/runbooks/app-production/README.md',
    'env --help rm docs/runbooks/app-production/README.md',
    'env -C /tmp rm docs/runbooks/app-production/README.md',
    'env --chdir=/tmp rm docs/runbooks/app-production/README.md',
    'sudo -l rm docs/runbooks/app-production/README.md',
    'sudo -v rm docs/runbooks/app-production/README.md',
    'sudo -D /tmp rm docs/runbooks/app-production/README.md',
    'sudo --chdir=/tmp rm docs/runbooks/app-production/README.md',
    'sudo -R /tmp rm docs/runbooks/app-production/README.md',
    'sudo --chroot=/tmp rm docs/runbooks/app-production/README.md',
    'sudo -h remote rm docs/runbooks/app-production/README.md',
    'sudo --background rm docs/runbooks/app-production/README.md',
    'rm -vi docs/runbooks/app-production/README.md',
    'rm -vI docs/runbooks/app-production/README.md',
    'mv -vn /tmp/source docs/runbooks/app-production/README.md',
    'cp -vn /tmp/source docs/runbooks/app-production/README.md',
    'cp -u /tmp/source docs/runbooks/app-production/README.md',
    'install -C /tmp/source docs/runbooks/app-production/README.md',
    'git rm -qn docs/runbooks/app-production/README.md',
    'git rm -nq docs/runbooks/app-production/README.md',
    'git --exec-path rm docs/runbooks/app-production/README.md',
    'git -C/tmp rm docs/runbooks/app-production/README.md',
    'git --work-tree=/tmp rm docs/runbooks/app-production/README.md',
    'GIT_WORK_TREE=/tmp git rm docs/runbooks/app-production/README.md',
    'true <> docs/runbooks/app-production/README.md',
    'true 3<>docs/runbooks/app-production/README.md',
    'true >> docs/runbooks/app-production/README.md',
    'cp -t /tmp docs/runbooks/app-production/README.md',
    'cp --target-directory=/tmp docs/runbooks/app-production/README.md',
    'install -t /tmp docs/runbooks/app-production/README.md',
    'install --target-directory=/tmp docs/runbooks/app-production/README.md',
    'git checkout -b docs/runbooks/app-production/README.md',
    'git restore --source docs/runbooks/app-production/README.md other-file',
    'git mv -k docs/runbooks/app-production/README.md /tmp/existing',
    './rm docs/runbooks/app-production/README.md',
    '/tmp/rm docs/runbooks/app-production/README.md',
    'sudo ./rm docs/runbooks/app-production/README.md',
    'PATH=/tmp/fake-bin rm docs/runbooks/app-production/README.md',
    'env PATH=/tmp/fake-bin rm docs/runbooks/app-production/README.md',
    'LD_PRELOAD=/tmp/no-unlink.so rm docs/runbooks/app-production/README.md',
    'env LD_PRELOAD=/tmp/no-unlink.so rm docs/runbooks/app-production/README.md',
    'tee -a docs/runbooks/app-production/README.md </dev/null',
    'sudo printf replacement | tee -a docs/runbooks/app-production/README.md',
    "printf 'password\\n' | sudo -S tee -a docs/runbooks/app-production/README.md",
    "printf 'password\\n' | sudo --stdin tee -a docs/runbooks/app-production/README.md",
    'echo replacement 2>& docs/runbooks/app-production/README.md',
    'cleanup () {\nrm docs/runbooks/app-production/README.md\n}',
  ])('does not invalidate candidate evidence for non-proven mutation: %s', (command) => {
    const setupBase = Date.parse('2026-07-01T10:00:00.000Z');
    const detectorInput = input({
      toolData: [
        toolSession('non-proven-shell-mutation', [
          bash(durableCommand, at(setupBase, 0)),
          writeRunbook(
            'docs/runbooks/app-production/README.md',
            at(setupBase, 2)
          ),
          bash(command, at(setupBase, 3), 'non-proven-mutation'),
        ]),
      ],
      sessions: [sessionMeta('non-proven-shell-mutation')],
    });

    expect(detector.emitAll?.(detectorInput, NOW).map((rec) => rec.id)).toEqual([
      'workflow.leave-behind-candidate-verification',
    ]);
  });

  it('does not alias a same-session absolute Bash path outside the project root', () => {
    const setupBase = Date.parse('2026-07-01T10:00:00.000Z');
    const detectorInput = input({
      toolData: [
        toolSession('absolute-path-alias', [
          bash(durableCommand, at(setupBase, 0)),
          writeRunbook(
            'docs/runbooks/app-production/README.md',
            at(setupBase, 2)
          ),
          bash(
            'rm /tmp/docs/runbooks/app-production/README.md',
            at(setupBase, 3),
            'outside-project-remove'
          ),
        ]),
      ],
      sessions: [sessionMeta('absolute-path-alias', '/repo/app')],
    });

    expect(detector.emitAll?.(detectorInput, NOW).map((rec) => rec.id)).toEqual([
      'workflow.leave-behind-candidate-verification',
    ]);
  });

  it('does not treat canonical-path prose inside a quoted heredoc as Bash invalidation', () => {
    const setupBase = Date.parse('2026-07-01T10:00:00.000Z');
    const detectorInput = input({
      toolData: [
        toolSession('heredoc-prose', [
          bash(durableCommand, at(setupBase, 0)),
          writeRunbook(
            'docs/runbooks/app-production/README.md',
            at(setupBase, 2)
          ),
          bash(
            "cat <<'EOF' > notes.txt\nrm docs/runbooks/app-production/README.md\nEOF",
            at(setupBase, 3),
            'write-notes'
          ),
        ]),
      ],
      sessions: [sessionMeta('heredoc-prose')],
    });

    expect(detector.emitAll?.(detectorInput, NOW).map((rec) => rec.id)).toEqual([
      'workflow.leave-behind-candidate-verification',
    ]);
  });

  it('does not infer an earlier mutation from a successful trailing heredoc command', () => {
    const setupBase = Date.parse('2026-07-01T10:00:00.000Z');
    const detectorInput = input({
      toolData: [
        toolSession('mutation-before-heredoc', [
          bash(durableCommand, at(setupBase, 0)),
          writeRunbook(
            'docs/runbooks/app-production/README.md',
            at(setupBase, 2)
          ),
          bash(
            "rm docs/runbooks/app-production/README.md; cat <<'EOF'\nprose\nEOF",
            at(setupBase, 3),
            'remove-then-heredoc'
          ),
        ]),
      ],
      sessions: [sessionMeta('mutation-before-heredoc')],
    });

    expect(detector.emitAll?.(detectorInput, NOW).map((rec) => rec.id)).toEqual([
      'workflow.leave-behind-candidate-verification',
    ]);
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
              '/repo/app/docs/runbooks/app-production/README.md',
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

  it('collapses each transcript by call order before comparing cross-session timestamps', () => {
    const setupBase = Date.parse('2026-07-01T10:00:00.000Z');
    const path = 'docs/runbooks/app-production/README.md';
    const recommendations =
      detector.emitAll?.(
        input({
          toolData: [
            toolSession('setup-with-candidate', [
              bash(durableCommand, at(setupBase, 0)),
              writeRunbook(path, at(setupBase, 2)),
            ]),
            toolSession('reversed-call-timestamps', [
              {
                ...writeRunbook(path, at(setupBase, 4), {
                  marker: false,
                  toolName: 'Edit',
                }),
                toolUseId: 'b-inv',
              },
              {
                ...writeRunbook(path, at(setupBase, 3)),
                toolUseId: 'b-restored',
              },
            ]),
          ],
          sessions: [
            sessionMeta('setup-with-candidate'),
            sessionMeta('reversed-call-timestamps'),
          ],
        }),
        NOW
      ) ?? [];

    expect(recommendations.map((rec) => rec.id)).toEqual([
      'workflow.leave-behind-candidate-verification',
    ]);
    expect(recommendations[0].evidence?.join(' ')).toContain('b-restored');
    expect(recommendations[0].evidence?.join(' ')).not.toContain('b-inv');
  });

  it('retains the monotone timestamp lower bound when a later call invalidates', () => {
    const setupBase = Date.parse('2026-07-01T10:00:00.000Z');
    const path = 'docs/runbooks/app-production/README.md';
    const recommendations =
      detector.emitAll?.(
        input({
          toolData: [
            toolSession('setup-with-candidate', [
              bash(durableCommand, at(setupBase, 0)),
              writeRunbook(path, at(setupBase, 90)),
            ]),
            toolSession('reversed-invalidation-timestamps', [
              {
                ...writeRunbook(path, at(setupBase, 120)),
                toolUseId: 'b-candidate',
              },
              {
                ...writeRunbook(path, at(setupBase, 60), {
                  marker: false,
                  toolName: 'Edit',
                }),
                toolUseId: 'b-inv',
              },
            ]),
          ],
          sessions: [
            sessionMeta('setup-with-candidate'),
            sessionMeta('reversed-invalidation-timestamps'),
          ],
        }),
        NOW
      ) ?? [];

    expect(recommendations.map((rec) => rec.id)).toEqual([
      'workflow.value-of-agent-handoff',
    ]);
    expect(recommendations[0].evidence?.join(' ')).toContain('b-inv');
    expect(recommendations[0].evidence?.join(' ')).not.toContain('b-candidate');
  });

  it('uses a different-path call as the session-wide timestamp lower bound', () => {
    const setupBase = Date.parse('2026-07-01T10:00:00.000Z');
    const path = 'docs/runbooks/app-production/README.md';
    const recommendations =
      detector.emitAll?.(
        input({
          toolData: [
            toolSession('setup-with-candidate', [
              bash(durableCommand, at(setupBase, 0)),
              writeRunbook(path, at(setupBase, 90)),
            ]),
            toolSession('different-key-clock-anchor', [
              {
                ...writeRunbook(
                  'docs/runbooks/other-scope/README.md',
                  at(setupBase, 120)
                ),
                toolUseId: 'other-scope-anchor',
              },
              {
                ...writeRunbook(path, at(setupBase, 60), {
                  marker: false,
                  toolName: 'Edit',
                }),
                toolUseId: 'b-inv',
              },
            ]),
          ],
          sessions: [
            sessionMeta('setup-with-candidate'),
            sessionMeta('different-key-clock-anchor'),
          ],
        }),
        NOW
      ) ?? [];

    expect(recommendations.map((rec) => rec.id)).toEqual([
      'workflow.value-of-agent-handoff',
    ]);
    expect(recommendations[0].evidence?.join(' ')).toContain('b-inv');
  });

  it.each([
    {
      label: 'lower-bounded candidate versus later point invalidation',
      boundedMarker: true,
      pointMarker: false,
    },
    {
      label: 'lower-bounded invalidation versus later point candidate',
      boundedMarker: false,
      pointMarker: true,
    },
  ])('keeps overlapping cross-session time intervals ambiguous: $label', ({
    boundedMarker,
    pointMarker,
  }) => {
    const setupBase = Date.parse('2026-07-01T10:00:00.000Z');
    const path = 'docs/runbooks/app-production/README.md';
    const bounded = writeRunbook(path, at(setupBase, 60), {
      marker: boundedMarker,
      ...(boundedMarker ? {} : { toolName: 'Edit' as const }),
    });
    const point = writeRunbook(path, at(setupBase, 150), {
      marker: pointMarker,
      ...(pointMarker ? {} : { toolName: 'Edit' as const }),
    });
    const recommendations =
      detector.emitAll?.(
        input({
          toolData: [
            toolSession('setup-with-candidate', [
              bash(durableCommand, at(setupBase, 0)),
              writeRunbook(path, at(setupBase, 90)),
            ]),
            toolSession('lower-bounded-final', [
              writeRunbook(
                'docs/runbooks/other-scope/README.md',
                at(setupBase, 120)
              ),
              { ...bounded, toolUseId: 'bounded-final' },
            ]),
            toolSession('later-point-final', [
              { ...point, toolUseId: 'point-final' },
            ]),
          ],
          sessions: [
            sessionMeta('setup-with-candidate'),
            sessionMeta('lower-bounded-final'),
            sessionMeta('later-point-final'),
          ],
        }),
        NOW
      ) ?? [];

    expect(recommendations.map((rec) => rec.id)).toEqual([
      'workflow.leave-behind-candidate-verification',
    ]);
    expect(recommendations[0].detail).toMatch(/clocks that move backwards/i);
    const claims = recommendations[0].provenance?.observations
      .map((observation) => observation.claim)
      .join(' ');
    expect(claims).not.toMatch(/latest observed invalidated state/i);
  });

  it.each([
    'docs//runbooks/app-production/README.md',
    './docs/runbooks/app-production/README.md',
    'docs/./runbooks/app-production/README.md',
    '/repo/app/./docs/runbooks/app-production/README.md',
  ])(
    'invalidates a canonical candidate through a redundant path spelling: %s',
    (invalidationPath) => {
      const setupBase = Date.parse('2026-07-01T10:00:00.000Z');
      const recommendations =
        detector.emitAll?.(
          input({
            toolData: [
              toolSession('redundant-path-alias', [
                bash(durableCommand, at(setupBase, 0)),
                writeRunbook(
                  'docs/runbooks/app-production/README.md',
                  at(setupBase, 2)
                ),
                writeRunbook(invalidationPath, at(setupBase, 3), {
                  marker: false,
                  toolName: 'Edit',
                }),
              ]),
            ],
            sessions: [sessionMeta('redundant-path-alias', '/repo/app')],
          }),
          NOW
        ) ?? [];

      expect(recommendations.map((rec) => rec.id)).toEqual([
        'workflow.value-of-agent-handoff',
      ]);
    }
  );

  it('invalidates redundant relative aliases across sessions in one project', () => {
    const setupBase = Date.parse('2026-07-01T10:00:00.000Z');
    const recommendations =
      detector.emitAll?.(
        input({
          toolData: [
            toolSession('redundant-path-writer', [
              bash(durableCommand, at(setupBase, 0)),
              writeRunbook(
                'docs/runbooks/app-production/README.md',
                at(setupBase, 2)
              ),
            ]),
            toolSession('redundant-path-editor', [
              writeRunbook(
                './docs//runbooks/app-production/README.md',
                at(setupBase, 3),
                { marker: false, toolName: 'Edit' }
              ),
            ]),
          ],
          sessions: [
            sessionMeta('redundant-path-writer', '/repo/./app'),
            sessionMeta('redundant-path-editor', '/repo/app'),
          ],
        }),
        NOW
      ) ?? [];

    expect(recommendations.map((rec) => rec.id)).toEqual([
      'workflow.value-of-agent-handoff',
    ]);
  });

  it('does not collapse traversal segments into a canonical transition path', () => {
    const setupBase = Date.parse('2026-07-01T10:00:00.000Z');
    const recommendations =
      detector.emitAll?.(
        input({
          toolData: [
            toolSession('traversal-path-distinct', [
              bash(durableCommand, at(setupBase, 0)),
              writeRunbook(
                'docs/runbooks/app-production/README.md',
                at(setupBase, 2)
              ),
              writeRunbook(
                'docs/other/../runbooks/app-production/README.md',
                at(setupBase, 3),
                { marker: false, toolName: 'Edit' }
              ),
            ]),
          ],
          sessions: [sessionMeta('traversal-path-distinct', '/repo/app')],
        }),
        NOW
      ) ?? [];

    expect(recommendations.map((rec) => rec.id)).toEqual([
      'workflow.leave-behind-candidate-verification',
    ]);
  });

  it('does not cross-alias an absolute transition outside the shared project root', () => {
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
        toolSession('outside-project-editor', [
          writeRunbook(
            '/tmp/docs/runbooks/app-production/README.md',
            at(setupBase, 3),
            { marker: false, toolName: 'Edit' }
          ),
        ]),
      ],
      sessions: [
        sessionMeta('setup-with-candidate', '/repo/app'),
        sessionMeta('outside-project-editor', '/repo/app'),
      ],
    });

    expect(detector.emitAll?.(detectorInput, NOW).map((rec) => rec.id)).toEqual([
      'workflow.leave-behind-candidate-verification',
    ]);
  });

  it('tracks an exact absolute candidate when project identity is unavailable', () => {
    const setupBase = Date.parse('2026-07-01T10:00:00.000Z');
    const recommendations =
      detector.emitAll?.(
        input({
          toolData: [
            toolSession('absolute-unresolved-project', [
              bash(durableCommand, at(setupBase, 0)),
              writeRunbook(
                '/repo/app/docs/runbooks/app-production/README.md',
                at(setupBase, 2)
              ),
              writeRunbook(
                '/repo/app/docs/runbooks/app-production/README.md',
                at(setupBase, 3)
              ),
            ]),
          ],
          sessions: [],
        }),
        NOW
      ) ?? [];

    expect(recommendations.map((rec) => rec.id)).toEqual([
      'workflow.leave-behind-candidate-verification',
    ]);
  });

  it('keeps exact absolute invalidation ordering session-local without a project', () => {
    const setupBase = Date.parse('2026-07-01T10:00:00.000Z');
    const recommendations =
      detector.emitAll?.(
        input({
          toolData: [
            toolSession('absolute-unresolved-edit', [
              bash(durableCommand, at(setupBase, 0)),
              writeRunbook(
                '/repo/app/docs/runbooks/app-production/README.md',
                at(setupBase, 2)
              ),
              writeRunbook(
                '/repo/app/docs/runbooks/app-production/README.md',
                at(setupBase, 3),
                { marker: false, toolName: 'Edit' }
              ),
            ]),
          ],
          sessions: [],
        }),
        NOW
      ) ?? [];

    expect(recommendations.map((rec) => rec.id)).toEqual([
      'workflow.value-of-agent-handoff',
    ]);
  });

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
      (observation) => /candidate (?:is )?proven after the durable mutation/i.test(observation.claim)
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

  it('labels candidate/session-state associations without counting them as Write observations', () => {
    const firstBase = Date.parse('2026-07-01T10:00:00.000Z');
    const secondBase = Date.parse('2026-07-02T10:00:00.000Z');
    const restorationBase = Date.parse('2026-07-03T10:00:00.000Z');
    const rec = detector.rule(
      input({
        toolData: [
          toolSession('first-durable', [
            bash(durableCommand, at(firstBase, 0), 'first-mutation'),
            writeRunbook(
              'docs/runbooks/app-production/README.md',
              at(firstBase, 2)
            ),
          ]),
          toolSession('second-durable', [
            bash(durableCommand, at(secondBase, 0), 'second-mutation'),
            writeRunbook(
              'docs/runbooks/app-production/README.md',
              at(secondBase, 2)
            ),
          ]),
          toolSession('shared-restorer', [
            writeRunbook(
              'docs/runbooks/app-production/README.md',
              at(restorationBase, 0)
            ),
          ]),
        ],
        sessions: [
          sessionMeta('first-durable'),
          sessionMeta('second-durable'),
          sessionMeta('shared-restorer'),
        ],
      }),
      NOW
    );

    expect(rec?.id).toBe('workflow.leave-behind-candidate-verification');
    expect(rec?.detail).toMatch(
      /2 structurally conformant leave-behind candidate state association\(s\).*1 unique path/i
    );
    expect(rec?.evidence?.[0]).toMatch(
      /2 candidate state association\(s\).*1 unique path/i
    );
    expect(rec?.provenance?.observations[0].claim).toMatch(
      /2 durable-session\/state-scope candidate association\(s\).*1 unique path/i
    );
    expect(rec?.provenance?.observations[0].claim).not.toMatch(
      /full-file Write candidate observation/i
    );
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

  it('keeps cited candidate evidence inside the proven project root', () => {
    const setupBase = Date.parse('2026-07-01T10:00:00.000Z');
    const sameTimestamp = at(setupBase, 2);
    const relativeCandidate = {
      ...writeRunbook(
        'docs/runbooks/app-production/README.md',
        sameTimestamp
      ),
      toolUseId: 'candidate-relative',
    };
    const absoluteCandidate = {
      ...writeRunbook(
        '/other/repo/docs/runbooks/app-production/README.md',
        sameTimestamp
      ),
      toolUseId: 'candidate-absolute',
    };
    const detectorInput = input({
      toolData: [
        toolSession('mutation-session', [
          bash(durableCommand, at(setupBase, 0)),
          relativeCandidate,
        ]),
        // This absolute path has the same canonical suffix but is outside the
        // shared project root, so it cannot alias the relative candidate.
        toolSession('other-writer', [
          writeRunbook('docs/runbooks/unrelated/README.md', sameTimestamp),
          writeRunbook('docs/runbooks/also-unrelated/README.md', sameTimestamp),
          absoluteCandidate,
        ]),
      ],
      sessions: [
        sessionMeta('mutation-session'),
        sessionMeta('other-writer'),
      ],
    });

    const rec = detector
      .emitAll?.(detectorInput, NOW)
      .find((item) => item.id === 'workflow.leave-behind-candidate-verification');
    expect(rec?.evidence?.[1]).toContain('mutation');
    expect(rec?.evidence?.[1]).toContain(
      'docs/runbooks/app-production/README.md'
    );
    expect(rec?.evidence?.[1]).toContain('tool_use_id candidate-relative');
    expect(rec?.evidence?.[1]).not.toContain('/other/repo');
    expect(rec?.action).toContain(
      'docs/runbooks/app-production/README.md'
    );
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
    const setupBase = Date.parse('2026-02-01T10:00:00.000Z');
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
    expect(recommendations[0].detail).not.toMatch(/^As of /);
    expect(recommendations[0].estTimeReclaimedMin).toBeUndefined();
    expect(recommendations[0].provenance?.asOf).toBeUndefined();
    expect(recommendations[0].provenance?.stale).toBeUndefined();
    expect(
      recommendations[0].provenance?.observations
        .map((observation) => observation.claim)
        .join(' ')
    ).toMatch(/unresolved cross-session state conflict/i);
    expect(
      recommendations[0].provenance?.observations
        .map((observation) => observation.claim)
        .join(' ')
    ).not.toMatch(/equal-time unresolved state conflict/i);
    expect(recommendations[0].provenance?.inference).toMatch(
      /timestamps tie or are unavailable/i
    );
  });

  it('uses a dated example without claiming latest when a candidate timestamp is unavailable', () => {
    const setupBase = Date.parse('2026-02-01T10:00:00.000Z');
    const detectorInput = input({
      toolData: [
        toolSession('known-candidate', [
          bash(durableCommand, at(setupBase, 0)),
          writeRunbook(
            'docs/runbooks/app-production/README.md',
            at(setupBase, 2)
          ),
        ]),
        toolSession('unknown-time-candidate', [
          writeRunbook(
            'docs/runbooks/app-production/README.md',
            'timestamp-unavailable'
          ),
        ]),
      ],
      sessions: [
        sessionMeta('known-candidate'),
        sessionMeta('unknown-time-candidate'),
      ],
    });

    const rec = detector.rule(detectorInput, NOW);
    const claims = rec?.provenance?.observations
      .map((observation) => observation.claim)
      .join(' ');

    expect(rec?.id).toBe('workflow.leave-behind-candidate-verification');
    expect(rec?.detail).not.toMatch(/^As of /);
    expect(rec?.detail).toMatch(/candidate freshness cannot be established/i);
    expect(rec?.provenance?.asOf).toBeUndefined();
    expect(rec?.provenance?.stale).toBeUndefined();
    expect(claims).toMatch(/candidate (?:is )?proven after the durable mutation/i);
    expect(claims).toMatch(/unknown-time-candidate.*missing or unparseable timestamp/i);
    expect(claims).not.toMatch(/latest observed conformant Write candidate/i);
  });

  it('does not date or call a known invalidation latest when another invalidation timestamp is unavailable', () => {
    const setupBase = Date.parse('2026-02-01T10:00:00.000Z');
    const rec = detector.rule(
      input({
        toolData: [
          toolSession('known-invalidation', [
            bash(durableCommand, at(setupBase, 0)),
            {
              ...writeRunbook(
                'docs/runbooks/app-production/README.md',
                at(setupBase, 2),
                { marker: false }
              ),
              toolUseId: 'dated-invalidation',
            },
          ]),
          toolSession('unknown-time-invalidation', [
            {
              ...writeRunbook(
                'docs/runbooks/app-production/README.md',
                'timestamp-unavailable',
                { marker: false, toolName: 'Edit' }
              ),
              toolUseId: 'freshness-limiting-invalidation',
            },
          ]),
        ],
        sessions: [
          sessionMeta('known-invalidation'),
          sessionMeta('unknown-time-invalidation'),
        ],
      }),
      NOW
    );
    const evidence = rec?.evidence?.join(' ');
    const claims = rec?.provenance?.observations
      .map((observation) => observation.claim)
      .join(' ');

    expect(rec?.id).toBe('workflow.value-of-agent-handoff');
    expect(rec?.detail).not.toMatch(/^As of /);
    expect(rec?.provenance?.asOf).toBeUndefined();
    expect(rec?.provenance?.stale).toBeUndefined();
    expect(evidence).toMatch(/dated invalidation example/i);
    expect(evidence).toMatch(/timestamp unavailable/i);
    expect(evidence).toMatch(/freshness-limiting-invalidation/i);
    expect(evidence).not.toMatch(/latest observed invalidated state/i);
    expect(claims).toMatch(/dated invalidation example/i);
    expect(claims).toMatch(/freshness-limiting-invalidation/i);
    expect(claims).not.toMatch(/latest observed invalidated state/i);
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
      invalidationPath: '/repo/app/docs/runbooks/app-production/README.md',
    },
    {
      candidatePath: '/repo/app/docs/runbooks/app-production/README.md',
      invalidationPath: 'docs/runbooks/app-production/README.md',
    },
  ])(
    'invalidates a candidate across project-root relative/absolute aliases ($candidatePath)',
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

  it.each([
    {
      project: '/',
      absolutePath: '/docs/runbooks/app-production/README.md',
    },
    {
      project: 'C:/',
      absolutePath: 'C:/docs/runbooks/app-production/README.md',
    },
  ])(
    'preserves filesystem-root project identity for $project',
    ({ project, absolutePath }) => {
      const setupBase = Date.parse('2026-07-01T10:00:00.000Z');
      const rec = detector.rule(
        input({
          toolData: [
            toolSession('root-project-alias', [
              bash(durableCommand, at(setupBase, 0)),
              writeRunbook(
                'docs/runbooks/app-production/README.md',
                at(setupBase, 2)
              ),
              writeRunbook(absolutePath, at(setupBase, 3), {
                marker: false,
                toolName: 'Edit',
              }),
            ]),
          ],
          sessions: [sessionMeta('root-project-alias', project)],
        }),
        NOW
      );

      expect(rec?.title).toBe(
        'Leave a handoff when agents establish durable state'
      );
    }
  );

  it.each([
    '\\\\server\\share\\repo\\docs\\runbooks\\app-production\\README.md',
    '//server/share/repo/docs/runbooks/app-production/README.md',
  ])('aliases UNC project paths case-insensitively: %s', (absolutePath) => {
    const setupBase = Date.parse('2026-07-01T10:00:00.000Z');
    const recommendations =
      detector.emitAll?.(
        input({
          toolData: [
            toolSession('unc-project-alias', [
              bash(durableCommand, at(setupBase, 0)),
              writeRunbook(
                'docs/runbooks/app-production/README.md',
                at(setupBase, 2)
              ),
              writeRunbook(absolutePath, at(setupBase, 3), {
                marker: false,
                toolName: 'Edit',
              }),
            ]),
          ],
          sessions: [
            sessionMeta('unc-project-alias', '\\\\SERVER\\Share\\Repo'),
          ],
        }),
        NOW
      ) ?? [];

    expect(recommendations.map((rec) => rec.id)).toEqual([
      'workflow.value-of-agent-handoff',
    ]);
  });

  it('groups cross-session UNC project identities case-insensitively', () => {
    const setupBase = Date.parse('2026-07-01T10:00:00.000Z');
    const recommendations =
      detector.emitAll?.(
        input({
          toolData: [
            toolSession('unc-writer', [
              bash(durableCommand, at(setupBase, 0)),
              writeRunbook(
                'docs/runbooks/app-production/README.md',
                at(setupBase, 2)
              ),
            ]),
            toolSession('unc-editor', [
              writeRunbook(
                '\\\\server\\share\\repo\\docs\\runbooks\\app-production\\README.md',
                at(setupBase, 3),
                { marker: false, toolName: 'Edit' }
              ),
            ]),
          ],
          sessions: [
            sessionMeta('unc-writer', '\\\\SERVER\\Share\\Repo'),
            sessionMeta('unc-editor', '\\\\server\\share\\repo'),
          ],
        }),
        NOW
      ) ?? [];

    expect(recommendations.map((rec) => rec.id)).toEqual([
      'workflow.value-of-agent-handoff',
    ]);
  });

  it('does not alias an extra-leading-root spelling to a normal UNC project', () => {
    const setupBase = Date.parse('2026-07-01T10:00:00.000Z');
    const project = String.raw`\\\SERVER\Share\Repo`;
    const editedPath = String.raw`\\server\share\repo\docs\runbooks\app-production\README.md`;
    expect(project.match(/^\\+/)?.[0]).toHaveLength(3);
    expect(editedPath.match(/^\\+/)?.[0]).toHaveLength(2);
    expect(projectIdentityKey(project)).toBeNull();
    expect(projectIdentityKey(project)).not.toBe(
      projectIdentityKey(String.raw`\\server\share\repo`)
    );

    const recommendations =
      detector.emitAll?.(
        input({
          toolData: [
            toolSession('unc-extra-root-writer', [
              bash(durableCommand, at(setupBase, 0)),
              writeRunbook(
                'docs/runbooks/app-production/README.md',
                at(setupBase, 2)
              ),
            ]),
            toolSession('unc-normal-root-editor', [
              writeRunbook(editedPath, at(setupBase, 3), {
                marker: false,
                toolName: 'Edit',
              }),
            ]),
          ],
          sessions: [
            sessionMeta('unc-extra-root-writer', project),
            sessionMeta('unc-normal-root-editor', String.raw`\\server\share\repo`),
          ],
        }),
        NOW
      ) ?? [];

    expect(recommendations.map((rec) => rec.id)).toEqual([
      'workflow.leave-behind-candidate-verification',
    ]);
  });

  it.each([
    String.raw`\\\server\share\repo\docs\runbooks\app-production\README.md`,
    '///server/share/repo/docs/runbooks/app-production/README.md',
  ])('does not let a 3-separator path invalidate a UNC candidate: %s', (editedPath) => {
    const setupBase = Date.parse('2026-07-01T10:00:00.000Z');
    const recommendations =
      detector.emitAll?.(
        input({
          toolData: [
            toolSession('unc-three-root-path', [
              bash(durableCommand, at(setupBase, 0)),
              writeRunbook(
                'docs/runbooks/app-production/README.md',
                at(setupBase, 2)
              ),
              writeRunbook(editedPath, at(setupBase, 3), {
                marker: false,
                toolName: 'Edit',
              }),
            ]),
          ],
          sessions: [
            sessionMeta('unc-three-root-path', String.raw`\\server\share\repo`),
          ],
        }),
        NOW
      ) ?? [];

    expect(recommendations.map((rec) => rec.id)).toEqual([
      'workflow.leave-behind-candidate-verification',
    ]);
  });

  it('groups POSIX project slash aliases across sessions and project filters', () => {
    const setupBase = Date.parse('2026-07-01T10:00:00.000Z');
    const detectorInput = input({
      toolData: [
        toolSession('posix-slash-writer', [
          bash(durableCommand, at(setupBase, 0)),
          writeRunbook(
            'docs/runbooks/app-production/README.md',
            at(setupBase, 2)
          ),
        ]),
        toolSession('posix-slash-editor', [
          writeRunbook(
            '/repo/foo/docs/runbooks/app-production/README.md',
            at(setupBase, 3),
            { marker: false, toolName: 'Edit' }
          ),
        ]),
      ],
      sessions: [
        sessionMeta('posix-slash-writer', '/repo//foo/'),
        sessionMeta('posix-slash-editor', '/repo/foo'),
      ],
    });
    const recommendations = detector.emitAll?.(detectorInput, NOW) ?? [];

    expect(recommendations.map((rec) => rec.id)).toEqual([
      'workflow.value-of-agent-handoff',
    ]);
    expect(
      filterRecommendationsByProject(
        recommendations,
        '/repo//foo/',
        detectorInput.sessions
      ).map((rec) => rec.id)
    ).toEqual(['workflow.value-of-agent-handoff']);
    expect(
      filterRecommendationsByProject(
        recommendations,
        '/repo/foo',
        detectorInput.sessions
      ).map((rec) => rec.id)
    ).toEqual(['workflow.value-of-agent-handoff']);
  });

  it.each([
    { project: '/repo', absolutePath: '///repo/docs/runbooks/app-production/README.md' },
    { project: '///repo', absolutePath: '/repo/docs/runbooks/app-production/README.md' },
  ])(
    'collapses three-or-more leading POSIX slashes for $project',
    ({ project, absolutePath }) => {
      const setupBase = Date.parse('2026-07-01T10:00:00.000Z');
      const recommendations =
        detector.emitAll?.(
          input({
            toolData: [
              toolSession('posix-leading-slashes', [
                bash(durableCommand, at(setupBase, 0)),
                writeRunbook(absolutePath, at(setupBase, 2)),
              ]),
            ],
            sessions: [sessionMeta('posix-leading-slashes', project)],
          }),
          NOW
        ) ?? [];

      expect(recommendations.map((rec) => rec.id)).toEqual([
        'workflow.leave-behind-candidate-verification',
      ]);
    }
  );

  it('keeps forward-slash POSIX double-root paths case-sensitive', () => {
    const setupBase = Date.parse('2026-07-01T10:00:00.000Z');
    const recommendations =
      detector.emitAll?.(
        input({
          toolData: [
            toolSession('posix-double-root', [
              bash(durableCommand, at(setupBase, 0)),
              writeRunbook(
                'docs/runbooks/app-production/README.md',
                at(setupBase, 2)
              ),
              writeRunbook(
                '//tmp/repo/docs/runbooks/app-production/README.md',
                at(setupBase, 3),
                { marker: false, toolName: 'Edit' }
              ),
            ]),
          ],
          sessions: [sessionMeta('posix-double-root', '//tmp/Repo')],
        }),
        NOW
      ) ?? [];

    expect(recommendations.map((rec) => rec.id)).toEqual([
      'workflow.leave-behind-candidate-verification',
    ]);
  });

  it('does not treat backslashes as separators in a proven POSIX project', () => {
    const setupBase = Date.parse('2026-07-01T10:00:00.000Z');
    const candidateThenLiteralEdit =
      detector.emitAll?.(
        input({
          toolData: [
            toolSession('posix-backslash-edit', [
              bash(durableCommand, at(setupBase, 0)),
              writeRunbook(
                'docs/runbooks/app-production/README.md',
                at(setupBase, 2)
              ),
              writeRunbook(
                'docs\\runbooks\\app-production\\README.md',
                at(setupBase, 3),
                { marker: false, toolName: 'Edit' }
              ),
            ]),
          ],
          sessions: [sessionMeta('posix-backslash-edit', '/repo/app')],
        }),
        NOW
      ) ?? [];
    const literalWriteOnly =
      detector.emitAll?.(
        input({
          toolData: [
            toolSession('posix-backslash-write', [
              bash(durableCommand, at(setupBase, 0)),
              writeRunbook(
                'docs\\runbooks\\app-production\\README.md',
                at(setupBase, 2)
              ),
            ]),
          ],
          sessions: [sessionMeta('posix-backslash-write', '/repo/app')],
        }),
        NOW
      ) ?? [];

    expect(candidateThenLiteralEdit.map((rec) => rec.id)).toEqual([
      'workflow.leave-behind-candidate-verification',
    ]);
    expect(literalWriteOnly.map((rec) => rec.id)).toEqual([
      'workflow.value-of-agent-handoff',
    ]);
  });

  it('accepts an absolute handoff beneath a POSIX project with a literal backslash', () => {
    const setupBase = Date.parse('2026-07-01T10:00:00.000Z');
    const recommendations =
      detector.emitAll?.(
        input({
          toolData: [
            toolSession('posix-literal-project', [
              bash(durableCommand, at(setupBase, 0)),
              writeRunbook(
                '/repo/foo\\bar/docs/runbooks/app-production/README.md',
                at(setupBase, 2)
              ),
            ]),
          ],
          sessions: [
            sessionMeta('posix-literal-project', '/repo//foo\\bar/'),
          ],
        }),
        NOW
      ) ?? [];

    expect(recommendations.map((rec) => rec.id)).toEqual([
      'workflow.leave-behind-candidate-verification',
    ]);
  });

  it('does not alias a POSIX literal backslash with a slash', () => {
    const setupBase = Date.parse('2026-07-01T10:00:00.000Z');
    const recommendations =
      detector.emitAll?.(
        input({
          toolData: [
            toolSession('posix-literal-distinct', [
              bash(durableCommand, at(setupBase, 0)),
              writeRunbook(
                '/repo/foo/bar/docs/runbooks/app-production/README.md',
                at(setupBase, 2)
              ),
            ]),
          ],
          sessions: [
            sessionMeta('posix-literal-distinct', '/repo/foo\\bar'),
          ],
        }),
        NOW
      ) ?? [];

    expect(recommendations.map((rec) => rec.id)).toEqual([
      'workflow.value-of-agent-handoff',
    ]);
  });

  it('aliases relative and absolute handoffs under a POSIX literal-backslash project', () => {
    const setupBase = Date.parse('2026-07-01T10:00:00.000Z');
    const recommendations =
      detector.emitAll?.(
        input({
          toolData: [
            toolSession('posix-literal-alias', [
              bash(durableCommand, at(setupBase, 0)),
              writeRunbook(
                'docs/runbooks/app-production/README.md',
                at(setupBase, 2)
              ),
              writeRunbook(
                '/repo/foo\\bar/docs/runbooks/app-production/README.md',
                at(setupBase, 3),
                { marker: false, toolName: 'Edit' }
              ),
            ]),
          ],
          sessions: [sessionMeta('posix-literal-alias', '/repo/foo\\bar')],
        }),
        NOW
      ) ?? [];

    expect(recommendations.map((rec) => rec.id)).toEqual([
      'workflow.value-of-agent-handoff',
    ]);
  });

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

  it('keeps a grouped Windows finding visible under either project spelling', () => {
    const setupBase = Date.parse('2026-07-01T10:00:00.000Z');
    const detectorInput = input({
      toolData: [
        toolSession('aaaaaaaa-windows-one', [
          bash(durableCommand, at(setupBase, 0), 'windows-one'),
        ]),
        toolSession('bbbbbbbb-windows-two', [
          bash(durableCommand, at(setupBase, 1), 'windows-two'),
        ]),
      ],
      sessions: [
        sessionMeta('aaaaaaaa-windows-one', 'C:\\Repo'),
        sessionMeta('bbbbbbbb-windows-two', 'c:/repo'),
      ],
    });
    const rec = detector.rule(detectorInput, NOW);

    expect(rec?.affected).toBe(2);
    expect(
      filterRecommendationsByProject(
        [rec!],
        'C:\\Repo',
        detectorInput.sessions
      ).map((item) => item.id)
    ).toEqual(['workflow.value-of-agent-handoff']);
    expect(
      filterRecommendationsByProject(
        [rec!],
        'c:/repo',
        detectorInput.sessions
      ).map((item) => item.id)
    ).toEqual(['workflow.value-of-agent-handoff']);
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

  it('does not bill rediscovery before a backward-clock durable mutation lower bound', () => {
    const rediscoveryBase = Date.parse('2026-06-01T10:00:00.000Z');
    const rec = detector.rule(
      input({
        toolData: [
          toolSession('clock-regressed-mutation', [
            bash('npm test', '2026-07-01T10:00:00.000Z', 'later-anchor'),
            bash(durableCommand, '2026-04-01T10:00:00.000Z', 'backward-durable'),
          ]),
        ],
        timelines: [
          timeline('june-rediscovery', rediscoveryBase, [
            redUser(at(rediscoveryBase, 0), 'where is the remote config?'),
            redUser(at(rediscoveryBase, 8), 'which template created the setup?'),
          ]),
        ],
        sessions: [
          sessionMeta('clock-regressed-mutation'),
          sessionMeta('june-rediscovery'),
        ],
      }),
      NOW
    );

    expect(rec?.id).toBe('workflow.value-of-agent-handoff');
    expect(rec?.severity).toBe('info');
    expect(rec?.estTimeReclaimedMin).toBe(15);
    expect(rec?.detail).toMatch(/cold-start pre-signal/i);
    expect(rec?.detail).toMatch(/aggregate freshness cannot be established/i);
    expect(rec?.evidence?.join(' ')).not.toMatch(/billed back/i);
    expect(rec?.evidence?.join(' ')).toMatch(/ordering lower bound.*clock moves backwards/i);
    expect(rec?.provenance?.asOf).toBeUndefined();
    expect(rec?.provenance?.stale).toBeUndefined();
  });

  it('does not bill when the final durable mutation has no exact timestamp', () => {
    const rediscoveryBase = Date.parse('2026-06-01T10:00:00.000Z');
    const rec = detector.rule(
      input({
        toolData: [
          toolSession('unknown-final-mutation', [
            bash(durableCommand, '2026-04-01T10:00:00.000Z', 'dated-durable'),
            bash(
              'kubectl apply -f later.yaml',
              'timestamp-unavailable',
              'undated-durable'
            ),
          ]),
        ],
        timelines: [
          timeline('june-rediscovery-unknown', rediscoveryBase, [
            redUser(at(rediscoveryBase, 0), 'where is the deployed config?'),
            redUser(at(rediscoveryBase, 8), 'find how this setup works'),
          ]),
        ],
        sessions: [
          sessionMeta('unknown-final-mutation'),
          sessionMeta('june-rediscovery-unknown'),
        ],
      }),
      NOW
    );

    expect(rec?.severity).toBe('info');
    expect(rec?.estTimeReclaimedMin).toBe(15);
    expect(rec?.evidence?.join(' ')).not.toMatch(/billed back/i);
    expect(rec?.provenance?.asOf).toBeUndefined();
  });

  it.each([
    ['an impossible calendar day', '2026-02-30T10:00:00.000Z'],
    ['a timestamp without an RFC3339 offset', '2026-07-01 10:00:00'],
  ])('treats %s as unavailable timing evidence', (_label, timestamp) => {
    const rec = detector.rule(
      input({
        toolData: [
          toolSession('invalid-timestamp-mutation', [
            bash(durableCommand, timestamp, 'invalid-timestamp'),
          ]),
        ],
        sessions: [sessionMeta('invalid-timestamp-mutation')],
      }),
      NOW
    );

    expect(rec?.id).toBe('workflow.value-of-agent-handoff');
    expect(rec?.provenance?.asOf).toBeUndefined();
    expect(rec?.provenance?.stale).toBeUndefined();
    expect(rec?.evidence?.join(' ')).toMatch(
      /invalid-timestamp.*timestamp unavailable/i
    );
    expect(
      rec?.provenance?.observations.map((observation) => observation.claim).join(' ')
    ).toMatch(
      /invalid-timestamp.*missing or unparseable timestamp/i
    );
  });

  it('uses deciding transition lower bounds and exactness for rediscovery billing', () => {
    const rediscoveryBase = Date.parse('2026-06-01T10:00:00.000Z');
    const path = 'docs/runbooks/app-production/README.md';
    const rec = detector.rule(
      input({
        toolData: [
          toolSession('candidate-origin', [
            bash(durableCommand, '2026-04-01T10:00:00.000Z'),
            { ...writeRunbook(path, '2026-04-02T10:00:00.000Z'), toolUseId: 'candidate-apr' },
          ]),
          toolSession('backward-invalidator', [
            bash('npm test', '2026-07-01T10:00:00.000Z', 'transition-anchor'),
            {
              ...writeRunbook(path, '2026-04-03T10:00:00.000Z', {
                marker: false,
                toolName: 'Edit',
              }),
              toolUseId: 'backward-invalidation',
            },
          ]),
        ],
        timelines: [
          timeline('june-transition-rediscovery', rediscoveryBase, [
            redUser(at(rediscoveryBase, 0), 'where is the service runbook?'),
            redUser(at(rediscoveryBase, 8), 'find how the remote setup works'),
          ]),
        ],
        sessions: [
          sessionMeta('candidate-origin'),
          sessionMeta('backward-invalidator'),
          sessionMeta('june-transition-rediscovery'),
        ],
      }),
      NOW
    );

    expect(rec?.id).toBe('workflow.value-of-agent-handoff');
    expect(rec?.severity).toBe('info');
    expect(rec?.estTimeReclaimedMin).toBe(15);
    expect(rec?.evidence?.join(' ')).not.toMatch(/billed back/i);
    expect(rec?.detail).toMatch(/aggregate freshness cannot be established/i);
  });

  it('does not let a materially future transition win state ordering or freshness', () => {
    const path = 'docs/runbooks/app-production/README.md';
    const recommendations =
      detector.emitAll?.(
        input({
          toolData: [
            toolSession('current-candidate', [
              bash(
                durableCommand,
                '2026-07-01T10:00:00.000Z',
                'current-mutation'
              ),
              {
                ...writeRunbook(path, '2026-07-01T10:02:00.000Z'),
                toolUseId: 'current-write',
              },
            ]),
            toolSession('future-editor', [
              {
                ...writeRunbook(path, '2099-01-01T10:00:00.000Z', {
                  marker: false,
                  toolName: 'Edit',
                }),
                toolUseId: 'future-invalidation',
              },
            ]),
          ],
          sessions: [
            sessionMeta('current-candidate'),
            sessionMeta('future-editor'),
          ],
        }),
        NOW
      ) ?? [];

    expect(recommendations.map((rec) => rec.id)).toEqual([
      'workflow.leave-behind-candidate-verification',
    ]);
    expect(recommendations[0].provenance?.asOf).toBeUndefined();
    expect(recommendations[0].provenance?.stale).toBeUndefined();
    expect(recommendations[0].evidence?.join(' ')).toMatch(
      /future-invalidation.*future.*evaluation clock/i
    );
  });

  it('does not bill or date a materially future durable mutation', () => {
    const rediscoveryBase = Date.parse('2026-07-03T10:00:00.000Z');
    const rec = detector.rule(
      input({
        toolData: [
          toolSession('future-mutation-session', [
            bash(
              durableCommand,
              '2099-01-01T10:00:00.000Z',
              'future-mutation'
            ),
          ]),
        ],
        timelines: [
          timeline('current-rediscovery', rediscoveryBase, [
            redUser(at(rediscoveryBase, 0), 'where is the remote config?'),
            redUser(at(rediscoveryBase, 8), 'which template created the setup?'),
          ]),
        ],
        sessions: [
          sessionMeta('future-mutation-session'),
          sessionMeta('current-rediscovery'),
        ],
      }),
      NOW
    );

    expect(rec?.id).toBe('workflow.value-of-agent-handoff');
    expect(rec?.severity).toBe('info');
    expect(rec?.estTimeReclaimedMin).toBe(15);
    expect(rec?.provenance?.asOf).toBeUndefined();
    expect(rec?.provenance?.stale).toBeUndefined();
    expect(rec?.evidence?.join(' ')).toMatch(
      /future-mutation.*future.*evaluation clock/i
    );
    expect(rec?.evidence?.join(' ')).not.toMatch(/billed back/i);
  });

  it('does not bill rediscovery entries dated before their timeline start', () => {
    const timelineStart = Date.parse('2026-07-03T10:00:00.000Z');
    const preStart = Date.parse('2026-01-03T10:00:00.000Z');
    const rec = detector.rule(
      input({
        toolData: [
          toolSession('june-mutation', [
            bash(
              durableCommand,
              '2026-06-01T10:00:00.000Z',
              'june-mutation'
            ),
          ]),
        ],
        timelines: [
          timeline('pre-start-rediscovery', timelineStart, [
            redUser(at(preStart, 0), 'where is the remote config?'),
            redUser(at(preStart, 8), 'which template created the setup?'),
          ]),
        ],
        sessions: [
          sessionMeta('june-mutation'),
          sessionMeta('pre-start-rediscovery'),
        ],
      }),
      NOW
    );

    expect(rec?.id).toBe('workflow.value-of-agent-handoff');
    expect(rec?.severity).toBe('info');
    expect(rec?.estTimeReclaimedMin).toBe(15);
    expect(rec?.evidence?.join(' ')).not.toMatch(/billed back/i);
  });

  it('does not bill a rediscovery burst back to the same session', () => {
    const rediscoveryBase = Date.parse('2026-07-03T10:00:00.000Z');
    const rec = detector.rule(
      input({
        toolData: [
          toolSession('same-session', [
            bash(
              durableCommand,
              '2026-07-01T10:00:00.000Z',
              'same-session-mutation'
            ),
          ]),
        ],
        timelines: [
          timeline('same-session', rediscoveryBase, [
            redUser(at(rediscoveryBase, 0), 'where is the remote config?'),
            redUser(at(rediscoveryBase, 8), 'which template created the setup?'),
          ]),
        ],
        sessions: [sessionMeta('same-session')],
      }),
      NOW
    );

    expect(rec?.severity).toBe('info');
    expect(rec?.estTimeReclaimedMin).toBe(15);
    expect(rec?.evidence?.join(' ')).not.toMatch(/billed back/i);
  });

  it('does not choose arbitrarily between equally recent prior sessions', () => {
    const mutationTimestamp = '2026-07-01T10:00:00.000Z';
    const rediscoveryBase = Date.parse('2026-07-03T10:00:00.000Z');
    const rec = detector.rule(
      input({
        toolData: [
          toolSession('equal-prior-a', [
            bash(durableCommand, mutationTimestamp, 'equal-mutation-a'),
          ]),
          toolSession('equal-prior-b', [
            bash(durableCommand, mutationTimestamp, 'equal-mutation-b'),
          ]),
        ],
        timelines: [
          timeline('equal-prior-rediscovery', rediscoveryBase, [
            redUser(at(rediscoveryBase, 0), 'where is the remote config?'),
            redUser(at(rediscoveryBase, 8), 'which template created the setup?'),
          ]),
        ],
        sessions: [
          sessionMeta('equal-prior-a'),
          sessionMeta('equal-prior-b'),
          sessionMeta('equal-prior-rediscovery'),
        ],
      }),
      NOW
    );

    expect(rec?.severity).toBe('info');
    expect(rec?.estTimeReclaimedMin).toBe(30);
    expect(rec?.evidence?.join(' ')).not.toMatch(/billed back/i);
  });

  it('does not bill a materially future rediscovery timeline', () => {
    const futureBase = Date.parse('2099-01-01T10:00:00.000Z');
    const rec = detector.rule(
      input({
        toolData: [
          toolSession('current-mutation-for-future-burst', [
            bash(
              durableCommand,
              '2026-07-01T10:00:00.000Z',
              'current-mutation-for-future-burst'
            ),
          ]),
        ],
        timelines: [
          timeline('future-rediscovery', futureBase, [
            redUser(at(futureBase, 0), 'where is the remote config?'),
            redUser(at(futureBase, 8), 'which template created the setup?'),
          ]),
        ],
        sessions: [
          sessionMeta('current-mutation-for-future-burst'),
          sessionMeta('future-rediscovery'),
        ],
      }),
      NOW
    );

    expect(rec?.id).toBe('workflow.value-of-agent-handoff');
    expect(rec?.severity).toBe('info');
    expect(rec?.estTimeReclaimedMin).toBe(15);
    expect(rec?.provenance?.asOf).toBe('2026-07-01');
    expect(rec?.evidence?.join(' ')).not.toMatch(/billed back/i);
    expect(rec?.detail).not.toContain('2099');
  });

  it('reports attribution unavailable instead of converting absent rows to zero', () => {
    const rec = detector.rule(
      input({
        toolData: [
          toolSession('no-token-row', [
            bash(durableCommand, '2026-07-01T10:00:00.000Z'),
          ]),
        ],
        sessions: [sessionMeta('no-token-row')],
        tokenData: [],
      }),
      NOW
    );
    const observations = rec?.provenance?.observations ?? [];

    expect(
      observations.find((observation) =>
        observation.field?.includes('contextToolResultTokensSum')
      )
    ).toMatchObject({ value: 'unavailable' });
    expect(
      observations.find((observation) =>
        observation.field?.includes('TokenEntry.toolUseIds intersect')
      )
    ).toMatchObject({ value: 'unavailable' });
    expect(observations.map((observation) => observation.claim).join(' ')).not.toMatch(
      /totals 0 context tool-result tokens/i
    );
  });

  it('distinguishes a measured zero token total from unavailable tool-use joins', () => {
    const tokens = tokenMeta('zero-without-join', 0);
    tokens.entries![0].toolUseIds = undefined;
    tokens.entries![0].toolResultBytes = undefined;
    const rec = detector.rule(
      input({
        toolData: [
          toolSession('zero-without-join', [
            bash(durableCommand, '2026-07-01T10:00:00.000Z'),
          ]),
        ],
        sessions: [sessionMeta('zero-without-join')],
        tokenData: [tokens],
      }),
      NOW
    );
    const observations = rec?.provenance?.observations ?? [];
    const tokenObservation = observations.find((observation) =>
      observation.field?.includes('contextToolResultTokensSum')
    );
    const joinObservation = observations.find((observation) =>
      observation.field?.includes('TokenEntry.toolUseIds intersect')
    );

    expect(tokenObservation?.value).toBe(0);
    expect(tokenObservation?.claim).toMatch(/is numeric.*totaling 0/i);
    expect(joinObservation?.value).toBe('unavailable');
  });

  it('joins attribution to a deciding cross-session invalidation and reports partial coverage', () => {
    const path = 'docs/runbooks/app-production/README.md';
    const invalidatorTokens = tokenMeta('external-invalidator', 7);
    invalidatorTokens.entries![0].toolUseIds = ['external-invalidation'];
    invalidatorTokens.entries![0].toolResultBytes = 12;
    const rec = detector.rule(
      input({
        toolData: [
          toolSession('durable-origin', [
            bash(
              durableCommand,
              '2026-07-01T10:00:00.000Z',
              'durable-mutation'
            ),
            {
              ...writeRunbook(path, '2026-07-01T10:02:00.000Z'),
              toolUseId: 'candidate-write',
            },
          ]),
          toolSession('external-invalidator', [
            {
              ...writeRunbook(path, '2026-07-02T10:00:00.000Z', {
                marker: false,
                toolName: 'Edit',
              }),
              toolUseId: 'external-invalidation',
            },
          ]),
        ],
        sessions: [
          sessionMeta('durable-origin'),
          sessionMeta('external-invalidator'),
        ],
        tokenData: [invalidatorTokens],
      }),
      NOW
    );
    const observations = rec?.provenance?.observations ?? [];
    const tokenObservation = observations.find((observation) =>
      observation.field?.includes('contextToolResultTokensSum')
    );
    const joinObservation = observations.find((observation) =>
      observation.field?.includes('TokenEntry.toolUseIds intersect')
    );

    expect(rec?.id).toBe('workflow.value-of-agent-handoff');
    expect(tokenObservation?.value).toBe(7);
    expect(tokenObservation?.claim).toMatch(/across 2 involved session\(s\)/i);
    expect(joinObservation?.value).toBe(1);
    expect(joinObservation?.claim).toMatch(/1 of 2 involved/i);
  });

  it('does not join a reused tool-use id from the wrong session', () => {
    const path = 'docs/runbooks/app-production/README.md';
    const wrongSessionTokens = tokenMeta('durable-origin-collision', 9);
    wrongSessionTokens.entries![0].toolUseIds = ['external-invalidation-collision'];
    const rec = detector.rule(
      input({
        toolData: [
          toolSession('durable-origin-collision', [
            bash(
              durableCommand,
              '2026-07-01T10:00:00.000Z',
              'durable-mutation-collision'
            ),
            writeRunbook(path, '2026-07-01T10:02:00.000Z'),
          ]),
          toolSession('external-invalidator-collision', [
            {
              ...writeRunbook(path, '2026-07-02T10:00:00.000Z', {
                marker: false,
                toolName: 'Edit',
              }),
              toolUseId: 'external-invalidation-collision',
            },
          ]),
        ],
        sessions: [
          sessionMeta('durable-origin-collision'),
          sessionMeta('external-invalidator-collision'),
        ],
        tokenData: [wrongSessionTokens],
      }),
      NOW
    );
    const joinObservation = rec?.provenance?.observations.find((observation) =>
      observation.field?.includes('TokenEntry.toolUseIds intersect')
    );

    expect(joinObservation?.value).toBe('unavailable');
    expect(joinObservation?.claim).toMatch(/0 of 2 involved session-scoped/i);
  });

  it('cites the actual freshness-limiting candidate separately from an exact example', () => {
    const rec = detector.rule(
      input({
        toolData: [
          toolSession('exact-scope', [
            bash(durableCommand, '2026-02-01T10:00:00.000Z', 'exact-mutation'),
            {
              ...writeRunbook(
                'docs/runbooks/exact-production/README.md',
                '2026-02-01T10:02:00.000Z'
              ),
              toolUseId: 'exact-write',
            },
          ]),
          toolSession('unknown-scope', [
            bash(durableCommand, '2026-01-01T10:00:00.000Z', 'unknown-mutation'),
            {
              ...writeRunbook(
                'docs/runbooks/unknown-production/README.md',
                'timestamp-unavailable'
              ),
              toolUseId: 'unknown-write',
            },
          ]),
        ],
        sessions: [sessionMeta('exact-scope'), sessionMeta('unknown-scope')],
      }),
      NOW
    );
    const claims = rec?.provenance?.observations
      .map((observation) => observation.claim)
      .join(' ');

    expect(rec?.id).toBe('workflow.leave-behind-candidate-verification');
    expect(rec?.provenance?.asOf).toBeUndefined();
    expect(claims).toMatch(/unknown-write.*missing or unparseable timestamp/i);
    expect(
      rec?.provenance?.observations.find(
        (observation) => observation.value === 'exact-write'
      )?.claim
    ).toMatch(/proven after the durable mutation/i);
    expect(
      rec?.provenance?.observations.find(
        (observation) => observation.value === 'exact-write'
      )?.claim
    ).not.toMatch(/unresolved.*timeline/i);
  });

  it('does not describe an unordered cross-session candidate as post-mutation', () => {
    const path = 'docs/runbooks/app-production/README.md';
    const rec = detector.rule(
      input({
        toolData: [
          toolSession('mutated-then-invalidated', [
            bash(durableCommand, '2026-07-01T10:00:00.000Z'),
            {
              ...writeRunbook(path, '2026-07-01T10:02:00.000Z', {
                marker: false,
              }),
              toolUseId: 'known-invalidation',
            },
          ]),
          toolSession('unordered-writer', [
            {
              ...writeRunbook(path, 'timestamp-unavailable'),
              toolUseId: 'unordered-candidate',
            },
          ]),
        ],
        sessions: [
          sessionMeta('mutated-then-invalidated'),
          sessionMeta('unordered-writer'),
        ],
      }),
      NOW
    );

    expect(rec?.id).toBe('workflow.leave-behind-candidate-verification');
    expect(rec?.detail).not.toMatch(/across .* after their mutations/i);
    expect(rec?.detail).toMatch(/order relative to the durable mutation is not proven/i);
    expect(
      rec?.provenance?.observations.find(
        (observation) => observation.value === 'unordered-candidate'
      )?.claim
    ).toMatch(/order relative to the durable mutation is unproven/i);
    expect(rec?.provenance?.inference).not.toMatch(
      /^A conformant document structure was observed after the durable-state mutation/i
    );
  });
});
