/**
 * parse-docs.test.ts — vitest tests for the repo doc-graph builder (#2257,
 * epic #2256).
 *
 * Covers every acceptance bullet from the issue:
 *  - relative md-link resolution (incl. `../` and same-dir)
 *  - `#NNNN` issue-ref extraction
 *  - `src/lib/...` src-ref extraction
 *  - frontmatter parse (present + absent)
 *  - category derivation per directory
 *  - empty / no-docs input -> empty graph
 *  - the three declared partial indices (REFERENCES, competitive tracker, ADR)
 *
 * The pure extractors are exercised off plain strings (parse-memories style);
 * `buildDocGraph` is exercised end-to-end over a temp fixture tree.
 */
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { execFileSyncMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn((): string => {
    throw new Error('not a git repository');
  }),
}));
const fsCalls = vi.hoisted(() => ({
  statPaths: [] as string[],
  openPaths: [] as string[],
}));

vi.mock('node:child_process', () => ({ execFileSync: execFileSyncMock }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const statSync = (...args: unknown[]) => {
    fsCalls.statPaths.push(String(args[0]));
    return (actual.statSync as unknown as (...values: unknown[]) => unknown)(...args);
  };
  const openSync = (...args: unknown[]) => {
    fsCalls.openPaths.push(String(args[0]));
    return (actual.openSync as unknown as (...values: unknown[]) => unknown)(...args);
  };
  return {
    ...actual,
    default: { ...actual, statSync, openSync },
    statSync,
    openSync,
  };
});
import {
  buildDocGraph,
  captureDocGitTimesSnapshot,
  docGraphHasTransientGitHistoryFailure,
  classifyIndex,
  deriveCategory,
  extractHeadings,
  extractIssueRefs,
  extractMarkdownLinkTargets,
  extractSrcRefs,
  parseFrontmatter,
  resolveDocLink,
  slugForPath,
  type DocCategory,
  type DocGraph,
} from './parse-docs';
import { DOC_CATEGORIES, isDocCategory } from './doc-contract';

// ── Pure helpers ──────────────────────────────────────────────────────────────

describe('deriveCategory (per directory)', () => {
  it('maps repo-root markdown to root', () => {
    expect(deriveCategory('README.md')).toBe('root');
    expect(deriveCategory('REFERENCES.md')).toBe('root');
    expect(deriveCategory('AGENTS.md')).toBe('root');
  });

  it('maps a file directly under docs/ to doc', () => {
    expect(deriveCategory('docs/adding-a-recommendation.md')).toBe('doc');
  });

  it('maps each recognised docs subtree to its bucket', () => {
    expect(deriveCategory('docs/adr/0001-x.md')).toBe('adr');
    expect(deriveCategory('docs/audits/a.md')).toBe('audit');
    expect(deriveCategory('docs/competitive/x.md')).toBe('competitive');
    expect(deriveCategory('docs/competitive-analysis/x.md')).toBe('competitive');
    expect(deriveCategory('docs/plans/x.md')).toBe('plan');
    expect(deriveCategory('docs/experiments/x.md')).toBe('experiment');
    expect(deriveCategory('docs/product/x.md')).toBe('product');
    expect(deriveCategory('docs/reviews/x.md')).toBe('review');
    expect(deriveCategory('docs/backlog/x.md')).toBe('backlog');
    expect(deriveCategory('docs/perf-sprint/x.md')).toBe('perf');
  });

  it('maps an unknown docs subtree to doc and a non-docs tree to other', () => {
    expect(deriveCategory('docs/unknown-sub/x.md')).toBe('doc');
    expect(deriveCategory('src/lib/parse-docs.ts')).toBe('other');
  });
});

describe('doc-category contract (#2472)', () => {
  it('exposes a single, deduplicated vocabulary', () => {
    expect(new Set(DOC_CATEGORIES).size).toBe(DOC_CATEGORIES.length);
    expect([...DOC_CATEGORIES].sort()).toEqual(
      [
        'adr',
        'audit',
        'backlog',
        'competitive',
        'doc',
        'experiment',
        'other',
        'perf',
        'plan',
        'product',
        'review',
        'root',
      ].sort()
    );
  });

  it('deriveCategory only ever returns a member of the shared vocabulary', () => {
    const paths = [
      'README.md',
      'REFERENCES.md',
      'docs/x.md',
      'docs/adr/0001-x.md',
      'docs/audits/a.md',
      'docs/competitive/x.md',
      'docs/competitive-analysis/x.md',
      'docs/plans/x.md',
      'docs/experiments/x.md',
      'docs/product/x.md',
      'docs/reviews/x.md',
      'docs/backlog/x.md',
      'docs/perf-sprint/x.md',
      'docs/unknown-sub/x.md',
      'src/lib/parse-docs.ts',
    ];
    for (const p of paths) {
      expect(DOC_CATEGORIES).toContain(deriveCategory(p));
    }
  });

  it('every vocabulary member is reachable from some path (parser and contract share one vocabulary)', () => {
    const reachable = new Set<DocCategory>([
      deriveCategory('README.md'),
      deriveCategory('docs/x.md'),
      deriveCategory('docs/adr/0001-x.md'),
      deriveCategory('docs/audits/a.md'),
      deriveCategory('docs/competitive/x.md'),
      deriveCategory('docs/plans/x.md'),
      deriveCategory('docs/experiments/x.md'),
      deriveCategory('docs/product/x.md'),
      deriveCategory('docs/reviews/x.md'),
      deriveCategory('docs/backlog/x.md'),
      deriveCategory('docs/perf-sprint/x.md'),
      deriveCategory('src/lib/parse-docs.ts'), // 'other'
    ]);
    expect([...reachable].sort()).toEqual([...DOC_CATEGORIES].sort());
  });

  it('isDocCategory is exact-case (an uppercase or unknown token is not a category)', () => {
    expect(isDocCategory('adr')).toBe(true);
    expect(isDocCategory('ADR')).toBe(false);
    expect(isDocCategory('bogus')).toBe(false);
    expect(isDocCategory('')).toBe(false);
  });

  it('re-exports DocCategory through parse-docs for existing importers', () => {
    const c: DocCategory = 'adr'; // compile-time proof the parse-docs re-export resolves
    expect(isDocCategory(c)).toBe(true);
  });
});

