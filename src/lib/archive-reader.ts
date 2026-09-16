import { AsyncUnzipInflate, Unzip, type UnzipFile } from 'fflate';

// Upload-neutral bounded ZIP reader (#3806, epic #3736).
//
// This is the generic fflate streaming engine that `unzip-upload.ts` used to
// own, with the upload-specific parts (skip rules, project attribution,
// metadata-only paths, UI error copy) pushed out through two injection points:
// `admit` decides what happens to each entry before any decompression, and
// `map` turns an admitted entry into the caller's shape. The byte, entry, and
// ZIP-bomb limits stay here because they are properties of reading an archive
// safely in a browser tab, not of any one feature. Both the upload wrapper and
// the public sample loader (#3804) sit on top of this module.

// Fail-proof guards (#758). A large or pathological archive must fail fast and
// clearly instead of locking the tab while it inflates to memory. These caps
// are deliberately generous — a real `~/.claude` bundle is megabytes of
// well-compressing `.jsonl`, far under them — so they only ever trip on
// genuinely huge input or a decompression bomb (small compressed, vast
// inflated). Declared sizes provide an early-rejection hint; the authoritative
// per-entry and total caps use observed output bytes. Compressed input is fed
// to fflate in bounded pushes so the observed-byte guard has a finite
// allocation overshoot.

/** Compressed-input ceiling, checked before any decompression starts. */
export const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB
/** Per-entry inflated-size ceiling — a single file this big is pathological. */
export const MAX_ENTRY_BYTES = 512 * 1024 * 1024; // 512 MiB
/** Total inflated-bytes budget across all admitted entries. */
export const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB
/** Cap on the number of admitted entries. */
export const MAX_ENTRIES = 200_000;
/**
 * Maximum compressed archive bytes handed to fflate in one push. DEFLATE can
 * expand one compressed byte roughly 1,032x; keeping pushes at 4 KiB prevents
 * fflate from materializing an arbitrarily large output buffer before the
 * observed-byte guards below can reject it (#3368).
 */
export const MAX_COMPRESSED_PUSH_BYTES = 4096;

/** Tunable guard ceilings; default to the module `MAX_*` constants. */
export interface ArchiveLimits {
  maxArchiveBytes: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
  maxEntries: number;
}

export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = {
  maxArchiveBytes: MAX_ARCHIVE_BYTES,
  maxEntryBytes: MAX_ENTRY_BYTES,
  maxTotalBytes: MAX_TOTAL_BYTES,
  maxEntries: MAX_ENTRIES,
};

/**
 * Which ceiling an archive tripped. `archive` is the compressed input size,
 * `entry` a single inflated entry, `total` the inflated budget across entries,
 * and `entries` the admitted-entry count.
 */
export type ArchiveLimitKind = 'archive' | 'entry' | 'total' | 'entries';

interface ArchiveViolationDetail {
  path?: string;
  observed?: number;
}

/**
 * Thrown when an archive trips one of the {@link ArchiveLimits}. The structured
 * fields let a caller phrase its own message: `limit` is the ceiling that
 * tripped, `path` names the offending entry for `entry` violations, and
 * `observed` carries the size when one was known up front (the compressed
 * archive size, or an entry's declared size). An `entry` violation caught from
 * observed output has no `observed` value because inflation stopped at the
 * ceiling.
 */
export class ArchiveTooLargeError extends Error {
  readonly kind: ArchiveLimitKind;
  readonly limit: number;
  readonly path?: string;
  readonly observed?: number;

  constructor(kind: ArchiveLimitKind, limit: number, detail: ArchiveViolationDetail = {}) {
    super(describeViolation(kind, limit, detail));
    this.name = 'ArchiveTooLargeError';
    this.kind = kind;
    this.limit = limit;
    this.path = detail.path;
    this.observed = detail.observed;
  }
}

