import { describe, it, expect } from 'vitest';
import {
  buildPolicyCandidates,
  computePolicyDiff,
  policyDiffToSnippet,
} from './parse-policy';
import type { DangerousCommand, ToolPromptFriction } from './parse-permissions';

const danger = (pattern: string, sessionId = 's1'): DangerousCommand => ({
  sessionId,
  timestamp: 't',
  toolUseId: 'u',
  command: 'x',
  pattern,
  certainty: 'high',
});

const bashFriction: ToolPromptFriction = {
  toolName: 'Bash',
  promptableCalls: 100,
  sessionCount: 5,
  share: 60,
};

describe('buildPolicyCandidates', () => {
  it('maps a dangerous pattern to its canonical deny rule(s), defaulting to deny', () => {
    const out = buildPolicyCandidates([danger('rm -rf')], []);
    const rules = out.map((c) => c.rule);
    expect(rules).toContain('Bash(rm -rf:*)');
    expect(rules).toContain('Bash(rm -fr:*)');
    expect(out.every((c) => c.kind === 'dangerous' && c.defaultAction === 'deny')).toBe(true);
  });

  it('omits patterns with no prefix-matchable rule (fork bomb)', () => {
    expect(buildPolicyCandidates([danger('fork bomb')], [])).toHaveLength(0);
  });

  it('emits safe Bash allow rows from prompt friction, defaulting to allow', () => {
    const out = buildPolicyCandidates([], [bashFriction]);
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((c) => c.kind === 'friction' && c.defaultAction === 'allow')).toBe(true);
    expect(out.map((c) => c.rule)).toContain('Bash(ls:*)');
  });

  it('marks a rule already present in settings via `current`', () => {
    const out = buildPolicyCandidates([danger('dd if=')], [], { deny: ['Bash(dd:*)'] });
    const dd = out.find((c) => c.rule === 'Bash(dd:*)');
    expect(dd?.current).toBe('deny');
  });

  it('does not map a generic disk redirect to the unrelated dd prefix rule', () => {
    const out = buildPolicyCandidates([danger('dd if='), danger('disk overwrite')], []);
    expect(out.filter((c) => c.rule === 'Bash(dd:*)')).toHaveLength(1);
    expect(out.some((c) => c.detail.includes('disk overwrite'))).toBe(false);
  });
});

describe('computePolicyDiff', () => {
  it('accumulates selections into the right buckets', () => {
    const diff = computePolicyDiff([
      { rule: 'Bash(rm -rf:*)', action: 'deny' },
      { rule: 'Bash(ls:*)', action: 'allow' },
    ]);
    expect(diff.deny).toEqual(['Bash(rm -rf:*)']);
    expect(diff.allow).toEqual(['Bash(ls:*)']);
    expect(diff.count).toBe(2);
  });

  it('treats a rule already in the target bucket as a no-op', () => {
    const diff = computePolicyDiff(
      [{ rule: 'Bash(dd:*)', action: 'deny' }],
      { deny: ['Bash(dd:*)'] }
    );
    expect(diff.count).toBe(0);
  });

  it('still adds a rule that exists in a DIFFERENT bucket', () => {
    const diff = computePolicyDiff(
      [{ rule: 'Bash(dd:*)', action: 'deny' }],
      { allow: ['Bash(dd:*)'] }
    );
    expect(diff.deny).toEqual(['Bash(dd:*)']);
    expect(diff.count).toBe(1);
  });
});

describe('policyDiffToSnippet', () => {
  it('renders only non-empty buckets as a settings.json block', () => {
    const snippet = policyDiffToSnippet({
      allow: ['Bash(ls:*)'],
      ask: [],
      deny: ['Bash(rm -rf:*)'],
      count: 2,
    });
    const parsed = JSON.parse(snippet);
    expect(parsed.permissions.allow).toEqual(['Bash(ls:*)']);
    expect(parsed.permissions.deny).toEqual(['Bash(rm -rf:*)']);
    expect('ask' in parsed.permissions).toBe(false);
  });

  it('returns empty string when there is nothing to add', () => {
    expect(policyDiffToSnippet({ allow: [], ask: [], deny: [], count: 0 })).toBe('');
  });
});
