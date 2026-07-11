/**
 * Parser for the shadow-calls experiment ledger (epic #513, slices #518/#523).
 *
 * The shadow-calls engine (tooling under `~/.claude/shadow-calls/`) runs the same task
 * two ways — Main vs one rotated-axis Shadow — and appends one JSON record per experiment
 * to `~/.claude/shadow-calls/ledger.jsonl`. This parser aggregates that ledger per AXIS so
 * the `workflow.shadow-axis-wins` detector can recommend adopting axes that consistently
 * win, **weighting live evidence above replay** (replay carries cold-start + staleness
 * caveats — see the epic).
 *
 * Pure + text-in (mirrors the other `parse-*.ts`): `parseShadowCalls(jsonlText)`. A
 * missing/empty ledger yields a zeroed aggregate, so the detector simply emits nothing.
 *
 * Counting transparency (#2149): every non-empty ledger line lands in EXACTLY one bucket,
 * surfaced on the aggregate so nothing is silently dropped or merged into a lossy `total`:
 *   - `counted`   — real experiments: a valid `axis` AND a valid `mode` (`live`|`replay`).
 *                   ONLY these feed `byAxis` + the detectors, and split into `live`/`replay`.
 *   - `synthetic` — `synthetic: true` rows (below).
 *   - `skipped`   — everything else: `replay-skip`/bad-or-missing mode, no axis, malformed JSON.
 * The invariant `counted + synthetic + skipped === total` (and `live + replay === counted`)
 * holds line-for-line, so a viewer can reconcile the headline against the raw ledger size.
 *
 * Records flagged `synthetic: true` (hand-seeded demo/batch rows, #570) are excluded from
 * `counted`/`byAxis` — they carry no real source task, so counting them would inflate an
 * axis's `samples`/`shadowWins` and skew the recommendation confidence with fabricated
 * evidence — but are now surfaced in `synthetic` rather than dropped invisibly (#2149).
 *
 * Source taxonomy (#2150, epic #2147): every counted record is classified into a
 * first-class `source` (provenance) dimension and aggregated uniformly per
 * (source, axis) cell in `bySourceAxis` — so per-window replays, model-eval batches,
 * proof-batch runs, live `/race` arms, and config-scoping all report through ONE path
 * and a new experiment kind needs no bespoke aggregate field. See
 * {@link classifyExperimentSource} for the classification rule.
 *
 * Record shape (subset we read; see ~/.claude/shadow-calls/SCHEMA.md for the full union):
 *   { mode: 'live'|'replay', axis: string, synthetic?: boolean, source?: string,
 *     judge?: { winner?: 'main'|'shadow'|'tie' },
 *     main?: { tokens?: number }, shadow?: { tokens?: number } }
 */

export interface AxisAggregate {
  axis: string;
  samples: number;
  live: number;
  replay: number;
  shadowWins: number;
  mainWins: number;
  ties: number;
  /** Shadow wins seen under the higher-trust LIVE mode (drives confidence). */
  liveShadowWins: number;
  /** Σ(shadow.tokens − main.tokens) over records where both are known (negative ⇒ cheaper). */
  tokenDeltaSum: number;
  tokenDeltaCount: number;
  /**
   * Σ(shadow.costUsd − main.costUsd) over records where both run costs are known (#536).
   * Price-aware: a cheaper-tier model that used more tokens can still be cheaper in $.
   * Preferred over the raw-token delta when available.
   */
  costDeltaSum: number;
  costDeltaCount: number;
  /**
   * Σ of the judge's per-task adherence-regression counts over records that carried the
   * dimension (#1269/#1270, epic #1264). Written by the `config-scoping` judge: how many
   * rules that demonstrably applied under the monolith control failed to fire under the
   * atomized variation. 0 across full coverage ⇒ the variation dropped nothing.
   */
  adherenceRegressionSum: number;
  /**
   * How many of this axis's records carried the adherence-regression dimension. The
   * graduation gate (#1270) requires FULL coverage (`count === samples`) before it will
   * certify "zero regression" — absent/partial adherence data fails closed.
   */
  adherenceRegressionCount: number;
  /**
   * Per-finding sub-aggregate, populated ONLY for the `recs` axis (#579, ADR 0005 Tier 2).
   * Keyed by `record.recs.findingId`; undefined for every other axis. Mirrors the per-axis
   * verdict counters so a single finding can be evaluated in isolation ("finding F changed
   * behaviour in K/N replays") while the per-axis totals stay byte-identical.
   */
  byFinding?: Record<string, RecsFindingAggregate>;
  /**
   * Atomic-vs-monolith verdict sub-aggregate (#1663, epic #1264). Lifted from each
   * record's top-level `configScoping` triple (SCHEMA.md, #1662): monolith = MAIN arm,
   * atomized = SHADOW arm. Populated for any axis whose records carry the triple —
   * gated on the BLOCK's presence, not the axis name (#2150) — which in practice is
   * only the `config-scoping` runner. Absent when no record carried the triple, so the
   * detector degrades to its existing per-axis behaviour. Data-driven: only sums/counts
   * what the records actually contain — never fabricates a delta.
   */
  configScoping?: ConfigScopingAggregate;
}

