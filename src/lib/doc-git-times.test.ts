/**
 * doc-git-times.test.ts — fail-closed validation of the packaged git-times
 * manifest (#2707). Every rejection path must yield NO times: a manifest is
 * either fully trusted (schema + commit binding + bounds + time validity) or
 * contributes nothing.
 */
import { describe, expect, it } from 'vitest';
import {
  DOC_GIT_TIMES_MAX_ENTRIES,
  isValidManifestDocPath,
  parseDocGitTimesManifest,
} from './doc-git-times';

const COMMIT = 'a'.repeat(40);
const NOW_MS = Date.parse('2026-07-16T00:00:00Z');

function valid(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 2,
    sourceCommit: COMMIT,
    files: {
      'README.md': '2026-01-05T10:00:00+00:00',
      'docs/adr/0001-first.md': '2026-02-10T12:30:00Z',
    },
    ...overrides,
  };
}

const opts = { expectedCommit: COMMIT, nowMs: NOW_MS };

describe('parseDocGitTimesManifest', () => {
  it('accepts a valid, commit-bound manifest and returns its times', () => {
    const parsed = parseDocGitTimesManifest(valid(), opts);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.sourceCommit).toBe(COMMIT);
    expect(parsed.times.get('README.md')).toBe('2026-01-05T10:00:00+00:00');
    expect(parsed.times.get('docs/adr/0001-first.md')).toBe('2026-02-10T12:30:00Z');
  });

  it('binds commits case-insensitively and accepts an empty doc set', () => {
    const parsed = parseDocGitTimesManifest(valid({ files: {} }), {
      ...opts,
      expectedCommit: COMMIT.toUpperCase(),
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.times.size).toBe(0);
  });

  it('rejects non-object and structurally broken values', () => {
    for (const value of [null, undefined, 'manifest', 42, [], valid({ files: [] })]) {
      expect(parseDocGitTimesManifest(value, opts).ok).toBe(false);
    }
  });

  it('rejects a legacy schemaVersion even when it declares complete coverage', () => {
    expect(
      parseDocGitTimesManifest(valid({ schemaVersion: 1, complete: true }), opts).ok
    ).toBe(false);
  });

  it('rejects a missing or short sourceCommit', () => {
    expect(parseDocGitTimesManifest(valid({ sourceCommit: undefined }), opts).ok).toBe(false);
    expect(parseDocGitTimesManifest(valid({ sourceCommit: 'abc123' }), opts).ok).toBe(false);
  });

  it('fails closed without a runtime commit to bind against', () => {
    expect(parseDocGitTimesManifest(valid(), { nowMs: NOW_MS }).ok).toBe(false);
    expect(
      parseDocGitTimesManifest(valid(), { expectedCommit: null, nowMs: NOW_MS }).ok
    ).toBe(false);
    expect(
      parseDocGitTimesManifest(valid(), { expectedCommit: '', nowMs: NOW_MS }).ok
    ).toBe(false);
  });

  it('rejects a source-commit mismatch', () => {
    const parsed = parseDocGitTimesManifest(valid(), {
      expectedCommit: 'b'.repeat(40),
      nowMs: NOW_MS,
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toMatch(/does not match/);
  });

  it('rejects an over-cap manifest', () => {
    const files: Record<string, string> = {};
    for (let i = 0; i <= DOC_GIT_TIMES_MAX_ENTRIES; i += 1) {
      files[`docs/f${i}.md`] = '2026-01-05T10:00:00Z';
    }
    expect(parseDocGitTimesManifest(valid({ files }), opts).ok).toBe(false);
  });

  it('rejects the whole manifest on one future-dated entry', () => {
    const files = {
      'README.md': '2026-01-05T10:00:00Z',
      'docs/late.md': '2026-07-18T00:00:00Z', // > nowMs + 24h skew
    };
    const parsed = parseDocGitTimesManifest(valid({ files }), opts);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toMatch(/future-dated/);
  });

  it('tolerates bounded committer-clock skew (within 24h ahead)', () => {
    const files = { 'README.md': '2026-07-16T12:00:00Z' };
    expect(parseDocGitTimesManifest(valid({ files }), opts).ok).toBe(true);
  });

  it('rejects the whole manifest on one implausibly old entry (lower bound)', () => {
    for (const iso of ['0001-01-01T00:00:00Z', '1999-12-31T23:59:59Z']) {
      const parsed = parseDocGitTimesManifest(
        valid({ files: { 'README.md': iso } }),
        opts
      );
      expect(parsed.ok, iso).toBe(false);
      if (!parsed.ok) expect(parsed.reason).toMatch(/implausibly old/);
    }
    // The boundary itself is valid.
    expect(
      parseDocGitTimesManifest(
        valid({ files: { 'README.md': '2000-01-01T00:00:00Z' } }),
        opts
      ).ok
    ).toBe(true);
  });

  it('rejects the whole manifest on one malformed path or time', () => {
    for (const files of [
      { '../escape.md': '2026-01-05T10:00:00Z' },
      { '/abs/path.md': '2026-01-05T10:00:00Z' },
      { 'docs\\win.md': '2026-01-05T10:00:00Z' },
      { 'docs/code.ts': '2026-01-05T10:00:00Z' },
      { 'README.md': 'yesterday' },
      { 'README.md': '2026-01-05' },
      { 'README.md': 1736071200000 },
    ]) {
      expect(
        parseDocGitTimesManifest(valid({ files }), opts).ok,
        JSON.stringify(files)
      ).toBe(false);
    }
  });
});

describe('isValidManifestDocPath', () => {
  it('accepts bounded repo-relative POSIX markdown paths', () => {
    expect(isValidManifestDocPath('README.md')).toBe(true);
    expect(isValidManifestDocPath('docs/adr/0001-x.md')).toBe(true);
  });

  it('rejects traversal, absolute, non-md, and degenerate paths', () => {
    expect(isValidManifestDocPath('docs/../../x.md')).toBe(false);
    expect(isValidManifestDocPath('./x.md')).toBe(false);
    expect(isValidManifestDocPath('C:/docs/x.md')).toBe(false);
    expect(isValidManifestDocPath('docs//x.md')).toBe(false);
    expect(isValidManifestDocPath('')).toBe(false);
    expect(isValidManifestDocPath(`docs/${'a'.repeat(1024)}.md`)).toBe(false);
  });
});
