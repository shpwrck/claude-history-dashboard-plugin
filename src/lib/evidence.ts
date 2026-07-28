import type { SessionTimeline, TimelineEntry } from './parse-timeline';

export interface EvidenceRef {
  sessionId: string;
  entryIndex: number;
  timestamp: string;
  /**
   * Stable Claude tool_use id. Present for tool_use entries and copied onto the
   * matching tool_result entry when the transcript carries one.
   */
  toolUseId?: string;
}

export interface ResolvedEvidenceRef {
  ref: EvidenceRef;
  timeline: SessionTimeline;
  entry: TimelineEntry;
  entryIndex: number;
}

function matchesRef(
  entry: TimelineEntry | undefined,
  ref: EvidenceRef
): entry is TimelineEntry {
  if (!entry || entry.timestamp !== ref.timestamp) return false;
  if (ref.toolUseId && entry.toolUseId !== ref.toolUseId) return false;
  return true;
}

export function evidenceRefForEntry(
  timeline: SessionTimeline,
  entryIndex: number
): EvidenceRef | null {
  const entry = timeline.entries[entryIndex];
  if (!entry) return null;
  return {
    sessionId: timeline.sessionId,
    entryIndex,
    timestamp: entry.timestamp,
    ...(entry.toolUseId ? { toolUseId: entry.toolUseId } : {}),
  };
}

export function resolveEvidenceRef(
  ref: EvidenceRef,
  timelines: readonly SessionTimeline[]
): ResolvedEvidenceRef | null {
  const timeline = timelines.find((candidate) => candidate.sessionId === ref.sessionId);
  if (!timeline) return null;

  // Fast path: a ref minted moments ago by evidenceRefForEntry (every
  // "Entry N" link in SessionTimeline/SessionList) carries the CURRENT
  // entryIndex for the CURRENT timeline, so an in-bounds index whose entry
  // still matches ref's identity is the entry the ref was built from — that
  // is what "still in bounds and matching" *means* for a fresh ref, and
  // rejecting it would silently dead-link every "Entry N" click into a
  // same-timestamp multi-block turn (assistant thinking + text is routine;
  // see parseSessionTimeline). A reparse CAN insert a same-timestamp sibling
  // ahead of the target and leave a stale index pointing at the wrong entry
  // here — that residual misattribution is real and is knowingly deferred to
  // #3390 (stable per-entry identifier), not solved by this fast path.
  const indexedEntry = timeline.entries[ref.entryIndex];
  if (matchesRef(indexedEntry, ref)) {
    return {
      ref,
      timeline,
      entry: indexedEntry,
      entryIndex: ref.entryIndex,
    };
  }

  // Once the index itself is stale (out of bounds, or no longer matching),
  // we must search the whole timeline, and a bare timestamp (no toolUseId)
  // is not a unique key — same-timestamp siblings from one transcript record
  // are the ordinary case, not an edge case. Resolving to "the first match"
  // would silently attach evidence to an unrelated entry, so the fallback
  // only resolves when ref's identity narrows the timeline down to exactly
  // one candidate; any other count (zero or ambiguous) fails closed to null
  // rather than guessing (#3125).
  const fallbackIndices: number[] = [];
  timeline.entries.forEach((entry, index) => {
    if (matchesRef(entry, ref)) fallbackIndices.push(index);
  });
  if (fallbackIndices.length !== 1) return null;

  const fallbackIndex = fallbackIndices[0];
  return {
    ref,
    timeline,
    entry: timeline.entries[fallbackIndex],
    entryIndex: fallbackIndex,
  };
}

export function resolveEvidenceRefs(
  refs: readonly EvidenceRef[],
  timelines: readonly SessionTimeline[]
): ResolvedEvidenceRef[] {
  return refs.flatMap((ref) => {
    const resolved = resolveEvidenceRef(ref, timelines);
    return resolved ? [resolved] : [];
  });
}
