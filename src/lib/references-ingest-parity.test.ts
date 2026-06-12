import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// REFERENCES.md ingest-time parser-table parity (#541).
//
// REFERENCES.md is the authoritative `~/.claude/` artifact -> parser -> dataset-key
// map agents read before touching parsers. Its ingest-time table silently fell
// ~11 rows behind the code once (the late-May sprint added modules the table was
// never backfilled with), and nothing caught it — `parse-assistant-features.ts`
// (-> `assistantFeatures`) shipped undocumented even though downstream code cited
// the key. This test enforces the DETERMINISTIC half of the map: every dataset
// key `assembleDataset()` ships must have a row in the ingest-time table, so a
// new ingest parser key can't land without its REFERENCES row.
//
// Scope is deliberately the zero-false-positive half (the issue's #541 design):
// the derived/UI table needs human judgment ("is this src/lib a data module or
// infra?") and is NOT enforced here. The ALLOWLIST below carries the small set
// of `assembleDataset` keys that are intentionally NOT ingest-parser rows — the
// response envelope and the keys documented in other REFERENCES sections — each
// with its reason. Adding a key here is a conscious, reviewable act.

const ROOT = process.cwd();
const ingestSrc = readFileSync(`${ROOT}/scripts/ingest.mjs`, 'utf8');
const referencesSrc = readFileSync(`${ROOT}/REFERENCES.md`, 'utf8');

/** Top-level keys of the object `assembleDataset()` returns. */
function assembleDatasetKeys(src: string): string[] {
  const fnIdx = src.indexOf('export function assembleDataset');
  if (fnIdx === -1) throw new Error('assembleDataset() not found in ingest.mjs');
  const after = src.slice(fnIdx);
  const retIdx = after.indexOf('\n  return {');
  if (retIdx === -1) throw new Error('assembleDataset() return block not found');
  const block = after.slice(retIdx);
  const end = block.indexOf('\n  };');
  const body = block.slice(0, end === -1 ? undefined : end);
  const keys: string[] = [];
  // Top-level keys are at exactly 4-space indent; `units: { ... }` nests deeper
  // (6 spaces) and is excluded so only the response's own keys are collected.
  for (const line of body.split('\n')) {
    const m = /^ {4}(\w+)[,:]/.exec(line);
    if (m) keys.push(m[1]);
  }
  return [...new Set(keys)];
}

/** Backticked dataset-key tokens in the 3rd column of the ingest-time table. */
function ingestTableKeys(md: string): Set<string> {
  const start = md.indexOf('### Ingest-time parsers');
  const end = md.indexOf('### Derived parsers');
  if (start === -1 || end === -1) throw new Error('ingest-time table section not found');
  const section = md.slice(start, end);
  const keys = new Set<string>();
  for (const line of section.split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|');
    const lastCell = cells[cells.length - 2] ?? ''; // trailing '' after final '|'
    for (const m of lastCell.matchAll(/`([A-Za-z]+)`/g)) keys.add(m[1]);
  }
  return keys;
}

// `assembleDataset` keys that are intentionally NOT ingest-time parser rows.
const ALLOWLIST: Record<string, string> = {
  // Response envelope — not parser data.
  schemaVersion: 'response envelope',
  generatedAt: 'response envelope',
  windowStart: 'response envelope',
  windowEnd: 'response envelope',
  units: 'response envelope (numeric-field unit hints)',
  // Documented in other REFERENCES sections, not the ingest-PARSER table.
  liveConfig: 'config surface — documented in the liveConfig/config-loader rows',
  repoMap: 'server-only repo-map join — documented in the repo-map section (ADR 0007)',
  reviewEvents: 'enterprise organization-review-events — documented separately',
  workflows:
    'shipped via scripts/read-workflows.mjs (readWorkflowsSync), not a parse-*.ts ' +
    'parser — documented in the workflows artifact-map rows, not the parser table',
  externalGuidance:
    'repo-committed guidance snapshots (data/external-guidance/, #1302), not a ' +
    '~/.claude artifact — documented in the repository-bundled artifacts table',
};

describe('REFERENCES.md ingest-time parser-table parity (#541)', () => {
  it('documents every assembleDataset() dataset key in the ingest-time table', () => {
    const tableKeys = ingestTableKeys(referencesSrc);
    const undocumented = assembleDatasetKeys(ingestSrc).filter(
      (k) => !ALLOWLIST[k] && !tableKeys.has(k)
    );
    expect(
      undocumented,
      `These assembleDataset() keys have no row in REFERENCES.md's ingest-time ` +
        `parser table (and aren't allowlisted as envelope/elsewhere-documented). ` +
        `Add a row (or, if intentional, an ALLOWLIST entry with a reason): ` +
        undocumented.join(', ')
    ).toEqual([]);
  });

  it('extraction is non-trivial (guards against a silently-empty parse)', () => {
    expect(assembleDatasetKeys(ingestSrc).length).toBeGreaterThan(20);
    expect(ingestTableKeys(referencesSrc).has('tokenData')).toBe(true);
    expect(ingestTableKeys(referencesSrc).has('assistantFeatures')).toBe(true);
  });
});
