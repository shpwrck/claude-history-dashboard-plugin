import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  detector,
  parseFreshnessDurationMs,
  readFreshnessContract,
  evaluateDeclaredFreshness,
  FRESHNESS_WARN_KEY,
  FRESHNESS_ERROR_KEY,
} from './doc-hygiene';
import { validateRecommendationProvenance } from '../provenance';
import type { RecommendationInput } from '../types';
import { parseFrontmatter, buildDocGraph } from '../../parse-docs';
import type { DocEdge, DocGraph, DocNode } from '../../parse-docs';
import { isDocCategory } from '../../doc-contract';
import type { RepoMapDataset, RepoMapProjectJoin } from '../../parse-repo-map-join';
import type { RepoSymbol } from '../../repo-map/types';
import type { DocHygieneArtifact } from '../../doc-hygiene-artifact';
import { parseDocsMap } from '../../parse-docs-map';
import type { DocsMapArtifact } from '../../parse-docs-map';

// ── Fixture builders ───────────────────────────────────────────────────────

function node(slug: string, over: Partial<DocNode> = {}): DocNode {
  return {
    slug,
    path: `${slug}.md`,
    category: 'doc',
    frontmatter: {},
    headings: [],
    gitMtimeIso: null,
    ...over,
  };
}

const mdLink = (from: string, to: string): DocEdge => ({ from, to, kind: 'md-link' });
const srcRef = (from: string, path: string): DocEdge => ({
  from,
  to: `src:${path}`,
  kind: 'src-ref',
});

const graph = (
  nodes: DocNode[],
  edges: DocEdge[] = [],
  root = '/repo'
): DocGraph => ({ root, nodes, edges });

function repoMap(paths: string[], over: Record<string, unknown> = {}): RepoMapDataset {
  return {
    projects: [
      {
        root: '/repo',
        generatedAtGitSha: 'abc1234',
        fileCount: paths.length,
        truncated: false,
        text: '',
        files: paths.map((p) => ({
          path: p,
          symbols: [],
          imports: [],
          configSections: [],
          recommendations: [],
        })),
        configSections: [],
        configAttribution: [],
        ...over,
      },
    ],
  } as unknown as RepoMapDataset;
}

function run(
  docGraph: DocGraph | null | undefined,
  rm?: RepoMapDataset | null,
  docHygieneArtifact?: DocHygieneArtifact | null,
  now = 0,
  docsMap?: DocsMapArtifact | null
) {
  const input = {
    docGraph,
    repoMap: rm,
    docHygieneArtifact,
    docsMap,
  } as unknown as RecommendationInput;
  return detector.rule(input, now);
}

// ── docs-map fixtures (#2489) ───────────────────────────────────────────────

const DOCS_MAP_REPO = 'shpwrck/claude-history-dashboard';
const DOCS_MAP_COMMIT = 'a'.repeat(40);

/** A validated `DocsMapArtifact` wrapper around a small hand-built map, with
 *  the wrapper identity defaulted to match `repoMapProject`'s defaults below.
 *  Symbols default to `[]` (a file-level binding) when omitted. */
function docsMapWrapper(
  documents: Record<string, { sources: { path: string; symbols?: string[] }[] }>,
  over: Partial<{ repository: string | null; commit: string | null }> = {}
): DocsMapArtifact {
  return {
    map: {
      version: 1,
      repository: DOCS_MAP_REPO,
      documents: Object.fromEntries(
        Object.entries(documents).map(([path, doc]) => [
          path,
          { sources: doc.sources.map((s) => ({ path: s.path, symbols: s.symbols ?? [] })) },
        ])
      ),
    },
    repository: 'repository' in over ? over.repository! : DOCS_MAP_REPO,
    commit: 'commit' in over ? over.commit! : DOCS_MAP_COMMIT,
  };
}

function symbol(name: string): RepoSymbol {
  return { name, kind: 'function', exported: true, signature: `function ${name}()`, line: 1 };
}

/** One repo-map project, identity-matching `docsMapWrapper`'s defaults unless
 *  overridden. Files carry named symbols (default `[]`). */
function repoMapProject(
  files: { path: string; symbols?: string[] }[],
  over: Record<string, unknown> = {}
): RepoMapProjectJoin {
  return {
    root: '/repo',
    generatedAtGitSha: DOCS_MAP_COMMIT,
    repository: DOCS_MAP_REPO,
    fileCount: files.length,
    truncated: false,
    text: '',
    files: files.map((f) => ({
      path: f.path,
      symbols: (f.symbols ?? []).map(symbol),
      imports: [],
      configSections: [],
      recommendations: [],
    })),
    configSections: [],
    configAttribution: [],
    ...over,
  } as unknown as RepoMapProjectJoin;
}

function repoMapDataset(projects: RepoMapProjectJoin[]): RepoMapDataset {
  return { projects } as unknown as RepoMapDataset;
}

function lycheeArtifact(
  findings: DocHygieneArtifact['findings'] = []
): DocHygieneArtifact {
  return {
    schemaVersion: 1,
    generatedAt: '2026-07-13T00:00:00.000Z',
    repo: {
      identity: 'claude-history-dashboard',
      root: '/host/claude-history-dashboard',
      commit: 'abcdef1234567890',
      markdownFiles: 140,
    },
    summary: {
      score: findings.length ? 0 : 10,
      findingCount: findings.length,
      errorCount: 0,
      warningCount: findings.length,
    },
    checks: [
      {
        name: 'lychee.local-links',
        tool: 'lychee',
        toolVersion: '0.24.2',
        status: 'completed',
        score: findings.length ? 0 : 10,
        reason: findings.length ? 'Local links failed' : 'Local links clean',
        findingIds: findings.map((finding) => finding.id),
      },
    ],
    findings,
    skipped: [],
  };
}

function localLinkFinding(
  over: Partial<DocHygieneArtifact['findings'][number]> = {}
): DocHygieneArtifact['findings'][number] {
  return {
    id: 'doc-link:lychee.local-links:abc123',
    check: 'lychee.local-links',
    signal: 'broken-internal-link',
    severity: 'warning',
    path: 'docs/a.md',
    line: 17,
    target: 'docs/gone.md#install',
    message: 'Cannot find file',
    source: { tool: 'lychee', field: 'error_map[].span' },
    ...over,
  };
}

function agentsLintArtifact(findings: DocHygieneArtifact['findings']): DocHygieneArtifact {
  return {
    schemaVersion: 1,
    generatedAt: '2026-07-15T00:00:00.000Z',
    repo: {
      identity: 'claude-history-dashboard',
      root: '/host/claude-history-dashboard',
      commit: 'abcdef1234567890',
      markdownFiles: 140,
    },
    summary: {
      score: findings.length ? 8 : 10,
      findingCount: findings.length,
      errorCount: findings.filter((finding) => finding.severity === 'error').length,
      warningCount: findings.filter((finding) => finding.severity === 'warning').length,
    },
    checks: [
      {
        name: 'agents-lint.context-refs',
        tool: 'agents-lint',
        toolVersion: '0.5.0',
        status: 'completed-with-adapter',
        score: findings.length ? 8 : 10,
        reason: findings.length ? 'Context references failed' : 'Context references clean',
        findingIds: findings.map((finding) => finding.id),
      },
    ],
    findings,
    skipped: [],
  };
}

function agentsLintFinding(
  over: Partial<DocHygieneArtifact['findings'][number]> = {},
): DocHygieneArtifact['findings'][number] {
  return {
    id: 'context-ref:agents-lint.context-refs:abc123',
    check: 'agents-lint.context-refs',
    signal: 'missing-path',
    severity: 'error',
    path: 'REFERENCES.md',
    line: 42,
    target: 'src/lib/parse-retired.ts',
    message: 'Path does not exist: "src/lib/parse-retired.ts"',
    source: {
      tool: 'agents-lint',
      field: 'reports[].results[checker=filesystem].issues[rule=no-missing-path]',
    },
    ...over,
  };
}

// A root/README entry point, used to satisfy the orphan cross-link guard without
// itself being flagged.
const readme = () => node('README', { category: 'root', path: 'README.md' });

