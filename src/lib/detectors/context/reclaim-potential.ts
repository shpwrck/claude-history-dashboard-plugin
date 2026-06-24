import type {
  Detector,
  AppliedMarkers,
  RecObservation,
  RecProvenance,
} from '../types';
import { claudeMdMarksApplied, MIN_SAVINGS_USD, fmtUsd } from '../shared';
import { getModelPricing, CHEAPEST_MODEL } from '../../pricing';
import type { ToolCall } from '../../parse-tools';
import type { SessionTokenData, Session } from '../../../types';

/**
 * Native context-reclaim-potential MEASUREMENT (#1758, epic #1911).
 *
 * The decided competitive response to the headroom tool: rather than vendor a
 * license-unstated ML model whose 60-95% "headroom" headline did NOT survive a
 * local trial on real `~/.claude` data (~11.5% ML / ~5% deterministic), ship a
 * DETERMINISTIC, ML-free counter of context that is provably compressible or
 * removable. (The ML estimate is explicitly DEFERRED — a Future follow-up — so
 * the zero-node_modules server boot graph stays clean.)
 *
 * This detector owns ONLY the two reclaim buckets the file-Read detectors do
 * not, so no byte is double-booked across the engine:
 *
 *  (a) **Oversized / duplicate tool_result payloads.** Non-file-Read tool calls
 *      (Bash, Grep, Glob, Task, MCP, …) whose result was large, AND identical
 *      results re-fetched within a session (same tool + command fingerprint),
 *      each re-paying its ingestion. Sized from `ToolCall.resultBytes` (the
 *      char-count proxy) / 4.
 *  (b) **Re-pasted file content in user turns.** The same pasted block
 *      (`Session.entries[].pastedContents[].content`) appearing in 2+ user
 *      turns across the corpus — every repeat re-ingests the same bytes that
 *      one reference would have loaded once.
 *
 * EXPLICITLY EXCLUDED — owned elsewhere, asserted by a boundary test:
 *  - file-`Read` re-ingestion: `context.cross-session-reread` owns cross-session
 *    cold FIRST-reads of DOCUMENTATION files; `context.repo-map-context-waste`
 *    owns within-session repeats of STRUCTURAL code files. This detector skips
 *    every file tool (Read/Edit/Write/MultiEdit/NotebookEdit) entirely, so its
 *    reclaim set never overlaps theirs.
 *
 * The reclaim estimate is dollarized at the corpus's measured blended cache-read
 * residual rate (the way `repo-map-context-waste` / `cross-session-reread` book
 * against the cache-read pool — a conservative floor; genuinely-cold re-reads
 * would bill more), gated on a minimum dollar effect (`MIN_SAVINGS_USD`, never a
 * zero-impact finding), and carries structured `provenance` plus an `asOf`
 * trendline that demotes present-tense wording when the underlying data is stale.
 */

