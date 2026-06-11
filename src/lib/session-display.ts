import type { Session } from '../types';

export interface SessionDisplay {
  label: string;
  title?: string;
  isFallbackId: boolean;
}

const FALLBACK_TEXT_LIMIT = 80;
const DEFAULT_ID_TRUNCATE = 8;

function compactText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function truncateLabel(text: string): string {
  if (text.length <= FALLBACK_TEXT_LIMIT) return text;
  return `${text.slice(0, FALLBACK_TEXT_LIMIT - 1).trimEnd()}…`;
}

export function sessionTitle(session: Session | undefined): string | undefined {
  if (!session) return undefined;
  if (session.title) return session.title;
  for (const entry of session.entries) {
    if (entry.title) return entry.title;
  }
  return undefined;
}

export function shortSessionId(
  sessionId: string,
  truncate = DEFAULT_ID_TRUNCATE
): string {
  return sessionId.slice(0, truncate);
}

/**
 * Derived (non-id) name for a session that has no explicit title: the first
 * real user prompt, compacted and truncated. Returns undefined when there is no
 * usable prompt — callers then fall back to the session hash (never a generic
 * "Untitled session" label). #7
 */
export function sessionFallbackLabel(
  session: Session | undefined
): string | undefined {
  if (!session) return undefined;
  const prompt = session.entries
    .map((entry) => compactText(entry.display))
    .find((display) => display && display !== 'init' && display !== 'exit');
  return prompt ? truncateLabel(prompt) : undefined;
}

/**
 * Resolve a session to a display label using one rule app-wide (#7): the
 * session's name if it has one (explicit title, then first-prompt label),
 * otherwise the session hash. `isFallbackId` is true only in the hash case so
 * callers can render it monospace.
 */
function resolveDisplay(
  sessionId: string,
  session: Session | undefined,
  truncate: number
): SessionDisplay {
  const title = sessionTitle(session);
  if (title) return { label: title, title, isFallbackId: false };
  const derived = sessionFallbackLabel(session);
  if (derived) return { label: derived, title: undefined, isFallbackId: false };
  return {
    label: shortSessionId(sessionId, truncate),
    title: undefined,
    isFallbackId: true,
  };
}

export function buildSessionDisplayMap(
  sessions: Session[] | undefined
): Map<string, SessionDisplay> {
  const map = new Map<string, SessionDisplay>();
  for (const session of sessions ?? []) {
    map.set(
      session.sessionId,
      resolveDisplay(session.sessionId, session, DEFAULT_ID_TRUNCATE)
    );
  }
  return map;
}

const displayMapCache = new WeakMap<Session[], Map<string, SessionDisplay>>();

function cachedSessionDisplayMap(
  sessions: Session[] | undefined
): Map<string, SessionDisplay> | undefined {
  if (!sessions) return undefined;
  const cached = displayMapCache.get(sessions);
  if (cached) return cached;
  const map = buildSessionDisplayMap(sessions);
  displayMapCache.set(sessions, map);
  return map;
}

export function sessionDisplay(
  sessionId: string,
  sessions: Session[] | undefined,
  truncate = DEFAULT_ID_TRUNCATE
): SessionDisplay {
  const resolved = cachedSessionDisplayMap(sessions)?.get(sessionId);
  if (resolved) {
    // Re-apply the caller's truncation to the hash fallback (the cached map is
    // built with the default length).
    if (resolved.isFallbackId) {
      return { ...resolved, label: shortSessionId(sessionId, truncate) };
    }
    return resolved;
  }
  // Session not in the provided set — show the hash, never "Untitled session".
  return {
    label: shortSessionId(sessionId, truncate),
    title: undefined,
    isFallbackId: true,
  };
}
