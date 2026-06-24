/**
 * Context-composition reconstruction (#1926): dissect the ~86%-context bill into
 * named token buckets.
 *
 * WHY THIS IS A RECONSTRUCTION, NOT A BILLED SPLIT. The API `usage` object only
 * ever reports per-turn TOTALS (`input_tokens`, `cache_creation_input_tokens`,
 * `cache_read_input_tokens`, `output_tokens`) — there is no per-content-block
 * billing breakdown anywhere in the source, and there can't be. So the method
 * is: tokenize the locally-recorded content of each bucket (done in
 * `parse-sessions.ts`, accumulated per session onto `SessionTokenData`), then
 * reconcile to the billed totals with the unexplained gap surfaced as an
 * explicit residual.
 *
 * ADDITIVE, NOT PROPORTIONAL. The two HIGH-fidelity buckets (`conversationHistory`,
 * `toolPayloads`) are reported at their tokenized values — we do not scale them
 * to fit. The `systemPrefix` is reported at its config-reconstructed lower bound.
 * Whatever the billed input total covers BEYOND those three (request framing,
 * tool/MCP schemas + harness system prompt that are absent from local data, and
 * tokenizer imprecision) lands in `unattributedResidual`. Only in the rare case
 * where the three raw estimates OVERSHOOT the billed input do we scale them down
 * (residual 0). This keeps the high-fidelity buckets crisp and concentrates all
 * uncertainty in the residual + reconstructed prefix.
 *
 * FIDELITY VARIES BY BUCKET — this module owns that honestly:
 *   - HIGH fidelity: `conversationHistory` and `toolPayloads` are fully present
 *     in the transcript and tokenized (calibrated densities, `thinking-tokens.ts`).
 *   - OUTPUT side: `thinking` is the #1927 residual estimate; `visibleOutput` is
 *     `output − thinking`. Together they reconcile to `output_tokens` exactly.
 *   - LOW fidelity / reconstructed-from-config: `systemPrefix` (system prompt +
 *     tool/MCP schemas) is NOT logged per turn. The `input_schema` of every tool
 *     is ABSENT from transcripts. We reconstruct a LOWER BOUND from the CURRENT
 *     ingested config (CLAUDE.md/AGENTS.md text + skill/agent/command
 *     descriptions + settings) with a DRIFT CAVEAT, applied once per turn (it is
 *     re-sent every turn). The un-sizable remainder falls into the residual.
 */
import type { LiveConfig, SessionTokenData, TokenEntry } from '../types';
import { resolveModelPricing, SERVER_TOOL_PRICING } from './pricing';
import { estimateTokens } from './thinking-tokens';

/** The six named buckets a token bill decomposes into. */
export interface ContextBuckets {
  /**
   * Static prefix: system prompt + tool/MCP schemas. RECONSTRUCTED-FROM-CONFIG
   * LOWER BOUND (see {@link ConfigPrefixEstimate}); the un-sizable remainder
   * (tool schemas, harness system prompt) falls into {@link unattributedResidual}.
   */
  systemPrefix: number;
  /** Conversation history: user prose + prior assistant visible output. High fidelity. */
  conversationHistory: number;
  /** File/tool payloads (`tool_result` content). High fidelity; usually dominant. */
  toolPayloads: number;
  /** Reasoning tokens billed inside output (#1927 residual estimate). */
  thinking: number;
  /** Visible assistant output (text + tool_use args) = `output − thinking`. */
  visibleOutput: number;
  /**
   * Billed total minus the sum of the five attributed buckets. Captures
   * request framing, the known-absent static-prefix content (tool/MCP schemas +
   * harness system prompt not present in local data), and tokenizer
   * imprecision. >= 0.
   */
  unattributedResidual: number;
}

/** A composition expressed in both tokens and apportioned US dollars. */
export interface ContextComposition {
  tokens: ContextBuckets;
  cost: ContextBuckets;
  /** Billed input-side tokens (`input + cacheCreation + cacheRead`). */
  billedInputTokens: number;
  /** Billed output tokens. */
  billedOutputTokens: number;
}

/** Config-derived static-prefix estimate, with its explicit fidelity caveat. */
export interface ConfigPrefixEstimate {
  /** Per-turn reconstructed prefix tokens (a LOWER BOUND). */
  totalTokens: number;
  breakdown: {
    /** CLAUDE.md / AGENTS.md (global + per-project) instruction text. */
    instructions: number;
    /** Skill + subagent + command `description` text. */
    resourceDescriptions: number;
    /** Serialized settings.json. */
    settings: number;
  };
  /** Number of configured MCP servers whose tool schemas could NOT be sized. */
  unsizableMcpServers: number;
  /** Human-readable drift + low-fidelity caveat for the UI to surface verbatim. */
  caveat: string;
}

