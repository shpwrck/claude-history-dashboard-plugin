import { describe, it, expect } from 'vitest';
import {
  parseMemoryFile,
  parseMemories,
  countMemories,
  type MemoriesResponse,
} from './parse-memories';

const FULL = `---
name: groom-means-stop-at-submit
description: when asked to groom, stop after gh issue create
metadata:
  type: feedback
---
The body of the fact, with a [[link]] to another memory.`;

describe('parseMemoryFile', () => {
  it('parses name, description, nested metadata.type, and body', () => {
    const m = parseMemoryFile({ name: 'groom-means-stop-at-submit.md', content: FULL });
    expect(m.name).toBe('groom-means-stop-at-submit');
    expect(m.description).toBe('when asked to groom, stop after gh issue create');
    expect(m.type).toBe('feedback');
    expect(m.body).toContain('The body of the fact');
    expect(m.file).toBe('groom-means-stop-at-submit.md');
  });

  it('falls back to the filename when frontmatter is absent', () => {
    const m = parseMemoryFile({ name: 'MEMORY.md', content: '# Index\n- a\n- b' });
    expect(m.name).toBe('MEMORY');
    expect(m.description).toBe('');
    expect(m.type).toBe('other');
    expect(m.body).toContain('# Index');
  });

  it('normalizes an unknown type to "other"', () => {
    const content = `---
name: x
description: d
metadata:
  type: wizardry
---
body`;
    expect(parseMemoryFile({ name: 'x.md', content }).type).toBe('other');
  });

  it('handles a top-level type and quoted values', () => {
    const content = `---
name: "quoted-name"
description: 'single quoted'
type: project
---
b`;
    const m = parseMemoryFile({ name: 'x.md', content });
    expect(m.name).toBe('quoted-name');
    expect(m.description).toBe('single quoted');
    expect(m.type).toBe('project');
  });

  it('does not throw on partial frontmatter (name only)', () => {
    const content = `---
name: only-name
---
b`;
    const m = parseMemoryFile({ name: 'x.md', content });
    expect(m.name).toBe('only-name');
    expect(m.description).toBe('');
    expect(m.type).toBe('other');
  });
});

describe('parseMemories', () => {
  const resp: MemoriesResponse = {
    projects: [
      {
        slug: '-home-u-zeta',
        files: [
          { name: 'b.md', content: '---\nname: bee\ndescription: \nmetadata:\n  type: user\n---\nx' },
          { name: 'a.md', content: '---\nname: ay\ndescription: \nmetadata:\n  type: project\n---\ny' },
        ],
      },
      {
        slug: '-home-u-alpha',
        files: [{ name: 'one.md', content: '---\nname: one\ndescription: d\nmetadata:\n  type: reference\n---\nz' }],
      },
      { slug: '-home-u-empty', files: [] },
    ],
  };

  it('groups by project sorted by slug, sorts memories by name, drops empty projects', () => {
    const g = parseMemories(resp);
    expect(g.map((p) => p.project)).toEqual(['-home-u-alpha', '-home-u-zeta']); // sorted, empty dropped
    expect(g[1].memories.map((m) => m.name)).toEqual(['ay', 'bee']); // sorted by name
  });

  it('counts memories across projects', () => {
    expect(countMemories(parseMemories(resp))).toBe(3);
  });

  it('returns [] for null/empty input', () => {
    expect(parseMemories(null)).toEqual([]);
    expect(parseMemories({ projects: [] })).toEqual([]);
  });
});
