import { describe, expect, it } from 'vitest';
import {
  evidenceRefForEntry,
  resolveEvidenceRef,
  resolveEvidenceRefs,
  type EvidenceRef,
} from './evidence';
import type { SessionTimeline } from './parse-timeline';

const timeline: SessionTimeline = {
  sessionId: 'session-1',
  startTime: '2026-06-12T10:00:00.000Z',
  endTime: '2026-06-12T10:02:00.000Z',
  entries: [
    {
      timestamp: '2026-06-12T10:00:00.000Z',
      kind: 'user',
      summary: 'inspect the failing test',
    },
    {
      timestamp: '2026-06-12T10:01:00.000Z',
      kind: 'tool_use',
      toolName: 'Bash',
      toolUseId: 'toolu_123',
      summary: '{"command":"npm test"}',
    },
    {
      timestamp: '2026-06-12T10:02:00.000Z',
      kind: 'tool_result',
      toolUseId: 'toolu_123',
      isError: true,
      summary: 'test failed',
    },
  ],
};

describe('EvidenceRef resolver (#1305)', () => {
  it('resolves an EvidenceRef to the correct timeline entry', () => {
    const ref: EvidenceRef = {
      sessionId: 'session-1',
      entryIndex: 0,
      timestamp: '2026-06-12T10:00:00.000Z',
    };

    const resolved = resolveEvidenceRef(ref, [timeline]);

    expect(resolved?.entryIndex).toBe(0);
    expect(resolved?.entry.summary).toBe('inspect the failing test');
  });

  it('round-trips a tool_use ref with the stable tool id', () => {
    const ref = evidenceRefForEntry(timeline, 1);

    expect(ref).toEqual({
      sessionId: 'session-1',
      entryIndex: 1,
      timestamp: '2026-06-12T10:01:00.000Z',
      toolUseId: 'toolu_123',
    });

    const resolved = resolveEvidenceRef(ref!, [timeline]);

    expect(resolved?.entry.kind).toBe('tool_use');
    expect(resolved?.entry.toolUseId).toBe('toolu_123');
  });

  it('falls back to timestamp and tool id when a stale index points elsewhere', () => {
    const ref: EvidenceRef = {
      sessionId: 'session-1',
      entryIndex: 0,
      timestamp: '2026-06-12T10:02:00.000Z',
      toolUseId: 'toolu_123',
    };

    const resolved = resolveEvidenceRef(ref, [timeline]);

    expect(resolved?.entryIndex).toBe(2);
    expect(resolved?.entry.kind).toBe('tool_result');
  });

  it('still falls back on a stale index when the timestamp is unique and no tool id is present', () => {
    // Preservation guard for #3125: a lone timestamp match is unambiguous, so
    // the fallback must keep resolving it even with no `toolUseId` to confirm.
    const ref: EvidenceRef = {
      sessionId: 'session-1',
      entryIndex: 2,
      timestamp: '2026-06-12T10:00:00.000Z',
    };

    const resolved = resolveEvidenceRef(ref, [timeline]);

    expect(resolved?.entryIndex).toBe(0);
    expect(resolved?.entry.summary).toBe('inspect the failing test');
  });

  it('KNOWN LIMITATION (#3390): a reparse can still shift an in-bounds index onto the wrong same-timestamp sibling', () => {
    // This pins a residual gap deliberately left open, not a passing
    // guarantee. Simulates a reparse where a new content block from the same
    // transcript record (parseSessionTimeline stamps every block in a record
    // with the SAME timestamp) is inserted ahead of the entry the ref was
    // originally created for. The stored entryIndex (0) is still in range
    // and its current occupant matches ref's timestamp, so the indexed fast
    // path accepts it — but it is NOT the entry the ref pointed at; that
    // entry got pushed to index 1. Neither entry carries a toolUseId, so
    // timestamp alone cannot tell them apart.
    //
    // We keep the fast path anyway (see resolveEvidenceRef) because
    // rejecting every in-bounds match this way breaks the far more common
    // case: a FRESH ref minted moments ago by evidenceRefForEntry from the
    // current timeline (see the "fresh ref" test below), which is exactly
    // what SessionTimeline/SessionList mint for every "Entry N" link. Closing
    // this residual misattribution for good needs a stable per-entry
    // identifier (#3390), not a stricter timestamp check.
    const reorderedTimeline: SessionTimeline = {
      sessionId: 'session-reordered',
      startTime: '2026-06-12T10:00:00.000Z',
      endTime: '2026-06-12T10:00:00.000Z',
      entries: [
        {
          timestamp: '2026-06-12T10:00:00.000Z',
          kind: 'assistant',
          summary: 'newly inserted block, not the one the ref pointed at',
        },
        {
          timestamp: '2026-06-12T10:00:00.000Z',
          kind: 'assistant',
          summary: 'the original block the ref was created for',
        },
      ],
    };

    const ref: EvidenceRef = {
      sessionId: 'session-reordered',
      entryIndex: 0,
      timestamp: '2026-06-12T10:00:00.000Z',
    };

    const resolved = resolveEvidenceRef(ref, [reorderedTimeline]);

    // Documents the residual: it resolves, but to the wrong entry.
    expect(resolved?.entryIndex).toBe(0);
    expect(resolved?.entry.summary).toBe(
      'newly inserted block, not the one the ref pointed at'
    );
  });

  it('#3390 (fresh-ref guard): a ref minted just now for a same-timestamp multi-block turn still resolves', () => {
    // SessionTimeline.tsx mints exactly this kind of ref for every "Entry N"
    // link via evidenceRefForEntry(timeline, index) against the CURRENT
    // timeline, and SessionList.tsx requires a successful resolveEvidenceRef
    // before it will focus/scroll to the row. An assistant turn with more
    // than one content block (thinking + text, or text + tool_use) is
    // routine — parseSessionTimeline stamps every block from one record with
    // an identical timestamp — so this must keep working for a same-session,
    // same-timestamp, no-toolUseId neighbour.
    const multiBlockTimeline: SessionTimeline = {
      sessionId: 'session-multiblock',
      startTime: '2026-06-12T10:00:00.000Z',
      endTime: '2026-06-12T10:00:00.000Z',
      entries: [
        {
          timestamp: '2026-06-12T10:00:00.000Z',
          kind: 'thinking',
          summary: 'reasoning about the failing test',
        },
        {
          timestamp: '2026-06-12T10:00:00.000Z',
          kind: 'assistant',
          summary: 'the fix is in evidence.ts',
        },
      ],
    };

    const ref = evidenceRefForEntry(multiBlockTimeline, 1);
    expect(ref).toEqual({
      sessionId: 'session-multiblock',
      entryIndex: 1,
      timestamp: '2026-06-12T10:00:00.000Z',
    });

    const resolved = resolveEvidenceRef(ref!, [multiBlockTimeline]);

    expect(resolved?.entryIndex).toBe(1);
    expect(resolved?.entry.summary).toBe('the fix is in evidence.ts');
  });

  it('#3125: returns null instead of misattributing a stale ref to one of two same-timestamp entries', () => {
    const ambiguousTimeline: SessionTimeline = {
      sessionId: 'session-ambiguous',
      startTime: '2026-06-12T10:00:00.000Z',
      endTime: '2026-06-12T10:00:00.000Z',
      entries: [
        {
          timestamp: '2026-06-12T10:00:00.000Z',
          kind: 'user',
          summary: 'first message at this timestamp',
        },
        {
          timestamp: '2026-06-12T10:00:00.000Z',
          kind: 'user',
          summary: 'second, unrelated message sharing the timestamp',
        },
      ],
    };

    // Stale index: entry 2 no longer exists, so resolution falls through to the
    // timestamp search. Neither entry carries a `toolUseId`, so the timestamp
    // alone cannot tell the two apart — resolving to either would be a
    // confident but unverified claim.
    const ref: EvidenceRef = {
      sessionId: 'session-ambiguous',
      entryIndex: 2,
      timestamp: '2026-06-12T10:00:00.000Z',
    };

    const resolved = resolveEvidenceRef(ref, [ambiguousTimeline]);

    expect(resolved).toBeNull();
  });

  it('#3125: drops an ambiguous ref from batch resolution rather than guessing', () => {
    const ambiguousTimeline: SessionTimeline = {
      sessionId: 'session-ambiguous',
      startTime: '2026-06-12T10:00:00.000Z',
      endTime: '2026-06-12T10:00:00.000Z',
      entries: [
        {
          timestamp: '2026-06-12T10:00:00.000Z',
          kind: 'user',
          summary: 'first message at this timestamp',
        },
        {
          timestamp: '2026-06-12T10:00:00.000Z',
          kind: 'user',
          summary: 'second, unrelated message sharing the timestamp',
        },
      ],
    };

    const refs: EvidenceRef[] = [
      {
        sessionId: 'session-1',
        entryIndex: 0,
        timestamp: '2026-06-12T10:00:00.000Z',
      },
      {
        sessionId: 'session-ambiguous',
        entryIndex: 2,
        timestamp: '2026-06-12T10:00:00.000Z',
      },
    ];

    expect(
      resolveEvidenceRefs(refs, [timeline, ambiguousTimeline]).map(
        (row) => row.timeline.sessionId
      )
    ).toEqual(['session-1']);
  });

  it('drops unresolved refs from batch resolution', () => {
    const refs: EvidenceRef[] = [
      {
        sessionId: 'session-1',
        entryIndex: 0,
        timestamp: '2026-06-12T10:00:00.000Z',
      },
      {
        sessionId: 'missing',
        entryIndex: 0,
        timestamp: '2026-06-12T10:00:00.000Z',
      },
    ];

    expect(resolveEvidenceRefs(refs, [timeline]).map((row) => row.entryIndex)).toEqual([0]);
  });
});
