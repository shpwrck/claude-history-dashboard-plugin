/**
 * Personal good/bad labels for sessions (#138), persisted in localStorage —
 * Riley's controllable ground-truth signal, independent of the `/insights`
 * outcome overlay. Mirrors the `nav-prefs.ts` get/set pattern: a tolerant
 * reader, a best-effort writer, and a tiny hook keyed by session id.
 *
 * All mounted instances stay in sync via a `session-tags-changed` window event
 * the writer dispatches, so labelling a row in the Sessions view immediately
 * reflects in the Patterns view's colouring without a reload.
 */
import { useCallback, useEffect, useState } from 'react';

export type SessionTag = 'good' | 'bad';
export type SessionTags = Record<string, SessionTag>;

const STORAGE_KEY = 'claude-dashboard:session-tags';
const CHANGE_EVENT = 'session-tags-changed';

/** Tolerant read — a missing/corrupt store yields an empty map. */
export function getSessionTags(): SessionTags {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const out: SessionTags = {};
    for (const [id, val] of Object.entries(parsed as Record<string, unknown>)) {
      if (val === 'good' || val === 'bad') out[id] = val;
    }
    return out;
  } catch {
    return {};
  }
}

function writeSessionTags(tags: SessionTags): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tags));
    window.dispatchEvent(new Event(CHANGE_EVENT));
  } catch {
    /* localStorage disabled (private mode etc.) — silently no-op */
  }
}

/**
 * Read + mutate session labels. `setTag(id, null)` clears the label. Kept in
 * React state so consumers re-render on change, and re-synced from storage when
 * another instance writes (the `session-tags-changed` event) or another tab
 * does (the native `storage` event).
 */
export function useSessionTags() {
  const [tags, setTags] = useState<SessionTags>(() => getSessionTags());

  useEffect(() => {
    const resync = () => setTags(getSessionTags());
    window.addEventListener(CHANGE_EVENT, resync);
    window.addEventListener('storage', resync);
    return () => {
      window.removeEventListener(CHANGE_EVENT, resync);
      window.removeEventListener('storage', resync);
    };
  }, []);

  const setTag = useCallback((sessionId: string, tag: SessionTag | null) => {
    setTags((prev) => {
      const next = { ...prev };
      if (tag === null) {
        if (!(sessionId in next)) return prev;
        delete next[sessionId];
      } else {
        if (next[sessionId] === tag) return prev;
        next[sessionId] = tag;
      }
      writeSessionTags(next);
      return next;
    });
  }, []);

  return { tags, setTag };
}
