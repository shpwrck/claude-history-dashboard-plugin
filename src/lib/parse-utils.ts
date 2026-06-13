/**
 * Shared JSONL-parsing scaffolding used by every per-session parser.
 *
 * Each parser walks the same `~/.claude/projects/.../*.jsonl` wire format:
 * one JSON object per line, with a `type`, `timestamp`, and (sometimes) a
 * `message` that is either an object or a JSON-encoded string. The types and
 * helpers below were duplicated across parse-tools, parse-timeline,
 * parse-errors, parse-permissions, and parse-agents until this module was
 * extracted; consolidating them keeps the wire-format assumptions in one
 * place.
 */

/**
 * Maximum length, in characters, of a one-line summary.
 *
 * Parsers cap their `summary` outputs at this length so the UI can render
 * compact timeline rows without surprise overflow.
 */
export const MAX_SUMMARY = 200;

/**
 * Top-level shape of a single JSONL line.
 *
 * Parsers may extend this with their own optional fields (e.g. permission
 * mode, API-error flag) via intersection.
 */
export interface RawSessionEntry {
  type?: string;
  message?: unknown;
  timestamp?: string;
}

/**
 * Union of the content-block shapes Claude emits in `message.content`.
 *
 * Different parsers care about different subsets of these fields; declaring
 * the superset keeps each parser's local typing concise.
 */
export interface ContentBlock {
  type?: string;
  // text / thinking blocks
  text?: string;
  thinking?: string;
  // tool_use blocks
  id?: string;
  name?: string;
  input?: unknown;
  // tool_result blocks
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
}

/**
 * Parsed form of the `message` field.
 *
 * The wire format stores `message` either as an already-parsed object or as
 * a JSON-encoded string; in both cases the parsed form looks like this.
 */
export interface ParsedMessage {
  content?: ContentBlock[] | string;
}

const JSONL_CACHE_LIMIT = 2;
const MESSAGE_STRING_CACHE_LIMIT = 512;
const MESSAGE_STRING_CACHE_MAX_CHARS = 200_000;
const jsonlCache = new Map<string, RawSessionEntry[]>();
const messageObjectCache = new WeakMap<object, ParsedMessage | null>();
const messageStringCache = new Map<string, ParsedMessage | null>();

/**
 * Parse JSONL transcript text once and share the parsed line objects across the
 * ingest parsers that run sequentially over the same session text.
 */
export function parseJsonl(text: string): RawSessionEntry[] {
  const cached = jsonlCache.get(text);
  if (cached) {
    jsonlCache.delete(text);
    jsonlCache.set(text, cached);
    return cached;
  }

  const out: RawSessionEntry[] = [];
  for (const line of text.trim().split('\n')) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as RawSessionEntry);
    } catch {
      /* skip unparseable lines */
    }
  }

  jsonlCache.set(text, out);
  while (jsonlCache.size > JSONL_CACHE_LIMIT) {
    const oldest = jsonlCache.keys().next().value;
    if (oldest === undefined) break;
    jsonlCache.delete(oldest);
  }
  return out;
}

export function parseDateMs(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Coerce a raw `message` value into a `ParsedMessage`.
 *
 * `message` is either already an object (return as-is) or a JSON-encoded
 * string (parse it). Anything else, or invalid JSON, returns `null`.
 *
 * Note: an earlier version performed a `replace(/'/g, '"')` on the string
 * before parsing, which corrupted valid Bash commands containing single
 * quotes. That hack has been removed.
 */
export function parseMessage(raw: unknown): ParsedMessage | null {
  if (raw == null) return null;
  if (typeof raw === 'object') {
    const cached = messageObjectCache.get(raw);
    if (cached !== undefined) return cached;
    const parsed = raw as ParsedMessage;
    messageObjectCache.set(raw, parsed);
    return parsed;
  }
  if (typeof raw === 'string') {
    if (raw.length > MESSAGE_STRING_CACHE_MAX_CHARS) {
      try {
        return JSON.parse(raw) as ParsedMessage;
      } catch {
        return null;
      }
    }
    if (messageStringCache.has(raw)) {
      const cached = messageStringCache.get(raw) ?? null;
      messageStringCache.delete(raw);
      messageStringCache.set(raw, cached);
      return cached;
    }
    try {
      const parsed = JSON.parse(raw) as ParsedMessage;
      messageStringCache.set(raw, parsed);
      while (messageStringCache.size > MESSAGE_STRING_CACHE_LIMIT) {
        const oldest = messageStringCache.keys().next().value;
        if (oldest === undefined) break;
        messageStringCache.delete(oldest);
      }
      return parsed;
    } catch {
      messageStringCache.set(raw, null);
      while (messageStringCache.size > MESSAGE_STRING_CACHE_LIMIT) {
        const oldest = messageStringCache.keys().next().value;
        if (oldest === undefined) break;
        messageStringCache.delete(oldest);
      }
      return null;
    }
  }
  return null;
}

/**
 * Collapse newlines and trim, then truncate to at most `max` characters.
 *
 * Newlines are replaced with a single space (not a glyph) so the resulting
 * string stays valid ASCII and copy-pastes cleanly.
 */
export function summarize(text: string, max: number = MAX_SUMMARY): string {
  const flat = text.replace(/\r?\n/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max) : flat;
}
