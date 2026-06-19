// artifact-source interface (ADR 0009 §1).
//
// The data plane's source of truth is raw `~/.claude` artifacts addressed by
// `source_id + rel_path + signature` — NOT parsed SQL rows. This module is the
// abstraction `ingest.mjs` routes its source-relative path resolution,
// directory listing, and history reads through (`resolve`/`list`/`exists`/
// `read`), so a second source root (another machine, a pushed pod bundle) is
// just another `ArtifactSource` with the same interface. The directory-walking
// aggregate-artifact parsers (sessions/, telemetry/, …) still take a real fs
// path via the `ArtifactRef.absPath` escape hatch rather than `read`. The
// content-string parsers stay untouched; only *where the bytes come from* is
// hidden here.
//
// Slice 1 of #1563 (#1643): the interface + its first, filesystem-backed
// implementation rooted at a local `~/.claude` directory. The multi-root
// aggregation (slice 4) lives in `ingest.mjs`, which iterates one
// `ArtifactSource` per configured `DataSource` and tags every emitted row with
// the source's `id` for provenance.
//
// Kept in plain dependency-free TS (no npm imports) because `ingest.mjs` boots
// it through the register-ts loader in the server image, which ships ZERO
// node_modules — anything pulled into this graph at boot would crash-loop.

