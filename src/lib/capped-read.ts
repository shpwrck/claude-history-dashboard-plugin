/**
 * One byte-capped file read for caller-supplied paths (#3419).
 *
 * Three byte-identical copies of this loop existed — `config-loader.ts`,
 * `github-review-sync.ts` and `doc-issue-fetch.ts` — differing only in the
 * error they threw and whether they clamped the cap first. Same duplication
 * class as the shell-quoting escape (#3379): a read that must not be allowed to
 * pull an unbounded file into memory, re-typed once per caller.
 *
 * ## This deliberately FOLLOWS symlinks, unlike bounded-fs.ts
 *
 * `bounded-fs.ts` refuses symlinks because there the DIRECTORY is the security
 * boundary: entries are discovered by listing `~/.claude/tasks/` and friends, so
 * a symlinked entry is an artifact claiming to belong to a directory it does not
 * belong to, and following it reads a file the user never put there.
 *
 * These reads are the opposite shape. The caller already knows the path — its
 * own config file, its own cache, its own token file — and did not discover it
 * by enumeration. A user symlinking `~/.claude.json` at their own home directory
 * is a normal thing to do, and refusing it would break a working setup to close
 * a hole that is not open: there is no untrusted party choosing these paths.
 *
 * That is why #3419 was filed separately from #3378 rather than folded into it.
 * The byte cap is the shared concern; the symlink policy is genuinely not.
 *
 * ## The cap bounds the READ, not a prior stat
 *
 * Bytes are counted as they arrive and the read aborts the moment the budget is
 * passed, so a file that grows while being read cannot exceed the budget — the
 * same property `bounded-fs.ts` documents for its own reads.
 */
import { closeSync, openSync, readSync } from 'node:fs';

/** Chunk size for the streaming read. */
const READ_CHUNK_BYTES = 64 * 1024;

/**
 * Build the error thrown when `path` holds more than `limit` bytes.
 *
 * Supplied by the caller so each site keeps the message that names its own
 * artifact ("Review events cache exceeds…", "doc-issue read exceeds…"). Those
 * messages are the one thing that legitimately differed between the three
 * copies, so they are a parameter rather than something to unify away.
 */
export type CappedReadOverflow = (limit: number, path: string) => Error;

const defaultOverflow: CappedReadOverflow = (limit, path) =>
  new Error(`file exceeds the ${limit} byte read limit: ${path}`);

/**
 * Read `path` as UTF-8, refusing to buffer more than `maxBytes`.
 *
 * @throws whatever `onOverflow` returns, as soon as the budget is passed —
 *         never after slurping the whole file.
 */
export function readTextFileCappedSync(
  path: string,
  maxBytes: number,
  onOverflow: CappedReadOverflow = defaultOverflow
): string {
  const fd = openSync(path, 'r');
  const chunks: Buffer[] = [];
  let bytes = 0;
  const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, maxBytes + 1));
  try {
    for (;;) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      bytes += bytesRead;
      if (bytes > maxBytes) throw onOverflow(maxBytes, path);
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
  } finally {
    closeSync(fd);
  }
  return Buffer.concat(chunks).toString('utf8');
}
