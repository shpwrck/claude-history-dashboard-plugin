import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateRepoMap, renderRepoMap } from './generate';
import {
  computeCacheKey,
  enforceSizeLimit,
  isCacheValid,
} from './cache';
import {
  createRepoMapFileCache,
  DEFAULT_REPO_MAP_FILE_CACHE_MAX_BYTES,
  REPO_MAP_FILE_CACHE_VERSION,
} from './file-cache';
import { createTsParseFile, repoMapParserCacheSalt } from './parser';
import { RepoMapParserInitializationError } from './types';
import type { FileStructure, ParseFile, RepoSymbol } from './types';

const roots: string[] = [];

const INVALID_REPO_SYMBOL_FIELD_VALUES = {
  name: [undefined, null, 42, false, {}, []],
  kind: [undefined, null, 42, false, {}, [], 'not-a-repo-symbol-kind'],
  exported: [undefined, null, 0, 'true', {}, []],
  signature: [undefined, null, 42, false, {}, []],
  line: [
    undefined,
    null,
    false,
    '37',
    {},
    [],
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ],
} satisfies Record<keyof Required<RepoSymbol>, readonly unknown[]>;

const MALFORMED_REPO_SYMBOL_CASES = Object.entries(
  INVALID_REPO_SYMBOL_FIELD_VALUES
).flatMap(([field, values]) =>
  values.map((value, index) => [`${field} case ${index + 1}`, field, value] as const)
);

const SPARSE_IMPORTS: string[] = [];
SPARSE_IMPORTS.length = 1;

const ACCESSOR_IMPORTS: string[] = [];
Object.defineProperty(ACCESSOR_IMPORTS, 0, {
  configurable: true,
  enumerable: true,
  get: () => 'must-not-execute-array-accessor',
});

const PROXIED_IMPORTS = new Proxy([] as string[], {});
const PROXIED_STRUCTURE = new Proxy(
  { symbols: [] as RepoSymbol[], imports: [] as string[] },
  {}
);

let thenAccessorReads = 0;
const THEN_ACCESSOR_OUTPUT = {
  symbols: [] as RepoSymbol[],
  imports: [] as string[],
  get then(): undefined {
    thenAccessorReads += 1;
    throw new RepoMapParserInitializationError(
      new Error('returned then accessor is not parser initialization')
    );
  },
};

let proxyThenReads = 0;
const THEN_TRAP_PROXY = new Proxy(
  { symbols: [] as RepoSymbol[], imports: [] as string[] },
  {
    get: (target, property, receiver) => {
      if (property === 'then') {
        proxyThenReads += 1;
        throw new RepoMapParserInitializationError(
          new Error('proxy then trap is not parser initialization')
        );
      }
      return Reflect.get(target, property, receiver);
    },
  }
);

let unknownAccessorReads = 0;
const UNKNOWN_ACCESSOR_OUTPUT = {
  symbols: [] as RepoSymbol[],
  imports: [] as string[],
  get toJSON(): () => string {
    unknownAccessorReads += 1;
    return () => 'must-not-run-to-json';
  },
};

class ParserPromiseSubclass extends Promise<FileStructure> {}
let promiseSubclassThenReads = 0;

function parserPromiseSubclass(
  executor: (
    resolve: (value: FileStructure) => void,
    reject: (reason: unknown) => void
  ) => void
): Promise<FileStructure> {
  const promise = new ParserPromiseSubclass(executor);
  Object.defineProperty(promise, 'then', {
    configurable: true,
    get: () => {
      promiseSubclassThenReads += 1;
      return Promise.prototype.then;
    },
  });
  return promise;
}

const INHERITED_SPARSE_SYMBOLS: RepoSymbol[] = [];
INHERITED_SPARSE_SYMBOLS.length = 1;
const inheritedSymbolPrototype = Object.create(Array.prototype) as Record<
  number,
  RepoSymbol
>;
inheritedSymbolPrototype[0] = {
  name: 'inherited',
  kind: 'const',
  exported: true,
  signature: 'const inherited',
  line: 1,
};
Object.setPrototypeOf(INHERITED_SPARSE_SYMBOLS, inheritedSymbolPrototype);

const INITIALIZATION_ERROR_ACCESSOR_OUTPUT = {
  imports: [] as string[],
  get symbols(): RepoSymbol[] {
    throw new RepoMapParserInitializationError(
      new Error('returned object accessor is not parser initialization')
    );
  },
};

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop() as string, { recursive: true, force: true });
  }
});

function structureParser(calls: string[]): ParseFile {
  return (source, path) => {
    calls.push(path);
    return {
      symbols: [...source.matchAll(/export const (\w+)/g)].map((match) => ({
        name: match[1],
        kind: 'const' as const,
        exported: true,
        signature: `const ${match[1]}`,
        line: 1,
      })),
      imports: [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]),
    };
  };
}

function cacheFor(
  cacheFile: string,
  salt: string,
  calls: string[],
  options: { reuse?: boolean; maxBytes?: number; parseFile?: ParseFile } = {}
) {
  return createRepoMapFileCache({
    cacheFile,
    salt,
    parseFile: options.parseFile ?? structureParser(calls),
    reuse: options.reuse,
    maxBytes: options.maxBytes,
  });
}

