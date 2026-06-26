/**
 * Experiment-axis enrollment ledger ingest (#2242, part of #2227).
 *
 * Parses the append-only `~/.claude/experiments/enrollment.jsonl` written by the
 * `/experiment-enroll` skill (see `~/.claude/experiments/README.md`). One JSON
 * object per line:
 *
 *   {"ts":"…","sessionId":"…","axis":"background-first","arm":"on","assignment":"menu"}
 *
 * A session is "enrolled" if any line carries its `sessionId`; the LAST matching
 * line wins if a session re-enrolls. Fail-open: a missing, empty, or garbage
 * ledger yields zero enrollments and NEVER throws — enrollment is an optional,
 * opt-in signal, so its absence must degrade silently like the shadow-calls ledger.
 */

export type Assignment = 'menu' | 'blind';

export interface EnrollmentRecord {
  /** ISO-8601 timestamp of the enrollment (raw, unvalidated). */
  ts?: string;
  /** Claude Code session id this enrollment applies to. */
  sessionId: string;
  /** Axis `key` from the registry (e.g. `background-first`). */
  axis: string;
  /** Arm `id` within the axis (e.g. `on` / `off`). */
  arm: string;
  /** `menu` (v0, self-selected) or `blind` (eventual causal form). */
  assignment: Assignment;
}

/** The latest-wins enrollment for one session. */
export interface SessionEnrollment {
  sessionId: string;
  axis: string;
  arm: string;
  assignment: Assignment;
}

function isValidRecord(value: unknown): value is EnrollmentRecord {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.sessionId === 'string' &&
    r.sessionId.length > 0 &&
    typeof r.axis === 'string' &&
    r.axis.length > 0 &&
    typeof r.arm === 'string' &&
    r.arm.length > 0 &&
    (r.assignment === 'menu' || r.assignment === 'blind')
  );
}

/**
 * Parse the JSONL ledger text into per-session enrollments, latest-wins.
 *
 * The input is the raw file contents (or `null`/`undefined`/`''` when no ledger
 * exists). Malformed lines are skipped individually — one bad line never sinks
 * the rest of the file. Returns a Map keyed by `sessionId`; later lines for the
 * same session overwrite earlier ones (the ledger is append-only and ordered).
 */
export function parseEnrollmentLedger(
  text: string | null | undefined
): Map<string, SessionEnrollment> {
  const bySession = new Map<string, SessionEnrollment>();
  if (!text) return bySession;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // skip a malformed line, keep parsing the rest
    }
    if (!isValidRecord(parsed)) continue;
    // Append-only ordering means a later line for the same session is the newer
    // enrollment; overwrite so the last record wins.
    bySession.set(parsed.sessionId, {
      sessionId: parsed.sessionId,
      axis: parsed.axis,
      arm: parsed.arm,
      assignment: parsed.assignment,
    });
  }
  return bySession;
}
