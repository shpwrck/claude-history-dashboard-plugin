import {
  getLlmUsageEntry,
  type LlmEgressScrubMode,
  type LlmUsageId,
} from './llm-registry';
import { redactSecretsDeep } from './secret-redaction';

const ANTHROPIC_BASE = 'https://api.anthropic.com/v1';
const ANTHROPIC_VERSION = '2023-06-01';
const OAUTH_BETA = 'oauth-2025-04-20';

export type AnthropicCredential =
  | { kind: 'oauth'; token: string }
  | { kind: 'console-key'; apiKey: string };

export interface CallAnthropicRequest {
  credential: AnthropicCredential;
  method?: 'GET' | 'POST';
  path: '/messages' | '/models';
  body?: unknown;
  headers?: Record<string, string>;
  containsClaudeData?: boolean;
  scrubReceipt?: EgressScrubReceipt;
  capChecked?: boolean;
  capReceipt?: LlmCapReceipt;
  fetchImpl?: typeof fetch;
}

export interface AnthropicChatRequest {
  apiKey: string;
  model: string;
  maxTokens: number;
  system?: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  scrubReceipt: EgressScrubReceipt;
  capChecked: true;
  capReceipt: LlmCapReceipt;
  /**
   * True when the message content was rendered from the user's `~/.claude` tree
   * (#3111). Forwarded to the chokepoint so a Rule-A/OAuth-credentialled entry
   * fails closed instead of sending that content under the subscription
   * credential (ADR 0008).
   */
  containsClaudeData?: boolean;
  fetchImpl?: typeof fetch;
}

export interface AnthropicChatResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
  stopReason: string | null;
}

export interface EgressScrubReceipt {
  registryId: LlmUsageId;
  mode: LlmEgressScrubMode;
  inputBytes: number;
  outputBytes: number;
}

export interface EgressScrubResult<T> {
  content: T;
  receipt: EgressScrubReceipt;
}

export interface LlmCapReceipt {
  registryId: LlmUsageId;
  callBudget: { env: string; limit: number };
  inputBounds: readonly { env: string; limit: number }[];
  outputTokenLimit?: { env: string; limit: number };
  spendControls: readonly string[];
}

export type EgressScrubLogger = (receipt: EgressScrubReceipt) => void;

export class AnthropicEgressError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'AnthropicEgressError';
    this.code = code;
  }
}

// Cap the upstream error body retained on the error so a future handler that
// logs or returns err.body can't leak a large or sensitive payload — the
// credential lives one frame away (#2065). Anthropic error bodies are small and
// don't echo the request, so a short bound is ample for debugging.
const EGRESS_ERROR_BODY_MAX_CHARS = 512;
function boundEgressErrorBody(body: unknown): string {
  let s: string;
  try {
    s = typeof body === 'string' ? body : JSON.stringify(body);
  } catch {
    s = String(body);
  }
  if (s == null) return '';
  return s.length > EGRESS_ERROR_BODY_MAX_CHARS
    ? `${s.slice(0, EGRESS_ERROR_BODY_MAX_CHARS)}…[truncated]`
    : s;
}

export class AnthropicEgressHttpError extends Error {
  status: number;
  body: string;

  constructor(status: number, body: unknown) {
    super(`Anthropic API error (${status})`);
    this.name = 'AnthropicEgressHttpError';
    this.status = status;
    this.body = boundEgressErrorBody(body);
  }
}

