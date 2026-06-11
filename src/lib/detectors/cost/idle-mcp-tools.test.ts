import { describe, it, expect } from 'vitest';
import { detector } from './idle-mcp-tools';
import { validateRecommendationProvenance } from '../provenance';
import type { RecommendationInput } from '../types';
import type { LiveConfig } from '../../../types';
import type { ToolInventory } from '../../parse-tool-inventory';

const inv = (sessionId: string, available: string[], used: string[]): ToolInventory =>
  ({ sessionId, toolsAvailable: available, toolsUsed: used, unusedTools: [], utilizationPct: 0 });

/** Minimal LiveConfig whose mcpServers carries the given server ids. */
const lc = (serverIds: string[]): LiveConfig =>
  ({ settings: {}, mcpServers: serverIds.map((id) => ({ id, scope: 'global' })) } as unknown as LiveConfig);

const input = (toolInventories?: ToolInventory[], liveConfig: LiveConfig | null = null): RecommendationInput => ({
  tokenData: [], toolData: [], sessions: [], projects: [], permissionRows: [], apiErrors: [],
  liveConfig, toolInventories,
});

const fooLoadedNeverUsed = () => [
  inv('s1', ['mcp__foo__bar', 'Bash'], ['Bash']),
  inv('s2', ['mcp__foo__bar', 'Bash'], ['Bash']),
  inv('s3', ['mcp__foo__bar', 'Bash'], ['Bash']),
];

describe('cost.idle-mcp-tools (#416)', () => {
  it('fires for an MCP tool loaded in 3+ sessions and never used (no config to reconcile)', () => {
    const rec = detector.rule(input(fooLoadedNeverUsed()), 0);
    expect(rec?.id).toBe('cost.idle-mcp-tools');
    expect(rec?.fix?.note).toContain('foo');
  });
  it('ignores used MCP tools and sub-threshold load counts', () => {
    expect(detector.rule(input([
      inv('s1', ['mcp__foo__bar'], ['mcp__foo__bar']),
      inv('s2', ['mcp__foo__bar'], ['mcp__foo__bar']),
      inv('s3', ['mcp__foo__bar'], ['mcp__foo__bar']),
    ]), 0)).toBeNull();
    expect(detector.rule(input([inv('s1', ['mcp__foo__bar'], []), inv('s2', ['mcp__foo__bar'], [])]), 0)).toBeNull();
    expect(detector.rule(input(), 0)).toBeNull();
  });

  // ── Stale-input reconciliation (#1102) ───────────────────────────────────
  it('fires when the idle server is still configured', () => {
    const rec = detector.rule(input(fooLoadedNeverUsed(), lc(['foo'])), 0);
    expect(rec?.id).toBe('cost.idle-mcp-tools');
    expect(rec!.fix?.note).toContain('foo');
    expect(validateRecommendationProvenance(rec!)).toEqual([]);
  });
  it('suppresses when the idle server is already gone from current config', () => {
    expect(detector.rule(input(fooLoadedNeverUsed(), lc(['github'])), 0)).toBeNull();
    expect(detector.rule(input(fooLoadedNeverUsed(), lc([])), 0)).toBeNull();
  });
  it('does not advise removing a server absent from current config (the audited bug)', () => {
    // foo + baz both idle historically, but only foo is still configured.
    const rec = detector.rule(input([
      inv('s1', ['mcp__foo__a', 'mcp__baz__a', 'Bash'], ['Bash']),
      inv('s2', ['mcp__foo__a', 'mcp__baz__a', 'Bash'], ['Bash']),
      inv('s3', ['mcp__foo__a', 'mcp__baz__a', 'Bash'], ['Bash']),
    ], lc(['foo'])), 0);
    expect(rec!.fix?.note).toContain('foo');
    expect(rec!.fix?.note).not.toContain('baz');
  });
});
