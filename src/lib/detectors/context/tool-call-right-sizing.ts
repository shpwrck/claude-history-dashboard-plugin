import type { Detector } from '../types';
import { scopeKeyOf, type ReclaimClaim } from '../../reclaim';
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
 * The payload is cache-read on every later turn, so the waste compounds across
 * the session — the steady-state tax that `context.compaction-large-tool-outputs`
 * misses (it only fires once a payload forces a compaction). We book the
 * cache-compounded tail as a `scaleTokens` reclaim against the `cacheRead` pool
 * under the `structural-prefix` cause; the cascade runs that AFTER
 * `workflow.native-bypass`'s `input`-pool lever and we exclude native-bypass Bash
 * calls upstream, so the same bytes are never double-claimed (acceptance #1924).
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
  dataDeps: ['toolData', 'tokenData'],
  rule(input) {
    const a = toolPayloadRightSizing(input.toolData);
    if (a.totalAffected < MIN_AFFECTED_CALLS) return null;
    if (a.totalExcessTokens < MIN_EXCESS_TOKENS) return null;

    // Cache-compounded tail → a scaleTokens deletion against the affected
    // sessions' cacheRead pool. Mirrors native-bypass's per-pool byte lever
    // (#951): resolve real priced (session, model) cells; the cascade's
    // `residual ≥ 0` guard caps the reclaim at the real cache-read bill. Needs
    // tokenData to resolve priced cells — absent ⇒ no claim (rec still surfaces).
    //
    // Per-session cap (review #1924): the compounded tail is a forward
    // PROJECTION (excess tokens × remaining turns) that can exceed a session's
    // actual cacheRead bill when the turn-count proxy over-counts or the payload
    // was compacted early. Cap each session's claim at its OWN real cacheRead
    // before summing, so one session's projection can't inflate the global frac
    // applied to other sessions' pools — the claim stays bounded by the real
    // per-session bill, not just the aggregate residual guard.
    const cacheReadBySession = new Map<string, number>();
    const scopeKeysBySession = new Map<string, string[]>();
    for (const d of input.tokenData ?? []) {
      let cacheRead = 0;
      const keys: string[] = [];
      for (const e of d.entries) {
        cacheRead += e.cacheReadTokens;
        keys.push(scopeKeyOf(d.sessionId, e.model || 'unknown'));
      }
      cacheReadBySession.set(d.sessionId, cacheRead);
      scopeKeysBySession.set(d.sessionId, keys);
    }
    const scopeKeys = new Set<string>();
    let inScopeCacheRead = 0;
    let claimTokens = 0;
    for (const s of a.byScope) {
      const sessionCacheRead = cacheReadBySession.get(s.sessionId);
      if (!sessionCacheRead) continue; // no priced cacheRead cell for this session
      const capped = Math.min(s.excessCacheReadTokens, sessionCacheRead);
      if (capped <= 0) continue;
      claimTokens += capped;
      inScopeCacheRead += sessionCacheRead;
      for (const k of scopeKeysBySession.get(s.sessionId) ?? []) scopeKeys.add(k);
    }

    let reclaim: ReclaimClaim | undefined;
    if (claimTokens > 0 && scopeKeys.size > 0 && inScopeCacheRead > 0) {
      const frac = Math.min(1, claimTokens / inScopeCacheRead);
      reclaim = {
        leverId: 'context.tool-call-right-sizing',
        category: 'context',
        // Structural cache-layout bloat, not a behavioural redo — runs in the
        // structural band [40,90), AFTER the behavioural causes have carved their
        // slices (native-bypass is workflow-rework, band 30).
        cause: 'structural-prefix',
        orderKey: 42,
        ownedPools: ['cacheRead'],
        scopeKeys: [...scopeKeys],
        counterfactual: { kind: 'scaleTokens', poolDeltaFrac: { cacheRead: frac } },
        evidenceTokens: Math.round(claimTokens),
      };
    }

    // Evidence: the prescriptive per-tool payload ranking (top offenders) plus
    // the single largest over-fetch read.
    const evidence: string[] = [];
    for (const t of a.verboseTools.slice(0, 3)) evidence.push(rankingRow(t));
    if (a.topOverFetch.length > 0) {
      const top = a.topOverFetch[0];
      evidence.push(
        `Over-fetch: ${top.sessionId.slice(0, 8)} loaded ${kb(top.resultBytes)} in one Read`
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
        )}) where an offset/limit or Grep slice would return a fraction`
      );
    }
    if (verboseNames.length > 0) {
      detailParts.push(
        `chronically verbose used tools (${verboseNames.join(', ')}) return bloated payloads call after call`
      );
    }
    const detail =
      `${a.totalAffected} tool calls pulled far more into context than the task used` +
      (detailParts.length > 0 ? ` — ${detailParts.join('; ')}.` : '.') +
      ` Those bytes are cache-read on every later turn, compounding ~${Math.round(
        a.totalExcessTokens
      ).toLocaleString()} cache-read tokens.`;

    return {
      id: 'context.tool-call-right-sizing',
      category: 'context',
      severity: 'info',
      title: 'Right-size large tool-call payloads',
      detail,
      action:
        'Read with offset/limit (or Grep) for targeted slices instead of whole files; add output-limiting flags / pagination / projection to verbose commands and MCP tools (e.g. a `head`/`--quiet`/`jq` projection) so each call returns only what gets used.',
      ...(reclaim ? { reclaim } : {}),
      affected: a.totalAffected,
      evidence,
      view: 'tools',
      provenance: {
        observations: [
          {
            claim: `${a.totalAffected} tool calls returned payloads larger than a targeted alternative would`,
            source: 'parse-tools',
            field: 'toolData[].calls[].resultBytes',
            value: a.totalAffected,
          },
          ...(a.overFetchCount > 0
            ? [
                {
                  claim: `${a.overFetchCount} Read call(s) returned ≥ ${FAT_READ_BYTES} chars (largest ${a.topOverFetch[0].resultBytes})`,
                  source: 'parse-tools',
                  field: 'toolData[].calls[].resultBytes',
                  value: a.topOverFetch[0].resultBytes,
                },
              ]
            : []),
          ...(a.verboseTools.length > 0
            ? [
                {
                  claim: `${a.verboseTools.length} used tool(s) average ≥ ${VERBOSE_AVG_BYTES} chars/call`,
                  source: 'parse-tools',
                  field: 'toolData[].calls[].resultBytes',
                  value: a.verboseTools.length,
                },
              ]
            : []),
        ],
        inference:
          'Result payloads above a targeted-alternative baseline are cache-read on every subsequent turn, so trimming them removes a compounding cache-read tail.',
      },
    };
  },
};