/**
 * Per-arm speed/cost/accuracy roll-up for the `config-scoping` axis (#1663). Each metric
 * carries the monolith (MAIN) and atomized (SHADOW) running sums plus how many records
 * supplied them, so the detector can render a mean per-run delta and a win tally without
 * re-deriving anything from the run/judge blocks (the #1662 record already did that work).
 * monolith = MAIN arm, atomized = SHADOW arm.
 */
export interface ConfigScopingAggregate {
  /** Wall-time (ms): lower wins. */
  speed: ConfigScopingMetric;
  /** Tokens + price-aware $: lower wins. */
  cost: ConfigScopingCostMetric;
  /** Build/test/lint gate winner + #61 adherence-regression score (10 = none dropped). */
  accuracy: ConfigScopingAccuracy;
}

interface ConfigScopingWins {
  /** Records whose per-metric winner was the monolith (MAIN) arm. */
  monolithWins: number;
  /** Records whose per-metric winner was the atomized (SHADOW) arm. */
  atomizedWins: number;
  /** Records whose per-metric winner was a tie. */
  ties: number;
}

export interface ConfigScopingMetric extends ConfigScopingWins {
  /** Σ monolith (MAIN) wall-time over records that carried it. */
  monolithSum: number;
  /** Σ atomized (SHADOW) wall-time over records that carried it. */
  atomizedSum: number;
  /** Records that supplied BOTH arms (so a per-run delta is meaningful). */
  pairedCount: number;
}

export interface ConfigScopingCostMetric extends ConfigScopingWins {
  monolithTokenSum: number;
  atomizedTokenSum: number;
  tokenPairedCount: number;
  monolithCostUsdSum: number;
  atomizedCostUsdSum: number;
  costPairedCount: number;
}

export interface ConfigScopingAccuracy {
  /** Gate (build/test/lint) winner tally across records that carried one. */
  gate: ConfigScopingWins;
  /** Σ #61 adherence-regression score per arm (higher = more rules still honored). */
  monolithAdherenceSum: number;
  atomizedAdherenceSum: number;
  adherencePairedCount: number;
}

/**
 * Per-finding counters for the `recs` axis (#579). Mirrors the subset of `AxisAggregate`
 * that drives a verdict — wins/losses/ties plus the live/replay split — bucketed by the
 * finding a recs shadow was injecting (`record.recs.findingId`).
 */
export interface RecsFindingAggregate {
  findingId: string;
  samples: number;
  shadowWins: number;
  mainWins: number;
  ties: number;
  live: number;
  replay: number;
}

/**
 * The known experiment sources (#2150). This is the documented taxonomy, NOT an
 * enum lockout: {@link classifyExperimentSource} passes an explicit `source` stamp
 * through verbatim, so a new experiment kind starts reporting the moment its writer
 * stamps records — no parser change, no new aggregate field.
 *   - `live`           — organic rotation shadow fired alongside real work (unstamped fallback)
 *   - `replay`         — idle-window replay of a past task (unstamped fallback)
 *   - `race-live`      — live `/race` run (explicit stamp, or unstamped fallback: the
 *                        record carries `raceGoal`, which only the race writer emits —
 *                        `finalizeRace` predates source stamping, #2151)
 *   - `model-eval`     — model-eval batch runner (explicit stamp, #2138)
 *   - `proof`          — proof-batch runner (explicit stamp)
 *   - `config-scoping` — atomic-vs-monolith config experiment (its runner predates
 *                        source stamping, so unstamped rows on that axis classify here)
 */
export const KNOWN_EXPERIMENT_SOURCES = [
  'live',
  'replay',
  'race-live',
  'model-eval',
  'proof',
  'config-scoping',
] as const;

/**
 * Classify one ledger record into its experiment source (#2150). An explicit
 * `source` stamp always wins (free-form tolerant — see
 * {@link KNOWN_EXPERIMENT_SOURCES}); unstamped records fall back to the taxonomy
 * rule: config-scoping-axis rows were written by that dedicated runner before
 * stamping existed, everything else is the organic engine, split by `mode`.
 */
export function classifyExperimentSource(rec: {
  source?: unknown;
  axis?: unknown;
  mode?: unknown;
  raceGoal?: unknown;
}): string {
  if (typeof rec.source === 'string' && rec.source.trim()) {
    // Free-form tolerant but bounded: a runaway writer must not mint
    // arbitrarily long aggregation keys.
    return rec.source.trim().slice(0, 64);
  }
  // Only the race writer (`finalizeRace`) emits `raceGoal`, and it predates
  // source stamping — so an unstamped row carrying it is a live `/race` (#2151).
  if (typeof rec.raceGoal === 'string' && rec.raceGoal.trim()) return 'race-live';
  if (rec.axis === 'config-scoping') return 'config-scoping';
  return rec.mode === 'replay' ? 'replay' : 'live';
}

