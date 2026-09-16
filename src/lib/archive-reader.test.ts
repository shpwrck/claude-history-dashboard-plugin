import { describe, it, expect, vi } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import {
  ArchiveTooLargeError,
  DEFAULT_ARCHIVE_LIMITS,
  MAX_COMPRESSED_PUSH_BYTES,
  formatBytes,
  readArchive,
  readArchiveBlob,
  readArchiveBytes,
  type ArchiveEntry,
  type ArchiveEntryInfo,
  type ArchiveReaderOptions,
} from './archive-reader';
import {
  MIB,
  buildZip,
  forgeDeclaredSize,
  noise,
  observeSubarrays,
} from './__fixtures__/zip-archive-fixture';

const readEverything: ArchiveReaderOptions<ArchiveEntry> = {
  admit: () => 'read',
  map: (entry) => entry,
};

async function rejection(promise: Promise<unknown>): Promise<ArchiveTooLargeError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(ArchiveTooLargeError);
    return err as ArchiveTooLargeError;
  }
  throw new Error('expected the archive to be rejected');
}

/** Yield 4 KiB slices with a macrotask gap between them, like a streaming Blob. */
async function* trickle(archive: Uint8Array): AsyncIterable<Uint8Array> {
  for (let offset = 0; offset < archive.byteLength; offset += MAX_COMPRESSED_PUSH_BYTES) {
    await new Promise((resolve) => setTimeout(resolve, 2));
    yield archive.subarray(offset, offset + MAX_COMPRESSED_PUSH_BYTES);
  }
}

describe('readArchive admission', () => {
  it('maps admitted entries in archive order with path, name, and decoded text', async () => {
    const zip = buildZip({
      'history.jsonl': '{"display":"hi"}\n',
      'projects/p/sess-1.jsonl': '{"type":"user"}\n',
    });

    const entries = await readArchiveBytes(zip, readEverything);

    expect(entries.map((e) => [e.path, e.name, e.text, e.metadataOnly])).toEqual([
      ['history.jsonl', 'history.jsonl', '{"display":"hi"}\n', false],
      ['projects/p/sess-1.jsonl', 'sess-1.jsonl', '{"type":"user"}\n', false],
    ]);
  });

  it('never inflates an entry the policy skips', async () => {
    const zip = buildZip({ 'keep.txt': 'kept', 'secret.txt': 'SECRET' });
    const inflated: number[] = [];

    const entries = await readArchiveBytes(zip, {
      ...readEverything,
      admit: (entry) => (entry.name === 'secret.txt' ? 'skip' : 'read'),
      observeForTest: (bytes) => inflated.push(bytes),
    });

    expect(entries.map((e) => e.path)).toEqual(['keep.txt']);
    expect(JSON.stringify(entries)).not.toContain('SECRET');
    expect(inflated.reduce((sum, bytes) => sum + bytes, 0)).toBe('kept'.length);
  });

  it('returns metadata-only entries with empty text and without decompressing them', async () => {
    const zip = buildZip({ 'file-history/s/snap@v2': 'SECRET SNAPSHOT BODY' });
    const inflated: number[] = [];

    const entries = await readArchiveBytes(zip, {
      ...readEverything,
      admit: () => 'metadata',
      observeForTest: (bytes) => inflated.push(bytes),
    });

    expect(entries).toEqual([
      expect.objectContaining({ path: 'file-history/s/snap@v2', text: '', metadataOnly: true }),
    ]);
    expect(inflated).toEqual([]);
  });

  it('counts metadata-only entries against the entry budget', async () => {
    const zip = buildZip({ 'a.snap': 'x', 'b.jsonl': '{}' });

    const err = await rejection(
      readArchiveBytes(zip, {
        ...readEverything,
        admit: (entry) => (entry.name === 'a.snap' ? 'metadata' : 'read'),
        limits: { maxEntries: 1 },
      })
    );

    expect(err.kind).toBe('entries');
  });

  it('skips directory entries before consulting the policy', async () => {
    const zip = zipSync({ dir: { 'a.txt': strToU8('a') } });
    const seen: string[] = [];

    const entries = await readArchiveBytes(zip, {
      ...readEverything,
      admit: (entry) => {
        seen.push(entry.path);
        return 'read';
      },
    });

    expect(seen).toEqual(['dir/a.txt']);
    expect(entries.map((e) => e.name)).toEqual(['a.txt']);
  });

  it('hands the policy the declared size before any decompression', async () => {
    const zip = buildZip({ 'a.txt': 'x'.repeat(1234) });
    const seen: ArchiveEntryInfo[] = [];

    await readArchiveBytes(zip, {
      ...readEverything,
      admit: (entry) => {
        seen.push(entry);
        return 'skip';
      },
    });

    expect(seen).toEqual([{ path: 'a.txt', name: 'a.txt', declaredSize: 1234 }]);
  });

  it('returns an empty array when nothing is admitted', async () => {
    const zip = buildZip({ 'readme.md': '# hi' });
    expect(await readArchiveBytes(zip, { ...readEverything, admit: () => 'skip' })).toEqual([]);
  });

  // perf-index-contract: archive-inflight-terminators non-querying
  it('does no inflation work, so registers no terminators, when nothing is read (#3481)', async () => {
    const zip = buildZip({ 'a.snap': 'metadata only', 'b.txt': 'skipped' });
    const inflated: number[] = [];
    const map = vi.fn((entry: ArchiveEntry) => entry.path);

    const paths = await readArchiveBytes(zip, {
      admit: (entry) => (entry.name === 'a.snap' ? 'metadata' : 'skip'),
      map,
      observeForTest: (bytes) => inflated.push(bytes),
    });

    expect(paths).toEqual(['a.snap']);
    expect(map).toHaveBeenCalledTimes(1);
    // Nothing was inflated, so the in-flight terminator set was never populated.
    expect(inflated.length).toBe(0);
  });

  it('delivers whatever map returns, including null, in order', async () => {
    const zip = buildZip({ 'a.txt': 'a', 'b.txt': 'b' });
    const values = await readArchiveBytes(zip, {
      ...readEverything,
      map: (entry) => (entry.name === 'a.txt' ? null : entry.text),
    });
    expect(values).toEqual([null, 'b']);
  });
});

