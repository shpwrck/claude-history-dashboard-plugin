import { describe, expect, it } from 'vitest';
import {
  docHygieneArtifactFilename,
  parseDocHygieneArtifact,
} from './doc-hygiene-artifact';

function artifact() {
  return {
    schemaVersion: 1,
    generatedAt: '2026-07-09T00:00:00.000Z',
    repo: {
      identity: 'claude-history-dashboard',
      root: '/repo',
      commit: 'abcdef1234567890',
      markdownFiles: 2,
    },
    summary: { score: 5, findingCount: 1, errorCount: 0, warningCount: 1 },
    checks: [
      {
        name: 'lychee.local-links',
        tool: 'lychee',
        toolVersion: '0.24.2',
        status: 'completed',
        score: 5,
        reason: '1 local Markdown link failed',
        findingIds: ['doc-link:docs/a.md:7'],
      },
    ],
    findings: [
      {
        id: 'doc-link:docs/a.md:7',
        check: 'lychee.local-links',
        signal: 'broken-internal-link',
        severity: 'warning',
        path: 'docs/a.md',
        line: 7,
        target: 'docs/gone.md',
        message: 'Cannot find file',
        source: { tool: 'lychee', field: 'error_map[].span' },
      },
    ],
    skipped: [
      {
        name: 'lychee.external-links',
        reason:
          'external URL checks disabled; set CHD_DOC_HYGIENE_EXTERNAL_LINKS=1',
      },
    ],
  };
}

describe('parseDocHygieneArtifact', () => {
  it('accepts the bounded normalized shape at the expected root/commit', () => {
    expect(
      parseDocHygieneArtifact(artifact(), {
        expectedRoot: '/repo',
        expectedIdentity: 'claude-history-dashboard',
        expectedCommit: 'abcdef1234567890ffff',
      })
    ).toEqual(artifact());
  });

  it('fails closed on malformed, cross-root, stale, or inconsistent artifacts', () => {
    // A binding commit so these cases reach the ROOT/IDENTITY/consistency checks
    // rather than short-circuiting on the #3124 commit-binding guard.
    const bind = { expectedCommit: 'abcdef1234567890' };
    expect(parseDocHygieneArtifact(null, bind)).toBeNull();
    expect(
      parseDocHygieneArtifact({ ...artifact(), schemaVersion: 2 }, bind)
    ).toBeNull();
    expect(
      parseDocHygieneArtifact(artifact(), { ...bind, expectedRoot: '/other' })
    ).toBeNull();
    expect(
      parseDocHygieneArtifact(artifact(), {
        ...bind,
        expectedIdentity: 'other-repo',
      })
    ).toBeNull();
    expect(
      parseDocHygieneArtifact(artifact(), { expectedCommit: '1234567ffff' })
    ).toBeNull();
    expect(
      parseDocHygieneArtifact(
        {
          ...artifact(),
          summary: { ...artifact().summary, findingCount: 2 },
        },
        bind
      )
    ).toBeNull();
  });

  it('refuses schema-valid but unbound artifacts (#3124)', () => {
    const a = artifact();
    // No options / no commit: NOT silently accepted just because the shape is valid.
    expect(parseDocHygieneArtifact(a)).toBeNull();
    expect(parseDocHygieneArtifact(a, {})).toBeNull();
    expect(parseDocHygieneArtifact(a, { expectedCommit: null })).toBeNull();
    expect(parseDocHygieneArtifact(a, { expectedCommit: '' })).toBeNull();
    // A present but malformed (non-hex / too short) commit is also refused.
    expect(parseDocHygieneArtifact(a, { expectedCommit: 'nothex!' })).toBeNull();
    expect(parseDocHygieneArtifact(a, { expectedCommit: 'abc' })).toBeNull();
    // A present, valid, binding commit is accepted; a valid non-binding one fails.
    expect(
      parseDocHygieneArtifact(a, { expectedCommit: 'abcdef1234567890' })
    ).toEqual(a);
    expect(
      parseDocHygieneArtifact(a, { expectedCommit: 'fedcba0987654321' })
    ).toBeNull();
  });

  it('rejects duplicate finding ids and ambiguous check ownership', () => {
    // Bind the commit so these reach the ownership checks (#3124 guard runs first).
    const bind = { expectedCommit: 'abcdef1234567890' };
    const base = artifact();
    const duplicateFinding = {
      ...base,
      summary: { ...base.summary, findingCount: 2, warningCount: 2 },
      checks: [
        {
          ...base.checks[0],
          findingIds: [base.findings[0].id],
        },
      ],
      findings: [base.findings[0], { ...base.findings[0] }],
    };
    expect(parseDocHygieneArtifact(duplicateFinding, bind)).toBeNull();

    const crossOwned = {
      ...base,
      checks: [
        { ...base.checks[0], findingIds: [] },
        {
          ...base.checks[0],
          name: 'lychee.external-links',
          findingIds: [base.findings[0].id],
        },
      ],
    };
    expect(parseDocHygieneArtifact(crossOwned, bind)).toBeNull();

    const unowned = {
      ...base,
      checks: [{ ...base.checks[0], findingIds: [] }],
    };
    expect(parseDocHygieneArtifact(unowned, bind)).toBeNull();
  });

  it('turns only bounded safe repo keys into artifact basenames', () => {
    expect(docHygieneArtifactFilename('claude-history-dashboard')).toBe(
      'claude-history-dashboard.json'
    );
    expect(docHygieneArtifactFilename('../escape')).toBeNull();
    expect(docHygieneArtifactFilename('')).toBeNull();
    expect(docHygieneArtifactFilename('x'.repeat(129))).toBeNull();
  });
});
