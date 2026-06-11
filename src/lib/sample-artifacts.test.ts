import { describe, it, expect } from 'vitest';
import {
  buildSampleTasks,
  buildSampleTeams,
  buildSamplePlans,
  buildSampleStatsCache,
  buildSampleSessionRegistry,
  buildSampleTelemetry,
  buildSampleDebugLogs,
  buildSampleFileHistory,
  buildSampleUpdateResults,
  buildSampleMcpAuth,
  buildSampleConfigBackups,
  buildSampleLiveConfig,
  buildSampleDeceitSignals,
} from './sample-artifacts';
import { buildSampleWorkflows } from './sample-workflows';
import { parseWorkflows } from './parse-workflows';
import { buildReportCard } from './report-card';
import { analyzeActivityTrend } from './parse-stats-cache';
import { clusterPlans } from './parse-plans';
import { summarizeTasks, COLD_DAYS } from './parse-tasks';
import { buildRecommendations } from './recommendations';
import type { RecommendationInput } from './detectors/types';

// Fixed clock so the time-relative generators (task mtimes, stats-cache dates)
// are deterministic in the suite.
const NOW = Date.UTC(2026, 5, 4, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const IDS = ['sess-aaaa', 'sess-bbbb', 'sess-cccc'];

// A minimal RecommendationInput carrying ONLY the #539 sample artifact fields,
// so we can assert the demo fires the same findings the server build would.
function sampleInput(): RecommendationInput {
  return {
    tokenData: [],
    toolData: [],
    sessions: [],
    projects: [],
    permissionRows: [],
    apiErrors: [],
    tasks: buildSampleTasks(IDS, NOW),
    teams: buildSampleTeams(),
    plans: buildSamplePlans(),
    statsCache: buildSampleStatsCache(NOW),
    sessionRegistry: buildSampleSessionRegistry(NOW),
    telemetry: buildSampleTelemetry(),
    debugLogs: buildSampleDebugLogs(),
    fileHistory: buildSampleFileHistory(NOW),
    updateResults: buildSampleUpdateResults(),
    mcpAuth: buildSampleMcpAuth(),
    configBackups: buildSampleConfigBackups(NOW),
  };
}

describe('sample-artifacts — every new view gets non-empty demo data', () => {
  it('tasks: includes a cold session with open tasks and a blocked pileup', () => {
    const tasks = buildSampleTasks(IDS, NOW);
    expect(tasks.length).toBeGreaterThan(0);
    const summaries = summarizeTasks(tasks);
    expect(summaries.length).toBeGreaterThan(0);
    // at least one session is cold (idle >= COLD_DAYS) AND has an open task
    const coldOpen = summaries.some(
      (s) => s.open > 0 && NOW - s.latestMtimeMs >= COLD_DAYS * DAY
    );
    expect(coldOpen).toBe(true);
    // a same-session blocked pileup exists (>=2 open tasks behind an unfinished root)
    expect(tasks.some((t) => t.blockedBy.length > 0)).toBe(true);
  });

  it('teams: a degraded team (stalled agent + >=50% dropped) and a healthy one', () => {
    const teams = buildSampleTeams();
    expect(teams.some((t) => t.stalledAgents.length > 0 && t.droppedPct >= 50)).toBe(true);
    expect(teams.some((t) => t.droppedCount === 0)).toBe(true);
  });

  it('plans: cluster into all three shapes with large unverified plans present', () => {
    const plans = buildSamplePlans();
    const { stats } = clusterPlans(plans);
    expect(stats.filter((s) => s.count > 0).length).toBeGreaterThanOrEqual(2);
    expect(
      plans.some((p) => !p.hasVerification && (p.fileRefs >= 6 || p.words >= 1000))
    ).toBe(true);
  });

  it('stats-cache: this week runs hotter than last week', () => {
    const analysis = analyzeActivityTrend(buildSampleStatsCache(NOW), NOW);
    expect(analysis.verdict).toBe('hotter');
    expect(analysis.sparkline.length).toBe(14);
    expect(analysis.toolCallCount.pctChange).toBeGreaterThanOrEqual(50);
  });

  it('report card: joins the trio into KEEP x1 / FLAG x1 / MOVE x2', () => {
    const card = buildReportCard(
      buildSampleSessionRegistry(NOW),
      buildSampleTelemetry(),
      buildSampleDebugLogs()
    );
    expect(card.totalProjects).toBe(4);
    expect(card.tally).toEqual({ KEEP: 1, FLAG: 1, MOVE: 2 });
    // the committed-but-heavy data-pipeline project must demote to MOVE
    const dp = card.projects.find((p) => p.cwd.endsWith('data-pipeline'));
    expect(dp?.attributionBucket).toBe('committed');
    expect(dp?.verdict).toBe('MOVE');
  });
});

describe('sample-artifacts — demo recommendations parity', () => {
  it('fires the headline #539 detectors on the sample input', () => {
    const recs = buildRecommendations(sampleInput(), NOW);
    const ids = new Set(recs.map((r) => r.id));
    for (const id of [
      'workflow.abandoned-tasks',
      'workflow.blocked-task-pileup',
      'reliability.dropped-assignments',
      'activity.activity-trend',
      'workflow.plan-missing-verification',
      'reliability.agent-report-card',
      // detector-only artifacts (no dedicated view)
      'workflow.rework-signature',
      'reliability.self-update-health',
      'reliability.mcp-needs-auth',
      'reliability.config-drift',
    ]) {
      expect(ids.has(id), `expected ${id} to fire on the demo dataset`).toBe(true);
    }
  });

  it('detector-only artifacts produce non-empty demo data', () => {
    expect(buildSampleFileHistory(NOW).length).toBeGreaterThanOrEqual(3);
    expect(buildSampleUpdateResults().some((u) => u.outcome !== 'success')).toBe(true);
    expect(buildSampleMcpAuth().serversNeedingAuth.length).toBeGreaterThan(0);
    const recentDrift = buildSampleConfigBackups(NOW).filter(
      (e) => e.kind !== 'global-churn' && NOW - e.timestamp <= 7 * DAY
    );
    expect(recentDrift.length).toBeGreaterThan(0);
  });
});

describe('sample data — new #632 orchestration detectors fire in the demo (#669)', () => {
  const NOW_669 = Date.UTC(2026, 5, 4, 12, 0, 0);
  const DAY_669 = 24 * 60 * 60 * 1000;
  const recIds = (): Set<string> => {
    const input: RecommendationInput = {
      tokenData: [],
      toolData: [],
      sessions: [{ sessionId: 'sess-aaaa', startTime: NOW_669 - DAY_669 }] as unknown as RecommendationInput['sessions'],
      projects: [],
      permissionRows: [],
      apiErrors: [],
      attribution: [],
      liveConfig: buildSampleLiveConfig(),
      workflows: parseWorkflows(buildSampleWorkflows(['sess-aaaa', 'sess-bbbb', 'sess-cccc'])),
    };
    return new Set(buildRecommendations(input, NOW_669).map((r) => r.id));
  };

  it('liveConfig surfaces unused installed subagents and commands', () => {
    const ids = recIds();
    expect(ids.has('workflow.unused-installed-subagents')).toBe(true);
    expect(ids.has('workflow.unused-installed-commands')).toBe(true);
  });

  it('sample workflows surface failed-run and runaway-cost findings', () => {
    const ids = recIds();
    expect(ids.has('workflow.failed-workflow-runs')).toBe(true);
    expect(ids.has('workflow.runaway-workflow-cost')).toBe(true);
  });
});

describe('sample data — security.model-deceit fires in the SPA demo (#688)', () => {
  const NOW_688 = Date.UTC(2026, 5, 4, 12, 0, 0);
  const IDS_688 = ['sess-aaaa', 'sess-bbbb', 'sess-cccc'];

  it('one flagged session with a contradicted claim → a security warning', () => {
    const deceitSignals = buildSampleDeceitSignals(IDS_688);
    const flagged = deceitSignals.filter(
      (s) => s.unbackedClaimCount + s.contradictedClaimCount > 0
    );
    expect(flagged.length).toBe(1);

    const input: RecommendationInput = {
      tokenData: [],
      toolData: [],
      sessions: [],
      projects: [],
      permissionRows: [],
      apiErrors: [],
      deceitSignals,
    };
    const rec = buildRecommendations(input, NOW_688).find(
      (r) => r.id === 'security.model-deceit'
    );
    expect(rec).toBeDefined();
    expect(rec?.category).toBe('security');
    expect(rec?.severity).toBe('warning');
  });

  it('stays dark with no session ids (the transcript-free upload)', () => {
    expect(buildSampleDeceitSignals([])).toEqual([]);
  });
});
