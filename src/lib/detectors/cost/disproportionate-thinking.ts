import type { Detector, RecommendationInput } from '../types';
import type { ClaimDerivation } from '../../claim-provenance';
import { fmtUsd, newestTokenDataDate, short, STALE_WEEKS } from '../shared';
import { isAsOfStale } from '../provenance';
import { resolveModelPricing } from '../../pricing';
import { scopeKeyOf, type ReclaimClaim } from '../../reclaim';

/**
 * Effort-calibration detector (#1927).
 *
 * `outputTokens` bills thinking and visible output together; we reconstruct a
 * per-session `totalThinkingTokens` estimate (residual of billed output after
 * visible text + tool_use args — see `src/lib/thinking-tokens.ts`). This rule
 * flags sessions whose thinking spend is DISPROPORTIONATE to the visible work
 * produced: the visible output (text the user reads + tool calls the agent
 * makes) is the complexity proxy, so a session that "thought" far more than it
 * produced is the over-effort signature on otherwise mechanical work.
 *
 * Dollarized per #858: the recoverable portion of the thinking cost is booked
 * against the `output` token pool via a `scaleTokens` reclaim, so it stays
 * inside the residual-guarded identity (can never exceed the real output bill)
 * and the cascade dedups it against any model-downshift lever over the same
 * scopes.
 */

// Hardened thresholds (#2006). The reconstructed thinking estimate is a noisy
// per-session signal, so the bar to flag is deliberately conservative:
// substantial absolute thinking, an EXTREME share (not merely >half), and a
// non-trivial amount of real visible work — so estimator variance on
// tiny/tool-only sessions can't manufacture a finding.
//
// Absolute floor so small sessions don't trip the ratio on noise.
const MIN_THINKING_TOKENS = 20_000;
// Thinking must be at least this multiple of visible output (thought >=2x more
// than it produced) — an extreme, hard-to-explain-as-noise disproportion.
const MIN_OVERTHINK_RATIO = 2.0;
// The session must have produced a non-trivial amount of visible output, so we
// only flag real work that over-reasoned — not a handful of tiny tool calls
// where the per-message residual is least reliable.
const MIN_VISIBLE_TOKENS = 2_000;
// Lowering reasoning effort cannot eliminate all thinking; treat half the
// flagged thinking spend as realistically recoverable.
const RECOVERABLE_FRACTION = 0.5;
// Don't surface a finding worth less than this.
const MIN_SAVINGS_USD = 0.25;

/** Thinking evidence older than this demotes to "as of <date>" (#3194). */
const STALE_AFTER_DAYS = STALE_WEEKS * 7;

