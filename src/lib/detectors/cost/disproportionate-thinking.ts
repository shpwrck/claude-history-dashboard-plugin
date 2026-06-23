import type { Detector } from '../types';
import { fmtUsd, short } from '../shared';
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

export const detector: Detector = {
  id: 'cost.disproportionate-thinking',
  category: 'cost',
  dataDeps: ['tokenData'],
  rule(input) {
    const scopeKeys = new Set<string>();
    const flagged: { sessionId: string; think: number; visible: number; share: number }[] = [];
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
    const totalOutput = input.tokenData.reduce((s, d) => {
      // Only the flagged sessions' output backs this claim.
      return flagged.some((f) => f.sessionId === d.sessionId)
        ? s + d.totalOutputTokens
        : s;
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

    return {
      id: 'cost.disproportionate-thinking',
      category: 'cost',
      severity: 'info',
      title: 'Reasoning effort looks oversized for the work done',
      detail:
        `${flagged.length} session(s) spent more on reasoning ("thinking") than on visible output — ` +
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
    };
  },
};
