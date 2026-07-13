import { describe, it, expect } from 'vitest';
import { detector } from './doc-hygiene';
import { validateRecommendationProvenance } from '../provenance';
import type { RecommendationInput } from '../types';
import type { DocEdge, DocGraph, DocNode } from '../../parse-docs';
import type { RepoMapDataset } from '../../parse-repo-map-join';
import type { DocHygieneArtifact } from '../../doc-hygiene-artifact';

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

const graph = (nodes: DocNode[], edges: DocEdge[] = []): DocGraph => ({ nodes, edges });

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
  docHygieneArtifact?: DocHygieneArtifact | null
) {
  const input = {
    docGraph,
    repoMap: rm,
    docHygieneArtifact,
  } as unknown as RecommendationInput;
  return detector.rule(input, 0);
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

  it('does not flag a ref whose extension the inventory never covers', () => {
    // A TS-only map cannot judge a `.css` reference — that is a coverage gap,
    // not a dead reference.
    const g = graph([refDoc()], [srcRef('REFERENCES', 'src/styles/app.css')]);
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
