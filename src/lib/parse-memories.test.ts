import { describe, it, expect } from 'vitest';
import {
  parseMemoryFile,
  parseMemories,
  parseMemoryIndex,
  buildMemoryStores,
  countMemories,
  projectPathToSlug,
  memoriesMatchProject,
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

  it('excludes the MEMORY.md index from the Memories view (#1990)', () => {
    // The server read now INCLUDES MEMORY.md so buildMemoryStores can light up
    // the #1779 detector — but the index is not a fact card, so parseMemories
    // must filter it out (and `MEMORY.md` lowercases via isIndexFile too).
    const withIndex: MemoriesResponse = {
      projects: [
        {
          slug: '-home-u-zeta',
          files: [
            { name: 'MEMORY.md', content: '# Index\n- [a](a.md) — hook' },
            { name: 'a.md', content: '---\nname: ay\nmetadata:\n  type: user\n---\nbody' },
            { name: 'memory.md', content: '# lowercase index also dropped' },
          ],
        },
      ],
    };
    const g = parseMemories(withIndex);
    expect(g).toHaveLength(1);
    expect(g[0].memories.map((m) => m.name)).toEqual(['ay']);
    expect(countMemories(g)).toBe(1);
  });

  it('drops a project whose only file is the MEMORY.md index (#1990)', () => {
    const indexOnly: MemoriesResponse = {
      projects: [{ slug: '-home-u-idx', files: [{ name: 'MEMORY.md', content: '# Index' }] }],
    };
    expect(parseMemories(indexOnly)).toEqual([]);
  });
});

const INDEX_MD = `# Memory index — demo

## Gotchas
- [Burn loop: verify CI green](burn-loop-verify-ci-green.md) — local lint != CI
- [PR needs open milestone](pr-needs-open-milestone.md) — set PR milestone at create

## Conventions
* [epic issue convention](epic-issue-convention.md) — sub-issue links + epic-NNN labels
- a bare line that is not a link
- [no hook entry](no-hook.md)`;

describe('parseMemoryIndex', () => {
  it('parses markdown list-link pointer lines into title/file/hook', () => {
    const entries = parseMemoryIndex(INDEX_MD);
    expect(entries).toHaveLength(4); // 4 links; heading + bare line skipped
    expect(entries[0]).toEqual({
      title: 'Burn loop: verify CI green',
      file: 'burn-loop-verify-ci-green.md',
      hook: 'local lint != CI',
      raw: '- [Burn loop: verify CI green](burn-loop-verify-ci-green.md) — local lint != CI',
    });
    expect(entries[2].file).toBe('epic-issue-convention.md'); // `*` bullet too
    expect(entries[3]).toMatchObject({ file: 'no-hook.md', hook: '' }); // no em-dash
  });

  it('returns [] when no link lines are present', () => {
    expect(parseMemoryIndex('# Just a heading\nsome prose')).toEqual([]);
    expect(parseMemoryIndex('')).toEqual([]);
  });
});

describe('buildMemoryStores', () => {
  const resp: MemoriesResponse = {
    projects: [
      {
        slug: '-home-u-zeta',
        files: [
          { name: 'b.md', content: '---\nname: bee\ndescription: \nmetadata:\n  type: user\n---\nx' },
          { name: 'MEMORY.md', content: INDEX_MD },
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

  it('splits the MEMORY.md index out from the fact store, per project', () => {
    const stores = buildMemoryStores(resp);
    expect(stores.map((s) => s.project)).toEqual(['-home-u-alpha', '-home-u-zeta']); // sorted, empty dropped

    const zeta = stores[1];
    expect(zeta.memories.map((m) => m.name)).toEqual(['ay', 'bee']); // sorted, MEMORY.md excluded
    expect(zeta.index).toHaveLength(4);
    expect(zeta.index[0].file).toBe('burn-loop-verify-ci-green.md');
    expect(zeta.indexRaw).toContain('# Memory index');
  });

  it('yields an empty index when a project has no MEMORY.md', () => {
    const alpha = buildMemoryStores(resp)[0];
    expect(alpha.project).toBe('-home-u-alpha');
    expect(alpha.index).toEqual([]);
    expect(alpha.indexRaw).toBe('');
    expect(alpha.memories.map((m) => m.name)).toEqual(['one']);
  });

  it('keeps an index-only project (pointers but no backing fact files)', () => {
    const stores = buildMemoryStores({
      projects: [{ slug: '-home-u-idx', files: [{ name: 'MEMORY.md', content: INDEX_MD }] }],
    });
    expect(stores).toHaveLength(1);
    expect(stores[0].memories).toEqual([]);
    expect(stores[0].index.length).toBeGreaterThan(0);
  });

  it('returns [] for null/empty input', () => {
    expect(buildMemoryStores(null)).toEqual([]);
    expect(buildMemoryStores({ projects: [] })).toEqual([]);
  });
});

describe('projectPathToSlug / memoriesMatchProject', () => {
  it('slugs a cwd path like Claude Code does (non-alnum -> "-")', () => {
    expect(projectPathToSlug('/home/dev/acme-web')).toBe('-home-dev-acme-web');
    expect(projectPathToSlug('/home/dev/my.app')).toBe('-home-dev-my-app');
    expect(projectPathToSlug('/work/alpha')).toBe('-work-alpha');
  });

  it('joins a slug-format memory key to a cwd-path filter selection', () => {
    // parser output shape: `project` is the on-disk slug.
    const grouped = parseMemories({
      projects: [
        { slug: '-work-alpha', files: [{ name: 'a.md', content: 'alpha' }] },
        { slug: '-work-beta', files: [{ name: 'b.md', content: 'beta' }] },
      ],
    });
    const kept = grouped.filter((g) => memoriesMatchProject(g.project, '/work/alpha'));
    expect(kept.map((g) => g.project)).toEqual(['-work-alpha']);
  });

  it('drops a non-matching canonical slug', () => {
    expect(memoriesMatchProject('-work-beta', '/work/alpha')).toBe(false);
  });

  it('keeps rather than drops when the stored key is not a canonical slug', () => {
    // Defensive: a legacy path-shaped key is uncertain, so keep it.
    expect(memoriesMatchProject('/work/alpha', '/work/alpha')).toBe(true);
    expect(memoriesMatchProject('/work/other', '/work/alpha')).toBe(true);
  });
});
