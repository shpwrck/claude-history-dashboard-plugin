#!/usr/bin/env node
// Repo Map measurement gates (#893, epic #871). See ADR 0007 and
// docs/perf-sprint/repo-map.md.
//
// The epic's measurement plan and privacy non-goals call out four failure modes
// for the repo-map artifact: it can balloon cold-ingest cost, grow the dataset
// payload, lose localization quality (the map must surface the files a task
// actually needs), or stop reducing the reread/search waste it exists to cut.
// This gate quantifies each against a budget so a regression fails CI rather than
// shipping silently — the sibling of check-bundle-size.mjs / cold-load-measure.mjs.
//
// It runs HOST-SIDE (it generates the repo-map, which needs the WASM grammars):
//   node --import ./scripts/register-ts.mjs scripts/repo-map-gate.mjs
//   node --import ./scripts/register-ts.mjs scripts/repo-map-gate.mjs --root <dir>
//   ... --json out.json        also write the structured metrics
//   ... --measure-only         print numbers, do not gate (exit 0)
//   ... --budget <file>        override the budget JSON
//   ... --max-persisted-bytes  override the producer's size ceiling (tests)
//
// Metrics (each checked against repo-map-budget.json):
//   - unboundedPayloadBytes      what the artifact serializes to with NO size
//                                ceiling — the real growth signal, and the one
//                                that gates. The persisted size is CLAMPED to
//                                the ceiling by enforceSizeLimit, so gating it
//                                against an equal budget was a tautology that
//                                could never fail (#3452); it is now reported
//                                but not gated.
//   - retainedFilesPct           share of ranked files surviving the clamp, so
//                                an artifact silently shedding files fails here
//                                instead of only showing up as worse recall
//   - coldIngestMs               wall-clock to walk + parse + render cold
//   - localizationRecallPct      share of the import graph's resolved edges
//                                whose target file falls in the ranked head
//                                (top-K, K a FRACTION of the ranked count) —
//                                rebuilt in #3471 so the ground truth is
//                                independent of the ranking under test
//   - rereadWasteTokensSaved     reread/search tokens the map saves a session
//                                vs. the no-map baseline (token/reread reduction)
// Raise a ceiling deliberately, with a note, when a change is a real win.
// Localization has a stricter contract (#3510): its floor and slice fraction are
// anchored to a RECORDED measurement (`localizationBaseline`) plus a hash of the
// ranking/extraction sources, AND the budget's localization keys are compared
// against the committed copy at origin/master, so relaxing them without a fresh
// re-measurement fails instead of merely looking bad. Residual slack is bounded
// by the down tolerance (1 point) and always visible as a budget diff. See
// docs/perf-sprint/repo-map.md.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';
import { envNumber, EnvNumberError } from './lib/env-number.mjs';
import { headSha, requiredGit } from './lib/host-producer.mjs';
import { localizationProbe } from './lib/repo-map-probe.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');

const {
  generateRepoMap,
  renderRepoMap,
  computeCacheKey,
  enforceSizeLimit,
  serializedBytes,
  assertNoBodyLeakage,
  DEFAULT_MAX_PERSISTED_BYTES,
} = await import(join(REPO_ROOT, 'src', 'lib', 'repo-map', 'index.ts'));

