import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
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
import { parseFrontmatter } from '../../parse-docs';
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
  now = 0
) {
  const input = {
    docGraph,
    repoMap: rm,
    docHygieneArtifact,
  } as unknown as RecommendationInput;
  return detector.rule(input, now);
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
