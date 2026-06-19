import { describe, it, expect } from 'vitest';
import { classifyClaudePath, isSessionData } from './claude-tree-classification';
// The shipper (a zero-dep .mjs in the dispatch image) mirrors the classifier byte-for-byte; this is
// the load-bearing DRIFT GUARD that the two copies never diverge.
import { classifyClaudePath as shipperClassify } from '../../probaitio-operator/dispatch/artifact-ship.mjs';

describe('claude-tree-classification', () => {
  it('classifies session-data (the shipper allowlist)', () => {
    expect(classifyClaudePath('projects/-workspace/abc-uuid.jsonl')).toBe('session-data');
    expect(classifyClaudePath('projects/-workspace/abc-uuid/subagents/x.jsonl')).toBe('session-data');
    expect(classifyClaudePath('history.jsonl')).toBe('session-data');
    expect(classifyClaudePath('history.d/abc-uuid.jsonl')).toBe('session-data');
    expect(classifyClaudePath('telemetry/2026-06-15.jsonl')).toBe('session-data');
    expect(classifyClaudePath('debug/run.log')).toBe('session-data');
    expect(classifyClaudePath('stats-cache.json')).toBe('session-data');
    expect(classifyClaudePath('file-history/x.json')).toBe('session-data');
    expect(classifyClaudePath('todos/t.json')).toBe('session-data');
    expect(isSessionData('projects/p/s.jsonl')).toBe(true);
  });

  it('classifies secret (never shipped/accepted) — checked first', () => {
    expect(classifyClaudePath('.credentials.json')).toBe('secret');
    expect(classifyClaudePath('.credentials')).toBe('secret');
    expect(classifyClaudePath('paste-cache/blob')).toBe('secret');
    expect(classifyClaudePath('.ssh/id_rsa')).toBe('secret');
    expect(classifyClaudePath('keys/server.pem')).toBe('secret');
    expect(isSessionData('.credentials.json')).toBe(false);
  });

  it('classifies config (the bake; never shipped)', () => {
    expect(classifyClaudePath('settings.json')).toBe('config');
    expect(classifyClaudePath('.claude.json')).toBe('config');
    expect(classifyClaudePath('CLAUDE.md')).toBe('config');
    expect(classifyClaudePath('agents/foo.md')).toBe('config');
    expect(classifyClaudePath('commands/bar.md')).toBe('config');
  });

  it('normalizes leading ./, backslashes, trailing slash', () => {
    expect(classifyClaudePath('./projects/p/')).toBe('session-data');
    expect(classifyClaudePath('projects\\p\\s.jsonl')).toBe('session-data');
  });

  it('the shipper mirror never drifts from the TS canonical', () => {
    const fixtures = [
      'projects/-workspace/abc.jsonl',
      'history.jsonl',
      'history.d/x.jsonl',
      'telemetry/t.jsonl',
      'stats-cache.json',
      'todos/t.json',
      '.credentials.json',
      'paste-cache/blob',
      '.ssh/id_rsa',
      'keys/x.pem',
      'settings.json',
      '.claude.json',
      'agents/a.md',
      './projects/p/',
    ];
    for (const f of fixtures) {
      expect(shipperClassify(f)).toBe(classifyClaudePath(f));
    }
  });
});
