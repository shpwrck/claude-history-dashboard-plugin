import type { SessionTokenData, TokenEntry, CompactionEvent } from '../types';
import { shortenProject } from './parse-history';
import { resolveModelPricing, SERVER_TOOL_PRICING } from './pricing';
import { parseJsonl, parseMessage, summarize, type ContentBlock } from './parse-utils';

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
  const tokenMap = new Map<string, TokenEntry>();
  let model = 'unknown';

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

      const messageId = msg.id ?? `unknown-${tokenMap.size}`;
      const incoming = {
        timestamp: entry.timestamp ?? '',
        inputTokens: msg.usage.input_tokens ?? 0,
        outputTokens: msg.usage.output_tokens ?? 0,
        cacheCreationTokens: msg.usage.cache_creation_input_tokens ?? 0,
        cacheCreation1hTokens:
          msg.usage.cache_creation?.ephemeral_1h_input_tokens ?? 0,
        cacheReadTokens: msg.usage.cache_read_input_tokens ?? 0,
        webSearchRequests:
          msg.usage.server_tool_use?.web_search_requests ?? 0,
        webFetchRequests:
          msg.usage.server_tool_use?.web_fetch_requests ?? 0,
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
              model: incoming.model ?? prevUsage.model,
            }
          : incoming
      );
    } catch {
      // skip unparseable lines
    }
  }

  const tokenEntries = Array.from(tokenMap.values());

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
    totalCacheCreationTokens: tokenEntries.reduce((s, e) => s + e.cacheCreationTokens, 0),
    totalCacheReadTokens: tokenEntries.reduce((s, e) => s + e.cacheReadTokens, 0),
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
  const cache1h = Math.min(entry.cacheCreation1hTokens, entry.cacheCreationTokens);
  const cache5m = entry.cacheCreationTokens - cache1h;
  return (
    (entry.inputTokens / 1_000_000) * pricing.input +
    (entry.outputTokens / 1_000_000) * pricing.output +
    (cache5m / 1_000_000) * pricing.cacheWrite5m +
    (cache1h / 1_000_000) * pricing.cacheWrite1h +
    (entry.cacheReadTokens / 1_000_000) * pricing.cacheRead +
    entry.webSearchRequests * SERVER_TOOL_PRICING.webSearchRequest +
    entry.webFetchRequests * SERVER_TOOL_PRICING.webFetchRequest
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
