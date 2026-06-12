/**
 * Agent Report Card (#572) — the consolidation surface for issue #539.
 *
 * Persona P7 (Owen, multi-CLI evaluator) independently reached for the same
 * "one-screen agent report card" on THREE separate artifacts during the #539
 * brainstorm — `sessions/` (attribution), `telemetry/1p_failed_events` (retry
 * storms + wasted wall-clock), and `debug/*.txt` (TTFB + fast-mode-lost). The
 * decision he is actually making needs attribution and reliability in the SAME
 * row, because they interact: a project that is 100% one entrypoint (a clean
 * "KEEP" by attribution alone) but storms retries and bleeds p90 TTFB is NOT a
 * clean KEEP. The reliability tax is the per-completed-task cost a token meter
 * can't see — and it's what disqualifies a CLI for unattended work.
 *
 * This module JOINS the three parsers on `sessionId` / `cwd` and emits ONE
 * blended verdict per project. It is the single owner of the unified surface;
 * #561/#562/#569 stay as the per-artifact ingest/parse work that feeds it.
 *
 * Pure (no I/O): it consumes the already-parsed arrays the ingest step assembles
 * (`sessionRegistry`, `telemetry`, `debugLogs`), so the same builder runs both
 * server-side (the consolidated detector) and client-side (the report-card view)
 * with no drift between the chart and the JSON export (the P10/Aya constraint).
 */
import {
  analyzeAttribution,
  type SessionRegistryEntry,
  type ProjectAttribution,
  type AttributionBucket,
  type EntrypointCount,
  type VersionTimelineEntry,
} from './parse-session-registry';
import {
  analyzeReliability,
  type TelemetryEvent,
  type SessionReliability,
} from './parse-telemetry';
import { isUnattendedEntrypoint } from './parse-sessions';
import type { DebugSessionMetrics } from './parse-debug';

/** Reliability-drag bucket (additive score, then bucketed). */
export type DragBucket = 'OK' | 'DRAG' | 'HEAVY';

/** The blended per-project verdict. */
export type ReportCardVerdict = 'KEEP' | 'FLAG' | 'MOVE';

/** Drag-score thresholds (#572 prototype). Exported so the view legend matches. */
export const DRAG_DRAG_MIN = 20;
export const DRAG_HEAVY_MIN = 45;

/** Drag-signal thresholds (#572 prototype). */
export const RETRY_STORM_RATE_PCT = 25;
export const RETRY_STORM_MAX_ATTEMPT = 8;
export const TTFB_P90_HEAVY_MS = 5000;
export const DEAD_WALLCLOCK_MS = 60000;

/**
 * Durable transcript-derived context used only when telemetry/debug has a
 * session id that is no longer present in the live `~/.claude/sessions`
 * registry. Live registry entries always win.
 */
export interface ReportCardSessionContext {
  sessionId: string;
  /** Project/cwd from grouped transcript entries. */
  project?: string;
  /** Alias accepted for tests and future server-side callers. */
  cwd?: string;
  startTime?: number;
  /** Transcript/token parser entrypoint dimension, when present. */
  entrypoint?: string;
  version?: string;
}

