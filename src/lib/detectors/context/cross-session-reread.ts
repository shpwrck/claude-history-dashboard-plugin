import type {
  Detector,
  AppliedMarkers,
  RecObservation,
  RecProvenance,
} from '../types';
import { claudeMdMarksApplied, MIN_SAVINGS_USD, fmtUsd, basename } from '../shared';
import { getModelPricing, CHEAPEST_MODEL } from '../../pricing';
import type { ToolCall } from '../../parse-tools';
import type { SessionTokenData } from '../../../types';

/**
 * Cross-session cold-read -> distilled-memory-note recommender (#1752, epic #1910).
 *
 * The only lever that puts a DOLLAR on the cross-session slice of the 84%-of-bill
 * context tax. `parse-file-reread.ts` (and `context.repo-map-context-waste`, which
 * consumes it) measure WITHIN-session re-reads only — they gate on `count >= 3`
 * *inside one session*, so a large doc read exactly ONCE per session, cold, across
 * MANY sessions is invisible to every existing detector. This detector aggregates
 * the per-session FIRST (cold) Read of each documentation file ACROSS the corpus,
 * ranks docs by the recoverable re-ingestion tax, and recommends distilling each
 * into a short `CLAUDE.md`/`AGENTS.md` note so future sessions read the summary
 * instead of re-ingesting the source.
 *
 * Three load-bearing corrections from the spec's vetting are baked in:
 *
 *  1. **NET, not gross savings.** A distilled note loads EAGERLY into every
 *     session, so for a doc read in only a minority of sessions the recurring
 *     eager-load can exceed the cold-read tax it removes. We book
 *     `coldRead x (readingSessions - 1) - noteTokens x corpusSessions` and drop
 *     any doc whose NET is <= 0 — pinning it would cost more than it saves.
 *  2. **Priced at the cache-read residual.** Within the 5h cache window a
 *     re-ingestion lands as a cache READ (~0.1x input), so pricing the whole tax
 *     at full input rate would overstate it for time-clustered users. We
 *     dollarize the NET tokens at the corpus's measured blended cache-read rate
 *     (the way `repo-map-context-waste` books against the cache-read pool) — a
 *     conservative floor; genuinely-cold (>5h) re-reads would bill more.
 *  3. **Stability-gated + deduped.** Only files with ZERO edits/writes across the
 *     corpus are flagged (a churned doc isn't stable to pin). Scope is restricted
 *     to DOCUMENTATION files, so the same bytes are never double-booked against
 *     `context.repo-map-context-waste` (which ranks CODE/structural files from the
 *     symbol graph) — and the two even measure different token populations
 *     (cross-session cold FIRST-reads here vs within-session repeats there).
 *
 * Built off raw Read events (zero-deps, local-only) — NOT the web-tree-sitter
 * repo-map graph, which must stay out of the zero-node_modules server boot graph.
 * The server-side memory-tool handler is explicitly OUT of scope: this ships the
 * measurement plus the human-authored-note recommendation only.
 */

const MARKERS_CROSS_SESSION_REREAD: AppliedMarkers = {
  headings: [/^##\s+Distilled reference notes\b/i],
  bodyPhrases: ['Distill these docs once here instead of re-reading them cold'],
};

const READ_TOOLS = new Set(['Read']);
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'NotebookEdit']);
const WRITE_TOOLS = new Set(['Write']);

/** Bytes->tokens heuristic, matching `parse-file-reread.ts`. */
const CHARS_PER_TOKEN = 4;

/**
 * The distilled note is modelled at this fraction of the source doc's per-read
 * token footprint. A hand-written summary captures the key facts in a small
 * fraction of the original — 0.2 is the conservative ceiling (a bigger note
 * shrinks the NET, so over-estimating here never overstates savings). It is the
 * single knob that gates whether a doc read in only a minority of sessions clears
 * the eager-load cost (correction #1).
 */
const NOTE_DISTILL_FRAC = 0.2;

/** Minimum distinct sessions a doc must be cold-read in to count as cross-session. */
const MIN_READING_SESSIONS = 3;

/** How many candidate docs to surface / name in the finding and the fix. */
const MAX_CANDIDATES = 5;

/** Documentation file extensions — the dedup boundary vs the code-facing repo-map detector. */
const DOC_EXTENSIONS = ['.md', '.mdx', '.markdown', '.txt', '.rst'];

