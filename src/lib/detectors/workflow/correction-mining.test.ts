/**
 * Tests for workflow.correction-mining (#1040).
 *
 * Synthetic failed→succeeded tool sequences (the acceptance fixture): the
 * detector emits at least the file-path-correction category with evidence rows,
 * carries a marker-bearing CLAUDE.md fix, stays silent with no corrections, and
 * suppresses when the user has already written the facts down.
 */
import { describe, it, expect } from 'vitest';
import { detector } from './correction-mining';
import type { RecommendationInput } from '../types';
import type { ToolCall, ToolUsageData } from '../../parse-tools';
import type { LiveConfig } from '../../../types';

const call = (over: Partial<ToolCall>): ToolCall => ({
  timestamp: 't', toolName: 'Bash', input: {}, toolUseId: 'u', isError: null, resultBytes: 0, ...over,
});
const read = (file_path: string, isError: boolean | null): ToolCall =>
  call({ toolName: 'Read', input: { file_path }, isError });
const bash = (command: string, isError: boolean | null): ToolCall =>
  call({ toolName: 'Bash', input: { command }, isError });
const session = (sessionId: string, calls: ToolCall[]): ToolUsageData => ({ sessionId, calls });

const input = (toolData: ToolUsageData[], liveConfig: LiveConfig | null = null): RecommendationInput => ({
  tokenData: [], toolData, sessions: [], projects: [], permissionRows: [], apiErrors: [], liveConfig,
});

const pathFix = () => [session('s1', [
  read('axion-formats/src/FirstClassEntity.java', true),
  read('axion-scala-common/src/FirstClassEntity.scala', false),
])];

describe('workflow.correction-mining (#1040)', () => {
  it('fires on a file-path correction with a failed→succeeded evidence row', () => {
    const rec = detector.rule(input(pathFix()), 0)!;
    expect(rec.id).toBe('workflow.correction-mining');
    expect(rec.category).toBe('workflow');
    expect(rec.affected).toBe(1);
    expect(rec.evidence![0]).toMatch(/Read: .*FirstClassEntity\.java → .*FirstClassEntity\.scala/);
  });

  it('ships a marker-bearing CLAUDE.md fix (adoption/suppression can track it)', () => {
    const rec = detector.rule(input(pathFix()), 0)!;
    expect(rec.fix?.target).toBe('CLAUDE.md');
    expect(rec.fix?.appliedMarkers?.headings?.length).toBeGreaterThan(0);
    expect(rec.fix?.snippet).toContain('FirstClassEntity.scala');
  });

  it('does not fire on command-only sequences (command category deferred)', () => {
    expect(detector.rule(input([session('s', [
      bash('python3 run.py', true),
      bash('uv run python run.py', false),
    ])]), 0)).toBeNull();
  });

  it('stays silent when there are no corrections', () => {
    // different stems → no pairing; generic stem → no pairing
    expect(detector.rule(input([session('s', [read('Widget.ts', true), read('Gadget.ts', false)])]), 0)).toBeNull();
    expect(detector.rule(input([session('s', [read('pkgA/index.ts', true), read('pkgB/index.ts', false)])]), 0)).toBeNull();
    expect(detector.rule(input([]), 0)).toBeNull();
  });

  it('suppresses when CLAUDE.md already records the corrections', () => {
    const lc = {
      settings: {}, mcpServers: [],
      claudeMd: { global: '## Known paths & gotchas\n\nThese are not the first place the agent looked.' },
    } as unknown as LiveConfig;
    expect(detector.rule(input(pathFix(), lc), 0)).toBeNull();
  });
});
