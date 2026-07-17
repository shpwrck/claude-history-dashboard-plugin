import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DOCS_MAP_MAX_DOCUMENTS,
  DOCS_MAP_MAX_PATH_CHARS,
  DOCS_MAP_MAX_SOURCES_PER_DOCUMENT,
  DOCS_MAP_MAX_SYMBOL_CHARS,
  DOCS_MAP_MAX_SYMBOLS_PER_SOURCE,
  isNormalizedRepoRelativePath,
  isRepositorySlug,
  normalizeGitRemoteUrl,
  parseDocsMap,
} from './parse-docs-map';

function validMap(): Record<string, unknown> {
  return {
    version: 1,
    repository: 'shpwrck/claude-history-dashboard',
    documents: {
      'docs/example.md': {
        sources: [{ path: 'src/lib/example.ts', symbols: ['buildExample'] }],
      },
    },
  };
}

describe('parseDocsMap (#2709 strict v1 contract)', () => {
  it('accepts a valid v1 map and rebuilds it from fresh objects', () => {
    const input = validMap();
    const parsed = parseDocsMap(input);
    expect(parsed).toEqual(input);
    expect(parsed).not.toBe(input);
    expect(parsed?.documents).not.toBe(input.documents);
    expect(parsed?.documents['docs/example.md'].sources).not.toBe(
      (input.documents as Record<string, { sources: unknown }>)['docs/example.md']
        .sources
    );
  });

  it('returns a null-prototype documents record (no inherited membership answers)', () => {
    const parsed = parseDocsMap(validMap());
    expect(Object.getPrototypeOf(parsed?.documents)).toBeNull();
    // On a plain object these would answer from Object.prototype.
    const documents = parsed?.documents as Record<string, unknown>;
    expect('constructor' in documents).toBe(false);
    expect(documents['toString']).toBeUndefined();
    expect(documents['hasOwnProperty']).toBeUndefined();
  });

  it('accepts an empty documents object (a map that declares nothing)', () => {
    expect(parseDocsMap({ ...validMap(), documents: {} })).toEqual({
      version: 1,
      repository: 'shpwrck/claude-history-dashboard',
      documents: {},
    });
  });

  it('accepts an empty symbols array as a file-level binding', () => {
    const map = validMap();
    (map.documents as Record<string, unknown>)['docs/example.md'] = {
      sources: [{ path: 'src/lib/example.ts', symbols: [] }],
    };
    expect(parseDocsMap(map)?.documents['docs/example.md'].sources).toEqual([
      { path: 'src/lib/example.ts', symbols: [] },
    ]);
  });

  it('accepts the same source path declared by DIFFERENT documents', () => {
    const map = validMap();
    (map.documents as Record<string, unknown>)['docs/other.md'] = {
      sources: [{ path: 'src/lib/example.ts', symbols: ['otherView'] }],
    };
    expect(parseDocsMap(map)).not.toBeNull();
  });

  it('returns null for absent input', () => {
    expect(parseDocsMap(null)).toBeNull();
    expect(parseDocsMap(undefined)).toBeNull();
  });

  it('returns null for non-object roots', () => {
    for (const value of ['{}', 7, true, [], [validMap()]]) {
      expect(parseDocsMap(value)).toBeNull();
    }
  });

  it('rejects unknown or malformed versions (whole map to null)', () => {
    for (const version of [2, 0, -1, '1', 1.5, null, undefined]) {
      expect(parseDocsMap({ ...validMap(), version })).toBeNull();
    }
  });

  it('rejects unknown extra keys at every level (strict v1)', () => {
    expect(parseDocsMap({ ...validMap(), extra: true })).toBeNull();
    const extraDocKey = validMap();
    (extraDocKey.documents as Record<string, unknown>)['docs/example.md'] = {
      sources: [{ path: 'src/lib/example.ts', symbols: [] }],
      note: 'nope',
    };
    expect(parseDocsMap(extraDocKey)).toBeNull();
    const extraSourceKey = validMap();
    (extraSourceKey.documents as Record<string, unknown>)['docs/example.md'] = {
      sources: [{ path: 'src/lib/example.ts', symbols: [], line: 1 }],
    };
    expect(parseDocsMap(extraSourceKey)).toBeNull();
  });

  it('rejects missing required keys', () => {
    const noRepository = validMap();
    delete noRepository.repository;
    expect(parseDocsMap(noRepository)).toBeNull();
    const noSources = validMap();
    (noSources.documents as Record<string, unknown>)['docs/example.md'] = {};
    expect(parseDocsMap(noSources)).toBeNull();
    const noSymbols = validMap();
    (noSymbols.documents as Record<string, unknown>)['docs/example.md'] = {
      sources: [{ path: 'src/lib/example.ts' }],
    };
    expect(parseDocsMap(noSymbols)).toBeNull();
  });

  it('rejects malformed repository slugs', () => {
    for (const repository of [
      '',
      'no-slash',
      'a/b/c',
      'owner/',
      '/repo',
      'owner/re po',
      'owner/..',
      'owner/.',
      // The derived side (normalizeGitRemoteUrl) strips `.git`, so a declared
      // `.git` suffix could structurally never match any checkout identity.
      'owner/repo.git',
      'owner/REPO.GIT',
      `o/${'r'.repeat(200)}`,
      7,
      null,
    ]) {
      expect(parseDocsMap({ ...validMap(), repository })).toBeNull();
    }
  });

  it('rejects C1 control and invisible/bidi format characters in paths and symbols', () => {
    // Built via fromCharCode so no invisible bytes live in this test source.
    const nastyChars = [
      String.fromCharCode(0x0085), // C1 NEL
      String.fromCharCode(0x200b), // zero-width space
      String.fromCharCode(0x200d), // zero-width joiner
      String.fromCharCode(0x2060), // word joiner
      String.fromCharCode(0x202e), // right-to-left override
      String.fromCharCode(0xfeff), // BOM / zero-width no-break space
    ];
    for (const nasty of nastyChars) {
      const asPath = validMap();
      (asPath.documents as Record<string, unknown>)[`docs/a${nasty}b.md`] = {
        sources: [{ path: 'src/lib/example.ts', symbols: [] }],
      };
      expect(parseDocsMap(asPath), `path char u+${nasty.charCodeAt(0).toString(16)}`).toBeNull();
      const asSymbol = validMap();
      (asSymbol.documents as Record<string, unknown>)['docs/example.md'] = {
        sources: [{ path: 'src/lib/example.ts', symbols: [`a${nasty}b`] }],
      };
      expect(parseDocsMap(asSymbol), `symbol char u+${nasty.charCodeAt(0).toString(16)}`).toBeNull();
    }
  });

  it('rejects non-object documents values', () => {
    for (const documents of [null, [], 'docs', 7]) {
      expect(parseDocsMap({ ...validMap(), documents })).toBeNull();
    }
  });

  it('rejects traversal, absolute, and non-normalized paths (documents and sources)', () => {
    const badPaths = [
      '/etc/passwd',
      '../outside.md',
      'docs/../secret.md',
      'docs//double.md',
      'docs\\windows.md',
      'C:/drive.md',
      '~/home.md',
      'docs/trailing/',
      'docs/./self.md',
      ' docs/padded.md',
      'docs/padded.md ',
      '.',
      '',
      'docs/__proto__/x.md',
      `docs/${'a'.repeat(DOCS_MAP_MAX_PATH_CHARS)}.md`,
    ];
    for (const bad of badPaths) {
      const asDocument = validMap();
      (asDocument.documents as Record<string, unknown>)[bad] = {
        sources: [{ path: 'src/lib/example.ts', symbols: [] }],
      };
      expect(parseDocsMap(asDocument), `document path: ${JSON.stringify(bad)}`).toBeNull();
      const asSource = validMap();
      (asSource.documents as Record<string, unknown>)['docs/example.md'] = {
        sources: [{ path: bad, symbols: [] }],
      };
      expect(parseDocsMap(asSource), `source path: ${JSON.stringify(bad)}`).toBeNull();
    }
  });

  it('rejects duplicate source paths within one document', () => {
    const map = validMap();
    (map.documents as Record<string, unknown>)['docs/example.md'] = {
      sources: [
        { path: 'src/lib/example.ts', symbols: ['a'] },
        { path: 'src/lib/example.ts', symbols: ['b'] },
      ],
    };
    expect(parseDocsMap(map)).toBeNull();
  });

  it('rejects duplicate symbols within one source', () => {
    const map = validMap();
    (map.documents as Record<string, unknown>)['docs/example.md'] = {
      sources: [{ path: 'src/lib/example.ts', symbols: ['dup', 'dup'] }],
    };
    expect(parseDocsMap(map)).toBeNull();
  });

  it('rejects malformed symbols', () => {
    for (const symbol of ['', ' padded', 'two words', 'tab\tchar', 7, null, 's'.repeat(DOCS_MAP_MAX_SYMBOL_CHARS + 1)]) {
      const map = validMap();
      (map.documents as Record<string, unknown>)['docs/example.md'] = {
        sources: [{ path: 'src/lib/example.ts', symbols: [symbol] }],
      };
      expect(parseDocsMap(map), `symbol: ${JSON.stringify(symbol)}`).toBeNull();
    }
  });

  it('rejects empty and non-array sources', () => {
    for (const sources of [[], null, {}, 'src']) {
      const map = validMap();
      (map.documents as Record<string, unknown>)['docs/example.md'] = { sources };
      expect(parseDocsMap(map)).toBeNull();
    }
  });

  it('enforces every count bound', () => {
    const tooManyDocuments = validMap();
    for (let i = 0; i <= DOCS_MAP_MAX_DOCUMENTS; i += 1) {
      (tooManyDocuments.documents as Record<string, unknown>)[`docs/d${i}.md`] = {
        sources: [{ path: 'src/lib/example.ts', symbols: [] }],
      };
    }
    expect(parseDocsMap(tooManyDocuments)).toBeNull();

    const tooManySources = validMap();
    (tooManySources.documents as Record<string, unknown>)['docs/example.md'] = {
      sources: Array.from(
        { length: DOCS_MAP_MAX_SOURCES_PER_DOCUMENT + 1 },
        (_, i) => ({ path: `src/lib/s${i}.ts`, symbols: [] })
      ),
    };
    expect(parseDocsMap(tooManySources)).toBeNull();

    const tooManySymbols = validMap();
    (tooManySymbols.documents as Record<string, unknown>)['docs/example.md'] = {
      sources: [
        {
          path: 'src/lib/example.ts',
          symbols: Array.from(
            { length: DOCS_MAP_MAX_SYMBOLS_PER_SOURCE + 1 },
            (_, i) => `symbol${i}`
          ),
        },
      ],
    };
    expect(parseDocsMap(tooManySymbols)).toBeNull();
  });

  it('rejects the WHOLE map when only one of several entries is bad', () => {
    const map = validMap();
    (map.documents as Record<string, unknown>)['docs/good.md'] = {
      sources: [{ path: 'src/lib/good.ts', symbols: ['fine'] }],
    };
    (map.documents as Record<string, unknown>)['docs/bad.md'] = {
      sources: [{ path: '../escape.ts', symbols: ['fine'] }],
    };
    expect(parseDocsMap(map)).toBeNull();
  });
});

