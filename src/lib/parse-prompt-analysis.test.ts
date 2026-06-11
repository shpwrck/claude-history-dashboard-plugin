import { describe, expect, it } from 'vitest';
import type { HistoryEntry } from '../types';
import { parsePromptAnalysis } from './parse-prompt-analysis';

function entry(
  sessionId: string,
  display: string,
  options: {
    project?: string;
    timestamp?: number;
    pastedContents?: HistoryEntry['pastedContents'];
  } = {}
): HistoryEntry {
  return {
    sessionId,
    display,
    project: options.project ?? '/repo/alpha',
    timestamp: options.timestamp ?? 1,
    pastedContents: options.pastedContents ?? {},
  };
}

describe('parsePromptAnalysis', () => {
  it('scores path-bearing imperative prompts as specific and imperative', () => {
    const [analysis] = parsePromptAnalysis([
      entry(
        's1',
        'Update src/lib/parse-prompt-analysis.ts to emit `PromptAnalysis` counts and keep the payload text-free.'
      ),
    ]);

    expect(analysis).toMatchObject({
      sessionId: 's1',
      project: '/repo/alpha',
      promptTurnCount: 1,
      imperativeTurnCount: 1,
      questionTurnCount: 0,
      filePathMentionCount: 1,
      backtickIdentifierCount: 1,
      specificityMarkerCount: 2,
      lowSpecificityTurnCount: 0,
      constraintTurnCount: 1,
    });
    expect(analysis.totalPromptChars).toBeGreaterThan(0);
    expect(analysis.avgPromptChars).toBe(analysis.totalPromptChars);
    expect(JSON.stringify(analysis)).not.toContain('parse-prompt-analysis.ts');
  });

  it('scores vague questions as questions with low specificity', () => {
    const [analysis] = parsePromptAnalysis([
      entry('s2', 'Maybe what should we do next?'),
    ]);

    expect(analysis).toMatchObject({
      sessionId: 's2',
      promptTurnCount: 1,
      questionTurnCount: 1,
      imperativeTurnCount: 0,
      specificityMarkerCount: 0,
      lowSpecificityTurnCount: 1,
      hedgingTurnCount: 1,
    });
  });

  it('counts constraints and pasted-content reliance without retaining pasted text', () => {
    const [analysis] = parsePromptAnalysis([
      entry('s3', 'Do not call the server. Acceptance: lint and tests pass.', {
        pastedContents: {
          pasted: {
            id: 1,
            type: 'text',
            content: 'secret pasted fixture',
          },
        },
      }),
    ]);

    expect(analysis).toMatchObject({
      sessionId: 's3',
      sentenceCount: 2,
      constraintTurnCount: 1,
      pastedContentTurnCount: 1,
      pastedContentCount: 1,
    });
    expect(JSON.stringify(analysis)).not.toContain('secret pasted fixture');
  });

  it('returns one aggregate record per session', () => {
    const result = parsePromptAnalysis([
      entry('b', 'Fix `src/App.tsx`.', { project: '/repo/beta' }),
      entry('a', 'Can you check this?'),
      entry('b', 'Run tests before the PR.'),
    ]);

    expect(result.map((row) => row.sessionId)).toEqual(['a', 'b']);
    expect(result.find((row) => row.sessionId === 'b')).toMatchObject({
      project: '/repo/beta',
      promptTurnCount: 2,
      imperativeTurnCount: 2,
    });
  });

  it('ignores empty prompt text', () => {
    expect(parsePromptAnalysis([entry('empty', '   ')])).toEqual([]);
  });
});
