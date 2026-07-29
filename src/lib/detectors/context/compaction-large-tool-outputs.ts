import type { Detector } from '../types';
import { claudeMdMarksApplied, newestTokenDataDate } from '../shared';
import {
  computeCompactionRisk,
  LARGE_OUTPUT_RATE_WARN,
} from '../../parse-compaction-risk';

// When tool output is the dominant compaction factor across hot sessions,
// unfiltered reads/outputs are inflating context. (#425)
const MIN_DOMINANT = 3;

const MARKERS = {
  headings: [/^##\s+Tool output discipline\b/i],
  bodyPhrases: ['prefer Grep/Glob over unfiltered'],
};

/** Flag large tool outputs driving compaction. (#425) */
export const detector: Detector = {
  id: 'context.compaction-large-tool-outputs',
  appliedMarkers: MARKERS,
  category: 'context',
  dataDeps: ['tokenData', 'toolData', 'timelines', 'liveConfig'],
  rule(input) {
    if (claudeMdMarksApplied(input.liveConfig, MARKERS)) return null;
    const rows = computeCompactionRisk(
      input.tokenData,
      input.toolData,
      input.timelines ?? []
    );
    const hot = rows.filter((r) => r.riskClass !== 'low');
    if (hot.length === 0) return null;
    const meanLarge = hot.reduce((s, r) => s + r.largeToolOutputRate, 0) / hot.length;
    const dominant = rows.filter((r) => r.topFactor === 'tool-output').length;
    if (meanLarge < LARGE_OUTPUT_RATE_WARN || dominant < MIN_DOMINANT) return null;
    const asOf = newestTokenDataDate(input.tokenData);
    return {
      id: 'context.compaction-large-tool-outputs',
      category: 'context',
      severity: 'info',
      title: 'Large tool outputs are inflating context',
      detail: `Across hot sessions the mean large-tool-output rate is ${Math.round(meanLarge * 100)}% (over the ${Math.round(LARGE_OUTPUT_RATE_WARN * 100)}% warn threshold), with tool output the dominant compaction factor on ${dominant} session(s).`,
      action:
        'Scope Read with offset/limit and prefer Grep over unfiltered cat so tool outputs stay under the large-output threshold.',
      affected: dominant,
      view: 'context',
      fix: {
        target: 'CLAUDE.md',
        label: 'Add tool-output discipline',
        note: 'Append to CLAUDE.md so large tool outputs stop dominating context growth.',
        snippet: `## Tool output discipline

- Read with \`offset\`/\`limit\` instead of whole large files; prefer Grep/Glob over unfiltered \`cat\` so a single tool result stays small.
- Don't echo large command output into context the current task doesn't need.`,
        appliedMarkers: MARKERS,
      },
      provenance: {
        observations: [
          {
            // Mean over the HOT cohort only, not over the whole fleet — the
            // denominator is the part a reader cannot recover from the number.
            claim: `across the ${hot.length} hot session(s) the mean large-tool-output rate is ${(meanLarge * 100).toFixed(1)}%`,
            source: 'parse-compaction-risk (computeCompactionRisk over toolData)',
            field: 'largeToolOutputRate',
            value: Number(meanLarge.toFixed(4)),
          },
          {
            claim: `${dominant} session(s) across the whole scored fleet name tool output as their leading compaction factor`,
            source: 'parse-compaction-risk (computeCompactionRisk)',
            field: 'topFactor',
            value: dominant,
          },
          {
            claim: `the gates are LARGE_OUTPUT_RATE_WARN = ${(LARGE_OUTPUT_RATE_WARN * 100).toFixed(0)}% mean rate and MIN_DOMINANT = ${MIN_DOMINANT} tool-output-dominant sessions`,
            source: 'parse-compaction-risk / detectors/context/compaction-large-tool-outputs',
            field: 'LARGE_OUTPUT_RATE_WARN / MIN_DOMINANT',
            value: MIN_DOMINANT,
          },
        ],
        // The rate is measured from tool-result sizes; "inflating context" is
        // the interpretation. `topFactor` is a ranking among heuristic score
        // parts, not an attribution of measured tokens.
        inference:
          'The rate is measured from recorded tool-result sizes, and `topFactor` ranks the ' +
          'heuristic score parts against each other — it is not an attribution of measured ' +
          'context tokens to tool output. The two figures also cover different populations: ' +
          'the mean is over the hot cohort, the dominance count is over every scored session.',
        // Newest OBSERVED entry, never `now`.
        ...(asOf ? { asOf } : {}),
      },
    };
  },
};
