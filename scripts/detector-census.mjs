#!/usr/bin/env node
// Detector census (#2998, ADR 0002 §4): which registered detectors have fired at
// least once over this machine's retained local artifacts.
//
// The census is evidence for a later, review-gated retirement pass (#3770). It
// retires nothing itself. Its output is deliberately narrow so it can be
// committed as a sanitized artifact:
//
//   - each detector's id, whether it was measured, and a fired-ever boolean;
//   - the observation window as two calendar dates;
//   - a coverage disclosure naming the population and tallying detectors.
//
// No transcript text, session ids, per-session rows, or event counts leave this
// script. `assertSanitizedCensus` enforces that shape on every write.
//
// "Measured" means at least one input field the detector declares in
// `dataDeps` held data. A detector that did not fire and saw none of its
// declared inputs, or declares none, is `unmeasured`: zero observations is
// never reported as "never fires".
//
// Usage (reads the local ~/.claude through the same ingest the server uses; no
// network):
//   node --import ./scripts/register-ts.mjs scripts/detector-census.mjs \
//     [--as-of YYYY-MM-DD] [--out docs/audits/detector-census.json]

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const CENSUS_SCHEMA_VERSION = 1;

export const CENSUS_POPULATION =
  "This machine's retained local Claude Code artifacts (~/.claude) over the " +
  'named window. Artifacts removed by retention or cleanup before the run are ' +
  'not observed, and other machines or users are not represented.';

export const CENSUS_METHOD =
  'Each detector ran once over everything retained in the window, as of the asOf ' +
  'date. A detector that only looks back a few days saw only the end of the ' +
  'window, so firedEver is a lower bound for it.';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DETECTOR_ID_RE = /^[a-z][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/;

/** Same presence test the engine's domain coverage uses (src/lib/coverage.ts). */
export function hasInputValue(input, key) {
  const value = input?.[key];
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function isoDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * The observation window: the first session's start date through the last
 * session's end date, or null when no session was retained.
 */
export function observationWindow(sessions) {
  let from = Infinity;
  let to = -Infinity;
  for (const session of sessions ?? []) {
    const start = Number(session?.startTime);
    const end = Number(session?.endTime);
    if (Number.isFinite(start)) from = Math.min(from, start);
    if (Number.isFinite(end)) to = Math.max(to, end);
    else if (Number.isFinite(start)) to = Math.max(to, start);
  }
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return { from: isoDate(from), to: isoDate(to), endMs: to };
}

function detectorFired(detector, input, now) {
  if (typeof detector.emitAll === 'function') {
    return detector.emitAll(input, now).length > 0;
  }
  return detector.rule(input, now) !== null;
}

/**
 * Build the census from a detector catalog and one engine input. Pure: the same
 * catalog, input, and `asOfMs` always give the same object.
 *
 * Each detector runs on its own (rule or emitAll) so a finding is attributed to
 * the detector that produced it, before any engine-level collapse or user
 * rejection could hide it.
 */
export function buildDetectorCensus({ detectors, input, asOfMs }) {
  const window = observationWindow(input?.sessions);
  const now = asOfMs ?? window?.endMs;
  if (!Number.isFinite(now)) {
    throw new Error(
      'detector census: no retained sessions to date the window; pass --as-of YYYY-MM-DD'
    );
  }

  const rows = [];
  // perf-index-contract: census-duplicate-ids always-consumed: every detector in the catalog is checked against it
  const seen = new Set();
  for (const detector of detectors) {
    if (seen.has(detector.id)) {
      throw new Error(`detector census: duplicate detector id ${detector.id}`);
    }
    seen.add(detector.id);
    const fired = detectorFired(detector, input, now);
    const deps = detector.dataDeps ?? [];
    const sawInput = deps.some((dep) => hasInputValue(input, dep));
    const measured = fired || sawInput;
    rows.push({
      id: detector.id,
      measured,
      firedEver: measured ? fired : null,
    });
  }
  // perf-index-contract: census-row-order always-consumed: the serialized artifact is always written in id order
  rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const fired = rows.filter((row) => row.firedEver === true).length;
  const measuredNotFired = rows.filter((row) => row.firedEver === false).length;
  const unmeasured = rows.filter((row) => !row.measured).length;

  const census = {
    schemaVersion: CENSUS_SCHEMA_VERSION,
    window: {
      from: window?.from ?? null,
      to: window?.to ?? null,
      asOf: isoDate(now),
    },
    coverage: {
      population: CENSUS_POPULATION,
      method: CENSUS_METHOD,
      measuredMeans:
        'The detector fired, or at least one input it declares in dataDeps held data.',
      unmeasuredMeans:
        'The detector did not fire and none of its declared inputs held data (or it declares none). This is not evidence that it never fires.',
      detectors: rows.length,
      firedEver: fired,
      measuredNotFired,
      unmeasured,
    },
    detectors: rows,
  };
  assertSanitizedCensus(census);
  return census;
}

const TOP_KEYS = ['schemaVersion', 'window', 'coverage', 'detectors'];
const WINDOW_KEYS = ['from', 'to', 'asOf'];
const COVERAGE_KEYS = [
  'population',
  'method',
  'measuredMeans',
  'unmeasuredMeans',
  'detectors',
  'firedEver',
  'measuredNotFired',
  'unmeasured',
];
const ROW_KEYS = ['id', 'measured', 'firedEver'];

function assertExactKeys(value, keys, where) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`detector census: ${where} must be an object`);
  }
  // perf-index-contract: census-key-shape always-consumed: both sorted key lists are compared on every call
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.join('\n') !== expected.join('\n')) {
    throw new Error(
      `detector census: ${where} keys must be exactly ${expected.join(', ')} (got ${actual.join(', ')})`
    );
  }
}

