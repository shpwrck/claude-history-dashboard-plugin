/**
 * External guidance snapshot reader (#1300, epic #656).
 *
 * The pure core — types, source registry, parser/validator, reference
 * projection — lives in `./external-guidance` so the browser-bundled
 * recommendation engine can import it without dragging node:fs into the SPA.
 * This module owns only the on-disk snapshot-store reader and re-exports the
 * core for back-compat with existing importers.
 */
import { opendirSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeMaxEntries } from './bounded-fs';
import { CONFIG_FILE_MAX_BYTES, readTextFileCappedSync } from './config-loader';
import {
  parseExternalGuidanceSnapshot,
  type ExternalGuidance,
} from './external-guidance';

export type {
  ExternalGuidance,
  ExternalGuidanceFacts,
  ExternalGuidanceFactValue,
  ExternalGuidancePage,
  ExternalGuidanceRef,
  ExternalGuidanceSource,
  ExternalGuidanceTarget,
  ExternalGuidanceTrustTier,
} from './external-guidance';
export {
  EXTERNAL_GUIDANCE_MAX_FUTURE_SKEW_MS,
  ExternalGuidanceParseError,
  externalGuidanceRef,
  isAllowedUrl,
  parseExternalGuidanceSnapshot,
  renderExternalGuidanceContent,
  SOURCE_REGISTRY,
  sourceForExternalGuidance,
} from './external-guidance';

export interface ParseExternalGuidanceOptions {
  maxFileBytes?: number;
  maxEntries?: number;
  /** Hard cap on all top-level dirents inspected while finding eligible JSON. */
  maxScannedEntries?: number;
}

/**
 * Authoritative bounded snapshot surface shared by the reader and both cache
 * gates. Non-files, nested content, and non-JSON entries never consume the
 * snapshot cap; a separate scan cap keeps a hostile override directory cheap.
 */
export function externalGuidanceSnapshotPaths(
  dir: string,
  opts: ParseExternalGuidanceOptions = {}
): string[] {
  const maxEntries = normalizeMaxEntries(opts.maxEntries);
  const maxScannedEntries = normalizeMaxEntries(
    opts.maxScannedEntries ?? maxEntries
  );
  const paths: string[] = [];
  let scanned = 0;
  let handle: ReturnType<typeof opendirSync>;
  try {
    handle = opendirSync(dir);
  } catch {
    return paths;
  }
  try {
    while (scanned < maxScannedEntries) {
      const entry = handle.readSync();
      if (!entry) break;
      scanned += 1;
      if (entry.isFile() && entry.name.endsWith('.json')) {
        paths.push(join(dir, entry.name));
      }
    }
  } finally {
    try {
      handle.closeSync();
    } catch {
      /* ignore close failures */
    }
  }
  return paths.sort().slice(0, maxEntries);
}

export function readExternalGuidanceSnapshots(
  dir: string,
  opts: ParseExternalGuidanceOptions = {}
): ExternalGuidance[] {
  const maxFileBytes = opts.maxFileBytes ?? CONFIG_FILE_MAX_BYTES;
  return externalGuidanceSnapshotPaths(dir, opts)
    .map((path) =>
      parseExternalGuidanceSnapshot(
        JSON.parse(readTextFileCappedSync(path, maxFileBytes))
      )
    );
}
