import type { Detector } from '../types';
import type { SessionTokenData, AssistantFeatures } from '../../../types';
import { claudeMdMarksApplied, fmtUsd, MIN_SAVINGS_USD } from '../shared';
import { getModelPricing } from '../../pricing';
import { scopeKeyOf, type ReclaimClaim } from '../../reclaim';

/**
 * `cost.output-verbosity` (#1923) — measure verbose assistant PROSE output and
 * dollarize compressing it (the "caveman"/output-compression lever).
 *
 * Sized HONESTLY and prose-only (the point of #1923 — caveman's ~75% reduction is
 * an unproven self-claim, output is only ~12% of the bill, and prose compresses
 * but tool-call JSON / code / file payloads do not):
 *  - The measure reads `AssistantFeatures.textLength` (chars of assistant TEXT
 *    blocks only — `tool_use`/thinking are excluded by the parser), so the
 *    estimate never claims compression on tool/JSON/file output.
 *  - Only sessions where prose DOMINATES the output (share ≥ `PROSE_SHARE_FLOOR`)
 *    are counted, so the tool-heavy headless fleet (where the money is) is not
 *    over-credited.
 *  - The booked dollar is the DIRECT output-token saving only (`output` pool),
 *    at a conservative `COMPRESSION_FRAC` well below the 75% self-claim. The
 *    cache-compounded tail (compressed prose also shrinks cached history on later
 *    turns) is estimated and reported in the detail but deliberately NOT added to
 *    the booked figure — those cache-read tokens are already the territory of the
 *    payload levers (tool-call-right-sizing / mcp-schema-tax), so double-claiming
 *    them would inflate the bill.
 *
 * The causal proof (a caveman vs normal `/replay` axis) is a separate meta
 * follow-on, tracked apart so this slice stays a burnable dashboard change.
 */

const CHARS_PER_TOKEN = 4;
/**
 * Conservative compressible share of PROSE tokens. The `caveman` skill self-claims
 * ~75% output reduction; that is unproven and risks quality/rework, so we book a
 * deliberately lower fraction and let the proof axis measure the real effect.
 */
const COMPRESSION_FRAC = 0.4;
/** Only count sessions where prose is at least this share of output tokens. */
const PROSE_SHARE_FLOOR = 0.4;
/** Per-session prose floor (tokens) below which compression isn't worth flagging. */
const MIN_PROSE_TOKENS = 2_000;
/** Cap on the cache-read tail multiplier for the reported (non-booked) tail estimate. */
const MAX_TAIL_TURNS = 40;