const MARKERS_RECLAIM_POTENTIAL: AppliedMarkers = {
  headings: [/^##\s+Context reclaim discipline\b/i],
  bodyPhrases: ['Cache or reference these large tool outputs and pasted blocks'],
};

/** File tools owned by the two file-Read detectors — never counted here (the
 *  non-overlap boundary). */
const FILE_TOOLS = new Set([
  'Read',
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
  'NotebookRead',
]);

/** Bytes->tokens heuristic, matching `parse-file-reread.ts` / cross-session-reread. */
const CHARS_PER_TOKEN = 4;

/**
 * A non-file tool result counts as OVERSIZED above this byte size (~5k tokens).
 * Below it the per-result ingestion is noise; the duplicate path still catches
 * repeated small results that compound.
 */
const OVERSIZED_RESULT_BYTES = 20_000;

/** Minimum distinct sessions / occurrences before a pasted block counts as
 *  re-pasted (re-ingested) rather than a one-off. */
const MIN_PASTE_REPEATS = 2;

/** How many candidate items to surface / name in the finding and the fix. */
const MAX_CANDIDATES = 5;

/** Trend window: data within this many days of `now` is "recent"; older sessions
 *  form the baseline. A finding whose newest contributing session is older than
 *  this is demoted to "as of <date>" (stale). */
const TREND_WINDOW_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

/** A normalized fingerprint for a non-file tool call, so identical re-fetches
 *  group together. Prefer the precomputed fingerprint; fall back to the tool +
 *  command/preview text. */
function callFingerprint(call: ToolCall): string {
  const key =
    call.commandFingerprint ??
    call.input?.command ??
    call.commandPreview ??
    '';
  return `${call.toolName}::${key}`;
}

/** Collapse a pasted block to a stable content key (whitespace-normalized). */
function pasteKey(content: string): string {
  return content.replace(/\s+/g, ' ').trim();
}

interface ToolItem {
  kind: 'oversized-output' | 'duplicate-output';
  label: string;
  reclaimTokens: number;
  occurrences: number;
  newestTs: number;
}

interface PasteItem {
  kind: 're-pasted-content';
  label: string;
  reclaimTokens: number;
  occurrences: number;
  newestTs: number;
}

type Item = ToolItem | PasteItem;

/**
 * Corpus blended cache-read price in USD per token. Mirrors
 * `cross-session-reread.cacheReadRatePerToken`: sum the per-entry cache-read
 * dollars over the cache-read tokens that carry a priced model, so the rate is
 * grounded in what the user really paid; fall back to the cheapest model's
 * cache-read rate when there are no priced cache reads (a conservative floor).
 */
function cacheReadRatePerToken(tokenData: SessionTokenData[]): number {
  let crTokens = 0;
  let crCost = 0;
  for (const d of tokenData) {
    for (const e of d.entries) {
      if (e.cacheReadTokens <= 0) continue;
      const price = getModelPricing(e.model || 'unknown').cacheRead; // $/MTok
      if (price <= 0) continue;
      crTokens += e.cacheReadTokens;
      crCost += (e.cacheReadTokens / 1_000_000) * price;
    }
  }
  if (crTokens > 0 && crCost > 0) return crCost / crTokens;
  return getModelPricing(CHEAPEST_MODEL).cacheRead / 1_000_000;
}

/** Session start-time index for trend bucketing (epoch ms by session id). */
function sessionStartIndex(sessions: Session[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const s of sessions) {
    if (typeof s.startTime === 'number' && s.startTime > 0) m.set(s.sessionId, s.startTime);
  }
  return m;
}

function tsMs(iso: string | undefined): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

export const detector: Detector = {
  id: 'context.reclaim-potential',
  appliedMarkers: MARKERS_RECLAIM_POTENTIAL,
  category: 'context',
  dataDeps: ['toolData', 'sessions', 'tokenData', 'liveConfig'],
  rule(input, now) {
    if (claudeMdMarksApplied(input.liveConfig, MARKERS_RECLAIM_POTENTIAL)) return null;
    const toolData = input.toolData ?? [];
    const sessions = input.sessions ?? [];
    const startIndex = sessionStartIndex(sessions);

    const toolItems: ToolItem[] = [];
    const pasteItems: PasteItem[] = [];

    // ── Bucket (a): oversized + duplicate non-file tool_result payloads ───────
    for (const session of toolData) {
      const sessionTs = startIndex.get(session.sessionId) ?? 0;
      // Group identical non-file calls within the session to find re-fetches.
      const groups = new Map<string, { count: number; bytes: number; toolName: string; ts: number }>();
      for (const call of session.calls) {
        if (FILE_TOOLS.has(call.toolName)) continue; // file-Read territory — excluded
        if (call.resultBytes <= 0) continue;
        const fp = callFingerprint(call);
        const g = groups.get(fp) ?? {
          count: 0,
          bytes: 0,
          toolName: call.toolName,
          ts: 0,
        };
        g.count += 1;
        g.bytes = Math.max(g.bytes, call.resultBytes); // representative size
        g.ts = Math.max(g.ts, tsMs(call.timestamp) || sessionTs);
        groups.set(fp, g);
      }

      for (const [fp, g] of groups) {
        const perCallTokens = Math.round(g.bytes / CHARS_PER_TOKEN);
        if (perCallTokens <= 0) continue;
        const newestTs = g.ts || sessionTs;
        const fpTail = fp.split('::').slice(1).join('::').trim();
        if (g.count >= 2) {
          // Duplicate: every repeat after the first re-pays the same ingestion.
          const reclaimTokens = perCallTokens * (g.count - 1);
          if (reclaimTokens <= 0) continue;
          toolItems.push({
            kind: 'duplicate-output',
            label: `${g.toolName} result re-fetched ${g.count}x${fpTail ? ` (${fpTail.slice(0, 48)})` : ''} — ~${perCallTokens.toLocaleString()} tok each`,
            reclaimTokens,
            occurrences: g.count - 1,
            newestTs,
          });
        } else if (g.bytes >= OVERSIZED_RESULT_BYTES) {
          // Oversized single result: a fraction is reclaimable by narrowing the
          // call (head/grep/limit) instead of dumping the whole payload. Book a
          // conservative half of the over-threshold tail, never the full result.
          const overTokens = Math.round((g.bytes - OVERSIZED_RESULT_BYTES) / CHARS_PER_TOKEN);
          const reclaimTokens = Math.round(overTokens / 2);
          if (reclaimTokens <= 0) continue;
          toolItems.push({
            kind: 'oversized-output',
            label: `${g.toolName} dumped a ~${perCallTokens.toLocaleString()}-tok result${fpTail ? ` (${fpTail.slice(0, 48)})` : ''} — narrow the call`,
            reclaimTokens,
            occurrences: 1,
            newestTs,
          });
        }
      }
    }

    // ── Bucket (b): re-pasted file content in user turns ──────────────────────
    // Aggregate identical pasted blocks across the whole corpus; a block pasted
    // N times re-ingests its bytes N times where one reference would load once.
    const pasteAgg = new Map<
      string,
      { count: number; bytes: number; sample: string; newestTs: number }
    >();
    for (const s of sessions) {
      const sessionTs = typeof s.startTime === 'number' ? s.startTime : 0;
      for (const entry of s.entries ?? []) {
        const pasted = entry.pastedContents;
        if (!pasted) continue;
        const ts = (typeof entry.timestamp === 'number' && entry.timestamp > 0
          ? entry.timestamp
          : sessionTs);
        for (const pc of Object.values(pasted)) {
          if (!pc || typeof pc.content !== 'string') continue;
          const key = pasteKey(pc.content);
          if (key.length === 0) continue;
          const a = pasteAgg.get(key) ?? {
            count: 0,
            bytes: 0,
            sample: key,
            newestTs: 0,
          };
          a.count += 1;
          a.bytes = Math.max(a.bytes, pc.content.length);
          a.newestTs = Math.max(a.newestTs, ts);
          pasteAgg.set(key, a);
        }
      }
    }

    for (const a of pasteAgg.values()) {
      if (a.count < MIN_PASTE_REPEATS) continue; // a one-off paste is not reclaim
      const perPasteTokens = Math.round(a.bytes / CHARS_PER_TOKEN);
      if (perPasteTokens <= 0) continue;
      const reclaimTokens = perPasteTokens * (a.count - 1); // repeats after the first
      if (reclaimTokens <= 0) continue;
      const preview = a.sample.slice(0, 40);
      pasteItems.push({
        kind: 're-pasted-content',
        label: `Pasted block re-pasted ${a.count}x — ~${perPasteTokens.toLocaleString()} tok each ("${preview}${a.sample.length > 40 ? '…' : ''}")`,
        reclaimTokens,
        occurrences: a.count - 1,
        newestTs: a.newestTs,
      });
    }

    const items: Item[] = [...toolItems, ...pasteItems];
    if (items.length === 0) return null;

    const totalReclaimTokens = items.reduce((s, it) => s + it.reclaimTokens, 0);
    if (totalReclaimTokens <= 0) return null;

    const rate = cacheReadRatePerToken(input.tokenData ?? []);
    const estSavingsUsd = totalReclaimTokens * rate;
    if (estSavingsUsd < MIN_SAVINGS_USD) return null; // min-effect gate — no zero-impact findings

    items.sort((x, y) => y.reclaimTokens - x.reclaimTokens);
    const top = items.slice(0, MAX_CANDIDATES);

    // ── Trendline (asOf + stale demotion) ─────────────────────────────────────
    // Split reclaim by recent vs baseline window using each item's newest
    // contributing timestamp. `now === 0` (test/replay default) means "no clock"
    // — then we cannot reason about freshness, so we leave it non-stale and skip
    // the directional claim.
    const newestTs = items.reduce((m, it) => Math.max(m, it.newestTs), 0);
    let asOf: string | undefined;
    let stale: boolean | undefined;
    let trendPhrase = '';
    if (now > 0 && newestTs > 0) {
      asOf = new Date(newestTs).toISOString().slice(0, 10);
      stale = now - newestTs > TREND_WINDOW_DAYS * DAY_MS;
      const cutoff = now - TREND_WINDOW_DAYS * DAY_MS;
      let recent = 0;
      let baseline = 0;
      for (const it of items) {
        if (it.newestTs >= cutoff) recent += it.reclaimTokens;
        else baseline += it.reclaimTokens;
      }
      if (stale) {
        trendPhrase = ` (as of ${asOf}; no reclaimable context in the last ${TREND_WINDOW_DAYS} days)`;
      } else if (recent > baseline) {
        trendPhrase = ` (trending up: ~${recent.toLocaleString()} of these tokens are from the last ${TREND_WINDOW_DAYS} days)`;
      } else {
        trendPhrase = ` (as of ${asOf})`;
      }
    }

    const dupCount = toolItems.filter((i) => i.kind === 'duplicate-output').length;
    const overCount = toolItems.filter((i) => i.kind === 'oversized-output').length;
    const pasteCount = pasteItems.length;

    const observations: RecObservation[] = [
      {
        claim: `${overCount} oversized + ${dupCount} duplicate non-file tool_result payload(s) and ${pasteCount} re-pasted block(s) carry reclaimable context`,
        source: 'parse-tools',
        field: 'toolData[].calls[] (non-file) resultBytes; sessions[].entries[].pastedContents',
        value: items.length,
      },
      {
        claim: `Total deterministically-reclaimable context across these items: ~${totalReclaimTokens.toLocaleString()} tokens`,
        source: 'parse-tools',
        field: 'resultBytes / 4 (duplicates: repeats x size; oversized: half the over-threshold tail) + pastedContents repeats',
        value: totalReclaimTokens,
      },
    ];
    const provenance: RecProvenance = {
      observations,
      inference: `Reclaim is the re-ingested/compressible tail only: duplicate tool results re-pay (count-1) x size, oversized single results book half the bytes above ${OVERSIZED_RESULT_BYTES.toLocaleString()}, and a block pasted N times re-pays (N-1) x size. File-Read re-ingestion is excluded (owned by cross-session-reread and repo-map-context-waste). Priced at the measured cache-read residual rate.`,
      ...(asOf ? { asOf } : {}),
      ...(stale !== undefined ? { stale } : {}),
    };

    const describe = (it: Item): string => it.label;

    return {
      id: 'context.reclaim-potential',
      category: 'context',
      severity: 'info',
      title: 'Reclaim duplicate tool output and re-pasted context',
      detail: `${items.length} item(s) — ${overCount} oversized + ${dupCount} duplicate tool outputs and ${pasteCount} re-pasted block(s) — carry ~${totalReclaimTokens.toLocaleString()} tokens of deterministically-reclaimable context worth ~${fmtUsd(estSavingsUsd)}${trendPhrase}. This is the tool-output / paste bloat the file-Read detectors don't cover.`,
      action:
        'Narrow oversized tool calls (head/grep/limit instead of dumping the whole output), avoid re-running identical commands, and reference re-pasted content once instead of pasting it each turn.',
      estSavingsUsd,
      affected: items.length,
      view: 'context',
      evidence: top.map(describe),
      provenance,
      fix: {
        target: 'CLAUDE.md',
        label: 'Add context reclaim discipline',
        note: 'Append to your project CLAUDE.md. This is a discipline note to adapt — narrow large tool calls and reference repeated pasted content once instead of re-pasting it; it is not a one-click config change.',
        snippet: `## Context reclaim discipline\n\nCache or reference these large tool outputs and pasted blocks instead of re-ingesting them:\n${top
          .map((it) => `- ${it.label}`)
          .join('\n')}`,
        fixKind: 'illustrative',
        appliedMarkers: MARKERS_RECLAIM_POTENTIAL,
      },
    };
  },
};
