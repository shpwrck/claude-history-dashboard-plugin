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
  summary?: string; // one-line, already truncated to ~200 chars; stripped from bulk timelines
  summaryLen?: number;
  hasCode?: boolean;
  isQuestion?: boolean;
  toolName?: string; // when kind === 'tool_use'
  toolUseId?: string; // stable tool_use id, also copied onto matching tool_result entries
  isError?: boolean; // when kind === 'tool_result'
  /**
   * When `kind === 'assistant'`: the text ends on passive wait/monitor language
   * ("I'll wait", "I'll report when it finishes", "I'll surface the rollup when
   * the watcher fires"). Detected on the *full* untruncated block text, so a
   * trailing wait phrase past the ~200-char `summary` cutoff is still caught (and
   * the flag survives `slimSessionTimeline`, which only strips `summary`). Feeds
   * the `reliability.passive-wait-stall` detector (#1873).
   */
  waitLanguage?: boolean;
  /**
   * When `kind === 'user'`: this user record is the literal interrupt sentinel
   * the harness writes when a human cuts the assistant off mid-response
   * (`[Request interrupted by user]` / `[Request interrupted by user for tool
   * use]`), NOT a real human prompt. Detected on the *full* untruncated user text
   * (anchored with `startsWith`, so a prompt that merely quotes the phrase or an
   * assistant turn discussing it is never flagged) and set as a derived boolean so
   * it survives `slimSessionTimeline`. Feeds the
   * `workflow.mid-turn-interrupt-steering` detector (#1754): everything the
   * assistant produced in the now-orphaned turn was billed but discarded.
   */
  interrupted?: boolean;
  /**
   * When `kind === 'tool_use'`: the call dispatches harness-backed work that
   * auto-wakes the session on completion (`run_in_background` Bash, or a
   * Task / Workflow / ScheduleWakeup / Monitor call). The clean-separation control
   * for the passive-wait-stall detector (#1873): a turn carrying one of these is
   * never a passive stall, because the session resumes on its own rather than
   * forcing a human turn.
   */
  backgrounded?: boolean;
}

export interface SessionTimeline extends SessionDimensions {
  sessionId: string;
  startTime: string;
  endTime: string;
  entries: TimelineEntry[];
  firstPromptPreview?: string;
  /**
   * True when `entries[].summary` text has been stripped from this timeline for
   * the bulk dataset (#1035/#1284). Full detail is served lazily by
   * `GET /api/session/<id>/timeline.json`; client-parsed timelines (uploads, the SPA
   * sample corpus) are never slim.
   */
  slim?: boolean;
}

function summarySignals(summary: string): Pick<TimelineEntry, 'summaryLen' | 'hasCode' | 'isQuestion'> {
  return {
    summaryLen: summary.length,
    hasCode: summary.includes('```'),
    isQuestion: summary.trimEnd().endsWith('?'),
  };
}

function withSummarySignals(entry: TimelineEntry): TimelineEntry {
  const summary = entry.summary ?? '';
  return {
    ...entry,
    summaryLen: typeof entry.summaryLen === 'number' ? entry.summaryLen : summary.length,
    hasCode: typeof entry.hasCode === 'boolean' ? entry.hasCode : summary.includes('```'),
    isQuestion:
      typeof entry.isQuestion === 'boolean'
        ? entry.isQuestion
        : summary.trimEnd().endsWith('?'),
  };
}

function timelineEntry(
  entry: Omit<TimelineEntry, 'summaryLen' | 'hasCode' | 'isQuestion'> & {
    summary: string;
  }
): TimelineEntry {
  return { ...entry, ...summarySignals(entry.summary) };
}

function firstPromptPreview(entries: TimelineEntry[]): string | undefined {
  return entries.find((entry) => entry.kind === 'user' && entry.summary)?.summary;
}

/**
 * Bulk-dataset slimming (#1035/#1284): remove `summary` from every entry after
 * carrying the derived fields aggregate readers need. The session_blob row keeps
 * the full parse; the Timeline view hydrates it lazily when selected.
 */
export function slimSessionTimeline(timeline: SessionTimeline): SessionTimeline {
  const entries = timeline.entries.map((entry) => {
    const rest = { ...withSummarySignals(entry) };
    delete rest.summary;
    return rest;
  });
  return {
    ...timeline,
    entries,
    firstPromptPreview: timeline.firstPromptPreview ?? firstPromptPreview(timeline.entries),
    slim: true,
  };
}

/**
 * Passive wait/monitor phrases an assistant turn can END on — "I'll wait", "I'll
 * report when it finishes", "I'll surface the rollup when the watcher fires".
 * Matched on the full untruncated text so a trailing wait phrase past the
 * ~200-char `summary` cutoff is still caught. Feeds the passive-wait-stall
 * detector (#1873): a turn that ends on one of these with no harness-backed
 * background mechanism cannot resume on its own and forces a human turn.
 */
