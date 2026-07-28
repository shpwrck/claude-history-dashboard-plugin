import { describe, expect, it } from 'vitest';
import {
  evidenceRefForEntry,
  resolveEvidenceRef,
  resolveEvidenceRefs,
  type EvidenceRef,
} from './evidence';
import { parseSessionTimeline, type SessionTimeline } from './parse-timeline';

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

  it('#3390: an entryId ref follows its entry when records are spliced in ahead of it', () => {
    // Was a KNOWN LIMITATION pin, then very nearly a worse bug. The ref carries
    // the id the target had BEFORE the reparse — which is the only thing a
    // stored ref can carry — and the reparse splices a record in ahead of it.
    // An id built from array position gets REASSIGNED to the new occupant here,
    // so the ref would resolve confidently to the wrong entry; keying the id to
    // the record's own uuid is what makes the ref follow its entry. Assigning
    // the ref the target's POST-insertion id would assert only that resolution
    // works when nothing moved, which is not the property under test.
    const refIdMintedBeforeTheEdit = 'rec-target:0';

    const reparsedTimeline: SessionTimeline = {
      sessionId: 'session-reordered',
      startTime: '2026-06-12T10:00:00.000Z',
      endTime: '2026-06-12T10:00:00.000Z',
      entries: [
        {
          entryId: 'rec-spliced:0',
          timestamp: '2026-06-12T10:00:00.000Z',
          kind: 'assistant',
          summary: 'merged-in subagent record, not the one the ref pointed at',
        },
        {
          entryId: refIdMintedBeforeTheEdit,
          timestamp: '2026-06-12T10:00:00.000Z',
          kind: 'assistant',
          summary: 'the entry the ref was created for',
        },
      ],
    };

    const ref: EvidenceRef = {
      sessionId: 'session-reordered',
      // Stale: the target sat at index 0 when the ref was minted.
      entryIndex: 0,
      timestamp: '2026-06-12T10:00:00.000Z',
      entryId: refIdMintedBeforeTheEdit,
    };

    const resolved = resolveEvidenceRef(ref, [reparsedTimeline]);

    expect(resolved?.entryIndex).toBe(1);
    expect(resolved?.entry.summary).toBe('the entry the ref was created for');
  });

  it('#3390: end-to-end — a ref survives the subagent merge splicing records in ahead of it', () => {
    // The scenario that actually occurs: readMergedSession concatenates
    // subagents/*.jsonl in LEXICAL filename order over random hex names, so a
    // late-created subagent lands EARLY in the merged blob and displaces every
    // record after it. Built through the real parser so the ref is minted the
    // way production mints it, from the pre-merge parse.
    const targetLine = JSON.stringify({
      type: 'user',
      uuid: 'rec-target',
      timestamp: '2026-06-12T10:00:05.000Z',
      message: { role: 'user', content: 'the entry a ref points at' },
    });
    const splicedLine = JSON.stringify({
      type: 'user',
      uuid: 'rec-spliced',
      timestamp: '2026-06-12T10:00:01.000Z',
      message: { role: 'user', content: 'a later subagent that sorts earlier' },
    });

    const beforeMerge = parseSessionTimeline(targetLine, 'session-merge.jsonl');
    const ref = evidenceRefForEntry(beforeMerge, 0)!;
    expect(ref.entryId).toBe('rec-target:0');

    const afterMerge = parseSessionTimeline(
      [splicedLine, targetLine].join('\n'),
      'session-merge.jsonl'
    );
    const resolved = resolveEvidenceRef(ref, [afterMerge]);

    expect(resolved?.entry.summary).toBe('the entry a ref points at');
    expect(resolved?.entryIndex).toBe(1);
  });

  it('#3390 RESIDUAL (not a regression): a block inserted INSIDE one record still shifts its siblings', () => {
    // Honest pin of what uuid keying does NOT fix. `blockIndex` is still a
    // position, so inserting a block ahead of the target WITHIN one record
    // reassigns the target's id to its new neighbour and this resolves to the
    // wrong sibling.
    //
    // Why it is nonetheless acceptable: (1) it is exactly what master does
    // today — the pre-#3390 KNOWN LIMITATION documented this same
    // misresolution — so nothing regresses; (2) it requires REWRITING an
    // existing transcript line, unlike the record splice, which happens on
    // every merge; (3) it is unobservable in the measured corpus, where all
    // 7746 array-content records carry exactly ONE block.
    // The fix, if multi-block records ever appear, is to make the block
    // component content-derived (a hash) — NOT to corroborate the id against a
    // timestamp, which would make identity a second opinion that can disagree.
    const line = (blocks: unknown[]) =>
      JSON.stringify({
        type: 'assistant',
        uuid: 'rec-rewritten',
        timestamp: '2026-06-12T10:00:00.000Z',
        message: { role: 'assistant', content: blocks },
      });

    const before = parseSessionTimeline(
      line([{ type: 'text', text: 'the entry the ref points at' }]),
      'session-rewrite.jsonl'
    );
    const ref = evidenceRefForEntry(before, 0)!;
    expect(ref.entryId).toBe('rec-rewritten:0');

    const after = parseSessionTimeline(
      line([
        { type: 'text', text: 'a block inserted ahead of it' },
        { type: 'text', text: 'the entry the ref points at' },
      ]),
      'session-rewrite.jsonl'
    );

    // Documents the residual: it resolves, but to the inserted sibling.
    expect(resolveEvidenceRef(ref, [after])?.entry.summary).toBe(
      'a block inserted ahead of it'
    );
  });

  it('#3390: a set-but-unmatched entryId fails closed instead of falling back to the timestamp', () => {
    // The transcript was edited/rewritten since the ref was minted, so `9:0` is
    // gone. Every remaining entry shares the ref's timestamp — the pre-#3390
    // rules would have handed back entry 0 (in-bounds index, matching
    // timestamp). Falling back there would resolve the ref to an entry it was
    // never written against: the exact misattribution entryId exists to remove.
    const editedTimeline: SessionTimeline = {
      sessionId: 'session-edited',
      startTime: '2026-06-12T10:00:00.000Z',
      endTime: '2026-06-12T10:00:00.000Z',
      entries: [
        {
          entryId: 'rec-a:0',
          timestamp: '2026-06-12T10:00:00.000Z',
          kind: 'assistant',
          summary: 'an unrelated entry that merely shares the timestamp',
        },
      ],
    };

    const ref: EvidenceRef = {
      sessionId: 'session-edited',
      entryIndex: 0,
      timestamp: '2026-06-12T10:00:00.000Z',
      entryId: 'rec-vanished:0',
    };

    expect(resolveEvidenceRef(ref, [editedTimeline])).toBeNull();
  });

  it('#3390: identity is dispositive — a stale index and timestamp never override it', () => {
    // Both corroborating signals disagree with the identity: the stored index
    // points at a different entry and the stored timestamp belongs to that
    // other entry. The ref still resolves to the entry it names, with no
    // reconciliation between the three.
    const timelineWithIds: SessionTimeline = {
      sessionId: 'session-ids',
      startTime: '2026-06-12T10:00:00.000Z',
      endTime: '2026-06-12T10:05:00.000Z',
      entries: [
        {
          entryId: 'rec-c:0',
          timestamp: '2026-06-12T10:00:00.000Z',
          kind: 'user',
          summary: 'the entry the stale index and timestamp point at',
        },
        {
          entryId: 'rec-d:2',
          timestamp: '2026-06-12T10:05:00.000Z',
          kind: 'assistant',
          summary: 'the entry the ref was written against',
        },
      ],
    };

    const ref: EvidenceRef = {
      sessionId: 'session-ids',
      entryIndex: 0,
      timestamp: '2026-06-12T10:00:00.000Z',
      entryId: 'rec-d:2',
    };

    const resolved = resolveEvidenceRef(ref, [timelineWithIds]);

    expect(resolved?.entryIndex).toBe(1);
    expect(resolved?.entry.summary).toBe('the entry the ref was written against');
  });

  it('#3390: evidenceRefForEntry carries entryId through a round trip', () => {
    const identityTimeline: SessionTimeline = {
      sessionId: 'session-roundtrip',
      startTime: '2026-06-12T10:00:00.000Z',
      endTime: '2026-06-12T10:00:00.000Z',
      entries: [
        {
          entryId: 'rec-e:0',
          timestamp: '2026-06-12T10:00:00.000Z',
          kind: 'thinking',
          summary: 'reasoning',
        },
        {
          entryId: 'rec-e:1',
          timestamp: '2026-06-12T10:00:00.000Z',
          kind: 'assistant',
          summary: 'the answer',
        },
      ],
    };

    const ref = evidenceRefForEntry(identityTimeline, 1);

    expect(ref).toEqual({
      sessionId: 'session-roundtrip',
      entryIndex: 1,
      timestamp: '2026-06-12T10:00:00.000Z',
      entryId: 'rec-e:1',
    });

    expect(resolveEvidenceRef(ref!, [identityTimeline])?.entry.summary).toBe('the answer');
  });

  it('#3390: duplicate entryIds fail closed rather than resolving to the first', () => {
    // A single parse cannot emit two entries with the same
    // `${uuid}:${blockIndex}`, so a duplicate means the entry array is
    // not one parse and the id identifies nothing. Guessing "the first" would
    // be a confident unverified claim (#3125).
    const mergedTimeline: SessionTimeline = {
      sessionId: 'session-merged',
      startTime: '2026-06-12T10:00:00.000Z',
      endTime: '2026-06-12T10:00:00.000Z',
      entries: [
        {
          entryId: 'rec-dup:0',
          timestamp: '2026-06-12T10:00:00.000Z',
          kind: 'user',
          summary: 'from transcript A',
        },
        {
          entryId: 'rec-dup:0',
          timestamp: '2026-06-12T10:01:00.000Z',
          kind: 'user',
          summary: 'from transcript B',
        },
      ],
    };

    const ref: EvidenceRef = {
      sessionId: 'session-merged',
      entryIndex: 0,
      timestamp: '2026-06-12T10:00:00.000Z',
      entryId: 'rec-dup:0',
    };

    expect(resolveEvidenceRef(ref, [mergedTimeline])).toBeNull();
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
