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
  /** Claude Code's own per-record id. See {@link TimelineEntry.entryId}. */
  uuid?: string;
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
  /**
   * Stable per-entry identity (#3390): `${record.uuid}:${blockIndex}`, where
   * `uuid` is the source record's OWN identifier as Claude Code wrote it and
   * `blockIndex` is this entry's position within that record's content-block
   * array (0 for scalar/non-array `message.content` and for non-content-bearing
   * records, e.g. `kind === 'other'`).
   *
   * WHY NOT THE RECORD'S ARRAY POSITION. The first cut of this field keyed on
   * `recordIndex` (the line's position in `parseJsonl(text)`) on the grounds
   * that array positions are provably unique per parse. They are — but
   * UNIQUENESS IS NOT STABILITY, and stability under insertion is the property
   * an evidence ref actually needs. `readMergedSession`/`ingestOne` concatenate
   * `subagents/*.jsonl` in LEXICAL filename order (REFERENCES.md, "Subagent
   * merge order matters"), and those filenames are random hex — so a subagent
   * created late routinely sorts EARLY and its records are spliced in AHEAD of
   * records that already had refs written against them. Measured on this repo's
   * own live session: 18 subagent files, 45 of 153 pairs inverted between
   * creation order and lexical order, and the newest file displaced 820
   * downstream records on the next parse. A positional key silently reassigns
   * the displaced records' ids to their new occupants, so a stale ref resolves
   * CONFIDENTLY TO THE WRONG ENTRY — strictly worse than the #3125 behaviour it
   * replaced, which fell back to the (insertion-stable) timestamp.
   *
   * `uuid` has exactly the property position lacks: it travels with the record,
   * so splicing lines in around it changes nothing. Its known weakness is the
   * mirror image — it is not guaranteed unique (a merge could carry the same
   * record twice) — and that weakness is the safe one, because
   * `resolveEvidenceRef` fails closed on a duplicate id rather than guessing.
   * Measured coverage on the live corpus: 8790 records across 19 files, `uuid`
   * present on 100% of `user`/`assistant`/`system`/`attachment` records and
   * ZERO duplicates.
   *
   * ABSENT WHEN THE RECORD HAS NO `uuid` — we do NOT fall back to a positional
   * id, because a positional fallback is precisely the unstable key this field
   * exists to stop using; a ref with no identity takes evidence.ts's legacy
   * timestamp path, which is lossy but never confidently wrong. In the live
   * corpus the only timestamped records lacking a `uuid` are `queue-operation`
   * lines (533), which become low-value `kind: 'other'` entries.
   *
   * RESIDUAL, stated honestly: `blockIndex` is still a position, so inserting a
   * block AHEAD of another WITHIN one record would shift it. That is no worse
   * than the pre-#3390 behaviour (the old KNOWN LIMITATION documented exactly
   * that misresolution) and is unobservable in the live corpus, where all 7746
   * array-content records carry exactly ONE block. If multi-block records ever
   * appear, replace the block component with a content hash rather than
   * corroborating the id against a timestamp.
   *
   * Optional (like every other derived field on this interface, e.g.
   * `toolUseId`/`waitLanguage`): many hand-built `TimelineEntry` fixtures across
   * the codebase construct entries directly without it, and those must keep
   * typechecking as identity-less entries.
   */
  entryId?: string;
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
   * auto-wakes the session on completion (an explicit `run_in_background` call,
   * or a ScheduleWakeup / Monitor call). The clean-separation control
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
   * carries `backgroundableKind: true` with `backgrounded` absent. Set at parse time
   * (when the raw command is still available) as a derived boolean so it survives
   * `slimSessionTimeline`, which strips the command `summary`. Feeds the
   * `workflow.conversational-availability` detector (#2238): a backgroundable-kind
   * call that was NOT backgrounded yet blocked the turn is recoverable wait.
   */
  backgroundableKind?: boolean;
  /**
   * When `kind === 'user'` or `'assistant'`: the turn text is rediscovery
   * language about durable external state — "where is the remote config", "how
   * was this deployed", "which template created the config" — classified from
   * the *full* untruncated block text by {@link isRediscoveryText} (rediscovery
   * verb co-occurring with a durable-state noun). Like `waitLanguage` /
   * `interrupted` / `backgroundableKind`, this is a derived boolean set at parse
   * time so it survives `slimSessionTimeline` (which strips `summary`), keeping
   * the signal recoverable on the slim bulk/server dataset where the text is
   * gone. Feeds the `workflow.value-of-agent-handoff` detector (#2312): a burst
   * of rediscovery turns early in a session is billed back to the prior
   * durable-state session that left no handoff. Absent ⇒ not rediscovery.
   */
  rediscovery?: boolean;
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
 * Build a {@link TimelineEntry.entryId} from its source record's `uuid` and the
 * entry's block position within that record. Single source of truth for the id
 * format so a future producer (or a test) never hand-rolls a divergent
 * encoding.
 *
 * Returns `undefined` when the record carries no usable `uuid`: an entry with
 * no stable identity must have NO identity, never a positional stand-in. See
 * the field doc on {@link TimelineEntry.entryId} for the measured reason.
 */
export function timelineEntryId(
  recordUuid: string | undefined,
  blockIndex: number
): string | undefined {
  if (typeof recordUuid !== 'string' || recordUuid.length === 0) return undefined;
  return `${recordUuid}:${blockIndex}`;
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
 * Rediscovery language about durable external state — a later session asking
 * "where is the remote config", "how was this set up/deployed", "which template
 * created the config", "reverse-engineer the setup". Requires BOTH a rediscovery
 * verb/phrase AND a durable-state noun so ordinary "where is the bug" chatter
 * does not match. Matched on the *full* untruncated turn text (not the ~200-char
 * `summary`) so the classification is baked into the entry before
 * `slimSessionTimeline` strips the summary. Exported so the
 * `workflow.value-of-agent-handoff` detector (#2312) can reuse the same matcher
 * for client-parsed timelines and its tests assert against the parser's flag.
 */
const REDISCOVERY_RE =
  /\b(?:where\s+(?:is|are|was|were|do|does|did)|how\s+(?:was|were|is|are|do|does|did)\s+[^?!.]{0,60}\b(?:set\s*up|configured|installed|deployed|wired)|what\s+(?:config|template|state|secret|service|host|path)|which\s+(?:config|template|state|secret|service|host|path)|find\s+(?:the\s+)?(?:config|template|state|secret|service|host|path|setup)|rediscover|re-discover|reverse[- ]engineer)\b/i;

const DURABLE_NOUN_RE =
  /\b(?:config|template|state|secret|service|host|remote|server|deploy|deployment|install|setup|runbook|handoff|env|environment|volume|cluster|namespace)\b/i;

export function isRediscoveryText(text: string | undefined): boolean {
  if (!text) return false;
  return REDISCOVERY_RE.test(text) && DURABLE_NOUN_RE.test(text);
}

/**
 * Harness mechanisms that resume the session on their own after a turn ends —
 * the clean-separation control for the passive-wait-stall detector (#1873). A
 * turn that dispatches one of these never strands the session waiting on a human:
 * `run_in_background` calls auto-wake on exit, while ScheduleWakeup/Monitor are
 * deliberate self-resuming polls. A foreground Agent/Task/Workflow blocks the
 * turn and must not be inferred as backgrounded from its tool kind alone.
 */
const ALWAYS_SELF_RESUMING_TOOLS: ReadonlySet<string> = new Set([
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
  return name ? ALWAYS_SELF_RESUMING_TOOLS.has(name) : false;
}

/**
 * Tool kinds that are a backgroundable KIND even when run synchronously in the
 * foreground — a sub-agent fan-out / long-running orchestration call that
 * `run_in_background` (or its own self-resuming nature) could have detached. This
 * is the KIND set, NOT the "was actually backgrounded" set: `isBackgroundedToolUse`
 * flags actual background dispatch, so a foreground/blocking Agent or Workflow
 * carries `backgroundableKind: true` with a falsy `backgrounded` — the real
 * availability cost the `workflow.conversational-availability` detector (#2238)
 * counts. This kind set is intentionally broader than `ALWAYS_SELF_RESUMING_TOOLS`.
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
          entryId: timelineEntryId(raw.uuid, 0),
          timestamp,
          kind: 'user',
          summary: '',
        }));
        continue;
      }
      if (typeof msg.content === 'string') {
        entries.push(timelineEntry({
          entryId: timelineEntryId(raw.uuid, 0),
          timestamp,
          kind: 'user',
          summary: summarize(msg.content),
          ...(isInterruptSentinel(msg.content) ? { interrupted: true } : {}),
          ...(isRediscoveryText(msg.content) ? { rediscovery: true } : {}),
        }));
      } else if (Array.isArray(msg.content)) {
        for (const [blockIndex, block] of msg.content.entries()) {
          if (!block || typeof block !== 'object') continue;
          if (block.type === 'tool_result') {
            entries.push(timelineEntry({
              entryId: timelineEntryId(raw.uuid, blockIndex),
              timestamp,
              kind: 'tool_result',
              summary: stringifyToolResultContent(block.content),
              toolUseId: typeof block.tool_use_id === 'string' ? block.tool_use_id : undefined,
              isError: block.is_error === true,
            }));
          } else if (block.type === 'text') {
            entries.push(timelineEntry({
              entryId: timelineEntryId(raw.uuid, blockIndex),
              timestamp,
              kind: 'user',
              summary: summarize(block.text ?? ''),
              ...(isInterruptSentinel(block.text) ? { interrupted: true } : {}),
              ...(isRediscoveryText(block.text) ? { rediscovery: true } : {}),
            }));
          }
        }
      }
    } else if (type === 'assistant') {
      const msg = parseMessage(raw.message);
      if (!msg || !Array.isArray(msg.content)) continue;
      for (const [blockIndex, block] of msg.content.entries()) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'text') {
          const text = block.text ?? '';
          entries.push(timelineEntry({
            entryId: timelineEntryId(raw.uuid, blockIndex),
            timestamp,
            kind: 'assistant',
            summary: summarize(text),
            ...(hasWaitLanguage(text)
              ? { waitLanguage: true, waitClass: classifyWaitClass(text) }
              : {}),
            ...(isRediscoveryText(text) ? { rediscovery: true } : {}),
          }));
        } else if (block.type === 'thinking') {
          entries.push(timelineEntry({
            entryId: timelineEntryId(raw.uuid, blockIndex),
            timestamp,
            kind: 'thinking',
            summary: summarize(block.thinking ?? block.text ?? ''),
          }));
        } else if (block.type === 'tool_use') {
          entries.push(timelineEntry({
            entryId: timelineEntryId(raw.uuid, blockIndex),
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
        entryId: timelineEntryId(raw.uuid, 0),
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