const WAIT_LANGUAGE_PATTERNS: readonly RegExp[] = [
  /\bi(?:'|’)?ll\s+wait\b/i, // "I'll wait"
  /\bi\s+will\s+wait\b/i, // "I will wait"
  // "I'll report / surface / monitor / let you know / ping you / circle back …"
  /\bi(?:'|’)?ll\s+(?:report|surface|share|update|let\s+you\s+know|ping\s+you|notify\s+you|circle\s+back|check\s+back|come\s+back|keep\s+you\s+posted|keep\s+you\s+updated|monitor|keep\s+an\s+eye)\b/i,
  /\bi\s+will\s+(?:report|surface|share|update|let\s+you\s+know|ping\s+you|notify\s+you|circle\s+back|check\s+back|keep\s+you\s+posted|monitor)\b/i,
  // "report/surface … when/once … finishes/completes/fires"
  /\b(?:report|surface|update\s+you|let\s+you\s+know|ping\s+you|notify\s+you)\b[^.!?\n]{0,80}\b(?:when|once|after|as\s+soon\s+as)\b[^.!?\n]{0,80}\b(?:finish|complete|done|fire[sd]?|return|ready|land|wrap)/i,
  // "waiting for it to complete / for completion"
  /\bwait(?:ing)?\s+for\b[^.!?\n]{0,60}\b(?:to\s+(?:complete|finish|return)|completion)\b/i,
];

/**
 * Whether an assistant text block ends a turn on passive wait/monitor language.
 * Exported so the passive-wait-stall detector test can assert against the same
 * matcher the parser uses.
 */
export function hasWaitLanguage(text: string): boolean {
  if (!text) return false;
  return WAIT_LANGUAGE_PATTERNS.some((re) => re.test(text));
}

/**
 * The literal sentinel the harness writes (as a `user`-type text message) when a
 * human interrupts the assistant mid-response: `[Request interrupted by user]` or
 * `[Request interrupted by user for tool use]`. Anchored to the START of the text
 * so a real prompt that merely quotes the phrase, or an assistant turn discussing
 * it, is never mistaken for an interrupt — verified against the local corpus where
 * the genuine markers are exactly these two prefixes, emitted with no leading
 * whitespace (#1754). Exported so the mid-turn-interrupt-steering detector test
 * asserts against the same matcher the parser uses.
 */
export function isInterruptSentinel(text: string | undefined): boolean {
  if (!text) return false;
  return text.startsWith('[Request interrupted by user');
}

/**
 * Harness mechanisms that resume the session on their own after a turn ends —
 * the clean-separation control for the passive-wait-stall detector (#1873). A
 * turn that dispatches one of these never strands the session waiting on a human:
 * `run_in_background` Bash auto-wakes on exit, Task/Workflow re-invoke on
 * completion, and ScheduleWakeup/Monitor are deliberate self-resuming polls.
 */
const SELF_RESUMING_TOOLS: ReadonlySet<string> = new Set([
  'Task',
  'Agent',
  'Workflow',
  'ScheduleWakeup',
  'Monitor',
]);

/** Whether a tool_use dispatches harness-backed, self-resuming background work. */
export function isBackgroundedToolUse(name: string | undefined, input: unknown): boolean {
  if (
    input &&
    typeof input === 'object' &&
    (input as { run_in_background?: unknown }).run_in_background === true
  ) {
    return true;
  }
  return name ? SELF_RESUMING_TOOLS.has(name) : false;
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
        entries.push(timelineEntry({
          timestamp,
          kind: 'user',
          summary: '',
        }));
        continue;
      }
      if (typeof msg.content === 'string') {
        entries.push(timelineEntry({
          timestamp,
          kind: 'user',
          summary: summarize(msg.content),
          ...(isInterruptSentinel(msg.content) ? { interrupted: true } : {}),
        }));
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (!block || typeof block !== 'object') continue;
          if (block.type === 'tool_result') {
            entries.push(timelineEntry({
              timestamp,
              kind: 'tool_result',
              summary: stringifyToolResultContent(block.content),
              toolUseId: typeof block.tool_use_id === 'string' ? block.tool_use_id : undefined,
              isError: block.is_error === true,
            }));
          } else if (block.type === 'text') {
            entries.push(timelineEntry({
              timestamp,
              kind: 'user',
              summary: summarize(block.text ?? ''),
              ...(isInterruptSentinel(block.text) ? { interrupted: true } : {}),
            }));
          }
        }
      }
    } else if (type === 'assistant') {
      const msg = parseMessage(raw.message);
      if (!msg || !Array.isArray(msg.content)) continue;
      for (const block of msg.content) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'text') {
          const text = block.text ?? '';
          entries.push(timelineEntry({
            timestamp,
            kind: 'assistant',
            summary: summarize(text),
            ...(hasWaitLanguage(text) ? { waitLanguage: true } : {}),
          }));
        } else if (block.type === 'thinking') {
          entries.push(timelineEntry({
            timestamp,
            kind: 'thinking',
            summary: summarize(block.thinking ?? block.text ?? ''),
          }));
        } else if (block.type === 'tool_use') {
          entries.push(timelineEntry({
            timestamp,
            kind: 'tool_use',
            summary: stringifyToolInput(block.input),
            toolUseId: typeof block.id === 'string' ? block.id : undefined,
            toolName: block.name ?? 'unknown',
            ...(isBackgroundedToolUse(block.name, block.input) ? { backgrounded: true } : {}),
          }));
        }
      }
    } else if (type) {
      entries.push(timelineEntry({
        timestamp,
        kind: 'other',
        summary: type,
      }));
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
    firstPromptPreview: firstPromptPreview(entries),
    version,
    gitBranch,
    entrypoint,
    serviceTier,
  };
}