/** The per-session fields the composition reads (subset of SessionTokenData). */
export type ComposableSession = Pick<
  SessionTokenData,
  | 'entries'
  | 'totalInputTokens'
  | 'totalOutputTokens'
  | 'totalCacheCreationTokens'
  | 'totalCacheReadTokens'
  | 'totalThinkingTokens'
  | 'messageCount'
  | 'contextHistoryTokensSum'
  | 'contextToolResultTokensSum'
>;

const emptyBuckets = (): ContextBuckets => ({
  systemPrefix: 0,
  conversationHistory: 0,
  toolPayloads: 0,
  thinking: 0,
  visibleOutput: 0,
  unattributedResidual: 0,
});

/**
 * Reconstruct the per-turn static-prefix token floor from the CURRENT ingested
 * config.
 *
 * This is a deliberate LOWER BOUND: tool/MCP `input_schema` and the harness
 * system prompt are not available locally, so they are NOT counted here (they
 * surface in the residual). What IS counted: CLAUDE.md/AGENTS.md instruction
 * text, resource descriptions, and settings — exactly the config the dashboard
 * already ingests. The prefix is static, re-sent every turn.
 */
export function tokenizeConfigPrefix(
  liveConfig: Pick<
    LiveConfig,
    'claudeMd' | 'skills' | 'subagents' | 'commands' | 'mcpServers' | 'settings'
  > | null | undefined
): ConfigPrefixEstimate {
  const baseCaveat =
    'Reconstructed from CURRENT config, not what was sent per turn (drift). ' +
    'A lower bound: tool/MCP schemas and the harness system prompt are not ' +
    'available locally and are not counted here — they fall into the residual.';
  if (!liveConfig) {
    return {
      totalTokens: 0,
      breakdown: { instructions: 0, resourceDescriptions: 0, settings: 0 },
      unsizableMcpServers: 0,
      caveat: baseCaveat,
    };
  }

  let instructions = 0;
  if (liveConfig.claudeMd?.global) instructions += estimateTokens(liveConfig.claudeMd.global);
  for (const text of Object.values(liveConfig.claudeMd?.perProject ?? {})) {
    if (text) instructions += estimateTokens(text);
  }

  let resourceDescriptions = 0;
  for (const res of [
    ...(liveConfig.skills ?? []),
    ...(liveConfig.subagents ?? []),
    ...(liveConfig.commands ?? []),
  ]) {
    if (res?.description) resourceDescriptions += estimateTokens(res.description);
  }

  let settings = 0;
  if (liveConfig.settings) {
    try {
      settings = estimateTokens(JSON.stringify(liveConfig.settings));
    } catch {
      settings = 0;
    }
  }

  const unsizableMcpServers = (liveConfig.mcpServers ?? []).length;
  const caveat =
    unsizableMcpServers > 0
      ? `${baseCaveat} ${unsizableMcpServers} MCP server(s) configured whose tool schemas could not be sized.`
      : baseCaveat;

  return {
    totalTokens: instructions + resourceDescriptions + settings,
    breakdown: { instructions, resourceDescriptions, settings },
    unsizableMcpServers,
    caveat,
  };
}

/** Per-entry input/output cost split, using the same pricing as `estimateEntryCost`. */
function entryCostSplit(entry: TokenEntry): { input: number; output: number } {
  const { pricing } = resolveModelPricing(entry.model);
  const cache1h = Math.min(entry.cacheCreation1hTokens, entry.cacheCreationTokens);
  const cache5m = entry.cacheCreationTokens - cache1h;
  const input =
    (entry.inputTokens / 1_000_000) * pricing.input +
    (cache5m / 1_000_000) * pricing.cacheWrite5m +
    (cache1h / 1_000_000) * pricing.cacheWrite1h +
    (entry.cacheReadTokens / 1_000_000) * pricing.cacheRead +
    entry.webSearchRequests * SERVER_TOOL_PRICING.webSearchRequest +
    entry.webFetchRequests * SERVER_TOOL_PRICING.webFetchRequest;
  const output = (entry.outputTokens / 1_000_000) * pricing.output;
  return { input, output };
}

