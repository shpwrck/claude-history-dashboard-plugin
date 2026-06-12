/**
 * External guidance snapshot reader (#1300, epic #656).
 *
 * The pure core — types, source registry, parser/validator, reference
 * projection — lives in `./external-guidance` so the browser-bundled
 * recommendation engine can import it without dragging node:fs into the SPA.
 * This module owns only the on-disk snapshot-store reader and re-exports the
 * core for back-compat with existing importers.
 */
import { join } from 'node:path';
import { normalizeMaxEntries, readDirentsBoundedSync } from './bounded-fs';
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
}

export function readExternalGuidanceSnapshots(
  dir: string,
  opts: ParseExternalGuidanceOptions = {}
): ExternalGuidance[] {
  const maxEntries = normalizeMaxEntries(opts.maxEntries);
  const maxFileBytes = opts.maxFileBytes ?? CONFIG_FILE_MAX_BYTES;
  return readDirentsBoundedSync(dir, maxEntries)
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => join(dir, entry.name))
    .sort()
    .map((path) =>
      parseExternalGuidanceSnapshot(
        JSON.parse(readTextFileCappedSync(path, maxFileBytes))
      )
    );
}
