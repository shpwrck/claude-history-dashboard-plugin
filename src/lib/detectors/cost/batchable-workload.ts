import type { Detector } from '../types';
import type { SessionTokenData } from '../../../types';
import { fmtUsd, MIN_SAVINGS_USD, short } from '../shared';
import { isUnattendedEntrypoint } from '../../parse-sessions';
import { getModelPricing } from '../../pricing';
import { scopeKeyOf, type ReclaimClaim } from '../../reclaim';

/**
 * `cost.batchable-workload` (#1755) — flag token-heavy, latency-insensitive
 * workloads that could route through the Anthropic Batch API for a deterministic
 * ~50% cut on standard input/output tokens, and dollarize the recoverable spend.
 *
 * Batch API is named as the single biggest deterministic cost cut on the board.
 * The lever applies only where the workload tolerates async (up-to-24h) turnaround
 * — so latency-insensitivity is inferred conservatively from the **unattended**
 * (`sdk-*`) entrypoint (no human waiting on the turn), with `scheduledFires`
 * (cron wakeups) raising confidence. It discounts standard input/output only;
 * cache reads/writes are NOT batch-discounted, so they are excluded from the
 * dollar figure.
 *
 * DEDUP: `cost.automation-share` shows a non-booked same-token model-swap
 * ceiling for these sessions. Batch remains the booked claim: orderKey 82,
 * `scaleTokens` on input+output only. The cascade's residual guard handles any
 * other booked claims without treating the automation ceiling as realized.
 * The actual `batch-route` shadow-calls axis is a SEPARATE meta follow-on.
 */

/** Batch API standard input/output discount (cache pools are NOT discounted). */
const BATCH_DISCOUNT = 0.5;
/** Per-session input+output token floor below which batching isn't worth flagging. */
const MIN_BATCHABLE_TOKENS = 50_000;

/** Standard (non-cache) input+output USD for one session at its own model rates. */
function ioCost(d: SessionTokenData): number {
  let usd = 0;
  for (const e of d.entries) {
    const p = getModelPricing(e.model || 'unknown');
    usd += (e.inputTokens / 1_000_000) * p.input + (e.outputTokens / 1_000_000) * p.output;
  }
  return usd;
}