describe('resolveDocLink (relative md-link resolution)', () => {
  it('resolves a same-dir link (with and without ./)', () => {
    expect(resolveDocLink('docs/a.md', 'b.md')).toBe('docs/b');
    expect(resolveDocLink('docs/a.md', './b.md')).toBe('docs/b');
  });

  it('resolves a parent-dir link via ../', () => {
    expect(resolveDocLink('docs/adr/0001-x.md', '../RELEASING.md')).toBe(
      'docs/RELEASING'
    );
    expect(resolveDocLink('docs/adr/0001-x.md', '../../REFERENCES.md')).toBe(
      'REFERENCES'
    );
  });

  it('resolves a nested subdir link', () => {
    expect(resolveDocLink('docs/a.md', 'adr/0008-x.md')).toBe('docs/adr/0008-x');
  });

  it('strips an anchor fragment before resolving', () => {
    expect(resolveDocLink('docs/a.md', 'b.md#a-section')).toBe('docs/b');
  });

  it('ignores external URLs, mailto, anchors, and non-md assets', () => {
    expect(resolveDocLink('docs/a.md', 'https://example.com/x.md')).toBeNull();
    expect(resolveDocLink('docs/a.md', 'mailto:me@x.com')).toBeNull();
    expect(resolveDocLink('docs/a.md', '#section')).toBeNull();
    expect(resolveDocLink('docs/a.md', 'diagram.png')).toBeNull();
    expect(resolveDocLink('docs/a.md', '//cdn.example.com/x.md')).toBeNull();
  });

  it('ignores a link that escapes the doc root', () => {
    expect(resolveDocLink('a.md', '../secrets.md')).toBeNull();
  });
});

describe('extractMarkdownLinkTargets', () => {
  it('captures targets, with titles and angle brackets', () => {
    const md =
      'see [x](./x.md) and [y](y.md "title") and [z](<sp ace.md>) and [w](https://e.com)';
    expect(extractMarkdownLinkTargets(md)).toEqual([
      './x.md',
      'y.md',
      'sp ace.md',
      'https://e.com',
    ]);
  });
});

describe('extractIssueRefs (#NNNN)', () => {
  it('extracts and de-duplicates issue numbers', () => {
    expect(
      extractIssueRefs('closes #2257, see #2256 and (#2257) again; epic #2256.')
    ).toEqual([2257, 2256]);
  });

  it('does not match HTML entities or word#123', () => {
    expect(extractIssueRefs('&#123; color #fff not an issue but word#99')).toEqual(
      []
    );
  });

  it('returns [] when there are no refs', () => {
    expect(extractIssueRefs('no issues here')).toEqual([]);
  });

  it('skips a #NNN inside a fenced code block (e.g. a hex colour) (#2871)', () => {
    const md = [
      'See #2257 in prose.',
      '```css',
      '.a { color: #123; background: #456456; }',
      '```',
      'And #2258 after.',
    ].join('\n');
    expect(extractIssueRefs(md)).toEqual([2257, 2258]);
  });

  it('skips a #NNN inside an inline code span (#2871)', () => {
    expect(
      extractIssueRefs('the token `#999` is code, but #123 is a real ref')
    ).toEqual([123]);
  });

  it('handles ~~~ fences and an unterminated fence conservatively (#2871)', () => {
    expect(
      extractIssueRefs(['x #1 y', '~~~', '#2', '~~~', '#3'].join('\n'))
    ).toEqual([1, 3]);
    // An unterminated fence swallows the remainder (as with heading extraction).
    expect(extractIssueRefs(['#1', '```', '#2', '#3'].join('\n'))).toEqual([1]);
  });

  it('honours GFM fence length + closing rules (nested / trailing-text fences) (#2871)', () => {
    // A nested ```-block inside a ````-block does not close it early.
    expect(
      extractIssueRefs(
        ['````markdown', '```css', '.x { color: #789; }', '```', '````', '#900'].join(
          '\n'
        )
      )
    ).toEqual([900]);
    // A closing fence carrying trailing text does not close the block.
    expect(
      extractIssueRefs(
        [
          '```css',
          '.foo { color: #111; }',
          '``` end-of-block',
          '.bar { color: #222; }',
          '```',
          '#333',
        ].join('\n')
      )
    ).toEqual([333]);
    // A shorter closer leaves a longer fence open (both in-block #N stay code).
    expect(extractIssueRefs(['~~~~', '#301', '~~~', '#302'].join('\n'))).toEqual(
      []
    );
  });

  it('accepts only canonical positive decimals within the safe-integer range (#2871)', () => {
    // #0 and leading-zero forms are rejected; a >= 2^53 token is rejected — the
    // same grammar the #2711 consumer enforces.
    expect(extractIssueRefs('#0 #007 #12 #99999999999999999999')).toEqual([12]);
  });
});

describe('extractSrcRefs (src/lib/...)', () => {
  it('extracts and de-duplicates src paths', () => {
    const md =
      'consumed by `src/lib/parse-memories.ts` and src/lib/parse-docs.ts, also src/components/App.tsx; repeat src/lib/parse-memories.ts';
    expect(extractSrcRefs(md)).toEqual([
      'src/lib/parse-memories.ts',
      'src/lib/parse-docs.ts',
      'src/components/App.tsx',
    ]);
  });

  it('returns [] when there are no src refs', () => {
    expect(extractSrcRefs('scripts/ingest.mjs is not src/')).toEqual([]);
  });
});