/**
 * Sources whose `mode:'live'` rows may increment `liveShadowWins` — the counter
 * that lifts the shadow-axis-wins recommendation from info to warning (#2151).
 * Organic rotation shadows and `/race` runs are real, in-the-loop experiments;
 * everything else (model-eval batches, proof-batch, config-scoping, unknown
 * future writers) is batch/benchmark-tier evidence that must never buy live
 * trust just by stamping `mode:'live'` — it still counts toward samples/wins,
 * but caps at replay-tier confidence.
 */
export const LIVE_TRUST_SOURCES: ReadonlySet<string> = new Set(['live', 'race-live']);

/**
 * Cardinality bound on the (source, axis) cells (#2150): a buggy writer that
 * stamps a per-run unique `source` (a uuid, a timestamp) must not mint one
 * aggregate cell per ledger row. Past the cap, new sources fold into
 * `(other)` so totals still reconcile — bounded, never silently dropped.
 */
export const MAX_SOURCE_AXIS_CELLS = 100;

/**
 * The ONE statement of the #2149 counting rule, shared by the aggregate parser
 * here and the per-row log parser (`shadow-experiments.ts`) so the drill-down
 * log can never silently disagree with the headline about which rows count.
 */
export function classifyShadowRecord(rec: {
  synthetic?: unknown;
  axis?: unknown;
  mode?: unknown;
}): {
  axis: string | null;
  mode: 'live' | 'replay' | null;
  disposition: 'counted' | 'synthetic' | 'skipped';
  skipReason: 'no-axis' | 'bad-mode' | null;
} {
  const axis = typeof rec.axis === 'string' ? rec.axis : null;
  const mode = rec.mode === 'live' || rec.mode === 'replay' ? rec.mode : null;
  if (rec.synthetic === true) return { axis, mode, disposition: 'synthetic', skipReason: null };
  if (!axis) return { axis, mode, disposition: 'skipped', skipReason: 'no-axis' };
  if (!mode) return { axis, mode, disposition: 'skipped', skipReason: 'bad-mode' };
  return { axis, mode, disposition: 'counted', skipReason: null };
}

/**
 * One (source, axis) cell of the uniform provenance aggregate (#2150). Every
 * experiment kind — replay, race, model-eval, proof, config-scoping, anything
 * future writers stamp — reports through this SAME shape, so no source ever
 * needs a bespoke bolt-on aggregate field again.
 */
export interface SourceAxisAggregate {
  source: string;
  axis: string;
  samples: number;
  live: number;
  replay: number;
  shadowWins: number;
  mainWins: number;
  ties: number;
  /** Σ(shadow.tokens − main.tokens) over records where both are known. */
  tokenDeltaSum: number;
  tokenDeltaCount: number;
  /** Σ(shadow.costUsd − main.costUsd) over records where both are known (#536). */
  costDeltaSum: number;
  costDeltaCount: number;
}

export interface ShadowCallAggregate {
  /**
   * Every non-empty ledger line, whatever its disposition — the honest ledger size.
   * The exclusion buckets are surfaced explicitly (#2149) so the number a viewer reads
   * equals what actually ran: `counted + synthetic + skipped === total` (no line silently
   * dropped/merged) and `live + replay === counted`.
   */
  total: number;
  /**
   * Real experiments: a line with a valid `axis` AND a valid `mode` (`live`|`replay`).
   * ONLY these feed `byAxis` and the detectors — this is the number the old lossy `total`
   * reported (the headline "Experiments (real)").
   */
  counted: number;
  /** `synthetic: true` seed/demo rows (#570): real-shaped but no source task, so excluded from `counted`. */
  synthetic: number;
  /** Lines dropped for any other reason: `replay-skip`/bad-or-missing mode, no axis, or malformed JSON. */
  skipped: number;
  /** `counted` rows that ran in `live` mode. */
  live: number;
  /** `counted` rows that ran in `replay` mode. */
  replay: number;
  byAxis: AxisAggregate[];
  /**
   * Uniform (source, axis) provenance cells (#2150) — the one path every
   * experiment kind reports through. Sorted by (source, axis) so the detector +
   * ETag stay stable. Ledger-derived cells sum to `counted`; artifact-derived
   * cells (proof receipts, model-eval batches — merged in by
   * {@link mergeExternalSourceCells}, #2151) sum to `external`, so the full
   * reconciliation is `Σ cells.samples === counted + (external ?? 0)`.
   */
  bySourceAxis: SourceAxisAggregate[];
  /**
   * Samples contributed by artifact-derived cells (#2151): experiments whose
   * records live OUTSIDE the ledger (proof receipts in `data/proof-receipts.jsonl`,
   * model-eval result artifacts). Kept separate from `counted` so the #2149
   * line-for-line ledger reconciliation (`counted + synthetic + skipped === total`)
   * still holds against the raw ledger. Absent (never 0) when no external
   * source contributed.
   */
  external?: number;
  /**
   * True when the ledger exceeded the artifact byte cap and only its newest tail
   * was parsed (#2152): the counts above then cover a SUFFIX of the ledger, not
   * all of it. Set by the reader (the parser itself is pure text-in), absent
   * (never false) otherwise, and surfaced by every consumer — a capped ledger
   * must read as "truncated", not as a smaller corpus.
   */
  truncated?: boolean;
}

