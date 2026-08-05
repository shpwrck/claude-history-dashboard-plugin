/**
 * parse-session-registry.ts — Parser + attribution analyser for
 * ~/.claude/sessions/<pid>.json (the live process registry).
 *
 * Issue #561 (P7 Owen: CLI Attribution Report Card) building block.
 * Consumed by issue #572 (consolidated Agent Report Card) via analyzeAttribution().
 *
 * CRITICAL CAVEAT: sessions report kind:"interactive" even when
 * entrypoint:"sdk-cli". ALL attribution logic MUST key on `entrypoint`,
 * NEVER on `kind`. The kind field is unreliable for automation detection.
 *
 * Do NOT confuse with src/lib/parse-sessions.ts (JSONL transcript token data).
 * This file reads <pid>.json registry files, NOT transcript files.
 */

import {
  DEFAULT_ARTIFACT_MAX_ENTRIES,
  DEFAULT_ARTIFACT_MAX_FILE_BYTES,
  readDirentsBoundedSync,
  readFileInDirBoundedSync,
  resolveCap,
} from './bounded-fs';

// ---------------------------------------------------------------------------
// Per-session shape (one file = one live/recent process)
// ---------------------------------------------------------------------------

// The SessionRegistryEntry shape and the pure attribution analyser live in
// the fs-free `session-attribution` leaf (#3639) so the browser-bundled
// report-card can import them WITHOUT a runtime edge into this fs-touching
// module. Re-exported here so existing `from './parse-session-registry'`
// consumers keep resolving.

import type { SessionRegistryEntry } from './session-attribution';

export type {
  SessionRegistryEntry,
  AttributionBucket,
  EntrypointCount,
  VersionTimelineEntry,
  ProjectAttribution,
  AttributionAnalysis,
} from './session-attribution';
export { analyzeAttribution } from './session-attribution';

export interface ParseSessionRegistryOptions {
  /**
   * Per-file byte ceiling. Files larger than this are skipped — on the stat
   * when they are already too big, and mid-read when they grow past it while
   * being read, so the ceiling holds against a concurrent writer. Omitted /
   * non-finite / negative falls back to
   * {@link DEFAULT_REGISTRY_MAX_FILE_BYTES}.
   */
  maxFileBytes?: number;
  /**
   * Ceiling on directory entries inspected (all entries, not just `.json`).
   * Omitted / non-finite / negative falls back to
   * {@link DEFAULT_REGISTRY_MAX_ENTRIES}.
   */
  maxEntries?: number;
}

/**
 * Default ceiling on directory entries scanned per call (#3152).
 *
 * A real ~/.claude/sessions/ holds one small file per live/recent CLI process —
 * tens to low hundreds in practice — so 50,000 leaves ~3 orders of magnitude of
 * headroom for a legitimately large registry while still bounding a runaway or
 * hostile directory. Matches the `DASHBOARD_ARTIFACT_DIR_MAX_ENTRIES` default
 * that ingest already passes explicitly.
 */
export const DEFAULT_REGISTRY_MAX_ENTRIES = DEFAULT_ARTIFACT_MAX_ENTRIES;

/**
 * Default per-file byte ceiling (#3152).
 *
 * A registry file is a single flat JSON object of roughly 200-400 bytes, so
 * 1 MiB is ~3,000x headroom for any legitimate file while preventing a
 * corrupted or deliberately inflated `<pid>.json` from being slurped into
 * memory and handed to a synchronous `JSON.parse`.
 */
export const DEFAULT_REGISTRY_MAX_FILE_BYTES = DEFAULT_ARTIFACT_MAX_FILE_BYTES;

// ---------------------------------------------------------------------------
// Directory parser
// ---------------------------------------------------------------------------