/** One joined project row: attribution + reliability + blended verdict. */
export interface ReportCardProject {
  /** Absolute working directory — the project key. */
  cwd: string;
  sessionCount: number;
  // ── Attribution axis (from sessions/) ──────────────────────────────────
  attributionBucket: AttributionBucket;
  dominantEntrypoint: string;
  dominantShare: number;
  entrypointMatrix: EntrypointCount[];
  versionTimeline: VersionTimelineEntry[];
  /** Auditable kind!=entrypoint count (see parse-session-registry caveat). */
  kindEntrypointAnomalyCount: number;
  // ── Reliability axis (from telemetry + debug, joined on sessionId) ──────
  /** % of this project's failed API events at attempt >= 4. */
  retryStormPct: number;
  /** Highest retry attempt seen across the project's sessions. */
  maxAttempt: number;
  /** Worst per-session p90 time-to-first-byte (ms) across the project. */
  p90TtfbMs: number;
  /** Total dead wall-clock (ms) from slow-first-byte timeouts. */
  wastedMs: number;
  /** Count of "Fast mode unavailable" log lines across the project. */
  fastModeLostCount: number;
  /** Number of the project's sessions that had any telemetry/debug signal. */
  sessionsWithSignal: number;
  /** Alias for export/debug readability. */
  reliabilitySessionCount: number;
  /** Number of signal-bearing sessions recovered through transcript context. */
  recoveredFromTranscriptCount: number;
  /** Telemetry event rows contributing to retry-storm/wasted-clock fields. */
  telemetryEventCount: number;
  /** Distinct sessions with telemetry signal. */
  telemetrySessionCount: number;
  /** Distinct sessions with parsed debug-log signal. */
  debugSessionCount: number;
  /** TTFB samples contributing to the p90 TTFB field. */
  ttfbSampleCount: number;
  /** Raw samples that make maxAttempt an observed value instead of unavailable. */
  maxAttemptSourceCount: number;
  // ── Blend ──────────────────────────────────────────────────────────────
  dragScore: number;
  dragBucket: DragBucket;
  verdict: ReportCardVerdict;
  /** One-line, screenshot-and-argue explanation of the verdict. */
  verdictReason: string;
}

/** The whole fleet card: per-project rows + a fleet tally. */
export interface ReportCard {
  projects: ReportCardProject[];
  totalSessions: number;
  totalProjects: number;
  allVersions: string[];
  totalKindAnomalies: number;
  /** Verdict tally across projects. */
  tally: { KEEP: number; FLAG: number; MOVE: number };
  /** Fleet-wide retry-storm rate (%) and total wasted wall-clock (ms). */
  fleetRetryStormPct: number;
  fleetWastedMs: number;
  /** Fleet-wide coverage counts for auditability and not-measured rendering. */
  fleetTelemetryEventCount: number;
  fleetDebugSessionCount: number;
  fleetTtfbSampleCount: number;
  recoveredFromTranscriptCount: number;
}

/**
 * Compute the additive reliability-drag score for a project from its joined
 * telemetry + debug signals (#572 scoring). Returns the score and the bucket.
 */
function scoreDrag(args: {
  retryStormPct: number;
  maxAttempt: number;
  p90TtfbMs: number;
  wastedMs: number;
  fastModeLostCount: number;
  dominantEntrypoint: string;
}): { score: number; bucket: DragBucket } {
  let score = 0;
  if (
    args.retryStormPct >= RETRY_STORM_RATE_PCT ||
    args.maxAttempt >= RETRY_STORM_MAX_ATTEMPT
  ) {
    score += 40;
  }
  if (args.p90TtfbMs >= TTFB_P90_HEAVY_MS) score += 25;
  if (args.wastedMs >= DEAD_WALLCLOCK_MS) score += 15;
  // Fast-mode-lost only counts as drag on an SDK-dominant project: those are
  // the unattended runs paying a steady latency/cost tax for the lost fast path.
  if (args.fastModeLostCount > 0 && isUnattendedEntrypoint(args.dominantEntrypoint)) {
    score += 10;
  }
  const bucket: DragBucket =
    score >= DRAG_HEAVY_MIN ? 'HEAVY' : score >= DRAG_DRAG_MIN ? 'DRAG' : 'OK';
  return { score, bucket };
}

/**
 * The blend matrix (#572). The committed->FLAG/MOVE demotion path is the entire
 * reason to consolidate: it can only fire when attribution AND reliability are
 * joined.
 */
function blend(
  attribution: AttributionBucket,
  drag: DragBucket,
  sessionsWithSignal: number
): { verdict: ReportCardVerdict; reason: string } {
  if (attribution === 'low-signal') {
    return { verdict: 'MOVE', reason: 'Insufficient evidence (<=2 sessions); pilot elsewhere.' };
  }
  if (attribution === 'split') {
    return {
      verdict: 'FLAG',
      reason: 'Split across entrypoints; cost is untrustworthy until you pick one CLI.',
    };
  }
  if (sessionsWithSignal === 0) {
    return {
      verdict: 'FLAG',
      reason: 'Attribution is committed, but reliability is not measured for these sessions.',
    };
  }
  // committed
  if (drag === 'OK') {
    return { verdict: 'KEEP', reason: 'One CLI, clean reliability — attribute cost confidently.' };
  }
  if (drag === 'DRAG') {
    return {
      verdict: 'FLAG',
      reason: 'One CLI but a reliability tax to fix before trusting the cost numbers.',
    };
  }
  return { verdict: 'MOVE', reason: 'This CLI is actively expensive here (heavy reliability drag).' };
}