export async function callAnthropic(
  registryId: LlmUsageId,
  req: CallAnthropicRequest
): Promise<Response> {
  const entry = getLlmUsageEntry(registryId);
  if (!entry) {
    throw new AnthropicEgressError(
      'ERR_DASHBOARD_LLM_REGISTRY_MISSING',
      `No LLM usage registry entry for ${registryId}`
    );
  }
  if (entry.surface !== 'server') {
    throw new AnthropicEgressError(
      'ERR_DASHBOARD_LLM_BROWSER_ENTRY',
      `${registryId} is a browser-only LLM usage entry`
    );
  }
  if (entry.credential !== req.credential.kind) {
    throw new AnthropicEgressError(
      'ERR_DASHBOARD_LLM_CREDENTIAL_MISMATCH',
      `${registryId} requires ${entry.credential}, got ${req.credential.kind}`
    );
  }

  if (entry.rule === 'A') {
    if (req.containsClaudeData !== false) {
      throw new AnthropicEgressError(
        'ERR_DASHBOARD_LLM_OAUTH_CLAUDE_DATA',
        `${registryId} must explicitly certify that no ~/.claude content is sent`
      );
    }
    if (req.credential.kind !== 'oauth' || !req.credential.token) {
      throw new AnthropicEgressError(
        'ERR_DASHBOARD_LLM_MISSING_OAUTH_TOKEN',
        `${registryId} requires an OAuth token`
      );
    }
    if (
      registryId === 'server.usage-gauge' &&
      req.body != null &&
      !isUsageGaugeProbeBody(req.body)
    ) {
      throw new AnthropicEgressError(
        'ERR_DASHBOARD_LLM_OAUTH_NON_PROBE_BODY',
        `${registryId} may only send the fixed rate-limit probe payload`
      );
    }
  }

  if (entry.rule === 'B') {
    if (req.credential.kind !== 'console-key' || !req.credential.apiKey) {
      throw new AnthropicEgressError(
        'ERR_DASHBOARD_LLM_MISSING_API_KEY',
        `${registryId} requires an Anthropic Console API key`
      );
    }
    if (!validScrubReceipt(registryId, entry.egressScrub, req.scrubReceipt)) {
      throw new AnthropicEgressError(
        'ERR_DASHBOARD_LLM_SCRUB_MISSING',
        `${registryId} requires an egressScrub receipt before egress`
      );
    }
    if (
      req.capChecked !== true ||
      !validCapReceipt(registryId, req.body, req.capReceipt)
    ) {
      throw new AnthropicEgressError(
        'ERR_DASHBOARD_LLM_CAP_UNCHECKED',
        `${registryId} requires an explicit capChecked=true attestation and cap receipt`
      );
    }
  }

  const fetcher = req.fetchImpl ?? fetch;
  const headers = buildHeaders(req);
  const init: RequestInit = {
    method: req.method ?? (req.body == null ? 'GET' : 'POST'),
    headers,
  };
  if (req.body != null) {
    init.body =
      typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
  }
  return fetcher(`${ANTHROPIC_BASE}${req.path}`, init);
}

