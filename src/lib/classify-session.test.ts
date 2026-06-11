import { describe, expect, it } from 'vitest';
import type { TaskCategory } from '../types';
import { DEFAULT_TASK_CATEGORY, TASK_CATEGORY_TAXONOMY } from '../types';
import { classifySession } from './classify-session';

const CATEGORIES = TASK_CATEGORY_TAXONOMY.map((c) => c.id);

describe('classifySession (#655)', () => {
  it('exports a documented fixed taxonomy with a default bucket', () => {
    expect(CATEGORIES).toEqual([
      'implementation',
      'debugging',
      'review',
      'research',
      'planning',
      'operations',
      'documentation',
      'other',
    ]);
    expect(DEFAULT_TASK_CATEGORY).toBe('other');
    for (const row of TASK_CATEGORY_TAXONOMY) {
      expect(row.label.length).toBeGreaterThan(0);
      expect(row.description.length).toBeGreaterThan(0);
    }
  });

  it.each<[TaskCategory, Parameters<typeof classifySession>[0]]>([
    [
      'implementation',
      {
        title: 'Implement the billing parser',
        toolCalls: [{ toolName: 'Edit', input: { file_path: 'src/billing.ts' } }],
      },
    ],
    [
      'debugging',
      {
        opener: 'Fix the failing checkout test',
        toolCalls: [{ toolName: 'Bash', input: { command: 'npm test -- checkout' } }],
      },
    ],
    [
      'review',
      {
        title: 'Review the security PR',
        prompts: ['audit the diff and validate the auth flow'],
      },
    ],
    [
      'research',
      {
        opener: 'Explain how the cache works',
        toolCalls: [{ toolName: 'Read', input: { file_path: 'src/cache.ts' } }],
      },
    ],
    [
      'planning',
      {
        title: 'Design the migration plan',
        prompts: ['break down the architecture and scope'],
      },
    ],
    [
      'operations',
      {
        gitBranch: 'release/v0.4',
        toolCalls: [{ toolName: 'Bash', input: { command: 'kubectl rollout restart deploy/api' } }],
      },
    ],
    [
      'documentation',
      {
        title: 'Update the README guide',
        toolCalls: [{ toolName: 'Edit', input: { file_path: 'docs/releasing.md' } }],
      },
    ],
  ])('classifies %s from local signals', (expected, signals) => {
    expect(classifySession(signals)).toBe(expected);
  });

  it('falls back to the documented default for unknown signals and never throws', () => {
    expect(classifySession()).toBe(DEFAULT_TASK_CATEGORY);
    expect(classifySession({ title: 'miscellaneous' })).toBe(DEFAULT_TASK_CATEGORY);
  });
});
