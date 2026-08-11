import type { SessionTokenData, TokenEntry, CompactionEvent } from '../types';
import { shortenProject } from './parse-history';
import { entryCostBreakdown, resolveModelPricing } from './pricing';
import { parseJsonl, parseMessage, summarize, type ContentBlock } from './parse-utils';
import { resultContentSize } from './parse-tools';
import {
  estimateTokens,
  isThinkingBlock,
  reconstructThinkingTokens,
  visibleBlockTokens,
} from './thinking-tokens';

/**
 * Prompt-regime derivation (#3405) keys off the `version` dimension this module
 * parses below, but it lives in `./prompt-regime` and is imported from there
 * directly — deliberately NOT re-exported here.
 *
 * A convenience pass-through on this module is not free: `parse-sessions` is
 * bundled into the SPA upload-pipeline worker, so re-exporting dragged the
 * boundary table into a bundle that never runs detectors (the engine-absent
 * gate proves the catalog is excluded) and pushed that route 1,520 B over its
 * size cap. The only consumer is server-side, so it imports
 * `./prompt-regime` directly and the SPA pays nothing.
 *
 * @see ./prompt-regime.ts — `promptRegimeForSession` / `summarizePromptRegimes`
 */

/**
 * Chars/token density for `tool_result` PAYLOAD content (#1926 context
 * composition). Tool output (file contents, command logs, JSON) tokenizes
 * somewhat denser than prose but lighter than minified JSON: ~3.5 chars/token
 * is a documented mid estimate between the thinking-token text (2.6) and
 * tool_use JSON (1.7) densities. This bucket is a totals-anchored
 * reconstruction, not a billed split, so the absolute density only shifts the
 * raw share between buckets; the apportionment is re-anchored to the billed
 * total and the residual is shown (see `context-composition.ts`).
 */
const TOOL_RESULT_CHARS_PER_TOKEN = 3.5;

/**
 * Whether a session's `entrypoint` marks an unattended (non-interactive) run.
 * Real transcripts carry `cli` (interactive human), `sdk-cli`, and `sdk-py`
 * (both SDK automation) — there is no `cron`/`interactive` value (see #291).
 * Any `sdk-*` entrypoint is unattended; `cli` (and absent) is interactive.
 */
export function isUnattendedEntrypoint(entrypoint: string | undefined): boolean {
  return typeof entrypoint === 'string' && entrypoint.startsWith('sdk-');
}

interface RawSessionEntry {
  type?: string;
  message?: string;
  timestamp?: string;
  // Per-session dimensions carried top-level on each transcript line.
  version?: string;
  gitBranch?: string;
  entrypoint?: string;
  // The session's working directory (decoded project path). Same value
  // `deriveEntries` uses for history entries, so it joins cleanly with
  // `Session.project`.
  cwd?: string;
}

interface AssistantMessage {
  id?: string;
  model?: string;
  /**
   * Content blocks of this assistant message. Used to estimate visible-output
   * tokens (text + tool_use args) for the #1927 thinking-token residual; the
   * blocks of one logical message are split across multiple transcript lines
   * sharing the same `id`, so they accumulate per `id`.
   */
  content?: ContentBlock[] | string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    service_tier?: string;
    /** Breakdown of cache_creation_input_tokens by TTL tier. */
    cache_creation?: {
      ephemeral_5m_input_tokens?: number;
      ephemeral_1h_input_tokens?: number;
    };
    /** Per-request server-side tool usage (web search / fetch). */
    server_tool_use?: {
      web_search_requests?: number;
      web_fetch_requests?: number;
    };
  };
}

/**
 * Extract the plain text of one user message for the session OPENER (#743).
 *
 * `message.content` is either a bare string or an array of content blocks; only
 * `{type:'text'}` blocks carry user prose (a tool_result block is the harness
 * echoing tool output back, not the human's words). Returns the concatenated
 * text, or `''` when the message holds no user text — the caller treats an
 * empty opener as "no opener yet" and keeps looking at later user lines.
 */
function userMessageText(rawMessage: unknown): string {
  const msg = parseMessage(rawMessage);
  if (!msg) return '';
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    const parts: string[] = [];
    for (const block of msg.content as ContentBlock[]) {
      if (block && typeof block === 'object' && block.type === 'text') {
        if (typeof block.text === 'string') parts.push(block.text);
      }
    }
    return parts.join(' ');
  }
  return '';
}

