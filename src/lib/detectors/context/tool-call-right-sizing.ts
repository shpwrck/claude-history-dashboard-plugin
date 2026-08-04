import type { Detector } from '../types';
import {
  toolPayloadRightSizing,
  VERBOSE_AVG_BYTES,
  FAT_READ_BYTES,
  type ToolPayloadRanking,
} from '../../parse-tools';

/**
 * `context.tool-call-right-sizing` (#1924) — flag tool calls that pull far more
 * into context than the task needed, and dollarize trimming them.
 *
 * Two faces (computed in `toolPayloadRightSizing`):
 *  1. First-call over-fetch — a whole-file `Read` whose payload is large where an
 *     offset/limit or `Grep` slice would have returned a fraction.
 *  2. Chronically verbose used tools — MCP + Bash tools whose return payloads are
 *     bloated call after call.
 *
 * If the payload stays in context it is cache-read on later turns, so the waste
 * can compound across the session — the steady-state tax that
 * `context.compaction-large-tool-outputs` misses (it only fires once a payload
 * forces a compaction). But `resultBytes` alone does NOT establish what the task
 * used, that a smaller targeted slice was actually available, or how many later
 * model turns re-read the payload — so this detector reports a HEURISTIC CANDIDATE
 * and a PROJECTED UPPER BOUND (excess bytes x a per-call turn-count proxy) and
 * does NOT book a deterministic reclaim (#3190). Booking that would need
 * turn-level cache attribution the transcript does not carry.
 */

/** Noise floors — stay silent below a handful of calls / a trivial tail. */
const MIN_AFFECTED_CALLS = 3;
const MIN_EXCESS_TOKENS = 1_000;

/** Human-readable KB for a byte count. */
function kb(bytes: number): string {
  return `${(bytes / 1000).toFixed(1)} KB`;
}

/** "12 calls averaging 18.0 KB/call" */
function rankingRow(r: ToolPayloadRanking): string {
  return `${r.toolName}: ${r.calls} calls averaging ${kb(r.avgResultBytes)}/call`;
}

export const detector: Detector = {
  id: 'context.tool-call-right-sizing',
  category: 'context',
  dataDeps: ['toolData'],
  rule(input) {
    const a = toolPayloadRightSizing(input.toolData);
    if (a.totalAffected < MIN_AFFECTED_CALLS) return null;
    if (a.totalExcessTokens < MIN_EXCESS_TOKENS) return null;

    // #3190: `resultBytes` alone establishes neither task usage, an actually
    // available smaller slice, nor the number of later model turns. So we do NOT
    // book a reclaim from it — the compounded figure is a PROJECTION (excess
    // bytes x a per-call turn-count proxy), not observed per-turn cache-read
    // attribution. It is surfaced as a heuristic candidate + projected upper
    // bound, never a deterministic saving.

    // Evidence: the prescriptive per-tool payload ranking (top offenders) plus
    // the single largest candidate over-fetch read.
    const evidence: string[] = [];
    for (const t of a.verboseTools.slice(0, 3)) evidence.push(rankingRow(t));
    if (a.topOverFetch.length > 0) {
      const top = a.topOverFetch[0];
      evidence.push(
        `Largest single Read payload: ${top.sessionId.slice(0, 8)} loaded ${kb(top.resultBytes)} in one Read (candidate over-fetch)`
      );
    }
    if (evidence.length === 0 && a.ranking.length > 0) {
      evidence.push(rankingRow(a.ranking[0]));
    }

    const verboseNames = a.verboseTools.map((t) => t.toolName).slice(0, 3);
    const detailParts: string[] = [];
    if (a.overFetchCount > 0) {
      detailParts.push(
        `${a.overFetchCount} Read call(s) loaded a whole file (largest ${kb(
          a.topOverFetch[0].resultBytes
        )}) above the ${FAT_READ_BYTES}-char threshold`
      );
    }
    if (verboseNames.length > 0) {
      detailParts.push(
        `chronically verbose used tools (${verboseNames.join(', ')}) return large payloads call after call`
      );
    }
    const detail =
      `${a.totalAffected} tool call(s) returned large payloads — heuristic candidates for over-fetch, flagged by fixed byte thresholds` +
      (detailParts.length > 0 ? ` — ${detailParts.join('; ')}.` : '.') +
      ` If each large payload stays in context for the rest of its session, that projects to a rough upper bound of ~${Math.round(
        a.totalExcessTokens
      ).toLocaleString()} cache-read tokens — an estimate from a per-call turn-count proxy, not observed cache-read attribution.`;

    return {
      id: 'context.tool-call-right-sizing',
      category: 'context',
      severity: 'info',
      title: 'Right-size large tool-call payloads',
      detail,
      action:
        'Read with offset/limit (or Grep) for targeted slices instead of whole files; add output-limiting flags / pagination / projection to verbose commands and MCP tools (e.g. a `head`/`--quiet`/`jq` projection) so each call returns only what gets used.',
      affected: a.totalAffected,
      evidence,
      view: 'tools',
      provenance: {
        observations: [
          {
            claim: `${a.totalAffected} tool call(s) returned payloads above fixed size thresholds (heuristic candidates for over-fetch)`,
            source: 'parse-tools',
            field: 'toolData[].calls[].resultBytes',
            value: a.totalAffected,
          },
          ...(a.overFetchCount > 0
            ? [
                {
                  claim: `${a.overFetchCount} Read call(s) returned >= ${FAT_READ_BYTES} chars (largest ${a.topOverFetch[0].resultBytes})`,
                  source: 'parse-tools',
                  field: 'toolData[].calls[].resultBytes',
                  value: a.topOverFetch[0].resultBytes,
                },
              ]
            : []),
          ...(a.verboseTools.length > 0
            ? [
                {
                  claim: `${a.verboseTools.length} used tool(s) average >= ${VERBOSE_AVG_BYTES} chars/call`,
                  source: 'parse-tools',
                  field: 'toolData[].calls[].resultBytes',
                  value: a.verboseTools.length,
                },
              ]
            : []),
          {
            claim: `projected cache-read upper bound ~${Math.round(a.totalExcessTokens).toLocaleString()} tokens (excess bytes x a per-call turn-count proxy)`,
            source: 'parse-tools',
            field: 'toolData[].calls[].resultBytes x subsequent tool-call count',
            value: Math.round(a.totalExcessTokens),
          },
        ],
        inference:
          'Payload size above a fixed byte threshold is a HEURISTIC CANDIDATE for over-fetch: resultBytes alone does not establish what the task used, that a smaller targeted slice was actually available, or how many later model turns re-read the payload. The compounded cache-read figure is therefore a PROJECTED UPPER BOUND from the count of subsequent tool calls (a turn-count proxy), not observed per-turn cache-read attribution — an estimate, not a booked reclaim.',
      },
    };
  },
};