// ── Silence cases ──────────────────────────────────────────────────────────

describe('maintenance.doc-hygiene — silence', () => {
  it('emits nothing when the doc graph is absent', () => {
    expect(run(null)).toBeNull();
    expect(run(undefined)).toBeNull();
  });

  it('emits nothing on an empty doc graph', () => {
    expect(run(graph([]))).toBeNull();
    expect(run(graph([], []))).toBeNull();
  });

  it('stays silent on a clean, cross-linked corpus', () => {
    const clean = graph(
      [node('docs/a'), node('docs/b')],
      [mdLink('docs/a', 'docs/b'), mdLink('docs/b', 'docs/a')]
    );
    expect(run(clean)).toBeNull();
  });
});

// ── Signal 1: broken-internal-link ─────────────────────────────────────────

describe('maintenance.doc-hygiene — broken-internal-link (signal 1)', () => {
  it('flags an in-scope md-link whose target doc is not on disk (red)', () => {
    const rec = run(graph([node('docs/a')], [mdLink('docs/a', 'docs/gone')]));
    expect(rec).not.toBeNull();
    expect(rec!.affected).toBe(1);
    expect(rec!.severity).toBe('warning'); // structural breakage
    expect(rec!.evidence![0]).toContain('docs/gone.md');
    expect(rec!.evidence![0]).toContain('broken internal doc link or fragment');
  });

  it('does not flag a link that resolves to a real doc (green)', () => {
    const ok = graph(
      [node('docs/a'), node('docs/b')],
      [mdLink('docs/a', 'docs/b'), mdLink('docs/b', 'docs/a')]
    );
    expect(run(ok)).toBeNull();
  });

  it('does not flag a link that lands outside the walked doc namespace', () => {
    // A link resolving to a `src/…` slug was never walked, so absence is unknown
    // — not broken. (No resolved md-link ⇒ orphan detection is also skipped.)
    const g = graph([node('docs/a')], [mdLink('docs/a', 'src/lib/foo')]);
    expect(run(g)).toBeNull();
  });
});

describe('maintenance.doc-hygiene — host Lychee artifact merge (#2486)', () => {
  it('emits an artifact-only local-link finding with its exact line span', () => {
    const rec = run(null, null, lycheeArtifact([localLinkFinding()]));

    expect(rec).not.toBeNull();
    expect(rec!.affected).toBe(1);
    expect(rec!.evidence).toEqual([
      'docs/a.md:17 -> docs/gone.md#install — broken internal doc link or fragment',
    ]);
    expect(rec!.provenance!.observations).toEqual([
      expect.objectContaining({
        source: 'doc-hygiene artifact',
        value: 1,
      }),
    ]);
    expect(validateRecommendationProvenance(rec!)).toEqual([]);
  });

  it('deduplicates the graph copy in favor of Lychee line evidence', () => {
    const g = graph([node('docs/a')], [mdLink('docs/a', 'docs/gone')]);
    const rec = run(g, null, lycheeArtifact([localLinkFinding()]));

    expect(rec).not.toBeNull();
    expect(rec!.affected).toBe(1);
    expect(rec!.evidence![0]).toContain('docs/a.md:17');
    expect(rec!.provenance!.observations.map((row) => row.source)).toEqual([
      'doc-hygiene artifact',
    ]);
  });

  it('deduplicates URI-escaped graph targets against decoded Lychee paths', () => {
    const g = graph(
      [node('docs/a')],
      [mdLink('docs/a', 'docs/gone%20doc')]
    );
    const finding = localLinkFinding({ target: 'docs/gone doc.md' });
    const rec = run(g, null, lycheeArtifact([finding]));

    expect(rec).not.toBeNull();
    expect(rec!.affected).toBe(1);
    expect(rec!.evidence).toEqual([
      'docs/a.md:17 -> docs/gone doc.md — broken internal doc link or fragment',
    ]);
    expect(rec!.provenance!.observations.map((row) => row.source)).toEqual([
      'doc-hygiene artifact',
    ]);
  });

  it('reports a fragment-only failure without claiming the target file is missing', () => {
    const existingTarget = localLinkFinding({
      id: 'doc-link:lychee.local-links:fragment123',
      target: 'docs/b.md#missing-heading',
      message: 'Fragment not found',
    });
    const linked = graph(
      [node('docs/a'), node('docs/b')],
      [mdLink('docs/a', 'docs/b'), mdLink('docs/b', 'docs/a')]
    );
    const rec = run(linked, null, lycheeArtifact([existingTarget]));

    expect(rec).not.toBeNull();
    expect(rec!.affected).toBe(1);
    expect(rec!.evidence![0]).toContain('broken internal doc link or fragment');
    expect(rec!.evidence![0]).not.toContain('missing file');
  });

  it('stays silent when both graph and normalized artifact are clean', () => {
    expect(run(null, null, lycheeArtifact())).toBeNull();
    expect(run(graph([]), null, lycheeArtifact())).toBeNull();
  });

  it('ignores external and non-local-link artifact findings', () => {
    const external = localLinkFinding({
      id: 'doc-link:lychee.external-links:def456',
      check: 'lychee.external-links',
      signal: 'broken-external-link',
      target: 'https://example.invalid',
    });
    expect(run(null, null, lycheeArtifact([external]))).toBeNull();
  });
});

describe('maintenance.doc-hygiene — adapted agents-lint context refs (#2487)', () => {
  it('keeps unique non-src paths and npm-script drift as auditable evidence', () => {
    const npmFinding = agentsLintFinding({
      id: 'context-ref:agents-lint.context-refs:def456',
      signal: 'missing-npm-script',
      severity: 'warning',
      path: 'AGENTS.md',
      line: 73,
      target: 'npm run missing-script',
      message: 'Script "missing-script" is mentioned but not found in any package.json',
      source: {
        tool: 'agents-lint',
        field: 'reports[].results[checker=npm-scripts].issues[rule=no-missing-script]',
      },
    });
    const composeFinding = agentsLintFinding({
      id: 'context-ref:agents-lint.context-refs:ghi789',
      path: 'CLAUDE.md',
      line: 21,
      target: 'docker-compose.retired.yml',
      message: 'Path does not exist: "docker-compose.retired.yml"',
    });

    const rec = run(null, null, agentsLintArtifact([npmFinding, composeFinding]));

    expect(rec).not.toBeNull();
    expect(rec!.affected).toBe(2);
    expect(rec!.evidence).toEqual([
      'AGENTS.md:73 -> npm run missing-script — npm script no longer exists',
      'CLAUDE.md:21 -> docker-compose.retired.yml — context file reference no longer exists',
    ]);
    expect(rec!.provenance!.observations).toEqual([
      expect.objectContaining({
        source: 'doc-hygiene artifact',
        field: 'findings[check=agents-lint.context-refs].{id,signal,path,line,target,source}',
        value: 2,
      }),
    ]);
    expect(validateRecommendationProvenance(rec!)).toEqual([]);
  });

  it('deduplicates an identical dangling-src-ref in favor of agents-lint line evidence', () => {
    const refDoc = node('REFERENCES', {
      category: 'root',
      path: 'REFERENCES.md',
      indexKind: 'references',
    });
    const g = graph([refDoc], [srcRef('REFERENCES', 'src/lib/parse-retired.ts')]);
    const rec = run(
      g,
      repoMap(['src/lib/parse-docs.ts']),
      agentsLintArtifact([
        agentsLintFinding(),
        agentsLintFinding({
          id: 'context-ref:agents-lint.context-refs:duplicate',
          line: 99,
          target: './src/lib/parse-retired.ts',
        }),
      ]),
    );

    expect(rec).not.toBeNull();
    expect(rec!.affected).toBe(1);
    expect(rec!.evidence).toEqual([
      'REFERENCES.md:42 -> src/lib/parse-retired.ts — source reference no longer exists',
    ]);
    expect(rec!.provenance!.observations.map((row) => row.source)).toEqual([
      'doc-hygiene artifact',
    ]);
    expect(rec!.provenance!.inference).toContain(
      'adapted source references use the commit-bound host checker'
    );
    expect(rec!.provenance!.inference).not.toContain(
      'dangling source references are cross-checked'
    );
    expect(validateRecommendationProvenance(rec!)).toEqual([]);
  });

  it('ignores unsupported agents-lint advice that bypasses the adapter contract', () => {
    const unrelated = agentsLintFinding({
      signal: 'missing-section',
      target: 'Testing',
    });
    expect(run(null, null, agentsLintArtifact([unrelated]))).toBeNull();

    const wrongSourceField = agentsLintFinding({
      source: {
        tool: 'agents-lint',
        field: 'reports[].results[checker=structure].issues[rule=missing-section]',
      },
    });
    expect(run(null, null, agentsLintArtifact([wrongSourceField]))).toBeNull();
  });
});

