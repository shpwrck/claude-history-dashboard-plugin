/**
 * Reclaim cascade — the "guarded-marginal" accounting model (epic #944, PR1).
 *
 * Background. The recommendations engine attaches a dollar figure
 * (`estSavingsUsd`) to its `cost`-category findings. Historically those figures
 * were summed blindly, which quadruple-counts a single priced pool whenever more
 * than one detector reasons about the same tokens (e.g. the one ~$5,449
 * cache-read pool seen through several parsers). #946 added a *dedup* rollup
 * keyed on a claim signature; this module replaces the dedup heuristic with the
 * real accounting model from `docs/v0.3-efficiency-accounting.md` §4.
 *
 * The model is a **sequential-residual cascade**:
 *
 *  1. Price a per-`(scopeKey, pool)` *residual matrix* from the actual token
 *     usage at each pool's `pricing.ts` rate (the same five-pool decomposition
 *     `entryCostAtModel` sums) — `billOriginal` is the sum of every cell.
 *  2. Apply each lever's counterfactual to the *running* residual in `orderKey`
 *     order, booking `marginal = max(0, billBefore − billAfter)` and decrementing
 *     the touched cells.
 *  3. Because each lever acts on a *smaller* residual than the last, overlapping
 *     levers carve disjoint slices and the identity
 *
 *         sum(marginal) ≡ billOriginal − billFinal
 *
 *     holds *by construction* — overflow (claiming more than the bill) is
 *     structurally impossible.
 *
 * Two guardrails are lifted from the design's rival models:
 *  - a global **`residual ≥ 0` invariant** — a counterfactual that would drive a
 *    cell negative is *rejected and logged*, never silently clamped; and
 *  - a **canonical `scopeKey` precondition** — a claim whose scope does not
 *    resolve to a real priced entry-group is rejected (it cannot book a marginal
 *    against tokens that aren't there).
 *
 * PR2 (#948) adds the **pure-label** extension on top of PR1's closed, cost-only
 * cascade: a finite {@link CauseKey} taxonomy, an **open** `leverId` string
 * convention (`${category}.${slug}`), the `flag-only` counterfactual sentinel
 * (books $0, mutates no residual, evidence only), and a per-lever / per-category
 * **coverage** breakdown. `category` and `cause` are *labels only* — they change
 * grouping/reporting and the cascade's *application order*, never the arithmetic
 * — so the identity `sum(marginal) ≡ billOriginal − billFinal` and the
 * `residual ≥ 0` invariant hold under any ordering, byte-for-byte as in PR1. The
 * contract reuses the existing {@link RecCategory} enum (no parallel enum); PR1
 * detectors that omit `cause` fall into the {@link DEFAULT_CAUSE} bucket and keep
 * compiling unchanged.
 */
import type { RecCategory } from './detectors/rec-enums';
import type { Recommendation } from './detectors/types';
import type { SessionTokenData, TokenEntry } from '../types';
import { getModelPricing } from './pricing';

/** The five priced token sub-pools `entryCostAtModel` sums. */
export type PoolId =
  | 'cacheRead'
  | 'cacheWrite5m'
  | 'cacheWrite1h'
  | 'output'
  | 'input';

/** Every priced token pool, in a stable order (matrix column order). */
export const POOL_IDS: readonly PoolId[] = [
  'input',
  'output',
  'cacheWrite5m',
  'cacheWrite1h',
  'cacheRead',
] as const;

/**
 * The finite **cause taxonomy** — *why* a lever's dollars are reclaimable. A
 * pure label (grouping/reporting + cascade ordering only): it never changes the
 * arithmetic, so the identity and `residual ≥ 0` invariant hold regardless of a
 * claim's cause. Per doc §4 the cascade is **cause-first**: a retried-turn prefix
 * re-read is *both* a reliability waste and prefix bloat over the same cache-read,
 * so the cause levers run *ahead* of the structural cost/context levers and each
 * marginal equals the counterfactual the user can independently act on.
 *
 *  - `failed-tool-retry` — tokens re-spent because a tool call failed and the
 *    turn (and its cache-read prefix) was replayed (reliability).
 *  - `safety-redo`       — tokens re-spent redoing work a guardrail/permission
 *    bounce forced (safety).
 *  - `workflow-rework`   — tokens re-spent on redundant reads / native-bypass /
 *    fan-out write→read churn the workflow could have avoided.
 *  - `activity-idle`     — spend attributable to idle/low-value activity.
 *  - `structural-prefix` — structural prefix/cache bloat (context); a pure
 *    re-pricing of how the context is laid out, not a behavioural redo.
 *  - `model-tier`        — over-tiered model spend (cost); right-size the model.
 *  - `unclassified`      — the {@link DEFAULT_CAUSE} bucket for a claim that
 *    names no cause (every PR1 claim, kept compiling unchanged).
 */
