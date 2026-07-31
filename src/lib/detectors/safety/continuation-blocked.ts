import type { Detector } from '../types';
import { newestIsoDate, short, STALE_WEEKS } from '../shared';
import { isAsOfStale } from '../provenance';
import type { RuntimeEvents, StopHookEvent } from '../../parse-runtime-events';

const MIN_BLOCKED_CONTINUATIONS = 2;

/**
 * Blocked-continuation history whose newest contributing event is older than
 * this demotes to "As of <date>" wording + a re-check action (#3219, the
 * generic #1102 stale-input rule). Same 4-week window the cost detectors use
 * (#3194) — old stop-hook blocks say nothing about the CURRENT guard config.
 */
const STALE_AFTER_DAYS = STALE_WEEKS * 7;

interface BlockedContinuationSession {
  sessionId: string;
  blockedCount: number;
  latestTimestamp: string;
}

function eventSessionId(
  session: RuntimeEvents,
  event: StopHookEvent
): string {
  return event.sessionId || session.sessionId;
}

function timestampIsAfter(next: string, previous: string): boolean {
  const nextMs = Date.parse(next);
  const previousMs = Date.parse(previous);
  if (Number.isFinite(nextMs) && Number.isFinite(previousMs)) {
    return nextMs > previousMs;
  }
  return next > previous;
}

export function blockedContinuationSessions(
  runtimeEvents: RuntimeEvents[]
): BlockedContinuationSession[] {
  const bySession = new Map<string, BlockedContinuationSession>();
  for (const session of runtimeEvents) {
    for (const event of session.stopHooks) {
      if (!event.preventedContinuation) continue;
      const sessionId = eventSessionId(session, event);
      const existing = bySession.get(sessionId);
      if (!existing) {
        bySession.set(sessionId, {
          sessionId,
          blockedCount: 1,
          latestTimestamp: event.timestamp,
        });
        continue;
      }
      existing.blockedCount += 1;
      if (timestampIsAfter(event.timestamp, existing.latestTimestamp)) {
        existing.latestTimestamp = event.timestamp;
      }
    }
  }
  return Array.from(bySession.values()).sort((a, b) => {
    const countDelta = b.blockedCount - a.blockedCount;
    if (countDelta !== 0) return countDelta;
    if (a.latestTimestamp === b.latestTimestamp) return a.sessionId.localeCompare(b.sessionId);
    return timestampIsAfter(b.latestTimestamp, a.latestTimestamp) ? 1 : -1;
  });
}

function evidenceRow(session: BlockedContinuationSession): string {
  return `${short(session.sessionId)}: ${session.blockedCount} blocked continuation(s)`;
}

export const detector: Detector = {
  id: 'safety.continuation-blocked',
  category: 'safety',
  dataDeps: ['runtimeEvents'],
  rule(input, now) {
    const runtimeEvents = input.runtimeEvents;
    if (!runtimeEvents || runtimeEvents.length === 0) return null;

    const sessions = blockedContinuationSessions(runtimeEvents);
    const blockedCount = sessions.reduce((sum, session) => sum + session.blockedCount, 0);
    if (blockedCount < MIN_BLOCKED_CONTINUATIONS) return null;

    // #3219: anchor the claim to the newest plausible contributing event date
    // (derived from the retained per-session latest timestamps, never `now`);
    // demote sufficiently old history to dated wording + a re-check action.
    const asOf = newestIsoDate(sessions.map((s) => s.latestTimestamp));
    const stale = isAsOfStale(asOf, now, STALE_AFTER_DAYS);

    return {
      id: 'safety.continuation-blocked',
      category: 'safety',
      severity: 'warning',
      title: 'Safety guards repeatedly blocked continuation',
      detail: stale
        ? `As of ${asOf}, ${blockedCount} stop-hook block(s) across ${sessions.length} session(s) had prevented continuation. A guard that fired repeatedly may have been catching real risk, or it may have been a misconfigured gate halting safe work.`
        : `${blockedCount} stop-hook block(s) across ${sessions.length} session(s) prevented continuation. A guard firing repeatedly may be catching real risk, or it may be a misconfigured gate that halts safe work.`,
      action: stale
        ? `Re-check current stop-hook behavior before acting — the newest blocked continuation here is dated ${asOf}. Then audit the blocking Stop hook or guard: keep non-zero exits for high-confidence safety failures, and make advisory checks log and exit zero so safe sessions can continue.`
        : 'Audit the blocking Stop hook or guard. Keep non-zero exits for high-confidence safety failures, and make advisory checks log and exit zero so safe sessions can continue.',
      affected: blockedCount,
      evidence: sessions.slice(0, 5).map(evidenceRow),
      view: 'permissions',
      provenance: {
        observations: [
          {
            claim: `${blockedCount} stop-hook event(s) recorded preventedContinuation=true`,
            source: 'parse-runtime-events',
            field: 'runtimeEvents[].stopHooks[].preventedContinuation',
            value: blockedCount,
          },
          {
            claim: `${sessions.length} session(s) contributed blocked continuation evidence`,
            source: 'parse-runtime-events',
            field: 'runtimeEvents[].sessionId',
            value: sessions.length,
          },
        ],
        inference:
          'Repeated continuation blocks are safety-relevant because they either indicate recurring risky actions being stopped or a guard configuration that is interrupting safe work.',
        ...(asOf !== undefined ? { asOf, stale } : {}),
      },
    };
  },
};
