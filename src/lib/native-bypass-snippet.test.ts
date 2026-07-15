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
    expect(snippet).toContain('## Prefer native tools and path-safe shell usage');
    expect(snippet).toContain(
      'choose native tools or path-safe alternatives before Bash'
    );
    expect(snippet).toContain('Use the native Grep tool instead of Bash `grep`.');
    expect(snippet).toContain('Use the native Read tool instead of Bash `cat`.');
    // Bullets are markdown list items.
    expect(snippet).toContain('- Use the native Grep tool');
  });

  it('phrases the `cd` corrective as guidance, not a tool swap', () => {
    const snippet = nativeBypassGuidanceSnippet([
      { category: 'cd', nativeTool: 'absolute paths' },
    ]);
    expect(snippet).toContain('Avoid a standalone Bash `cd` command');
    expect(snippet).toContain('use absolute paths');
    expect(snippet).toContain('`cd <dir> && <cmd>`');
    // It must NOT phrase `cd` as "use the native … tool".
    expect(snippet).not.toContain('native absolute paths tool');
  });

  it('uses proven command aliases when a category collapsed them', () => {
    const snippet = nativeBypassGuidanceSnippet([
      {
        category: 'grep',
        nativeTool: 'Grep',
        observedCommands: ['grep', 'rg'],
      },
    ]);
    expect(snippet).toContain('Bash `grep` or Bash `rg`');
  });

  it('labels an alias-free fallback as generic rather than observed', () => {
    const snippet = nativeBypassGuidanceSnippet([
      { category: 'grep', nativeTool: 'Grep', observedCommands: [] },
    ]);
    expect(snippet).toContain(
      'category names are generic when an observed alias is unavailable'
    );
    expect(snippet).toContain('Bash `grep`');
    expect(snippet).not.toContain('Apply these observed examples');
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
    expect(line).toContain('Avoid a standalone Bash `cd` command');
    expect(line).toContain('`cd <dir> && <cmd>`');
    expect(line.startsWith('- ')).toBe(false);
  });
});