describe('parseFrontmatter (present + absent)', () => {
  it('parses a present frontmatter block and returns the body', () => {
    const content = `---\ntitle: My Doc\nstatus: "accepted"\nnum: 8\n---\n\n# Heading\n\nbody text\n`;
    const { frontmatter, body } = parseFrontmatter(content);
    expect(frontmatter).toEqual({ title: 'My Doc', status: 'accepted', num: '8' });
    expect(body).toContain('# Heading');
    expect(body).toContain('body text');
  });

  it('returns empty frontmatter and the whole content as body when absent', () => {
    const content = '# Just a doc\n\nno frontmatter here';
    const { frontmatter, body } = parseFrontmatter(content);
    expect(frontmatter).toEqual({});
    expect(body).toBe(content);
  });

  it('does not promote a nested-only category declaration to the top level', () => {
    const content = `---\nmetadata:\n  category: plan\n---\n\n# Nested metadata\n`;
    const { frontmatter } = parseFrontmatter(content);

    expect(frontmatter['category']).toBeUndefined();
  });

  it('keeps a top-level category when a later nested mapping repeats the key', () => {
    const content =
      `---\ncategory: adr\nmetadata:\n  category: plan\n  owner: docs\n---\n\n# ADR\n`;
    const { frontmatter } = parseFrontmatter(content);

    expect(frontmatter['category']).toBe('adr');
    // Existing flat-leaf behavior remains available for non-contract fields.
    expect(frontmatter['owner']).toBe('docs');
  });

  it('preserves an empty top-level category as an explicit declaration', () => {
    const content = `---\ncategory:\n---\n\n# Missing category token\n`;
    const { frontmatter } = parseFrontmatter(content);

    expect(Object.hasOwn(frontmatter, 'category')).toBe(true);
    expect(frontmatter['category']).toBe('');
  });

  it('strips YAML comments outside quoted and unquoted category scalars', () => {
    const unquoted = parseFrontmatter(
      `---\ncategory: adr # canonical path category\n---\n`
    ).frontmatter;
    const quoted = parseFrontmatter(
      `---\ncategory: "audit" # canonical path category\n---\n`
    ).frontmatter;
    const hashInsideQuotes = parseFrontmatter(
      `---\ncategory: "audit # draft"\n---\n`
    ).frontmatter;

    expect(unquoted['category']).toBe('adr');
    expect(quoted['category']).toBe('audit');
    expect(hashInsideQuotes['category']).toBe('audit # draft');
  });

  // ── Lifecycle-owner fields status/issue (#2711) — same top-level-only,
  //    inline-comment-aware treatment as category ────────────────────────────

  it('does not promote a nested-only status or issue declaration to the top level', () => {
    const content =
      `---\nmetadata:\n  status: draft\n  issue: "#123"\n---\n\n# Nested lifecycle metadata\n`;
    const { frontmatter } = parseFrontmatter(content);

    expect(frontmatter['status']).toBeUndefined();
    expect(frontmatter['issue']).toBeUndefined();
  });

  it('keeps a top-level status/issue when a later nested mapping repeats the key', () => {
    const content =
      `---\nstatus: draft\nissue: "#123"\nmetadata:\n  status: closed\n  issue: "#999"\n  owner: docs\n---\n\n# Draft\n`;
    const { frontmatter } = parseFrontmatter(content);

    expect(frontmatter['status']).toBe('draft');
    expect(frontmatter['issue']).toBe('#123');
    // Existing flat-leaf behavior remains available for non-contract fields.
    expect(frontmatter['owner']).toBe('docs');
  });

  it('strips an unquoted issue value to empty (YAML comment) but keeps a quoted hash', () => {
    // An unquoted `#123` is a YAML comment: the value strips to empty, so the
    // detector's `/^#[1-9]\\d*$/` owner check never matches it (silent).
    const unquoted = parseFrontmatter(`---\nissue: #123\n---\n`).frontmatter;
    // A quoted hash survives, giving the detector the exact `#123` it needs.
    const quoted = parseFrontmatter(`---\nissue: "#123"\n---\n`).frontmatter;

    expect(unquoted['issue']).toBe('');
    expect(quoted['issue']).toBe('#123');
  });
});

describe('extractHeadings', () => {
  it('captures ATX headings and skips fenced-code lines', () => {
    const body = [
      '# Title',
      '',
      '## Section one',
      '',
      '```bash',
      '# not a heading (inside a fence)',
      '```',
      '',
      '### Section two ###',
    ].join('\n');
    expect(extractHeadings(body)).toEqual(['Title', 'Section one', 'Section two']);
  });
});

describe('classifyIndex (declared partial indices)', () => {
  it('recognises REFERENCES.md as the references index', () => {
    expect(classifyIndex('REFERENCES', 'root')).toEqual({ indexKind: 'references' });
  });

  it('recognises the competitive tracker README', () => {
    expect(
      classifyIndex('docs/competitive-analysis/README', 'competitive')
    ).toEqual({ indexKind: 'competitive-tracker' });
    expect(classifyIndex('docs/competitive/README', 'competitive')).toEqual({
      indexKind: 'competitive-tracker',
    });
  });

  it('recognises an ADR and extracts its numeric ordinal', () => {
    expect(classifyIndex('docs/adr/0008-server-llm', 'adr')).toEqual({
      indexKind: 'adr-sequence',
      ordinal: 8,
    });
  });

  it('returns null for an ordinary doc', () => {
    expect(classifyIndex('docs/adding-a-recommendation', 'doc')).toBeNull();
  });
});

describe('slugForPath', () => {
  it('drops the .md suffix and normalises separators', () => {
    expect(slugForPath('docs/adr/0001-x.md')).toBe('docs/adr/0001-x');
    expect(slugForPath('docs\\a\\b.md')).toBe('docs/a/b');
  });
});

// ── buildDocGraph end-to-end ──────────────────────────────────────────────────

function write(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
}