interface ShadowRecord {
  mode?: unknown;
  axis?: unknown;
  synthetic?: unknown;
  /** Explicit experiment-source stamp (#2150); absent on rows from older writers. */
  source?: unknown;
  /** Race-writer-only field (`finalizeRace`) — the unstamped race-live signature (#2151). */
  raceGoal?: unknown;
  judge?: { winner?: unknown; adherenceRegressions?: unknown } | null;
  main?: { tokens?: unknown; costUsd?: unknown } | null;
  shadow?: { tokens?: unknown; costUsd?: unknown } | null;
  /** Recs-axis-only block written by the replay runner (`recsRecordFields()`). */
  recs?: {
    findingId?: unknown;
    treatment?: unknown;
    paraphraseOverlap?: unknown;
    redundant?: unknown;
  } | null;
  /**
   * config-scoping-axis-only verdict triple, emitted by `finalizeRecord` for that axis only
   * (#1662, SCHEMA.md). All sub-fields are individually optional, so a record may carry a
   * partial triple; we sum/count whatever is a finite number and tally winners that name an
   * arm. monolith = MAIN, atomized = SHADOW.
   */
  configScoping?: {
    speed?: { monolithWallMs?: unknown; atomizedWallMs?: unknown; winner?: unknown } | null;
    cost?: {
      monolithTokens?: unknown;
      atomizedTokens?: unknown;
      monolithCostUsd?: unknown;
      atomizedCostUsd?: unknown;
      winner?: unknown;
    } | null;
    accuracy?: {
      gateWinner?: unknown;
      monolithAdherence?: unknown;
      atomizedAdherence?: unknown;
    } | null;
  } | null;
}

function emptyFinding(findingId: string): RecsFindingAggregate {
  return {
    findingId,
    samples: 0,
    shadowWins: 0,
    mainWins: 0,
    ties: 0,
    live: 0,
    replay: 0,
  };
}

function emptyConfigScoping(): ConfigScopingAggregate {
  return {
    speed: {
      monolithSum: 0,
      atomizedSum: 0,
      pairedCount: 0,
      monolithWins: 0,
      atomizedWins: 0,
      ties: 0,
    },
    cost: {
      monolithTokenSum: 0,
      atomizedTokenSum: 0,
      tokenPairedCount: 0,
      monolithCostUsdSum: 0,
      atomizedCostUsdSum: 0,
      costPairedCount: 0,
      monolithWins: 0,
      atomizedWins: 0,
      ties: 0,
    },
    accuracy: {
      gate: { monolithWins: 0, atomizedWins: 0, ties: 0 },
      monolithAdherenceSum: 0,
      atomizedAdherenceSum: 0,
      adherencePairedCount: 0,
    },
  };
}

/** A finite, non-negative number (the only shape we sum for a per-arm metric), else null. */
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Tally one config-scoping per-metric winner onto a wins block. */
function tallyWinner(w: ConfigScopingWins, winner: unknown): void {
  if (winner === 'monolith') w.monolithWins++;
  else if (winner === 'atomized') w.atomizedWins++;
  else if (winner === 'tie') w.ties++;
}

function emptyAxis(axis: string): AxisAggregate {
  return {
    axis,
    samples: 0,
    live: 0,
    replay: 0,
    shadowWins: 0,
    mainWins: 0,
    ties: 0,
    liveShadowWins: 0,
    tokenDeltaSum: 0,
    tokenDeltaCount: 0,
    costDeltaSum: 0,
    costDeltaCount: 0,
    adherenceRegressionSum: 0,
    adherenceRegressionCount: 0,
  };
}

function emptySourceAxis(source: string, axis: string): SourceAxisAggregate {
  return {
    source,
    axis,
    samples: 0,
    live: 0,
    replay: 0,
    shadowWins: 0,
    mainWins: 0,
    ties: 0,
    tokenDeltaSum: 0,
    tokenDeltaCount: 0,
    costDeltaSum: 0,
    costDeltaCount: 0,
  };
}

