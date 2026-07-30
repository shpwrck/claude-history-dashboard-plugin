import type { Detector } from '../types';
import { aggregateInventory } from '../../parse-tool-inventory';
import {
  newestIsoDate,
  STALE_WEEKS,
  isPartialCoverage,
  type EvidenceCoverage,
} from '../shared';
import { isAsOfStale } from '../provenance';
import type { ReclaimClaim } from '../../reclaim';

// MCP tools loaded across many sessions but never invoked. (#416)
//
// This detector used to add "each adds ~50-200 tokens to the tool manifest on
// every turn" to both its detail and its inference. Nothing it reads measures
// manifest token size: `ToolInventory` carries tool NAMES and usage counts, and
// `aggregateInventory` only counts loaded-vs-invoked slots. The range was a
// plausible guess published as a measurement, so it is gone rather than
// re-sourced — the observed fact is the utilization, and that is what is
// claimed. (#3197)
const MIN_NEVER_USED_SESSIONS = 3;

/**
 * How old the inventory may be before the finding is demoted to a dated lead.
 *
 * Same window every other historical-evidence detector demotes against
 * (`STALE_WEEKS * 7`), so a reader is not comparing two different definitions
 * of "stale" across two cards.
 */
const INVENTORY_STALE_DAYS = STALE_WEEKS * 7;

/** Bare server name from an `mcp__<server>__<tool>` manifest entry. */
function mcpServer(toolName: string): string | null {
  const m = /^mcp__([^_]+(?:_[^_]+)*?)__/.exec(toolName);
  return m ? m[1] : null;
}