import {
  closeSync,
  opendirSync,
  openSync,
  readSync,
  statSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { CodingHarness, DataSource } from '../types';

/** A cheap stat-only fingerprint of a file (mtime + size), or '0:0' if absent. */
export type ArtifactSignature = string;

/** A single artifact addressed by its owning source + a root-relative path. */
export interface ArtifactRef {
  /** Provenance: the `DataSource.id` (or hub-root id) this artifact belongs to. */
  sourceId: string;
  /** The coding harness that produced the source (carried for provenance). */
  harness: CodingHarness;
  /** Path relative to the source root (the `~/.claude` directory). */
  relPath: string;
  /** Cheap stat fingerprint (`mtimeMs:size`); changes when the file changes. */
  signature: ArtifactSignature;
  /** Absolute path on disk — the escape hatch for the directory-walking parsers
   *  that still need a real fs path. Keeping it here means callers never
   *  re-derive `join(root, relPath)` and so can't drift from the interface. */
  absPath: string;
}

/** Text + signature returned by a `read`. */
export interface ArtifactReadResult {
  text: string;
  signature: ArtifactSignature;
}

/** Options for a capped read. */
export interface ArtifactReadOptions {
  /** Throw if the file exceeds this many bytes (parity with ingest's caps). */
  maxBytes?: number;
}

/**
 * The `artifact-source` interface (ADR 0009 §1): list and read raw artifacts by
 * `source_id + rel_path + signature`. Implementations hide *where* the bytes
 * live (local fs today; a PVC/R2 blob store later) behind a uniform contract.
 */
export interface ArtifactSource {
  /** Provenance id (the `DataSource.id`). */
  readonly id: string;
  /** The harness that produced this source. */
  readonly harness: CodingHarness;
  /** Resolve a root-relative path to an absolute fs path. */
  resolve(relPath: string): string;
  /** Cheap stat fingerprint for one root-relative path. */
  signature(relPath: string): ArtifactSignature;
  /** Whether a root-relative path exists. */
  exists(relPath: string): boolean;
  /**
   * List immediate children of a root-relative directory as `ArtifactRef`s.
   * Returns `[]` for a missing/unreadable directory (never throws), matching
   * the streaming directory scans ingest already uses. `filter` keeps only
   * entries whose dirent passes the predicate (e.g. files ending in `.jsonl`).
   */
  list(
    relDir: string,
    filter?: (entry: { name: string; isFile: boolean; isDirectory: boolean }) => boolean
  ): ArtifactRef[];
  /** Read one root-relative file as UTF-8 text + its signature. */
  read(relPath: string, options?: ArtifactReadOptions): ArtifactReadResult;
}

const READ_CHUNK_BYTES = 1 << 20; // 1 MiB, matching ingest's reader.

function statSignature(absPath: string): ArtifactSignature {
  try {
    const s = statSync(absPath);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return '0:0';
  }
}

function artifactFileTooLargeError(maxBytes: number): Error {
  const err = new Error(`Artifact file exceeds ${maxBytes} byte limit`);
  (err as NodeJS.ErrnoException & { code: string }).code =
    'ERR_DASHBOARD_ARTIFACT_FILE_TOO_LARGE';
  return err;
}

function readCappedSync(absPath: string, maxBytes: number): string {
  const fd = openSync(absPath, 'r');
  const chunks: Buffer[] = [];
  let bytes = 0;
  const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, maxBytes + 1));
  try {
    for (;;) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      bytes += bytesRead;
      if (bytes > maxBytes) throw artifactFileTooLargeError(maxBytes);
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
  } finally {
    closeSync(fd);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// Fallback cap only — callers should pass an explicit `maxBytes` (e.g. ingest's
// env-tunable `ARTIFACT_FILE_MAX_BYTES` / `DASHBOARD_ARTIFACT_FILE_MAX_BYTES`)
// so an operator's configured byte cap governs the read; this default applies
// only when a caller omits one.
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Filesystem-backed `ArtifactSource`: the FIRST implementation, rooted at a
 * local `~/.claude` directory (`dirname(DataSource.historyDir)`). Every
 * root-relative path maps to `join(rootDir, relPath)`, so a single-source
 * dataset produces byte-identical paths to the pre-interface direct fs reads —
 * the critical parity property for the live server's data plane.
 */
export class FilesystemArtifactSource implements ArtifactSource {
  readonly id: string;
  readonly harness: CodingHarness;
  /** The `~/.claude` root this source reads from. */
  readonly rootDir: string;

  constructor(params: { id: string; harness: CodingHarness; rootDir: string }) {
    this.id = params.id;
    this.harness = params.harness;
    this.rootDir = params.rootDir;
  }

  resolve(relPath: string): string {
    return relPath ? join(this.rootDir, relPath) : this.rootDir;
  }

  signature(relPath: string): ArtifactSignature {
    return statSignature(this.resolve(relPath));
  }

  exists(relPath: string): boolean {
    try {
      statSync(this.resolve(relPath));
      return true;
    } catch {
      return false;
    }
  }

  private refFor(relPath: string): ArtifactRef {
    const absPath = this.resolve(relPath);
    return {
      sourceId: this.id,
      harness: this.harness,
      relPath,
      signature: statSignature(absPath),
      absPath,
    };
  }

  list(
    relDir: string,
    filter?: (entry: {
      name: string;
      isFile: boolean;
      isDirectory: boolean;
    }) => boolean
  ): ArtifactRef[] {
    const absDir = this.resolve(relDir);
    let dir;
    try {
      dir = opendirSync(absDir);
    } catch {
      return [];
    }
    const out: ArtifactRef[] = [];
    try {
      for (;;) {
        const ent = dir.readSync();
        if (!ent) break;
        const meta = {
          name: ent.name,
          isFile: ent.isFile(),
          isDirectory: ent.isDirectory(),
        };
        if (filter && !filter(meta)) continue;
        out.push(this.refFor(relDir ? join(relDir, ent.name) : ent.name));
      }
    } finally {
      dir.closeSync();
    }
    return out;
  }

  read(relPath: string, options: ArtifactReadOptions = {}): ArtifactReadResult {
    const absPath = this.resolve(relPath);
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    return {
      text: readCappedSync(absPath, maxBytes),
      signature: statSignature(absPath),
    };
  }
}

/**
 * Build the filesystem `ArtifactSource` for a resolved `DataSource`. The source
 * root is the `~/.claude` directory (`dirname(historyDir)`), so its
 * root-relative `history.jsonl`, `sessions/`, `telemetry/`, etc. resolve
 * exactly as the existing `sourceArtifactPath` helper does — preserving
 * byte-identical paths for the single-source case (the data-plane parity
 * property). For hub mirror roots `historyDir` is the bare projects root, so
 * the source root is its parent; the aggregate-artifact dirs simply won't exist
 * there, which the guarded readers already tolerate.
 */
export function filesystemArtifactSource(source: DataSource): FilesystemArtifactSource {
  return new FilesystemArtifactSource({
    id: source.id,
    harness: source.harness,
    rootDir: dirname(source.historyDir),
  });
}