export function parseShadowCalls(
  jsonlText: string | null | undefined
): ShadowCallAggregate {
  const byAxis = new Map<string, AxisAggregate>();
  const bySourceAxis = new Map<string, SourceAxisAggregate>();
  // Explicit disposition buckets (#2149): total counts every non-empty line; each line
  // increments EXACTLY one of counted/synthetic/skipped, so nothing is silently dropped.
  let total = 0;
  let counted = 0;
  let synthetic = 0;
  let skipped = 0;
  let live = 0;
  let replay = 0;
  const empty: ShadowCallAggregate = {
    total: 0,
    counted: 0,
    synthetic: 0,
    skipped: 0,
    live: 0,
    replay: 0,
    byAxis: [],
    bySourceAxis: [],
  };
  if (!jsonlText) return empty;

  for (const line of jsonlText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    total++;
    let rec: ShadowRecord;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      // A line of valid-but-non-object JSON (`null`, `5`, `"x"`) is just as
      // malformed as unparseable text — without this guard a bare `null` line
      // would throw on the property reads below and sink the WHOLE parse.
      if (typeof parsed !== 'object' || parsed === null) {
        skipped++;
        continue;
      }
      rec = parsed as ShadowRecord;
    } catch {
      skipped++; // malformed JSON — surfaced in `skipped`, never dropped invisibly (#2149).
      continue;
    }
    // The shared #2149 counting rule: synthetic rows (#570) surface in
    // `synthetic` (real-shaped but no source task — counting them would
    // fabricate evidence); replay-skip / no-axis / bad-or-missing mode surface
    // in `skipped` (real work, no comparable verdict).
    const cls = classifyShadowRecord(rec);
    if (cls.disposition === 'synthetic') {
      synthetic++;
      continue;
    }
    if (cls.disposition === 'skipped') {
      skipped++;
      continue;
    }
    const axis = cls.axis!;
    const mode = cls.mode!;

    counted++;
    let a = byAxis.get(axis);
    if (!a) {
      a = emptyAxis(axis);
      byAxis.set(axis, a);
    }
    // Uniform provenance cell (#2150): the same counters, keyed (source, axis),
    // so every experiment kind reports through one path with no bespoke fields.
    // The raw (pre-cap) source also drives the live-trust gate below (#2151).
    const rawSource = classifyExperimentSource(rec);
    let source = rawSource;
    let cellKey = `${source}\u0000${axis}`;
    if (!bySourceAxis.has(cellKey) && bySourceAxis.size >= MAX_SOURCE_AXIS_CELLS) {
      source = '(other)';
      cellKey = `${source}\u0000${axis}`;
    }
    let cell = bySourceAxis.get(cellKey);
    if (!cell) {
      cell = emptySourceAxis(source, axis);
      bySourceAxis.set(cellKey, cell);
    }
    a.samples++;
    cell.samples++;
    if (mode === 'live') {
      a.live++;
      cell.live++;
      live++;
    } else {
      a.replay++;
      cell.replay++;
      replay++;
    }

    const winner = rec.judge?.winner;
    if (winner === 'shadow') {
      a.shadowWins++;
      cell.shadowWins++;
      // Live trust is gated on the SOURCE, not just the mode (#2151): a batch
      // writer stamping mode:'live' must not lift detector confidence.
      if (mode === 'live' && LIVE_TRUST_SOURCES.has(rawSource)) a.liveShadowWins++;
    } else if (winner === 'main') {
      a.mainWins++;
      cell.mainWins++;
    } else if (winner === 'tie') {
      a.ties++;
      cell.ties++;
    }

    // Per-task adherence-regression dimension (#1269/#1270): a distinct judged count the
    // `config-scoping` judge emits alongside the cost/speed verdict (NOT folded into it).
    // Aggregated wherever it appears so the graduation gate can require full coverage.
    const adherence = rec.judge?.adherenceRegressions;
    if (typeof adherence === 'number' && Number.isFinite(adherence) && adherence >= 0) {
      a.adherenceRegressionSum += adherence;
      a.adherenceRegressionCount++;
    }

    // Per-finding sub-aggregate, recs axis only (#579). Additive: reuses the same `winner`
    // mapping and the `synthetic:true` skip already applied to the per-axis totals above.
    if (axis === 'recs') {
      const findingId =
        rec.recs && typeof rec.recs.findingId === 'string' ? rec.recs.findingId : null;
      if (findingId) {
        if (!a.byFinding) a.byFinding = {};
        let f = a.byFinding[findingId];
        if (!f) {
          f = emptyFinding(findingId);
          a.byFinding[findingId] = f;
        }
        f.samples++;
        if (mode === 'live') f.live++;
        else f.replay++;
        if (winner === 'shadow') f.shadowWins++;
        else if (winner === 'main') f.mainWins++;
        else if (winner === 'tie') f.ties++;
      }
    }

    // Atomic-vs-monolith verdict triple (#1663). Additive: lifted verbatim from the
    // record's `configScoping` block (#1662) — we only sum finite numbers and tally
    // named-arm winners, so a partial/absent triple degrades gracefully. Gated on the
    // BLOCK's presence, not the axis name (#2150): only the config-scoping runner
    // writes the triple, so output is unchanged, but the parser no longer carries a
    // per-source axis-name branch.
    // Object-shape guard: a truthy non-object (`configScoping: true`) must not
    // attach a zeroed aggregate to the axis — the view picks its verdict card
    // by this field's presence, so garbage here would displace the real one.
    const cs = rec.configScoping;
    if (cs && typeof cs === 'object') {
      if (!a.configScoping) a.configScoping = emptyConfigScoping();
      const cfg = a.configScoping;

      const mWall = num(cs.speed?.monolithWallMs);
      const aWall = num(cs.speed?.atomizedWallMs);
      if (mWall !== null && aWall !== null) {
        cfg.speed.monolithSum += mWall;
        cfg.speed.atomizedSum += aWall;
        cfg.speed.pairedCount++;
      }
      tallyWinner(cfg.speed, cs.speed?.winner);

      const mTok = num(cs.cost?.monolithTokens);
      const aTok = num(cs.cost?.atomizedTokens);
      if (mTok !== null && aTok !== null) {
        cfg.cost.monolithTokenSum += mTok;
        cfg.cost.atomizedTokenSum += aTok;
        cfg.cost.tokenPairedCount++;
      }
      const mUsd = num(cs.cost?.monolithCostUsd);
      const aUsd = num(cs.cost?.atomizedCostUsd);
      if (mUsd !== null && aUsd !== null) {
        cfg.cost.monolithCostUsdSum += mUsd;
        cfg.cost.atomizedCostUsdSum += aUsd;
        cfg.cost.costPairedCount++;
      }
      tallyWinner(cfg.cost, cs.cost?.winner);

      tallyWinner(cfg.accuracy.gate, cs.accuracy?.gateWinner);
      const mAdh = num(cs.accuracy?.monolithAdherence);
      const aAdh = num(cs.accuracy?.atomizedAdherence);
      if (mAdh !== null && aAdh !== null) {
        cfg.accuracy.monolithAdherenceSum += mAdh;
        cfg.accuracy.atomizedAdherenceSum += aAdh;
        cfg.accuracy.adherencePairedCount++;
      }
    }

    const ms = rec.main?.tokens;
    const ss = rec.shadow?.tokens;
    if (typeof ms === 'number' && typeof ss === 'number') {
      a.tokenDeltaSum += ss - ms;
      a.tokenDeltaCount++;
      cell.tokenDeltaSum += ss - ms;
      cell.tokenDeltaCount++;
    }

    const mc = rec.main?.costUsd;
    const sc = rec.shadow?.costUsd;
    if (typeof mc === 'number' && typeof sc === 'number') {
      a.costDeltaSum += sc - mc;
      a.costDeltaCount++;
      cell.costDeltaSum += sc - mc;
      cell.costDeltaCount++;
    }
  }

  // Stable, deterministic order (by axis key / source+axis key) so the detector +
  // ETag stay stable.
  const sorted = [...byAxis.values()].sort((x, y) => x.axis.localeCompare(y.axis));
  const sortedCells = [...bySourceAxis.values()].sort(
    (x, y) => x.source.localeCompare(y.source) || x.axis.localeCompare(y.axis)
  );
  return {
    total,
    counted,
    synthetic,
    skipped,
    live,
    replay,
    byAxis: sorted,
    bySourceAxis: sortedCells,
  };
}