describe('buildDocGraph', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'parse-docs-'));
    fsCalls.statPaths.length = 0;
    fsCalls.openPaths.length = 0;
    execFileSyncMock.mockReset();
    execFileSyncMock.mockImplementation((): string => {
      throw new Error('not a git repository');
    });
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns an empty graph for a missing root', () => {
    const missing = join(root, 'does-not-exist');
    const graph = buildDocGraph(missing);
    expect(graph).toEqual<DocGraph>({ root: missing, nodes: [], edges: [] });
  });

  it('returns an empty graph when there are no docs', () => {
    mkdirSync(join(root, 'src', 'lib'), { recursive: true });
    writeFileSync(join(root, 'src', 'lib', 'code.ts'), 'export const x = 1;');
    const graph = buildDocGraph(root);
    expect(graph).toEqual<DocGraph>({ root, nodes: [], edges: [] });
  });

  it('indexes repo-root *.md and docs/** and skips excluded/non-docs trees', () => {
    write(root, 'README.md', '# Readme\n');
    write(root, 'docs/adding-a-recommendation.md', '# Adding\n');
    write(root, 'docs/adr/0001-first.md', '# ADR 1\n');
    // Not indexed: outside root/docs, or in excluded dirs.
    write(root, 'src/notes.md', '# should be ignored (not docs/, not root)\n');
    write(root, 'node_modules/pkg/README.md', '# ignored\n');
    write(root, '.worktrees/wt/docs/x.md', '# ignored\n');

    const graph = buildDocGraph(root);
    expect(graph.root).toBe(root);
    const slugs = graph.nodes.map((n) => n.path).sort();
    expect(slugs).toEqual([
      'README.md',
      'docs/adding-a-recommendation.md',
      'docs/adr/0001-first.md',
    ]);
  });

  it('resolves same-dir and ../ md-links across real files, and flags dangling', () => {
    write(root, 'docs/a.md', 'see [b](./b.md) and [ref](../REFERENCES.md) and [gone](missing.md)\n');
    write(root, 'docs/b.md', '# B\n');
    write(root, 'REFERENCES.md', '# refs\n');

    const graph = buildDocGraph(root);
    const links = graph.edges
      .filter((e) => e.kind === 'md-link' && e.from === 'docs/a')
      .map((e) => e.to)
      .sort();
    expect(links).toEqual(['REFERENCES', 'docs/b', 'docs/missing']);
    // 'docs/missing' is a dangling edge — no node with that slug exists.
    expect(graph.nodes.some((n) => n.slug === 'docs/missing')).toBe(false);
  });

  it('extracts issue-ref and src-ref edges over the whole file', () => {
    write(
      root,
      'REFERENCES.md',
      'Row: `src/lib/parse-sessions.ts` consumes it. Tracked in #2257 (epic #2256).\n'
    );
    const graph = buildDocGraph(root);
    const issue = graph.edges.filter((e) => e.kind === 'issue-ref');
    const src = graph.edges.filter((e) => e.kind === 'src-ref');
    expect(issue.map((e) => e.to).sort()).toEqual(['issue:2256', 'issue:2257']);
    expect(src.map((e) => e.to)).toEqual(['src:src/lib/parse-sessions.ts']);
  });

  it('parses frontmatter (present) and defaults to {} (absent)', () => {
    write(root, 'docs/with-fm.md', '---\ntitle: Has FM\nstatus: draft\n---\n\n# Body\n');
    write(root, 'docs/no-fm.md', '# No frontmatter\n\ntext\n');
    const graph = buildDocGraph(root);
    const withFm = graph.nodes.find((n) => n.slug === 'docs/with-fm');
    const noFm = graph.nodes.find((n) => n.slug === 'docs/no-fm');
    expect(withFm?.frontmatter).toEqual({ title: 'Has FM', status: 'draft' });
    expect(withFm?.headings).toEqual(['Body']);
    expect(noFm?.frontmatter).toEqual({});
  });

  it('carries an opt-in category: frontmatter value onto the node (declared-category input, #2472)', () => {
    write(root, 'docs/adr/0009-x.md', '---\ncategory: adr\n---\n\n# ADR 9\n');
    const graph = buildDocGraph(root);
    const n = graph.nodes.find((x) => x.slug === 'docs/adr/0009-x');
    // The declared value the detector reads, and the derived value it compares against.
    expect(n?.frontmatter['category']).toBe('adr');
    expect(n?.category).toBe('adr');
    // Frontmatter is stripped from the body, so headings are unaffected.
    expect(n?.headings).toEqual(['ADR 9']);
  });

  it('carries an empty top-level category onto the node for invalid-declaration detection', () => {
    write(root, 'docs/adr/0010-empty.md', '---\ncategory:\n---\n\n# Empty category\n');
    const graph = buildDocGraph(root);
    const n = graph.nodes.find((candidate) => candidate.path === 'docs/adr/0010-empty.md');

    expect(Object.hasOwn(n?.frontmatter ?? {}, 'category')).toBe(true);
    expect(n?.frontmatter['category']).toBe('');
  });

  it('derives a category per node and recognises declared indices + gitMtime', () => {
    write(root, 'REFERENCES.md', '# refs\n');
    write(root, 'docs/adr/0007-x.md', '# ADR 7\n');
    write(root, 'docs/competitive-analysis/README.md', '# tracker\n');
    write(root, 'docs/plans/plan-a.md', '# plan\n');

    const graph = buildDocGraph(root);
    const byslug = new Map(graph.nodes.map((n) => [n.slug, n]));

    expect(byslug.get('REFERENCES')?.category).toBe('root');
    expect(byslug.get('REFERENCES')?.indexKind).toBe('references');
    expect(byslug.get('docs/adr/0007-x')?.category).toBe('adr');
    expect(byslug.get('docs/adr/0007-x')?.indexKind).toBe('adr-sequence');
    expect(byslug.get('docs/adr/0007-x')?.ordinal).toBe(7);
    expect(byslug.get('docs/competitive-analysis/README')?.indexKind).toBe(
      'competitive-tracker'
    );
    expect(byslug.get('docs/plans/plan-a')?.category).toBe('plan');
    expect(byslug.get('docs/plans/plan-a')?.indexKind).toBeUndefined();

    // gitMtimeIso is best-effort: a temp dir is not a git repo, so it falls back
    // to the filesystem mtime — always a parseable ISO string here, never null.
    const mtime = byslug.get('REFERENCES')?.gitMtimeIso;
    expect(typeof mtime).toBe('string');
    expect(Number.isNaN(Date.parse(mtime as string))).toBe(false);
    // The fallback clock is explicitly labelled non-authoritative (#2707).
    expect(byslug.get('REFERENCES')?.gitMtimeProvenance).toBe('filesystem');
  });

  it('resolves every tracked mtime with one bounded git history query', () => {
    write(root, 'README.md', '# Readme\n');
    write(root, 'docs/a.md', '# A\n');
    write(root, 'docs/untracked.md', '# Untracked\n');
    execFileSyncMock.mockImplementation((_cmd, args?: readonly string[]): string => {
      if (args?.includes('--is-shallow-repository')) return 'false\n';
      if (args?.includes('status')) return '?? docs/untracked.md\0';
      return (
        'CHD-DATE:2026-07-14T10:00:00-04:00\0\0\nREADME.md\0' +
        'CHD-DATE:2026-07-13T09:00:00-04:00\0\0\ndocs/a.md\0'
      );
    });

    const graph = buildDocGraph(root);
    const byPath = new Map(graph.nodes.map((node) => [node.path, node]));

    // Context + bounded status + index flags + ONE batched history walk.
    expect(execFileSyncMock).toHaveBeenCalledTimes(4);
    expect(execFileSyncMock).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['-C', root, 'ls-files', '-v', '-z', '--full-name']),
      expect.objectContaining({ encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    );
    expect(execFileSyncMock).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining([
        '-C',
        root,
        'status',
        '--porcelain=v1',
        '-z',
        '--ignored=traditional',
      ]),
      expect.objectContaining({ encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    );
    expect(execFileSyncMock).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining([
        '-C',
        root,
        'log',
        '--max-count=4096',
        '--name-only',
        '-z',
        '--relative',
        '--',
        ':(glob)*.md',
        ':(glob)docs/**/*.md',
      ]),
      expect.objectContaining({ encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    );
    expect(byPath.get('README.md')?.gitMtimeIso).toBe(
      '2026-07-14T10:00:00-04:00'
    );
    expect(byPath.get('README.md')?.gitMtimeProvenance).toBe('git');
    expect(byPath.get('docs/a.md')?.gitMtimeIso).toBe(
      '2026-07-13T09:00:00-04:00'
    );
    expect(byPath.get('docs/a.md')?.gitMtimeProvenance).toBe('git');
    expect(Date.parse(byPath.get('docs/untracked.md')?.gitMtimeIso ?? '')).not.toBeNaN();
    expect(byPath.get('docs/untracked.md')?.gitMtimeProvenance).toBe('filesystem');
    expect(docGraphHasTransientGitHistoryFailure(graph)).toBe(false);
  });

  it('labels tracked worktree/index changes git-dirty and keeps untracked files non-authoritative', () => {
    const COMMIT = 'c'.repeat(40);
    write(root, 'README.md', '# Clean\n');
    write(root, 'docs/dirty.md', '# Dirty\n');
    write(root, 'docs/staged.md', '# Staged\n');
    write(root, 'docs/untracked.md', '# Untracked\n');
    write(root, 'docs/ignored.md', '# Ignored\n');
    const dirtyMtime = statSync(join(root, 'docs/dirty.md')).mtime.toISOString();
    const stagedMtime = statSync(join(root, 'docs/staged.md')).mtime.toISOString();
    write(
      root,
      'data/doc-git-times.json',
      JSON.stringify({
        schemaVersion: 2,
        sourceCommit: COMMIT,
        files: {
          'docs/dirty.md': '2025-01-01T00:00:00+00:00',
          'docs/staged.md': '2025-01-02T00:00:00+00:00',
        },
      })
    );
    execFileSyncMock.mockImplementation((_cmd, args?: readonly string[]): string => {
      if (args?.includes('--is-shallow-repository')) return 'false\n';
      if (args?.includes('status')) {
        return (
          ' M docs/dirty.md\0M  docs/staged.md\0' +
          '?? docs/untracked.md\0!! docs/ignored.md\0'
        );
      }
      return (
        'CHD-DATE:2026-07-14T10:00:00-04:00\0\0\nREADME.md\0' +
        'CHD-DATE:2024-01-01T00:00:00+00:00\0\0\ndocs/dirty.md\0' +
        'CHD-DATE:2024-01-02T00:00:00+00:00\0\0\ndocs/staged.md\0' +
        // A path can have deleted history even though the current file is untracked.
        'CHD-DATE:2024-01-03T00:00:00+00:00\0\0\ndocs/untracked.md\0' +
        'CHD-DATE:2024-01-04T00:00:00+00:00\0\0\ndocs/ignored.md\0'
      );
    });

    const graph = buildDocGraph(root, { docGitTimesExpectedCommit: COMMIT });
    const byPath = new Map(graph.nodes.map((node) => [node.path, node]));

    expect(byPath.get('README.md')?.gitMtimeProvenance).toBe('git');
    expect(byPath.get('docs/dirty.md')).toMatchObject({
      gitMtimeIso: dirtyMtime,
      gitMtimeProvenance: 'git-dirty',
    });
    expect(byPath.get('docs/staged.md')).toMatchObject({
      gitMtimeIso: stagedMtime,
      gitMtimeProvenance: 'git-dirty',
    });
    expect(byPath.get('docs/untracked.md')?.gitMtimeProvenance).toBe('filesystem');
    expect(byPath.get('docs/untracked.md')?.gitMtimeIso).not.toBe(
      '2024-01-03T00:00:00+00:00'
    );
    expect(byPath.get('docs/ignored.md')?.gitMtimeProvenance).toBe('filesystem');
    expect(byPath.get('docs/ignored.md')?.gitMtimeIso).not.toBe(
      '2024-01-04T00:00:00+00:00'
    );
    expect(execFileSyncMock).toHaveBeenCalledTimes(4);
    expect(
      execFileSyncMock.mock.calls.filter(([, args]) => args?.includes('status'))
    ).toHaveLength(1);
  });

  it('marks a copied destination dirty without demoting the unchanged source', () => {
    write(root, 'docs/source.md', '# Source\n');
    write(root, 'docs/copied.md', '# Source\n');
    execFileSyncMock.mockImplementation((_cmd, args?: readonly string[]): string => {
      if (args?.includes('--is-shallow-repository')) return 'false\n';
      if (args?.includes('status')) {
        return 'C  docs/copied.md\0docs/source.md\0';
      }
      return (
        'CHD-DATE:2024-01-01T00:00:00+00:00\0\0\ndocs/source.md\0' +
        'CHD-DATE:2024-01-02T00:00:00+00:00\0\0\ndocs/copied.md\0'
      );
    });

    const byPath = new Map(
      buildDocGraph(root).nodes.map((candidate) => [candidate.path, candidate])
    );

    expect(byPath.get('docs/copied.md')?.gitMtimeProvenance).toBe('git-dirty');
    expect(byPath.get('docs/source.md')?.gitMtimeProvenance).toBe('git');
  });

  it('demotes tracked docs hidden by assume-unchanged or skip-worktree flags', () => {
    write(root, 'docs/assumed.md', '# Assumed\n');
    write(root, 'docs/skipped.md', '# Skipped\n');
    execFileSyncMock.mockImplementation((_cmd, args?: readonly string[]): string => {
      if (args?.includes('--is-shallow-repository')) return 'false\n';
      if (args?.includes('status')) return '';
      if (args?.includes('ls-files')) {
        return 'h docs/assumed.md\0S docs/skipped.md\0';
      }
      return (
        'CHD-DATE:2024-01-01T00:00:00+00:00\0\0\ndocs/assumed.md\0' +
        'CHD-DATE:2024-01-02T00:00:00+00:00\0\0\ndocs/skipped.md\0'
      );
    });

    const byPath = new Map(
      buildDocGraph(root).nodes.map((candidate) => [candidate.path, candidate])
    );

    expect(byPath.get('docs/assumed.md')?.gitMtimeProvenance).toBe('git-dirty');
    expect(byPath.get('docs/skipped.md')?.gitMtimeProvenance).toBe('git-dirty');
  });

  it('normalizes repo-root porcelain paths when the graph root is nested', () => {
    write(root, 'docs/a.md', '# A\n');
    execFileSyncMock.mockImplementation((_cmd, args?: readonly string[]): string => {
      if (args?.includes('--is-shallow-repository')) return 'package/\nfalse\n';
      if (args?.includes('status')) return ' M package/docs/a.md\0';
      return 'CHD-DATE:2024-01-01T00:00:00+00:00\0\0\ndocs/a.md\0';
    });

    const node = buildDocGraph(root).nodes.find((candidate) => candidate.path === 'docs/a.md');

    expect(node?.gitMtimeProvenance).toBe('git-dirty');
    expect(node?.gitMtimeIso).not.toBe('2024-01-01T00:00:00+00:00');
  });

  it('normalizes repo-root index-flag paths when the graph root is nested', () => {
    write(root, 'docs/a.md', '# A\n');
    execFileSyncMock.mockImplementation((_cmd, args?: readonly string[]): string => {
      if (args?.includes('--is-shallow-repository')) return 'package/\nfalse\n';
      if (args?.includes('status')) return '';
      if (args?.includes('ls-files')) return 'S package/docs/a.md\0';
      return 'CHD-DATE:2024-01-01T00:00:00+00:00\0\0\ndocs/a.md\0';
    });

    const node = buildDocGraph(root).nodes.find(
      (candidate) => candidate.path === 'docs/a.md'
    );

    expect(node?.gitMtimeProvenance).toBe('git-dirty');
    expect(node?.gitMtimeIso).not.toBe('2024-01-01T00:00:00+00:00');
  });

  it('suppresses live and manifest authority when status fails in a known repo', () => {
    const COMMIT = 'd'.repeat(40);
    write(root, 'README.md', '# Readme\n');
    write(
      root,
      'data/doc-git-times.json',
      JSON.stringify({
        schemaVersion: 2,
        sourceCommit: COMMIT,
        files: { 'README.md': '2026-01-05T10:00:00+00:00' },
      })
    );
    execFileSyncMock.mockImplementation((_cmd, args?: readonly string[]): string => {
      if (args?.includes('--is-shallow-repository')) return 'false\n';
      if (args?.includes('status')) throw new Error('status failed');
      return 'CHD-DATE:2026-07-14T10:00:00-04:00\0\0\nREADME.md\0';
    });

    const graph = buildDocGraph(root, { docGitTimesExpectedCommit: COMMIT });
    const node = graph.nodes[0];

    expect(node?.gitMtimeProvenance).toBe('filesystem');
    expect(node?.gitMtimeIso).not.toBe('2026-01-05T10:00:00+00:00');
    expect(docGraphHasTransientGitHistoryFailure(graph)).toBe(true);
    expect(execFileSyncMock).toHaveBeenCalledTimes(2);
    expect(execFileSyncMock.mock.calls.some(([, args]) => args?.includes('log'))).toBe(false);
  });

  it('rejects a same-HEAD manifest when Git probing fails inside a repository', () => {
    const COMMIT = 'e'.repeat(40);
    mkdirSync(join(root, '.git'), { recursive: true });
    write(root, 'README.md', '# Dirty bytes\n');
    write(
      root,
      'data/doc-git-times.json',
      JSON.stringify({
        schemaVersion: 2,
        sourceCommit: COMMIT,
        files: { 'README.md': '2026-01-05T10:00:00+00:00' },
      })
    );

    const graph = buildDocGraph(root, { docGitTimesExpectedCommit: COMMIT });
    const node = graph.nodes[0];

    expect(node?.gitMtimeProvenance).toBe('filesystem');
    expect(node?.gitMtimeIso).not.toBe('2026-01-05T10:00:00+00:00');
    expect(docGraphHasTransientGitHistoryFailure(graph)).toBe(true);
  });

  it('marks a candidate uncacheable when assembly observes a different status identity', () => {
    write(root, 'README.md', '# Readme\n');
    execFileSyncMock.mockImplementation((_cmd, args?: readonly string[]): string => {
      if (args?.includes('--is-shallow-repository')) return 'false\n';
      if (args?.includes('status')) return '';
      return 'CHD-DATE:2026-07-14T10:00:00-04:00\0\0\nREADME.md\0';
    });

    const graph = buildDocGraph(root, {
      expectedGitWorkingTreeSignature: 'ok:prefix::status: M README.md\0',
    });

    expect(graph.nodes[0]?.gitMtimeProvenance).toBe('git');
    expect(docGraphHasTransientGitHistoryFailure(graph)).toBe(true);
    expect(Object.keys(graph)).toEqual(['root', 'nodes', 'edges']);
  });

  it('fails closed when a bounded history walk returns partial stdout', () => {
    const commit = 'c'.repeat(40);
    const filesystemTime = new Date('2026-01-06T11:00:00.000Z');
    write(root, 'README.md', '# Readme\n');
    write(root, 'docs/older.md', '# Older\n');
    utimesSync(join(root, 'docs/older.md'), filesystemTime, filesystemTime);
    write(
      root,
      'data/doc-git-times.json',
      JSON.stringify({
        schemaVersion: 2,
        sourceCommit: commit,
        files: { 'README.md': '2026-01-05T10:00:00+00:00' },
      })
    );
    execFileSyncMock.mockImplementation((_cmd, args?: readonly string[]): string => {
      if (args?.includes('--is-shallow-repository')) return 'false\n';
      if (args?.includes('status')) return '';
      if (args?.includes('ls-files')) return 'H README.md\0H docs/older.md\0';
      throw Object.assign(new Error('missing historical tree'), {
        stdout:
          'CHD-DATE:2026-07-14T10:00:00-04:00\0\0\nREADME.md\0' +
          'CHD-DATE:2026-07-13T09:00:00-04:00\0\0\ndocs/older.md\0',
      });
    });

    const graph = buildDocGraph(root, { docGitTimesExpectedCommit: commit });
    const byPath = new Map(graph.nodes.map((node) => [node.path, node]));

    expect(execFileSyncMock).toHaveBeenCalledTimes(4);
    expect(byPath.get('README.md')).toMatchObject({
      gitMtimeIso: '2026-01-05T10:00:00+00:00',
      gitMtimeProvenance: 'manifest',
    });
    expect(byPath.get('docs/older.md')).toMatchObject({
      gitMtimeIso: filesystemTime.toISOString(),
      gitMtimeProvenance: 'filesystem',
    });
    expect(docGraphHasTransientGitHistoryFailure(graph)).toBe(true);
    expect(Object.keys(graph)).toEqual(['root', 'nodes', 'edges']);
  });

  it('never trusts live history in a SHALLOW checkout (#2707)', () => {
    write(root, 'README.md', '# Readme\n');
    execFileSyncMock.mockImplementation((_cmd, args?: readonly string[]): string => {
      if (args?.includes('--is-shallow-repository')) return 'true\n';
      if (args?.includes('status')) return '';
      // The batched log would happily return grafted boundary-commit times —
      // it must never be consulted.
      return 'CHD-DATE:2026-07-14T10:00:00-04:00\0\0\nREADME.md\0';
    });

    const graph = buildDocGraph(root);

    expect(execFileSyncMock).toHaveBeenCalledTimes(3); // context + status + flags, no log
    const node = graph.nodes.find((n) => n.path === 'README.md');
    expect(node?.gitMtimeProvenance).toBe('filesystem');
    expect(node?.gitMtimeIso).not.toBe('2026-07-14T10:00:00-04:00');
  });

  describe('packaged git-times manifest join (#2707)', () => {
    const COMMIT = 'c'.repeat(40);

    const writeManifest = (files: Record<string, string>, overrides = {}) => {
      write(
        root,
        'data/doc-git-times.json',
        JSON.stringify({
          schemaVersion: 2,
          sourceCommit: COMMIT,
          files,
          ...overrides,
        })
      );
    };

    it('carries manifest provenance when no .git exists and the commit binds', () => {
      write(root, 'README.md', '# Readme\n');
      write(root, 'docs/extra.md', '# Not in manifest\n');
      writeManifest({ 'README.md': '2026-01-05T10:00:00+00:00' });

      const graph = buildDocGraph(root, { docGitTimesExpectedCommit: COMMIT });
      const byPath = new Map(graph.nodes.map((n) => [n.path, n]));

      expect(byPath.get('README.md')?.gitMtimeIso).toBe('2026-01-05T10:00:00+00:00');
      expect(byPath.get('README.md')?.gitMtimeProvenance).toBe('manifest');
      expect(docGraphHasTransientGitHistoryFailure(graph)).toBe(false);
      // A doc absent from the manifest degrades honestly to filesystem.
      expect(byPath.get('docs/extra.md')?.gitMtimeProvenance).toBe('filesystem');
      // The manifest itself is not a doc node (data/ is outside the doc walk).
      expect(byPath.has('data/doc-git-times.json')).toBe(false);
    });

    it('stats, reads, and parses one pinned manifest once across identity and graph join', () => {
      const manifestPath = join(root, 'data/doc-git-times.json');
      const originalTime = '2026-01-05T10:00:00+00:00';
      const replacementTime = '2026-02-06T11:00:00+00:00';
      write(root, 'README.md', '# Readme\n');
      writeManifest({ 'README.md': originalTime });

      const jsonParse = vi.spyOn(JSON, 'parse');
      try {
        const snapshot = captureDocGitTimesSnapshot(root, {
          docGitTimesExpectedCommit: COMMIT,
        });

        expect(fsCalls.statPaths.filter((path) => path === manifestPath)).toHaveLength(1);
        expect(fsCalls.openPaths.filter((path) => path === manifestPath)).toHaveLength(0);

        const loaded = snapshot.load();
        expect(loaded.raw).toContain(originalTime);
        expect(snapshot.load()).toBe(loaded);
        expect(jsonParse).toHaveBeenCalledTimes(1);

        // A replacement after the load cannot split the content hash's bytes
        // from the graph join: both later consumers stay pinned to `loaded`.
        writeManifest({ 'README.md': replacementTime });
        const graph = buildDocGraph(root, { docGitTimesSnapshot: snapshot });
        const node = graph.nodes.find((candidate) => candidate.path === 'README.md');

        expect(node?.gitMtimeIso).toBe(originalTime);
        expect(node?.gitMtimeProvenance).toBe('manifest');
        expect(fsCalls.statPaths.filter((path) => path === manifestPath)).toHaveLength(1);
        expect(fsCalls.openPaths.filter((path) => path === manifestPath)).toHaveLength(1);
        expect(jsonParse).toHaveBeenCalledTimes(1);
        expect(fsCalls.statPaths.filter((path) => path === join(root, 'README.md'))).toHaveLength(1);
      } finally {
        jsonParse.mockRestore();
      }
    });

    it('binds via the CHD_DOC_GIT_TIMES_EXPECTED_COMMIT env seam', () => {
      write(root, 'README.md', '# Readme\n');
      writeManifest({ 'README.md': '2026-01-05T10:00:00+00:00' });
      vi.stubEnv('CHD_DOC_GIT_TIMES_EXPECTED_COMMIT', COMMIT);
      try {
        const graph = buildDocGraph(root);
        expect(graph.nodes[0]?.gitMtimeProvenance).toBe('manifest');
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('shares the empty feature-env to GIT_SHA fallback without bypassing explicit overrides', () => {
      write(root, 'README.md', '# Readme\n');
      writeManifest({ 'README.md': '2026-01-05T10:00:00+00:00' });
      vi.stubEnv('CHD_DOC_GIT_TIMES_EXPECTED_COMMIT', '');
      vi.stubEnv('GIT_SHA', COMMIT);
      try {
        expect(buildDocGraph(root).nodes[0]?.gitMtimeProvenance).toBe(
          'manifest'
        );
        expect(
          buildDocGraph(root, { docGitTimesExpectedCommit: '' }).nodes[0]
            ?.gitMtimeProvenance
        ).toBe('filesystem');
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('never promotes Docker mtime: a commit-mismatched manifest is ignored', () => {
      write(root, 'README.md', '# Readme\n');
      writeManifest({ 'README.md': '2026-01-05T10:00:00+00:00' });

      const graph = buildDocGraph(root, {
        docGitTimesExpectedCommit: 'd'.repeat(40),
      });
      const node = graph.nodes.find((n) => n.path === 'README.md');
      expect(node?.gitMtimeProvenance).toBe('filesystem');
      expect(node?.gitMtimeIso).not.toBe('2026-01-05T10:00:00+00:00');
    });

    it('fails closed on an unbound, legacy-schema, or malformed manifest', () => {
      write(root, 'README.md', '# Readme\n');

      writeManifest({ 'README.md': '2026-01-05T10:00:00+00:00' });
      expect(
        buildDocGraph(root, { docGitTimesExpectedCommit: null }).nodes[0]
          ?.gitMtimeProvenance
      ).toBe('filesystem');

      writeManifest({ 'README.md': '2026-01-05T10:00:00+00:00' }, { schemaVersion: 1 });
      expect(
        buildDocGraph(root, { docGitTimesExpectedCommit: COMMIT }).nodes[0]
          ?.gitMtimeProvenance
      ).toBe('filesystem');

      write(root, 'data/doc-git-times.json', '{not json');
      expect(
        buildDocGraph(root, { docGitTimesExpectedCommit: COMMIT }).nodes[0]
          ?.gitMtimeProvenance
      ).toBe('filesystem');
    });

    it('prefers live non-shallow git history over a valid manifest', () => {
      write(root, 'README.md', '# Readme\n');
      writeManifest({ 'README.md': '2026-01-05T10:00:00+00:00' });
      execFileSyncMock.mockImplementation((_cmd, args?: readonly string[]): string => {
        if (args?.includes('--is-shallow-repository')) return 'false\n';
        if (args?.includes('status')) return '';
        return 'CHD-DATE:2026-07-14T10:00:00-04:00\0\0\nREADME.md\0';
      });

      const graph = buildDocGraph(root, { docGitTimesExpectedCommit: COMMIT });
      const node = graph.nodes.find((n) => n.path === 'README.md');
      expect(node?.gitMtimeIso).toBe('2026-07-14T10:00:00-04:00');
      expect(node?.gitMtimeProvenance).toBe('git');
    });
  });

  it('produces deterministic, sorted, de-duplicated output', () => {
    write(root, 'docs/a.md', 'link [b](b.md) and [b again](./b.md); #10 #10\n');
    write(root, 'docs/b.md', '# B\n');
    const g1 = buildDocGraph(root);
    const g2 = buildDocGraph(root);
    expect(g1).toEqual(g2);
    // De-dup: the two links to b.md collapse to one md-link edge; #10 twice -> one.
    expect(g1.edges.filter((e) => e.kind === 'md-link' && e.from === 'docs/a')).toHaveLength(1);
    expect(g1.edges.filter((e) => e.kind === 'issue-ref' && e.from === 'docs/a')).toHaveLength(1);
  });
});