// ── Signal 2: orphan ───────────────────────────────────────────────────────

describe('maintenance.doc-hygiene — orphan (signal 2)', () => {
  it('flags a doc with no inbound links that is not an entry point (red)', () => {
    const g = graph(
      [readme(), node('docs/a'), node('docs/orphan')],
      [mdLink('README', 'docs/a')]
    );
    const rec = run(g);
    expect(rec).not.toBeNull();
    expect(rec!.affected).toBe(1);
    expect(rec!.severity).toBe('info'); // sprawl, not structural
    expect(rec!.evidence![0]).toContain('docs/orphan.md');
    expect(rec!.evidence![0]).toContain('no inbound links');
  });

  it('does not flag a doc that has an inbound link (green)', () => {
    const g = graph([readme(), node('docs/a')], [mdLink('README', 'docs/a')]);
    expect(run(g)).toBeNull();
  });

  it('excludes declared entry points (root governance, README, indexKind)', () => {
    const g = graph(
      [
        node('AGENTS', { category: 'root', path: 'AGENTS.md' }),
        node('docs/adr/0001-foo', {
          category: 'adr',
          indexKind: 'adr-sequence',
          ordinal: 1,
          path: 'docs/adr/0001-foo.md',
        }),
        node('docs/competitive/README', {
          category: 'competitive',
          indexKind: 'competitive-tracker',
          path: 'docs/competitive/README.md',
        }),
        node('docs/a'),
      ],
      [mdLink('AGENTS', 'docs/a')]
    );
    // Every zero-inbound node here is a declared entry point ⇒ no orphan.
    expect(run(g)).toBeNull();
  });

  it('stays silent when the corpus has no resolved cross-links (no storm)', () => {
    // Nodes but zero resolved md-links: flagging every doc would be a false
    // positive, so orphan detection is suppressed entirely.
    const g = graph([node('docs/a'), node('docs/b'), node('docs/c')], []);
    expect(run(g)).toBeNull();
  });
});

// ── Signal 3: dangling-src-ref ─────────────────────────────────────────────

describe('maintenance.doc-hygiene — dangling-src-ref (signal 3)', () => {
  const refDoc = () =>
    node('REFERENCES', { category: 'root', path: 'REFERENCES.md', indexKind: 'references' });

  it('flags a src-ref absent from the repo-map inventory (red)', () => {
    const g = graph([refDoc()], [srcRef('REFERENCES', 'src/lib/parse-gone.ts')]);
    const rec = run(g, repoMap(['src/lib/parse-docs.ts']));
    expect(rec).not.toBeNull();
    expect(rec!.affected).toBe(1);
    expect(rec!.severity).toBe('warning'); // structural breakage
    expect(rec!.evidence![0]).toContain('src/lib/parse-gone.ts');
    expect(rec!.evidence![0]).toContain('source reference no longer exists');
  });

  it('does not flag a src-ref that exists in the inventory (green)', () => {
    const g = graph([refDoc()], [srcRef('REFERENCES', 'src/lib/parse-gone.ts')]);
    expect(run(g, repoMap(['src/lib/parse-gone.ts']))).toBeNull();
  });

  it('stays silent when there is no repo-map inventory to check against', () => {
    const g = graph([refDoc()], [srcRef('REFERENCES', 'src/lib/parse-gone.ts')]);
    expect(run(g, undefined)).toBeNull();
    expect(run(g, null)).toBeNull();
  });

  it('stays silent when the repo map is truncated (incomplete inventory)', () => {
    const g = graph([refDoc()], [srcRef('REFERENCES', 'src/lib/parse-gone.ts')]);
    const rm = repoMap(['src/lib/parse-docs.ts'], { truncated: true });
    expect(run(g, rm)).toBeNull();
  });

  it('stays silent when structured file rows do not cover fileCount', () => {
    const g = graph([refDoc()], [srcRef('REFERENCES', 'src/lib/parse-gone.ts')]);
    const rm = repoMap(['src/lib/parse-docs.ts'], { fileCount: 2 });
    expect(run(g, rm)).toBeNull();
  });

  it('does not flag a ref whose extension the inventory never covers', () => {
    // A TS-only map cannot judge a `.css` reference — that is a coverage gap,
    // not a dead reference.
    const g = graph([refDoc()], [srcRef('REFERENCES', 'src/styles/app.css')]);
    expect(run(g, repoMap(['src/lib/parse-docs.ts']))).toBeNull();
  });

  it('stays silent when the only repo map belongs to another checkout', () => {
    const g = graph([refDoc()], [srcRef('REFERENCES', 'src/lib/parse-gone.ts')]);
    const unrelated = repoMap(['src/lib/parse-docs.ts'], {
      root: '/user-project',
    });
    expect(run(g, unrelated)).toBeNull();
  });

  it('checks only the matching root when another project contains the target', () => {
    const g = graph([refDoc()], [srcRef('REFERENCES', 'src/lib/parse-gone.ts')]);
    const maps = repoMap(['src/lib/parse-docs.ts']);
    maps.projects.push(
      repoMap(['src/lib/parse-gone.ts'], { root: '/user-project' }).projects[0]
    );

    const rec = run(g, maps);
    expect(rec).not.toBeNull();
    expect(rec!.evidence).toContain(
      'REFERENCES.md -> src/lib/parse-gone.ts — source reference no longer exists'
    );
  });

  it('ignores an unrelated truncated map when the matching inventory is complete', () => {
    const g = graph([refDoc()], [srcRef('REFERENCES', 'src/lib/parse-gone.ts')]);
    const maps = repoMap(['src/lib/parse-docs.ts']);
    maps.projects.push(
      repoMap(['src/lib/other.ts'], {
        root: '/user-project',
        truncated: true,
      }).projects[0]
    );

    expect(run(g, maps)).not.toBeNull();
  });

  it('fails closed for a legacy graph with no root identity', () => {
    const g = {
      nodes: [refDoc()],
      edges: [srcRef('REFERENCES', 'src/lib/parse-gone.ts')],
    } as unknown as DocGraph;
    expect(run(g, repoMap(['src/lib/parse-docs.ts']))).toBeNull();
  });
});

// ── Grouped card + auditability contract ───────────────────────────────────

