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

/**
 * The kind of pending external state a passive-wait turn-end (#1873) is waiting
 * on, classified from the assistant text by {@link classifyWaitClass}. The class
 * determines the waited-on task's footprint, which the `workflow.reclaim-wait-windows`
 * ruleset (#1880) uses to decide what other work is provably non-interfering:
 *  - `'ci'`           — CI / PR checks / a test suite / a pipeline run.
 *  - `'deploy'`       — a deploy / rollout / container build / preview bring-up.
 *  - `'push'`         — a git push or a PR merge landing.
 *  - `'remote-queue'` — a remote queue / background worker / agent-fleet job.
 *  - `'watcher'`      — a Monitor / watcher / poll on a file or condition.
 *  - `'generic'`      — wait language with no class-specific signal (the floor).
 */
export type WaitClass = 'ci' | 'deploy' | 'push' | 'remote-queue' | 'watcher' | 'generic';

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
   * When `kind === 'assistant'` AND {@link waitLanguage} is set: the kind of
   * external state the turn is waiting on, classified from the *full* untruncated
   * block text by {@link classifyWaitClass} (`'ci'` | `'deploy'` | `'push'` |
   * `'remote-queue'` | `'watcher'` | `'generic'`). Like `waitLanguage`, this is a
   * derived field set at parse time, so it survives `slimSessionTimeline` (which
   * strips `summary`) and the wait-CLASS is recoverable on the slim bulk/server
   * dataset where the text is gone. Feeds the `workflow.reclaim-wait-windows`
   * ruleset detector (#1880): the wait class drives which backlog work is
   * provably non-interfering with the waited-on task. Only set alongside
   * `waitLanguage`; absent ⇒ the turn did not end on a wait.
   */
  waitClass?: WaitClass;
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
  /**
   * When `kind === 'tool_use'`: the tool is of a backgroundable KIND — a
   * long-running Bash toolchain invocation (build/test/install/typecheck/container
   * build|compose, classified by {@link isBackgroundableBashCommand}), or an
   * Agent/Task/Workflow/Monitor/ScheduleWakeup call. ORTHOGONAL to `backgrounded`
   * ("was actually run in the background"): a foreground/blocking Agent or Workflow
   * carries `backgroundableKind: true` AND `backgrounded: false`. Set at parse time
   * (when the raw command is still available) as a derived boolean so it survives
   * `slimSessionTimeline`, which strips the command `summary`. Feeds the
   * `workflow.conversational-availability` detector (#2238): a backgroundable-kind
   * call that was NOT backgrounded yet blocked the turn is recoverable wait.
   */
  backgroundableKind?: boolean;
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
 * Bulk-dataset slimming (#1035/#1284, #2106): remove `summary` from every entry,
 * and prune the summary-derived fields (`summaryLen`/`hasCode`/`isQuestion`) down
 * to only what bulk readers actually consult. The session_blob row keeps the full
 * parse; the Timeline view hydrates it lazily when selected.
 *
 * #2106 — the derived signals dominated the bulk timeline payload (~14 MB on the
 * ~1 GB corpus), yet EVERY dataset-level consumer reads them only for
 * `kind === 'user'` entries (conversation-patterns.ts, session-overview.ts,
 * session-scorecard.ts, parse-model-recommendation.ts — all filter on the user
 * kind first). So we:
 *   - keep `summaryLen` only on `user` entries (its only readers; absent elsewhere
 *     reads back as 0 via the `?? summary?.length ?? 0` fallback on stripped bulk);
 *   - keep `hasCode`/`isQuestion` only on `user` entries AND only when `true`
 *     (their `e.hasCode ?? containsCodeBlock(summary)` fallbacks recompute false on
 *     the stripped bulk summary, so an omitted flag is read back as false —
 *     byte-identical behaviour). Non-`user` entries drop all three.
 * The full per-session detail (served lazily by getSessionTimelineDetail) keeps
 * every field, so the detail/forensic views are unaffected.
 */
export function slimSessionTimeline(timeline: SessionTimeline): SessionTimeline {
  const entries = timeline.entries.map((entry) => {
    const filled = withSummarySignals(entry);
    const rest = { ...filled };
    delete rest.summary;
    if (rest.kind === 'user') {
      // user entries: keep summaryLen; demote the booleans to sparse-true.
      if (!rest.hasCode) delete rest.hasCode;
      if (!rest.isQuestion) delete rest.isQuestion;
    } else {
      // non-user entries: no bulk reader consults the derived signals.
      delete rest.summaryLen;
      delete rest.hasCode;
      delete rest.isQuestion;
    }
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
 * Per-class signals for {@link classifyWaitClass}. Evaluated in array order and
 * FIRST match wins, so the list is ordered most-specific → least: a "wait for CI
 * then merge" turn classifies as `'ci'` (the thing actually pending) rather than
 * `'push'`. Patterns are deliberately tight — a bare "merge" or "image" without a
 * wait-domain word would over-match, so each anchors on a token that co-occurs
 * with a genuine pending external wait. No match ⇒ `'generic'` (the floor); the
 * class is only consulted when {@link hasWaitLanguage} already held.
 */
const WAIT_CLASS_PATTERNS: ReadonlyArray<readonly [WaitClass, RegExp]> = [
  // CI / PR checks / a test suite / pipeline run.
  ['ci', /\b(?:CI|continuous\s+integration|pr\s+checks?|gh\s+pr\s+checks|checks?\s+(?:are\s+)?(?:run|pass|green|complete)|test\s+suite|pipeline|workflow\s+run|the\s+(?:checks?|build)\s+(?:to\s+)?(?:finish|complete|pass|go\s+green))\b/i],
  // Deploy / rollout / container build / preview bring-up.
  ['deploy', /\b(?:deploy(?:ment|ing|s|ed)?|redeploy(?:ing|ed)?|rollout|roll\s+out|podman|docker|compose\s+up|container\s+(?:to\s+)?(?:build|come\s+up|start)|preview\s+(?:to\s+)?(?:come\s+up|deploy|build)|image\s+(?:to\s+)?(?:build|publish|push))\b/i],
  // A git push or a PR merge landing. Each alternative requires a git-domain
  // co-signal (a bare "pushing"/"the merge" can be ordinary prose), so the class
  // stays footprint-honest even though the text already ended on wait language.
  ['push', /\b(?:git\s+push|the\s+push|pushed|pushing\s+(?:to\b|up\b|now\b|the\s+(?:remote|branch|commit|changes?|code|pr|fix)|changes?\b)|(?:the\s+)?merge\s+(?:to\s+)?(?:land(?:s|ed|ing)?|complete[sd]?|finish(?:e[sd])?|go(?:es)?\s+through)|merging\s+(?:the\s+)?(?:pr|branch|it|changes?)|pr\s+(?:to\s+)?(?:land|merge))\b/i],
  // Remote queue / background worker / agent-fleet job.
  ['remote-queue', /\b(?:remote\s+(?:queue|run|worker|job|session)|background\s+(?:worker|job|agent|queue)|the\s+queue|agent\s+fleet|cloud\s+(?:run|agent|job)|worker\s+(?:to\s+)?(?:finish|return|complete))\b/i],
  // A Monitor / watcher / poll on a file or condition.
  ['watcher', /\b(?:watcher|the\s+monitor|monitoring\b|polling|poll\s+(?:for|until)|file\s+change|until\s+the\s+condition|watch(?:ing)?\s+(?:for|the\s+file))\b/i],
];

/**
 * Classify a passive-wait turn-end into a {@link WaitClass} from its assistant
 * text. Returns `'generic'` when no class-specific signal is present. Intended to
 * be called only when {@link hasWaitLanguage} is already true (the parser does
 * exactly this), so it always returns a concrete class for a wait turn. Exported
 * so the `workflow.reclaim-wait-windows` detector test can assert against the
 * same matcher the parser uses.
 */
export function classifyWaitClass(text: string): WaitClass {
  if (!text) return 'generic';
  for (const [cls, re] of WAIT_CLASS_PATTERNS) {
    if (re.test(text)) return cls;
  }
  return 'generic';
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

/**
 * Tool kinds that are a backgroundable KIND even when run synchronously in the
 * foreground — a sub-agent fan-out / long-running orchestration call that
 * `run_in_background` (or its own self-resuming nature) could have detached. This
 * is the KIND set, NOT the "was actually backgrounded" set: `isBackgroundedToolUse`
 * already flags the self-resuming ones, so a foreground/blocking Agent or Workflow
 * carries `backgroundableKind: true` AND `backgrounded: false` — the real
 * availability cost the `workflow.conversational-availability` detector (#2238)
 * counts. Mirrors `SELF_RESUMING_TOOLS` so the two stay in lockstep.
 */
const BACKGROUNDABLE_TOOL_KINDS: ReadonlySet<string> = new Set([
  'Task',
  'Agent',
  'Workflow',
  'ScheduleWakeup',
  'Monitor',
]);

/**
 * A backgroundable toolchain command must be the INVOCATION at the start of a
 * command segment, not a bare word anywhere in the string. Each pattern is
 * anchored to a command boundary — start of string, or right after a shell
 * separator (`&&`, `||`, `|`, `;`, `(`, newline) — past an optional `sudo` /
 * env-var / `time` prefix — so a toolchain binary only matches when it is actually
 * being run. That conservatism is what keeps a leading `ls deploy/`, `cat
 * build.log`, `find . -name "*.test.ts"`, or `grep -n test src/foo.ts` from
 * matching: there `ls`/`cat`/`find`/`grep` is the command and
 * `build`/`test`/`deploy` is just an argument.
 *
 * This is the SHARED classifier (#2238): the parser calls it on the raw Bash
 * `command` to set `backgroundableKind`, and the `conversational-availability`
 * detector consumes that flag rather than re-classifying — so the parser and the
 * detector cannot drift, and the classification survives `slimSessionTimeline`
 * (which strips the command text from the bulk dataset).
 */
// A command-boundary: start of the whole string, or just after a shell operator
// that begins a new command — plus the common no-op prefixes (env assignments,
// `sudo`, `time`) that can sit in front of the real command.
const CMD_START = String.raw`(?:^|[\n;&|(])\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+|sudo\s+|time\s+)*`;
const atCmd = (invocation: string) => new RegExp(CMD_START + invocation, 'i');
const BACKGROUNDABLE_BASH: readonly RegExp[] = [
  // npm/pnpm/yarn run-scripts and the package managers' install/ci verbs.
  atCmd(String.raw`(?:npm|pnpm|yarn)\s+run\b`),
  atCmd(String.raw`(?:npm|pnpm|yarn)\s+(?:ci|install|i|test|t)\b`),
  // Bundlers / typecheckers / test runners invoked directly or via npx.
  atCmd(String.raw`(?:npx\s+)?vite\s+(?:build|preview)\b`),
  atCmd(String.raw`(?:npx\s+)?vitest\b`),
  atCmd(String.raw`(?:npx\s+)?tsc\b`),
  atCmd(String.raw`(?:npx\s+)?(?:jest|playwright|cypress)\b`),
  // Other-language build/test toolchains, invoked as the command.
  atCmd(String.raw`(?:pytest|cargo\s+(?:build|test)|go\s+(?:build|test)|mvn|gradle|make)\b`),
  // Container builds / compose orchestration as the command.
  atCmd(String.raw`(?:docker|podman)\s+(?:compose\s+|build\b)`),
];

/**
 * Whether a raw Bash `command` string is a long-running, backgroundable toolchain
 * invocation (build / test / install / typecheck / container build|compose). Used
 * by the parser to set `backgroundableKind` on Bash `tool_use` entries. Operates
 * on the RAW command text (not the truncated `summary`), so the classification is
 * baked into the entry before `slimSessionTimeline` strips the command.
 */
export function isBackgroundableBashCommand(command: string | undefined): boolean {
  if (!command) return false;
  return BACKGROUNDABLE_BASH.some((re) => re.test(command));
}

/**
 * Whether a `tool_use` is of a backgroundable KIND — a long-running Bash toolchain
 * invocation, or an Agent/Task/Workflow/Monitor/ScheduleWakeup call. This is
 * orthogonal to `isBackgroundedToolUse` ("was actually backgrounded"): a
 * foreground/blocking Agent or Workflow is a backgroundable KIND that was NOT
 * backgrounded. Set as `backgroundableKind` on the entry so it survives slimming.
 */
export function isBackgroundableKind(name: string | undefined, input: unknown): boolean {
  if (name && BACKGROUNDABLE_TOOL_KINDS.has(name)) return true;
  if (name !== 'Bash') return false;
  const command =
    input && typeof input === 'object'
      ? (input as { command?: unknown }).command
      : typeof input === 'string'
        ? input
        : undefined;
  return isBackgroundableBashCommand(typeof command === 'string' ? command : undefined);
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
            ...(hasWaitLanguage(text)
              ? { waitLanguage: true, waitClass: classifyWaitClass(text) }
              : {}),
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
            ...(isBackgroundableKind(block.name, block.input) ? { backgroundableKind: true } : {}),
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