function isDoc(path: string): boolean {
  const lower = path.toLowerCase();
  return DOC_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function getFilePath(call: ToolCall): string | null {
  const fp = call.input?.file_path;
  return typeof fp === 'string' && fp.length > 0 ? fp : null;
}

interface PathAcc {
  /** Distinct sessions that Read this path at least once (cold-read sessions). */
  sessions: Set<string>;
  /** Sum of the per-session FIRST-read bytes, over reads that carried a payload. */
  coldBytesSum: number;
  /** Count of contributing first-read byte samples. */
  coldBytesSamples: number;
  /** Edits + writes on this path across the corpus (stability gate). */
  mutations: number;
}

function freshAcc(): PathAcc {
  return { sessions: new Set(), coldBytesSum: 0, coldBytesSamples: 0, mutations: 0 };
}

interface Candidate {
  path: string;
  readingSessions: number;
  coldReadTokens: number;
  noteTokens: number;
  grossTaxTokens: number;
  eagerLoadTokens: number;
  netTokens: number;
}

/**
 * Corpus blended cache-read price in USD per token (correction #2). Sums the
 * per-entry cache-read dollars over the cache-read tokens that actually carry a
 * priced model, so the rate is GROUNDED in what the user really paid. Entries on
 * an unknown/zero-priced model are skipped (they'd drag a real rate toward zero).
 * Falls back to the cheapest current model's cache-read rate when the corpus has
 * no priced cache reads — a conservative floor.
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

export const detector: Detector = {
  id: 'context.cross-session-reread',
  appliedMarkers: MARKERS_CROSS_SESSION_REREAD,
  category: 'context',
  dataDeps: ['toolData', 'tokenData', 'liveConfig'],
  rule(input) {
    if (claudeMdMarksApplied(input.liveConfig, MARKERS_CROSS_SESSION_REREAD)) return null;
    const toolData = input.toolData;
    if (!toolData || toolData.length === 0) return null;

    // Corpus session count = every session that loads CLAUDE.md eagerly. Use the
    // union of billed (tokenData) and tool-active (toolData) session ids; the
    // larger denominator makes the eager-load cost (and so the NET gate)
    // conservative.
    const corpusSessionIds = new Set<string>();
    for (const d of input.tokenData) corpusSessionIds.add(d.sessionId);
    for (const d of toolData) corpusSessionIds.add(d.sessionId);
    const corpusSessions = corpusSessionIds.size;
    if (corpusSessions < MIN_READING_SESSIONS) return null;

    const acc = new Map<string, PathAcc>();
    let globalReadBytes = 0;
    let globalReadCount = 0;

    for (const session of toolData) {
      const coldSeen = new Set<string>();
      for (const call of session.calls) {
        const path = getFilePath(call);
        if (!path) continue;
        const a = acc.get(path) ?? freshAcc();
        if (READ_TOOLS.has(call.toolName)) {
          if (call.resultBytes > 0) {
            globalReadBytes += call.resultBytes;
            globalReadCount += 1;
          }
          // First Read of this path in this session is the COLD read; later
          // reads in the same session are within-session repeats (a different
          // detector's territory) and are not double-counted here.
          if (!coldSeen.has(path)) {
            coldSeen.add(path);
            a.sessions.add(session.sessionId);
            if (call.resultBytes > 0) {
              a.coldBytesSum += call.resultBytes;
              a.coldBytesSamples += 1;
            }
          }
        } else if (EDIT_TOOLS.has(call.toolName) || WRITE_TOOLS.has(call.toolName)) {
          a.mutations += 1;
        }
        acc.set(path, a);
      }
    }

    const globalMeanBytes = globalReadCount === 0 ? 0 : globalReadBytes / globalReadCount;

    const candidates: Candidate[] = [];
    for (const [path, a] of acc) {
      if (!isDoc(path)) continue; // docs only — dedup boundary vs repo-map (code)
      if (a.sessions.size < MIN_READING_SESSIONS) continue; // cross-session pattern
      if (a.mutations > 0) continue; // stability gate: read-only docs are safe to pin

      const avgColdBytes =
        a.coldBytesSamples > 0 ? a.coldBytesSum / a.coldBytesSamples : globalMeanBytes;
      const coldReadTokens = Math.round(avgColdBytes / CHARS_PER_TOKEN);
      if (coldReadTokens <= 0) continue;

      const readingSessions = a.sessions.size;
      const grossTaxTokens = coldReadTokens * (readingSessions - 1);
      const noteTokens = Math.round(coldReadTokens * NOTE_DISTILL_FRAC);
      const eagerLoadTokens = noteTokens * corpusSessions;
      const netTokens = grossTaxTokens - eagerLoadTokens;
      // NET <= 0 -> the eager note-load costs as much or more than the tax it
      // removes; pinning it would lose money, so it is NOT recommended.
      if (netTokens <= 0) continue;

      candidates.push({
        path,
        readingSessions,
        coldReadTokens,
        noteTokens,
        grossTaxTokens,
        eagerLoadTokens,
        netTokens,
      });
    }

    if (candidates.length === 0) return null;
    candidates.sort((x, y) => y.netTokens - x.netTokens);

    const rate = cacheReadRatePerToken(input.tokenData);
    const totalNetTokens = candidates.reduce((s, c) => s + c.netTokens, 0);
    const estSavingsUsd = totalNetTokens * rate;
    if (estSavingsUsd < MIN_SAVINGS_USD) return null;

    const top = candidates.slice(0, MAX_CANDIDATES);

    const observations: RecObservation[] = [
      {
        claim: `${candidates.length} read-only documentation file(s) were cold-read in ${MIN_READING_SESSIONS}+ separate sessions each`,
        source: 'parse-tools',
        field: 'toolData[].calls[] (Read)',
        value: candidates.length,
      },
      {
        claim: `Top doc ${basename(top[0].path)} was cold-read in ${top[0].readingSessions} sessions with 0 edits/writes (read-only)`,
        source: 'parse-tools',
        field: 'toolData[].calls[] (Read/Edit/Write)',
        value: top[0].readingSessions,
      },
      {
        claim: `Net recoverable cross-session re-ingestion tax across these docs: ~${totalNetTokens.toLocaleString()} tokens`,
        source: 'parse-tools',
        field: 'toolData[].calls[] (Read) — first-read resultBytes / 4, NET after note eager-load',
        value: totalNetTokens,
      },
    ];
    const provenance: RecProvenance = {
      observations,
      inference: `Net savings = coldReadTokens x (readingSessions - 1) - noteTokens x ${corpusSessions} corpus sessions, with noteTokens modelled at ${NOTE_DISTILL_FRAC}x the doc and priced at the measured cache-read residual rate. Only docs with positive NET are recommended.`,
    };

    const describe = (c: Candidate): string =>
      `${c.path} — cold-read in ${c.readingSessions} sessions, ~${c.coldReadTokens.toLocaleString()} tok/read, net ~${c.netTokens.toLocaleString()} tok after eager note-load`;

    return {
      id: 'context.cross-session-reread',
      category: 'context',
      severity: 'info',
      title: 'Distil docs you re-read cold across sessions',
      detail: `${candidates.length} read-only doc(s) are read cold in ${MIN_READING_SESSIONS}+ separate sessions, re-paying the same re-ingestion each time. Distilling them into a short CLAUDE.md/AGENTS.md note nets ~${fmtUsd(estSavingsUsd)} after the note's eager per-session load is subtracted.`,
      action:
        'Write a short, hand-distilled note for each doc in CLAUDE.md/AGENTS.md so future sessions read the summary instead of re-ingesting the full file.',
      estSavingsUsd,
      affected: candidates.length,
      view: 'context',
      evidence: top.map(describe),
      provenance,
      fix: {
        target: 'CLAUDE.md',
        label: 'Add distilled reference notes',
        note: "Append to your project CLAUDE.md. Replace each placeholder with a short, hand-distilled summary of the doc's key facts — a few lines, not the whole file — so future sessions read the note instead of re-ingesting the source. This is a template to adapt, not copy-paste config.",
        snippet: `## Distilled reference notes\n\nDistill these docs once here instead of re-reading them cold each session:\n${top
          .map((c) => `- ${c.path}: <summarize the key facts an agent needs from this doc — keep it to a few lines>`)
          .join('\n')}`,
        fixKind: 'illustrative',
        appliedMarkers: MARKERS_CROSS_SESSION_REREAD,
      },
    };
  },
};
