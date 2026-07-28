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
  /**
   * Stable per-entry identity (#3390) copied from {@link TimelineEntry.entryId}
   * — `${record.uuid}:${blockIndex}`, keyed on the source record's own id so it
   * survives records being spliced in ahead of it by the subagent merge (see
   * the field doc on `TimelineEntry` for the measured reason position failed).
   *
   * When present this is the ONLY thing {@link resolveEvidenceRef} matches on:
   * identity REPLACES the ambiguous index+timestamp path rather than joining it
   * as a third signal that could disagree with the other two. Absent only on a
   * ref minted before the field existed (or by a producer whose source entry
   * has no `entryId`), which is what keeps the legacy fallback alive.
   */
  entryId?: string;
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
    ...(entry.entryId ? { entryId: entry.entryId } : {}),
  };
}

export function resolveEvidenceRef(
  ref: EvidenceRef,
  timelines: readonly SessionTimeline[]
): ResolvedEvidenceRef | null {
  const timeline = timelines.find((candidate) => candidate.sessionId === ref.sessionId);
  if (!timeline) return null;

  // IDENTITY PATH (#3390) — dispositive, and the ONLY path taken when the ref
  // carries an entryId. `entryId` names one entry outright, so there is nothing
  // for an index or a timestamp to corroborate: consulting them could only
  // introduce a disagreement, and any rule for settling that disagreement would
  // reinstate exactly the guesswork this field removes. Nothing below runs.
  //
  // SET BUT UNMATCHED => null, deliberately. A ref whose entryId is absent from
  // the timeline was written against an entry that no longer exists at that
  // position (the transcript was edited/rewritten, or a different parser version
  // produced it). Falling back to the timestamp rule there would resolve it to
  // whatever entry now happens to carry that timestamp — precisely the silent
  // misattribution the identity was added to prevent, reintroduced one layer in.
  // A dead link is recoverable; a confident wrong link is not (#3125).
  //
  // Duplicate ids fail closed for the same reason. A record `uuid` is not
  // GUARANTEED unique the way an array position is — a merge could carry the
  // same record twice (none observed: 0 duplicates across 8790 live records) —
  // and that is the safe direction for the weakness to point: a duplicate makes
  // the id ambiguous, and ambiguity is never resolved by guessing.
  if (ref.entryId !== undefined) {
    const identityIndices: number[] = [];
    timeline.entries.forEach((entry, index) => {
      if (entry.entryId === ref.entryId) identityIndices.push(index);
    });
    if (identityIndices.length !== 1) return null;
    const identityIndex = identityIndices[0];
    return {
      ref,
      timeline,
      entry: timeline.entries[identityIndex],
      entryIndex: identityIndex,
    };
  }

  // ---- Legacy path: refs with NO entryId (minted before #3390, or by a
  // producer whose source entry predates the field). Unchanged from #3125.

  // Fast path: a ref minted moments ago by evidenceRefForEntry (every
  // "Entry N" link in SessionTimeline/SessionList) carries the CURRENT
  // entryIndex for the CURRENT timeline, so an in-bounds index whose entry
  // still matches ref's identity is the entry the ref was built from — that
  // is what "still in bounds and matching" *means* for a fresh ref, and
  // rejecting it would silently dead-link every "Entry N" click into a
  // same-timestamp multi-block turn (assistant thinking + text is routine;
  // see parseSessionTimeline). A reparse CAN insert a same-timestamp sibling
  // ahead of the target and leave a stale index pointing at the wrong entry
  // here — that residual misattribution is real and is not solved by this fast
  // path. It is now confined to entryId-less refs: any ref minted against a
  // parsed timeline carries an entryId and never reaches this code (#3390).
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