function normalizeContext(
  sessionContext: ReportCardSessionContext[] | null | undefined
): Map<string, ReportCardSessionContext> {
  const bySession = new Map<string, ReportCardSessionContext>();
  for (const row of sessionContext ?? []) {
    if (!row.sessionId) continue;
    const previous = bySession.get(row.sessionId);
    const incomingCwd = usableProject(row.cwd) || usableProject(row.project);
    const previousCwd = usableProject(previous?.cwd) || usableProject(previous?.project);
    const cwd = previousCwd || incomingCwd || '';
    bySession.set(row.sessionId, {
      sessionId: row.sessionId,
      cwd,
      project: usableProject(previous?.project) || usableProject(row.project),
      startTime: previous?.startTime ?? row.startTime,
      entrypoint: previous?.entrypoint ?? row.entrypoint,
      version: previous?.version ?? row.version,
    });
  }
  return bySession;
}

function usableProject(value: string | undefined): string | undefined {
  if (!value || value === '_unknown') return undefined;
  return value;
}

function syntheticRegistryEntry(
  sessionId: string,
  context: ReportCardSessionContext,
  index: number
): SessionRegistryEntry | null {
  const cwd = context.cwd || context.project || '';
  if (!cwd) return null;
  const entrypoint = context.entrypoint || 'unknown';
  return {
    pid: -1 - index,
    sessionId,
    cwd,
    startedAt: context.startTime ?? 0,
    procStart: 'transcript-context',
    version: context.version ?? '',
    peerProtocol: 0,
    kind: entrypoint,
    entrypoint,
  };
}

/**
 * Merge grouped-session project context with token-data dimensions. Callers pass
 * the result to buildReportCard so unregistered reliability session ids can
 * still be attributed without redesigning the parsers.
 */
export function buildReportCardSessionContext(
  sessions: ReportCardSessionContext[] | null | undefined,
  tokenData: ReportCardSessionContext[] | null | undefined = []
): ReportCardSessionContext[] {
  return Array.from(normalizeContext([...(sessions ?? []), ...(tokenData ?? [])]).values());
}

/**
 * Build the consolidated Agent Report Card from the three raw artifact arrays.
 * Joins telemetry + debug onto each project's sessions by sessionId.
 */
