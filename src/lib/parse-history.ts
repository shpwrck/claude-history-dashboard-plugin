import type {
  HistoryEntry,
  Session,
  ProjectStats,
  RepoChild,
  RepoGroup,
} from '../types';
import { shortenProject } from './format';
import { parseDateMs } from './parse-utils';

// Re-exported for backward compatibility; the canonical home is `./format`.
export { shortenProject };

export function parseHistoryJsonl(text: string): HistoryEntry[] {
  const out: HistoryEntry[] = [];
  for (const line of text.trim().split('\n')) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as HistoryEntry);
    } catch {
      /* skip unparseable lines */
    }
  }
  return out;
}

/** Flatten a transcript `message.content` (string or text-block array) to text. */
function textBlocksToString(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        typeof b === 'string'
          ? b
          : b && typeof b === 'object' && (b as { type?: string }).type === 'text'
            ? ((b as { text?: string }).text ?? '')
            : ''
      )
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/**
 * Derive history-style entries (typed user prompts) from a session transcript,
 * so an uploaded transcript shows up in the Sessions/Search/Projects views and
 * — critically — so cost/activity attribution can map its `sessionId` to a real
 * project instead of the `_unknown` bucket (issue #399).
 *
 * This is the browser-side mirror of `deriveEntries()` in `scripts/ingest.mjs`:
 * the server runs it over every on-disk transcript, but the upload path never
 * did, so automation (`sdk-*`) sessions — absent from `history.jsonl`, which
 * only logs typed human prompts — lost their project entirely. The `project`
 * comes from each user turn's `cwd`, falling back to the path-derived project
 * the uploader recovers (`fallbackProject`). Only top-level user turns with real
 * text are kept (skip meta/sidechain/tool_result-only turns), matching the
 * server so both modes produce identical attribution.
 */
export function deriveEntriesFromTranscript(
  text: string,
  sessionId: string,
  fallbackProject: string | undefined,
  title?: string | null
): HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    let o: {
      type?: string;
      isMeta?: boolean;
      isSidechain?: boolean;
      message?: { role?: string; content?: unknown };
      timestamp?: string;
      cwd?: string;
    };
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.type !== 'user' || o.isMeta || o.isSidechain || !o.message) continue;
    if (o.message.role && o.message.role !== 'user') continue;
    const display = textBlocksToString(o.message.content).trim();
    if (!display) continue; // skip tool_result-only user turns
    entries.push({
      display: display.length > 2000 ? display.slice(0, 2000) : display,
      pastedContents: {},
      timestamp: parseDateMs(o.timestamp),
      project: o.cwd || fallbackProject || '',
      sessionId,
      ...(title ? { title } : {}),
    });
  }
  return entries;
}

/**
 * Union transcript-derived entries with `history.jsonl` entries, honoring the
 * same precedence as `assembleDataset()` in `scripts/ingest.mjs`: transcript
 * entries are authoritative, and a `history.jsonl` entry is included only for a
 * session that has no transcript. Keeps the two upload sources from
 * double-counting a session that appears in both.
 */
export function unionEntries(
  historyEntries: HistoryEntry[],
  transcriptEntries: HistoryEntry[],
  transcriptSessionIds: Iterable<string> = transcriptEntries.map((e) => e.sessionId)
): HistoryEntry[] {
  const transcriptIds = new Set(transcriptSessionIds);
  return [
    ...transcriptEntries,
    ...historyEntries.filter((e) => !transcriptIds.has(e.sessionId)),
  ];
}

/**
 * Merge per-session history.d entries with the legacy flat history.jsonl log.
 * A session present in any history.d part is owned by those part entries; the
 * legacy file remains a fallback for sessions that have not been split yet.
 */
export function unionHistoryParts(
  legacyEntries: HistoryEntry[],
  partEntries: HistoryEntry[]
): HistoryEntry[] {
  const partSessionIds = new Set(partEntries.map((e) => e.sessionId));
  return [
    ...partEntries,
    ...legacyEntries.filter((e) => !partSessionIds.has(e.sessionId)),
  ];
}

const SYNTHETIC_TURN_RE =
  /^\s*<\s*(task-notification|system-reminder)\b[\s\S]*<\/\s*\1\s*>\s*$/i;

export function isRealHumanTurn(entry: HistoryEntry): boolean {
  const display = entry.display.trim();
  return (
    display.length > 0 &&
    display !== 'init' &&
    display !== 'exit' &&
    !SYNTHETIC_TURN_RE.test(display)
  );
}

export function realHumanTurns(entries: readonly HistoryEntry[]): HistoryEntry[] {
  return entries.filter(isRealHumanTurn);
}