function parseArgs(argv) {
  const out = { root: REPO_ROOT, budget: join(REPO_ROOT, 'repo-map-budget.json') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') out.root = resolve(argv[++i]);
    else if (a === '--budget') out.budget = argv[++i];
    else if (a === '--json') out.json = argv[++i];
    else if (a === '--measure-only') out.measureOnly = true;
    else if (a === '--max-persisted-bytes') {
      // The producer's real ceiling, overridable so a test can exercise the
      // size-bounding path without building a 1 MiB corpus. Parsed FAIL-CLOSED
      // (#3076): bad input exits non-zero rather than silently falling back to
      // a default and measuring something other than what was asked for.
      const raw = argv[++i];
      const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0) {
        console.error(`--max-persisted-bytes must be a positive integer, got: ${raw}`);
        process.exit(2);
      }
      out.maxPersistedBytes = n;
    } else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

function die(msg) {
  console.error(`\n✗ Repo-map gate ERROR — ${msg}\n`);
  process.exit(2);
}

function hrMs() {
  const [s, ns] = process.hrtime();
  return s * 1e3 + ns / 1e6;
}

// ---------------------------------------------------------------------------
// Relaxation control (#3510).
//
// This one gate has produced five instances of a single defect class — a
// control reporting success for a state it claims to reject (#3076, #3452,
// #3471 a/b/c) — and its localization floor/slice were relaxed ten times in a
// row, every time stating "touches no ranking code". Convention did not hold,
// so this is a control: the budget records the LAST MEASUREMENT
// (`localizationBaseline`) plus a hash of the ranking/extraction sources, and
// the gate enforces
//
//   - measured recall within [baseline - DOWN, baseline + UP] — a drop is a
//     regression (exit 1), and a measured value far ABOVE the recorded
//     baseline means the baseline is stale or sandbagged and must be ratcheted
//     UP (exit 1), so the recorded number cannot quietly detach from reality
//     in either direction;
//   - the ranking-surface hash must match the baseline's — ranking/extraction
//     edits MUST re-measure and re-record in the same commit (exit 2);
//   - `localizationTopKPct` must equal the baseline's;
//   - the floor may sit at most FLOOR_SLACK below the recorded baseline.
//
// Those in-file checks alone are NOT sufficient: the gate is stateless within
// one commit, so a PAIRED JSON edit (baseline lowered together with the floor,
// or the slice fraction widened in both places with a stale recorded value)
// could satisfy every one of them (review r13-rev-perf, findings 1-2). The
// missing state is supplied by CROSS-COMMIT checks (`priorLocalizationBudget`):
// the budget's localization keys are compared against the committed copy at the
// TRUST ANCHOR — origin/master (fetched fresh in CI, so local history amending
// cannot alter it; REPO_MAP_PRIOR_BUDGET_REF overrides for odd topologies,
// falling back to HEAD, and an unresolvable prior is skipped WITH A PRINTED
// NOTE, never silently). Relative to that prior copy:
//
//   - lowering `localizationBaseline.recallPct` fails unless the new value
//     matches the freshly measured probe within the down tolerance — the
//     machine-checkable "fresh measurement in the same commit";
//   - moving `localizationTopKPct` fails under the same fresh-match rule, so a
//     widened slice must RECORD the (monotonically higher) fresh number and
//     thereby raises the future bar instead of buying slack;
//   - lowering `localizationRecallMinPct` fails unless the recorded baseline
//     legitimately moved down in the same commit, and by at least as much —
//     the floor follows a fresh re-baseline, it never moves on its own.
//
// Honest bound on the residual: because "fresh" is a ±DOWN tolerance, a
// baseline may still be recorded up to 1 point below measured reality, buying
// at most 1 point of regression slack — visible in the diff, and
// NON-COMPOUNDING (the next lowering is measured against then-current reality,
// which JSON edits cannot move). The other residual is the hash surface:
// RANKING_SURFACE covers the local ranking/extraction sources but not the
// Tree-sitter grammar binary, so a grammar swap shows up only through the
// measured value, not the sha.
// ---------------------------------------------------------------------------
const BASELINE_DOWN_TOLERANCE_PCT = 1.0; // > this drop vs recorded baseline = regression
const BASELINE_UP_TOLERANCE_PCT = 3.0; // > this rise = stale/sandbagged baseline, ratchet it up
const FLOOR_MAX_SLACK_PCT = 5.0; // floor may trail the recorded baseline by at most this

/** The ranking/scoring/extraction surface the baseline is measured against —
 *  the code every historical relaxation swore it did not touch, PLUS its local
 *  behavior-bearing dependencies (review r13-rev-perf finding 4a: the walk in
 *  bounded-fs determines the ranked file SET and therefore every in-degree)
 *  and the probe definition itself (changing the probe changes the metric).
 *  Changing any of these files without re-recording `localizationBaseline` is
 *  a hard error. NOT covered: the web-tree-sitter WASM grammar — a grammar
 *  swap surfaces only through the measured value. The budget JSON never enters
 *  the hash (it is the surface being controlled). */
const RANKING_SURFACE = [
  'src/lib/repo-map/generate.ts',
  'src/lib/repo-map/parser.ts',
  'src/lib/repo-map/types.ts',
  'src/lib/bounded-fs.ts',
  'src/lib/secret-redaction.ts',
  'scripts/lib/repo-map-probe.mjs',
];

function rankingSurfaceSha256() {
  const hash = createHash('sha256');
  for (const rel of RANKING_SURFACE) {
    hash.update(rel);
    hash.update('\0');
    hash.update(readFileSync(join(REPO_ROOT, rel)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

/** Resolve the budget file's PRIOR committed copy for the cross-commit
 *  relaxation checks. Refs tried, in order: REPO_MAP_PRIOR_BUDGET_REF when set
 *  (explicit intent — a failure to resolve it is then an ERROR, per #3477's
 *  fail-closed rule), else origin/master (the trust anchor; CI fetches it
 *  fresh before running this gate), else HEAD (last committed copy — catches
 *  working-tree edits locally). Returns `{ available: false, reason }` when the
 *  budget is not in a git repo or no candidate resolves — the caller prints the
 *  reason so the skip is visible, never silent. */
function priorLocalizationBudget(budgetPath) {
  const budgetDir = dirname(resolve(budgetPath));
  const explicitRef = process.env.REPO_MAP_PRIOR_BUDGET_REF;
  let toplevel;
  try {
    toplevel = requiredGit(budgetDir, ['rev-parse', '--show-toplevel'], {
      prefix: 'repo-map gate',
      label: 'resolve budget repository',
    }).trim();
  } catch {
    if (explicitRef) {
      return {
        available: false,
        error: `REPO_MAP_PRIOR_BUDGET_REF=${explicitRef} is set but the budget file is not inside a git repository`,
      };
    }
    return { available: false, reason: 'budget file is not inside a git repository' };
  }
  const rel = relative(toplevel, resolve(budgetPath)).split('\\').join('/');
  const explicit = explicitRef;
  const candidates = explicit ? [explicit] : ['origin/master', 'HEAD'];
  for (const ref of candidates) {
    let raw;
    try {
      raw = requiredGit(budgetDir, ['show', `${ref}:${rel}`], {
        prefix: 'repo-map gate',
        label: `read prior budget at ${ref}`,
      }).trim();
    } catch {
      if (explicit) {
        return {
          available: false,
          error: `REPO_MAP_PRIOR_BUDGET_REF=${explicit} did not resolve ${rel} — an explicit ref must exist`,
        };
      }
      continue;
    }
    try {
      return { available: true, ref, budget: JSON.parse(raw) };
    } catch (err) {
      // A resolvable-but-corrupt prior is a hard error, not a skip: committed
      // history should never hold an unparseable budget, and treating it as
      // "no prior" would turn corruption into a bypass.
      return { available: false, error: `prior budget at ${ref}:${rel} is unparseable (${err.message})` };
    }
  }
  return {
    available: false,
    reason: `no prior budget resolvable (tried ${candidates.join(', ')})`,
  };
}

// ---------------------------------------------------------------------------
// Reread/search-waste model.
//
// Without a map, an agent orienting in an unfamiliar root must scan (open + read
// + often re-read) source to find the handful of files it needs — it pays a cost
// proportional to the WHOLE tree's surface, because it does not yet know which
// files matter. With the map it reads one bounded, ranked fragment ONCE and is
// pointed straight at them. We model the SAVED tokens as the no-map scan surface
// minus the map fragment — the epic's "reread-token waste over time" lens.
//
// No-map surface is approximated as the full signature surface of every file
// (path + each symbol name/signature + imports), which the agent would touch
// piecemeal while searching; the conservative 0.5 factor assumes it scans about
// half the tree before locating its targets. Coarse (~4 chars/token, the
// dashboard's standard estimate) but monotonic: a denser, better-ranked map
// saves more, a bloated/redundant one saves less — what the gate keeps honest.
// ---------------------------------------------------------------------------
function rereadWasteTokensSaved(map) {
  // Full structural surface the agent would otherwise sift through, in chars.
  let surfaceChars = 0;
  for (const f of map.files) {
    surfaceChars += f.path.length;
    for (const s of f.symbols) surfaceChars += s.name.length + s.signature.length;
    for (const spec of f.imports) surfaceChars += spec.length;
  }
  const noMapScanChars = surfaceChars * 0.5; // scans ~half the tree to localize
  const mapChars = map.text.length; // reads the bounded fragment once
  const savedChars = Math.max(0, noMapScanChars - mapChars);
  return Math.round(savedChars / 4); // ~4 chars/token
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  let budget;
  try {
    budget = JSON.parse(readFileSync(args.budget, 'utf8'));
  } catch (err) {
    die(`could not read budget file ${args.budget} (${err.message}).`);
  }

  const gitSha = headSha(args.root, { prefix: 'repo-map gate' });
  // Strict env parsing (#3477): a set-but-unusable override is an error, never
  // a silent fallback that measures something other than what was asked for —
  // the same shared #3076 parser the producer uses, so gate and producer agree.
  const envIntOrDie = (name, fallback) => {
    try {
      return envNumber(name, { fallback, min: 1, integer: true });
    } catch (err) {
      if (err instanceof EnvNumberError) die(err.message);
      throw err;
    }
  };
  const tokenBudget = envIntOrDie('REPO_MAP_TOKEN_BUDGET', 8000);
  const maxFiles = envIntOrDie('REPO_MAP_MAX_FILES', undefined);
  const maxDirEntries = envIntOrDie('REPO_MAP_MAX_DIR_ENTRIES', undefined);

  // Cold ingest cost = generate from scratch (walk + parse + render).
  const t0 = hrMs();
  const map = await generateRepoMap(args.root, {
    gitSha,
    tokenBudget,
    maxFiles,
    maxDirEntries,
  });
  const coldIngestMs = hrMs() - t0;

  // Dataset payload (#3452). TWO figures, and only one of them can gate.
  //
  // `enforceSizeLimit` binary-searches the largest prefix of the ranked file
  // list that fits `maxPersistedBytes` and drops the rest, so the PERSISTED
  // size is clamped to that ceiling by construction. Comparing it against a
  // budget equal to the same ceiling — which is what this gate used to do —
  // is a tautology: `datasetPayloadBytes <= datasetPayloadMaxBytes` could
  // never be false, whatever the repo grew to. Growth was absorbed silently by
  // shedding ranked files instead of failing CI, which is the opposite of what
  // the gate exists for.
  //
  // So we gate the UNBOUNDED serialization — what the artifact would be if
  // nothing were dropped — which is the real growth signal and can actually
  // fail. The persisted figure is still reported (it is what ships) but is
  // deliberately NOT gated, because a clamped value cannot carry a budget.
  // We also gate how much of the map survives the clamp, so an artifact
  // quietly shedding ranked files is itself a failure rather than a silent
  // degradation that only ever surfaced on localization recall.
  // Measure the ceiling the PRODUCER will actually apply, or the retention check
  // guards an artifact nobody ships: scripts/repo-map-generate.mjs honors
  // REPO_MAP_MAX_BYTES, so a deployment setting it to 512 KiB ships far fewer
  // files than a gate hard-coded to the 1 MiB default would ever notice.
  // Precedence: explicit CLI flag > REPO_MAP_MAX_BYTES > built-in default.
  // Parsed fail-closed (#3076) — an unusable override is an error, not a silent
  // fallback that measures a different artifact than the one being shipped.
  // `??` short-circuits, so a valid explicit CLI flag still takes precedence
  // and skips the env parse entirely (the flag was already parsed fail-closed).
  const maxPersistedBytes =
    args.maxPersistedBytes ?? envIntOrDie('REPO_MAP_MAX_BYTES', DEFAULT_MAX_PERSISTED_BYTES);
  const absFiles = map.files.map((f) => join(args.root, f.path));
  const cacheKey = computeCacheKey(args.root, gitSha, absFiles);
  const render = (files) => renderRepoMap(files, tokenBudget);
  const persisted = enforceSizeLimit(map, cacheKey, render, maxPersistedBytes);
  const datasetPayloadBytes = serializedBytes(persisted);
  // Same envelope, no ceiling — the size the artifact naturally wants to be.
  const unbounded = enforceSizeLimit(map, cacheKey, render, Number.MAX_SAFE_INTEGER);
  const unboundedPayloadBytes = serializedBytes(unbounded);
  const retainedFilesPct =
    map.files.length === 0
      ? 100
      : (persisted.map.files.length / map.files.length) * 100;

  // Privacy: even a measurement run asserts no bodies leaked. We can't know the
  // corpus's real secrets, but a non-empty structural map must still scan clean
  // against any sentinels the budget lists (defense in depth for CI).
  const sentinels = budget.bodySentinels || [];
  const leak = assertNoBodyLeakage(persisted, sentinels);
  if (!leak.ok) die(`body leakage: persisted artifact contains ${leak.leaked.join(', ')}`);

  // Obsolete probe knobs are HARD errors (#3471). `localizationTopK` was the
  // absolute slice width widened ten times in a row; `localizationSampleSize`
  // was the seed-sample knob (every ranked file is a seed now, so there is
  // nothing to sample). Silently honoring — or silently ignoring — either
  // would re-open the ladder this rebuild closes.
  for (const obsolete of ['localizationTopK', 'localizationSampleSize']) {
    if (obsolete in budget) {
      die(
        `budget key '${obsolete}' is obsolete since the #3471 probe rebuild. ` +
          'The slice is localizationTopKPct (a fraction of the ranked file count) ' +
          'and every ranked file is a seed. Remove the key.',
      );
    }
  }

  // The slice width, as a FRACTION of the ranked file count. Gating requires it
  // in the budget; --measure-only defaults to 7% so a new budget can be
  // bootstrapped from a measurement run.
  let topKPct = budget.localizationTopKPct;
  if (!Number.isFinite(topKPct) || topKPct <= 0 || topKPct > 100) {
    if (!args.measureOnly) {
      die(
        `budget ${args.budget} needs localizationTopKPct (a number in (0, 100]), ` +
          `got: ${JSON.stringify(budget.localizationTopKPct)}`,
      );
    }
    topKPct = 7;
  }

  const probe = localizationProbe(map, topKPct);
  const surfaceSha = rankingSurfaceSha256();

  // No evidence is an ERROR, not a score (#3471 defect 3: the old probe
  // returned 100 — a perfect mark for having measured nothing, which clears
  // any floor by construction). --measure-only reports the non-result.
  if (!probe.evaluable && !args.measureOnly) {
    die(
      'localization probe is not evaluable: no resolvable intra-repo import ' +
        'edges in this root, so there is no evidence to score. Refusing to ' +
        'claim recall for it.',
    );
  }

  // Relaxation control (#3510): the recorded last measurement the localization
  // numbers are anchored to. Structural problems here are exit-2 errors —
  // a budget without a coherent baseline cannot gate localization at all.
  const baseline = budget.localizationBaseline;
  if (!args.measureOnly) {
    if (baseline == null || typeof baseline !== 'object' || Array.isArray(baseline)) {
      die(
        `budget ${args.budget} is missing localizationBaseline — the recorded ` +
          'measurement (recallPct, topKPct, rankingCodeSha256, date) the ' +
          'localization gate anchors to (#3510). Bootstrap it from ' +
          '--measure-only, which prints a ready-to-paste candidate.',
      );
    }
    if (!Number.isFinite(baseline.recallPct)) {
      die('localizationBaseline.recallPct must be a number (the measured recall).');
    }
    if (!Number.isFinite(baseline.topKPct)) {
      die('localizationBaseline.topKPct must be a number (the slice the measurement used).');
    }
    if (typeof baseline.rankingCodeSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(baseline.rankingCodeSha256)) {
      die('localizationBaseline.rankingCodeSha256 must be the 64-hex sha256 printed by --measure-only.');
    }
    if (typeof baseline.date !== 'string' || baseline.date.trim() === '') {
      die('localizationBaseline.date must record when the baseline was measured.');
    }
    if (baseline.topKPct !== topKPct) {
      die(
        `localizationTopKPct (${topKPct}) does not match localizationBaseline.topKPct ` +
          `(${baseline.topKPct}). Changing the slice fraction re-defines the metric, so it ` +
          'must be re-measured and re-recorded in the same commit — recall@K is monotonic ' +
          'in K, so a wider slice records a HIGHER baseline and raises the future bar ' +
          'rather than buying slack (#3510).',
      );
    }
    if (baseline.rankingCodeSha256 !== surfaceSha) {
      die(
        `the ranking surface changed but localizationBaseline was not re-recorded. ` +
          `Recorded sha ${baseline.rankingCodeSha256.slice(0, 12)}…, actual ${surfaceSha.slice(0, 12)}… ` +
          `over [${RANKING_SURFACE.join(', ')}]. A ranking/extraction change must carry its ` +
          'measured before/after in the same commit: run --measure-only and update ' +
          'localizationBaseline (recallPct, rankingCodeSha256, date) alongside the code (#3510).',
      );
    }
    if (budget.localizationRecallMinPct < baseline.recallPct - FLOOR_MAX_SLACK_PCT) {
      die(
        `localizationRecallMinPct (${budget.localizationRecallMinPct}) sits more than ` +
          `${FLOOR_MAX_SLACK_PCT} points below the recorded baseline (${baseline.recallPct}). ` +
          'A floor detached from the last measurement is not a safety margin, it is the ' +
          'ratchet #3471 documents. Keep it within the slack band.',
      );
    }
  }

  // Cross-commit relaxation checks (#3510, review findings 1-2): compare this
  // budget's localization keys against the committed prior at the trust anchor.
  // The in-file checks above are stateless, so a PAIRED edit (baseline+floor
  // lowered together, or topKPct widened in both places with a stale recorded
  // value) satisfies all of them — only a diff against a copy the working tree
  // cannot rewrite closes that. Note: `baseline.denominator` / `rankedFiles`
  // are informational provenance, deliberately not validated here or above.
  let crossCommitNote = null;
  if (!args.measureOnly) {
    const measuredRecall = +probe.recallPct.toFixed(1);
    const prior = priorLocalizationBudget(args.budget);
    if (prior.error) die(`relaxation anchor: ${prior.error}`);
    if (!prior.available) {
      crossCommitNote = `cross-commit relaxation checks SKIPPED: ${prior.reason}`;
    } else {
      const pb = prior.budget.localizationBaseline;
      const priorFloor = prior.budget.localizationRecallMinPct;
      if (pb == null || !Number.isFinite(pb.recallPct) || !Number.isFinite(pb.topKPct) || !Number.isFinite(priorFloor)) {
        crossCommitNote =
          `cross-commit relaxation checks SKIPPED: prior budget at ${prior.ref} ` +
          'predates the baseline contract (introduction commit)';
      } else {
        // "Fresh" = the recorded value matches what THIS run just measured,
        // within the down tolerance. Reality is the one thing a JSON edit
        // cannot move, which is what makes this the justification token.
        const fresh = Math.abs(measuredRecall - baseline.recallPct) <= BASELINE_DOWN_TOLERANCE_PCT;
        const topKMoved = topKPct !== pb.topKPct;
        const loweredBaseline = baseline.recallPct < pb.recallPct;
        const floorDrop = priorFloor - budget.localizationRecallMinPct;
        if (topKMoved && !fresh) {
          die(
            `localizationTopKPct moved ${pb.topKPct} -> ${topKPct} relative to ${prior.ref}, but ` +
              `localizationBaseline.recallPct (${baseline.recallPct}) does not match the freshly ` +
              `measured ${measuredRecall} within ±${BASELINE_DOWN_TOLERANCE_PCT}. Changing the slice ` +
              'must RECORD the fresh measurement at the new K in the same commit (run --measure-only ' +
              'and paste the candidate) — a stale recorded value under a wider K buys regression ' +
              'slack (#3510).',
          );
        }
        if (loweredBaseline && !fresh) {
          die(
            `localizationBaseline.recallPct lowered ${pb.recallPct} -> ${baseline.recallPct} relative ` +
              `to ${prior.ref} without matching the freshly measured ${measuredRecall} within ` +
              `±${BASELINE_DOWN_TOLERANCE_PCT}. A downward re-baseline must record the fresh ` +
              'measurement in the same commit; it cannot be dialed to buy regression room (#3510).',
          );
        }
        if (floorDrop > 0) {
          const baselineDrop = Math.max(0, pb.recallPct - baseline.recallPct);
          // 1e-9 guards float noise on equal-distance moves (e.g. 8.7 - 6.7).
          if (floorDrop > baselineDrop + 1e-9) {
            die(
              `localizationRecallMinPct lowered ${priorFloor} -> ${budget.localizationRecallMinPct} ` +
                `relative to ${prior.ref} — a drop of ${+floorDrop.toFixed(1)}, more than the recorded ` +
                `baseline moved (${+baselineDrop.toFixed(1)}). The floor may follow a fresh downward ` +
                're-baseline by at most the same distance; it never moves on its own (#3510).',
            );
          }
        }
        if (loweredBaseline || topKMoved || floorDrop > 0) {
          crossCommitNote =
            `accepted re-baseline vs ${prior.ref}: recallPct ${pb.recallPct} -> ${baseline.recallPct}` +
            `${topKMoved ? `, topKPct ${pb.topKPct} -> ${topKPct}` : ''}` +
            `${floorDrop > 0 ? `, floor ${priorFloor} -> ${budget.localizationRecallMinPct}` : ''}` +
            ' (fresh measurement match)';
        }
      }
    }
  }

  const metrics = {
    datasetPayloadBytes,
    unboundedPayloadBytes,
    retainedFiles: persisted.map.files.length,
    retainedFilesPct: +retainedFilesPct.toFixed(1),
    maxPersistedBytes,
    coldIngestMs: +coldIngestMs.toFixed(1),
    localizationEvaluable: probe.evaluable,
    localizationRecallPct: probe.evaluable ? +probe.recallPct.toFixed(1) : null,
    localizationTopKPct: topKPct,
    localizationTopK: probe.topK,
    localizationHits: probe.hits,
    localizationDenominator: probe.denominator,
    rankingSurfaceSha256: surfaceSha,
    rereadWasteTokensSaved: rereadWasteTokensSaved(map),
    fileCount: map.fileCount,
    sizeBounded: persisted.sizeBounded,
    droppedFiles: persisted.droppedFiles,
  };

  // Gate checks: max-ceilings for cost/payload, min-floors for the value metrics.
  // `required` is load-bearing (#3452): a missing or misspelled budget key used
  // to make its check silently pass and print "(no budget)" — the same
  // cannot-fail failure mode this file is being repaired for. All four are
  // mandatory, so an absent bound is an ERROR, not a free pass.
  const checks = [
    { name: 'payload (unbounded)', actual: metrics.unboundedPayloadBytes, bound: budget.unboundedPayloadMaxBytes, dir: 'max', unit: 'B', required: true },
    // Absolute COUNT, deliberately not a percentage. Retained-SHARE falls with
    // repo growth BY CONSTRUCTION — the byte ceiling is fixed, so the same
    // artifact covers a smaller fraction of a bigger tree — which would make a
    // percentage floor a self-lowering ratchet needing periodic renegotiation
    // with no regression having occurred (the #3471 pathology).
    //
    // The count is MORE ROBUST, not immune. It is bounded by
    // maxPersistedBytes / average retained entry size, so it holds steady while
    // that average holds; a batch of high-ranking files with large entries can
    // displace several smaller ones and lower it without any per-file bloat.
    // What it does not do is drift downward merely because the tree got bigger.
    // The share is still reported for humans.
    { name: 'files retained', actual: metrics.retainedFiles, bound: budget.retainedFilesMin, dir: 'min', unit: 'files', required: true },
    { name: 'cold ingest', actual: metrics.coldIngestMs, bound: budget.coldIngestMaxMs, dir: 'max', unit: 'ms', required: true },
    { name: 'localization recall', actual: metrics.localizationRecallPct, bound: budget.localizationRecallMinPct, dir: 'min', unit: '%', required: true },
    { name: 'reread tokens saved', actual: metrics.rereadWasteTokensSaved, bound: budget.rereadTokensSavedMin, dir: 'min', unit: 'tok', required: true },
  ];

  if (!probe.evaluable) {
    // Only reachable under --measure-only (gating mode died above): drop the
    // recall row rather than compare null against a floor.
    for (let i = checks.length - 1; i >= 0; i--) {
      if (checks[i].name.startsWith('localization')) checks.splice(i, 1);
    }
  } else if (baseline != null && Number.isFinite(baseline.recallPct)) {
    // #3510: the recorded-measurement anchor, enforced BOTH ways so the
    // baseline cannot quietly detach from reality in either direction. A drop
    // past DOWN is a regression of the measured metric — the HASHED ranking
    // surface is unchanged (the sha check passed above), though the hash does
    // not cover the grammar binary, and honest composition drift (many
    // added/removed leaf files) can also land here; the sanctioned response to
    // a verified composition drop is a fresh downward re-baseline, which the
    // cross-commit checks verify against reality. A rise past UP means the
    // recorded baseline is stale or was sandbagged low — ratchet it up to the
    // measured value, so future regressions are judged from reality.
    checks.push(
      {
        name: 'recall vs baseline',
        actual: metrics.localizationRecallPct,
        bound: +(baseline.recallPct - BASELINE_DOWN_TOLERANCE_PCT).toFixed(1),
        dir: 'min',
        unit: '%',
        required: true,
      },
      {
        name: 'baseline freshness',
        actual: metrics.localizationRecallPct,
        bound: +(baseline.recallPct + BASELINE_UP_TOLERANCE_PCT).toFixed(1),
        dir: 'max',
        unit: '%',
        required: true,
      },
    );
  }

  // In GATING mode a missing bound is fatal. `--measure-only` is exempt so a
  // new budget file can be bootstrapped from a measurement run — it cannot
  // silently pass a gate because it does not gate at all.
  const missing = checks
    .filter((c) => c.required && !Number.isFinite(c.bound))
    .map((c) => c.name);
  if (missing.length > 0 && !args.measureOnly) {
    die(
      `budget ${args.budget} is missing a numeric bound for: ${missing.join(', ')}. ` +
        'Every check here is mandatory — a missing key must not silently pass.',
    );
  }

  console.log(`\nRepo-map measurement gates — root ${args.root}`);
  console.log(`  (${metrics.fileCount} files, sha ${gitSha ?? 'none'}${metrics.sizeBounded ? `, size-bounded: dropped ${metrics.droppedFiles}` : ''})\n`);
  // Reported, never gated: this value is clamped to `maxPersistedBytes` by
  // construction, so any budget on it would be a tautology (#3452).
  console.log(
    `  · REPORT persisted payload      ${String(metrics.datasetPayloadBytes).padStart(12)} B   ` +
      `/ clamped to ${maxPersistedBytes} B (not gated — clamped value)`,
  );
  console.log(
    `  · REPORT files retained         ${String(metrics.retainedFiles).padStart(12)}     ` +
      `/ of ${map.files.length} ranked (${metrics.retainedFilesPct}% — accepted head-of-ranking index, ADR 0020 / #3475)`,
  );
  console.log(`  · REPORT ranking surface sha256 ${surfaceSha}`);
  if (probe.evaluable) {
    console.log(
      `  · REPORT localization probe     ${String(`${probe.hits}/${probe.denominator}`).padStart(12)}     ` +
        `edges hit @ top-${probe.topK} (${topKPct}% of ${map.files.length} ranked)`,
    );
  } else {
    console.log(
      '  · REPORT localization probe     not evaluable (no resolvable intra-repo imports)',
    );
  }
  if (crossCommitNote) console.log(`  · NOTE ${crossCommitNote}`);
  const failures = [];
  for (const c of checks) {
    // A null bound only ever reaches here under --measure-only (gating mode
    // died above), so it can never silently pass a real gate.
    const unbudgeted = !Number.isFinite(c.bound);
    const ok = unbudgeted || (c.dir === 'max' ? c.actual <= c.bound : c.actual >= c.bound);
    const mark = unbudgeted ? '·' : ok ? '✓' : '✗';
    const boundStr = unbudgeted
      ? '(no budget — measure-only)'
      : `${c.dir === 'max' ? '<=' : '>='} ${c.bound} ${c.unit}`;
    console.log(`  ${mark} ${c.name.padEnd(22)} ${String(c.actual).padStart(12)} ${c.unit.padEnd(3)} / budget ${boundStr}`);
    if (!ok) failures.push(`${c.name} ${c.actual} ${c.unit} fails budget ${boundStr}`);
  }

  if (args.json) {
    writeFileSync(args.json, JSON.stringify(metrics, null, 2));
    console.log(`\nwrote metrics -> ${args.json}`);
  }

  if (args.measureOnly) {
    if (probe.evaluable) {
      // Bootstrap / re-baseline path (#3510): the exact object a legitimate
      // relaxation records in the same commit as its ranking change.
      console.log(
        '\nlocalization baseline candidate (repo-map-budget.json "localizationBaseline"):',
      );
      console.log(
        `  ${JSON.stringify({
          recallPct: metrics.localizationRecallPct,
          topKPct,
          denominator: probe.denominator,
          rankedFiles: map.files.length,
          rankingCodeSha256: surfaceSha,
          date: new Date().toISOString().slice(0, 10),
        })}`,
      );
    }
    console.log('\n(measure-only: not gating)\n');
    return;
  }

  if (failures.length > 0) {
    console.error('\n✗ Repo-map gate BLOCKED:');
    for (const f of failures) console.error(`  - ${f}`);
    if (failures.some((f) => f.includes('baseline'))) {
      console.error(
        '\nBaseline failures follow the #3510 contract. A recall DROP while the ' +
          'hashed ranking surface is unchanged is either a ranking-adjacent ' +
          'regression (fix it) or honest composition drift from many added/removed ' +
          'files. The sanctioned response to a VERIFIED composition drop is a fresh ' +
          'downward re-baseline: re-record localizationBaseline.recallPct at the ' +
          "--measure-only value with today's date in the same commit — the gate " +
          'verifies the fresh match against the prior at origin/master, and the ' +
          'floor may follow by at most the same distance. A value far ABOVE the ' +
          'recorded baseline means the record is stale: ratchet ' +
          'localizationBaseline.recallPct UP to the measured value. See ' +
          'docs/perf-sprint/repo-map.md.',
      );
    }
    console.error(
      '\nIf the change is a real win (a denser map, a legitimately larger root), ' +
        'raise the relevant ceiling/floor in repo-map-budget.json with a note on ' +
        'why. Otherwise, trim the regression.\n',
    );
    process.exit(1);
  }

  console.log('\n✓ Repo-map gate PASSED: all metrics within budget.\n');
}

main().catch((err) => die(err?.stack || String(err)));
