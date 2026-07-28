/**
 * Bounded, symlink-refusing reads of `~/.claude` artifact directories (#3378).
 *
 * #3151 and #3152 were fixed against `parse-session-registry.ts` alone, but both
 * defects were structural: every artifact parser listed a directory, kept only
 * `Dirent.name`, re-joined it, and read with `statSync`/`readFileSync` — which
 * follow symlinks — while its caps defaulted to "no cap". Patching that one file
 * at a time would not converge, so the hardened read from PR #3373 lives here
 * now and the parsers call it.
 *
 * Two guarantees, and the honest limits of each:
 *
 * 1. **The requested directory is the boundary.** An entry that is a symlink is
 *    refused even when its target is a perfectly valid, same-shaped file. This
 *    is enforced in layers because no single check is sufficient:
 *    `Dirent.isSymbolicLink()` (cheap, but some filesystems report `UNKNOWN`
 *    d_type), an `lstat` re-check, `O_NOFOLLOW` on the open where the platform
 *    defines it, and a `dev`/`ino` check that the descriptor really is the inode
 *    the `lstat` approved. That last layer is what covers a link swapped in
 *    *after* the `lstat` on Windows, which has no `O_NOFOLLOW` — see
 *    {@link isSameFile} for the single case that still degrades, and why it
 *    degrades rather than refuses.
 * 2. **Both caps are finite by default.** `normalizeMaxEntries` requires an
 *    explicit fallback, so a caller cannot get an unbounded scan by omitting an
 *    option — "unbounded" is no longer spellable by accident. The byte cap
 *    bounds the *read*, not just the stat, so a file that grows past the budget
 *    after being stat'd is refused mid-read rather than slurped to EOF.
 */
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readSync,
  type Dirent,
  type Stats,
} from 'node:fs';
import { join, resolve, sep } from 'node:path';

/**
 * Default ceiling on directory entries scanned per call (#3152).
 *
 * A real artifact directory holds tens to low hundreds of small files, so 50,000
 * leaves ~3 orders of magnitude of headroom for a legitimately large directory
 * while still bounding a runaway or hostile one. Matches the
 * `DASHBOARD_ARTIFACT_DIR_MAX_ENTRIES` default that ingest already passes
 * explicitly.
 */
export const DEFAULT_ARTIFACT_MAX_ENTRIES = 50_000;

/**
 * Default per-file byte ceiling (#3152).
 *
 * Artifact files are small flat JSON/text documents, so 1 MiB is ample headroom
 * for any legitimate file while preventing a corrupted or deliberately inflated
 * one from being read into memory and handed to a synchronous parse.
 */
export const DEFAULT_ARTIFACT_MAX_FILE_BYTES = 1_048_576;

/** Resolve an optional numeric cap, falling back to a finite default. */
export function resolveCap(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}

/**
 * Resolve an optional entry cap against a REQUIRED finite fallback.
 *
 * The fallback is a required parameter, not an optional one: this function used
 * to return `Number.MAX_SAFE_INTEGER` for omitted or invalid input, which made
 * "scan without limit" the thing you got by forgetting rather than by asking
 * (#3378). A caller that genuinely wants no practical bound must now say so by
 * passing a large fallback explicitly.
 */
export function normalizeMaxEntries(
  maxEntries: number | undefined,
  fallback: number
): number {
  return resolveCap(maxEntries, fallback);
}

export function remainingEntryCapacity(maxEntries: number, used: number): number {
  return Math.max(0, maxEntries - used);
}