describe('readArchive failures', () => {
  it('propagates a mapping failure on a read entry instead of swallowing it', async () => {
    const zip = buildZip({ 'a.txt': 'a' });
    await expect(
      readArchiveBytes(zip, {
        ...readEverything,
        map: () => {
          throw new Error('map exploded');
        },
      })
    ).rejects.toThrow('map exploded');
  });

  it('propagates a mapping failure on a metadata-only entry', async () => {
    const zip = buildZip({ 'a.snap': 'a', 'b.txt': 'b' });
    await expect(
      readArchiveBytes(zip, {
        ...readEverything,
        admit: (entry) => (entry.name === 'a.snap' ? 'metadata' : 'read'),
        map: () => {
          throw new Error('metadata map exploded');
        },
      })
    ).rejects.toThrow('metadata map exploded');
  });

  it('stops feeding and mapping once a read-entry map throws on a streaming source', async () => {
    const files: Record<string, Uint8Array> = { 'first.txt': strToU8('first') };
    for (let i = 0; i < 6; i += 1) files[`noise-${i}.bin`] = noise(64 * 1024);
    const archive = buildZip(files);
    const admitted: string[] = [];
    const map = vi.fn((entry: ArchiveEntry) => {
      if (entry.name === 'first.txt') throw new Error('map exploded');
      return entry.name;
    });

    await expect(
      readArchive(trickle(archive), {
        admit: (entry) => {
          admitted.push(entry.name);
          return 'read';
        },
        map,
        archiveBytes: archive.byteLength,
      })
    ).rejects.toThrow('map exploded');

    // The failure lands while the tail of the archive is still trickling in, so
    // the reader must neither admit every later entry nor keep mapping them.
    expect(admitted.length).toBeLessThan(7);
    expect(map.mock.calls.length).toBeLessThan(7);
  });

  it('surfaces a chunk-source error and does not hang on entries left mid-stream', async () => {
    const archive = buildZip({ 'big.bin': noise(64 * 1024) });
    async function* brokenSource(): AsyncIterable<Uint8Array> {
      yield archive.subarray(0, 3 * MAX_COMPRESSED_PUSH_BYTES);
      throw new Error('source failed');
    }

    await expect(
      readArchive(brokenSource(), { ...readEverything, archiveBytes: archive.byteLength })
    ).rejects.toThrow('source failed');
  });
});

