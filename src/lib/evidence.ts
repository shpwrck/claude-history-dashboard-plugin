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

  const indexedEntry = timeline.entries[ref.entryIndex];
  if (matchesRef(indexedEntry, ref)) {
    return {
      ref,
      timeline,
      entry: indexedEntry,
      entryIndex: ref.entryIndex,
    };
  }

  const fallbackIndex = timeline.entries.findIndex((entry) =>
    matchesRef(entry, ref)
  );
  if (fallbackIndex === -1) return null;

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