/**
 * Reject anything beyond the published shape: no extra keys at any level, ids
 * shaped like detector ids, dates as plain calendar dates, detector tallies
 * that agree with the rows, and the two fixed disclosure strings. This is what
 * keeps transcript text, session rows, and event counts out of the artifact.
 */
export function assertSanitizedCensus(census) {
  assertExactKeys(census, TOP_KEYS, 'census');
  if (census.schemaVersion !== CENSUS_SCHEMA_VERSION) {
    throw new Error('detector census: unknown schemaVersion');
  }
  assertExactKeys(census.window, WINDOW_KEYS, 'window');
  for (const key of WINDOW_KEYS) {
    const value = census.window[key];
    if (key !== 'asOf' && value === null) continue;
    if (typeof value !== 'string' || !DATE_RE.test(value)) {
      throw new Error(`detector census: window.${key} must be a YYYY-MM-DD date`);
    }
  }
  assertExactKeys(census.coverage, COVERAGE_KEYS, 'coverage');
  if (census.coverage.population !== CENSUS_POPULATION) {
    throw new Error('detector census: coverage.population must be the fixed disclosure');
  }
  if (census.coverage.method !== CENSUS_METHOD) {
    throw new Error('detector census: coverage.method must be the fixed disclosure');
  }
  for (const key of ['measuredMeans', 'unmeasuredMeans']) {
    if (typeof census.coverage[key] !== 'string' || census.coverage[key].length > 200) {
      throw new Error(`detector census: coverage.${key} must be a short fixed string`);
    }
  }
  if (!Array.isArray(census.detectors)) {
    throw new Error('detector census: detectors must be an array');
  }
  let fired = 0;
  let quiet = 0;
  let unmeasured = 0;
  for (const [index, row] of census.detectors.entries()) {
    assertExactKeys(row, ROW_KEYS, `detectors[${index}]`);
    if (typeof row.id !== 'string' || !DETECTOR_ID_RE.test(row.id)) {
      throw new Error(`detector census: detectors[${index}].id is not a detector id`);
    }
    if (typeof row.measured !== 'boolean') {
      throw new Error(`detector census: detectors[${index}].measured must be boolean`);
    }
    if (row.measured ? typeof row.firedEver !== 'boolean' : row.firedEver !== null) {
      throw new Error(
        `detector census: detectors[${index}].firedEver must be boolean when measured and null when unmeasured`
      );
    }
    if (row.firedEver === true) fired += 1;
    else if (row.firedEver === false) quiet += 1;
    else unmeasured += 1;
  }
  const coverage = census.coverage;
  if (
    coverage.detectors !== census.detectors.length ||
    coverage.firedEver !== fired ||
    coverage.measuredNotFired !== quiet ||
    coverage.unmeasured !== unmeasured
  ) {
    throw new Error('detector census: coverage tallies must count the detector rows');
  }
  return census;
}

export function serializeCensus(census) {
  return `${JSON.stringify(assertSanitizedCensus(census), null, 2)}\n`;
}

function parseArgs(argv) {
  const options = { asOf: null, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--as-of' || arg === '--out') {
      const value = argv[i + 1];
      if (!value) throw new Error(`${arg} needs a value`);
      i += 1;
      if (arg === '--as-of') {
        if (!DATE_RE.test(value)) throw new Error('--as-of must be YYYY-MM-DD');
        options.asOf = Date.parse(`${value}T23:59:59.999Z`);
      } else {
        options.out = value;
      }
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

/**
 * Run the census over the default local ingest (the same `~/.claude` roots the
 * server reads, honoring the same env overrides).
 */
export async function runDetectorCensus({ asOfMs } = {}) {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const { ingest, assembleRecommendationContext } = await import(
    pathToFileURL(join(repoRoot, 'scripts', 'ingest.mjs')).href
  );
  const { DETECTORS } = await import(
    pathToFileURL(join(repoRoot, 'src', 'lib', 'detectors', 'index.ts')).href
  );
  ingest();
  const { input } = assembleRecommendationContext({});
  return buildDetectorCensus({ detectors: DETECTORS, input, asOfMs });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const census = await runDetectorCensus({ asOfMs: options.asOf ?? undefined });
  const text = serializeCensus(census);
  if (options.out) {
    writeFileSync(options.out, text);
    process.stderr.write(
      `detector census: ${census.coverage.detectors} detectors, ${census.coverage.firedEver} fired, ` +
        `${census.coverage.measuredNotFired} measured without firing, ${census.coverage.unmeasured} unmeasured -> ${options.out}\n`
    );
  } else {
    process.stdout.write(text);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    process.stderr.write(`${err?.message ?? err}\n`);
    process.exit(1);
  });
}

export const _test = { parseArgs };