describe('repo-map per-file cache', () => {
  it('keeps uncached, cold, warm, and sidecar parser output exact and privacy-safe', async () => {
    const root = tempDir('repo-map-file-cache-root-');
    const cacheFile = join(tempDir('repo-map-file-cache-store-'), 'cache.json');
    const source = 'export interface CacheRoundTrip {}\n';
    const path = 'round-trip.ts';
    const parserOnlySentinel = 'must-not-cross-the-parser-output-boundary';
    writeFileSync(join(root, path), source);
    const symbol = {
      name: 'CacheRoundTrip',
      kind: 'interface',
      exported: true,
      signature: 'export interface CacheRoundTrip',
      line: 37,
    } satisfies Required<RepoSymbol>;
    const expectedStructure = {
      symbols: [symbol],
      imports: ['./distinct-dependency'],
    } satisfies FileStructure;
    const coldParser: ParseFile = () => ({
      symbols: [
        {
          ...symbol,
          parserOnlyBody: parserOnlySentinel,
        },
      ],
      imports: [...expectedStructure.imports],
      parserOnlyState: parserOnlySentinel,
    });

    const uncachedMap = await generateRepoMap(root, {
      parseFile: coldParser,
      tokenBudget: 5000,
    });
    expect(uncachedMap.files[0]?.symbols[0]).toStrictEqual(symbol);
    expect(JSON.stringify(uncachedMap)).not.toContain(parserOnlySentinel);

    const cold = createRepoMapFileCache({
      cacheFile,
      salt: 'repo-symbol-parity',
      parseFile: coldParser,
    });

    const coldStructure = await cold.parseFile(source, path);
    expect(coldStructure).toStrictEqual(expectedStructure);
    const coldMap = await generateRepoMap(root, {
      parseFile: cold.parseFile,
      tokenBudget: 5000,
    });
    expect(coldMap.files).toStrictEqual(uncachedMap.files);
    expect(coldMap.text).toBe(uncachedMap.text);
    expect(JSON.stringify(coldMap)).not.toContain(parserOnlySentinel);
    expect(cold.commit()).toMatchObject({ written: true, entryCount: 1 });

    const persisted = JSON.parse(readFileSync(cacheFile, 'utf8')) as {
      entries: Record<string, { structure: FileStructure }>;
    };
    expect(persisted.entries[path]?.structure).toStrictEqual(expectedStructure);
    expect(persisted.entries[path]?.structure.symbols[0]).not.toHaveProperty(
      'parserOnlyBody'
    );
    expect(persisted.entries[path]?.structure).not.toHaveProperty('parserOnlyState');
    expect(JSON.stringify(persisted)).not.toContain(parserOnlySentinel);

    const fallbackParserFactory = vi.fn((): ParseFile => {
      throw new Error('warm hit must not construct the parser');
    });
    const warm = createRepoMapFileCache({
      cacheFile,
      salt: 'repo-symbol-parity',
      parseFileFactory: fallbackParserFactory,
    });

    const warmStructure = await warm.parseFile(source, path);
    expect(warmStructure).toStrictEqual(expectedStructure);
    expect(warm.stats).toEqual({ hits: 1, misses: 0 });
    expect(fallbackParserFactory).not.toHaveBeenCalled();
    const warmMap = await generateRepoMap(root, {
      parseFile: warm.parseFile,
      tokenBudget: 5000,
    });
    expect(warmMap.files).toStrictEqual(uncachedMap.files);
    expect(warmMap.text).toBe(uncachedMap.text);
    expect(JSON.stringify(warmMap)).not.toContain(parserOnlySentinel);
    expect(fallbackParserFactory).not.toHaveBeenCalled();
  });

  it('bridges Promise subclasses without reading own then accessors', async () => {
    const root = tempDir('repo-map-promise-subclass-root-');
    const cacheFile = join(
      tempDir('repo-map-promise-subclass-cache-'),
      'cache.json'
    );
    writeFileSync(join(root, 'async.ts'), 'export const asyncValue = 1;\n');
    const sentinel = 'promise-subclass-parser-only-sentinel';
    promiseSubclassThenReads = 0;
    const parseFile = (): Promise<FileStructure> =>
      parserPromiseSubclass((resolve) =>
        resolve({
          symbols: [
            {
              name: 'asyncValue',
              kind: 'const',
              exported: true,
              signature: 'const asyncValue',
              line: 1,
              parserOnlyBody: sentinel,
            } as RepoSymbol,
          ],
          imports: [],
        })
      );

    const direct = await generateRepoMap(root, {
      parseFile,
      tokenBudget: 5000,
    });
    expect(direct.files[0]?.symbols[0]?.name).toBe('asyncValue');
    expect(JSON.stringify(direct)).not.toContain(sentinel);

    const cold = createRepoMapFileCache({
      cacheFile,
      salt: 'promise-subclass',
      parseFile,
    });
    const coldMap = await generateRepoMap(root, {
      parseFile: cold.parseFile,
      tokenBudget: 5000,
    });
    expect(coldMap.files).toStrictEqual(direct.files);
    expect(cold.commit()).toMatchObject({ written: true, entryCount: 1 });

    const warmFactory = vi.fn((): ParseFile => {
      throw new Error('warm Promise-subclass hit must not construct a parser');
    });
    const warm = createRepoMapFileCache({
      cacheFile,
      salt: 'promise-subclass',
      parseFileFactory: warmFactory,
    });
    const warmMap = await generateRepoMap(root, {
      parseFile: warm.parseFile,
      tokenBudget: 5000,
    });
    expect(warmMap.files).toStrictEqual(direct.files);
    expect(warm.stats).toEqual({ hits: 1, misses: 0 });
    expect(warmFactory).not.toHaveBeenCalled();
    expect(promiseSubclassThenReads).toBe(0);
  });

  it('does not re-assimilate an already-fulfilled parser value', async () => {
    const root = tempDir('repo-map-fulfilled-then-root-');
    writeFileSync(join(root, 'fulfilled.ts'), 'export const fulfilled = 1;\n');
    let thenReads = 0;
    const output = { symbols: [] as RepoSymbol[], imports: [] as string[] };
    const fulfilled = Promise.resolve(output);
    Object.defineProperty(output, 'then', {
      configurable: true,
      get: () => {
        thenReads += 1;
        throw new Error('fulfilled parser value then getter must not execute');
      },
    });

    const map = await generateRepoMap(root, {
      parseFile: () => fulfilled,
      tokenBudget: 5000,
    });

    // The normalizer rejects the unknown accessor as malformed, but neither
    // the bridge nor `await` may execute it first.
    expect(map.files).toEqual([]);
    expect(thenReads).toBe(0);
  });

  it('observes rejected fully frozen standard Promise subclasses', async () => {
    const root = tempDir('repo-map-frozen-promise-root-');
    writeFileSync(join(root, 'rejected.ts'), 'export const rejected = 1;\n');
    let thenReads = 0;
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    class FrozenParserPromise extends Promise<FileStructure> {}
    const rejected = new FrozenParserPromise((_resolve, reject) =>
      reject(new Error('frozen parser rejection'))
    );
    Object.defineProperty(rejected, 'then', {
      configurable: true,
      get: () => {
        thenReads += 1;
        return Promise.prototype.then;
      },
    });
    Object.freeze(FrozenParserPromise.prototype);
    Object.freeze(FrozenParserPromise);
    Object.preventExtensions(rejected);

    try {
      const map = await generateRepoMap(root, {
        parseFile: () => rejected,
        tokenBudget: 5000,
      });
      expect(map.files).toEqual([]);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(thenReads).toBe(0);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('fails before executing a fully locked custom Promise species hook', async () => {
    const root = tempDir('repo-map-locked-species-root-');
    const cacheFile = join(
      tempDir('repo-map-locked-species-cache-'),
      'cache.json'
    );
    writeFileSync(join(root, 'locked.ts'), 'export const locked = 1;\n');
    let speciesReads = 0;

    class LockedSpeciesPromise extends Promise<FileStructure> {}
    Object.defineProperty(LockedSpeciesPromise, Symbol.species, {
      configurable: false,
      get: () => {
        speciesReads += 1;
        return Promise;
      },
    });
    const locked = new LockedSpeciesPromise((resolve) =>
      resolve({ symbols: [], imports: [] })
    );
    Object.freeze(LockedSpeciesPromise.prototype);
    Object.preventExtensions(locked);

    await expect(
      generateRepoMap(root, {
        parseFile: () => locked,
        tokenBudget: 5000,
      })
    ).rejects.toBeInstanceOf(RepoMapParserInitializationError);
    const cold = createRepoMapFileCache({
      cacheFile,
      salt: 'locked-species',
      parseFile: () => locked,
    });
    await expect(
      generateRepoMap(root, {
        parseFile: cold.parseFile,
        tokenBudget: 5000,
      })
    ).rejects.toBeInstanceOf(RepoMapParserInitializationError);
    expect(() => readFileSync(cacheFile, 'utf8')).toThrow();
    expect(speciesReads).toBe(0);
  });

  it('observes rejected decorated promises and non-extensible subclasses before artifact construction', async () => {
    const root = tempDir('repo-map-rejected-promise-root-');
    const cacheFile = join(
      tempDir('repo-map-rejected-promise-cache-'),
      'cache.json'
    );
    writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
    writeFileSync(join(root, 'b.ts'), 'export const b = 1;\n');
    writeFileSync(join(root, 'c.ts'), 'export const c = 1;\n');
    promiseSubclassThenReads = 0;
    const parseFile = ((_source: string, path: string) => {
      if (path === 'a.ts') {
        const decorated = Promise.reject(
          new Error('decorated-parser-promise-rejected')
        ) as Promise<FileStructure> & FileStructure;
        Object.defineProperties(decorated, {
          symbols: { configurable: true, value: [], writable: true },
          imports: { configurable: true, value: [], writable: true },
        });
        return decorated;
      }
      if (path === 'b.ts') {
        const subclass = parserPromiseSubclass((_resolve, reject) =>
          reject(new Error('parser-promise-subclass-rejected'))
        );
        Object.preventExtensions(subclass);
        return subclass;
      }
      return {
        symbols: [
          {
            name: 'c',
            kind: 'const',
            exported: true,
            signature: 'const c',
            line: 1,
          },
        ],
        imports: [],
      };
    }) as ParseFile;

    const direct = await generateRepoMap(root, {
      parseFile,
      tokenBudget: 5000,
    });
    expect(direct.files.map((file) => file.path)).toEqual(['c.ts']);

    const cold = createRepoMapFileCache({
      cacheFile,
      salt: 'rejected-parser-promises',
      parseFile,
    });
    const coldMap = await generateRepoMap(root, {
      parseFile: cold.parseFile,
      tokenBudget: 5000,
    });
    expect(coldMap.files).toStrictEqual(direct.files);
    expect(cold.commit()).toMatchObject({ written: true, entryCount: 1 });

    const warm = createRepoMapFileCache({
      cacheFile,
      salt: 'rejected-parser-promises',
      parseFile,
    });
    const warmMap = await generateRepoMap(root, {
      parseFile: warm.parseFile,
      tokenBudget: 5000,
    });
    expect(warmMap.files).toStrictEqual(direct.files);
    expect(warm.stats).toEqual({ hits: 1, misses: 2 });
    expect(promiseSubclassThenReads).toBe(0);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });

  it.each([
    ['a non-object result', null],
    ['a non-array symbols field', { symbols: 'invalid', imports: [] }],
    ['a non-string import', { symbols: [], imports: [42] }],
    ['a sparse imports array', { symbols: [], imports: SPARSE_IMPORTS }],
    ['an accessor import', { symbols: [], imports: ACCESSOR_IMPORTS }],
    ['a proxied imports array', { symbols: [], imports: PROXIED_IMPORTS }],
    ['a proxied structure', PROXIED_STRUCTURE],
    ['an unknown then accessor', THEN_ACCESSOR_OUTPUT],
    ['a proxy with a then trap', THEN_TRAP_PROXY],
    ['an unknown serialization accessor', UNKNOWN_ACCESSOR_OUTPUT],
    [
      'an inherited sparse symbol',
      { symbols: INHERITED_SPARSE_SYMBOLS, imports: [] },
    ],
    ['an accessor that throws the fatal parser error class', INITIALIZATION_ERROR_ACCESSOR_OUTPUT],
    [
      'a malformed nested symbol',
      {
        symbols: [
          {
            name: 'a',
            kind: 'const',
            exported: true,
            signature: 'const a',
            line: 'not-a-number',
          },
        ],
        imports: [],
      },
    ],
  ] as const)(
    'skips only the malformed file for uncached and cold-cache generation: %s',
    async (_caseName, malformedOutput) => {
      if (_caseName === 'an unknown then accessor') thenAccessorReads = 0;
      if (_caseName === 'a proxy with a then trap') proxyThenReads = 0;
      if (_caseName === 'an unknown serialization accessor') {
        unknownAccessorReads = 0;
      }
      const root = tempDir('repo-map-malformed-parser-root-');
      const cacheFile = join(tempDir('repo-map-malformed-parser-cache-'), 'cache.json');
      writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
      writeFileSync(join(root, 'b.ts'), 'export const b = 1;\n');
      const parseFile = ((_source: string, path: string) =>
        path === 'a.ts'
          ? malformedOutput
          : {
              symbols: [
                {
                  name: 'b',
                  kind: 'const' as const,
                  exported: true,
                  signature: 'const b',
                  line: 1,
                },
              ],
              imports: [],
            }) as unknown as ParseFile;

      const uncachedMap = await generateRepoMap(root, {
        parseFile,
        tokenBudget: 5000,
      });
      expect(uncachedMap.files.map((file) => file.path)).toEqual(['b.ts']);

      const cold = createRepoMapFileCache({
        cacheFile,
        salt: 'malformed-parser-output',
        parseFile,
      });
      const coldMap = await generateRepoMap(root, {
        parseFile: cold.parseFile,
        tokenBudget: 5000,
      });
      expect(coldMap.files).toStrictEqual(uncachedMap.files);
      expect(coldMap.text).toBe(uncachedMap.text);
      expect(cold.commit()).toMatchObject({ written: true, entryCount: 1 });

      const warmCalls: string[] = [];
      const warm = createRepoMapFileCache({
        cacheFile,
        salt: 'malformed-parser-output',
        parseFile: (source, path) => {
          warmCalls.push(path);
          return parseFile(source, path);
        },
      });
      const warmMap = await generateRepoMap(root, {
        parseFile: warm.parseFile,
        tokenBudget: 5000,
      });
      expect(warmMap.files).toStrictEqual(uncachedMap.files);
      expect(warmMap.text).toBe(uncachedMap.text);
      expect(warm.stats).toEqual({ hits: 1, misses: 1 });
      expect(warmCalls).toEqual(['a.ts']);
      if (_caseName === 'an unknown then accessor') {
        expect(thenAccessorReads).toBe(0);
      }
      if (_caseName === 'a proxy with a then trap') {
        expect(proxyThenReads).toBe(0);
      }
      if (_caseName === 'an unknown serialization accessor') {
        expect(unknownAccessorReads).toBe(0);
      }
    }
  );

  it('keeps sidecar schema v2 while the v11 parser salt retires old cohorts', () => {
    expect(REPO_MAP_FILE_CACHE_VERSION).toBe(2);
    expect(repoMapParserCacheSalt()).toMatch(/^repo-map-output-v11:[a-f0-9]{64}$/);
  });

  it.each(MALFORMED_REPO_SYMBOL_CASES)(
    'rejects the whole sidecar cohort for malformed %s',
    async (_caseName, malformedField, malformedValue) => {
      const cacheFile = join(tempDir('repo-map-file-cache-store-'), 'cache.json');
      const sources = new Map([
        ['a.ts', 'export const a = 1;\n'],
        ['b.ts', 'export const b = 1;\n'],
      ]);
      const parser = (calls: string[]): ParseFile => (_source, path) => {
        calls.push(path);
        const name = path.replace('.ts', '');
        return {
          symbols: [
            {
              name,
              kind: 'const',
              exported: true,
              signature: `export const ${name}`,
              line: 1,
            },
          ],
          imports: [],
        };
      };

      const cold = createRepoMapFileCache({
        cacheFile,
        salt: 'malformed-symbol-cohort',
        parseFile: parser([]),
      });
      for (const [path, source] of sources) await cold.parseFile(source, path);
      expect(cold.commit()).toMatchObject({ written: true, entryCount: 2 });

      const cleanWarmCalls: string[] = [];
      const cleanWarm = createRepoMapFileCache({
        cacheFile,
        salt: 'malformed-symbol-cohort',
        parseFile: parser(cleanWarmCalls),
      });
      for (const [path, source] of sources) {
        await cleanWarm.parseFile(source, path);
      }
      expect(cleanWarmCalls).toEqual([]);
      expect(cleanWarm.stats).toEqual({ hits: 2, misses: 0 });

      const persisted = JSON.parse(readFileSync(cacheFile, 'utf8')) as {
        entries: Record<
          string,
          { structure: { symbols: Array<Record<string, unknown>> } }
        >;
      };
      const corruptedSymbol = persisted.entries['a.ts']?.structure.symbols[0];
      expect(corruptedSymbol).toBeDefined();
      if (corruptedSymbol) corruptedSymbol[malformedField] = malformedValue;
      writeFileSync(cacheFile, JSON.stringify(persisted));

      const rejectedCalls: string[] = [];
      const rejected = createRepoMapFileCache({
        cacheFile,
        salt: 'malformed-symbol-cohort',
        parseFile: parser(rejectedCalls),
      });
      for (const [path, source] of sources) {
        await rejected.parseFile(source, path);
      }

      expect(rejectedCalls).toEqual(['a.ts', 'b.ts']);
      expect(rejected.stats).toEqual({ hits: 0, misses: 2 });
    }
  );

  it('reuses unchanged structures and reparses only changed content', async () => {
    const root = tempDir('repo-map-file-cache-root-');
    const cacheFile = join(tempDir('repo-map-file-cache-store-'), 'cache.json');
    writeFileSync(join(root, 'a.ts'), "export const a = 1;\n");
    writeFileSync(join(root, 'b.ts'), "import { a } from './a';\nexport const b = a;\n");

    const coldCalls: string[] = [];
    const coldCache = cacheFor(cacheFile, 'grammar-a', coldCalls);
    await generateRepoMap(root, { parseFile: coldCache.parseFile, tokenBudget: 5000 });
    coldCache.commit();
    expect(coldCalls.sort()).toEqual(['a.ts', 'b.ts']);

    writeFileSync(join(root, 'b.ts'), 'export const changed = 2;\n');
    const warmCalls: string[] = [];
    const warmCache = cacheFor(cacheFile, 'grammar-a', warmCalls);
    const warmMap = await generateRepoMap(root, {
      parseFile: warmCache.parseFile,
      tokenBudget: 5000,
    });
    warmCache.commit();

    expect(warmCalls).toEqual(['b.ts']);
    expect(warmMap.files.find((file) => file.path === 'a.ts')?.symbols[0]?.name).toBe('a');
    expect(warmMap.files.find((file) => file.path === 'b.ts')?.symbols[0]?.name).toBe('changed');

    const freshCalls: string[] = [];
    const freshMap = await generateRepoMap(root, {
      parseFile: structureParser(freshCalls),
      tokenBudget: 5000,
    });
    expect(warmMap).toEqual(freshMap);
  });

  it('keys reuse by content rather than mtime while refreshing host metadata', async () => {
    const root = tempDir('repo-map-file-cache-mtime-');
    const cacheFile = join(tempDir('repo-map-file-cache-store-'), 'cache.json');
    const sourceFile = join(root, 'a.ts');
    writeFileSync(sourceFile, 'export const a = 1;\n');

    const cold = cacheFor(cacheFile, 'grammar-a', []);
    await generateRepoMap(root, { parseFile: cold.parseFile });
    cold.commit();

    const future = new Date(Date.now() + 10_000);
    utimesSync(sourceFile, future, future);
    const calls: string[] = [];
    const warm = cacheFor(cacheFile, 'grammar-a', calls);
    const map = await generateRepoMap(root, { parseFile: warm.parseFile });
    const commit = warm.commit();

    expect(calls).toEqual([]);
    expect(map.files[0]?.mtimeMs).toBeCloseTo(future.getTime(), -1);
    expect(commit).toMatchObject({ changed: false, written: false, entryCount: 1 });
  });

  it('binds artifact identity to both parser salt and the active source cohort', async () => {
    const root = tempDir('repo-map-file-cache-identity-');
    const cacheFile = join(tempDir('repo-map-file-cache-store-'), 'cache.json');
    const sourceFile = join(root, 'a.ts');
    writeFileSync(sourceFile, 'export const a = 1;\n');

    const saltA = cacheFor(cacheFile, 'grammar-a', []);
    await generateRepoMap(root, { parseFile: saltA.parseFile });
    const signatureA = saltA.structureSignature();
    saltA.commit();

    const saltB = cacheFor(cacheFile, 'grammar-b', []);
    await generateRepoMap(root, { parseFile: saltB.parseFile });
    const signatureB = saltB.structureSignature();
    saltB.commit();

    writeFileSync(sourceFile, 'export const changed = 2;\n');
    const changed = cacheFor(cacheFile, 'grammar-b', []);
    await generateRepoMap(root, { parseFile: changed.parseFile });
    const changedSignature = changed.structureSignature();

    expect(signatureA).toMatch(/^[a-f0-9]{64}$/);
    expect(signatureB).toMatch(/^[a-f0-9]{64}$/);
    expect(signatureB).not.toBe(signatureA);
    expect(changedSignature).not.toBe(signatureB);
  });

  it('rejects a concurrently interleaved artifact from another parser cohort', async () => {
    const root = tempDir('repo-map-file-cache-race-');
    const cacheFile = join(tempDir('repo-map-file-cache-store-'), 'cache.json');
    const sourceFile = join(root, 'a.ts');
    writeFileSync(sourceFile, 'export const a = 1;\n');
    const parser = (name: string): ParseFile => () => ({
      symbols: [
        {
          name,
          kind: 'const',
          exported: true,
          signature: `const ${name}`,
          line: 1,
        },
      ],
      imports: [],
    });

    // Both producers generate before either sidecar commit. The old producer's
    // artifact can therefore win while the new producer's sidecar commits last.
    const oldCache = createRepoMapFileCache({
      cacheFile,
      salt: 'grammar-old',
      parseFile: parser('oldSymbol'),
    });
    const oldMap = await generateRepoMap(root, { parseFile: oldCache.parseFile });
    const oldKey = computeCacheKey(
      root,
      'same-clean-git-sha',
      [sourceFile],
      oldCache.structureSignature()
    );
    const oldArtifact = enforceSizeLimit(oldMap, oldKey, (files) =>
      renderRepoMap(files, 5000)
    );

    const newCache = createRepoMapFileCache({
      cacheFile,
      salt: 'grammar-new',
      parseFile: parser('newSymbol'),
    });
    await generateRepoMap(root, { parseFile: newCache.parseFile });
    oldCache.commit();
    newCache.commit();

    const parserFactory = vi.fn(async () => parser('mustNotRun'));
    const nextNew = createRepoMapFileCache({
      cacheFile,
      salt: 'grammar-new',
      parseFileFactory: parserFactory,
    });
    const currentMap = await generateRepoMap(root, { parseFile: nextNew.parseFile });
    const currentKey = computeCacheKey(
      root,
      'same-clean-git-sha',
      [sourceFile],
      nextNew.structureSignature()
    );

    expect(parserFactory).not.toHaveBeenCalled();
    expect(oldArtifact.map.files[0]?.symbols[0]?.name).toBe('oldSymbol');
    expect(currentMap.files[0]?.symbols[0]?.name).toBe('newSymbol');
    expect(nextNew.cohortChanged()).toBe(false);
    expect(isCacheValid(oldArtifact, currentKey)).toBe(false);
  });

  it('does not construct the parser or rewrite the sidecar on an all-hit run', async () => {
    const root = tempDir('repo-map-file-cache-lazy-');
    const cacheFile = join(tempDir('repo-map-file-cache-store-'), 'cache.json');
    writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');

    const cold = cacheFor(cacheFile, 'grammar-a', []);
    await generateRepoMap(root, { parseFile: cold.parseFile });
    cold.commit();

    const parserFactory = vi.fn(async () => structureParser([]));
    const warm = createRepoMapFileCache({
      cacheFile,
      salt: 'grammar-a',
      parseFileFactory: parserFactory,
    });
    await generateRepoMap(root, { parseFile: warm.parseFile });
    const commit = warm.commit();

    expect(parserFactory).not.toHaveBeenCalled();
    expect(commit).toMatchObject({ changed: false, written: false, entryCount: 1 });
  });

  it('fails loudly on lazy parser initialization failure without replacing the cache', async () => {
    const root = tempDir('repo-map-file-cache-init-failure-');
    const cacheFile = join(tempDir('repo-map-file-cache-store-'), 'cache.json');
    writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');

    const cold = cacheFor(cacheFile, 'grammar-a', []);
    await generateRepoMap(root, { parseFile: cold.parseFile });
    cold.commit();
    const before = readFileSync(cacheFile, 'utf8');

    const broken = createRepoMapFileCache({
      cacheFile,
      salt: 'grammar-b',
      parseFileFactory: async () => {
        throw new Error('missing tree-sitter grammar');
      },
    });

    await expect(
      generateRepoMap(root, { parseFile: broken.parseFile })
    ).rejects.toBeInstanceOf(RepoMapParserInitializationError);
    expect(readFileSync(cacheFile, 'utf8')).toBe(before);
  });

  it('invalidates and replaces the whole cache cohort when the grammar salt changes', async () => {
    const root = tempDir('repo-map-file-cache-salt-');
    const cacheFile = join(tempDir('repo-map-file-cache-store-'), 'cache.json');
    writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
    writeFileSync(join(root, 'b.ts'), 'export const b = 1;\n');

    const saltACache = cacheFor(cacheFile, 'grammar-a', []);
    await generateRepoMap(root, { parseFile: saltACache.parseFile });
    saltACache.commit();

    const saltBCalls: string[] = [];
    const saltBCache = cacheFor(cacheFile, 'grammar-b', saltBCalls);
    await generateRepoMap(root, { parseFile: saltBCache.parseFile });
    saltBCache.commit();
    expect(saltBCalls.sort()).toEqual(['a.ts', 'b.ts']);

    const persisted = JSON.parse(readFileSync(cacheFile, 'utf8')) as {
      salt: string;
      entries: Record<string, unknown>;
    };
    expect(persisted.salt).toBe('grammar-b');
    expect(Object.keys(persisted.entries)).toHaveLength(2);

    const sameSaltCalls: string[] = [];
    const sameSalt = cacheFor(cacheFile, 'grammar-b', sameSaltCalls);
    await generateRepoMap(root, { parseFile: sameSalt.parseFile });
    sameSalt.commit();
    expect(sameSaltCalls).toEqual([]);
  });

  it('prunes entries for deleted files from the next committed cohort', async () => {
    const root = tempDir('repo-map-file-cache-delete-');
    const cacheFile = join(tempDir('repo-map-file-cache-store-'), 'cache.json');
    writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
    writeFileSync(join(root, 'b.ts'), 'export const b = 1;\n');

    const cold = cacheFor(cacheFile, 'grammar-a', []);
    await generateRepoMap(root, { parseFile: cold.parseFile });
    cold.commit();
    unlinkSync(join(root, 'b.ts'));

    const calls: string[] = [];
    const warm = cacheFor(cacheFile, 'grammar-a', calls);
    const map = await generateRepoMap(root, { parseFile: warm.parseFile });
    const commit = warm.commit();

    expect(calls).toEqual([]);
    expect(map.files.map((file) => file.path)).toEqual(['a.ts']);
    expect(commit.changed).toBe(true);
    const persisted = JSON.parse(readFileSync(cacheFile, 'utf8')) as {
      entries: Record<string, unknown>;
    };
    expect(Object.keys(persisted.entries)).toHaveLength(1);
  });

  it.each([
    ['malformed JSON', '{ definitely not json'],
    [
      'invalid entry schema',
      JSON.stringify({
        version: REPO_MAP_FILE_CACHE_VERSION,
        salt: 'grammar-a',
        cohort: { bad: 'a'.repeat(64) },
        entries: { bad: { source: 'raw' } },
      }),
    ],
  ])('fails cold and self-heals on %s', async (_label, corrupt) => {
    const root = tempDir('repo-map-file-cache-corrupt-');
    const cacheFile = join(tempDir('repo-map-file-cache-store-'), 'cache.json');
    writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
    writeFileSync(cacheFile, corrupt);

    const calls: string[] = [];
    const cache = cacheFor(cacheFile, 'grammar-a', calls);
    const map = await generateRepoMap(root, { parseFile: cache.parseFile });
    cache.commit();

    expect(calls).toEqual(['a.ts']);
    expect(map.fileCount).toBe(1);
    expect(() => JSON.parse(readFileSync(cacheFile, 'utf8'))).not.toThrow();
  });

  it('rejects oversize input and bounds output without dropping map data', async () => {
    const root = tempDir('repo-map-file-cache-bounds-');
    const cacheDir = tempDir('repo-map-file-cache-store-');
    const cacheFile = join(cacheDir, 'cache.json');
    const maxBytes = 1024;
    writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
    writeFileSync(cacheFile, 'x'.repeat(maxBytes + 1));

    const calls: string[] = [];
    const cache = cacheFor(cacheFile, 'grammar-a', calls, { maxBytes });
    const map = await generateRepoMap(root, { parseFile: cache.parseFile });
    const result = cache.commit();
    expect(calls).toEqual(['a.ts']);
    expect(map.fileCount).toBe(1);
    expect(result.bytes).toBeLessThanOrEqual(maxBytes);

    const hugeFile = join(root, 'huge.ts');
    writeFileSync(hugeFile, 'export const huge = 1;\n');
    const hugeParser: ParseFile = (_source, path) => ({
      symbols: [],
      imports: path === 'huge.ts' ? ['x'.repeat(maxBytes * 2)] : [],
    });
    const hugeCache = cacheFor(cacheFile, 'grammar-b', [], {
      maxBytes,
      parseFile: hugeParser,
    });
    const hugeMap = await generateRepoMap(root, {
      parseFile: hugeCache.parseFile,
      tokenBudget: 10_000,
    });
    const hugeResult = hugeCache.commit();
    expect(hugeMap.files.find((file) => file.path === 'huge.ts')?.imports[0]).toHaveLength(
      maxBytes * 2
    );
    expect(hugeResult.bytes).toBeLessThanOrEqual(maxBytes);
    expect(readFileSync(cacheFile).byteLength).toBeLessThanOrEqual(maxBytes);
  });

  it('stabilizes an unchanged cohort when some structures exceed the byte cap', async () => {
    const root = tempDir('repo-map-file-cache-bounded-cohort-');
    const cacheFile = join(tempDir('repo-map-file-cache-store-'), 'cache.json');
    const maxBytes = 700;
    writeFileSync(join(root, 'small.ts'), 'export const small = 1;\n');
    writeFileSync(join(root, 'large.ts'), 'export const large = 1;\n');

    const parser = (calls: string[]): ParseFile => (_source, path) => {
      calls.push(path);
      return {
        symbols: [],
        imports: path === 'large.ts' ? ['x'.repeat(maxBytes * 2)] : [],
      };
    };

    const coldCalls: string[] = [];
    const cold = cacheFor(cacheFile, 'grammar-a', coldCalls, {
      maxBytes,
      parseFile: parser(coldCalls),
    });
    await generateRepoMap(root, { parseFile: cold.parseFile, tokenBudget: 10_000 });
    const coldCommit = cold.commit();
    expect(coldCalls.sort()).toEqual(['large.ts', 'small.ts']);
    expect(coldCommit.entryCount).toBe(1);

    const warmCalls: string[] = [];
    const warm = cacheFor(cacheFile, 'grammar-a', warmCalls, {
      maxBytes,
      parseFile: parser(warmCalls),
    });
    await generateRepoMap(root, { parseFile: warm.parseFile, tokenBudget: 10_000 });
    const warmCommit = warm.commit();

    expect(warmCalls).toEqual(['large.ts']);
    expect(warmCommit).toMatchObject({ changed: false, written: false, entryCount: 1 });

    writeFileSync(join(root, 'large.ts'), 'export const changed = 2;\n');
    const changedCalls: string[] = [];
    const changed = cacheFor(cacheFile, 'grammar-a', changedCalls, {
      maxBytes,
      parseFile: parser(changedCalls),
    });
    await generateRepoMap(root, { parseFile: changed.parseFile, tokenBudget: 10_000 });
    expect(changed.cohortChanged()).toBe(true);
    expect(changed.commit()).toMatchObject({ changed: true, written: true });

    const settledCalls: string[] = [];
    const settled = cacheFor(cacheFile, 'grammar-a', settledCalls, {
      maxBytes,
      parseFile: parser(settledCalls),
    });
    await generateRepoMap(root, { parseFile: settled.parseFile, tokenBudget: 10_000 });
    expect(settled.commit()).toMatchObject({ changed: false, written: false });

    const expandedCalls: string[] = [];
    const expanded = cacheFor(cacheFile, 'grammar-a', expandedCalls, {
      maxBytes: 4000,
      parseFile: parser(expandedCalls),
    });
    await generateRepoMap(root, { parseFile: expanded.parseFile, tokenBudget: 10_000 });
    expect(expandedCalls).toEqual(['large.ts']);
    expect(expanded.commit()).toMatchObject({
      changed: false,
      written: true,
      entryCount: 2,
    });

    const fullyWarmCalls: string[] = [];
    const fullyWarm = cacheFor(cacheFile, 'grammar-a', fullyWarmCalls, {
      maxBytes: 4000,
      parseFile: parser(fullyWarmCalls),
    });
    await generateRepoMap(root, { parseFile: fullyWarm.parseFile, tokenBudget: 10_000 });
    expect(fullyWarmCalls).toEqual([]);
    expect(fullyWarm.commit()).toMatchObject({ changed: false, written: false });
  });

  it('force bypasses reuse but repopulates a fresh cache', async () => {
    const root = tempDir('repo-map-file-cache-force-');
    const cacheFile = join(tempDir('repo-map-file-cache-store-'), 'cache.json');
    writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');

    const cold = cacheFor(cacheFile, 'grammar-a', []);
    await generateRepoMap(root, { parseFile: cold.parseFile });
    cold.commit();

    const forceCalls: string[] = [];
    const forced = cacheFor(cacheFile, 'grammar-a', forceCalls, { reuse: false });
    await generateRepoMap(root, { parseFile: forced.parseFile });
    forced.commit();
    expect(forceCalls).toEqual(['a.ts']);

    const warmCalls: string[] = [];
    const warm = cacheFor(cacheFile, 'grammar-a', warmCalls);
    await generateRepoMap(root, { parseFile: warm.parseFile });
    warm.commit();
    expect(warmCalls).toEqual([]);
  });

  it('persists hashes and structural facts, never source bodies or literal values', async () => {
    const root = tempDir('repo-map-file-cache-privacy-');
    const cacheFile = join(tempDir('repo-map-file-cache-store-'), 'cache.json');
    const bodySecret = 'body_secret_must_not_be_cached';
    const literalSecret = 'literal_secret_must_not_be_cached';
    writeFileSync(
      join(root, 'secret.ts'),
      `export const API_KEY = '${literalSecret}';\nexport function f() { return '${bodySecret}'; }\n`
    );

    const parseFile = await createTsParseFile();
    const cache = createRepoMapFileCache({
      cacheFile,
      salt: 'real-grammar-test',
      parseFile,
    });
    const map = await generateRepoMap(root, { parseFile: cache.parseFile });
    cache.commit();

    const serializedCache = readFileSync(cacheFile, 'utf8');
    const combined = `${serializedCache}\n${JSON.stringify(map)}`;
    expect(combined).not.toContain(bodySecret);
    expect(combined).not.toContain(literalSecret);
    const persisted = JSON.parse(serializedCache) as {
      entries: Record<string, { contentHash: string }>;
    };
    expect(Object.keys(persisted.entries)).toHaveLength(1);
    expect(persisted.entries['secret.ts']?.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(serializedCache).not.toMatch(/"(?:source|body)"\s*:/);
  });

  it('uses a bounded default and leaves no atomic-write temp files behind', async () => {
    const root = tempDir('repo-map-file-cache-atomic-');
    const cacheDir = tempDir('repo-map-file-cache-store-');
    const cacheFile = join(cacheDir, 'cache.json');
    writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
    const cache = cacheFor(cacheFile, 'grammar-a', []);
    await generateRepoMap(root, { parseFile: cache.parseFile });
    const result = cache.commit();

    expect(result.bytes).toBeLessThanOrEqual(DEFAULT_REPO_MAP_FILE_CACHE_MAX_BYTES);
    expect(readdirSync(cacheDir)).toEqual(['cache.json']);
  });

  it('keeps disposable-cache cleanup best-effort under permission drift', async () => {
    const root = tempDir('repo-map-file-cache-permission-root-');
    const cacheDir = tempDir('repo-map-file-cache-permission-store-');
    const cacheFile = join(cacheDir, 'cache.json');
    writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
    const cache = cacheFor(cacheFile, 'grammar-a', []);
    await generateRepoMap(root, { parseFile: cache.parseFile });

    chmodSync(cacheDir, 0o400);
    try {
      expect(() => cache.commit()).not.toThrow();
    } finally {
      chmodSync(cacheDir, 0o700);
    }
  });
});
