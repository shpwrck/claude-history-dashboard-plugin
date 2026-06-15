import { describe, it, expect } from 'vitest';
import { detector } from './settings-json-invalid';
import type { RecommendationInput } from '../types';

const input = (settingsHealth: unknown): RecommendationInput => ({
  tokenData: [], toolData: [], sessions: [], projects: [], permissionRows: [], apiErrors: [],
  liveConfig: { settingsHealth } as unknown as RecommendationInput['liveConfig'],
});

describe('reliability.settings-json-invalid (#417)', () => {
  it('fires when there is an error-severity finding', () => {
    const rec = detector.rule(input({
      filePath: '~/.claude/settings.json', present: true, ok: false,
      findings: [{ kind: 'type', severity: 'error', path: 'model', message: 'expected string' }],
    }), 0);
    expect(rec?.id).toBe('reliability.settings-json-invalid');
    expect(rec?.affected).toBe(1);
    expect(rec?.fix?.target).toBe('command');
    expect(rec?.fix?.snippet).toBe(
      'python3 -m json.tool ~/.claude/settings.json'
    );
  });
  it('stays silent when absent, ok, or only warnings', () => {
    expect(detector.rule(input({ present: false, ok: true, findings: [] }), 0)).toBeNull();
    expect(detector.rule(input({ present: true, ok: true, findings: [] }), 0)).toBeNull();
    expect(detector.rule(input({ present: true, ok: false, findings: [{ kind: 'unknown-key', severity: 'warning', path: 'x', message: 'm' }] }), 0)).toBeNull();
    expect(detector.rule(input(null), 0)).toBeNull();
  });
});
