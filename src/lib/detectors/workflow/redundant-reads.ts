import type { Detector } from '../types';
import type { AppliedMarkers } from '../types';
import { claudeMdMarksApplied, short, basename } from '../shared';
import { redundantReads, type RedundantRead } from '../../parse-files';
import { parseFileReread } from '../../parse-file-reread';
import { scopeKeyOf, type ReclaimClaim } from '../../reclaim';

const MARKERS_REDUNDANT_READS: AppliedMarkers = {
  headings: [/^##\s+Key files\b/i],
  bodyPhrases: ['Load these files once into context'],
};

/** Same file Read many times in one session — pin it instead. */
export const detector: Detector = {
  id: 'workflow.redundant-reads',
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
    // `scaleTokens` deletion of those tokens against the re-reading sessions' INPUT
    // pool (re-read file content re-enters context as input). Per-session waste is
    // summed and expressed as one fraction of the in-scope input residual; the
    // cascade's `residual ≥ 0` guard caps each cell so we never reclaim more than
    // the real input bill. No reprice, no cross-model heroics — direct only.
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
    // in-scope input tokens so the deletion fraction targets exactly the re-read
    // bytes (direct estimate), bounded by the real input residual per cell.
    const scopeKeys = new Set<string>();
    let inScopeInputTokens = 0;
    let directWasteTokens = 0;
    for (const d of input.tokenData) {
      const waste = wasteBySession.get(d.sessionId);
      if (!waste) continue;
      directWasteTokens += waste;
      for (const e of d.entries) {
        scopeKeys.add(scopeKeyOf(d.sessionId, e.model || 'unknown'));
        inScopeInputTokens += e.inputTokens;
      }
    }

    let reclaim: ReclaimClaim | undefined;
    if (directWasteTokens > 0 && scopeKeys.size > 0 && inScopeInputTokens > 0) {
      // Fraction of the in-scope input pool the re-read waste represents. >1 ⇒ the
      // cascade keeps 0 (deletes the whole input residual, never goes negative).
      const inputFrac = directWasteTokens / inScopeInputTokens;
      reclaim = {
        leverId: 'workflow.redundant-reads',
        category: 'workflow',
        cause: 'workflow-rework',
        // Behavioural band [10,40): reliability(10) → safety(20) → workflow(30).
        orderKey: 30,
        ownedPools: ['input'],
        scopeKeys: [...scopeKeys],
        counterfactual: { kind: 'scaleTokens', poolDeltaFrac: { input: inputFrac } },
        evidenceTokens: directWasteTokens,
      };
    }

    return {
      id: 'workflow.redundant-reads',
      category: 'workflow',
      severity: 'info',
      title: 'Files re-read repeatedly within a session',
      detail: `${reads.length} (session, file) pair(s) re-Read the same file 3+ times${
        withCompaction > 0 ? `, ${withCompaction} alongside compaction (eviction-driven)` : ''
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
        const bullets = names.map((n) => `- @${n}`).join('\n');
        return {
          target: 'CLAUDE.md' as const,
          label: 'Pin files in CLAUDE.md',
          note: 'Append to your project CLAUDE.md. The @-prefix imports the file so its contents load once into context instead of being re-Read each time. Replace the basenames with repo-relative paths.',
          snippet: `## Key files (kept in context)\n\nLoad these files once into context, then reuse that copy instead of re-reading them:\n${bullets}`,
          appliedMarkers: MARKERS_REDUNDANT_READS,
        };
      })(),
    };
  },
};
