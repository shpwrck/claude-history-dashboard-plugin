/**
 * Parser for saved plan-mode documents (#565).
 *
 * Claude Code can save plan-mode / ExitPlanMode outputs to `~/.claude/plans/*.md`.
 * Each file is a markdown document. This module extracts a 4-feature structural
 * signature per plan (section count, numbered file-change refs, word count,
 * presence of a Verification/Test section), then clusters plans into shapes
 * A/B/C using deterministic k-means (k=3, fixed seed initialization).
 *
 * Structure-only extraction: the parser counts structural features and NEVER
 * surfaces file body text, secrets, or credentials. This matches the P5 Riley
 * persona prototype (`proto/539-plans`).
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_ARTIFACT_MAX_ENTRIES,
  normalizeMaxEntries,
  readDirentsBoundedSync,
} from './bounded-fs';

// The plan signature shape, markdown feature extraction, and shape clustering
// live in the fs-free `plan-clusters` leaf (#3639) so the browser-bundled
// PlanShapesPf view can import them WITHOUT a runtime edge into this
// fs-touching module. Re-exported here so existing `from './parse-plans'`
// consumers keep resolving.

import { parsePlanMarkdown, type PlanSignature } from './plan-clusters';

export type {
  PlanSignature,
  PlanShape,
  ClusterStats,
  PlanClusterAssignment,
  ClusterResult,
} from './plan-clusters';
export { parsePlanMarkdown, clusterPlans } from './plan-clusters';

export interface ParsePlansOptions {
  maxFileBytes?: number;
  maxEntries?: number;
}

// ── Directory scan ───────────────────────────────────────────────────────────

/**
 * Scan a directory of plan markdown files and return one {@link PlanSignature}
 * per `.md` file found. Files that cannot be read are silently skipped.
 *
 * @param dir  Absolute path to the plans directory (e.g. `~/.claude/plans`).
 *             Tilde expansion is NOT done here; callers must resolve `~` first.
 */
export function parsePlansDir(dir: string, opts: ParsePlansOptions = {}): PlanSignature[] {
  const maxEntries = normalizeMaxEntries(opts.maxEntries, DEFAULT_ARTIFACT_MAX_ENTRIES);
  const entries = readDirentsBoundedSync(dir, maxEntries).map((entry) => entry.name);
  const maxFileBytes =
    typeof opts.maxFileBytes === 'number' &&
    Number.isFinite(opts.maxFileBytes) &&
    opts.maxFileBytes >= 0
      ? Math.floor(opts.maxFileBytes)
      : -1;

  const out: PlanSignature[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;
    let text: string;
    try {
      const filePath = path.join(dir, entry);
      const fileStat = fs.statSync(filePath);
      if (
        !fileStat.isFile() ||
        (maxFileBytes >= 0 && fileStat.size > maxFileBytes)
      ) {
        continue;
      }
      text = fs.readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }
    const name = entry.replace(/\.md$/i, '');
    out.push(parsePlanMarkdown(text, name));
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