describe('maintenance.doc-hygiene — grouped card + contract', () => {
  function kitchenSink(): DocGraph {
    return graph(
      [readme(), node('docs/a'), node('docs/orphan'), node('REFERENCES', {
        category: 'root',
        path: 'REFERENCES.md',
        indexKind: 'references',
      })],
      [
        mdLink('README', 'docs/a'), // a resolved link (satisfies the orphan guard)
        mdLink('docs/a', 'docs/gone'), // broken-internal-link
        srcRef('REFERENCES', 'src/lib/parse-gone.ts'), // dangling-src-ref
      ]
    );
  }

  it('emits ONE recommendation covering all three signals', () => {
    const rec = run(kitchenSink(), repoMap(['src/lib/parse-docs.ts']));
    expect(rec).not.toBeNull();
    expect(rec!.id).toBe('maintenance.doc-hygiene');
    expect(rec!.category).toBe('maintenance');
    expect(rec!.affected).toBe(3); // broken-link + orphan + dangling-src-ref
    expect(rec!.severity).toBe('warning'); // structural breakage present
    expect(rec!.detail).toContain('3 deterministic hygiene issues');
  });

  it('is recommend-only (manual) — never ships an auto-apply fix', () => {
    const rec = run(kitchenSink(), repoMap(['src/lib/parse-docs.ts']));
    expect(rec!.fix).toBeUndefined();
  });

  it('carries auditable provenance that passes the contract', () => {
    const rec = run(kitchenSink(), repoMap(['src/lib/parse-docs.ts']));
    expect(rec!.provenance).toBeDefined();
    expect(rec!.provenance!.observations[0].source).toBe('parse-docs');
    // The dangling-src-ref existence oracle is the repo map — it must be cited.
    expect(
      rec!.provenance!.observations.some((o) => o.source === 'parse-repo-map-join')
    ).toBe(true);
    // Current-state signal: no staleness demotion.
    expect(rec!.provenance!.asOf).toBeUndefined();
    expect(validateRecommendationProvenance(rec!)).toEqual([]);
  });

  it('aggregates issues across multiple docs', () => {
    const g = graph(
      [node('docs/a'), node('docs/b')],
      [mdLink('docs/a', 'docs/gone-1'), mdLink('docs/b', 'docs/gone-2')]
    );
    const rec = run(g);
    expect(rec).not.toBeNull();
    expect(rec!.affected).toBe(2);
  });
});

// ── Signal 4: stale-declared-freshness (#2488) ─────────────────────────────