export function buildReportCard(
  sessionRegistry: SessionRegistryEntry[] | null | undefined,
  telemetry: TelemetryEvent[] | null | undefined,
  debugLogs: DebugSessionMetrics[] | null | undefined,
  sessionContext?: ReportCardSessionContext[] | null | undefined
): ReportCard {
  const registry = sessionRegistry ?? [];
  const reliability = analyzeReliability(telemetry ?? []);

  const relBySession = new Map<string, SessionReliability>();
  for (const s of reliability.bySession) relBySession.set(s.session_id, s);
  const debugBySession = new Map<string, DebugSessionMetrics>();
  for (const d of debugLogs ?? []) debugBySession.set(d.sessionId, d);

  const registrySessionIds = new Set(registry.map((entry) => entry.sessionId));
  const contextBySession = normalizeContext(sessionContext);
  const recoveredSessionIds = new Set<string>();
  const attributionEntries = [...registry];
  const reliabilitySessionIds = new Set<string>([
    ...relBySession.keys(),
    ...debugBySession.keys(),
  ]);
  let syntheticIndex = 0;
  for (const sessionId of reliabilitySessionIds) {
    if (!sessionId || registrySessionIds.has(sessionId)) continue;
    const context = contextBySession.get(sessionId);
    if (!context) continue;
    const synthetic = syntheticRegistryEntry(sessionId, context, syntheticIndex);
    if (!synthetic) continue;
    syntheticIndex += 1;
    recoveredSessionIds.add(sessionId);
    attributionEntries.push(synthetic);
  }

  const attribution = analyzeAttribution(attributionEntries);

  const projects: ReportCardProject[] = attribution.projects.map((p: ProjectAttribution) => {
    // Join telemetry + debug onto this project's sessions.
    let stormEvents = 0;
    let totalEvents = 0;
    let maxAttempt = 0;
    let wastedMs = 0;
    let p90TtfbMs = 0;
    let fastModeLostCount = 0;
    let sessionsWithSignal = 0;
    let recoveredFromTranscriptCount = 0;
    let telemetrySessionCount = 0;
    let debugSessionCount = 0;
    let ttfbSampleCount = 0;
    let maxAttemptSourceCount = 0;
    for (const entry of p.rawEntries) {
      const rel = relBySession.get(entry.sessionId);
      const dbg = debugBySession.get(entry.sessionId);
      if (rel || dbg) sessionsWithSignal += 1;
      if (rel || dbg) {
        if (recoveredSessionIds.has(entry.sessionId)) recoveredFromTranscriptCount += 1;
      }
      if (rel) {
        stormEvents += rel.stormEvents;
        totalEvents += rel.totalEvents;
        telemetrySessionCount += 1;
        maxAttemptSourceCount += rel.totalEvents;
        if (rel.maxAttempt > maxAttempt) maxAttempt = rel.maxAttempt;
        wastedMs += rel.totalWastedMs;
      }
      if (dbg) {
        debugSessionCount += 1;
        ttfbSampleCount += dbg.ttfbSampleCount;
        if (dbg.maxRetryAttempt > 0) maxAttemptSourceCount += 1;
        if (dbg.maxRetryAttempt > maxAttempt) maxAttempt = dbg.maxRetryAttempt;
        if (dbg.ttfbP90 > p90TtfbMs) p90TtfbMs = dbg.ttfbP90;
        fastModeLostCount += dbg.fastModeLostCount;
      }
    }
    const retryStormPct =
      totalEvents > 0 ? Math.round((100 * stormEvents) / totalEvents) : 0;

    const { score: dragScore, bucket: dragBucket } = scoreDrag({
      retryStormPct,
      maxAttempt,
      p90TtfbMs,
      wastedMs,
      fastModeLostCount,
      dominantEntrypoint: p.dominantEntrypoint,
    });
    const { verdict, reason } = blend(
      p.attributionBucket,
      dragBucket,
      sessionsWithSignal
    );

    return {
      cwd: p.cwd,
      sessionCount: p.sessionCount,
      attributionBucket: p.attributionBucket,
      dominantEntrypoint: p.dominantEntrypoint,
      dominantShare: p.dominantShare,
      entrypointMatrix: p.entrypointMatrix,
      versionTimeline: p.versionTimeline,
      kindEntrypointAnomalyCount: p.kindEntrypointAnomalyCount,
      retryStormPct,
      maxAttempt,
      p90TtfbMs,
      wastedMs,
      fastModeLostCount,
      sessionsWithSignal,
      reliabilitySessionCount: sessionsWithSignal,
      recoveredFromTranscriptCount,
      telemetryEventCount: totalEvents,
      telemetrySessionCount,
      debugSessionCount,
      ttfbSampleCount,
      maxAttemptSourceCount,
      dragScore,
      dragBucket,
      verdict,
      verdictReason: reason,
    };
  });

  const tally = { KEEP: 0, FLAG: 0, MOVE: 0 };
  for (const p of projects) tally[p.verdict] += 1;

  return {
    projects,
    totalSessions: attribution.totalSessions,
    totalProjects: attribution.totalProjects,
    allVersions: attribution.allVersions,
    totalKindAnomalies: attribution.totalKindAnomalies,
    tally,
    fleetRetryStormPct: reliability.retryStormPct,
    fleetWastedMs: reliability.totalWastedMs,
    fleetTelemetryEventCount: reliability.totalEvents,
    fleetDebugSessionCount: debugBySession.size,
    fleetTtfbSampleCount: Array.from(debugBySession.values()).reduce(
      (sum, row) => sum + row.ttfbSampleCount,
      0
    ),
    recoveredFromTranscriptCount: recoveredSessionIds.size,
  };
}