describe('isNormalizedRepoRelativePath / isRepositorySlug', () => {
  it('accepts normalized repo-relative paths', () => {
    expect(isNormalizedRepoRelativePath('docs/a b/readme.md')).toBe(true);
    expect(isNormalizedRepoRelativePath('src/lib/x.ts')).toBe(true);
    expect(isNormalizedRepoRelativePath('README.md')).toBe(true);
  });

  it('accepts owner/repo slugs and rejects everything else', () => {
    expect(isRepositorySlug('shpwrck/claude-history-dashboard')).toBe(true);
    expect(isRepositorySlug('a/b.c_d-e')).toBe(true);
    expect(isRepositorySlug('a b/c')).toBe(false);
    expect(isRepositorySlug(undefined)).toBe(false);
  });
});

describe('normalizeGitRemoteUrl', () => {
  it('normalizes scheme and scp-like remotes to one lowercase owner/repo slug', () => {
    for (const [url, expected] of [
      ['https://github.com/shpwrck/claude-history-dashboard.git', 'shpwrck/claude-history-dashboard'],
      ['https://github.com/shpwrck/claude-history-dashboard', 'shpwrck/claude-history-dashboard'],
      ['https://user:pass@github.com/o/r.git', 'o/r'],
      ['ssh://git@github.com/o/r.git', 'o/r'],
      ['ssh://git@github.com:2222/o/r.git', 'o/r'],
      ['git@github.com:o/r.git', 'o/r'],
      ['github.com:o/r', 'o/r'],
      ['https://github.com/o/r/', 'o/r'],
      ['https://github.com/o/r.GIT', 'o/r'],
      // Case-folded canonical form: GitHub slugs are case-insensitive, so
      // MixedCase remotes must derive the SAME identity everywhere.
      ['https://github.com/OWNER/RepoName.git', 'owner/reponame'],
      ['git@github.com:Acme/Widgets.git', 'acme/widgets'],
    ] as const) {
      expect(normalizeGitRemoteUrl(url), url).toBe(expected);
    }
  });

  it('returns null when no two-segment slug is derivable', () => {
    for (const url of [
      '',
      '   ',
      'not a url',
      'https://github.com/only-owner',
      'https://github.com/o/r/extra',
      '/srv/git/repo.git',
      'file:///srv/git/repo.git',
      'https://%zz/o/r',
      // Single-letter scp "host" tokens are drive prefixes, not remotes.
      'C:owner/repo',
      'c:o/r.git',
      42,
      null,
      undefined,
    ]) {
      expect(normalizeGitRemoteUrl(url), String(url)).toBeNull();
    }
  });
});

