import { parseJsonl, parseMessage, summarize, type RawSessionEntry } from './parse-utils';
import type { SessionDimensions } from '../types';

/**
 * Transcript lines carry per-session dimensions top-level (`version`,
 * `gitBranch`, `entrypoint`) and, on assistant/usage lines, a nested
 * `message.usage.service_tier`. We widen the shared raw shape here so the
 * timeline parser can capture them without touching the common parse-utils
 * contract.
 */
interface RawDimensionEntry extends RawSessionEntry {
  version?: string;
  gitBranch?: string;
  entrypoint?: string;
  message?: unknown;
}

export type EntryKind =
  | 'user'
  | 'assistant'
  | 'tool_use'
  | 'tool_result'
  | 'thinking'
  | 'other';

export interface TimelineEntry {
  // sessionId intentionally omitted — it is redundant with the enclosing
  // SessionTimeline.sessionId and was repeated on every entry (38B × N).
  // No consumer reads a per-entry sessionId.
  timestamp: string; // ISO
  kind: EntryKind;
  summary: string; // one-line, already truncated to ~200 chars
  toolName?: string; // when kind === 'tool_use'
  isError?: boolean; // when kind === 'tool_result'
}

export interface SessionTimeline extends SessionDimensions {
  sessionId: string;
  startTime: string;
  endTime: string;
  entries: TimelineEntry[];
  /**
   * True when non-user `entries[].summary` text has been stripped from this
   * timeline for the bulk dataset (#1035 — those summaries were 22.5 MB of a
   * 79 MB payload and only the SessionTimeline detail view renders them).
   * `user` summaries are kept: every aggregate consumer (conversation
   * patterns, tool effectiveness, model recommendation, user-turn counts)
   * reads summary only on user entries. Full detail is served lazily by
   * `GET /api/session/<id>/timeline`; client-parsed timelines (uploads, the
   * SPA sample corpus) are never slim.
   */
  slim?: boolean;
}

/**
 * Bulk-dataset slimming (#1035): blank `summary` on every non-user entry,
 * keeping the cheap, aggregate-read user summaries. Returns the input object
 * unchanged when nothing would be stripped (so non-slim timelines carry no
 * `slim` flag and detail consumers skip the lazy fetch).
 */
export function slimSessionTimeline(timeline: SessionTimeline): SessionTimeline {
  let changed = false;
  const entries = timeline.entries.map((e) => {
    if (e.kind === 'user' || e.summary === '') return e;
    changed = true;
    return { ...e, summary: '' };
  });
  if (!changed) return timeline;
  return { ...timeline, entries, slim: true };
}

function stringifyToolInput(input: unknown): string {
  if (input == null) return '';
  if (typeof input === 'string') return summarize(input);
  try {
    return summarize(JSON.stringify(input));
  } catch {
    return '';
  }
}

function stringifyToolResultContent(content: unknown): string {
  if (content == null) return '';
  if (typeof content === 'string') return summarize(content);
  if (Array.isArray(content)) {
    // tool_result content is sometimes an array of {type: 'text', text: ...} blocks
    const parts: string[] = [];
    for (const block of content) {
      if (block && typeof block === 'object') {
        const b = block as { type?: string; text?: string };
        if (typeof b.text === 'string') parts.push(b.text);
      } else if (typeof block === 'string') {
        parts.push(block);
      }
    }
    return summarize(parts.join(' '));
  }
  try {
    return summarize(JSON.stringify(content));
  } catch {
    return '';
  }
}

export function parseSessionTimeline(
  text: string,
  fileName: string
): SessionTimeline | null {
  const sessionId = fileName.replace(/\.jsonl$/, '');
  const entries: TimelineEntry[] = [];

  // Per-session dimensions: take the first non-empty value seen.
  let version: string | undefined;
  let gitBranch: string | undefined;
  let entrypoint: string | undefined;
  let serviceTier: string | undefined;

  for (const raw of parseJsonl(text) as RawDimensionEntry[]) {
    // Capture top-level dimensions from any line that carries them.
    if (version === undefined && raw.version) version = raw.version;
    if (gitBranch === undefined && raw.gitBranch) gitBranch = raw.gitBranch;
    if (entrypoint === undefined && raw.entrypoint) entrypoint = raw.entrypoint;
    // service_tier lives under message.usage on assistant/usage lines.
    if (serviceTier === undefined && raw.message && typeof raw.message === 'object') {
      const usage = (raw.message as { usage?: { service_tier?: string } }).usage;
      if (usage?.service_tier) serviceTier = usage.service_tier;
    }

    const timestamp = raw.timestamp ?? '';
    if (!timestamp) continue;

    const type = raw.type;

    if (type === 'user') {
      const msg = parseMessage(raw.message);
      if (!msg) {
        entries.push({
          timestamp,
          kind: 'user',
          summary: '',
        });
        continue;
      }
      if (typeof msg.content === 'string') {
        entries.push({
          timestamp,
          kind: 'user',
          summary: summarize(msg.content),
        });
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (!block || typeof block !== 'object') continue;
          if (block.type === 'tool_result') {
            entries.push({
              timestamp,
              kind: 'tool_result',
              summary: stringifyToolResultContent(block.content),
              isError: block.is_error === true,
            });
          } else if (block.type === 'text') {
            entries.push({
              timestamp,
              kind: 'user',
              summary: summarize(block.text ?? ''),
            });
          }
        }
      }
    } else if (type === 'assistant') {
      const msg = parseMessage(raw.message);
      if (!msg || !Array.isArray(msg.content)) continue;
      for (const block of msg.content) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'text') {
          entries.push({
            timestamp,
            kind: 'assistant',
            summary: summarize(block.text ?? ''),
          });
        } else if (block.type === 'thinking') {
          entries.push({
            timestamp,
            kind: 'thinking',
            summary: summarize(block.thinking ?? block.text ?? ''),
          });
        } else if (block.type === 'tool_use') {
          entries.push({
            timestamp,
            kind: 'tool_use',
            summary: stringifyToolInput(block.input),
            toolName: block.name ?? 'unknown',
          });
        }
      }
    } else if (type) {
      entries.push({
        timestamp,
        kind: 'other',
        summary: type,
      });
    }
  }

  if (entries.length === 0) return null;

  entries.sort((a, b) => {
    if (a.timestamp === b.timestamp) return 0;
    return a.timestamp < b.timestamp ? -1 : 1;
  });

  return {
    sessionId,
    startTime: entries[0].timestamp,
    endTime: entries[entries.length - 1].timestamp,
    entries,
    version,
    gitBranch,
    entrypoint,
    serviceTier,
  };
}
