import type { ToolUsageData } from './parse-tools';
import type { LiveResource } from '../types';

/**
 * Skill-discovery-failure detector (#136).
 *
 * Answers a stated top-question for two personas: "is the team re-implementing
 * in raw Bash what one of my skills already does?" `repeatedCommands()` already
 * flags identical Bash commands run ≥3× in a session; this cross-references
 * those against the installed custom skills (`liveConfig.skills`) and reports
 * sessions where a repeated command's keywords match a skill that was never
 * invoked in that session.
 *
 * The match is **deterministic keyword overlap — no network, no LLM**. Each
 * skill's trigger keywords come from tokenising its `id` (directory name) and
 * `description` (SKILL.md frontmatter). A session's repeated Bash commands are
 * tokenised the same way. A failure is recorded only when a repeated command
 * shares at least `MIN_KEYWORD_OVERLAP` distinct keywords with an un-invoked
 * skill — the multi-token threshold is what keeps false positives down (a lone
 * shared word like "test" is never enough).
 */

/** A Bash command must repeat at least this many times in one session to count
 *  (mirrors `repeatedCommands`' default). */
const MIN_REPEAT = 3;

/** Tokens shorter than this are dropped as noise before matching. */
const MIN_KEYWORD_LEN = 4;

/** A command must share at least this many distinct keywords with a skill to be
 *  flagged. ≥2 (a multi-token overlap) is the conservative bar the issue asks
 *  for — one incidental shared word never triggers a failure. */
const MIN_KEYWORD_OVERLAP = 2;

/**
 * Words too generic to carry discovery signal: English filler, skill-prose
 * boilerplate ("use when the user asks…"), and ubiquitous shell/tooling tokens
 * that appear in nearly every command or description. Excluding them means an
 * overlap is built from meaningful, skill-specific terms.
 */
const STOPWORDS = new Set([
  // English filler
  'this', 'that', 'with', 'when', 'what', 'your', 'have', 'will', 'from',
  'into', 'they', 'them', 'then', 'than', 'over', 'each', 'such', 'only',
  'also', 'does', 'doing', 'done', 'before', 'after', 'about', 'which',
  'these', 'those', 'their', 'there', 'here', 'where', 'while', 'would',
  'could', 'should', 'wants', 'want', 'asks', 'says', 'said', 'like',
  'using', 'used', 'make', 'made', 'need', 'needs', 'just', 'some', 'more',
  'most', 'them', 'one', 'two', 'via',
  // skill-prose boilerplate
  'skill', 'skills', 'user', 'users', 'claude', 'task', 'tasks', 'help',
  'helps', 'tool', 'tools', 'work', 'runs', 'running',
  // ubiquitous shell / tooling tokens
  'bash', 'sudo', 'node', 'npm', 'npx', 'sh', 'cd', 'echo', 'cat', 'true',
  'false', 'null', 'http', 'https', 'json', 'home', 'usr', 'bin', 'tmp',
  'path', 'file', 'files', 'dir', 'name', 'main', 'test', 'tests',
]);

/** Lowercase, split on non-alphanumerics, drop stopwords and short tokens. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= MIN_KEYWORD_LEN && !STOPWORDS.has(t));
}

export interface DiscoveryFailureOccurrence {
  sessionId: string;
  command: string;
  /** Times the command ran in that session (≥ MIN_REPEAT). */
  count: number;
}

export interface DiscoveryFailure {
  /** The un-invoked skill's id (directory name). */
  skillId: string;
  /** Distinct keywords shared between the skill and the matched commands. */
  matchedKeywords: string[];
  /** Per-session evidence: repeated raw Bash commands that matched this skill. */
  occurrences: DiscoveryFailureOccurrence[];
  /** Number of distinct sessions in which this skill went undiscovered. */
  sessions: number;
}

/** Per-skill keyword set built from id + description. */
interface SkillKeywords {
  id: string;
  scope: LiveResource['scope'];
  projectPath?: string;
  keywords: Set<string>;
}

