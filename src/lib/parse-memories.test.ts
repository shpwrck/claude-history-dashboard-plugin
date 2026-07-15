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

  it('threads mtimeMs through to lastModifiedMs when the payload carries it (#2495)', () => {
    const withMtime = parseMemoryFile({
      name: 'groom-means-stop-at-submit.md',
      content: FULL,
      mtimeMs: 1_700_000_000_000,
    });
    expect(withMtime.lastModifiedMs).toBe(1_700_000_000_000);

    // Same on the no-frontmatter path (whole file treated as body).
    const noFrontmatter = parseMemoryFile({
      name: 'MEMORY.md',
      content: '# Index',
      mtimeMs: 1_650_000_000_000,
    });
    expect(noFrontmatter.lastModifiedMs).toBe(1_650_000_000_000);
  });

  it('degrades lastModifiedMs to undefined when the payload lacks mtimeMs (SPA/upload path) (#2495)', () => {
    // SPA upload path and older cached payloads carry no mtimeMs — must not throw.
    const noMtime = parseMemoryFile({ name: 'x.md', content: FULL });
    expect(noMtime.lastModifiedMs).toBeUndefined();
  });

  it('keeps a canonical archive path while deriving the fallback name from its basename', () => {
    const m = parseMemoryFile({
      name: 'archive/old-decision.md',
      content: 'An archived decision.',
    });
    expect(m.file).toBe('archive/old-decision.md');
    expect(m.name).toBe('old-decision');
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

  it('excludes archive/ARCHIVE.md from cards while retaining archive facts', () => {
    const grouped = parseMemories({
      projects: [
        {
          slug: '-home-u-archive',
          files: [
            { name: 'archive/ARCHIVE.md', content: '- [Old](old.md)' },
            { name: 'archive/old.md', content: 'old fact' },
          ],
        },
      ],
    });
    expect(grouped[0].memories.map((memory) => memory.file)).toEqual([
      'archive/old.md',
    ]);
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

  it('canonicalizes archive-index links relative to archive/ without double-prefixing', () => {
    const entries = parseMemoryIndex(
      '- [Old](old.md)\n- [Qualified](archive/already.md)',
      'archive/ARCHIVE.md'
    );
    expect(entries.map((entry) => entry.file)).toEqual([
      'archive/old.md',
      'archive/already.md',
    ]);
    expect(
      parseMemoryIndex('- [Archive index](archive/archive.md)')[0]?.file
    ).toBe('archive/ARCHIVE.md');
  });

  it('does not normalize traversal, absolute, URL, or deeper archive targets into valid facts', () => {
    const entries = parseMemoryIndex(
      [
        '- [Traversal](../outside.md)',
        '- [Absolute](/outside.md)',
        '- [URL](https://example.test/outside.md)',
        '- [Nested](nested/deeper.md)',
      ].join('\n'),
      'archive/ARCHIVE.md'
    );
    expect(entries.map((entry) => entry.file)).toEqual([
      '../outside.md',
      '/outside.md',
      'https://example.test/outside.md',
      'nested/deeper.md',
    ]);
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

  it('carries per-file lastModifiedMs onto store records, tolerating mixed payloads (#2495)', () => {
    const stores = buildMemoryStores({
      projects: [
        {
          slug: '-home-u-mix',
          files: [
            // Server path: carries mtimeMs.
            {
              name: 'a.md',
              content: '---\nname: ay\nmetadata:\n  type: user\n---\nbody',
              mtimeMs: 1_700_000_000_000,
            },
            // SPA/upload path: no mtimeMs — must degrade to undefined, not throw.
            { name: 'b.md', content: '---\nname: bee\nmetadata:\n  type: project\n---\nbody' },
          ],
        },
      ],
    });
    expect(stores).toHaveLength(1);
    const byName = Object.fromEntries(stores[0].memories.map((m) => [m.name, m.lastModifiedMs]));
    expect(byName.ay).toBe(1_700_000_000_000);
    expect(byName.bee).toBeUndefined();
  });

  it('models main and archive indexes with canonical root-relative paths', () => {
    const stores = buildMemoryStores({
      projects: [
        {
          slug: '-home-u-archive',
          files: [
            {
              name: 'MEMORY.md',
              content: '- [Archive index](archive/ARCHIVE.md)',
            },
            {
              name: 'archive/ARCHIVE.md',
              content: '- [Old fact](old.md)',
            },
            { name: 'archive/old.md', content: 'old fact' },
          ],
          readCompleteness: {
            facts: true,
            mainIndex: true,
            archiveIndex: true,
          },
        },
      ],
    });

    expect(stores).toHaveLength(1);
    expect(stores[0].memories.map((memory) => memory.file)).toEqual([
      'archive/old.md',
    ]);
    expect(stores[0].index.map((entry) => entry.file)).toEqual([
      'archive/ARCHIVE.md',
    ]);
    expect(stores[0].archiveIndex.map((entry) => entry.file)).toEqual([
      'archive/old.md',
    ]);
    expect(stores[0].readCompleteness).toEqual({
      facts: true,
      mainIndex: true,
      archiveIndex: true,
    });
  });

  it('carries explicit completeness and treats legacy payloads as unknown', () => {
    const explicit = buildMemoryStores({
      projects: [
        {
          slug: 'partial',
          files: [{ name: 'one.md', content: 'one' }],
          readCompleteness: {
            facts: false,
            mainIndex: true,
            archiveIndex: false,
          },
        },
      ],
    })[0];
    expect(explicit.readCompleteness).toEqual({
      facts: false,
      mainIndex: true,
      archiveIndex: false,
    });

    const legacy = buildMemoryStores({
      projects: [
        { slug: 'legacy', files: [{ name: 'one.md', content: 'one' }] },
      ],
    })[0];
    expect(legacy.readCompleteness).toEqual({
      facts: false,
      mainIndex: false,
      archiveIndex: false,
    });
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