export const detector: Detector = {
  id: 'cost.disproportionate-thinking',
  category: 'cost',
  dataDeps: ['tokenData'],
  rule(input, now) {
    const scopeKeys = new Set<string>();
    const flagged: { sessionId: string; think: number; visible: number; share: number }[] = [];
    const flaggedData: RecommendationInput['tokenData'] = [];
    let savingsUsd = 0;

    for (const d of input.tokenData) {
      const think = d.totalThinkingTokens ?? 0;
      if (think < MIN_THINKING_TOKENS) continue;
      const visible = Math.max(0, d.totalOutputTokens - think);
      if (visible < MIN_VISIBLE_TOKENS) continue;
      const ratio = think / Math.max(1, visible);
      if (ratio < MIN_OVERTHINK_RATIO) continue;

      // Per-entry dollarization at each entry's own model rate, and collect the
      // concrete (session, model) scope rows the reclaim books against.
      for (const e of d.entries) {
        const et = e.thinkingTokens ?? 0;
        if (et <= 0) continue;
        const model = e.model || 'unknown';
        scopeKeys.add(scopeKeyOf(d.sessionId, model));
        const rate = resolveModelPricing(model).pricing.output;
        savingsUsd += ((et * RECOVERABLE_FRACTION) / 1_000_000) * rate;
      }

      flagged.push({
        sessionId: d.sessionId,
        think,
        visible,
        share: d.totalOutputTokens > 0 ? think / d.totalOutputTokens : 0,
      });
      flaggedData.push(d);
    }

    if (flagged.length === 0 || savingsUsd < MIN_SAVINGS_USD || scopeKeys.size === 0) {
      return null;
    }

    flagged.sort((a, b) => b.think - a.think);

    // The recoverable thinking tokens come out of the output pool. A single
    // `scaleTokens` fraction across the flagged scopes books the right TOTAL
    // marginal when their output rates are uniform, and stays residual-bounded
    // (so the booked dollars can never exceed the real output bill) otherwise.
    const totalThink = flagged.reduce((s, f) => s + f.think, 0);
    // Membership, not a search (#3198). `flagged.some(...)` once per tokenData
    // row made this O(tokenData x flagged), and `flagged` grows WITH tokenData
    // — every session can be flagged — so the worst case is quadratic in
    // session count on exactly the histories worth analysing. A Set answers
    // the same question in one pass; duplicate ids fold together, which is
    // what `some` already did.
    const flaggedSessionIds = new Set(flagged.map((f) => f.sessionId));
    const totalOutput = input.tokenData.reduce((s, d) => {
      // Only the flagged sessions' output backs this claim.
      return flaggedSessionIds.has(d.sessionId) ? s + d.totalOutputTokens : s;
    }, 0);
    const outputDeltaFrac =
      totalOutput > 0
        ? Math.min(1, (totalThink * RECOVERABLE_FRACTION) / totalOutput)
        : 0;

    const reclaim: ReclaimClaim = {
      leverId: 'cost.disproportionate-thinking',
      category: 'cost',
      orderKey: 70,
      ownedPools: ['output'],
      scopeKeys: [...scopeKeys],
      counterfactual: { kind: 'scaleTokens', poolDeltaFrac: { output: outputDeltaFrac } },
      evidenceTokens: totalThink,
    };

    const top = flagged[0];
    const topSharePct = Math.round(top.share * 100);

    const recoverableTokens = totalThink * RECOVERABLE_FRACTION;
    // #3516 review: the mean rate is DERIVED from the booked dollars, not read
    // from pricing.ts — back-solving it and then "deriving" savings from it was
    // circular (the identity held even if savingsUsd were wrong). savingsUsd is
    // now an observation naming its per-entry formula; the implied mean is
    // published in the honest direction (savings → mean) as a convenience.
    const impliedMeanOutputUsdPerMTok = savingsUsd / (recoverableTokens / 1_000_000);

    // Dated from the newest OBSERVED entry among the flagged sessions (never
    // `now`); no readable timestamps → no asOf (#3194).
    const asOf = newestTokenDataDate(flaggedData);
    const stale = isAsOfStale(asOf, now, STALE_AFTER_DAYS);
    const datePrefix = stale ? `As of ${asOf} (dated evidence): ` : '';

    // Typed explicitly: the operand keys differ per derivation, and the
    // heterogeneous array literal otherwise union-widens against
    // Record<string, ClaimScalar> under exactOptionalPropertyTypes.
    const derivations: ClaimDerivation[] = [
      {
        id: 'recoverable-thinking-tokens',
        formula: 'totalThinkingTokens * RECOVERABLE_FRACTION',
        operands: {
          totalThinkingTokens: totalThink,
          recoverableFraction: RECOVERABLE_FRACTION,
        },
        value: recoverableTokens,
      },
      {
        id: 'implied-mean-output-rate',
        formula: 'estSavingsUsd / (recoverableThinkingTokens / 1e6)',
        operands: {
          estSavingsUsd: savingsUsd,
          recoverableThinkingTokens: recoverableTokens,
        },
        value: impliedMeanOutputUsdPerMTok,
      },
    ];

    return {
      id: 'cost.disproportionate-thinking',
      category: 'cost',
      severity: 'info',
      title: 'Reasoning effort looks oversized for the work done',
      detail:
        `${datePrefix}${flagged.length} session(s) spent more on reasoning ("thinking") than on visible output — ` +
        `e.g. ${short(top.sessionId)} reconstructs ~${top.think.toLocaleString()} thinking tokens ` +
        `(~${topSharePct}% of its output) against only ~${top.visible.toLocaleString()} visible tokens. ` +
        `Lowering reasoning effort on this mechanical work could recover ~${fmtUsd(savingsUsd)}. ` +
        `Thinking is a reconstructed estimate (the API never separates it from output), so treat it as a lower bound.`,
      action:
        'Lower the reasoning-effort / thinking budget for these sessions or the agent types that drive them — they reason far more than they produce. Reserve high effort for genuinely hard tasks.',
      estSavingsUsd: savingsUsd,
      reclaim,
      affected: flagged.length,
      evidence: flagged
        .slice(0, 5)
        .map(
          (f) =>
            `${short(f.sessionId)}: ~${f.think.toLocaleString()} thinking vs ~${f.visible.toLocaleString()} visible tokens`
        ),
      view: 'cost',
      // Auditability contract (#1049/#3194): the reconstructed token counts are
      // the observations; the dollar figure is a named derivation over scalars;
      // the recoverable fraction is declared an assumption in the inference.
      provenance: {
        observations: [
          {
            claim: `${flagged.length} session(s) clear every flag gate (>= ${MIN_THINKING_TOKENS.toLocaleString()} thinking tokens, >= ${MIN_VISIBLE_TOKENS.toLocaleString()} visible tokens, thinking/visible ratio >= ${MIN_OVERTHINK_RATIO})`,
            source: 'parse-sessions',
            field: 'tokenData[] (sessions passing the thinking/visible gates)',
            value: flagged.length,
          },
          {
            claim: `the flagged sessions reconstruct ~${totalThink.toLocaleString()} thinking tokens in total`,
            source: 'parse-sessions',
            field: 'tokenData[].totalThinkingTokens / totalOutputTokens',
            value: totalThink,
          },
          {
            claim: `the flagged session with the largest thinking reconstruction rebuilds ~${top.think.toLocaleString()} thinking tokens (~${topSharePct}% of its billed output) against ~${top.visible.toLocaleString()} visible tokens`,
            source: 'parse-sessions',
            record: short(top.sessionId),
            field: 'tokenData[].totalThinkingTokens / totalOutputTokens',
            value: top.think,
          },
          {
            claim: `the recoverable thinking prices to ~${fmtUsd(savingsUsd)} when each flagged session's entries are priced at their own model's output rate`,
            source: 'pricing.ts',
            field: 'sum(entries[].thinkingTokens x RECOVERABLE_FRACTION / 1e6 x resolveModelPricing(entry.model).pricing.output)',
            value: savingsUsd,
          },
        ],
        derivations,
        inference:
          `Thinking tokens are a reconstructed residual (billed output minus visible ` +
          `text and tool_use args — the API never separates them), so the counts are ` +
          `estimates and treated as lower bounds. That a session which "thought" ` +
          `>= ${MIN_OVERTHINK_RATIO}x more than it produced over-reasoned is the detector's ` +
          `proxy inference, and RECOVERABLE_FRACTION=${RECOVERABLE_FRACTION} is an assumption ` +
          `(lowering effort cannot eliminate all thinking), not a measurement.`,
        ...(asOf !== undefined ? { asOf, stale } : {}),
      },
    };
  },
};