export type CauseKey =
  | 'failed-tool-retry'
  | 'safety-redo'
  | 'workflow-rework'
  | 'activity-idle'
  | 'structural-prefix'
  | 'model-tier'
  | 'unclassified';

/** The default cause for a claim that declares none (PR1 back-compat). */
export const DEFAULT_CAUSE: CauseKey = 'unclassified';

/**
 * Cause-first cascade ranking (doc §4 "ordering policy: cause-first, decided").
 *
 * The behavioural **causes** ([10,40)) run ahead of the **structural** cost /
 * context levers ([40,90)) so a redo's marginal isn't swallowed by the structure
 * that shares its tokens. Intra-cause is **deterministic-before-judge**:
 * reliability → safety-redo → workflow → activity. `unclassified` sorts last
 * within its band so a labelled claim never loses its slice to an unlabelled one.
 *
 * This rank is the **PRIMARY** cascade order: a behavioural cause books its
 * marginal ahead of a structural lever it shares tokens with EVEN when the
 * structural lever's `orderKey` is numerically lower. `orderKey` is the
 * *intra-cause* tiebreaker, not an override (the doc's contract sketch encodes
 * the cause band into the orderKey range, but the cause label is authoritative so
 * a detector that labels its cause correctly cannot accidentally lose cause-first
 * by mis-numbering its orderKey). The total is order-INVARIANT either way, so the
 * rank only sets each lever's attribution split — labels never move a dollar.
 */
const CAUSE_RANK: Record<CauseKey, number> = {
  // Behavioural causes — run first, on the larger residual.
  'failed-tool-retry': 10,
  'safety-redo': 20,
  'workflow-rework': 30,
  'activity-idle': 35,
  // Structural levers — run after the causes have carved their slices.
  'structural-prefix': 40,
  'model-tier': 50,
  // Unlabelled — last, so it never pre-empts a labelled claim's slice.
  unclassified: 90,
};

/** The cause-first rank of a claim, defaulting an absent cause to the tail. */
function causeRank(cause: CauseKey | undefined): number {
  return CAUSE_RANK[cause ?? DEFAULT_CAUSE];
}

/**
 * A lever's counterfactual — *what would the bill have been if…*. Each kind
 * reduces the residual of the claim's owned pools in a different way; the
 * cascade books the resulting drop as the lever's marginal.
 *
 *  - `reprice`     — the touched tokens billed at `toModel`'s rate instead of the
 *                    actual model's (model right-sizing / swap).
 *  - `convertRate` — the touched tokens re-billed at a *different pool's* rate on
 *                    the *same* model (e.g. 1-hour cache writes priced as 5-minute
 *                    writes). `rateFrom`/`rateTo` name the pools.
 *  - `scaleTokens` — a fraction of a pool's tokens removed outright
 *                    (`poolDeltaFrac` in [0,1] per pool). Deleting tokens deletes
 *                    their whole cost.
 *  - `directUsd`   — a flat dollar reclaim that is NOT a token-pool reprice (the
 *                    server-tool flat fee, e.g. web_search at $0.01/request). It
 *                    books against the scope's synthetic `server` cell so it still
 *                    flows through the same residual-guarded identity.
 *  - `flag-only`   — books $0 and mutates no residual; evidence only.
 */
export type ReclaimCounterfactual =
  | { kind: 'reprice'; toModel: string }
  | { kind: 'convertRate'; rateFrom: PoolId; rateTo: PoolId }
  | { kind: 'scaleTokens'; poolDeltaFrac: Partial<Record<PoolId, number>> }
  | { kind: 'directUsd'; usd: number }
  | { kind: 'flag-only' };

/**
 * A structured reclaim claim emitted by a detector — the unit the cascade books.
 *
 * `category` is a pure label (reporting/grouping only); it never changes the
 * arithmetic, so the identity and `residual ≥ 0` invariant hold under any
 * ordering. `scopeKeys` are the concrete `${sessionId}|${model}` matrix rows the
 * lever owns; a single-element list is the doc's canonical singular `scopeKey`.
 */
