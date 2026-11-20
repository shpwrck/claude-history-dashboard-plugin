import type { Detector } from '../types';
import type { LiveConfig } from '../../../types';

/**
 * Claude Code's own memory-size warning fires at roughly 5% of the active
 * model's context window in characters, with a 40,000-character floor
 * (`getMaxMemoryCharacterCount`, cited by `/doctor`). The dashboard cannot know
 * which model is active for a merged guidance set, so it uses the floor: the
 * most conservative value the product itself warns at (#3404).
 */
export const MEMORY_WARNING_FLOOR_CHARS = 40_000;

interface LoadedSet {
  /** Project path, or null for the global file alone. */
  project: string | null;
  docs: number;
  chars: number;
  lines: number;
}

function lineCount(text: string): number {
  return text.length === 0 ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

/**
 * The CLAUDE.md text one session can load together: the global file plus at
 * most one project's file. Projects are never merged with each other, because
 * no session loads two projects' CLAUDE.md files. Returns the largest set.
 */
function largestLoadedSet(
  claudeMd: Partial<LiveConfig['claudeMd']> | undefined
): LoadedSet | null {
  if (!claudeMd) return null;
  const global = typeof claudeMd.global === 'string' ? claudeMd.global : '';
  const sets: LoadedSet[] = [];
  if (global.length > 0) {
    sets.push({ project: null, docs: 1, chars: global.length, lines: lineCount(global) });
  }
  for (const [project, text] of Object.entries(claudeMd.perProject ?? {})) {
    if (typeof text !== 'string' || text.length === 0) continue;
    sets.push({
      project,
      docs: global.length > 0 ? 2 : 1,
      chars: global.length + text.length,
      lines: lineCount(global) + lineCount(text),
    });
  }
  if (sets.length === 0) return null;
  return sets.reduce((best, set) => (set.chars > best.chars ? set : best), sets[0]);
}

/**
 * Flag an oversized CLAUDE.md set. Triggers on the character count of the
 * largest set one session loads (global + one project) against the
 * product-anchored floor; the line count is descriptive only. Severity stays
 * `warning`: the product itself has one warning level, and an escalation
 * multiplier would be another invented threshold (#3404). There is no
 * self-suppression marker because the file in question IS CLAUDE.md, so a
 * prose note would suppress the very finding it describes (#412).
 */
export const detector: Detector = {
  id: 'context.bloated-claude-md',
  category: 'context',
  dataDeps: ['liveConfig'],
  rule(input) {
    const set = largestLoadedSet(input.liveConfig?.claudeMd);
    if (!set) return null;
    const { chars, lines } = set;
    if (chars <= MEMORY_WARNING_FLOOR_CHARS) return null;
    const scope =
      set.project === null
        ? 'Your global CLAUDE.md is'
        : set.docs === 2
          ? `Your global CLAUDE.md plus the CLAUDE.md for ${set.project} are`
          : `The CLAUDE.md for ${set.project} is`;
    const scopeShort =
      set.project === null ? 'the global CLAUDE.md' : set.docs === 2 ? `the global CLAUDE.md + ${set.project}` : set.project;
    const charsLabel = chars.toLocaleString('en-US');
    const floorLabel = MEMORY_WARNING_FLOOR_CHARS.toLocaleString('en-US');
    return {
      id: 'context.bloated-claude-md',
      category: 'context',
      severity: 'warning',
      title: 'Trim the oversized CLAUDE.md',
      detail:
        `${scope} ${charsLabel} characters together (~${lines} lines), over the ` +
        `${floorLabel}-character floor of Claude Code's own memory-size warning. The product ` +
        'scales that limit with the active context window (about 5%); the dashboard does not know ' +
        'the active model, so it compares against the floor. Every session in that scope loads this text.',
      action:
        'Move reference material into path-scoped .claude/rules/*.md (with a `paths:` frontmatter) or skills with disable-model-invocation, so rules load only when relevant files are touched.',
      affected: set.docs,
      fix: {
        target: 'CLAUDE.md',
        label: 'Split rules out of CLAUDE.md',
        note: `Keep the CLAUDE.md text one session loads under ${floorLabel} characters. Move topic-specific reference material into path-scoped rule files that load only when matching files are touched.`,
        snippet: `## Instructions size — split rules

Keep this file well under Claude Code's memory-size warning (${floorLabel} characters
at minimum). Everything here loads into every session.

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
            claim: `the largest CLAUDE.md set one session loads (${scopeShort}) is ${chars} character(s) long`,
            source: 'liveConfig.claudeMd',
            field: 'claudeMd.global.length + claudeMd.perProject[project].length',
            value: chars,
          },
          {
            claim: `the same text is ${lines} line(s) long (descriptive only, not the trigger)`,
            source: 'liveConfig.claudeMd',
            field: 'claudeMd.global + claudeMd.perProject[project]',
            value: lines,
          },
          {
            // A reader checking one file would otherwise find it shorter than
            // the headline and conclude the finding is wrong.
            claim: `that count adds ${set.docs} CLAUDE.md document(s) loaded together, not the size of any single file; other projects' files are not added`,
            source: 'liveConfig.claudeMd',
            field: 'claudeMd.global + claudeMd.perProject',
            value: set.docs,
          },
          {
            claim: `the threshold is MEMORY_WARNING_FLOOR_CHARS = ${MEMORY_WARNING_FLOOR_CHARS} characters, the floor of Claude Code's memory-size warning (getMaxMemoryCharacterCount), used because the active context window is unknown`,
            source: 'detectors/context/bloated-claude-md',
            field: 'MEMORY_WARNING_FLOOR_CHARS',
            value: MEMORY_WARNING_FLOOR_CHARS,
          },
        ],
        inference:
          'Only the character and line counts are measured. The threshold is the floor of Claude ' +
          'Code\'s own memory-size warning; on a model whose 5% share exceeds the floor the product ' +
          'warns later than this. No adherence rate and no per-session token cost is computed. ' +
          'When the figure adds the global and a project file, trimming one of them may not ' +
          'clear the threshold on its own.',
      },
    };
  },
};