/** The paired-delta counters shared by AxisAggregate and SourceAxisAggregate (#2150). */
export interface PairedDeltas {
  tokenDeltaSum: number;
  tokenDeltaCount: number;
  costDeltaSum: number;
  costDeltaCount: number;
}

/** Mean token delta (shadow − main), or null when no paired token data. */
export function avgTokenDelta(a: PairedDeltas): number | null {
  return a.tokenDeltaCount > 0 ? a.tokenDeltaSum / a.tokenDeltaCount : null;
}

/** Mean $ cost delta (shadow − main), or null when no paired cost data (#536). */
export function avgCostDelta(a: PairedDeltas): number | null {
  return a.costDeltaCount > 0 ? a.costDeltaSum / a.costDeltaCount : null;
}

/**
 * Is the shadow variation cheaper for this axis? Price-aware ($) when available (#536),
 * else falls back to raw tokens. Returns null when neither signal is present.
 */
export function shadowCheaper(a: PairedDeltas): boolean | null {
  const cost = avgCostDelta(a);
  if (cost !== null) return cost < 0;
  const tok = avgTokenDelta(a);
  return tok !== null ? tok < 0 : null;
}

/**
 * Did this axis's variation provably drop NO instruction (#1270 hard gate)?
 *
 * - `true`  — every record carried the adherence-regression dimension AND all were 0.
 * - `false` — at least one judged regression (any nonzero count).
 * - `null`  — no adherence data, or only partial coverage: "zero regression" cannot be
 *   certified, so callers must treat this exactly like a failure (fail closed).
 */
export function adherenceClean(a: AxisAggregate): boolean | null {
  if (a.adherenceRegressionCount === 0) return null;
  if (a.adherenceRegressionSum > 0) return false;
  if (a.adherenceRegressionCount < a.samples) return null; // partial coverage — fail closed
  return true;
}

/**
 * Decided comparisons for a single recs finding: shadow wins + main wins, ties excluded
 * (parity with the per-axis decided rule, #545). #579 reuses this to gate its per-finding
 * efficacy verdict on a minimum number of decided samples.
 */
export function decidedForFinding(f: RecsFindingAggregate): number {
  return f.shadowWins + f.mainWins;
}

