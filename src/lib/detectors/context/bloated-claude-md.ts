import type { Detector } from '../types';
import { mergedClaudeMdParts } from '../shared';

// Anthropic documents a ~200-line target for CLAUDE.md; adherence degrades and
// every session pays the token cost past it. (#412)
const WARN_LINES = 200;
const CRITICAL_LINES = 400;

/**
 * Flag an oversized merged global CLAUDE.md. Gates purely on line count — there
 * is no self-suppression marker because the file in question IS CLAUDE.md, so a
 * prose note would suppress the very finding it describes (#412).
 */
export const detector: Detector = {
  id: 'context.bloated-claude-md',
  category: 'context',
  dataDeps: ['liveConfig'],
  rule(input) {
    const parts = mergedClaudeMdParts(input.liveConfig);
    const text = parts.join('\n\n');
    if (text.length === 0) return null;
    const lines = text.split('\n').length;
    if (lines <= WARN_LINES) return null;
    return {
      id: 'context.bloated-claude-md',
      category: 'context',
      severity: lines > CRITICAL_LINES ? 'critical' : 'warning',
      title: 'Trim the oversized global CLAUDE.md',
      detail: `Your merged global CLAUDE.md is ~${lines} lines, over Anthropic's documented ${WARN_LINES}-line target; every session pays that token cost and instruction adherence degrades past it.`,
      action:
        'Move reference material into path-scoped .claude/rules/*.md (with a `paths:` frontmatter) or skills with disable-model-invocation, so rules load only when relevant files are touched.',
      affected: lines,
      fix: {
        target: 'CLAUDE.md',
        label: 'Split rules out of CLAUDE.md',
        note: 'Keep CLAUDE.md near the ~200-line target. Move topic-specific reference material into path-scoped rule files that load only when matching files are touched.',
        snippet: `## Instructions size — split rules

Keep this file near Anthropic's ~200-line target. Past it, token cost rises every
session and instruction adherence degrades.

- Move topic-specific guidance into \`.claude/rules/<topic>.md\` with a \`paths:\`
  frontmatter so each rule loads only when a matching file is touched:

  \`\`\`markdown
  ---
  paths: ["src/payments/**"]
  ---
  # Payments conventions
  …
  \`\`\`

- Or move rarely-needed reference material into a skill with
  \`disable-model-invocation\` so it is read on demand, not every turn.`,
      },
      provenance: {
        observations: [
          {
            claim: `the merged CLAUDE.md text is ${lines} line(s) long`,
            source: 'liveConfig.claudeMd (mergedClaudeMdText)',
            field: 'claudeMd.global + claudeMd.perProject',
            value: lines,
          },
          {
            // The number above is a MERGE, not the size of one file. Without
            // this the reader would reasonably check ~/.claude/CLAUDE.md, find
            // it far shorter, and conclude the finding is wrong.
            claim: `that count is the concatenation of ${parts.length} CLAUDE.md document(s), not the size of any single file`,
            source: 'liveConfig.claudeMd (mergedClaudeMdParts)',
            field: 'claudeMd.global + claudeMd.perProject',
            value: parts.length,
          },
          {
            claim: `the target compared against is WARN_LINES = ${WARN_LINES} lines, and severity escalates at CRITICAL_LINES = ${CRITICAL_LINES}`,
            source: 'detectors/context/bloated-claude-md',
            field: 'WARN_LINES / CRITICAL_LINES',
            value: WARN_LINES,
          },
        ],
        // Only the line count is measured here. The ~200-line target and the
        // adherence claim in `detail` are Anthropic's documented guidance —
        // this detector does not measure adherence or token cost at all, and
        // saying so is what keeps the headline honest (#3180).
        inference:
          'Only the line count is measured. The ~200-line target and the degraded-adherence ' +
          'consequence are Anthropic\'s documented guidance, not something observed here: no ' +
          'adherence rate and no per-session token cost is computed. Because the figure is a ' +
          'merge, trimming one of the merged files may not clear the target on its own.',
      },
    };
  },
};