describe('readArchive limits', () => {
  it('fails fast on a compressed input over the archive ceiling', async () => {
    const zip = buildZip({ 'a.txt': 'a' });
    const admit = vi.fn(() => 'read' as const);

    const err = await rejection(
      readArchive([zip], {
        ...readEverything,
        admit,
        archiveBytes: zip.byteLength,
        limits: { maxArchiveBytes: zip.byteLength - 1 },
      })
    );

    expect(err).toMatchObject({ kind: 'archive', limit: zip.byteLength - 1, observed: zip.byteLength });
    expect(admit).not.toHaveBeenCalled();
  });

  it('rejects a declared-oversize entry before decompressing it', async () => {
    const zip = buildZip({ 'small.txt': 'ok', 'projects/p/huge.jsonl': 'x'.repeat(5000) });
    const inflated: number[] = [];

    const err = await rejection(
      readArchiveBytes(zip, {
        ...readEverything,
        limits: { maxEntryBytes: 1000 },
        observeForTest: (bytes) => inflated.push(bytes),
      })
    );

    expect(err).toMatchObject({ kind: 'entry', limit: 1000, path: 'projects/p/huge.jsonl', observed: 5000 });
    expect(inflated.reduce((sum, bytes) => sum + bytes, 0)).toBeLessThanOrEqual('ok'.length);
  });

  it('rejects once the entry-count budget is exceeded', async () => {
    const zip = buildZip({ 'a.jsonl': '{}', 'b.jsonl': '{}', 'c.jsonl': '{}' });
    const err = await rejection(readArchiveBytes(zip, { ...readEverything, limits: { maxEntries: 2 } }));
    expect(err).toMatchObject({ kind: 'entries', limit: 2 });
  });

  it('rejects when declared sizes already exceed the total budget', async () => {
    const zip = buildZip({ 'a.jsonl': 'a'.repeat(800), 'b.jsonl': 'b'.repeat(800) });
    const err = await rejection(
      readArchiveBytes(zip, { ...readEverything, limits: { maxTotalBytes: 1000 } })
    );
    expect(err).toMatchObject({ kind: 'total', limit: 1000 });
  });

  it('rejects observed bytes past maxEntryBytes despite a forged small declared size', async () => {
    const zip = forgeDeclaredSize(buildZip({ 'projects/p/sess.jsonl': 'x'.repeat(200_000) }), 10);

    const err = await rejection(
      readArchiveBytes(zip, { ...readEverything, limits: { maxEntryBytes: 50_000 } })
    );

    expect(err).toMatchObject({ kind: 'entry', limit: 50_000, path: 'projects/p/sess.jsonl' });
    expect(err.observed).toBeUndefined();
  });

  it('rejects observed bytes past maxTotalBytes despite forged small declared sizes', async () => {
    const zip = forgeDeclaredSize(
      buildZip({ 'a.jsonl': 'a'.repeat(120_000), 'b.jsonl': 'b'.repeat(120_000) }),
      10
    );

    const err = await rejection(
      readArchiveBytes(zip, {
        ...readEverything,
        limits: { maxEntryBytes: 200_000, maxTotalBytes: 150_000 },
      })
    );

    expect(err).toMatchObject({ kind: 'total', limit: 150_000 });
  });

  it('does not double-count declared and observed bytes on an honest archive', async () => {
    const zip = buildZip({ 'sess.jsonl': 'y'.repeat(40_000) });

    const entries = await readArchiveBytes(zip, {
      ...readEverything,
      limits: { maxEntryBytes: 50_000, maxTotalBytes: 45_000 },
    });

    expect(entries).toHaveLength(1);
    expect(entries[0].text).toHaveLength(40_000);
  });

  it('feeds compressed input to fflate in bounded pushes', async () => {
    const raw = noise(64 * 1024);
    const archive = zipSync({ 'noise.bin': raw });
    const pushes: number[] = [];

    const entries = await readArchive([observeSubarrays(archive, pushes)], {
      ...readEverything,
      archiveBytes: archive.byteLength,
    });

    expect(pushes.length).toBeGreaterThan(1);
    expect(pushes.every((bytes) => bytes <= MAX_COMPRESSED_PUSH_BYTES)).toBe(true);
    expect(pushes.reduce((sum, bytes) => sum + bytes, 0)).toBe(archive.byteLength);
    // Incompressible bytes decode with replacement characters, so compare the
    // decoded text rather than assuming one byte per character.
    expect(entries[0].text).toBe(new TextDecoder().decode(raw));
  });

  it('stops feeding input as soon as a ceiling trips (#3368)', async () => {
    const archive = forgeDeclaredSize(zipSync({ 'bomb.bin': new Uint8Array(16 * MIB) }), 10);
    const pushes: number[] = [];
    let outerYields = 0;

    function* chunks(): Iterable<Uint8Array> {
      outerYields += 1;
      yield observeSubarrays(archive, pushes);
      outerYields += 1;
      yield archive;
    }

    const err = await rejection(
      readArchive(chunks(), {
        ...readEverything,
        archiveBytes: archive.byteLength,
        limits: { maxEntryBytes: 64 * 1024 },
      })
    );

    expect(err.kind).toBe('entry');
    expect(pushes.reduce((sum, bytes) => sum + bytes, 0)).toBeLessThan(archive.byteLength);
    expect(outerYields).toBe(1);
  });

  it('defaults every ceiling to the exported constants', () => {
    expect(DEFAULT_ARCHIVE_LIMITS).toEqual({
      maxArchiveBytes: 2 * 1024 * MIB,
      maxEntryBytes: 512 * MIB,
      maxTotalBytes: 2 * 1024 * MIB,
      maxEntries: 200_000,
    });
  });
});

