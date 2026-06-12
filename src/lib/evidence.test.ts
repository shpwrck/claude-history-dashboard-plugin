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
