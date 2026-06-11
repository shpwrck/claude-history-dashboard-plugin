import { parseJsonl } from './parse-utils';

// Extract human-readable session titles from a transcript JSONL.
//
// Transcripts carry two kinds of title lines (each repeated as the title is
// re-emitted across turns):
//
//   {"type":"ai-title","aiTitle":"...","sessionId":"..."}      // auto-generated
//   {"type":"custom-title","customTitle":"...","sessionId":"..."} // user-set
//
// A user-set `custom-title` always wins over an auto `ai-title` for the same
// session. Within a kind, the last non-empty value seen wins (titles can be
// updated mid-session). The result is a plain `sessionId -> title` map.

export type SessionTitleMap = Record<string, string>;

interface RawTitleLine {
  type?: string;
  sessionId?: string;
  aiTitle?: string;
  customTitle?: string;
}

/**
 * Parse a transcript's text into a `sessionId -> title` map.
 *
 * `custom-title` (user-set) is preferred over `ai-title` (auto) for a given
 * session even if the AI title appears later in the file.
 */
export function parseSessionTitles(text: string): SessionTitleMap {
  const ai: SessionTitleMap = {};
  const custom: SessionTitleMap = {};

  for (const o of parseJsonl(text) as RawTitleLine[]) {
    const sid = o.sessionId;
    if (!sid) continue;
    if (o.type === 'custom-title') {
      const t = (o.customTitle ?? '').trim();
      if (t) custom[sid] = t;
    } else if (o.type === 'ai-title') {
      const t = (o.aiTitle ?? '').trim();
      if (t) ai[sid] = t;
    }
  }

  // Merge with custom winning over ai.
  const out: SessionTitleMap = { ...ai, ...custom };
  return out;
}