/** Runtime guard for untrusted transcript usage counters. */
function nonNegativeFiniteOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

function detectCompactionEvents(entries: TokenEntry[]): CompactionEvent[] {
  const compactionEvents: CompactionEvent[] = [];
  const MAX_GAP_MS = 5 * 60 * 1000;

  for (let i = 1; i < entries.length; i++) {
    const prev = entries[i - 1];
    const curr = entries[i];

    const prevTime = new Date(prev.timestamp).getTime();
    const currTime = new Date(curr.timestamp).getTime();
    if (isNaN(prevTime) || isNaN(currTime) || currTime - prevTime > MAX_GAP_MS) {
      continue;
    }

    const prevContext = prev.inputTokens + prev.cacheReadTokens + prev.cacheCreationTokens;
    const currContext = curr.inputTokens + curr.cacheReadTokens + curr.cacheCreationTokens;

    if (currContext < prevContext * 0.7) {
      const reductionPercent = ((prevContext - currContext) / prevContext) * 100;
      compactionEvents.push({
        timestamp: curr.timestamp,
        beforeContext: prevContext,
        afterContext: currContext,
        reductionPercent,
      });
    }
  }

  return compactionEvents;
}

export function parseSessionJsonl(
  text: string,
  fileName: string,
  project?: string
): SessionTokenData | null {
  // Per-message accumulator: a TokenEntry plus the two transient #1927 fields
  // (`visibleTokens` summed across the message's content-block lines,
  // `hasThinking` OR-ed). These are resolved into the final `thinkingTokens`
  // and stripped before the entry is returned, so they never leak into the
  // serialized blob.
  type TokenAccumulator = TokenEntry & {
    visibleTokens: number;
    hasThinking: boolean;
    // #1926: cumulative context snapshots, taken once at the message's FIRST
    // line (before this message's own visible output is folded into history).
    ctxHistorySnapshot: number;
    ctxToolResultSnapshot: number;
  };
  const tokenMap = new Map<string, TokenAccumulator>();
  let model = 'unknown';

  // #1926: running cumulative estimates of the two high-fidelity input-context
  // buckets, advanced in transcript order. `cumHistoryTokens` = user prose +
  // prior assistant visible output (text + tool_use args). `cumToolResultTokens`
  // = tool_result payload content. At each assistant message's first line we
  // snapshot these as that turn's input-context composition (see
  // `context-composition.ts`).
  let cumHistoryTokens = 0;
  let cumToolResultTokens = 0;

  // #1928: ID linkage between billed messages and the tool calls they
  // dispatched. `tool_use` block ids accumulate per assistant message id (above,
  // in the assistant branch); `tool_result` payload sizes are collected here
  // keyed by `tool_use_id` from the user lines that echo tool output back. After
  // the per-message accumulation, each `TokenEntry` is tagged with its
  // `toolUseIds` and the summed `toolResultBytes` joined by those ids — the tight
  // ID join that supersedes the timestamp-/byte-share heuristic where ids exist.
  const resultBytesByToolUseId = new Map<string, number>();

  // Per-session dimensions: take the first non-empty value seen.
  let version: string | undefined;
  let gitBranch: string | undefined;
  let entrypoint: string | undefined;
  let serviceTier: string | undefined;
  // The transcript's working directory (decoded project path). Captured as a
  // project BACKSTOP (#1765): the server ingest path parses tokens without a
  // `project` arg, so without this `tok.project` is empty and any consumer that
  // can't join the session row (e.g. a windowed Cost view that drops a session
  // started before the window but active within it) falls through to
  // "(unknown project)". `cwd` is the same value `deriveEntries` writes onto
  // history entries, so it stays label-consistent with `Session.project`.
  let cwd: string | undefined;
  // The session OPENER: text of the FIRST user message that carries any prose
  // (#743). Captured once, then frozen — later user turns don't overwrite it.
  let opener: string | undefined;

  for (const entry of parseJsonl(text) as RawSessionEntry[]) {
    try {
      // Capture top-level dimensions from any line that carries them.
      if (version === undefined && entry.version) version = entry.version;
      if (gitBranch === undefined && entry.gitBranch) gitBranch = entry.gitBranch;
      if (entrypoint === undefined && entry.entrypoint) entrypoint = entry.entrypoint;
      if (cwd === undefined && entry.cwd) cwd = entry.cwd;

      // Opener: first user-role line with non-empty text wins. Tool-result-only
      // user lines (no text block) yield '' and are skipped so we keep looking.
      if (opener === undefined && entry.type === 'user' && entry.message) {
        const text = summarize(userMessageText(entry.message));
        if (text) opener = text;
      }

      // #1928: user lines echo tool output back as `tool_result` blocks carrying
      // the matching `tool_use_id`. Size each payload (same sizing as
      // parse-tools `ToolCall.resultBytes`) and key it by id so the assistant
      // message that emitted that `tool_use` can join its result bytes by ID.
      if (entry.type === 'user' && entry.message) {
        // #1926: user prose enters the conversation-history bucket.
        cumHistoryTokens += estimateTokens(userMessageText(entry.message));
        const userMsg = parseMessage(entry.message);
        if (userMsg && Array.isArray(userMsg.content)) {
          for (const block of userMsg.content as ContentBlock[]) {
            if (!block || block.type !== 'tool_result') continue;
            // #1926: ALL tool_result payload tokens feed the file/tool bucket,
            // whether or not the block carries a joinable tool_use_id.
            cumToolResultTokens += Math.ceil(
              resultContentSize(block.content) / TOOL_RESULT_CHARS_PER_TOKEN
            );
            const id = block.tool_use_id;
            if (typeof id !== 'string' || !id) continue;
            const bytes = resultContentSize(block.content);
            resultBytesByToolUseId.set(
              id,
              (resultBytesByToolUseId.get(id) ?? 0) + bytes
            );
          }
        }
      }

      if (entry.type !== 'assistant' || !entry.message) continue;

      let msg: AssistantMessage;
      try {
        msg = typeof entry.message === 'string'
          ? JSON.parse(entry.message)
          : entry.message;
      } catch {
        continue;
      }

      if (!msg.usage) continue;
      if (msg.model) model = msg.model;
      if (serviceTier === undefined && msg.usage.service_tier) {
        serviceTier = msg.usage.service_tier;
      }

      // #1927: estimate the VISIBLE-output tokens carried on THIS line's
      // content blocks (text prose + tool_use arg JSON) and note whether any
      // thinking block is present. The blocks of one logical assistant message
      // are split across multiple transcript lines sharing `id`, so these
      // accumulate per id (summed below) and feed the thinking-token residual.
      let lineVisibleTokens = 0;
      let lineHasThinking = false;
      // #1928: tool_use block ids emitted on this line, in order.
      const lineToolUseIds: string[] = [];
      if (Array.isArray(msg.content)) {
        for (const block of msg.content as ContentBlock[]) {
          lineVisibleTokens += visibleBlockTokens(block);
          if (isThinkingBlock(block)) lineHasThinking = true;
          if (block && block.type === 'tool_use' && typeof block.id === 'string' && block.id) {
            lineToolUseIds.push(block.id);
          }
        }
      } else if (typeof msg.content === 'string') {
        lineVisibleTokens += visibleBlockTokens({ type: 'text', text: msg.content });
      }

      const messageId = msg.id ?? `unknown-${tokenMap.size}`;
      const incoming = {
        timestamp: entry.timestamp ?? '',
        inputTokens: nonNegativeFiniteOrZero(msg.usage.input_tokens),
        outputTokens: nonNegativeFiniteOrZero(msg.usage.output_tokens),
        cacheCreationTokens: nonNegativeFiniteOrZero(
          msg.usage.cache_creation_input_tokens
        ),
        cacheCreation1hTokens:
          nonNegativeFiniteOrZero(
            msg.usage.cache_creation?.ephemeral_1h_input_tokens
          ),
        cacheReadTokens: nonNegativeFiniteOrZero(
          msg.usage.cache_read_input_tokens
        ),
        webSearchRequests:
          nonNegativeFiniteOrZero(
            msg.usage.server_tool_use?.web_search_requests
          ),
        webFetchRequests:
          nonNegativeFiniteOrZero(
            msg.usage.server_tool_use?.web_fetch_requests
          ),
        // #1927 accumulators (not part of TokenEntry): summed across the
        // message's lines, then resolved to `thinkingTokens` after the
        // outputTokens max-merge below.
        visibleTokens: lineVisibleTokens,
        hasThinking: lineHasThinking,
        // #1928: tool_use ids emitted on this line; concatenated (not max-merged)
        // across the message's streamed lines below, then deduped at resolution.
        toolUseIds: lineToolUseIds,
        // #1926: this turn's input-context snapshot. Valid for the message's
        // FIRST line (taken before its own visible output is folded into
        // history below); the merge keeps the first snapshot for later lines.
        ctxHistorySnapshot: cumHistoryTokens,
        ctxToolResultSnapshot: cumToolResultTokens,
        model: msg.model ?? model,
      };
      // #457: a single assistant message id can appear on multiple transcript
      // lines (streamed usage deltas). Earlier code did a blind last-write-wins
      // `set`, so a trailing chunk that reports `cache_read_input_tokens: 0`
      // (or zeroed usage) would clobber the real numbers — surfacing as a 0%
      // cache hit rate downstream. Merge per-field by max so partial/zero
      // chunks never erase populated values.
      const prevUsage = tokenMap.get(messageId);
      tokenMap.set(
        messageId,
        prevUsage
          ? {
              timestamp: prevUsage.timestamp || incoming.timestamp,
              inputTokens: Math.max(prevUsage.inputTokens, incoming.inputTokens),
              outputTokens: Math.max(
                prevUsage.outputTokens,
                incoming.outputTokens
              ),
              cacheCreationTokens: Math.max(
                prevUsage.cacheCreationTokens,
                incoming.cacheCreationTokens
              ),
              cacheCreation1hTokens: Math.max(
                prevUsage.cacheCreation1hTokens,
                incoming.cacheCreation1hTokens
              ),
              cacheReadTokens: Math.max(
                prevUsage.cacheReadTokens,
                incoming.cacheReadTokens
              ),
              webSearchRequests: Math.max(
                prevUsage.webSearchRequests,
                incoming.webSearchRequests
              ),
              webFetchRequests: Math.max(
                prevUsage.webFetchRequests,
                incoming.webFetchRequests
              ),
              // #1927: distinct content blocks of the same message arrive on
              // separate lines, so SUM their visible-token estimates (each
              // block counted once). If a line ever repeats blocks already
              // seen, over-counting visible only shrinks the thinking residual
              // toward 0 — the safe (conservative) direction.
              visibleTokens: prevUsage.visibleTokens + incoming.visibleTokens,
              hasThinking: prevUsage.hasThinking || incoming.hasThinking,
              // #1928: tool_use blocks of one message arrive on separate streamed
              // lines, so CONCATENATE their ids (deduped at resolution).
              toolUseIds: [
                ...(prevUsage.toolUseIds ?? []),
                ...(incoming.toolUseIds ?? []),
              ],
              // #1926: keep the FIRST line's input-context snapshot; later lines
              // of the same message must not re-snapshot a grown cumulative.
              ctxHistorySnapshot: prevUsage.ctxHistorySnapshot,
              ctxToolResultSnapshot: prevUsage.ctxToolResultSnapshot,
              model: incoming.model ?? prevUsage.model,
            }
          : incoming
      );

      // #1926: fold THIS assistant line's visible output (text + tool_use args)
      // into the running history cumulative so it counts toward LATER turns'
      // input context — done after the snapshot above, so it never lands in this
      // turn's own input composition.
      cumHistoryTokens += lineVisibleTokens;
    } catch {
      // skip unparseable lines
    }
  }

  // Resolve each accumulated message into a clean TokenEntry, computing the
  // #1927 thinking-token residual from the (max-merged) billed output and the
  // (summed) visible-token estimate. The `visibleTokens`/`hasThinking`
  // accumulators are dropped here so they never leak into the serialized blob.
  // #1926: accumulate the per-turn context snapshots into per-SESSION sums
  // (stored on SessionTokenData, not per entry, to keep the dataset lean).
  let contextHistoryTokensSum = 0;
  let contextToolResultTokensSum = 0;
  const tokenEntries: TokenEntry[] = Array.from(tokenMap.values()).map((acc) => {
    const {
      visibleTokens,
      hasThinking,
      toolUseIds,
      ctxHistorySnapshot,
      ctxToolResultSnapshot,
      ...rest
    } = acc;
    contextHistoryTokensSum += ctxHistorySnapshot;
    contextToolResultTokensSum += ctxToolResultSnapshot;
    // #1928: dedupe the message's tool_use ids (preserving first-seen order) and
    // join their result-payload bytes by ID. Both fields are omitted when the
    // message dispatched no tool calls, so rows with no tools stay byte-clean.
    const uniqueToolUseIds = toolUseIds ? Array.from(new Set(toolUseIds)) : [];
    const toolResultBytes = uniqueToolUseIds.reduce(
      (sum, id) => sum + (resultBytesByToolUseId.get(id) ?? 0),
      0
    );
    return {
      ...rest,
      cacheCreation1hTokens: Math.min(
        rest.cacheCreation1hTokens,
        rest.cacheCreationTokens
      ),
      thinkingTokens: reconstructThinkingTokens(
        rest.outputTokens,
        visibleTokens,
        hasThinking
      ),
      ...(uniqueToolUseIds.length > 0 ? { toolUseIds: uniqueToolUseIds } : {}),
      ...(toolResultBytes > 0 ? { toolResultBytes } : {}),
    };
  });

  if (tokenEntries.length === 0) return null;

  const sessionId = fileName.replace(/\.jsonl$/, '');
  const compactionEvents = detectCompactionEvents(tokenEntries);
  const hasUnknownModel = tokenEntries.some(
    (e) => resolveModelPricing(e.model).isUnknownModel
  );

  // Prefer an explicit caller-supplied project (the upload path passes the
  // decoded path from the file picker); fall back to the transcript's own `cwd`
  // so the server ingest path — which supplies no `project` arg — still carries
  // a project on every token row (#1765).
  const resolvedProject = project ?? cwd;

  return {
    sessionId,
    ...(resolvedProject
      ? { project: resolvedProject, projectShort: shortenProject(resolvedProject) }
      : {}),
    totalInputTokens: tokenEntries.reduce((s, e) => s + e.inputTokens, 0),
    totalOutputTokens: tokenEntries.reduce((s, e) => s + e.outputTokens, 0),
    totalThinkingTokens: tokenEntries.reduce((s, e) => s + (e.thinkingTokens ?? 0), 0),
    totalCacheCreationTokens: tokenEntries.reduce((s, e) => s + e.cacheCreationTokens, 0),
    totalCacheReadTokens: tokenEntries.reduce((s, e) => s + e.cacheReadTokens, 0),
    // #1926: per-session context-composition sums (omit when 0 to stay byte-clean).
    ...(contextHistoryTokensSum > 0 ? { contextHistoryTokensSum } : {}),
    ...(contextToolResultTokensSum > 0 ? { contextToolResultTokensSum } : {}),
    model,
    messageCount: tokenEntries.length,
    entries: tokenEntries,
    compactionEvents,
    hasUnknownModel,
    version,
    gitBranch,
    entrypoint,
    serviceTier,
    opener,
  };
}