export interface ReclaimClaim {
  /**
   * Stable lever id — an **open** string, convention `${category}.${slug}` (the
   * detector's rule id). Opened in PR2 so later category PRs can introduce new
   * lever slugs without editing a closed union; the cascade treats it purely as a
   * grouping key for the per-lever breakdown.
   */
  leverId: string;
  /** Reporting category. Reuses the engine's {@link RecCategory} enum. */
  category: RecCategory;
  /**
   * Why the dollars are reclaimable — a pure label from the finite
   * {@link CauseKey} taxonomy that also drives the cause-first cascade order.
   * Optional for PR1 back-compat: an absent cause falls into {@link DEFAULT_CAUSE}
   * (`unclassified`) and sorts last within the structural band. Like `category`,
   * it NEVER changes the arithmetic — only grouping and attribution split.
   */
  cause?: CauseKey;
  /**
   * Cascade application order. Lower runs first and acts on the larger residual.
   * The identity is order-INVARIANT; the order only sets each lever's *split* of
   * a shared pool (an attribution-policy choice, see doc §4). The {@link CauseKey}
   * rank is layered UNDER this as a tie-shaper (cause-first), so an explicit
   * `orderKey` still wins when two claims set different ones.
   */
  orderKey: number;
  /** The priced pools this lever's counterfactual touches. */
  ownedPools: PoolId[];
  /**
   * The concrete matrix rows this lever owns, each a canonical
   * `${sessionId}|${model}`. Empty ⇒ the precondition rejects the claim (no real
   * priced scope to book against), EXCEPT for a `directUsd`/`flag-only`
   * counterfactual, which carries its own dollars / books nothing.
   */
  scopeKeys: string[];
  /** The counterfactual the cascade prices against the running residual. */
  counterfactual: ReclaimCounterfactual;
  /**
   * Tokens behind the claim — feeds per-category *coverage* only, never the
   * dollar identity. (Coverage gauge is PR3+; carried here so the contract is
   * stable.)
   */
  evidenceTokens: number;
}

/** The canonical scope key for a session+model matrix row. */
export function scopeKeyOf(sessionId: string, model: string): string {
  return `${sessionId}|${model}`;
}

/**
 * A per-pool priced residual for one scope, plus its non-token server fee.
 *
 * Each pool carries a live **token count** AND a live **effective rate** ($/MTok),
 * so `cost = tokens · rate / 1e6`. Storing the rate (not just the dollar residual)
 * is what lets *reprice* counterfactuals chain correctly: after a reprice the
 * cell's rate is the new model's rate, so a *second* reprice on the same pool
 * acts on the already-reduced rate (not the original). A pure-dollar residual
 * loses that and would over-book stacked reprices.
 */
interface ScopeResidual {
  sessionId: string;
  model: string;
  /** Live residual token count per pool (shrinks under `scaleTokens`). */
  tokens: Record<PoolId, number>;
  /** Live effective rate per pool, USD per MTok (changes under reprice/convert). */
  rate: Record<PoolId, number>;
  /** Flat server-tool fee residual (web_search/web_fetch), non-token (USD). */
  server: number;
}

/** USD cost of one pool cell from its live tokens × live rate. */
function cellCost(row: ScopeResidual, pool: PoolId): number {
  return (row.tokens[pool] / 1_000_000) * row.rate[pool];
}

/** The $/MTok rate for `pool` under `model`. */
function poolRate(pool: PoolId, model: string): number {
  const p = getModelPricing(model);
  switch (pool) {
    case 'input':
      return p.input;
    case 'output':
      return p.output;
    case 'cacheWrite5m':
      return p.cacheWrite5m;
    case 'cacheWrite1h':
      return p.cacheWrite1h;
    case 'cacheRead':
      return p.cacheRead;
  }
}

/** Per-claim booking produced by the cascade. */
export interface BookedClaim {
  leverId: string;
  category: RecCategory;
  /** The claim's cause label, defaulted to {@link DEFAULT_CAUSE} when absent. */
  cause: CauseKey;
  orderKey: number;
  /** The marginal USD this lever booked against the running residual. */
  marginalUsd: number;
  /** True when the claim was rejected by a precondition / `residual ≥ 0` guard. */
  rejected: boolean;
  /** Human-readable reason when `rejected`. */
  rejectReason?: string;
}

/**
 * Per-category coverage — the share of the repriced bill the engine "has a dollar
 * opinion on" for one category. The numerator is the priced value of the
 * `(scopeKey, pool)` cells the category's claims *address* (at the original
 * matrix rate, set-unioned so overlapping claims count a cell exactly once), so a
 * `flag-only` lever that pins real cells raises coverage even though it books $0.
 * A flag-only claim carrying only an unmapped `evidenceTokens` count adds $0 — we
 * do not fabricate a price for tokens with no resolvable cell. Coverage is plotted
 * SEPARATELY from the dollar identity and is never multiplied into it (doc §4
 * "coverage gauge … plotted separately, never multiplied").
 */
export interface CategoryCoverage {
  /** Priced value of the cell-union this category's claims address (≤ `totalBill`). */
  claimedUsd: number;
  /** The repriced total bill (the denominator) — same for every category. */
  totalBill: number;
  /** `claimedUsd / totalBill` in [0,1] (0 when the bill is empty). */
  coverage: number;
}

