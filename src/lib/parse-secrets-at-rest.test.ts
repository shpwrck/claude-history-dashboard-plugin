import { describe, it, expect } from 'vitest';
import { parseSecretsAtRest } from './parse-secrets-at-rest';
import { parseSessionTimeline } from './parse-timeline';
import { resolveEvidenceRef } from './evidence';

// Synthetic, obviously-fake credentials that still match the shared
// SECRET_PATTERNS. NONE of these is a live secret — they are shape-only decoys.
const FAKE_ANTHROPIC = 'sk-ant-api03-FAKEfakeFAKE1234567890abcdefZZ';
const FAKE_AWS = 'AKIAIOSFODNN7EXAMPLE'; // AWS's own documentation example id
// A high-entropy but BENIGN string: a 40-hex git commit SHA. Must NOT fire —
// it matches none of the shape-anchored SECRET_PATTERNS.
const GIT_SHA = '9f83a1c7b2e4d6f8a0c1e3b5d7f9a1c3e5b7d9f1';

/** Build a `.jsonl` transcript string from raw entry objects. */
function transcript(entries: unknown[]): string {
  return entries.map((e) => JSON.stringify(e)).join('\n');
}

function userText(text: string, timestamp = '2026-07-01T00:00:00.000Z') {
  return { type: 'user', timestamp, message: { role: 'user', content: text } };
}

function toolResult(
  content: unknown,
  toolUseResult: unknown,
  timestamp = '2026-07-02T00:00:00.000Z',
  toolUseId = 'tool-1'
) {
  return {
    type: 'user',
    timestamp,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content }],
    },
    toolUseResult,
  };
}