/** Flag never-invoked MCP tools loaded in 3+ sessions. (#416) */
export const detector: Detector = {
  id: 'cost.idle-mcp-tools',
  category: 'cost',
  // `tokenData` is a DATING dep, not a measurement one (#3197): the inventory
  // itself carries no timestamp, so the only honest anchor for "as of when was
  // this observed" is the newest turn in the sessions the inventory was built
  // from. Declared so the absent-evidence contract sees what is actually read.
  dataDeps: ['toolInventories', 'liveConfig', 'tokenData'],
  rule(input, now) {
    const inv = input.toolInventories;
    if (!inv || inv.length === 0) return null;
    let idle = aggregateInventory(inv).unusedByFrequency.filter(
      (r) => r.toolName.startsWith('mcp__') && r.usedIn === 0 && r.neverUsed >= MIN_NEVER_USED_SESSIONS
    );
    if (idle.length === 0) return null;

    // Stale-input reconciliation (#1102): the idle tools are HISTORICAL. The
    // remediation ("remove the MCP server") only applies to servers still
    // present in the current config — advising removal of a server already gone
    // from ~/.claude.json is a stale, misleading fix. When the bundle is
    // readable, keep only idle tools whose backing server is still configured;
    // if that empties the set, the user has already remediated → suppress.
    // `null` liveConfig means "can't tell" → don't filter (don't hide a real
    // finding on an unreadable config).
    const configReadable = input.liveConfig != null;
    const currentServers = new Set((input.liveConfig?.mcpServers ?? []).map((s) => s.id));
    if (configReadable) {
      idle = idle.filter((r) => {
        const srv = mcpServer(r.toolName);
        return srv != null && currentServers.has(srv);
      });
      if (idle.length === 0) return null;
    }

    const servers = Array.from(
      new Set(idle.map((r) => mcpServer(r.toolName)).filter((s): s is string => Boolean(s)))
    );

    // ── Dating the evidence (#3197) ──────────────────────────────────────────
    //
    // "Loaded N times, never invoked" is only knowable once a whole session has
    // been observed, so the newest turn across the INVENTORY's own sessions is
    // the correct anchor — and it comes from the data, never from `now`. The
    // denominator is every inventory (that is what `aggregateInventory` counts
    // over), so the join spans all of them, not just the idle rows' sessions.
    //
    // `undefined` when no inventory session has a readable turn: the evidence
    // is real but undatable, and inventing today's date would assert a
    // freshness the corpus does not have. That case is stated in the copy
    // rather than left to look like fresh evidence.
    // FOLD over the field being cited, not `idle[0]` (#3459 defect class 5).
    // `unusedByFrequency` happens to sort by `neverUsed`, but the claim below
    // is about `loadedIn` — reading a superlative off a list sorted by a
    // neighbouring field is how "the most-compacted session" reported 2 when
    // the true max was 5. A reduce cannot drift from the sort.
    const maxLoadedIn = idle.reduce((m, r) => Math.max(m, r.loadedIn), 0);

    // Newest readable turn per session, computed ONCE (the per-tool folds below
    // would otherwise rescan every token row per flagged tool).
    const sessionDate = new Map<string, string>();
    for (const d of input.tokenData ?? []) {
      const newest = newestIsoDate((d.entries ?? []).map((e) => e.timestamp));
      if (newest !== undefined) sessionDate.set(d.sessionId, newest);
    }

    /**
     * Newest date among the sessions that ACTUALLY LOADED `toolName`.
     *
     * The first version of this join used every inventory session, which let a
     * session that never loaded the tool certify its evidence: three
     * January-2025 sessions holding an idle `foo` plus one unrelated July-2026
     * inventory produced "As of 2026-07-29, stale=false". That is the very
     * defect this detector was being fixed for, rebuilt one layer down —
     * freshness has to come from the rows that carry the claim.
     */
    const newestForTool = (toolName: string): string | undefined => {
      let best: string | undefined;
      for (const i of inv) {
        if (!i.toolsAvailable.includes(toolName)) continue;
        const d = sessionDate.get(i.sessionId);
        // ISO YYYY-MM-DD is lexicographically ordered, so `>` is a real
        // date comparison here.
        if (d !== undefined && (best === undefined || d > best)) best = d;
      }
      return best;
    };

    const perTool = idle.map((r) => newestForTool(r.toolName));
    const datedTools = perTool.filter((d): d is string => d !== undefined);
    const dateCoverage: EvidenceCoverage = {
      usable: datedTools.length,
      excluded: perTool.length - datedTools.length,
    };
    const undatedTools = dateCoverage.excluded;
    /**
     * The aggregate `asOf` — derivable ONLY when every flagged tool is dated.
     *
     * Two rules, both learned the hard way on this one field:
     *
     *  - Where it IS derivable it folds to the STALEST flagged tool, because
     *    the card makes one claim about all of them and cannot be fresher than
     *    its weakest member. A `reduce`, never `[0]` of a list sorted by
     *    something else.
     *  - Where coverage is PARTIAL it is not derivable at all. Filtering the
     *    undated tools out and dating the survivors published `stale: false`
     *    across a half-observed population: the prose said "1 of 2 could not be
     *    dated" while the structured field — the one machine consumers read —
     *    certified the whole finding as current. Dropping a row before deriving
     *    a claim is the same defect as never noticing the row.
     */
    const asOf =
      isPartialCoverage(dateCoverage) || datedTools.length === 0
        ? undefined
        : datedTools.reduce((min, d) => (d < min ? d : min), datedTools[0]);
    const stale = asOf !== undefined ? isAsOfStale(asOf, now, INVENTORY_STALE_DAYS) : undefined;
    // Both the date and its ABSENCE are rendered. A silent omission would make
    // undatable evidence read exactly like fresh evidence, which is the same
    // failure as the missing `asOf` this finding is about.
    const datePrefix = asOf === undefined ? '' : `As of ${asOf}, `;
    const coverageNote =
      undatedTools > 0
        ? ` ${undatedTools} of ${perTool.length} flagged tool(s) could not be dated at all — no readable turn in any session that loaded them — so their evidence is undated rather than current.`
        : '';
    const partialNote =
      isPartialCoverage(dateCoverage) && dateCoverage.usable > 0
        ? ` No overall as-of date is asserted while coverage is partial, even though ${dateCoverage.usable} of them could be dated.`
        : '';
    const dateNote =
      (asOf === undefined
        ? ' The tool inventory could not be dated (undated evidence), so confirm it still holds before acting.'
        : stale
          ? ` That is older than ${INVENTORY_STALE_DAYS} days, so this is a historical lead to confirm live, no longer a current reading.`
          : '') +
      coverageNote +
      partialNote;
    // Flag-only in the closed PR1 cascade: the wasted tokens are tool-manifest
    // re-reads that the dashboard cannot map to a priced `(scope,pool)` cell
    // deterministically (no per-turn manifest-token ledger). Books $0; carries
    // the idle-tool count as evidence for per-category coverage.
    const reclaim: ReclaimClaim = {
      leverId: 'cost.idle-mcp-tools',
      category: 'cost',
      orderKey: 85,
      ownedPools: [],
      scopeKeys: [],
      counterfactual: { kind: 'flag-only' },
      evidenceTokens: 0,
    };
    return {
      id: 'cost.idle-mcp-tools',
      category: 'cost',
      severity: 'info',
      title: 'Remove MCP tools loaded but never invoked',
      detail: `${datePrefix}${idle.length} MCP tool(s) were loaded in ${MIN_NEVER_USED_SESSIONS}+ sessions yet invoked zero times.${dateNote}`,
      action:
        'Disable or remove the MCP server(s) backing the never-used tool(s) from ~/.claude.json (or scope them to the projects that need them).',
      reclaim,
      affected: idle.length,
      evidence: idle.slice(0, 5).map((r) => `${r.toolName} — loaded in ${r.loadedIn}, used 0`),
      provenance: {
        observations: [
          {
            claim: `${idle.length} MCP tool(s) loaded in ${MIN_NEVER_USED_SESSIONS}+ sessions, invoked 0 times`,
            source: 'parse-tool-inventory',
            field: 'aggregateInventory().unusedByFrequency (usedIn === 0)',
            value: idle.length,
          },
          {
            // The utilization fact itself, with the count the threshold was
            // actually compared against — `neverUsed` for the worst offender.
            claim: `the most-loaded idle tool was loaded in ${maxLoadedIn} session(s) and invoked in none`,
            source: 'parse-tool-inventory',
            field: 'max(aggregateInventory().unusedByFrequency[].loadedIn) where usedIn === 0',
            value: maxLoadedIn,
          },
          {
            claim: configReadable
              ? `backing server(s) still configured: ${servers.join(', ') || '(none)'}`
              : 'current MCP config could not be read; server list not reconciled',
            source: '~/.claude.json',
            field: 'mcpServers[].id',
          },
          {
            // Date COVERAGE, stated whether or not any tool is undated. A
            // coverage figure that only appears when it is bad is a figure a
            // reader cannot calibrate against.
            claim: `${undatedTools} of ${perTool.length} flagged tool(s) could not be dated from any session that loaded them`,
            source: 'parse-sessions',
            field:
              'count(flagged tools with no readable tokenData[].entries[].timestamp in any inventory session that lists the tool)',
            value: undatedTools,
          },
        ],
        // #3197: the per-tool manifest overhead is NOT observed here, so the
        // inference no longer quotes a figure for it. What is observed is that
        // the tools were loaded and never invoked; that a loaded tool costs
        // manifest tokens is a property of the protocol, and how many is
        // unmeasured by anything in this input.
        inference:
          'A tool that is loaded but never invoked contributes its manifest entry to every ' +
          'turn of every session that loads it and returns nothing for it; removing the ' +
          'still-configured backing server(s) removes that entry. The per-tool token cost of ' +
          'a manifest entry is not measured by the tool inventory, so no figure is claimed ' +
          'for it here.',
        ...(asOf !== undefined ? { asOf, stale } : {}),
      },
      view: 'tools',
      fix: {
        target: 'command',
        label: 'Disable idle MCP servers',
        note: `Remove or scope these mcpServers in ~/.claude.json (or move them into a per-project .mcp.json). Servers with no invoked tools: ${servers.join(', ') || '(see evidence)'}.`,
        snippet: servers.length
          ? `# In ~/.claude.json, delete the "mcpServers" entries for:\n${servers.map((s) => `#   - ${s}`).join('\n')}`
          : '# In ~/.claude.json, delete the unused "mcpServers" entries (see the tool names above).',
      },
    };
  },
};