/**
 * Compose one session's token bill into the six buckets, anchored to the billed
 * totals with an explicit residual (additive model — see the file header).
 *
 * `prefixTokens` is the PER-TURN reconstructed prefix; the prefix is re-sent
 * every turn, so its session contribution is `prefixTokens * messageCount`.
 * Cost is split exactly from the per-entry pricing and apportioned across the
 * buckets by their token share of the input/output sides.
 */
export function composeSession(
  session: ComposableSession,
  prefixTokens: number
): ContextComposition {
  const billedInputTokens =
    session.totalInputTokens + session.totalCacheCreationTokens + session.totalCacheReadTokens;
  const billedOutputTokens = session.totalOutputTokens;

  const rawPrefix = Math.max(0, prefixTokens) * Math.max(0, session.messageCount);
  const rawHistory = Math.max(0, session.contextHistoryTokensSum ?? 0);
  const rawToolPayloads = Math.max(0, session.contextToolResultTokensSum ?? 0);
  const rawInputSum = rawPrefix + rawHistory + rawToolPayloads;

  let systemPrefix = rawPrefix;
  let conversationHistory = rawHistory;
  let toolPayloads = rawToolPayloads;
  let unattributedResidual = 0;
  if (rawInputSum > billedInputTokens && rawInputSum > 0) {
    // Overshoot: scale the three input buckets down to the billed anchor.
    const scale = billedInputTokens / rawInputSum;
    systemPrefix = rawPrefix * scale;
    conversationHistory = rawHistory * scale;
    toolPayloads = rawToolPayloads * scale;
  } else {
    unattributedResidual = billedInputTokens - rawInputSum;
  }

  const thinking = Math.min(Math.max(0, session.totalThinkingTokens ?? 0), billedOutputTokens);
  const visibleOutput = billedOutputTokens - thinking;

  const tokens: ContextBuckets = {
    systemPrefix,
    conversationHistory,
    toolPayloads,
    thinking,
    visibleOutput,
    unattributedResidual,
  };

  // Exact per-session input/output cost from the entries, apportioned across
  // buckets by their token share of each side.
  let inputCost = 0;
  let outputCost = 0;
  for (const entry of session.entries) {
    const split = entryCostSplit(entry);
    inputCost += split.input;
    outputCost += split.output;
  }
  const inputBucketTokens =
    systemPrefix + conversationHistory + toolPayloads + unattributedResidual;
  const inShare = (n: number) => (inputBucketTokens > 0 ? (n / inputBucketTokens) * inputCost : 0);
  const outShare = (n: number) => (billedOutputTokens > 0 ? (n / billedOutputTokens) * outputCost : 0);
  const cost: ContextBuckets = {
    systemPrefix: inShare(systemPrefix),
    conversationHistory: inShare(conversationHistory),
    toolPayloads: inShare(toolPayloads),
    thinking: outShare(thinking),
    visibleOutput: outShare(visibleOutput),
    unattributedResidual: inShare(unattributedResidual),
  };

  return { tokens, cost, billedInputTokens, billedOutputTokens };
}

const addInto = (acc: ContextBuckets, b: ContextBuckets) => {
  acc.systemPrefix += b.systemPrefix;
  acc.conversationHistory += b.conversationHistory;
  acc.toolPayloads += b.toolPayloads;
  acc.thinking += b.thinking;
  acc.visibleOutput += b.visibleOutput;
  acc.unattributedResidual += b.unattributedResidual;
};

/** Compose an aggregate across many sessions. */
export function composeAggregate(
  sessions: ReadonlyArray<ComposableSession>,
  prefixTokens: number
): ContextComposition {
  const tokens = emptyBuckets();
  const cost = emptyBuckets();
  let billedInputTokens = 0;
  let billedOutputTokens = 0;
  for (const session of sessions) {
    const c = composeSession(session, prefixTokens);
    addInto(tokens, c.tokens);
    addInto(cost, c.cost);
    billedInputTokens += c.billedInputTokens;
    billedOutputTokens += c.billedOutputTokens;
  }
  return { tokens, cost, billedInputTokens, billedOutputTokens };
}

/** Sum of all six token buckets — equals `billedInput + billedOutput` (anchored). */
export function totalTokens(b: ContextBuckets): number {
  return (
    b.systemPrefix +
    b.conversationHistory +
    b.toolPayloads +
    b.thinking +
    b.visibleOutput +
    b.unattributedResidual
  );
}
