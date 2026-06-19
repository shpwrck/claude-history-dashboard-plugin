import { describe, expect, it } from 'vitest';
import {
  nativeBypassGuidanceSnippet,
  nativeBypassRowSnippet,
} from './native-bypass-snippet';

describe('nativeBypassGuidanceSnippet', () => {
  it('emits a CLAUDE.md guidance block with one bullet per bypassed category', () => {
    const snippet = nativeBypassGuidanceSnippet([
      { category: 'grep', nativeTool: 'Grep' },
      { category: 'cat', nativeTool: 'Read' },
    ]);
    expect(snippet).toContain('## Prefer native tools over shell equivalents');
    expect(snippet).toContain('Use the native Grep tool instead of Bash `grep`.');
    expect(snippet).toContain('Use the native Read tool instead of Bash `cat`.');
    // Bullets are markdown list items.
    expect(snippet).toContain('- Use the native Grep tool');
  });

  it('phrases the `cd` corrective as guidance, not a tool swap', () => {
    const snippet = nativeBypassGuidanceSnippet([
      { category: 'cd', nativeTool: 'absolute paths' },
    ]);
    expect(snippet).toContain("Don't lead a Bash command with `cd`");
    expect(snippet).toContain('use absolute paths instead');
    // It must NOT phrase `cd` as "use the native … tool".
    expect(snippet).not.toContain('native absolute paths tool');
  });

  it('de-dupes repeated categories, preserving order', () => {
    const snippet = nativeBypassGuidanceSnippet([
      { category: 'grep', nativeTool: 'Grep' },
      { category: 'grep', nativeTool: 'Grep' },
    ]);
    const occurrences = snippet.split('Use the native Grep tool').length - 1;
    expect(occurrences).toBe(1);
  });

  it('falls back to the canonical set when given no rows', () => {
    const snippet = nativeBypassGuidanceSnippet([]);
    expect(snippet).toContain('Bash `grep`');
    expect(snippet).toContain('Bash `find`');
    expect(snippet).toContain('Bash `cat`');
  });

  it('is a pure prose block — no heredoc/shell hazard', () => {
    const snippet = nativeBypassGuidanceSnippet([
      { category: 'sed', nativeTool: 'Read/Edit' },
    ]);
    expect(snippet).not.toContain('<<');
    expect(snippet).not.toContain('chmod');
  });
});

describe('nativeBypassRowSnippet', () => {
  it('emits a standalone single-line corrective without the list bullet', () => {
    const line = nativeBypassRowSnippet({ category: 'find', nativeTool: 'Glob' });
    expect(line).toBe('Use the native Glob tool instead of Bash `find`.');
    expect(line.startsWith('- ')).toBe(false);
  });

  it('handles the `cd` row corrective', () => {
    const line = nativeBypassRowSnippet({
      category: 'cd',
      nativeTool: 'absolute paths',
    });
    expect(line).toContain("Don't lead a Bash command with `cd`");
    expect(line.startsWith('- ')).toBe(false);
  });
});