const NOW = Date.parse('2026-07-16T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

/** A doc committed `ageDays` before NOW with an opt-in freshness contract. */
function freshNode(
  slug: string,
  opts: {
    warn?: string;
    error?: string;
    ageDays?: number;
    provenance?: DocNode['gitMtimeProvenance'];
    gitMtimeIso?: string | null;
  } = {}
): DocNode {
  const frontmatter: Record<string, string> = {};
  if (opts.warn !== undefined) frontmatter[FRESHNESS_WARN_KEY] = opts.warn;
  if (opts.error !== undefined) frontmatter[FRESHNESS_ERROR_KEY] = opts.error;
  const gitMtimeIso =
    opts.gitMtimeIso !== undefined
      ? opts.gitMtimeIso
      : new Date(NOW - (opts.ageDays ?? 0) * DAY).toISOString();
  return node(slug, {
    frontmatter,
    gitMtimeIso,
    gitMtimeProvenance: opts.provenance ?? 'git',
  });
}

describe('parseFreshnessDurationMs — duration grammar', () => {
  it('parses a positive integer + d/w/m into FIXED windows', () => {
    expect(parseFreshnessDurationMs('90d')).toBe(90 * DAY);
    expect(parseFreshnessDurationMs('2w')).toBe(14 * DAY);
    expect(parseFreshnessDurationMs('1m')).toBe(30 * DAY);
    expect(parseFreshnessDurationMs('  180d  ')).toBe(180 * DAY); // trims
  });

  it('rejects malformed, zero, negative, leading-zero, and bad-unit values', () => {
    for (const bad of ['0d', '-5d', '01d', '5', '5y', '90days', '', 'd', '1.5d', '1 d', '+5d']) {
      expect(parseFreshnessDurationMs(bad), bad).toBeNull();
    }
  });

  it('rejects a duration that overflows a safe integer', () => {
    expect(parseFreshnessDurationMs('999999999999999999999d')).toBeNull();
    // safe-integer days, but the ms product overflows MAX_SAFE_INTEGER:
    expect(parseFreshnessDurationMs('9999999999999d')).toBeNull();
  });
});

describe('readFreshnessContract — contract classification', () => {
  it('is `none` when neither key is declared', () => {
    expect(readFreshnessContract({}).kind).toBe('none');
    expect(readFreshnessContract({ title: 'x' }).kind).toBe('none');
  });

  it('accepts a single warn-only or error-only contract', () => {
    expect(readFreshnessContract({ [FRESHNESS_WARN_KEY]: '30d' })).toEqual({
      kind: 'ok',
      contract: expect.objectContaining({ warnAfterMs: 30 * DAY, errorAfterMs: null }),
    });
    expect(readFreshnessContract({ [FRESHNESS_ERROR_KEY]: '60d' })).toEqual({
      kind: 'ok',
      contract: expect.objectContaining({ warnAfterMs: null, errorAfterMs: 60 * DAY }),
    });
  });

  it('accepts both when warn <= error, including equal thresholds', () => {
    expect(
      readFreshnessContract({ [FRESHNESS_WARN_KEY]: '90d', [FRESHNESS_ERROR_KEY]: '180d' }).kind
    ).toBe('ok');
    expect(
      readFreshnessContract({ [FRESHNESS_WARN_KEY]: '90d', [FRESHNESS_ERROR_KEY]: '90d' }).kind
    ).toBe('ok');
  });

  it('invalidates reversed ordering and any malformed threshold', () => {
    expect(
      readFreshnessContract({ [FRESHNESS_WARN_KEY]: '180d', [FRESHNESS_ERROR_KEY]: '90d' }).kind
    ).toBe('invalid');
    expect(readFreshnessContract({ [FRESHNESS_WARN_KEY]: '0d' }).kind).toBe('invalid');
    expect(
      readFreshnessContract({ [FRESHNESS_WARN_KEY]: '30d', [FRESHNESS_ERROR_KEY]: 'soon' }).kind
    ).toBe('invalid');
  });
});

describe('evaluateDeclaredFreshness — verdict + suppression', () => {
  it('passes silently when age is below the warn threshold', () => {
    expect(
      evaluateDeclaredFreshness(freshNode('docs/a', { warn: '90d', error: '180d', ageDays: 10 }), NOW)
    ).toBeNull();
  });

  it('warns at exactly the warn boundary, with auditable fields', () => {
    const v = evaluateDeclaredFreshness(
      freshNode('docs/a', { warn: '90d', error: '180d', ageDays: 90 }),
      NOW
    );
    expect(v?.verdict).toBe('warn');
    expect(v?.thresholdKey).toBe('warn_after');
    expect(v?.thresholdRaw).toBe('90d');
    expect(v?.provenance).toBe('git');
    expect(v?.asOf).toBe('2026-07-16');
    expect(v?.gitDate).toBe('2026-04-17'); // NOW - 90d
  });

  it('warns between warn and error, errors at/after the error boundary', () => {
    expect(
      evaluateDeclaredFreshness(freshNode('docs/a', { warn: '90d', error: '180d', ageDays: 120 }), NOW)
        ?.verdict
    ).toBe('warn');
    expect(
      evaluateDeclaredFreshness(freshNode('docs/a', { warn: '90d', error: '180d', ageDays: 180 }), NOW)
        ?.verdict
    ).toBe('error'); // boundary
    expect(
      evaluateDeclaredFreshness(freshNode('docs/a', { warn: '90d', error: '180d', ageDays: 400 }), NOW)
        ?.verdict
    ).toBe('error');
  });

  it('honours single-threshold contracts', () => {
    expect(
      evaluateDeclaredFreshness(freshNode('docs/a', { warn: '30d', ageDays: 40 }), NOW)?.verdict
    ).toBe('warn');
    expect(
      evaluateDeclaredFreshness(freshNode('docs/a', { warn: '30d', ageDays: 10 }), NOW)
    ).toBeNull();
    expect(
      evaluateDeclaredFreshness(freshNode('docs/a', { error: '60d', ageDays: 80 }), NOW)?.verdict
    ).toBe('error');
    expect(
      evaluateDeclaredFreshness(freshNode('docs/a', { error: '60d', ageDays: 30 }), NOW)
    ).toBeNull();
  });

  it('resolves equal thresholds to error at the shared boundary', () => {
    expect(
      evaluateDeclaredFreshness(freshNode('docs/a', { warn: '90d', error: '90d', ageDays: 90 }), NOW)
        ?.verdict
    ).toBe('error');
    // just under the shared boundary is a pass, not a warn
    expect(
      evaluateDeclaredFreshness(freshNode('docs/a', { warn: '90d', error: '90d', ageDays: 89 }), NOW)
    ).toBeNull();
  });

  it('suppresses a reversed, malformed, or overflow contract', () => {
    expect(
      evaluateDeclaredFreshness(freshNode('docs/a', { warn: '180d', error: '90d', ageDays: 400 }), NOW)
    ).toBeNull();
    expect(
      evaluateDeclaredFreshness(freshNode('docs/a', { warn: 'later', ageDays: 400 }), NOW)
    ).toBeNull();
    expect(
      evaluateDeclaredFreshness(freshNode('docs/a', { warn: '9999999999999d', ageDays: 400 }), NOW)
    ).toBeNull();
  });

  it('suppresses when no contract is declared', () => {
    expect(evaluateDeclaredFreshness(freshNode('docs/a', { ageDays: 999 }), NOW)).toBeNull();
  });

  it('suppresses non-authoritative or absent time provenance (never Docker mtime)', () => {
    for (const provenance of ['filesystem', 'unavailable'] as const) {
      expect(
        evaluateDeclaredFreshness(
          freshNode('docs/a', { error: '30d', ageDays: 400, provenance }),
          NOW
        ),
        provenance
      ).toBeNull();
    }
    // An older serialized graph with an ABSENT provenance is treated like filesystem.
    const noProvenance = node('docs/a', {
      frontmatter: { [FRESHNESS_ERROR_KEY]: '30d' },
      gitMtimeIso: new Date(NOW - 400 * DAY).toISOString(),
    });
    expect(evaluateDeclaredFreshness(noProvenance, NOW)).toBeNull();
  });

  it('suppresses a null, future, or implausibly old timestamp (clock skew)', () => {
    expect(
      evaluateDeclaredFreshness(freshNode('docs/a', { error: '30d', gitMtimeIso: null }), NOW)
    ).toBeNull();
    expect(
      evaluateDeclaredFreshness(freshNode('docs/a', { error: '30d', ageDays: -5 }), NOW)
    ).toBeNull(); // future / skew
    expect(
      evaluateDeclaredFreshness(
        freshNode('docs/a', { error: '30d', gitMtimeIso: '1994-01-01T00:00:00.000Z' }),
        NOW
      )
    ).toBeNull(); // before the 2000 plausibility floor
  });

  it('evaluates a valid commit-bound manifest time as authoritative', () => {
    expect(
      evaluateDeclaredFreshness(
        freshNode('docs/a', { error: '30d', ageDays: 400, provenance: 'manifest' }),
        NOW
      )?.verdict
    ).toBe('error');
  });
});

describe('maintenance.doc-hygiene — declared-freshness card (#2488)', () => {
  it('flags an error verdict as a warning-severity card with auditable, no-content-claim evidence', () => {
    const rec = run(
      graph([freshNode('docs/refstale', { warn: '90d', error: '180d', ageDays: 400 })]),
      undefined,
      undefined,
      NOW
    );
    expect(rec).not.toBeNull();
    expect(rec!.affected).toBe(1);
    expect(rec!.severity).toBe('warning');
    const line = rec!.evidence![0];
    expect(line).toContain('docs/refstale.md');
    expect(line).toContain('(git)');
    expect(line).toContain('error_after');
    expect(line).toContain('180d');
    expect(line).toContain('as of 2026-07-16');
    expect(line).toContain('→ error');
    // Wording never asserts the content is wrong or currently stale.
    expect(line).not.toMatch(/wrong|incorrect|outdated content|currently stale/i);
    expect(rec!.fix).toBeUndefined();
    expect(
      rec!.provenance!.observations.some(
        (o) => o.source === 'parse-docs' && String(o.field).includes('gitMtimeProvenance')
      )
    ).toBe(true);
    // The declared-freshness verdict recomputes live at `now`, so it embeds
    // "as of <date>" in wording rather than demoting via a rec-level asOf.
    expect(rec!.provenance!.asOf).toBeUndefined();
    expect(validateRecommendationProvenance(rec!)).toEqual([]);
  });

  it('flags a warn verdict as an info-severity card', () => {
    const rec = run(
      graph([freshNode('docs/warnme', { warn: '90d', error: '180d', ageDays: 120 })]),
      undefined,
      undefined,
      NOW
    );
    expect(rec).not.toBeNull();
    expect(rec!.severity).toBe('info');
    expect(rec!.evidence![0]).toContain('→ warn');
    expect(rec!.detail).toContain('document past its declared freshness threshold');
    expect(rec!.action).toContain('freshness.warn_after');
  });

  it('stays silent for a passing, undeclared, or non-authoritative corpus', () => {
    expect(
      run(
        graph([freshNode('docs/fresh', { warn: '90d', error: '180d', ageDays: 5 })]),
        undefined,
        undefined,
        NOW
      )
    ).toBeNull();
    expect(run(graph([node('docs/plain')]), undefined, undefined, NOW)).toBeNull();
    expect(
      run(
        graph([freshNode('docs/dockertime', { error: '30d', ageDays: 400, provenance: 'filesystem' })]),
        undefined,
        undefined,
        NOW
      )
    ).toBeNull();
  });

  it('combines freshness with a structural signal in one card', () => {
    const g = graph(
      [node('docs/a'), freshNode('docs/old', { error: '30d', ageDays: 400 })],
      [mdLink('docs/a', 'docs/gone')]
    );
    const rec = run(g, undefined, undefined, NOW);
    expect(rec).not.toBeNull();
    expect(rec!.affected).toBe(2);
    expect(rec!.severity).toBe('warning');
    expect(rec!.detail).toContain('broken internal doc link or fragment');
    expect(rec!.detail).toContain('document past its declared freshness threshold');
    // Structural breakage sorts ahead of the freshness row in the evidence.
    expect(rec!.evidence![0]).toContain('docs/a.md');
    expect(rec!.evidence!.some((e) => e.includes('docs/old.md'))).toBe(true);
  });
});

describe('maintenance.doc-hygiene — seeded freshness contracts (#2488)', () => {
  const SEED_FILES = [
    '../../../../REFERENCES.md',
    '../../../../docs/competitive-analysis/anthropic-official-analytics.md',
    '../../../../docs/competitive-analysis/claude-code-dashboards.md',
  ];

  it('every seeded contract parses to a self-consistent, valid contract', () => {
    for (const rel of SEED_FILES) {
      const content = readFileSync(new URL(rel, import.meta.url), 'utf8');
      const { frontmatter } = parseFrontmatter(content);
      const parsed = readFreshnessContract(frontmatter);
      expect(parsed.kind, `${rel} freshness contract`).toBe('ok');
      if (parsed.kind === 'ok') {
        const { warnAfterMs, errorAfterMs } = parsed.contract;
        expect(warnAfterMs, rel).not.toBeNull();
        expect(errorAfterMs, rel).not.toBeNull();
        expect(warnAfterMs!, rel).toBeLessThanOrEqual(errorAfterMs!);
      }
    }
  });

  it('a freshly committed seed (age ~0) produces no finding', () => {
    for (const rel of SEED_FILES) {
      const content = readFileSync(new URL(rel, import.meta.url), 'utf8');
      const { frontmatter } = parseFrontmatter(content);
      const justCommitted = node(rel, {
        frontmatter,
        gitMtimeIso: new Date(NOW).toISOString(),
        gitMtimeProvenance: 'git',
      });
      expect(evaluateDeclaredFreshness(justCommitted, NOW), rel).toBeNull();
    }
  });
});

// ── docs-map declared drift (#2489) ─────────────────────────────────────────

describe('maintenance.doc-hygiene — docs-map declared drift (#2489)', () => {
  it('stays silent on a fully consistent docs-map declaration', () => {
    const g = graph(
      [node('docs/guide', { path: 'docs/guide.md' })],
      [srcRef('docs/guide', 'src/lib/foo.ts')]
    );
    const wrapper = docsMapWrapper({
      'docs/guide.md': { sources: [{ path: 'src/lib/foo.ts', symbols: ['doThing'] }] },
    });
    const rm = repoMapDataset([repoMapProject([{ path: 'src/lib/foo.ts', symbols: ['doThing'] }])]);
    expect(run(g, rm, null, 0, wrapper)).toBeNull();
  });

  it('flags docs-map-missing-document when the mapped doc is not a node in the graph', () => {
    const g = graph([node('docs/other')], []);
    const wrapper = docsMapWrapper({
      'docs/guide.md': { sources: [{ path: 'src/lib/foo.ts', symbols: [] }] },
    });
    const rec = run(g, null, null, 0, wrapper);
    expect(rec).not.toBeNull();
    expect(rec!.affected).toBe(1);
    expect(rec!.severity).toBe('warning'); // structural
    expect(rec!.evidence).toEqual([
      'docs/guide.md — docs-map document no longer exists (declared in docs/docs-map.json)',
    ]);
  });

  it('flags docs-map-missing-source when the declared source is absent from the matched repo-map project', () => {
    // Root deliberately does NOT match the repo-map project's root, so the
    // legacy (#2258) root-matched dangling-src-ref signal stays silent and
    // only the identity-matched (repository+commit) docs-map signal fires.
    const g = graph(
      [node('docs/guide', { path: 'docs/guide.md' })],
      [srcRef('docs/guide', 'src/lib/gone.ts')],
      '/no-such-root'
    );
    const wrapper = docsMapWrapper({
      'docs/guide.md': { sources: [{ path: 'src/lib/gone.ts', symbols: [] }] },
    });
    const rm = repoMapDataset([repoMapProject([{ path: 'src/lib/other.ts' }])]);
    const rec = run(g, rm, null, 0, wrapper);
    expect(rec).not.toBeNull();
    expect(rec!.affected).toBe(1);
    expect(rec!.severity).toBe('warning'); // structural
    expect(rec!.evidence![0]).toContain('src/lib/gone.ts');
    expect(rec!.evidence![0]).toContain('declared source no longer exists');
  });

  it('flags docs-map-unreferenced-source when the doc exists but has no src-ref edge to the declared source', () => {
    const g = graph([node('docs/guide', { path: 'docs/guide.md' })], []);
    const wrapper = docsMapWrapper({
      'docs/guide.md': { sources: [{ path: 'src/lib/foo.ts', symbols: [] }] },
    });
    const rec = run(g, null, null, 0, wrapper); // no repoMap → 2/4 suppressed regardless
    expect(rec).not.toBeNull();
    expect(rec!.affected).toBe(1);
    expect(rec!.severity).toBe('info'); // declaration drift, not structural
    expect(rec!.evidence![0]).toContain('src/lib/foo.ts');
    expect(rec!.evidence![0]).toContain('declared source is not referenced by its document');
  });

  it('flags docs-map-missing-symbol when the declared symbol is absent from the source file symbols', () => {
    const g = graph(
      [node('docs/guide', { path: 'docs/guide.md' })],
      [srcRef('docs/guide', 'src/lib/foo.ts')]
    );
    const wrapper = docsMapWrapper({
      'docs/guide.md': { sources: [{ path: 'src/lib/foo.ts', symbols: ['missingFn'] }] },
    });
    const rm = repoMapDataset([repoMapProject([{ path: 'src/lib/foo.ts', symbols: ['realFn'] }])]);
    const rec = run(g, rm, null, 0, wrapper);
    expect(rec).not.toBeNull();
    expect(rec!.affected).toBe(1);
    expect(rec!.severity).toBe('warning'); // structural
    expect(rec!.evidence![0]).toContain('src/lib/foo.ts');
    expect(rec!.evidence![0]).toContain('missingFn');
    expect(rec!.evidence![0]).toContain('declared source symbol no longer exists');
  });

  it('never treats a body-only src-ref edge as an implicit docs-map declaration (one-way direction)', () => {
    const g = graph(
      [node('docs/guide', { path: 'docs/guide.md' })],
      [
        srcRef('docs/guide', 'src/lib/foo.ts'), // declared, satisfied
        srcRef('docs/guide', 'src/lib/undeclared.ts'), // never in the map — out of scope
      ]
    );
    const wrapper = docsMapWrapper({
      'docs/guide.md': { sources: [{ path: 'src/lib/foo.ts', symbols: [] }] },
    });
    expect(run(g, null, null, 0, wrapper)).toBeNull();
  });

  it('suppresses unreferenced-source for a missing document but still checks its declared sources against the repo map', () => {
    const g = graph([node('docs/other')], []); // docs/guide.md is absent
    const wrapper = docsMapWrapper({
      'docs/guide.md': {
        sources: [
          { path: 'src/lib/gone.ts', symbols: [] },
          { path: 'src/lib/foo.ts', symbols: ['missingSym'] },
        ],
      },
    });
    const rm = repoMapDataset([
      repoMapProject([{ path: 'src/lib/foo.ts', symbols: ['realSym'] }]),
    ]);
    const rec = run(g, rm, null, 0, wrapper);
    expect(rec).not.toBeNull();
    // missing-document + missing-source(gone.ts) + missing-symbol(foo.ts) = 3, no unreferenced-source.
    expect(rec!.affected).toBe(3);
    expect(rec!.evidence!.some((e) => e.includes('docs-map document no longer exists'))).toBe(true);
    expect(
      rec!.evidence!.some(
        (e) => e.includes('src/lib/gone.ts') && e.includes('declared source no longer exists')
      )
    ).toBe(true);
    expect(
      rec!.evidence!.some(
        (e) => e.includes('missingSym') && e.includes('declared source symbol no longer exists')
      )
    ).toBe(true);
    expect(
      rec!.evidence!.some((e) => e.includes('declared source is not referenced by its document'))
    ).toBe(false);
  });

  it('suppresses missing-symbol for a source whose file itself is missing', () => {
    // Root deliberately does NOT match the repo-map project's root — see the
    // missing-source test above for why.
    const g = graph(
      [node('docs/guide', { path: 'docs/guide.md' })],
      [srcRef('docs/guide', 'src/lib/gone.ts')],
      '/no-such-root'
    );
    const wrapper = docsMapWrapper({
      'docs/guide.md': { sources: [{ path: 'src/lib/gone.ts', symbols: ['someSymbol'] }] },
    });
    const rm = repoMapDataset([repoMapProject([{ path: 'src/lib/other.ts' }])]); // gone.ts absent
    const rec = run(g, rm, null, 0, wrapper);
    expect(rec).not.toBeNull();
    expect(rec!.affected).toBe(1); // only missing-source
    expect(rec!.evidence![0]).toContain('declared source no longer exists');
    expect(
      rec!.evidence!.some((e) => e.includes('declared source symbol no longer exists'))
    ).toBe(false);
  });

  it('does not let a same-named file in an unrelated (non-matching) project hide a genuinely missing source', () => {
    const g = graph(
      [node('docs/guide', { path: 'docs/guide.md' })],
      [srcRef('docs/guide', 'src/lib/foo.ts')]
    );
    const wrapper = docsMapWrapper({
      'docs/guide.md': { sources: [{ path: 'src/lib/foo.ts', symbols: [] }] },
    });
    const rm = repoMapDataset([
      repoMapProject([]), // identity-matched project: does NOT have foo.ts
      repoMapProject([{ path: 'src/lib/foo.ts' }], {
        root: '/other',
        repository: 'other-org/other-repo',
        generatedAtGitSha: 'c'.repeat(40),
      }), // unrelated project: HAS it, but is not a candidate
    ]);
    const rec = run(g, rm, null, 0, wrapper);
    expect(rec).not.toBeNull();
    expect(
      rec!.evidence!.some(
        (e) => e.includes('src/lib/foo.ts') && e.includes('declared source no longer exists')
      )
    ).toBe(true);
  });

  it('does not let an unrelated (non-matching) project missing the file create a false finding when the matched project has it', () => {
    const g = graph(
      [node('docs/guide', { path: 'docs/guide.md' })],
      [srcRef('docs/guide', 'src/lib/foo.ts')]
    );
    const wrapper = docsMapWrapper({
      'docs/guide.md': { sources: [{ path: 'src/lib/foo.ts', symbols: ['realFn'] }] },
    });
    const rm = repoMapDataset([
      repoMapProject([{ path: 'src/lib/foo.ts', symbols: ['realFn'] }]), // matched: HAS it
      repoMapProject([], {
        root: '/other',
        repository: 'other-org/other-repo',
        generatedAtGitSha: 'c'.repeat(40),
      }), // unrelated: lacks it, but is not a candidate
    ]);
    expect(run(g, rm, null, 0, wrapper)).toBeNull();
  });

  it('stays silent when docsMap is absent, even with matching graph/repo-map data', () => {
    const g = graph([node('docs/guide', { path: 'docs/guide.md' })], []);
    expect(run(g)).toBeNull();
    expect(run(g, null, null, 0, null)).toBeNull();
  });

  it('stays silent for all four docs-map signals when the doc graph is absent or empty, even with a valid wrapper + matched project', () => {
    const wrapper = docsMapWrapper({
      'docs/guide.md': { sources: [{ path: 'src/lib/foo.ts', symbols: ['realFn'] }] },
    });
    const rm = repoMapDataset([repoMapProject([{ path: 'src/lib/foo.ts', symbols: ['realFn'] }])]);
    expect(run(null, rm, null, 0, wrapper)).toBeNull();
    expect(run(undefined, rm, null, 0, wrapper)).toBeNull();
    expect(run(graph([]), rm, null, 0, wrapper)).toBeNull();
  });

  it('carries docs-map observations with the cited source/field when items fire', () => {
    const g = graph([node('docs/other')], []); // docs/guide.md absent
    const wrapper = docsMapWrapper({
      'docs/guide.md': { sources: [{ path: 'src/lib/foo.ts', symbols: ['missingSym'] }] },
    });
    const rm = repoMapDataset([repoMapProject([{ path: 'src/lib/foo.ts', symbols: ['realSym'] }])]);
    const rec = run(g, rm, null, 0, wrapper);
    expect(rec).not.toBeNull();
    expect(
      rec!.provenance!.observations.some(
        (o) => o.source === 'parse-docs-map' && String(o.field).includes('documents[<path>].sources')
      )
    ).toBe(true);
    expect(
      rec!.provenance!.observations.some(
        (o) => o.source === 'parse-repo-map-join' && String(o.field).includes('symbols[].name')
      )
    ).toBe(true);
    expect(validateRecommendationProvenance(rec!)).toEqual([]);
  });

  it('extends the action text and stays recommend-only when docs-map items fire', () => {
    const g = graph([node('docs/other')], []);
    const wrapper = docsMapWrapper({
      'docs/guide.md': { sources: [{ path: 'src/lib/foo.ts', symbols: [] }] },
    });
    const rec = run(g, null, null, 0, wrapper);
    expect(rec).not.toBeNull();
    expect(rec!.action).toContain('docs/docs-map.json');
    expect(rec!.fix).toBeUndefined();
  });
});

describe('maintenance.doc-hygiene — docs-map identity suppression matrix (#2489)', () => {
  // Shared "would-fire" shape: the doc exists (no missing-document) and has NO
  // src-ref edge to its declared source, so unreferenced-source (signal 3)
  // ALWAYS fires regardless of repo-map identity — proving the graph-side
  // signal keeps working. The declared source is absent from every
  // constructed repo-map project, so missing-source (signal 2) WOULD fire if
  // identity matched; each case breaks the match a different way.
  const guide = () => node('docs/guide', { path: 'docs/guide.md' });
  const wrapperWith = (over: Partial<{ repository: string | null; commit: string | null }>) =>
    docsMapWrapper(
      { 'docs/guide.md': { sources: [{ path: 'src/lib/gone.ts', symbols: [] }] } },
      over
    );

  const cases: Array<[string, () => { wrapper: DocsMapArtifact; rm: RepoMapDataset }]> = [
    [
      'wrapper.repository is null',
      () => ({
        wrapper: wrapperWith({ repository: null }),
        rm: repoMapDataset([repoMapProject([{ path: 'src/lib/other.ts' }])]),
      }),
    ],
    [
      'wrapper.commit is null',
      () => ({
        wrapper: wrapperWith({ commit: null }),
        rm: repoMapDataset([repoMapProject([{ path: 'src/lib/other.ts' }])]),
      }),
    ],
    [
      'zero matching projects (fully unrelated project)',
      () => ({
        wrapper: wrapperWith({}),
        rm: repoMapDataset([
          repoMapProject([{ path: 'src/lib/other.ts' }], {
            repository: 'zzz/unrelated',
            generatedAtGitSha: 'd'.repeat(40),
          }),
        ]),
      }),
    ],
    [
      'two matching projects (ambiguous)',
      () => ({
        wrapper: wrapperWith({}),
        rm: repoMapDataset([
          repoMapProject([{ path: 'src/lib/other.ts' }]),
          repoMapProject([{ path: 'src/lib/other2.ts' }]),
        ]),
      }),
    ],
    [
      'matched project is truncated',
      () => ({
        wrapper: wrapperWith({}),
        rm: repoMapDataset([
          repoMapProject([{ path: 'src/lib/other.ts' }], { truncated: true }),
        ]),
      }),
    ],
    [
      'files.length !== fileCount',
      () => ({
        wrapper: wrapperWith({}),
        rm: repoMapDataset([
          repoMapProject([{ path: 'src/lib/other.ts' }], { fileCount: 2 }),
        ]),
      }),
    ],
    [
      'repository mismatch',
      () => ({
        wrapper: wrapperWith({}),
        rm: repoMapDataset([
          repoMapProject([{ path: 'src/lib/other.ts' }], { repository: 'other-org/other-repo' }),
        ]),
      }),
    ],
    [
      'generatedAtGitSha mismatch (stale commit)',
      () => ({
        wrapper: wrapperWith({}),
        rm: repoMapDataset([
          repoMapProject([{ path: 'src/lib/other.ts' }], { generatedAtGitSha: 'b'.repeat(40) }),
        ]),
      }),
    ],
  ];

  it.each(cases)('%s suppresses signals 2+4 while signal 3 still fires', (_label, build) => {
    const { wrapper, rm } = build();
    const g = graph([guide()], []);
    const rec = run(g, rm, null, 0, wrapper);
    expect(rec).not.toBeNull();
    expect(
      rec!.evidence!.some((e) => e.includes('declared source is not referenced by its document'))
    ).toBe(true);
    expect(rec!.evidence!.some((e) => e.includes('declared source no longer exists'))).toBe(false);
    expect(
      rec!.evidence!.some((e) => e.includes('declared source symbol no longer exists'))
    ).toBe(false);
  });
});

describe('maintenance.doc-hygiene — seeded docs-map self-consistency (#2489)', () => {
  it('emits zero docs-map items for a synthetic graph/repo-map built to exactly mirror the real seed', () => {
    const content = readFileSync(
      new URL('../../../../docs/docs-map.json', import.meta.url),
      'utf8'
    );
    const map = parseDocsMap(JSON.parse(content));
    expect(map).not.toBeNull();
    if (!map) return;

    const nodes: DocNode[] = Object.keys(map.documents).map((docPath) =>
      node(docPath.replace(/\.md$/, ''), { path: docPath })
    );
    const edges: DocEdge[] = [];
    const filesByPath = new Map<string, { path: string; symbols: string[] }>();
    for (const [docPath, doc] of Object.entries(map.documents)) {
      const slug = docPath.replace(/\.md$/, '');
      for (const source of doc.sources) {
        edges.push(srcRef(slug, source.path));
        const existing = filesByPath.get(source.path) ?? { path: source.path, symbols: [] };
        existing.symbols = [...new Set([...existing.symbols, ...source.symbols])];
        filesByPath.set(source.path, existing);
      }
    }

    const g = graph(nodes, edges);
    const wrapper: DocsMapArtifact = {
      map,
      repository: map.repository,
      commit: DOCS_MAP_COMMIT,
    };
    const rm = repoMapDataset([
      repoMapProject([...filesByPath.values()], {
        generatedAtGitSha: DOCS_MAP_COMMIT,
        repository: map.repository,
      }),
    ]);

    expect(run(g, rm, null, 0, wrapper)).toBeNull();
  });
});

// ── Declared category (#2472) ───────────────────────────────────────────────

const catNode = (slug: string, category: DocNode['category'], declared?: string): DocNode =>
  node(slug, {
    path: `${slug}.md`,
    category,
    frontmatter: declared === undefined ? {} : { category: declared },
  });

/** The evidence line for the doc under test, wherever it sorts in the (capped) list. */
const lineFor = (rec: ReturnType<typeof run>, path: string): string => {
  const line = rec!.evidence!.find((e) => e.includes(path));
  expect(line, `evidence line for ${path}`).toBeDefined();
  return line!;
};

describe('maintenance.doc-hygiene — declared category (#2472)', () => {
  it('is silent when a doc declares no category (opt-in: absence is neutral)', () => {
    expect(run(graph([catNode('docs/adr/0007-x', 'adr')]))).toBeNull();
  });

  it('is silent when the declared category matches the derived category', () => {
    expect(run(graph([catNode('docs/adr/0007-x', 'adr', 'adr')]))).toBeNull();
    expect(run(graph([catNode('docs/audits/x', 'audit', 'audit')]))).toBeNull();
    expect(run(graph([catNode('docs/plain', 'doc', 'doc')]))).toBeNull();
  });

  it('stays silent when a matching parsed declaration has a YAML inline comment', () => {
    const { frontmatter } = parseFrontmatter(
      `---\ncategory: adr # canonical path category\n---\n`
    );
    const parsedNode = node('docs/adr/0007-x', {
      category: 'adr',
      frontmatter,
    });

    expect(run(graph([parsedNode]))).toBeNull();
  });

  it('flags a valid declaration that differs from the derived category, citing both sides neutrally', () => {
    const rec = run(graph([catNode('docs/adr/0007-x', 'adr', 'plan')]));
    expect(rec).not.toBeNull();
    expect(rec!.severity).toBe('info'); // declaration drift is sprawl, not structural
    const line = lineFor(rec, 'docs/adr/0007-x.md');
    expect(line).toContain('declared category "plan"');
    expect(line).toContain('location implies "adr"');
    expect(line).toContain('reconcile');
    // A valid mismatch must NOT be described as an unrecognized token.
    expect(line).not.toContain('not a recognized category');
    expect(rec!.action).toContain('move the file or correct the label');
    expect(rec!.action).not.toContain('replace it with a recognized category');
    // The observation cites the two node fields it read.
    expect(
      rec!.provenance!.observations.some(
        (o) => o.source === 'parse-docs' && /frontmatter\[category\]/.test(o.field ?? '')
      )
    ).toBe(true);
    expect(validateRecommendationProvenance(rec!)).toEqual([]);
  });

  it('flags an unrecognized (wrong-case) declaration as a DISTINCT invalid item, not a mismatch', () => {
    const rec = run(graph([catNode('docs/adr/0007-x', 'adr', 'ADR')]));
    expect(rec).not.toBeNull();
    const line = lineFor(rec, 'docs/adr/0007-x.md');
    expect(line).toContain('declared category "ADR" is not a recognized category');
    expect(line).toContain('expected one of');
    // Distinguishable from a mismatch: no "location implies" framing, no misfile claim.
    expect(line).not.toContain('location implies');
    expect(rec!.action).toContain('replace it with a recognized category');
    expect(rec!.action).not.toContain('move the file');
    expect(validateRecommendationProvenance(rec!)).toEqual([]);
  });

  it('treats an explicitly empty category as invalid rather than absent', () => {
    const rec = run(graph([catNode('docs/adr/0007-x', 'adr', '')]));

    expect(rec).not.toBeNull();
    expect(rec!.detail).toContain('1 declared category is not a recognized value');
    expect(rec!.action).toContain('replace it with a recognized category');
    expect(rec!.action).not.toContain('move the file');
    expect(lineFor(rec, 'docs/adr/0007-x.md')).toContain(
      'declared category "" is not a recognized category'
    );
  });

  it('flags a mismatch against the catch-all derived "doc" category (per the design decision)', () => {
    // deriveCategory collapses an unrecognized docs/<sub>/ subtree to "doc"; a
    // declaration that differs is still flagged so a misfile/new-subtree is seen.
    const rec = run(graph([catNode('docs/newsub/x', 'doc', 'plan')]));
    expect(rec).not.toBeNull();
    const line = lineFor(rec, 'docs/newsub/x.md');
    expect(line).toContain('declared category "plan"');
    expect(line).toContain('location implies "doc"');
  });

  it('counts mismatch and invalid items separately in the breakdown', () => {
    const rec = run(
      graph([
        catNode('docs/adr/0001-x', 'adr', 'plan'), // valid mismatch
        catNode('docs/adr/0002-x', 'adr', 'nope'), // invalid token
      ])
    );
    expect(rec).not.toBeNull();
    expect(rec!.detail).toContain('1 declared category does not match its location');
    expect(rec!.detail).toContain('1 declared category is not a recognized value');
    expect(rec!.action).toContain('move the file or correct the label');
    expect(rec!.action).toContain('replace it with a recognized category');
    expect(validateRecommendationProvenance(rec!)).toEqual([]);
  });

  it('reserves auditable evidence for every active category subtype at the row cap', () => {
    const structuralFindings = Array.from({ length: 8 }, (_, index) =>
      localLinkFinding({
        id: `doc-link:lychee.local-links:${index}`,
        path: `docs/broken-${index}.md`,
        line: index + 1,
        target: `docs/gone-${index}.md`,
      })
    );
    const rec = run(
      graph([
        catNode('docs/adr/category-mismatch', 'adr', 'plan'),
        catNode('docs/adr/category-invalid', 'adr', 'ADR'),
      ]),
      null,
      lycheeArtifact(structuralFindings)
    );

    expect(rec).not.toBeNull();
    expect(rec!.evidence).toHaveLength(8);
    expect(lineFor(rec, 'docs/adr/category-mismatch.md')).toContain(
      'declared category "plan"'
    );
    expect(lineFor(rec, 'docs/adr/category-invalid.md')).toContain(
      'declared category "ADR"'
    );
  });

  it('a declared-category item never raises the card above info on its own', () => {
    const rec = run(graph([catNode('docs/adr/0007-x', 'adr', 'plan')]));
    expect(rec!.severity).toBe('info');
  });
});

describe('maintenance.doc-hygiene — seeded declared categories are clean on the shipped tree (#2472)', () => {
  // The three seeds must produce ZERO declared-category findings, and no other
  // shipped doc may carry a category declaration that would fire the signal.
  // scanDeclaredCategory fires ONLY on an invalid or mismatched declaration, so
  // an exhaustive node-level check over the real graph is equivalent to
  // "zero findings against the shipped tree".
  const SEEDS: Record<string, string> = {
    'docs/doc-hygiene-borrow-stack.md': 'doc',
    'docs/adr/0019-leave-behind-contract.md': 'adr',
    'docs/audits/2026-07-portable-signal-inventory.md': 'audit',
  };

  it('every category declaration in the tree is valid and matches its path-derived category', () => {
    const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
    const g = buildDocGraph(repoRoot);
    const declared = g.nodes.filter((n) => n.frontmatter['category'] !== undefined);

    // The three intended seeds are present and self-consistent.
    for (const [path, expected] of Object.entries(SEEDS)) {
      const seed = declared.find((n) => n.path === path);
      expect(seed, `seed present with category frontmatter: ${path}`).toBeDefined();
      expect(seed!.frontmatter['category']).toBe(expected);
      expect(seed!.category).toBe(expected);
    }

    // No declaration anywhere in the shipped tree is invalid or mismatched.
    for (const n of declared) {
      expect(isDocCategory(n.frontmatter['category']), `${n.path} declares a valid category`).toBe(
        true
      );
      expect(n.frontmatter['category'], `${n.path} declared matches derived`).toBe(n.category);
    }
  });
});