function buildSkillKeywords(skills: LiveResource[]): SkillKeywords[] {
  const out: SkillKeywords[] = [];
  for (const s of skills) {
    const keywords = new Set([
      ...tokenize(s.id),
      ...tokenize(s.description ?? ''),
    ]);
    // A skill with no usable keywords (e.g. an all-stopword id and no
    // description) can never match — skip it so it never produces noise.
    if (keywords.size > 0) {
      out.push({
        id: s.id,
        scope: s.scope,
        projectPath: s.projectPath,
        keywords,
      });
    }
  }
  return out;
}

function sessionProjects(
  sessions: Array<{ sessionId: string; project?: string }> | undefined
): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of sessions ?? []) {
    if (typeof s.project === 'string' && s.project) out.set(s.sessionId, s.project);
  }
  return out;
}

function skillAvailableInSession(
  skill: SkillKeywords,
  sessionProject: string | undefined
): boolean {
  if (skill.scope !== 'project') return true;
  return Boolean(skill.projectPath && sessionProject === skill.projectPath);
}

/**
 * Find sessions re-implementing an un-invoked custom skill in raw Bash.
 *
 * @param toolData per-session tool calls (the same array the rest of ToolUsage
 *   consumes).
 * @param skills installed custom skills (`liveConfig.skills`) carrying `id` and
 *   the optional `description` surfaced from SKILL.md frontmatter.
 * @param sessions optional session metadata. Project-scoped skills are only
 *   compared against sessions from the same project path.
 */
export function detectDiscoveryFailures(
  toolData: ToolUsageData[],
  skills: LiveResource[],
  sessions?: Array<{ sessionId: string; project?: string }>
): DiscoveryFailure[] {
  const skillKeywords = buildSkillKeywords(skills);
  if (skillKeywords.length === 0) return [];
  const projectBySession = sessionProjects(sessions);

  // Aggregate per skill across sessions.
  const bySkill = new Map<
    string,
    { matched: Set<string>; occurrences: DiscoveryFailureOccurrence[]; sessions: Set<string> }
  >();

  for (const session of toolData) {
    const sessionProject = projectBySession.get(session.sessionId);
    // Skills actually invoked in this session — never flag these.
    const invoked = new Set<string>();
    // Identical Bash commands and their per-session repeat counts.
    const cmdCounts = new Map<string, { command: string; count: number }>();
    for (const call of session.calls) {
      if (call.input.skill) invoked.add(call.input.skill);
      if (call.toolName === 'Bash') {
        const cmd = call.input.command ?? call.commandPreview;
        if (!cmd) continue;
        const key = call.commandFingerprint ?? cmd;
        const current = cmdCounts.get(key) ?? { command: cmd, count: 0 };
        current.count += 1;
        cmdCounts.set(key, current);
      }
    }

    for (const { command, count } of cmdCounts.values()) {
      if (count < MIN_REPEAT) continue;
      const cmdTokens = new Set(tokenize(command));
      if (cmdTokens.size === 0) continue;

      for (const skill of skillKeywords) {
        if (!skillAvailableInSession(skill, sessionProject)) continue;
        if (invoked.has(skill.id)) continue;
        const overlap: string[] = [];
        for (const t of cmdTokens) {
          if (skill.keywords.has(t)) overlap.push(t);
        }
        if (overlap.length < MIN_KEYWORD_OVERLAP) continue;

        let entry = bySkill.get(skill.id);
        if (!entry) {
          entry = { matched: new Set(), occurrences: [], sessions: new Set() };
          bySkill.set(skill.id, entry);
        }
        for (const t of overlap) entry.matched.add(t);
        entry.occurrences.push({ sessionId: session.sessionId, command, count });
        entry.sessions.add(session.sessionId);
      }
    }
  }

  return Array.from(bySkill.entries())
    .map(([skillId, v]) => ({
      skillId,
      matchedKeywords: Array.from(v.matched).sort(),
      occurrences: v.occurrences.sort((a, b) => b.count - a.count),
      sessions: v.sessions.size,
    }))
    .sort((a, b) => b.sessions - a.sessions || b.occurrences.length - a.occurrences.length);
}