describe('docs/docs-map.json seeds (#2709)', () => {
  const seedPath = join(process.cwd(), 'docs', 'docs-map.json');

  it('parses under the strict v1 contract and binds to this repository', () => {
    const parsed = parseDocsMap(JSON.parse(readFileSync(seedPath, 'utf8')));
    expect(parsed).not.toBeNull();
    expect(parsed?.repository).toBe('shpwrck/claude-history-dashboard');
    const documentCount = Object.keys(parsed?.documents ?? {}).length;
    expect(documentCount).toBeGreaterThanOrEqual(3);
    expect(documentCount).toBeLessThanOrEqual(5);
  });

  it('declares only real documents, real source files, and really-exported symbols', () => {
    const parsed = parseDocsMap(JSON.parse(readFileSync(seedPath, 'utf8')));
    expect(parsed).not.toBeNull();
    for (const [documentPath, document] of Object.entries(parsed?.documents ?? {})) {
      expect(existsSync(join(process.cwd(), documentPath)), documentPath).toBe(true);
      for (const source of document.sources) {
        const sourcePath = join(process.cwd(), source.path);
        expect(existsSync(sourcePath), source.path).toBe(true);
        expect(source.symbols.length).toBeGreaterThan(0);
        const text = readFileSync(sourcePath, 'utf8');
        for (const symbol of source.symbols) {
          expect(
            new RegExp(
              `export (?:async )?(?:function|const|let|class|interface|type|enum)\\s+${symbol}\\b`
            ).test(text),
            `${source.path} must export ${symbol}`
          ).toBe(true);
        }
      }
    }
  });
});