/** A signed mean per-run delta (atomized − monolith) over `count` paired records, or null. */
function meanDelta(monolithSum: number, atomizedSum: number, count: number): number | null {
  return count > 0 ? (atomizedSum - monolithSum) / count : null;
}

/** Mean per-run wall-time delta (atomized − monolith, ms); negative ⇒ atomized faster. */
export function configScopingSpeedDelta(a: AxisAggregate): number | null {
  const c = a.configScoping;
  return c ? meanDelta(c.speed.monolithSum, c.speed.atomizedSum, c.speed.pairedCount) : null;
}

/** Mean per-run token delta (atomized − monolith); negative ⇒ atomized leaner. */
export function configScopingTokenDelta(a: AxisAggregate): number | null {
  const c = a.configScoping;
  return c ? meanDelta(c.cost.monolithTokenSum, c.cost.atomizedTokenSum, c.cost.tokenPairedCount) : null;
}

/** Mean per-run $ delta (atomized − monolith); negative ⇒ atomized cheaper (#726 input). */
export function configScopingCostDelta(a: AxisAggregate): number | null {
  const c = a.configScoping;
  return c ? meanDelta(c.cost.monolithCostUsdSum, c.cost.atomizedCostUsdSum, c.cost.costPairedCount) : null;
}

/**
 * Subset of a PROOF receipt we read (#2151). Written by `scripts/proof-batch.mjs`
 * to `data/proof-receipts.jsonl` — one JSON line per finalized matched-pairs
 * experiment. `result.verdict` is proven|null|refuted; `perDimensionDeltas.costUsd`
 * is the median per-pair $ delta (injected − control; negative ⇒ injected cheaper),
 * which maps directly onto the aggregate's (shadow − main) delta convention
 * because the injected arm is the variation.
 */
interface ProofReceipt {
  kind?: unknown;
  observed?: { wastePattern?: unknown } | null;
  result?: {
    verdict?: unknown;
    perDimensionDeltas?: { costUsd?: unknown } | null;
  } | null;
}

/**
 * Fold `data/proof-receipts.jsonl` into (source, axis) provenance cells (#2151):
 * source `proof`, axis = the receipt's `observed.wastePattern` (what the
 * experiment was about), one SAMPLE per receipt. Verdict mapping: `proven` ⇒
 * shadow win (the injected variation demonstrably helped), `refuted` ⇒ main win,
 * `null` ⇒ tie. `live`/`replay` stay 0 — a batch proof run is neither, and per
 * {@link LIVE_TRUST_SOURCES} it can never buy live-tier detector confidence.
 * Pure text-in like the ledger parser; malformed or non-PROOF lines are counted
 * in `skipped`, never silently dropped (#2149 discipline).
 */
export function parseProofReceiptCells(jsonlText: string | null | undefined): {
  cells: SourceAxisAggregate[];
  receipts: number;
  skipped: number;
} {
  const byAxis = new Map<string, SourceAxisAggregate>();
  let receipts = 0;
  let skipped = 0;
  if (jsonlText) {
    for (const line of jsonlText.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let rec: ProofReceipt;
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (typeof parsed !== 'object' || parsed === null) {
          skipped++;
          continue;
        }
        rec = parsed as ProofReceipt;
      } catch {
        skipped++;
        continue;
      }
      if (rec.kind !== 'PROOF') {
        skipped++;
        continue;
      }
      const pattern = rec.observed?.wastePattern;
      const axis =
        typeof pattern === 'string' && pattern.trim() ? pattern.trim().slice(0, 64) : 'unknown';
      let cell = byAxis.get(axis);
      if (!cell) {
        cell = emptySourceAxis('proof', axis);
        byAxis.set(axis, cell);
      }
      receipts++;
      cell.samples++;
      const verdict = rec.result?.verdict;
      if (verdict === 'proven') cell.shadowWins++;
      else if (verdict === 'refuted') cell.mainWins++;
      else if (verdict === 'null') cell.ties++;
      const costUsd = num(rec.result?.perDimensionDeltas?.costUsd);
      if (costUsd !== null) {
        cell.costDeltaSum += costUsd;
        cell.costDeltaCount++;
      }
    }
  }
  const cells = [...byAxis.values()].sort((x, y) => x.axis.localeCompare(y.axis));
  return { cells, receipts, skipped };
}

/**
 * The model-eval provenance cell (#2151): volume + provenance ONLY. The
 * model-eval pipeline (#1085/#1242) already carries its own verdict surface —
 * per-model rollups, vetoes, and routing recommendations consumed by the
 * Model Evals view and the #2138 detectors — so re-deriving shadow-win verdicts
 * from those rollups here would fabricate a comparability the underlying runs
 * never measured (recs are auditable claims). The cell makes the batch volume
 * visible in the uniform (source, axis) surface; its verdicts stay where they
 * are attributable. Axis is `model`: a model eval is definitionally the model
 * axis. Returns null when there are no runs, so an absent pipeline adds nothing.
 */
