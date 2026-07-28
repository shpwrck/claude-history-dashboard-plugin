/**
 * Behavioral tests for safety.prompt-friction (#75), focused on the v0.6 audit
 * finding #3223: when the dominant prompt-prone tool was not Bash the detector
 * emitted `{"permissions":{"allow":["<ToolName>"]}}` — a bare, unscoped grant.
 * The evidence behind this recommendation establishes prompt FREQUENCY only, so
 * that snippet blanket-authorized whatever the tool can do: arbitrary writes
 * (Write/Edit/NotebookEdit), network egress (WebFetch/WebSearch), or an entire
 * `mcp__*` server.
 *
 * The contract asserted here: only a catalogued, reviewed, SCOPED rule set may
 * produce an allow snippet; every other dominant tool yields a
 * manual-analysis finding with no `permissions.allow` snippet at all.
 */
import { describe, it, expect } from 'vitest';
import { detector, safeAllowRulesFor } from './prompt-friction';
import { effectiveFixKind, validateFixSnippet } from '../fix-validity';
import { BASH_SAFE_ALLOW_RULES } from '../shared';
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

/** Any `permissions.allow` array anywhere inside a parsed snippet. */
function allowArrayOf(snippet: string): unknown {
  const parsed = JSON.parse(snippet) as {
    permissions?: { allow?: unknown };
  };
  return parsed.permissions?.allow;
}

// ── The catalogued (safe, scoped) case still produces a validated fix ───────

describe('safety.prompt-friction catalogued tools (#3223)', () => {
  it('emits the scoped Bash safe-variant rules, not a bare "Bash" grant', () => {
    const rec = detector.rule(dominatedBy('Bash'), 0);
    expect(rec?.id).toBe('safety.prompt-friction');
    expect(rec?.fix).toBeDefined();
    // The LITERAL field, not effectiveFixKind: the classification must be
    // DECLARED. effectiveFixKind() returns 'validated' whether the field is
    // present or absent, so on its own it cannot tell a deliberate claim from an
    // inherited default — which is exactly the gap #3221 was about.
    expect(rec!.fix!.fixKind).toBe('validated');
    expect(effectiveFixKind(rec!.fix!)).toBe('validated');
    expect(validateFixSnippet(rec!.fix!)).toEqual([]);

    const allow = allowArrayOf(rec!.fix!.snippet) as string[];
    expect(allow).toEqual(BASH_SAFE_ALLOW_RULES);
    // Never the bare tool name.
    expect(allow).not.toContain('Bash');
    // Every rule is scoped to a named command.
    for (const rule of allow) expect(rule).toMatch(/^Bash\(.+\)$/);
  });

  it('self-suppresses once the scoped Bash rules are already allowed', () => {
    const input = dominatedBy('Bash');
    (input as { liveConfig: unknown }).liveConfig = {
      settings: { permissions: { allow: [...BASH_SAFE_ALLOW_RULES] } },
    };
    expect(detector.rule(input, 0)).toBeNull();
  });

  it('exposes only reviewed, scoped catalog entries', () => {
    expect(safeAllowRulesFor('Bash')).toEqual(BASH_SAFE_ALLOW_RULES);
    // Prototype keys must not masquerade as catalogued tools.
    for (const key of ['constructor', '__proto__', 'toString', 'valueOf']) {
      expect(safeAllowRulesFor(key)).toBeNull();
    }
  });
});

// ── Privileged / unknown tools must never get an allow snippet ──────────────

describe('safety.prompt-friction privileged non-Bash tools (#3223)', () => {
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