/** The cascade's full result: the dollar identity, per-lever / per-category splits, coverage. */
export interface ReclaimCascadeResult {
  /** The repriced actual bill before any counterfactual (sum of every cell). */
  billOriginal: number;
  /** The bill after every booked counterfactual (sum of surviving cells). */
  billFinal: number;
  /** `billOriginal − billFinal` ≡ `sum(booked marginal)`. */
  total: number;
  /** Per-category booked marginal (sparse). */
  byCategory: Partial<Record<RecCategory, number>>;
  /**
   * Per-lever booked marginal, keyed by `leverId`. The per-lever twin of
   * `byCategory`; both sum to `total`. An entry appears for each lever that ran a
   * token/`directUsd` counterfactual (its value may be `0` if the drop was $0);
   * `flag-only` and rejected levers book nothing and add no entry.
   */
  byLever: Record<string, number>;
  /**
   * Per-category coverage = `price(addressed cell-union) / repriced totalBill`.
   * Pure reporting, never part of the dollar identity; a `flag-only` lever that
   * pins real cells raises this but never `total`, and unmapped evidenceTokens add
   * $0. Sparse: a category appears only when its claims address a priced cell — a
   * ghost / no-cell category is omitted.
   */
  coverageByCategory: Partial<Record<RecCategory, CategoryCoverage>>;
  /** One entry per input claim, in cascade order, incl. rejections. */
  booked: BookedClaim[];
}

/** Per-entry 1h/5m cache split (mirrors `entryCostAtModel`). */
function cacheSplit(entry: TokenEntry): { cache1h: number; cache5m: number } {
  const cache1h = Math.min(entry.cacheCreation1hTokens, entry.cacheCreationTokens);
  return { cache1h, cache5m: entry.cacheCreationTokens - cache1h };
}

/** Tokens in a given pool for one entry. */
function poolTokens(entry: TokenEntry, pool: PoolId): number {
  const { cache1h, cache5m } = cacheSplit(entry);
  switch (pool) {
    case 'input':
      return entry.inputTokens;
    case 'output':
      return entry.outputTokens;
    case 'cacheWrite5m':
      return cache5m;
    case 'cacheWrite1h':
      return cache1h;
    case 'cacheRead':
      return entry.cacheReadTokens;
  }
}

/** Server-tool flat fee for one entry (web_search; web_fetch is $0 today). */
function serverFee(entry: TokenEntry): number {
  // Imported lazily-free: keep the constant local to avoid a pricing re-import
  // surface beyond what entryCostAtModel already pulls in.
  return entry.webSearchRequests * 0.01 + entry.webFetchRequests * 0;
}

/**
 * Build the priced residual matrix from the actual token usage.
 *
 * One row per `(sessionId, model)` (the canonical scopeKey granularity from doc
 * §4 / §7.2). A scope's bill is the sum of its five token-pool costs (priced at
 * the entry's *own* model via the same arithmetic as `entryCostAtModel`) plus a
 * non-token `server` fee. `billOriginal` is the sum of every cell.
 */
function buildResidualMatrix(tokenData: SessionTokenData[]): Map<string, ScopeResidual> {
  const matrix = new Map<string, ScopeResidual>();
  for (const d of tokenData) {
    for (const entry of d.entries) {
      const model = entry.model || 'unknown';
      const key = scopeKeyOf(d.sessionId, model);
      let row = matrix.get(key);
      if (!row) {
        // Seed each pool's effective rate from the scope's own model (uniform
        // across entries that share the (session, model) key).
        row = {
          sessionId: d.sessionId,
          model,
          tokens: { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 },
          rate: {
            input: poolRate('input', model),
            output: poolRate('output', model),
            cacheWrite5m: poolRate('cacheWrite5m', model),
            cacheWrite1h: poolRate('cacheWrite1h', model),
            cacheRead: poolRate('cacheRead', model),
          },
          server: 0,
        };
        matrix.set(key, row);
      }
      for (const pool of POOL_IDS) {
        row.tokens[pool] += poolTokens(entry, pool);
      }
      row.server += serverFee(entry);
    }
  }
  return matrix;
}

/** Sum every cell (token pools + server) across the matrix. */
function billOf(matrix: Map<string, ScopeResidual>): number {
  let total = 0;
  for (const row of matrix.values()) {
    for (const pool of POOL_IDS) total += cellCost(row, pool);
    total += row.server;
  }
  return total;
}

const EPS = 1e-9;

/**
 * Resolve a claim's `scopeKeys` to the matrix rows they own, dropping keys with
 * no priced cell and **de-duplicating by key** — a claim that lists the same
 * scope twice must not double-apply its counterfactual (or double-count a server
 * fee). Detectors already build their keys from a `Set`, so this is defence in
 * depth against a future malformed claim, not a hot path.
 */