const MARKERS = {
  headings: [/^##\s+Output brevity\b/i],
  bodyPhrases: ['keep assistant output terse'],
};

/** Model carrying the most output tokens in a session (cost-representative). */
function dominantOutputModel(d: SessionTokenData): string {
  let best = 'unknown';
  let bestOut = -1;
  for (const e of d.entries) {
    if (e.outputTokens > bestOut) {
      bestOut = e.outputTokens;
      best = e.model || 'unknown';
    }
  }
  return best;
}

export const detector: Detector = {
  id: 'cost.output-verbosity',
  appliedMarkers: MARKERS,
  category: 'cost',
  dataDeps: ['assistantFeatures', 'tokenData', 'liveConfig'],
  rule(input) {
    if (claudeMdMarksApplied(input.liveConfig, MARKERS)) return null;
    const feats = input.assistantFeatures;
    if (!feats || feats.length === 0) return null;

    const tokenBySession = new Map<string, SessionTokenData>(
      (input.tokenData ?? []).map((d) => [d.sessionId, d])
    );

    let estSavingsUsd = 0;
    let tailUsd = 0;
    let totalCompressibleTokens = 0;
    let inScopeOutputTokens = 0;
    const scopeKeys = new Set<string>();
    let affected = 0;
    let proseChars = 0;

    const consider = (af: AssistantFeatures) => {
      const d = tokenBySession.get(af.sessionId);
      if (!d) return;
      let totalOutput = 0;
      for (const e of d.entries) totalOutput += e.outputTokens;
      if (totalOutput <= 0) return;
      const proseTokens = Math.min(af.textLength / CHARS_PER_TOKEN, totalOutput);
      const proseShare = proseTokens / totalOutput;
      if (proseShare < PROSE_SHARE_FLOOR || proseTokens < MIN_PROSE_TOKENS) return;

      const compressible = proseTokens * COMPRESSION_FRAC;
      const pricing = getModelPricing(dominantOutputModel(d));
      estSavingsUsd += (compressible / 1_000_000) * pricing.output;
      // Reported-only cache tail: compressed prose also shrinks cached history.
      const tailTurns = Math.min(MAX_TAIL_TURNS, Math.max(0, d.entries.length - 1));
      tailUsd += (compressible / 1_000_000) * pricing.cacheRead * tailTurns;

      totalCompressibleTokens += compressible;
      inScopeOutputTokens += totalOutput;
      proseChars += af.textLength;
      for (const e of d.entries) scopeKeys.add(scopeKeyOf(d.sessionId, e.model || 'unknown'));
      affected += 1;
    };
    for (const af of feats) consider(af);

    // Honest-null: nothing worth saying when the prose lever is below the floor.
    if (affected === 0 || estSavingsUsd < MIN_SAVINGS_USD) return null;

    // Book the DIRECT output-token saving only (output pool), at the conservative
    // compression fraction. The cascade's residual guard caps it at the real
    // output bill. No cacheRead pool here — that tail is the payload levers'.
    let reclaim: ReclaimClaim | undefined;
    if (totalCompressibleTokens > 0 && scopeKeys.size > 0 && inScopeOutputTokens > 0) {
      const outputFrac = Math.min(1, totalCompressibleTokens / inScopeOutputTokens);
      reclaim = {
        leverId: 'cost.output-verbosity',
        category: 'cost',
        orderKey: 55,
        ownedPools: ['output'],
        scopeKeys: [...scopeKeys],
        counterfactual: { kind: 'scaleTokens', poolDeltaFrac: { output: outputFrac } },
        evidenceTokens: Math.round(totalCompressibleTokens),
      };
    }

    return {
      id: 'cost.output-verbosity',
      category: 'cost',
      severity: 'info',
      title: 'Compress verbose assistant prose output',
      detail:
        `${affected} session(s) emit prose-heavy output (≥${Math.round(
          PROSE_SHARE_FLOOR * 100
        )}% of output tokens is assistant text). Trimming filler/preamble at a conservative ${Math.round(
          COMPRESSION_FRAC * 100
        )}% (well below the unproven ~75% "caveman" self-claim) would save ~${fmtUsd(
          estSavingsUsd
        )} in output tokens` +
        (tailUsd > 0
          ? `, plus an estimated ~${fmtUsd(
              tailUsd
            )} cache-read tail as the prose shrinks in later turns' context (not double-counted — that tail is attributed to the payload levers).`
          : '.') +
        ` Prose only — tool-call JSON, code, and file payloads are excluded.`,
      action:
        'Prefer terse assistant output in headless/unattended runs: drop preamble, restated context, and filler; lead with the result. Verify on a payload-heavy task that brevity does not raise retries before adopting fleet-wide.',
      estSavingsUsd,
      savingsAttribution: {
        interventionKey: 'cost.output-verbosity',
        signatureId: 'output-prose-compression',
        tier: 'tier-0-estimate',
        predictedSavingsUsd: estSavingsUsd,
        confidence: 'low',
      },
      ...(reclaim ? { reclaim } : {}),
      affected,
      evidence: [
        `~${Math.round(proseChars / CHARS_PER_TOKEN).toLocaleString()} prose output tokens across ${affected} verbose session(s)`,
        `compressible at ${Math.round(COMPRESSION_FRAC * 100)}% → ~${Math.round(
          totalCompressibleTokens
        ).toLocaleString()} output tokens (~${fmtUsd(estSavingsUsd)})`,
      ],
      view: 'cost',
      provenance: {
        observations: [
          {
            claim: `${affected} session(s) with prose ≥${Math.round(PROSE_SHARE_FLOOR * 100)}% of output tokens; ~${Math.round(proseChars / CHARS_PER_TOKEN).toLocaleString()} prose output tokens`,
            source: 'parse-assistant-features',
            field: 'assistantFeatures[].textLength (text blocks only)',
            value: affected,
          },
          {
            claim: `output billed at the model output rate; compressible share booked at ${Math.round(COMPRESSION_FRAC * 100)}% of prose tokens`,
            source: 'pricing',
            field: 'getModelPricing().output',
            value: Math.round(totalCompressibleTokens),
          },
        ],
        inference:
          'Assistant text blocks (prose) are a compressible slice of output tokens; trimming filler at a conservative fraction saves output spend. Sized prose-only (tool-call JSON / code / file payloads excluded) and well below the unproven ~75% self-claim — a causal caveman-vs-normal replay axis is tracked separately to measure the real effect and any rework cost.',
      },
      fix: {
        target: 'CLAUDE.md',
        label: 'Add an output-brevity directive',
        note: 'Append to CLAUDE.md so headless/unattended runs default to terse output. Measure rework before adopting fleet-wide.',
        snippet: `## Output brevity

- Keep assistant output terse, especially in headless/unattended runs: drop preamble, restated context, and filler — lead with the result.
- This trims output (and its cached tail) without touching tool-call JSON, code, or file payloads.`,
        appliedMarkers: MARKERS,
      },
    };
  },
};
