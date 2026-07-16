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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { execFileSyncMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn((): string => {
    throw new Error('not a git repository');
  }),
}));

vi.mock('node:child_process', () => ({ execFileSync: execFileSyncMock }));
import {
  buildDocGraph,
  classifyIndex,
  deriveCategory,
  extractHeadings,
  extractIssueRefs,
  extractMarkdownLinkTargets,
  extractSrcRefs,
  parseFrontmatter,
  resolveDocLink,
  slugForPath,
  type DocGraph,
} from './parse-docs';

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
    execFileSyncMock.mockImplementation((_cmd, args?: readonly string[]): string =>
      args?.includes('--is-shallow-repository')
        ? 'false\n'
        : 'CHD-DATE:2026-07-14T10:00:00-04:00\0\0\nREADME.md\0' +
          'CHD-DATE:2026-07-13T09:00:00-04:00\0\0\ndocs/a.md\0'
    );

    const graph = buildDocGraph(root);
    const byPath = new Map(graph.nodes.map((node) => [node.path, node]));

    // Exactly two git children: the shallow probe (#2707), then ONE batched log.
    expect(execFileSyncMock).toHaveBeenCalledTimes(2);
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
  });

  it('preserves git mtimes emitted before a bounded history walk fails', () => {
    write(root, 'README.md', '# Readme\n');
    write(root, 'docs/older.md', '# Older\n');
    execFileSyncMock.mockImplementation((_cmd, args?: readonly string[]): string => {
      if (args?.includes('--is-shallow-repository')) return 'false\n';
      throw Object.assign(new Error('missing historical tree'), {
        stdout: 'CHD-DATE:2026-07-14T10:00:00-04:00\0\0\nREADME.md\0',
      });
    });

    const graph = buildDocGraph(root);
    const byPath = new Map(graph.nodes.map((node) => [node.path, node]));

    expect(execFileSyncMock).toHaveBeenCalledTimes(2);
    expect(byPath.get('README.md')?.gitMtimeIso).toBe(
      '2026-07-14T10:00:00-04:00'
    );
    expect(byPath.get('README.md')?.gitMtimeProvenance).toBe('git');
    expect(
      Date.parse(byPath.get('docs/older.md')?.gitMtimeIso ?? '')
    ).not.toBeNaN();
    expect(byPath.get('docs/older.md')?.gitMtimeProvenance).toBe('filesystem');
  });

  it('never trusts live history in a SHALLOW checkout (#2707)', () => {
    write(root, 'README.md', '# Readme\n');
    execFileSyncMock.mockImplementation((_cmd, args?: readonly string[]): string => {
      if (args?.includes('--is-shallow-repository')) return 'true\n';
      // The batched log would happily return grafted boundary-commit times —
      // it must never be consulted.
      return 'CHD-DATE:2026-07-14T10:00:00-04:00\0\0\nREADME.md\0';
    });

    const graph = buildDocGraph(root);

    expect(execFileSyncMock).toHaveBeenCalledTimes(1); // probe only, no log
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
          schemaVersion: 1,
          sourceCommit: COMMIT,
          complete: true,
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
      // A doc absent from the manifest degrades honestly to filesystem.
      expect(byPath.get('docs/extra.md')?.gitMtimeProvenance).toBe('filesystem');
      // The manifest itself is not a doc node (data/ is outside the doc walk).
      expect(byPath.has('data/doc-git-times.json')).toBe(false);
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

    it('fails closed on an unbound (no runtime commit), partial, or malformed manifest', () => {
      write(root, 'README.md', '# Readme\n');

      writeManifest({ 'README.md': '2026-01-05T10:00:00+00:00' });
      expect(
        buildDocGraph(root, { docGitTimesExpectedCommit: null }).nodes[0]
          ?.gitMtimeProvenance
      ).toBe('filesystem');

      writeManifest({ 'README.md': '2026-01-05T10:00:00+00:00' }, { complete: false });
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
      execFileSyncMock.mockImplementation((_cmd, args?: readonly string[]): string =>
        args?.includes('--is-shallow-repository')
          ? 'false\n'
          : 'CHD-DATE:2026-07-14T10:00:00-04:00\0\0\nREADME.md\0'
      );

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