function resolveRows(
  matrix: Map<string, ScopeResidual>,
  scopeKeys: string[]
): ScopeResidual[] {
  const seen = new Set<string>();
  const rows: ScopeResidual[] = [];
  for (const key of scopeKeys) {
    if (seen.has(key)) continue;
    seen.add(key);
    const row = matrix.get(key);
    if (row) rows.push(row);
  }
  return rows;
}

/**
 * Run the guarded-marginal cascade over `claims` against the actual `tokenData`.
 *
 * Claims are applied in ascending `orderKey` (ties broken by `leverId` for
 * determinism). Each claim's counterfactual reduces the residual of its owned
 * pools within its `scopeKeys`; the drop is booked as that claim's marginal and
 * the touched cells are decremented so the next claim sees a smaller residual.
 *
 * Guardrails:
 *  - **scopeKey precondition** — a token-touching claim whose `scopeKeys` resolve
 *    to no real matrix cell is rejected (books $0, mutates nothing).
 *  - **`residual ≥ 0` invariant** — a per-cell reduction that would exceed the
 *    cell's residual is rejected for that cell (logged), never clamped silently;
 *    the cascade keeps the well-formed portion.
 *
 * The returned `total` equals `billOriginal − billFinal` and the sum of booked
 * marginals to within floating-point epsilon — the identity is asserted in dev.
 *
 * `onReject` receives a one-line diagnostic for each rejected cell/claim; it
 * defaults to `console.warn` so a malformed claim is *visible*, not swallowed.
 * Tests pass a collector instead.
 */
export function runReclaimCascade(
  claims: ReclaimClaim[],
  tokenData: SessionTokenData[],
  onReject: (msg: string) => void = (m) => console.warn(`[reclaim] ${m}`)
): ReclaimCascadeResult {
  const matrix = buildResidualMatrix(tokenData);
  const billOriginal = billOf(matrix);

  // Coverage is priced against the ORIGINAL (pre-cascade) matrix, so it must be
  // captured before any counterfactual shrinks a cell. Pure reporting — it never
  // enters the dollar identity (doc §4: "plotted separately, never multiplied").
  const coverageByCategory = computeCoverage(claims, matrix, billOriginal);

  // Cause-first ordering (doc §4 "ordering policy: cause-first, decided"): the
  // CauseKey rank is PRIMARY, so a behavioural cause ([10,40)) always books its
  // marginal AHEAD of a structural cost/context lever ([40,90)) that shares the
  // same tokens — even when the structural lever's `orderKey` is numerically
  // lower. (If structure ran first it would swallow the shared cache-read and the
  // trendline would falsely read "fixing flaky tools saves $0".) `orderKey` is the
  // intra-cause tiebreaker; `leverId` breaks remaining ties for determinism. The
  // total is order-INVARIANT, so this only sets each lever's attribution split —
  // labels never move a dollar.
  const ordered = [...claims].sort(
    (a, b) =>
      causeRank(a.cause) - causeRank(b.cause) ||
      a.orderKey - b.orderKey ||
      a.leverId.localeCompare(b.leverId)
  );

  const booked: BookedClaim[] = [];
  const byCategory: Partial<Record<RecCategory, number>> = {};
  const byLever: Record<string, number> = {};

  const reject = (claim: ReclaimClaim, reason: string): BookedClaim => {
    onReject(`${claim.leverId}: ${reason}`);
    return {
      leverId: claim.leverId,
      category: claim.category,
      cause: claim.cause ?? DEFAULT_CAUSE,
      orderKey: claim.orderKey,
      marginalUsd: 0,
      rejected: true,
      rejectReason: reason,
    };
  };

  for (const claim of ordered) {
    const cf = claim.counterfactual;

    if (cf.kind === 'flag-only') {
      // Evidence-only sentinel: books $0 and mutates no residual. It still feeds
      // `coverageByCategory` (computed above), so a mostly-flag-only category
      // honestly shows dollar opinion without padding the identity.
      booked.push({
        leverId: claim.leverId,
        category: claim.category,
        cause: claim.cause ?? DEFAULT_CAUSE,
        orderKey: claim.orderKey,
        marginalUsd: 0,
        rejected: false,
      });
      continue;
    }

    let marginal = 0;

    if (cf.kind === 'directUsd') {
      // Books against the scopes' synthetic server-fee residual so it cannot
      // exceed the real flat-fee bill (residual ≥ 0 still holds).
      let available = 0;
      const rows = resolveRows(matrix, claim.scopeKeys);
      if (rows.length === 0) {
        booked.push(reject(claim, 'directUsd claim resolves to no priced scope'));
        continue;
      }
      for (const row of rows) available += row.server;
      if (cf.usd > available + EPS) {
        booked.push(
          reject(
            claim,
            `directUsd ${cf.usd.toFixed(4)} exceeds server-fee residual ${available.toFixed(4)}`
          )
        );
        continue;
      }
      // Drain the claimed dollars across the owning scopes' server residual.
      let remaining = cf.usd;
      for (const row of rows) {
        const take = Math.min(row.server, remaining);
        row.server -= take;
        remaining -= take;
        marginal += take;
        if (remaining <= EPS) break;
      }
    } else {
      // Token-pool counterfactual (reprice / convertRate / scaleTokens).
      const rows = resolveRows(matrix, claim.scopeKeys);
      if (rows.length === 0) {
        booked.push(reject(claim, 'claim resolves to no priced scope (precondition)'));
        continue;
      }
      for (const row of rows) {
        for (const pool of claim.ownedPools) {
          const before = cellCost(row, pool);
          if (before <= EPS) continue;
          const next = applyCounterfactual(row, pool, cf);
          const drop = before - next.cost;
          if (drop <= EPS) continue; // a no-op or cost-increasing reprice books $0
          if (drop > before + EPS) {
            // residual ≥ 0 invariant: a counterfactual must never reduce a cell
            // below zero. Reject this cell (keep the rest), never clamp silently.
            onReject(
              `${claim.leverId}: ${pool}@${scopeKeyOf(row.sessionId, row.model)} ` +
                `would over-draw residual (drop ${drop.toFixed(6)} > ${before.toFixed(6)})`
            );
            continue;
          }
          // Commit the reduced cell (fewer tokens and/or a lower rate).
          row.tokens[pool] = next.tokens;
          row.rate[pool] = next.rate;
          marginal += drop;
        }
      }
    }

    booked.push({
      leverId: claim.leverId,
      category: claim.category,
      cause: claim.cause ?? DEFAULT_CAUSE,
      orderKey: claim.orderKey,
      marginalUsd: marginal,
      rejected: false,
    });
    byCategory[claim.category] = (byCategory[claim.category] ?? 0) + marginal;
    byLever[claim.leverId] = (byLever[claim.leverId] ?? 0) + marginal;
  }

  const billFinal = billOf(matrix);
  const total = billOriginal - billFinal;

  // Dev-only identity assertion: sum(marginal) ≡ billOriginal − billFinal.
  const summed = booked.reduce((s, b) => s + b.marginalUsd, 0);
  if (Math.abs(summed - total) > 1e-6) {
    onReject(
      `cascade identity broken: sum(marginal)=${summed.toFixed(6)} ` +
        `vs billOriginal-billFinal=${total.toFixed(6)}`
    );
  }

  return { billOriginal, billFinal, total, byCategory, byLever, coverageByCategory, booked };
}