export function groupBySessions(entries: HistoryEntry[]): Session[] {
  const groups = new Map<string, HistoryEntry[]>();
  for (const entry of entries) {
    const list = groups.get(entry.sessionId) ?? [];
    list.push(entry);
    groups.set(entry.sessionId, list);
  }

  return Array.from(groups.entries())
    .map(([sessionId, items]) => {
      items.sort((a, b) => a.timestamp - b.timestamp);
      const startTime = items[0].timestamp;
      const endTime = items[items.length - 1].timestamp;
      const userMessages = items.filter(
        (e) => e.display !== 'init' && e.display !== 'exit'
      );
      return {
        sessionId,
        sourceId: items[0].sourceId,
        harness: items[0].harness,
        project: items[0].project,
        projectShort: shortenProject(items[0].project),
        entries: items,
        startTime,
        endTime,
        duration: endTime - startTime,
        messageCount: userMessages.length,
      };
    })
    .sort((a, b) => b.endTime - a.endTime);
}

export function groupByProjects(sessions: Session[]): ProjectStats[] {
  const groups = new Map<string, Session[]>();
  for (const session of sessions) {
    const list = groups.get(session.project) ?? [];
    list.push(session);
    groups.set(session.project, list);
  }

  return Array.from(groups.entries())
    .map(([project, projectSessions]) => ({
      project,
      projectShort: shortenProject(project),
      sessionCount: projectSessions.length,
      messageCount: projectSessions.reduce((s, sess) => s + sess.messageCount, 0),
      firstSeen: Math.min(...projectSessions.map((s) => s.startTime)),
      lastSeen: Math.max(...projectSessions.map((s) => s.endTime)),
      sessions: projectSessions,
    }))
    .sort((a, b) => b.messageCount - a.messageCount);
}

/** Path marker that identifies a git worktree checkout (#192). */
const WORKTREE_MARKER = '/.claude/worktrees/';

/**
 * Fold the flat `ProjectStats[]` into parent-repo groups so worktrees of the
 * same checkout aggregate under one entry, while leaving every other consumer
 * of `ProjectStats[]` untouched (this is a view-only grouping layer — see #192).
 *
 * Detection is purely path-based: a project path containing the
 * `/.claude/worktrees/` marker belongs to the repo at the prefix before the
 * marker, with its worktree slug taken from the segment after it. A path
 * without the marker is its own repo (the main checkout, labelled `"main"`),
 * which is also how non-worktree projects stay as a single flat row. Grouping
 * keys on the full pre-marker path, so two checkouts of the same repo name in
 * different base dirs (`…/project/x` vs `…/src/x`) remain distinct groups.
 *
 * Parent totals are the aggregate of the group's children; children are sorted
 * main-first, then by message count. Pure: depends only on its input.
 */
export function groupWorktrees(projects: ProjectStats[]): RepoGroup[] {
  const groups = new Map<string, RepoChild[]>();
  for (const p of projects) {
    const idx = p.project.indexOf(WORKTREE_MARKER);
    let repo: string;
    let branch: string;
    if (idx === -1) {
      repo = p.project;
      branch = 'main';
    } else {
      repo = p.project.slice(0, idx);
      const suffix = p.project.slice(idx + WORKTREE_MARKER.length);
      branch = suffix.split('/')[0] || 'worktree';
    }
    const list = groups.get(repo) ?? [];
    list.push({ ...p, branch });
    groups.set(repo, list);
  }

  return Array.from(groups.entries())
    .map(([repo, children]) => {
      // Main checkout (path == repo, no marker) sorts first; worktrees follow
      // by message count so the busiest worktree leads.
      const worktrees = [...children].sort((a, b) => {
        if (a.branch === 'main' && b.branch !== 'main') return -1;
        if (b.branch === 'main' && a.branch !== 'main') return 1;
        return b.messageCount - a.messageCount;
      });
      const sessions = worktrees.flatMap((c) => c.sessions);
      return {
        repo,
        repoShort: shortenProject(repo),
        sessionCount: worktrees.reduce((s, c) => s + c.sessionCount, 0),
        messageCount: worktrees.reduce((s, c) => s + c.messageCount, 0),
        firstSeen: Math.min(...worktrees.map((c) => c.firstSeen)),
        lastSeen: Math.max(...worktrees.map((c) => c.lastSeen)),
        sessions,
        worktrees,
      };
    })
    .sort((a, b) => b.messageCount - a.messageCount);
}

// `loadDefaultHistory()` (the `/history.jsonl` fallback fetch) moved to
// `api-client.ts` (#324) so the server URL lives only in the aliased-away
// chokepoint and never reaches the sample bundle.