export async function callAnthropicMessages(
  registryId: LlmUsageId,
  req: AnthropicChatRequest
): Promise<AnthropicChatResult> {
  const resp = await callAnthropic(registryId, {
    credential: { kind: 'console-key', apiKey: req.apiKey },
    path: '/messages',
    method: 'POST',
    body: {
      model: req.model,
      max_tokens: req.maxTokens,
      ...(req.system ? { system: req.system } : {}),
      messages: req.messages,
    },
    containsClaudeData: req.containsClaudeData,
    scrubReceipt: req.scrubReceipt,
    capChecked: req.capChecked,
    capReceipt: req.capReceipt,
    fetchImpl: req.fetchImpl,
  });
  const body = await safeJson(resp);
  if (!resp.ok) {
    throw new AnthropicEgressHttpError(resp.status, body);
  }
  const parsed = body as {
    content?: { type: string; text?: string }[];
    model?: string;
    stop_reason?: string | null;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const text = (parsed.content ?? [])
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('');
  return {
    text,
    inputTokens: parsed.usage?.input_tokens ?? 0,
    outputTokens: parsed.usage?.output_tokens ?? 0,
    model: parsed.model ?? req.model,
    stopReason: parsed.stop_reason ?? null,
  };
}

export function egressScrub<T>(
  registryId: LlmUsageId,
  content: T,
  options: { logger: EgressScrubLogger } | undefined
): EgressScrubResult<T> {
  const entry = getLlmUsageEntry(registryId);
  if (!entry) {
    throw new AnthropicEgressError(
      'ERR_DASHBOARD_LLM_REGISTRY_MISSING',
      `No LLM usage registry entry for ${registryId}`
    );
  }
  if (entry.egressScrub === 'none') {
    throw new AnthropicEgressError(
      'ERR_DASHBOARD_LLM_SCRUB_NOT_CONFIGURED',
      `${registryId} does not use an egress scrub step`
    );
  }
  // FAIL-CLOSED: only the transmission-grade 'redact' mode may send. A 'stub'
  // (identity) mode — or any unrecognised mode — refuses egress entirely, so a
  // misconfiguration can never leak unredacted transcript content (#1581).
  if (entry.egressScrub !== 'redact') {
    throw new AnthropicEgressError(
      'ERR_DASHBOARD_LLM_SCRUB_NOT_TRANSMISSION_GRADE',
      `${registryId} egressScrub mode "${entry.egressScrub}" is not a transmission-grade redactor; refusing to egress`
    );
  }
  if (!options || typeof options.logger !== 'function') {
    throw new AnthropicEgressError(
      'ERR_DASHBOARD_LLM_SCRUB_LOGGER_MISSING',
      `${registryId} requires a scrub logger before egress`
    );
  }
  const inputBytes = jsonByteLength(content);
  const redacted = redactSecretsDeep(content);
  const receipt = {
    registryId,
    mode: entry.egressScrub,
    inputBytes,
    outputBytes: jsonByteLength(redacted),
  };
  options.logger(receipt);
  return { content: redacted, receipt };
}

function buildHeaders(req: CallAnthropicRequest): Record<string, string> {
  const base: Record<string, string> = {
    ...req.headers,
    'anthropic-version': ANTHROPIC_VERSION,
  };
  if (req.body != null && !hasHeader(base, 'content-type')) {
    base['content-type'] = 'application/json';
  }
  if (req.credential.kind === 'oauth') {
    base.authorization = `Bearer ${req.credential.token}`;
    base['anthropic-beta'] = OAUTH_BETA;
  } else {
    base['x-api-key'] = req.credential.apiKey;
  }
  return base;
}

function validScrubReceipt(
  registryId: LlmUsageId,
  expectedMode: LlmEgressScrubMode,
  receipt: EgressScrubReceipt | undefined
): boolean {
  return (
    expectedMode === 'redact' &&
    receipt?.registryId === registryId &&
    receipt.mode === expectedMode &&
    Number.isFinite(receipt.inputBytes) &&
    Number.isFinite(receipt.outputBytes) &&
    receipt.inputBytes >= 0 &&
    receipt.outputBytes >= 0
  );
}

function validCapReceipt(
  registryId: LlmUsageId,
  body: unknown,
  receipt: LlmCapReceipt | undefined
): boolean {
  if (!receipt || receipt.registryId !== registryId) return false;
  if (!validNamedPositiveLimit(receipt.callBudget)) return false;
  if (
    !Array.isArray(receipt.inputBounds) ||
    receipt.inputBounds.length === 0 ||
    !receipt.inputBounds.every(validNamedPositiveLimit)
  ) {
    return false;
  }
  if (
    !Array.isArray(receipt.spendControls) ||
    receipt.spendControls.length === 0 ||
    !receipt.spendControls.every(
      (control) => typeof control === 'string' && control.trim().length > 0
    )
  ) {
    return false;
  }
  const requestedMaxTokens = maxTokensFromBody(body);
  if (requestedMaxTokens == null) return true;
  if (!validNamedPositiveLimit(receipt.outputTokenLimit)) return false;
  return requestedMaxTokens <= receipt.outputTokenLimit.limit;
}

function validNamedPositiveLimit(
  value: { env: string; limit: number } | undefined
): value is { env: string; limit: number } {
  return (
    !!value &&
    typeof value.env === 'string' &&
    value.env.trim().length > 0 &&
    Number.isFinite(value.limit) &&
    value.limit > 0
  );
}

function maxTokensFromBody(body: unknown): number | null {
  let parsed: unknown = body;
  if (typeof body === 'string') {
    try {
      parsed = JSON.parse(body);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const maxTokens = (parsed as { max_tokens?: unknown }).max_tokens;
  return typeof maxTokens === 'number' && Number.isFinite(maxTokens)
    ? maxTokens
    : null;
}

function jsonByteLength(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return 0;
  }
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const wanted = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === wanted);
}

function isUsageGaugeProbeBody(body: unknown): boolean {
  let parsed: unknown = body;
  if (typeof body === 'string') {
    try {
      parsed = JSON.parse(body);
    } catch {
      return false;
    }
  }
  if (!parsed || typeof parsed !== 'object') return false;
  const obj = parsed as {
    model?: unknown;
    max_tokens?: unknown;
    messages?: unknown;
  };
  if (obj.model !== 'claude-haiku-4-5-20251001') return false;
  if (obj.max_tokens !== 1) return false;
  if (!Array.isArray(obj.messages) || obj.messages.length !== 1) return false;
  const [message] = obj.messages;
  if (!message || typeof message !== 'object') return false;
  const msg = message as { role?: unknown; content?: unknown };
  return msg.role === 'user' && msg.content === 'hi';
}

async function safeJson(resp: Response): Promise<unknown> {
  try {
    return await resp.json();
  } catch {
    return null;
  }
}