/**
 * Per-category **coverage** numerator: the priced value of the bill the
 * category's claims address, at the ORIGINAL matrix rate.
 *
 * Coverage answers "what share of the real bill does the engine have a **dollar
 * opinion** on", so it is the priced **set union of addressed `(scope, pool)`
 * cells** — a cell two claims both touch counts exactly once. It is NOT
 * `sum(marginal)` and is decoupled from the dollar identity entirely. Because of
 * that:
 *  - it is priced from the original matrix (before any counterfactual shrinks a
 *    cell), so a later cascade booking never lowers an earlier coverage figure;
 *  - a claim that resolves its `scopeKeys` to real cells via `ownedPools`
 *    contributes those priced cells (a `flag-only` lever raises coverage even
 *    though it books $0, because the engine *does* have a dollar opinion on the
 *    cells it pins);
 *  - a `directUsd` claim contributes its scopes' server-fee residual, the
 *    non-token bill it has an opinion on.
 *
 * A `flag-only` claim that carries only a raw `evidenceTokens` count with **no
 * resolvable `(scope, pool)` cell contributes $0 to dollar coverage** — there is
 * no priced cell the engine has an opinion on, so fabricating a blended price for
 * unmapped tokens would inflate the "dollar opinion on X%" gauge. (A separate
 * token-based "evidence coverage" signal, if ever wanted, is a later concern; it
 * must NOT be mixed into this dollar gauge.)
 *
 * Unclaimed pools simply never enter any category's union, so they *lower*
 * coverage. The result is **sparse**: a category whose claims address no priced
 * cell (ghost scopes, or evidence with no resolvable cell) is omitted entirely —
 * there is no `claimedUsd:0` ghost entry. The set-union already keeps the
 * numerator ≤ the bill; `Math.min(claimedUsd, totalBill)` is a belt-and-suspenders
 * clamp so `coverage` stays in [0,1] under any float rounding.
 */
