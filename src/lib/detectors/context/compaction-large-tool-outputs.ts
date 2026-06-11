import type { Detector } from '../types';
import { claudeMdMarksApplied } from '../shared';
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
    };
  },
};
