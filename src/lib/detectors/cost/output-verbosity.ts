import type { Detector } from '../types';
import type { SessionTokenData, AssistantFeatures } from '../../../types';
import {
  claudeMdMarksApplied,
  fmtUsd,
  MIN_SAVINGS_USD,
  coverageTotal,
  isFullyExcluded,
  type EvidenceCoverage,
} from '../shared';
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

// `dominantOutputModel()` used to live here and is DELETED, not repaired.
//
// Its doc comment said "model carrying the most output tokens in a session",
// but it returned the model of the single largest ENTRY — two derivations of
// one fact, drifted (audit defect class 4). A session with 100,000 tokens of
// Haiku across ten entries and 20,000 of Opus in one entry resolved to Opus,
// and pricing the whole compressible slice at that rate overstated the saving
// by up to 5x while the reclaim cascade — which prices per (session, model)
// scope — booked the correct, smaller figure. One recommendation, two
// irreconcilable dollar amounts.
//
// Worse, provenance written from the COMMENT inherited the comment's meaning
// rather than the code's, laundering prose that was merely wrong into a
// structured, machine-readable claim that was authoritatively wrong. Output is
// now priced per (session, model) cell on the same weighted basis the cascade
// uses, so there is no single "dominant model" to name or to misdescribe.

