import type { Detector } from '../types';
import type { AppliedMarkers } from '../types';
import { claudeMdMarksApplied, short, basename, newestIsoDate, truncate } from '../shared';
import { redundantReads, type RedundantRead } from '../../parse-files';
import { parseFileReread } from '../../parse-file-reread';
import {
  FRESH_PROMPT_POOLS,
  freshPromptDeletion,
  freshPromptTokens,
  scopeKeyOf,
  type ReclaimClaim,
} from '../../reclaim';

const MARKERS_REDUNDANT_READS: AppliedMarkers = {
  headings: [/^##\s+Key files\b/i],
  bodyPhrases: ['Load these files once into context'],
};

/** Render parsed artifact text literally without letting it add Markdown lines/fences. */
function markdownCodeSpan(value: string): string {
  const flat = truncate(value, 120);
  const longestRun = Math.max(
    0,
    ...Array.from(flat.matchAll(/`+/g), (match) => match[0].length)
  );
  const fence = '`'.repeat(longestRun + 1);
  return `${fence} ${flat} ${fence}`;
}

/** Same file Read many times in one session — pin it instead. */
export const detector: Detector = {
  id: 'workflow.redundant-reads',
  appliedMarkers: MARKERS_REDUNDANT_READS,
  category: 'workflow',
  dataDeps: ['toolData', 'tokenData', 'liveConfig'],
  rule(input) {
    if (claudeMdMarksApplied(input.liveConfig, MARKERS_REDUNDANT_READS)) return null;
    const reads: RedundantRead[] = redundantReads(input.toolData, input.tokenData);
    if (reads.length === 0) return null;
    const withCompaction = reads.filter((r) => r.compactions > 0).length;

    // Direct-estimate-only dollar lever (#951, doc §3 "redundant-reads … direct
    // estimate only"): the measured re-read tokens, no modelled counterfactual.
    // `parseFileReread.estimatedTokenWaste` = (reads-1) × avgBytesPerRead / 4 — the
    // tokens that would NOT have been re-spent had the file loaded once. We book a
    // `scaleTokens` deletion of those tokens against the re-reading sessions' fresh
    // prompt pools (re-read content re-enters context as uncached input or a cache
    // write, #3854). Per-session waste is summed and expressed as one fraction of the
    // in-scope fresh prompt tokens; an estimate above them makes no claim, and the
    // cascade's `residual ≥ 0` guard caps each cell. No reprice, no cross-model heroics — direct only.
    const reread = parseFileReread(input.toolData, input.tokenData);
    const wasteBySession = new Map<string, number>();
    for (const r of reread.repeats) {
      if (r.estimatedTokenWaste <= 0) continue;
      wasteBySession.set(
        r.sessionId,
        (wasteBySession.get(r.sessionId) ?? 0) + r.estimatedTokenWaste
      );
    }

    // Resolve each re-reading session to its (session, model) scopes and tally the
    // in-scope fresh prompt tokens so the deletion fraction targets exactly the re-read
    // bytes (direct estimate), bounded by the real fresh prompt residual per cell.
    const scopeKeys = new Set<string>();
    let inScopeFreshTokens = 0;
    let directWasteTokens = 0;
    for (const d of input.tokenData) {
      const waste = wasteBySession.get(d.sessionId);
      if (!waste) continue;
      directWasteTokens += waste;
      for (const e of d.entries) {
        scopeKeys.add(scopeKeyOf(d.sessionId, e.model || 'unknown'));
        inScopeFreshTokens += freshPromptTokens(e);
      }
    }

    let reclaim: ReclaimClaim | undefined;
    // Re-entered content is billed as fresh prompt tokens: uncached input or a
    // cache write. Dividing by `input` alone gave fractions above 1 on cached
    // sessions, which the cascade rejected every cycle (#3854). An estimate larger
    // than the scope's fresh tokens makes no claim rather than booking them all.
    const poolDeltaFrac =
      directWasteTokens > 0 && scopeKeys.size > 0
        ? freshPromptDeletion(directWasteTokens, inScopeFreshTokens)
        : null;
    if (poolDeltaFrac) {
      reclaim = {
        leverId: 'workflow.redundant-reads',
        category: 'workflow',
        cause: 'workflow-rework',
        // Behavioural band [10,40): reliability(10) → safety(20) → workflow(30).
        orderKey: 30,
        ownedPools: [...FRESH_PROMPT_POOLS],
        scopeKeys: [...scopeKeys],
        counterfactual: { kind: 'scaleTokens', poolDeltaFrac },
        evidenceTokens: directWasteTokens,
      };
    }

    // Anchored to the newest OBSERVED re-read, never to `now`: the re-read
    // waste is only true as of the last time a file was seen re-Read.
    // `parse-file-reread` records the bracketing `lastRead` timestamp per
    // (session, file) repeat; an undated corpus yields no `asOf` rather than a
    // fabricated one.
    const asOf = newestIsoDate(reread.repeats.map((r) => r.lastRead));

    return {
      id: 'workflow.redundant-reads',
      category: 'workflow',
      severity: 'info',
      claimClass: 'accounting',
      proofTier: 'accounting',
      title: 'Files re-read repeatedly within a session',
      detail: `${reads.length} (session, file) pair(s) re-Read the same file 3+ times${
        withCompaction > 0
          ? `, ${withCompaction} alongside compaction; causation is not established`
          : ''
      }. Each re-read re-pays the token cost.`,
      action:
        'Pin frequently-needed files in CLAUDE.md or pass their contents once instead of re-reading.',
      ...(reclaim ? { reclaim } : {}),
      affected: reads.length,
      evidence: reads
        .slice(0, 5)
        .map((r) => `${short(r.sessionId)}, ${basename(r.filePath)}, ${r.reads}×`),
      view: 'files',
      fix: (() => {
        // De-dupe the most re-read files by basename for a human-readable list.
        const names = Array.from(new Set(reads.map((r) => basename(r.filePath)))).slice(0, 5);
        const bullets = names.map((n) => `- ${markdownCodeSpan(`@${n}`)}`).join('\n');
        return {
          target: 'CLAUDE.md' as const,
          label: 'Pin files in CLAUDE.md',
          fixKind: 'illustrative' as const,
          note: 'Append to your project CLAUDE.md. The @-prefix imports the file so its contents load once into context instead of being re-Read each time. Replace the basenames with repo-relative paths.',
          snippet: `## Key files (kept in context)\n\nLoad these files once into context, then reuse that copy instead of re-reading them:\n${bullets}`,
          appliedMarkers: MARKERS_REDUNDANT_READS,
        };
      })(),
      provenance: {
        observations: [
          {
            claim: `${reads.length} (session, file) pair(s) Read the same file 3+ times within one session`,
            source: 'parse-files (redundantReads over toolData[].calls)',
            field: 'redundantReads.length',
            value: reads.length,
          },
          {
            claim: `${withCompaction} of those pair(s) coincided with a compaction in the same session`,
            source: 'parse-files (redundantReads over toolData[].calls)',
            field: 'filter(compactions > 0).length',
            value: withCompaction,
          },
          ...(directWasteTokens > 0
            ? [
                {
                  claim: `the re-reads re-paid an estimated ${Math.round(directWasteTokens)} input token(s)`,
                  source: 'parse-file-reread (parseFileReread over toolData[].calls)',
                  field: 'sum(estimatedTokenWaste)',
                  value: Math.round(directWasteTokens),
                },
              ]
            : []),
        ],
        // The token figure is a DIRECT estimate — (reads-1) × avgBytesPerRead / 4
        // — of tokens that would not have re-entered context had the file loaded
        // once; it is booked against the in-scope fresh prompt pools, not a modelled
        // reprice. No claim is made about WHY the file was re-read (eviction,
        // forgetfulness, or a legitimate re-check); only that each repeat re-paid
        // its own bytes.
        inference:
          'Each re-Read of the same file re-pays that file\'s bytes as input tokens; ' +
          'the estimate is the measured re-read bytes, not a counterfactual about ' +
          'the cause of the re-reads.',
        ...(asOf ? { asOf } : {}),
      },
    };
  },
};