/**
 * Walk a directory of <pid>.json files and return parsed entries.
 * Malformed / unreadable files are silently skipped (tolerate partial writes
 * that occur when a session file is being written concurrently).
 *
 * Boundary guarantees:
 * - Symlinked entries are refused (#3151). The requested directory is the
 *   boundary: a `<pid>.json` that is a symlink to a registry-shaped file
 *   elsewhere on the box is never ingested, even when its target is a regular
 *   file with valid fields. Enforced in layers — `Dirent.isSymbolicLink()`, an
 *   `lstat` (no-follow) re-check for filesystems that report `UNKNOWN` d_type,
 *   `O_NOFOLLOW` on the open where the platform defines it, and a `dev`/`ino`
 *   check that the descriptor really is the inode the `lstat` approved.
 *   The last layer is what covers a link swapped in *after* the `lstat` on
 *   Windows, which has no `O_NOFOLLOW`; see {@link isSameFile} for the one
 *   case that leaves (a filesystem reporting no stable file id) and why it
 *   degrades rather than refuses.
 * - Both caps are finite by default (#3152): at most
 *   {@link DEFAULT_REGISTRY_MAX_ENTRIES} directory entries are inspected and
 *   files above {@link DEFAULT_REGISTRY_MAX_FILE_BYTES} are skipped, so the
 *   default path can no longer be stalled by a huge or corrupted registry
 *   directory. Explicit caller options (ingest passes the
 *   `DASHBOARD_ARTIFACT_*` values) still win, smaller or larger.
 * - The byte budget bounds the *read*, not just the stat. A file that grows
 *   past the budget after it was stat'd — a live writer, or one racing the
 *   check deliberately — is refused mid-read by {@link readFdBoundedSync}
 *   rather than being slurped to EOF, so the cap holds against a concurrent
 *   writer.
 *
 * @param dir  Path to ~/.claude/sessions/ (or a test fixture directory)
 * @returns    Array of parsed entries, may be empty if the directory is absent
 *             or all files are malformed.
 */
export function parseSessionRegistryDir(
  dir: string,
  opts: ParseSessionRegistryOptions = {}
): SessionRegistryEntry[] {
  const maxEntries = resolveCap(opts.maxEntries, DEFAULT_REGISTRY_MAX_ENTRIES);
  const maxFileBytes = resolveCap(opts.maxFileBytes, DEFAULT_REGISTRY_MAX_FILE_BYTES);
  const dirents = readDirentsBoundedSync(dir, maxEntries);

  const entries: SessionRegistryEntry[] = [];
  for (const dirent of dirents) {
    const filename = dirent.name;
    if (!filename.endsWith('.json')) continue;
    // Cheap reject when readdir already told us the entry is a link. The read
    // helper re-checks, but this avoids the syscalls for the common case.
    if (dirent.isSymbolicLink()) continue;
    try {
      const read = readFileInDirBoundedSync(dir, filename, maxFileBytes);
      if (!read) continue;
      const j = JSON.parse(read.text) as Partial<SessionRegistryEntry>;

      // Require the minimum fields needed for attribution
      if (
        typeof j.pid !== 'number' ||
        typeof j.sessionId !== 'string' ||
        typeof j.cwd !== 'string' ||
        typeof j.startedAt !== 'number' ||
        typeof j.entrypoint !== 'string' ||
        typeof j.kind !== 'string'
      ) {
        continue;
      }

      entries.push({
        pid: j.pid,
        sessionId: j.sessionId,
        cwd: j.cwd,
        startedAt: j.startedAt,
        procStart: typeof j.procStart === 'string' ? j.procStart : String(j.procStart ?? ''),
        version: typeof j.version === 'string' ? j.version : '',
        peerProtocol: typeof j.peerProtocol === 'number' ? j.peerProtocol : 0,
        kind: j.kind,
        entrypoint: j.entrypoint,
      });
    } catch {
      // skip unparseable files; every I/O refusal is already a null from the
      // read helper, so only JSON.parse reaches here
    }
  }
  return entries;
}