/**
 * Estimate cost for a session using official Anthropic pricing.
 *
 * Cache writes are split by TTL tier: the `ephemeral_1h_input_tokens` portion
 * is billed at the 1-hour rate (2x base input) and the remainder at the
 * 5-minute rate (1.25x base input). When the 1h sub-field is absent it is 0,
 * so the whole cache-creation count falls to the 5-minute rate exactly as
 * before (no change to existing totals).
 *
 * Server-side tool use (`web_search_requests` / `web_fetch_requests`) is
 * charged at a flat per-request rate (see SERVER_TOOL_PRICING) on top of the
 * token cost of the content those tools pull into context.
 *
 * `<synthetic>` entries resolve to zero pricing and contribute nothing.
 *
 * Memoized by `SessionTokenData` identity via a WeakMap — the same parsed
 * row is referenced from 11+ call sites (recommendations rules, cost
 * attribution, token usage view, agent effectiveness), and the math is pure,
 * so the first call wins for everyone. Cleared automatically when the
 * underlying object is GC'd. See issue #161.
 */
const costCache: WeakMap<SessionTokenData, number> = new WeakMap();

/**
 * Cost of a single `TokenEntry` under the same pricing rules as
 * `estimateCost` (which is exactly the sum of this over `data.entries`).
 * Exported so per-model attribution (#920 Model -> Project flow) can split a
 * session's spend by the model each entry actually used without duplicating
 * the pricing math.
 */
export function estimateEntryCost(entry: TokenEntry): number {
  const { pricing } = resolveModelPricing(entry.model);
  const terms = entryCostBreakdown(entry, pricing);
  return (
    terms.input +
    terms.output +
    terms.cacheWrite5m +
    terms.cacheWrite1h +
    terms.cacheRead +
    terms.serverTools
  );
}

export function estimateCost(data: SessionTokenData): number {
  const cached = costCache.get(data);
  if (cached !== undefined) return cached;
  let total = 0;
  for (const entry of data.entries) {
    total += estimateEntryCost(entry);
  }
  costCache.set(data, total);
  return total;
}