export function readDirentsBoundedSync(
  dirPath: string,
  maxEntries: number
): Dirent[] {
  // A non-finite cap falls back to the documented default rather than to zero.
  // `Math.max(0, Math.floor(NaN))` is NaN, and `length < NaN` is false, so a
  // bad cap would otherwise report the directory as EMPTY — an absent result
  // that reads as a fact about the world instead of a fact about the argument.
  // Empty is the more dangerous failure here: unbounded is loud, silence is not.
  const limit = resolveCap(maxEntries, DEFAULT_ARTIFACT_MAX_ENTRIES);
  const entries: Dirent[] = [];
  let dir;
  try {
    dir = opendirSync(dirPath);
  } catch {
    return entries;
  }
  try {
    while (entries.length < limit) {
      const ent = dir.readSync();
      if (!ent) break;
      entries.push(ent);
    }
  } finally {
    try {
      dir.closeSync();
    } catch {
      /* ignore close failures */
    }
  }
  return entries;
}

/**
 * Open flags that read a file without traversing a final-component symlink
 * (#3151).
 *
 * `O_NOFOLLOW` makes the open itself atomic with respect to symlinks, but it is
 * POSIX-only — Windows does not define it, and these parsers do run there (the
 * plugin bundle boots `scripts/server.mjs` -> `ingest.mjs` directly on the
 * user's machine, no container). Where the flag is absent these flags collapse
 * to a plain `O_RDONLY` that *would* follow a link swapped in after the `lstat`,
 * so the descriptor identity check in {@link isSameFile} is what closes that
 * window instead.
 */
const NOFOLLOW_OPEN_FLAGS =
  fsConstants.O_RDONLY |
  (typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0);

/**
 * True when two stat results name the same file on the same device.
 *
 * Confirms the descriptor actually opened is the same inode the `lstat`
 * approved — the portable half of the no-symlink guarantee, and the only half on
 * platforms without `O_NOFOLLOW`.
 *
 * Honest limit: this can only be as good as the identity the platform reports.
 * POSIX always reports real `dev`/`ino`. Windows reports a file index for NTFS
 * but can report `0` on filesystems with no stable id, and two zeroes compare
 * equal — so there the check degrades to a no-op rather than to a refusal.
 * Refusing instead would deny service on those filesystems to close a window
 * whose worst case is reading a file the invoking user can already read.
 */
function isSameFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

/**
 * True when `filePath` lies strictly beneath `rootDir` after lexical
 * normalization. Dirent names never contain a path separator, so this is a
 * defence-in-depth assertion rather than the primary boundary check — the
 * primary check is that the entry is not a symlink.
 */
function isWithinDir(rootDir: string, filePath: string): boolean {
  const root = resolve(rootDir);
  const prefix = root.endsWith(sep) ? root : root + sep;
  return resolve(filePath).startsWith(prefix);
}

/** Chunk size used once a file turns out to be bigger than its stat claimed. */
const READ_CHUNK_BYTES = 64 * 1024;

/**
 * Read at most `maxBytes` bytes from an already-open descriptor, or refuse.
 *
 * A size taken from `fstat` is only a snapshot: `readFileSync(fd)` reads to EOF,
 * so a live or hostile writer that grows the file between the stat and the read
 * (or midway through it) is read in full and the byte budget is bypassed
 * entirely. This reads through a ceiling of `maxBytes + 1` instead — the extra
 * byte exists only to prove the file is over budget, and its presence makes this
 * return `null` so the caller skips the file without decoding or parsing it.
 *
 * `sizeHint` (the `fstat` size) only sizes the first allocation; it is never
 * trusted as a bound.
 *
 * @returns the decoded text, or `null` when the descriptor holds more than
 *          `maxBytes` bytes.
 */
function readFdBoundedSync(
  fd: number,
  maxBytes: number,
  sizeHint: number
): string | null {
  const ceiling = maxBytes + 1;
  const chunks: Buffer[] = [];
  let total = 0;

  while (total < ceiling) {
    const want = Math.min(
      ceiling - total,
      total === 0 ? Math.max(sizeHint + 1, 1) : READ_CHUNK_BYTES
    );
    const buf = Buffer.allocUnsafe(want);
    // Explicit position: independent of the descriptor's offset, and a short
    // read is never mistaken for EOF at the wrong place.
    const got = readSync(fd, buf, 0, want, total);
    if (got <= 0) break;
    chunks.push(got === want ? buf : buf.subarray(0, got));
    total += got;
  }

  // The ceiling byte came back, so the file is larger than the budget allows.
  if (total > maxBytes) return null;
  if (chunks.length === 0) return '';
  // Decode exactly what was read — never the slack in the final buffer.
  return (chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, total)).toString(
    'utf8'
  );
}