export const detector: Detector = {
  id: 'cost.batchable-workload',
  category: 'cost',
  dataDeps: ['tokenData', 'runtimeEvents'],
  rule(input) {
    const scheduledSessions = new Set(
      (input.runtimeEvents ?? [])
        .filter((r) => (r.scheduledFires?.length ?? 0) > 0)
        .map((r) => r.sessionId)
    );

    let estSavingsUsd = 0;
    let batchableIoCost = 0;
    let scheduledCount = 0;
    const scopeKeys = new Set<string>();
    const sessions: { id: string; usd: number; scheduled: boolean }[] = [];

    for (const d of input.tokenData ?? []) {
      if (!isUnattendedEntrypoint(d.entrypoint)) continue;
      const tokens = (d.totalInputTokens ?? 0) + (d.totalOutputTokens ?? 0);
      if (tokens < MIN_BATCHABLE_TOKENS) continue;
      const io = ioCost(d);
      if (io <= 0) continue;
      batchableIoCost += io;
      estSavingsUsd += io * BATCH_DISCOUNT;
      const scheduled = scheduledSessions.has(d.sessionId);
      if (scheduled) scheduledCount += 1;
      for (const e of d.entries) scopeKeys.add(scopeKeyOf(d.sessionId, e.model || 'unknown'));
      sessions.push({ id: d.sessionId, usd: io, scheduled });
    }

    if (sessions.length === 0 || estSavingsUsd < MIN_SAVINGS_USD) return null;

    sessions.sort((a, b) => b.usd - a.usd);

    // Flag-only (#3191). This previously booked a 50% cut on the input/output
    // pools of EVERY sufficiently large sdk-* session. The only eligibility
    // evidence available is the unattended entrypoint plus optional schedule
    // events, and neither shows the workload tolerates the Batch API's
    // up-to-24-hour turnaround — the action itself tells the user to confirm
    // that, so the booking was made before the condition it depends on was
    // checked. Latency-sensitive automation (a cron job whose output another
    // system waits on) is unattended and not batchable. The lever keeps its
    // evidence for per-category coverage and books $0 until an explicit
    // async-tolerance signal exists.
    const reclaim: ReclaimClaim = {
      leverId: 'cost.batchable-workload',
      category: 'cost',
      orderKey: 82,
      ownedPools: [],
      scopeKeys: [],
      counterfactual: { kind: 'flag-only' },
      evidenceTokens: 0,
    };

    const schedNote =
      scheduledCount > 0
        ? ` ${scheduledCount} of them fire on a schedule (scheduled_task_fire), strengthening the latency-insensitive read.`
        : '';

    return {
      id: 'cost.batchable-workload',
      category: 'cost',
      severity: 'info',
      title: 'Route batchable unattended workloads through the Batch API',
      detail:
        `${sessions.length} unattended (sdk-*) session(s) ran token-heavy, non-interactive work (` +
        `${fmtUsd(batchableIoCost)} in standard input/output spend). The Anthropic Batch API cuts standard ` +
        `input/output ~${Math.round(BATCH_DISCOUNT * 100)}% for async-tolerant workloads, which would be ~${fmtUsd(
          estSavingsUsd
        )} here IF every one of these workloads tolerates async turnaround — that eligibility is not established by anything measured here, so none of it is counted as recovered.` +
        schedNote +
        ` Cache reads/writes are excluded (not batch-discounted). cost.automation-share may show a separate same-token ceiling, but that ceiling is not booked into reclaim.`,
      action:
        'Route latency-insensitive unattended/scheduled runs (bulk replay/eval/analysis, non-interactive cron jobs) through the Batch API for ~50% off standard input/output. Confirm each workload tolerates async (up-to-24h) turnaround before switching.',
      // No estSavingsUsd (#3191) — see the reclaim comment. The ceiling above
      // is stated in the detail as conditional, and declared below as a
      // tier-0 estimate rather than a booked amount.
      savingsAttribution: {
        interventionKey: 'cost.batchable-workload',
        signatureId: 'batch-api-unattended-io',
        tier: 'tier-0-estimate',
        predictedSavingsUsd: estSavingsUsd,
        confidence: 'medium',
      },
      reclaim,
      affected: sessions.length,
      evidence: sessions
        .slice(0, 5)
        .map((s) => `${short(s.id)} — ${fmtUsd(s.usd)} io${s.scheduled ? ' (scheduled)' : ''}`),
      view: 'cost',
      provenance: {
        observations: [
          {
            claim: `${sessions.length} unattended (sdk-*) session(s) with >=${MIN_BATCHABLE_TOKENS.toLocaleString()} input+output tokens; ${fmtUsd(batchableIoCost)} standard io spend`,
            source: 'parse-sessions',
            field: 'tokenData[].entrypoint (isUnattendedEntrypoint) + entries[].input/outputTokens',
            value: sessions.length,
          },
          ...(scheduledCount > 0
            ? [
                {
                  claim: `${scheduledCount} of them carry scheduled_task_fire events (scheduled/cron cadence)`,
                  source: 'parse-runtime-events',
                  field: 'runtimeEvents[].scheduledFires',
                  value: scheduledCount,
                },
              ]
            : []),
        ],
        inference:
          'Unattended (sdk-*) token-heavy work is a CANDIDATE for the Batch API, which cuts standard input/output ~50% (cache pools excluded). Entrypoint and schedule cadence do not establish async tolerance: unattended work can still be latency-sensitive when another system consumes its output. The dollar is therefore a tier-0 opportunity ceiling conditional on unverified eligibility, and nothing is booked into reclaim.',
      },
    };
  },
};