function describeViolation(
  kind: ArchiveLimitKind,
  limit: number,
  { path, observed }: ArchiveViolationDetail
): string {
  switch (kind) {
    case 'archive':
      return `Archive is ${formatBytes(observed ?? 0)}, over the ${formatBytes(limit)} limit.`;
    case 'entry':
      return `"${path ?? ''}" is over the ${formatBytes(limit)} per-entry limit.`;
    case 'total':
      return `Archive inflates to over ${formatBytes(limit)}.`;
    case 'entries':
      return `Archive holds more than ${limit.toLocaleString()} entries.`;
  }
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

/**
 * What the reader knows about an entry before decompressing it. fflate's
 * streaming unzip exposes no per-entry mtime, so there is deliberately no
 * timestamp here; callers that need one must derive it elsewhere.
 */
export interface ArchiveEntryInfo {
  /** In-archive path exactly as the header declares it (untrusted). */
  path: string;
  /** Final path segment. */
  name: string;
  /**
   * Declared inflated size from the header, when present. Untrusted ZIP
   * metadata: only ever a cheap pre-decompression rejection hint.
   */
  declaredSize?: number;
}

/** An admitted entry after reading: `text` is `''` for metadata-only entries. */
export interface ArchiveEntry extends ArchiveEntryInfo {
  text: string;
  metadataOnly: boolean;
}

/**
 * Per-entry admission decision, taken before any decompression:
 * - `skip`: never inflated, never counted.
 * - `metadata`: counted against the entry budget and mapped with empty text, but
 *   the body is never decompressed.
 * - `read`: inflated and decoded as UTF-8 text.
 */
export type ArchiveEntryDecision = 'skip' | 'metadata' | 'read';

export type ArchiveTestInstrumentation = (inflatedBytes: number) => void;

export interface ArchiveReaderOptions<T> {
  admit: (entry: ArchiveEntryInfo) => ArchiveEntryDecision;
  /** Shape an admitted entry; whatever it returns is delivered as-is, in archive order. */
  map: (entry: ArchiveEntry) => T;
  limits?: Partial<ArchiveLimits>;
  /** Compressed archive size when known; enables the fail-fast archive check. */
  archiveBytes?: number;
  /** Test-only hook observing each inflated chunk size (ignored outside vitest). */
  observeForTest?: ArchiveTestInstrumentation;
}

/**
 * Tracks the inflated-byte and entry-count budgets for one archive read. Declared
 * sizes are only a hint: an entry can declare 1 KiB and emit 2 GiB, so the
 * authoritative accounting is from bytes actually observed (#3176).
 */
class InflationBudget {
  private readonly limits: ArchiveLimits;
  private admittedCount = 0;
  private admittedBytes = 0;

  constructor(limits: ArchiveLimits) {
    this.limits = limits;
  }

  /**
   * Cheap pre-decompression checks from the entry's untrusted header. Counts
   * the entry as admitted when it passes.
   */
  admit(entry: ArchiveEntryInfo): ArchiveTooLargeError | null {
    const { maxEntryBytes, maxEntries, maxTotalBytes } = this.limits;
    const declared = entry.declaredSize;
    if (declared !== undefined && declared > maxEntryBytes) {
      return new ArchiveTooLargeError('entry', maxEntryBytes, { path: entry.path, observed: declared });
    }
    if (this.admittedCount + 1 > maxEntries) {
      return new ArchiveTooLargeError('entries', maxEntries);
    }
    if (declared !== undefined && this.admittedBytes + declared > maxTotalBytes) {
      return new ArchiveTooLargeError('total', maxTotalBytes);
    }
    this.admittedCount += 1;
    return null;
  }

  /** Authoritative accounting from an observed inflated chunk. */
  checkObserved(entry: ArchiveEntryInfo, entryBytes: number, chunkBytes: number): ArchiveTooLargeError | null {
    const { maxEntryBytes, maxTotalBytes } = this.limits;
    if (entryBytes > maxEntryBytes) {
      return new ArchiveTooLargeError('entry', maxEntryBytes, { path: entry.path });
    }
    this.admittedBytes += chunkBytes;
    if (this.admittedBytes > maxTotalBytes) {
      return new ArchiveTooLargeError('total', maxTotalBytes);
    }
    return null;
  }
}

function describeEntry(file: UnzipFile): ArchiveEntryInfo {
  const path = file.name;
  return { path, name: path.slice(path.lastIndexOf('/') + 1), declaredSize: file.originalSize };
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * One archive read: admission, budgets, and the mapped results in archive order.
 *
 * `failure` is the single error channel. The first failure of any kind (a
 * tripped ceiling, a corrupt stream, a throwing `map`) records itself here,
 * stops the feed loop, and terminates every entry still inflating, so a
 * rejected archive is never read to completion. A tripped ceiling takes
 * precedence over any other failure, including the stream error terminating
 * causes.
 */
class ArchiveReadSession<T> {
  failure: Error | null = null;
  private readonly options: ArchiveReaderOptions<T>;
  private readonly budget: InflationBudget;
  /** One promise per admitted entry, in archive order; `undefined` only after a failure. */
  private readonly pending: Promise<T | undefined>[] = [];
  /**
   * Terminators for entries still inflating, so a failure can stop them all.
   * Created on the first inflated entry; an archive whose policy admits nothing
   * for reading never allocates it.
   */
  private aborts: Set<() => void> | null = null;

  constructor(options: ArchiveReaderOptions<T>, limits: ArchiveLimits) {
    this.options = options;
    this.budget = new InflationBudget(limits);
  }

  fail(err: Error): void {
    if (err instanceof ArchiveTooLargeError || !this.failure) this.failure = err;
    for (const abort of this.aborts ?? []) abort();
    this.aborts?.clear();
  }

  private track(abort: () => void): void {
    // perf-index-contract: archive-inflight-terminators non-querying
    (this.aborts ??= new Set()).add(abort);
  }

  private untrack(abort: () => void): void {
    this.aborts?.delete(abort);
  }

  /** fflate entry callback: admission and declared-size hints run before `start()`. */
  onEntry(file: UnzipFile): void {
    if (file.name.endsWith('/') || this.failure) return;
    const entry = describeEntry(file);
    const decision = this.options.admit(entry);
    if (decision === 'skip') return;

    const overflow = this.budget.admit(entry);
    if (overflow) {
      this.fail(overflow);
      return;
    }
    this.pending.push(
      decision === 'metadata'
        ? Promise.resolve(this.finish({ ...entry, text: '', metadataOnly: true }))
        : this.inflate(file, entry)
    );
  }

  /** Wait for every admitted entry, then surface the recorded failure or the results. */
  async collect(): Promise<T[]> {
    const items = await Promise.all(this.pending);
    if (this.failure) throw this.failure;
    // Without a failure every entry settled through `finish`, so each slot
    // holds exactly what `map` returned.
    return items as T[];
  }

  /** Run the caller's `map`, converting a throw into the session failure. */
  private finish(entry: ArchiveEntry): T | undefined {
    if (this.failure) return undefined;
    try {
      return this.options.map(entry);
    } catch (err) {
      this.fail(toError(err));
      return undefined;
    }
  }

  /**
   * Inflate one admitted entry into UTF-8 text, enforcing the observed-byte
   * budgets on every chunk. Never rejects: a failure is recorded on the session
   * and the entry resolves `undefined` once its stream is terminated.
   */
  private inflate(file: UnzipFile, entry: ArchiveEntryInfo): Promise<T | undefined> {
    return new Promise<T | undefined>((resolve) => {
      const decoder = new TextDecoder();
      let text = '';
      let entryBytes = 0;
      const abort = (): void => {
        this.untrack(abort);
        file.terminate();
        resolve(undefined);
      };
      this.track(abort);
      file.ondata = (err, chunk, final) => {
        if (err) {
          this.fail(err);
          return;
        }
        if (chunk) {
          if (import.meta.env?.MODE === 'test') this.options.observeForTest?.(chunk.byteLength);
          entryBytes += chunk.byteLength;
          const overflow = this.budget.checkObserved(entry, entryBytes, chunk.byteLength);
          if (overflow) {
            this.fail(overflow);
            return;
          }
          text += decoder.decode(chunk, { stream: !final });
        }
        if (final) {
          this.untrack(abort);
          resolve(this.finish({ ...entry, text: text + decoder.decode(), metadataOnly: false }));
        }
      };
      file.start();
    });
  }
}

/**
 * Push compressed input in {@link MAX_COMPRESSED_PUSH_BYTES} slices, stopping
 * as soon as `aborted()` reports a failure — both the inner slicing and the
 * outer chunk iteration end there, so a rejected archive is never read to
 * completion.
 */
async function feedBounded(
  unzip: Unzip,
  chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  aborted: () => boolean
): Promise<void> {
  for await (const chunk of chunks) {
    for (let offset = 0; offset < chunk.length; ) {
      if (aborted()) return;
      unzip.push(chunk.subarray(offset, (offset += MAX_COMPRESSED_PUSH_BYTES)), false);
    }
  }
  if (!aborted()) unzip.push(new Uint8Array(), true);
}

/**
 * Stream a ZIP archive through fflate, admitting entries via `admit` and mapping
 * each admitted entry via `map`, in archive order. Directory entries are always
 * skipped. Skipped entries are never decompressed, so anything the policy
 * rejects never reaches memory.
 */
export async function readArchive<T>(
  chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  options: ArchiveReaderOptions<T>
): Promise<T[]> {
  const limits: ArchiveLimits = { ...DEFAULT_ARCHIVE_LIMITS, ...options.limits };
  const { archiveBytes } = options;

  // Fail fast on an absurdly large compressed input before spending any work
  // inflating it — this is the "immediate" half of fail-proof (#758).
  if (archiveBytes !== undefined && archiveBytes > limits.maxArchiveBytes) {
    throw new ArchiveTooLargeError('archive', limits.maxArchiveBytes, { observed: archiveBytes });
  }

  // Unlike fflate's object-returning `unzip`, this maps admitted entries as they
  // finish and avoids a second full decompressed byte map.
  const session = new ArchiveReadSession(options, limits);
  const unzip = new Unzip((file) => session.onEntry(file));
  unzip.register(AsyncUnzipInflate);

  try {
    await feedBounded(unzip, chunks, () => session.failure !== null);
  } catch (err) {
    // The chunk source or the ZIP parser failed; stop in-flight entries too.
    session.fail(toError(err));
  }
  return session.collect();
}

/** Read an archive already held in memory. */
export function readArchiveBytes<T>(data: Uint8Array, options: ArchiveReaderOptions<T>): Promise<T[]> {
  return readArchive([data], { ...options, archiveBytes: data.byteLength });
}

/**
 * Read an archive from a Blob/File handle, streaming when the platform supports
 * it and falling back to a single in-memory buffer otherwise.
 */
export async function readArchiveBlob<T>(blob: Blob, options: ArchiveReaderOptions<T>): Promise<T[]> {
  if (typeof blob.stream !== 'function') {
    return readArchiveBytes(new Uint8Array(await blob.arrayBuffer()), options);
  }
  return readArchive(blob.stream(), { ...options, archiveBytes: blob.size });
}
