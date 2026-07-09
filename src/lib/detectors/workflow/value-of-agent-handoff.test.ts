import { describe, expect, it } from 'vitest';
import { detector } from './value-of-agent-handoff';
import { buildRecommendations } from '../../recommendations';
import { validateFixSnippet } from '../fix-validity';
import { validateRecommendationProvenance } from '../provenance';
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

function writeRunbook(filePath: string, timestamp: string): ToolCall {
  return {
    timestamp,
    toolName: 'Write',
    input: { file_path: filePath },
    toolUseId: 'runbook-1',
    isError: false,
    resultBytes: 0,
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

  it('suppresses a durable-state session when a runbook artifact is written', () => {
    const setupBase = Date.parse('2026-07-01T10:00:00.000Z');
    const rec = detector.rule(
      input({
        toolData: [
          toolSession('setup-with-runbook', [
            bash(durableCommand, at(setupBase, 0)),
            writeRunbook('docs/runbook-app.md', at(setupBase, 2)),
          ]),
        ],
        sessions: [sessionMeta('setup-with-runbook')],
      }),
      NOW
    );

    expect(rec).toBeNull();
  });

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
