// Coverage guard for the SPA demo's Memories + Workflows sample data (#537).
//
// These two views can't ride the upload zip, so they're injected from dedicated
// sample modules and run through the REAL parsers (`parseMemories`,
// `parseWorkflows`) in App.tsx exactly like the server build. This suite asserts
// the sample fixtures survive those parsers non-empty, so a parser shape change
// that would silently blank the demo fails loudly here — the same contract
// `sample-corpus.test.ts` enforces for the zip-borne sections.

import { describe, it, expect } from 'vitest';
import { parseMemories } from './parse-memories';
import { parseWorkflows } from './parse-workflows';
import { sampleMemories } from './sample-memories';
import { buildSampleWorkflows } from './sample-workflows';

describe('sample memories (#537)', () => {
  const parsed = parseMemories(sampleMemories);

  it('parses into multiple projects, each with memories', () => {
    expect(parsed.length).toBeGreaterThanOrEqual(3);
    expect(parsed.every((p) => p.memories.length > 0)).toBe(true);
  });

  it('parses frontmatter — names, descriptions, and known types survive', () => {
    const all = parsed.flatMap((p) => p.memories);
    expect(all.length).toBeGreaterThan(4);
    expect(all.every((m) => m.name.length > 0)).toBe(true);
    expect(all.every((m) => m.description.length > 0)).toBe(true);
    // Frontmatter `metadata.type` resolved to a known category (not the
    // `'other'` fallback that signals a parse miss).
    expect(all.some((m) => m.type === 'project')).toBe(true);
    expect(all.some((m) => m.type === 'feedback')).toBe(true);
    expect(all.every((m) => m.type !== 'other')).toBe(true);
  });
});

describe('sample workflows (#537)', () => {
  const sessionIds = ['20260512-1000-feat-sample', '20260513-1001-cont-sample', '20260514-1002-roug-sample'];
  const parsed = parseWorkflows(buildSampleWorkflows(sessionIds));

  it('parses multiple runs (incl. an aborted one for #669), newest-first', () => {
    expect(parsed.length).toBeGreaterThanOrEqual(3);
    // Most runs complete, but the demo also carries an aborted run so the
    // workflow-health detectors (#635/#669) have something to fire on.
    expect(parsed.some((r) => r.status === 'completed')).toBe(true);
    expect(parsed.some((r) => r.status !== 'completed')).toBe(true);
    for (let i = 1; i < parsed.length; i++) {
      expect((parsed[i - 1].startTime ?? 0) >= (parsed[i].startTime ?? 0)).toBe(true);
    }
  });

  it('runs carry agents with phases and metrics', () => {
    expect(parsed.every((r) => r.agents.length > 0)).toBe(true);
    expect(parsed.every((r) => r.phases.length > 0)).toBe(true);
    const agents = parsed.flatMap((r) => r.agents);
    expect(agents.some((a) => (a.tokens ?? 0) > 0)).toBe(true);
    expect(agents.some((a) => (a.phaseTitle ?? '').length > 0)).toBe(true);
  });

  it('binds each run to a provided sample session id', () => {
    expect(parsed.every((r) => sessionIds.includes(r.sessionId))).toBe(true);
  });

  it('tolerates an empty session-id list', () => {
    const none = parseWorkflows(buildSampleWorkflows([]));
    expect(none.length).toBeGreaterThanOrEqual(3);
    expect(none.every((r) => r.sessionId === '')).toBe(true);
  });
});