function computeCoverage(
  claims: ReclaimClaim[],
  matrix: Map<string, ScopeResidual>,
  totalBill: number
): Partial<Record<RecCategory, CategoryCoverage>> {
  // Per category, the distinct addressed cells: token cells keyed `${scopeKey}#${pool}`
  // and server cells keyed `${scopeKey}#server`, so a cell counts at most once.
  const cellsByCategory = new Map<RecCategory, Set<string>>();
  const cellsFor = (cat: RecCategory): Set<string> => {
    let s = cellsByCategory.get(cat);
    if (!s) {
      s = new Set<string>();
      cellsByCategory.set(cat, s);
    }
    return s;
  };

  for (const claim of claims) {
    const cells = cellsFor(claim.category);
    const cf = claim.counterfactual;
    const rows = resolveRows(matrix, claim.scopeKeys);
    if (cf.kind === 'directUsd') {
      // The opinion is on the scopes' flat server-fee bill.
      for (const row of rows) {
        if (row.server > EPS) cells.add(`${scopeKeyOf(row.sessionId, row.model)}#server`);
      }
      continue;
    }
    // Token-pool and flag-only claims address the priced pools they pin within
    // their scopes. A flag-only claim with no resolvable cell pins nothing and so
    // adds $0 dollar coverage — its raw evidenceTokens are deliberately NOT priced.
    for (const row of rows) {
      const key = scopeKeyOf(row.sessionId, row.model);
      for (const pool of claim.ownedPools) {
        if (cellCost(row, pool) > EPS) cells.add(`${key}#${pool}`);
      }
    }
  }

  // Price each category's addressed-cell union at the original matrix rate, and
  // emit ONLY non-empty categories (sparse: no ghost { claimedUsd: 0 } entries).
  const out: Partial<Record<RecCategory, CategoryCoverage>> = {};
  for (const [cat, cells] of cellsByCategory) {
    let claimedUsd = 0;
    for (const cellId of cells) {
      const hash = cellId.lastIndexOf('#');
      const scopeKey = cellId.slice(0, hash);
      const part = cellId.slice(hash + 1);
      const row = matrix.get(scopeKey);
      if (!row) continue;
      claimedUsd += part === 'server' ? row.server : cellCost(row, part as PoolId);
    }
    // The set-union already bounds this by the bill; clamp belt-and-suspenders.
    claimedUsd = Math.min(claimedUsd, totalBill);
    if (claimedUsd <= EPS) continue; // sparse: omit categories with no dollar opinion
    out[cat] = {
      claimedUsd,
      totalBill,
      coverage: totalBill > EPS ? claimedUsd / totalBill : 0,
    };
  }
  return out;
}

/**
 * Apply a token-pool counterfactual to a cell's *current* residual, returning the
 * cell's new `(tokens, rate)` and `cost`.
 *
 * Because the cell carries a live token count and a live effective rate, a lever
 * applied after another acts on the already-reduced state (the cascade property):
 *  - `reprice`     — keep the tokens, drop the rate to the target model's rate for
 *                    this pool (a *second* reprice therefore drops from the first
 *                    reprice's rate, not the original — no over-booking).
 *  - `convertRate` — keep the tokens, drop the `rateFrom` pool's rate to the
 *                    `rateTo` pool's rate on the cell's *current* model.
 *  - `scaleTokens` — keep the rate, delete a fraction of the tokens.
 *
 * Each only ever *lowers* cost (a rate increase or negative fraction yields a
 * `cost ≥ before`, which the caller books as $0 and does not commit). The caller
 * enforces the `residual ≥ 0` invariant on the resulting drop.
 */
function applyCounterfactual(
  row: ScopeResidual,
  pool: PoolId,
  cf: Exclude<ReclaimCounterfactual, { kind: 'flag-only' } | { kind: 'directUsd' }>
): { tokens: number; rate: number; cost: number } {
  const tokens = row.tokens[pool];
  const rate = row.rate[pool];

  switch (cf.kind) {
    case 'scaleTokens': {
      const frac = cf.poolDeltaFrac[pool] ?? 0;
      const keep = Math.max(0, 1 - frac); // frac>1 ⇒ keep 0 (drop = full cost, never over)
      const nextTokens = tokens * keep;
      return { tokens: nextTokens, rate, cost: (nextTokens / 1_000_000) * rate };
    }
    case 'reprice': {
      // Same tokens, the target model's rate for THIS pool. Only commit if it
      // lowers the rate (a swap to a pricier model books nothing).
      const nextRate = Math.min(rate, poolRate(pool, cf.toModel));
      return { tokens, rate: nextRate, cost: (tokens / 1_000_000) * nextRate };
    }
    case 'convertRate': {
      // Only the `rateFrom` pool converts; any other owned pool is untouched.
      if (pool !== cf.rateFrom) return { tokens, rate, cost: cellCost(row, pool) };
      const nextRate = Math.min(rate, poolRate(cf.rateTo, row.model));
      return { tokens, rate: nextRate, cost: (tokens / 1_000_000) * nextRate };
    }
  }
}