/** Output tokens per model within one session — the pricing cell. */
function outputByModel(d: SessionTokenData): Map<string, number> {
  const perModel = new Map<string, number>();
  for (const e of d.entries) {
    const model = e.model || 'unknown';
    perModel.set(model, (perModel.get(model) ?? 0) + e.outputTokens);
  }
  return perModel;
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

    /** A session whose prose measurement can actually support a claim. */
    interface UsableSession {
      d: SessionTokenData;
      /** Unbounded proxy. Equal to `proseTokens` by construction here, since a
       *  session where the two differ is saturated and never reaches this list
       *  — published so that equality is verifiable rather than assumed. */
      rawTokens: number;
      proseTokens: number;
      totalOutput: number;
      tailTurns: number;
    }
    const usable: UsableSession[] = [];
    /**
     * Sessions where the prose proxy SATURATED — parsed assistant text implies
     * more prose tokens than the session's entire billed output.
     *
     * These are EXCLUDED from every figure, not merely disclosed. The cap
     * proves an upper bound and nothing more: it cannot support the claim that
     * non-prose output was excluded, so booking 40% of a session's whole output
     * bill off the back of it is an invented saving. Disclosing the cap while
     * still booking the dollars was the defect — disclosure is not exclusion.
     * They are counted so a consumer can see the rejection.
     */
    let cappedSessions = 0;

    const consider = (af: AssistantFeatures) => {
      const d = tokenBySession.get(af.sessionId);
      if (!d) return;
      let totalOutput = 0;
      for (const e of d.entries) totalOutput += e.outputTokens;
      if (totalOutput <= 0) return;
      const rawTokens = af.textLength / CHARS_PER_TOKEN;
      const proseTokens = Math.min(rawTokens, totalOutput);
      const proseShare = proseTokens / totalOutput;
      if (proseShare < PROSE_SHARE_FLOOR || proseTokens < MIN_PROSE_TOKENS) return;
      if (rawTokens > totalOutput) {
        cappedSessions += 1;
        return;
      }
      usable.push({
        d,
        rawTokens,
        proseTokens,
        totalOutput,
        // Reported-only cache tail: compressed prose also shrinks cached
        // history. The MAX_TAIL_TURNS clamp only ever makes this figure
        // SMALLER, it is labelled an estimate, and it is not booked — so unlike
        // the prose cap its activation cannot inflate a claim. Adjudicated
        // during the saturation sweep and kept as a conservative under-estimate.
        tailTurns: Math.min(MAX_TAIL_TURNS, Math.max(0, d.entries.length - 1)),
      });
    };
    for (const af of feats) consider(af);

    const coverage: EvidenceCoverage = { usable: usable.length, excluded: cappedSessions };

    // Genuinely nothing here — no prose-heavy session at all. Stay silent
    // rather than manufacture a card where none would ever have appeared.
    if (coverageTotal(coverage) === 0) return null;

    // Every candidate was rejected. This is NOT the same as "there was nothing
    // verbose here", and an early `return null` would make the two identical to
    // a consumer. Emit the rejection as a data-quality signal under the same id:
    // no dollars, no reclaim, no fix — there is no sized opportunity to offer.
    if (isFullyExcluded(coverage)) {
      return {
        id: 'cost.output-verbosity',
        category: 'cost',
        severity: 'info',
        title: 'Prose output could not be sized in any candidate session',
        detail:
          `${coverage.excluded} prose-heavy session(s) were found, but in every one the parsed ` +
          `assistant text implies more prose tokens than the session's entire billed output, so ` +
          `the prose proxy is saturated and can only bound the figure, not measure it. No saving ` +
          `is claimed. This is reported rather than passed over in silence because "every ` +
          `candidate was rejected" is a different fact from "no verbose output was found".`,
        action:
          'Treat prose-share figures for these sessions as unusable rather than low. This usually means assistant text was re-emitted into the transcript (compaction summaries, replayed history), so the character count no longer tracks billed output.',
        affected: coverage.excluded,
        evidence: [
          `${coverage.excluded} session(s) rejected: parsed prose proxy exceeds billed output tokens`,
        ],
        view: 'cost',
        provenance: {
          observations: [
            {
              claim: `${coverage.excluded} prose-heavy session(s) had a saturated prose proxy and were rejected`,
              source: 'parse-assistant-features + parse-sessions',
              field: `count(sessions where assistantFeatures[].textLength / ${CHARS_PER_TOKEN} > sum(tokenData[].entries[].outputTokens))`,
              value: coverage.excluded,
            },
            {
              claim: '0 session(s) had a usable prose measurement',
              source: 'parse-assistant-features + parse-sessions',
              field: 'count(prose-heavy sessions surviving the saturation check)',
              value: 0,
            },
          ],
          inference:
            'A character-count proxy that exceeds the billed output it is meant to approximate is ' +
            'not a low measurement, it is an invalid one: capping it would yield the whole output ' +
            'bill and compressing a fraction of that would invent a saving. With no session left ' +
            'to measure, the only honest output is the rejection itself.',
        },
      };
    }

    // ── Everything below is derived from `usable` only ───────────────────────
    let totalCompressibleTokens = 0;
    let inScopeOutputTokens = 0;
    let proseOutputTokens = 0;
    let rawProseTokens = 0;
    const scopeKeys = new Set<string>();
    for (const u of usable) {
      totalCompressibleTokens += u.proseTokens * COMPRESSION_FRAC;
      inScopeOutputTokens += u.totalOutput;
      proseOutputTokens += u.proseTokens;
      rawProseTokens += u.rawTokens;
      for (const e of u.d.entries) {
        scopeKeys.add(scopeKeyOf(u.d.sessionId, e.model || 'unknown'));
      }
    }
    const affected = usable.length;

    // Defensive only: `proseTokens` is bounded by each session's own output, so
    // `totalCompressibleTokens <= COMPRESSION_FRAC * inScopeOutputTokens` (0.4)
    // and this clamp is unreachable. Verified during the saturation sweep.
    const outputFrac =
      inScopeOutputTokens > 0 ? Math.min(1, totalCompressibleTokens / inScopeOutputTokens) : 0;

    /**
     * Price per (session, model) CELL, on exactly the basis the reclaim cascade
     * uses — the cascade scales each scope's output pool by `outputFrac` and
     * prices it at that scope's own model. Estimating from one "dominant" model
     * instead made the card's `estSavingsUsd` and its `reclaim` disagree by up
     * to 5x on a mixed-model session, so a consumer reading both got two
     * different answers from one recommendation.
     */
    let estSavingsUsd = 0;
    let tailUsd = 0;
    let unpricedOutputTokens = 0;
    for (const u of usable) {
      for (const [model, tokens] of outputByModel(u.d)) {
        const pricing = getModelPricing(model);
        const scaled = (tokens * outputFrac) / 1_000_000;
        estSavingsUsd += scaled * pricing.output;
        tailUsd += scaled * pricing.cacheRead * u.tailTurns;
        if (pricing.output <= 0) unpricedOutputTokens += tokens;
      }
    }

    // Honest-null: nothing worth saying when the prose lever is below the floor.
    if (estSavingsUsd < MIN_SAVINGS_USD) return null;

    // Book the DIRECT output-token saving only (output pool), at the conservative
    // compression fraction. The cascade's residual guard caps it at the real
    // output bill. No cacheRead pool here — that tail is the payload levers'.
    let reclaim: ReclaimClaim | undefined;
    if (totalCompressibleTokens > 0 && scopeKeys.size > 0 && inScopeOutputTokens > 0) {
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
        ` Prose only — tool-call JSON, code, and file payloads are excluded.` +
        (coverage.excluded > 0
          ? ` A further ${coverage.excluded} prose-heavy session(s) were EXCLUDED from this figure entirely: their parsed text implies more prose tokens than their whole billed output, so the proxy is saturated and can only bound the number, not measure it.`
          : '') +
        (unpricedOutputTokens > 0
          ? ` ~${Math.round(unpricedOutputTokens).toLocaleString()} output token(s) in the counted sessions ran on a model with no published rate and are priced at zero, so the dollar figure is a floor.`
          : ''),
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
        `~${Math.round(proseOutputTokens).toLocaleString()} prose output tokens across ${affected} verbose session(s)`,
        `compressible at ${Math.round(COMPRESSION_FRAC * 100)}% → ~${Math.round(
          totalCompressibleTokens
        ).toLocaleString()} output tokens (~${fmtUsd(estSavingsUsd)})`,
      ],
      view: 'cost',
      provenance: {
        // One figure per observation, each naming EVERY artifact its formula
        // reads (#3200, Codex #5). The earlier pass still failed both: the
        // pricing observation cited `getModelPricing().output` and stored a
        // token count, and the capped-basis observation named only
        // parse-assistant-features while its formula also reads tokenData — so
        // neither number could be reproduced from what it cited. The schema
        // validator passes all of that, because it checks that a claim CITES a
        // field, not that the field yields the value. The chain is now laid out
        // as raw -> bill -> bound -> compressible -> dollars, so each step's
        // operands are visible and a reader can redo the arithmetic.
        observations: [
          {
            claim: `${affected} session(s) where prose is at least ${Math.round(PROSE_SHARE_FLOOR * 100)}% of billed output tokens`,
            source: 'parse-assistant-features',
            field: 'assistantFeatures[].textLength (text blocks only)',
            value: affected,
          },
          {
            claim: `~${Math.round(rawProseTokens).toLocaleString()} raw prose proxy tokens before any bound, over the ${affected} usable session(s)`,
            source: 'parse-assistant-features',
            field: `sum(assistantFeatures[].textLength over the usable session(s)) / ${CHARS_PER_TOKEN}`,
            value: Math.round(rawProseTokens),
          },
          {
            claim: `~${Math.round(inScopeOutputTokens).toLocaleString()} billed output tokens in the same sessions`,
            source: 'parse-sessions',
            field: 'sum(tokenData[].entries[].outputTokens)',
            value: Math.round(inScopeOutputTokens),
          },
          {
            claim: `~${Math.round(proseOutputTokens).toLocaleString()} prose output tokens after bounding each usable session at its own bill`,
            source: 'parse-assistant-features + parse-sessions',
            field: `sum(min(assistantFeatures[].textLength / ${CHARS_PER_TOKEN}, sum(tokenData[].entries[].outputTokens)) per usable session)`,
            value: Math.round(proseOutputTokens),
          },
          {
            claim: `${coverage.excluded} further prose-heavy session(s) were excluded because their raw prose proxy exceeded their billed output tokens, so the bound would have saturated`,
            source: 'parse-assistant-features + parse-sessions',
            field: `count(sessions where assistantFeatures[].textLength / ${CHARS_PER_TOKEN} > sum(tokenData[].entries[].outputTokens))`,
            value: coverage.excluded,
          },
          {
            claim: `~${Math.round(totalCompressibleTokens).toLocaleString()} of those tokens treated as compressible`,
            source: 'parse-assistant-features + parse-sessions',
            field: `bounded prose tokens x COMPRESSION_FRAC (${COMPRESSION_FRAC})`,
            value: Math.round(totalCompressibleTokens),
          },
          {
            claim: `compressible output scaled by ${outputFrac.toFixed(6)} of each session-and-model output cell`,
            source: 'parse-sessions',
            field: 'totalCompressibleTokens / sum(tokenData[].entries[].outputTokens)',
            value: Math.round(outputFrac * 1_000_000) / 1_000_000,
          },
          {
            claim: `~${fmtUsd(estSavingsUsd)} booked, each (session, model) output cell priced at its own model rate`,
            source: 'pricing',
            field:
              'sum over (session, model) of outputTokens x outputFrac x getModelPricing(model).output — the same weighted basis the reclaim cascade books',
            value: Math.round(estSavingsUsd * 100) / 100,
          },
          {
            claim: `~${Math.round(unpricedOutputTokens).toLocaleString()} counted output token(s) had no published rate and priced at zero`,
            source: 'pricing',
            field: 'sum(outputTokens where getModelPricing(model).output <= 0)',
            value: Math.round(unpricedOutputTokens),
          },
        ],
        inference:
          'Assistant text blocks (prose) are a compressible slice of output tokens; trimming filler at a conservative fraction saves output spend. Sized prose-only (tool-call JSON / code / file payloads excluded) and well below the unproven ~75% self-claim — a causal caveman-vs-normal replay axis is tracked separately to measure the real effect and any rework cost. Sessions whose text proxy exceeds their billed output are excluded rather than capped, because a saturated proxy bounds the prose figure without measuring it; the dollar figure is priced per (session, model) cell on the same weighted basis the reclaim cascade books, so the two cannot disagree.',
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