describe('readArchiveBlob', () => {
  const zip = buildZip({ 'a.txt': 'streamed' });

  it('streams a Blob when the platform supports it', async () => {
    const entries = await readArchiveBlob(new Blob([zip]), readEverything);
    expect(entries.map((e) => e.text)).toEqual(['streamed']);
  });

  it('falls back to a single buffer when the Blob cannot stream', async () => {
    const legacyBlob = {
      size: zip.byteLength,
      arrayBuffer: async () => zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength),
    } as unknown as Blob;

    const entries = await readArchiveBlob(legacyBlob, readEverything);
    expect(entries.map((e) => e.text)).toEqual(['streamed']);
  });

  it('applies the archive ceiling to the Blob size before reading', async () => {
    const err = await rejection(
      readArchiveBlob(new Blob([zip]), { ...readEverything, limits: { maxArchiveBytes: 1 } })
    );
    expect(err).toMatchObject({ kind: 'archive', limit: 1, observed: zip.byteLength });
  });
});

describe('ArchiveTooLargeError', () => {
  it('carries a neutral, feature-agnostic message per kind', () => {
    expect(new ArchiveTooLargeError('archive', 2 * 1024 * MIB, { observed: 3 * 1024 * MIB }).message).toBe(
      'Archive is 3.0 GB, over the 2.0 GB limit.'
    );
    expect(new ArchiveTooLargeError('entry', 512 * MIB, { path: 'a/b.jsonl' }).message).toBe(
      '"a/b.jsonl" is over the 512 MB per-entry limit.'
    );
    expect(new ArchiveTooLargeError('total', 2 * 1024 * MIB).message).toBe(
      'Archive inflates to over 2.0 GB.'
    );
    expect(new ArchiveTooLargeError('entries', 200_000).message).toBe(
      `Archive holds more than ${(200_000).toLocaleString()} entries.`
    );
  });
});

describe('formatBytes', () => {
  it('rounds to the largest binary unit', () => {
    expect(formatBytes(512)).toBe('1 KB');
    expect(formatBytes(3 * MIB)).toBe('3 MB');
    expect(formatBytes(1.5 * 1024 * MIB)).toBe('1.5 GB');
  });
});
