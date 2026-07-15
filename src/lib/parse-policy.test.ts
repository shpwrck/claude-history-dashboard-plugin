import { describe, it, expect } from 'vitest';
import {
  buildPolicyCandidates,
  computePolicyDiff,
  policyDiffToSnippet,
} from './parse-policy';
import {
  detectDangerousCommands,
  type DangerousCommand,
  type ToolPromptFriction,
} from './parse-permissions';

const danger = (
  pattern: string,
  matchingRules: string[] | null,
  sessionId = 's1'
): DangerousCommand => ({
  sessionId,
  timestamp: 't',
  toolUseId: 'u',
  command: 'x',
  pattern,
  certainty: 'high',
  matchingRules,
});

const detected = (command: string): DangerousCommand[] =>
  detectDangerousCommands([
    {
      sessionId: 's1',
      calls: [
        {
          timestamp: 't',
          toolName: 'Bash',
          input: { command },
          toolUseId: 'u',
          isError: null,
          resultBytes: 0,
        },
      ],
    },
  ]);

const bashFriction: ToolPromptFriction = {
  toolName: 'Bash',
  promptableCalls: 100,
  sessionCount: 5,
  share: 60,
};

describe('buildPolicyCandidates', () => {
  it('maps only the canonical rule proven against the observed invocation', () => {
    const out = buildPolicyCandidates(detected('rm -rf ~'), []);
    const rules = out.map((c) => c.rule);
    expect(rules).toContain('Bash(rm -rf:*)');
    expect(rules).not.toContain('Bash(rm -fr:*)');
    expect(out.every((c) => c.kind === 'dangerous' && c.defaultAction === 'deny')).toBe(true);
  });

  it.each(['rm -rfv ~', 'rm -Rfv ~', 'cd /tmp && rm -rf ~'])(
    'omits a policy fix when no canonical rule covers the raw invocation: %s',
    (command) => {
      expect(buildPolicyCandidates(detected(command), [])).toHaveLength(0);
    }
  );

  it.each([
    ['legacy unknown', null],
    ['proven non-match', []],
  ])('omits a policy fix for %s persisted prefix truth', (_label, rules) => {
    expect(buildPolicyCandidates([danger('rm -rf', rules)], [])).toHaveLength(0);
  });

  it('omits impossible persisted alias sets after parser validation', () => {
    const parsed = detectDangerousCommands([
      {
        sessionId: 's1',
        calls: [
          {
            timestamp: 't',
            toolName: 'Bash',
            input: {},
            toolUseId: 'u',
            isError: null,
            resultBytes: 0,
            commandPreview: 'rm -rf ~',
            commandDangerousPattern: 'rm -rf',
            commandDangerousCertainty: 'high',
            commandDangerousRuleMatches: [
              'Bash(rm -rf:*)',
              'Bash(rm -fr:*)',
            ],
          },
        ],
      },
    ]);

    expect(parsed[0].matchingRules).toBeNull();
    expect(buildPolicyCandidates(parsed, [])).toHaveLength(0);
  });

  it('omits patterns with no prefix-matchable rule (fork bomb)', () => {
    expect(buildPolicyCandidates([danger('fork bomb', [])], [])).toHaveLength(0);
    expect(buildPolicyCandidates([danger('constructor', null)], [])).toHaveLength(0);
  });

  it('emits safe Bash allow rows from prompt friction, defaulting to allow', () => {
    const out = buildPolicyCandidates([], [bashFriction]);
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((c) => c.kind === 'friction' && c.defaultAction === 'allow')).toBe(true);
    expect(out.map((c) => c.rule)).toContain('Bash(ls:*)');
  });

  it('marks a rule already present in settings via `current`', () => {
    const out = buildPolicyCandidates([danger('dd if=', ['Bash(dd:*)'])], [], { deny: ['Bash(dd:*)'] });
    const dd = out.find((c) => c.rule === 'Bash(dd:*)');
    expect(dd?.current).toBe('deny');
  });

  it('does not map a generic disk redirect to the unrelated dd prefix rule', () => {
    const out = buildPolicyCandidates([
      danger('dd if=', ['Bash(dd:*)']),
      danger('disk overwrite', []),
    ], []);
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
