/**
 * Behavioral tests for safety.prompt-friction (#75), focused on the v0.6 audit
 * finding #3223: when the dominant prompt-prone tool was not Bash the detector
 * emitted `{"permissions":{"allow":["<ToolName>"]}}` — a bare, unscoped grant.
 * The evidence behind this recommendation establishes prompt FREQUENCY only, so
 * that snippet blanket-authorized whatever the tool can do: arbitrary writes
 * (Write/Edit/NotebookEdit), network egress (WebFetch/WebSearch), or an entire
 * `mcp__*` server.
 *
 * The contract asserted here: aggregate prompt frequency never produces an
 * allow snippet. Even command-prefixed Bash wildcards can admit redirection,
 * output paths, or other unobserved effects, so every dominant tool remains a
 * manual-analysis finding until operation-level safety evidence exists.
 */
import { describe, it, expect } from 'vitest';
import { detector } from './prompt-friction';
import { validateRecommendationProvenance } from '../provenance';
import type { RecommendationInput } from '../types';
import type { ToolUsageData } from '../../parse-tools-types';

// ── Fixtures ───────────────────────────────────────────────────────────────

/** `n` prompt-eligible calls of `toolName` in one `default`-mode session. */
function dominatedBy(toolName: string, n = 40): RecommendationInput {
  const calls = Array.from({ length: n }, (_, i) => ({
    timestamp: `2026-07-0${(i % 9) + 1}T10:00:00.000Z`,
    toolName,
    input: {},
    toolUseId: `t${i}`,
    isError: null,
    resultBytes: 0,
  })) as unknown as ToolUsageData['calls'];

  return {
    tokenData: [],
    toolData: [{ sessionId: 's1', calls }],
    sessions: [],
    projects: [],
    permissionRows: [{ mode: 'default', sessionId: 's1' }],
    apiErrors: [],
    liveConfig: null,
  } as unknown as RecommendationInput;
}

// ── Aggregate frequency must never become an automatic permission grant ────

describe('safety.prompt-friction operation-level safety (#3224)', () => {
  it('emits no fix when Bash dominates aggregate prompt frequency', () => {
    const rec = detector.rule(dominatedBy('Bash'), 0);
    expect(rec?.id).toBe('safety.prompt-friction');
    expect(rec?.fix).toBeUndefined();
    expect(rec?.fixes).toBeUndefined();
    expect(rec?.action).toMatch(/frequency.*not safety/i);
    expect(JSON.stringify(rec)).not.toContain('"allow"');
  });

  it('cites the promptable numerator, denominator, and sessions without claiming a safe rule derivation', () => {
    const input = dominatedBy('Bash');
    const calls = input.toolData[0].calls;
    calls.push(
      ...Array.from({ length: 10 }, (_, i) => ({
        timestamp: `2026-07-09T11:00:${String(i).padStart(2, '0')}.000Z`,
        toolName: 'Write',
        input: { file_path: `f${i}.ts` },
        toolUseId: `w${i}`,
        isError: null,
        resultBytes: 0,
      }))
    );

    const rec = detector.rule(input, 0)!;

    expect(validateRecommendationProvenance(rec)).toEqual([]);
    expect(rec.provenance?.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'rankPromptProneTools().promptableCalls',
          value: 40,
        }),
        expect.objectContaining({
          field: 'rankPromptProneTools()[].promptableCalls',
          value: 50,
        }),
        expect.objectContaining({
          field: 'rankPromptProneTools().sessionCount',
          value: 1,
        }),
      ])
    );
    expect(rec.provenance?.derivations).toContainEqual({
      id: 'promptable-share-percent',
      formula: '(promptableCalls / totalPromptableCalls) * 100',
      operands: { promptableCalls: 40, totalPromptableCalls: 50 },
      value: 80,
    });
    expect(rec.provenance?.inference).toMatch(/frequency.*not.*safety/i);
    expect(JSON.stringify(rec.provenance)).not.toContain('BASH_SAFE_ALLOW_RULES');
  });
});

// ── Every other prompt-prone tool must also remain manual ───────────────────

describe('safety.prompt-friction non-Bash tools (#3223)', () => {
  const privileged = [
    'Write', // arbitrary file writes
    'Edit', // arbitrary file writes
    'NotebookEdit', // arbitrary file writes
    'WebFetch', // network egress
    'WebSearch', // network egress
    'mcp__github__create_pull_request', // arbitrary MCP server capability
    'SomeToolNobodyHasReviewed', // unknown
    'constructor', // prototype-key adversarial name
  ];

  it.each(privileged)('emits no permissions.allow snippet for %s', (toolName) => {
    const rec = detector.rule(dominatedBy(toolName), 0);
    // The finding still surfaces — the friction is real…
    expect(rec?.id).toBe('safety.prompt-friction');
    expect(rec?.detail).toContain(toolName);
    // …but there is no fix to copy, so nothing can be blanket-authorized.
    expect(rec?.fix).toBeUndefined();
    expect(rec?.fixes).toBeUndefined();
    // Belt and braces: the whole recommendation must not contain an allow grant
    // for the bare tool name anywhere.
    expect(JSON.stringify(rec)).not.toContain(`"allow"`);
  });

  it('tells the user to scope the rule themselves instead of allowlisting the tool', () => {
    const rec = detector.rule(dominatedBy('Write'), 0);
    expect(rec!.action).toContain('Write');
    expect(rec!.action.toLowerCase()).toContain('scope');
    // It must not claim frequency implies safety.
    expect(rec!.action).toMatch(/frequency/i);
  });

  it('still self-suppresses when the bare tool is already allowed', () => {
    const input = dominatedBy('Write');
    (input as { liveConfig: unknown }).liveConfig = {
      settings: { permissions: { allow: ['Write'] } },
    };
    expect(detector.rule(input, 0)).toBeNull();
  });
});

// ── Gates unchanged ────────────────────────────────────────────────────────

describe('safety.prompt-friction thresholds', () => {
  it('stays silent below the promptable-call floor', () => {
    expect(detector.rule(dominatedBy('Bash', 19), 0)).toBeNull();
  });

  it('stays silent when no session has permission-mode info', () => {
    const input = dominatedBy('Bash');
    (input as { permissionRows: unknown[] }).permissionRows = [];
    expect(detector.rule(input, 0)).toBeNull();
  });
});
