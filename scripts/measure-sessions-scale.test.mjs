// Guards the corpus scaling used by the #3287 large-history benchmark
// (scripts/measure-sessions-scale.mjs). The benchmark's numbers are only
// meaningful if the scaled corpus actually contains `target` DISTINCT
// sessions: a clone whose transcript still carries its source session id
// could collapse into the source at parse time, silently measuring a smaller
// history under the larger scale's name.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { scaledCorpus } from './measure-sessions-scale.mjs';

describe('scaledCorpus', () => {
  it('returns the base corpus untouched when the target is not larger', () => {
    const base = scaledCorpus(1);
    // The deterministic sample corpus has 18 sessions; a smaller target never
    // truncates below it (the benchmark's smallest scale IS the base corpus).
    assert.equal(base.sessions.length, 18);
    const ids = new Set(base.sessions.map((s) => s.sessionId));
    assert.equal(ids.size, 18);
  });

  it('scales to the target with unique, fully-rewritten session ids', () => {
    const corpus = scaledCorpus(50);
    assert.equal(corpus.sessions.length, 50);

    const ids = new Set(corpus.sessions.map((s) => s.sessionId));
    assert.equal(ids.size, 50, 'every session id is unique');

    const base = scaledCorpus(1);
    const baseById = new Map(base.sessions.map((s) => [s.sessionId, s]));
    for (const s of corpus.sessions) {
      if (baseById.has(s.sessionId)) continue; // a base session, not a clone
      const srcId = s.sessionId.replace(/-x\d+$/, '');
      const src = baseById.get(srcId);
      assert.ok(src, `clone ${s.sessionId} maps back to a base session`);
      // Clone provenance: same project/slug, transcript carries the new id...
      assert.equal(s.project, src.project);
      assert.equal(s.slug, src.slug);
      assert.ok(s.jsonl.includes(s.sessionId));
      // ...and NO residual source-id occurrence outside the new id itself
      // (the new id contains the source id as a prefix, so strip the new id
      // first, then look for leftovers).
      assert.ok(
        !s.jsonl.split(s.sessionId).join('').includes(srcId),
        `clone ${s.sessionId} has no residual source session id`
      );
    }
  });

  it('is deterministic', () => {
    const a = scaledCorpus(40);
    const b = scaledCorpus(40);
    assert.deepEqual(
      a.sessions.map((s) => [s.sessionId, s.jsonl]),
      b.sessions.map((s) => [s.sessionId, s.jsonl])
    );
    assert.equal(a.historyJsonl, b.historyJsonl);
  });
});