/** A file successfully read from an artifact directory. */
export interface BoundedFileRead {
  /** Decoded UTF-8 contents. */
  text: string;
  /** `fstat` of the descriptor actually read — use this, never a fresh `stat`. */
  stat: Stats;
}

/**
 * Read one entry of an artifact directory, refusing symlinks and anything over
 * the byte budget.
 *
 * This is the single hardened read path described in the module comment: pass
 * the directory and the entry name (never a joined path from elsewhere), and get
 * back the text plus the stat of the descriptor that was actually read.
 *
 * @returns `null` for every refusal — symlink, not a regular file, over budget,
 *          grew past budget mid-read, or unreadable. Callers skip silently;
 *          artifact directories are read opportunistically and a partial write
 *          in progress is normal, not exceptional.
 */
export function readFileInDirBoundedSync(
  dir: string,
  filename: string,
  maxFileBytes: number = DEFAULT_ARTIFACT_MAX_FILE_BYTES
): BoundedFileRead | null {
  const budget = Math.max(0, Math.floor(maxFileBytes));
  let fd = -1;
  try {
    const filePath = join(dir, filename);
    if (!isWithinDir(dir, filePath)) return null;
    // lstat, not stat: must NOT follow the link before deciding.
    const linkStat = lstatSync(filePath);
    if (linkStat.isSymbolicLink() || !linkStat.isFile()) return null;
    if (linkStat.size > budget) return null;
    // Where O_NOFOLLOW exists this closes the stat-then-open race outright: if
    // the entry became a symlink after the lstat, the open fails (ELOOP) and we
    // skip it. Where it does not, the identity check below does.
    fd = openSync(filePath, NOFOLLOW_OPEN_FLAGS);
    const openedStat = fstatSync(fd);
    if (!openedStat.isFile()) return null;
    // The descriptor must be the exact inode the lstat approved. Without
    // O_NOFOLLOW the open would have followed a link swapped in just now; this
    // catches that after the fact, before a single byte is read.
    if (!isSameFile(linkStat, openedStat)) return null;
    if (openedStat.size > budget) return null;
    // The stat above is only an early reject — the read itself is bounded, so a
    // writer that grows the file after the stat cannot exceed the budget.
    const text = readFdBoundedSync(fd, budget, openedStat.size);
    if (text === null) return null;
    return { text, stat: openedStat };
  } catch {
    // unreadable / partial / unopenable (ELOOP on a symlinked entry lands here)
    return null;
  } finally {
    if (fd >= 0) {
      try {
        closeSync(fd);
      } catch {
        /* ignore close failures */
      }
    }
  }
}

/**
 * Names of the real subdirectories of `dir`, bounded and refusing symlinks.
 *
 * The directory half of the same boundary: a symlinked subdirectory would let a
 * whole foreign tree be walked as though it belonged to the artifact directory,
 * so `statSync(...).isDirectory()` — which follows links — is not sufficient
 * here either.
 */
export function readSubdirectoryNamesBoundedSync(
  dir: string,
  maxEntries: number
): string[] {
  const names: string[] = [];
  for (const dirent of readDirentsBoundedSync(dir, maxEntries)) {
    if (dirent.isSymbolicLink()) continue;
    try {
      const path = join(dir, dirent.name);
      if (!isWithinDir(dir, path)) continue;
      const linkStat = lstatSync(path);
      if (linkStat.isSymbolicLink() || !linkStat.isDirectory()) continue;
      names.push(dirent.name);
    } catch {
      continue;
    }
  }
  return names;
}