describe('parseSecretsAtRest', () => {
  it('fires on a secret-shaped value pasted into a user prompt', () => {
    const sig = parseSecretsAtRest(
      transcript([userText(`use my key ${FAKE_ANTHROPIC} to call the API`)]),
      'sess-a.jsonl'
    );
    expect(sig).not.toBeNull();
    expect(sig!.sessionId).toBe('sess-a');
    expect(sig!.totalCount).toBe(1);
    expect(sig!.countsByKind).toEqual({ 'anthropic-key': 1 });
    expect(sig!.evidenceRefs).toHaveLength(1);
    expect(sig!.evidenceRefs[0]).toMatchObject({
      sessionId: 'sess-a',
      entryIndex: 0,
      timestamp: '2026-07-01T00:00:00.000Z',
    });
    expect(sig!.lastObserved).toBe('2026-07-01T00:00:00.000Z');
  });

  it('fires on a secret in a tool_result payload and carries the toolUseId coord', () => {
    const sig = parseSecretsAtRest(
      transcript([
        toolResult(
          `AWS_ACCESS_KEY_ID=${FAKE_AWS}`,
          { stdout: `AWS_ACCESS_KEY_ID=${FAKE_AWS}` },
          '2026-07-02T00:00:00.000Z',
          'tool-xyz'
        ),
      ]),
      'sess-b.jsonl'
    );
    expect(sig).not.toBeNull();
    // The SAME key appears in both the tool_result block AND its sibling
    // toolUseResult of the SAME entry — it is ONE at-rest secret, counted once.
    expect(sig!.totalCount).toBe(1);
    expect(sig!.countsByKind).toEqual({ 'aws-access-key-id': 1 });
    expect(sig!.evidenceRefs[0].toolUseId).toBe('tool-xyz');
  });

  it('counts the same value in DIFFERENT entries as separate at-rest locations', () => {
    const sig = parseSecretsAtRest(
      transcript([
        userText(`key ${FAKE_ANTHROPIC}`, '2026-07-01T00:00:00.000Z'),
        userText(`same key again ${FAKE_ANTHROPIC}`, '2026-07-03T00:00:00.000Z'),
      ]),
      'sess-c.jsonl'
    );
    expect(sig!.totalCount).toBe(2);
    expect(sig!.countsByKind).toEqual({ 'anthropic-key': 2 });
    expect(sig!.evidenceRefs).toHaveLength(2);
    // lastObserved tracks the NEWEST matched entry.
    expect(sig!.lastObserved).toBe('2026-07-03T00:00:00.000Z');
  });

  it('does NOT fire on a high-entropy-but-benign git SHA (false-positive guard)', () => {
    const sig = parseSecretsAtRest(
      transcript([
        userText(`merged at commit ${GIT_SHA}`),
        toolResult(`HEAD is ${GIT_SHA}`, { stdout: `HEAD is ${GIT_SHA}` }),
      ]),
      'sess-d.jsonl'
    );
    expect(sig).toBeNull();
  });

  it('returns null when the session has no secret-shaped values at all', () => {
    const sig = parseSecretsAtRest(
      transcript([userText('just a normal prompt with no secrets')]),
      'sess-e.jsonl'
    );
    expect(sig).toBeNull();
  });

  it('labels sk-ant- keys as anthropic-key, not the looser openai-key (first-pattern-wins)', () => {
    const sig = parseSecretsAtRest(
      transcript([userText(`token ${FAKE_ANTHROPIC}`)]),
      'sess-f.jsonl'
    );
    // Sequential masking mirrors scrubSecrets: the value is labelled once.
    expect(Object.keys(sig!.countsByKind)).toEqual(['anthropic-key']);
    expect(sig!.totalCount).toBe(1);
  });

  it('SECURITY: the matched value never appears in the emitted signal JSON', () => {
    const sig = parseSecretsAtRest(
      transcript([
        userText(`prompt with ${FAKE_ANTHROPIC}`),
        toolResult(
          `AWS_ACCESS_KEY_ID=${FAKE_AWS}`,
          { stdout: `dump ${FAKE_AWS}` }
        ),
      ]),
      'sess-g.jsonl'
    );
    expect(sig).not.toBeNull();
    const json = JSON.stringify(sig);
    // The load-bearing security invariant: only counts + coordinates persist.
    expect(json).not.toContain(FAKE_ANTHROPIC);
    expect(json).not.toContain(FAKE_AWS);
    // A partial value fragment must not leak either.
    expect(json).not.toContain('sk-ant-');
    expect(json).not.toContain('AKIA');
  });

  it('#3390: stamps an entryId that resolves to the block that carried the secret', () => {
    // This parser builds refs BY HAND, and its `entryIndex` is a RECORD index,
    // not a timeline-entry index — so it points at the wrong entry the moment
    // one record yields more than one entry. Here the second record yields two
    // text entries; the secret is in the SECOND. The ref's entryIndex (1) lands
    // on the first, whose timestamp matches (one record, one timestamp) and
    // which carries no toolUseId to contradict it — so the pre-#3390 rules
    // resolved this ref to the wrong block, confidently. The entryId names the
    // matched block of the matched RECORD outright, and keeps naming it when
    // the subagent merge splices other records in ahead of it.
    const text = transcript([
      userText('starting the run', '2026-07-01T00:00:00.000Z'),
      {
        type: 'user',
        uuid: 'rec-multi',
        timestamp: '2026-07-01T00:00:01.000Z',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'a plain note with nothing in it' },
            { type: 'text', text: `and my key is ${FAKE_ANTHROPIC}` },
          ],
        },
      },
    ]);

    const sig = parseSecretsAtRest(text, 'sess-h.jsonl');
    expect(sig!.evidenceRefs).toHaveLength(1);
    expect(sig!.evidenceRefs[0].entryId).toBe('rec-multi:1');
    expect(sig!.evidenceRefs[0].toolUseId).toBeUndefined();

    const timeline = parseSessionTimeline(text, 'sess-h.jsonl');
    const resolved = resolveEvidenceRef(sig!.evidenceRefs[0], [timeline]);
    // Entry 2 is record 1's SECOND text block; entry 1 is its same-timestamp
    // sibling that the record-index ref used to land on.
    expect(resolved?.entryIndex).toBe(2);
    expect(resolved?.entry.summary).toContain('and my key is');
  });

  it('#3390: attributes a toolUseResult-only secret to its sibling tool_result block', () => {
    // The structured `toolUseResult` payload has no content block of its own;
    // it is the twin of the tool_result block, so the ref must name that block
    // rather than defaulting to block 0 (the text block here). The old rules
    // happened to land right on this one — but only because a toolUseId was
    // present to disambiguate; the id makes it exact without that crutch.
    const text = transcript([
      {
        type: 'user',
        uuid: 'rec-twin',
        timestamp: '2026-07-01T00:00:00.000Z',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'echo output follows' },
            { type: 'tool_result', tool_use_id: 'tool-4', content: 'redacted by the tool' },
          ],
        },
        toolUseResult: { stdout: `AWS_ACCESS_KEY_ID=${FAKE_AWS}` },
      },
    ]);

    const sig = parseSecretsAtRest(text, 'sess-i.jsonl');
    expect(sig!.evidenceRefs[0].entryId).toBe('rec-twin:1');

    const timeline = parseSessionTimeline(text, 'sess-i.jsonl');
    expect(resolveEvidenceRef(sig!.evidenceRefs[0], [timeline])?.entry.kind).toBe(
      'tool_result'
    );
  });
});