/**
 * Roll the cascade up into the shape #946's `rollupReclaim` consumers expect,
 * adding the repriced `totalBill` denominator the coverage gauge needs.
 *
 * `total` and `byCategory` come straight from the cascade (the deduped,
 * overflow-proof booked marginals); `totalBill` is `billOriginal`. Kept as a thin
 * adapter so `recommendations.ts` can repoint onto the cascade without importing
 * the matrix internals.
 */
export interface ReclaimRollupWithBill {
  total: number;
  byCategory: Partial<Record<RecCategory, number>>;
  /**
   * Per-lever booked marginal, keyed by `leverId` (PR2). The per-lever twin of
   * `byCategory`; both sum to `total` over non-rejected claims. Lets the trendline
   * label each lever's "marginal given the levers above it" without re-walking
   * `booked`.
   */
  byLever: Record<string, number>;
  /**
   * Per-category coverage = priced set-union of the addressed `(scope,pool)`
   * cells / totalBill (PR2), each cell counted once. Plotted separately from the
   * dollar identity and never feeds `total`. A `flag-only` claim contributes only
   * through the real cells it resolves to — one carrying just `evidenceTokens`
   * with no `ownedPools` adds $0 (flagged, but no dollar opinion). Sparse: only
   * categories that price at least one cell appear.
   */
  coverageByCategory: Partial<Record<RecCategory, CategoryCoverage>>;
  /** The repriced actual bill — coverage = total / totalBill. */
  totalBill: number;
}

export function rollupCascade(result: ReclaimCascadeResult): ReclaimRollupWithBill {
  return {
    total: result.total,
    byCategory: result.byCategory,
    byLever: result.byLever,
    coverageByCategory: result.coverageByCategory,
    totalBill: result.billOriginal,
  };
}

// ── Recommendation-list cascade helpers ──────────────────────────────────
// Pure aggregation over a `Recommendation[]` + `tokenData` — NO detector run,
// so these live in this detector-free module (#2719). They were extracted from
// `recommendations.ts` (which pulls the whole detector catalog) so browser
// surfaces can roll up reclaim dollars over a server-supplied rec list without
// bundling the engine. `recommendations.ts` re-exports them for existing
// server/test importers.

/** The claims a rec list carries, in stable rec order. */
function reclaimClaims(recs: Recommendation[]): ReclaimClaim[] {
  const claims: ReclaimClaim[] = [];
  for (const rec of recs) if (rec.reclaim) claims.push(rec.reclaim);
  return claims;
}

/**
 * Run the guarded-marginal cascade over the claims a rec list carries, against
 * the actual token usage. Returns the full cascade result (`billOriginal`,
 * `billFinal`, `total`, per-category split, and the per-claim bookings) so a
 * caller can both roll up dollars and back-fill each rec's `estSavingsUsd`.
 */
export function reclaimCascade(
  recs: Recommendation[],
  tokenData: SessionTokenData[],
  onReject?: (msg: string) => void
): ReclaimCascadeResult {
  return runReclaimCascade(reclaimClaims(recs), tokenData, onReject);
}

/**
 * Deduped, overflow-proof reclaim rollup with the repriced `totalBill`
 * denominator — the cascade replacement for `rollupReclaim`. Use this when the
 * actual `tokenData` is available (the engine input always has it).
 */
export function rollupReclaimCascade(
  recs: Recommendation[],
  tokenData: SessionTokenData[]
): ReclaimRollupWithBill {
  return rollupCascade(reclaimCascade(recs, tokenData));
}

/**
 * Back-fill each rec's `estSavingsUsd` from its booked cascade marginal so the
 * per-card dollar figure equals the lever's disjoint slice (not its raw,
 * possibly-overlapping estimate). Recs without a claim, or whose claim was
 * rejected, are returned unchanged. Returns a NEW array; inputs are not mutated.
 */
export function backfillReclaimSavings(
  recs: Recommendation[],
  tokenData: SessionTokenData[]
): Recommendation[] {
  const result = reclaimCascade(recs, tokenData);
  const booked = new Map(result.booked.map((b) => [b.leverId, b]));
  return recs.map((rec) => {
    if (!rec.reclaim) return rec;
    const b = booked.get(rec.reclaim.leverId);
    if (!b || b.rejected) return rec;
    return { ...rec, estSavingsUsd: b.marginalUsd };
  });
}