export function modelEvalSourceCell(
  summary: { runCount?: number } | null | undefined
): SourceAxisAggregate | null {
  const runs = summary?.runCount;
  if (typeof runs !== 'number' || !Number.isFinite(runs) || runs <= 0) return null;
  const cell = emptySourceAxis('model-eval', 'model');
  cell.samples = Math.floor(runs);
  return cell;
}

/**
 * Merge artifact-derived provenance cells (proof receipts, model-eval batches)
 * into a ledger aggregate (#2151). Returns a NEW aggregate: `bySourceAxis` is
 * re-sorted with the extra cells appended and `external` carries their sample
 * sum, so the documented reconciliation `Σ cells.samples === counted + external`
 * holds and the #2149 ledger invariants (`counted + synthetic + skipped ===
 * total`) are untouched. A no-op (same aggregate back) for an empty cell list.
 */
export function mergeExternalSourceCells(
  agg: ShadowCallAggregate,
  cells: SourceAxisAggregate[]
): ShadowCallAggregate {
  if (cells.length === 0) return agg;
  const merged = [...agg.bySourceAxis, ...cells].sort(
    (x, y) => x.source.localeCompare(y.source) || x.axis.localeCompare(y.axis)
  );
  const external = (agg.external ?? 0) + cells.reduce((sum, c) => sum + c.samples, 0);
  return { ...agg, bySourceAxis: merged, external };
}

/**
 * Build the atomic-vs-monolith speed/cost/accuracy evidence rows for the config-scoping
 * axis (#1663). Pure + data-driven: emits ONE row per metric the records actually carried
 * (a paired delta or a non-empty winner tally), and an empty array when the axis carried no
 * triple — so the detector's evidence is unchanged for every other axis and degrades to its
 * existing rows when config-scoping has no verdict data. monolith = MAIN, atomized = SHADOW.
 */
export function configScopingEvidence(a: AxisAggregate): string[] {
  const c = a.configScoping;
  if (!c) return [];
  const rows: string[] = [];

  const winTally = (w: ConfigScopingWins): string =>
    `atomized ${w.atomizedWins} / monolith ${w.monolithWins} / tie ${w.ties}`;
  const hasWins = (w: ConfigScopingWins): boolean =>
    w.atomizedWins + w.monolithWins + w.ties > 0;

  // SPEED — mean per-run wall-time delta (atomized − monolith), ms.
  // Tie semantics match the verdict view (ShadowCallsPf): an exact-zero wall-time
  // delta and a sub-cent $ delta read as a tie, not "0ms faster"/"$0.00 cheaper"
  // — so the same datum renders consistently in the rec evidence and the UI (#2002).
  const speedDelta = configScopingSpeedDelta(a);
  if (speedDelta !== null) {
    const ms = Math.round(speedDelta);
    const phrase =
      ms === 0
        ? 'atomized and monolith tied on wall-time'
        : `atomized ${ms < 0 ? `${Math.abs(ms)}ms faster` : `${ms}ms slower`}`;
    rows.push(`config-scoping speed: ${phrase} per run on average (${winTally(c.speed)})`);
  } else if (hasWins(c.speed)) {
    rows.push(`config-scoping speed: ${winTally(c.speed)}`);
  }

  // COST — mean per-run $ delta preferred; raw-token delta when $ is absent (#726 path).
  const costDelta = configScopingCostDelta(a);
  const tokenDelta = configScopingTokenDelta(a);
  if (costDelta !== null) {
    const phrase =
      Math.abs(costDelta) < 0.005
        ? 'atomized and monolith tied on $'
        : `atomized $${Math.abs(costDelta).toFixed(2)} ${costDelta < 0 ? 'cheaper' : 'pricier'}`;
    rows.push(`config-scoping cost: ${phrase} per run on average (${winTally(c.cost)})`);
  } else if (tokenDelta !== null) {
    const tk = Math.round(tokenDelta);
    const phrase =
      tk === 0
        ? 'atomized and monolith tied on tokens'
        : `atomized ${Math.abs(tk)} ${tk < 0 ? 'fewer' : 'more'} tokens`;
    rows.push(`config-scoping cost: ${phrase} per run on average (${winTally(c.cost)})`);
  } else if (hasWins(c.cost)) {
    rows.push(`config-scoping cost: ${winTally(c.cost)}`);
  }

  // ACCURACY — gate winner tally + mean per-run #61 adherence (higher = fewer rules dropped).
  const acc = c.accuracy;
  const accParts: string[] = [];
  if (hasWins(acc.gate)) accParts.push(`gate ${winTally(acc.gate)}`);
  if (acc.adherencePairedCount > 0) {
    const mAdh = acc.monolithAdherenceSum / acc.adherencePairedCount;
    const aAdh = acc.atomizedAdherenceSum / acc.adherencePairedCount;
    accParts.push(`adherence atomized ${aAdh.toFixed(1)} vs monolith ${mAdh.toFixed(1)} (10 = no rule dropped)`);
  }
  if (accParts.length) rows.push(`config-scoping accuracy: ${accParts.join('; ')}`);

  return rows;
}
