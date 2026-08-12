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
  scrubbedBody?: EgressScrubResult<unknown>;
  /** Caller-supplied headers are forbidden at the governed server chokepoint. */
  headers?: never;
  containsClaudeData?: boolean;
  capChecked?: boolean;
  capReceipt?: LlmCapReceipt;
  fetchImpl?: typeof fetch;
}

export interface AnthropicChatRequest {
  apiKey: string;
  scrubbedBody: EgressScrubResult<AnthropicMessagesBody>;
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

export interface AnthropicMessagesBody {
  model: string;
  max_tokens: number;
  system?: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
}

export interface AnthropicChatResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
  stopReason: string | null;
}

export interface EgressScrubReceipt {
  readonly registryId: LlmUsageId;
  readonly mode: LlmEgressScrubMode;
  readonly inputBytes: number;
  readonly outputBytes: number;
}

const trustedScrubResultBrand: unique symbol = Symbol(
  'dashboard.trusted-egress-scrub-result'
);

export interface EgressScrubResult<T> {
  readonly content: T;
  readonly receipt: EgressScrubReceipt;
  readonly [trustedScrubResultBrand]: true;
}

export interface LlmCapReceipt {
  registryId: LlmUsageId;
  callBudget: { env: string; limit: number };
  inputBounds: readonly { env: string; limit: number }[];
  outputTokenLimit?: { env: string; limit: number };
  spendControls: readonly string[];
}

export type EgressScrubLogger = (receipt: EgressScrubReceipt) => void;

interface TrustedScrubbedBody {
  registryId: LlmUsageId;
  serializedBody: string;
  model?: string;
}

// Runtime opacity matters here: TypeScript's structural types disappear after
// compilation, so a private brand alone cannot distinguish a trusted scrub
// result from caller-created JSON. The WeakMap authorizes only object identities
// created by egressScrub and retains the exact serialized transmission snapshot.
const trustedScrubbedBodies = new WeakMap<object, TrustedScrubbedBody>();

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
  let serializedBody: string | undefined;
  const entry = getLlmUsageEntry(registryId);
  if (!entry) {
    throw new AnthropicEgressError(
      'ERR_DASHBOARD_LLM_REGISTRY_MISSING',
      `No LLM usage registry entry for ${registryId}`
    );
  }
  if (entry.credential !== req.credential.kind) {
    throw new AnthropicEgressError(
      'ERR_DASHBOARD_LLM_CREDENTIAL_MISMATCH',
      `${registryId} requires ${entry.credential}, got ${req.credential.kind}`
    );
  }
  if (Object.prototype.hasOwnProperty.call(req, 'headers')) {
    throw new AnthropicEgressError(
      'ERR_DASHBOARD_LLM_CALLER_HEADERS',
      `${registryId} cannot send caller-supplied headers; governed Anthropic headers are constructed internally`
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
    if ('scrubReceipt' in req) {
      throw new AnthropicEgressError(
        'ERR_DASHBOARD_LLM_SCRUB_MISSING',
        `${registryId} cannot authorize egress with a caller-supplied scrub receipt`
      );
    }
    if (req.credential.kind !== 'console-key' || !req.credential.apiKey) {
      throw new AnthropicEgressError(
        'ERR_DASHBOARD_LLM_MISSING_API_KEY',
        `${registryId} requires an Anthropic Console API key`
      );
    }
    const trustedBody =
      req.scrubbedBody && typeof req.scrubbedBody === 'object'
        ? trustedScrubbedBodies.get(req.scrubbedBody)
        : undefined;
    if (
      req.body != null ||
      !trustedBody ||
      trustedBody.registryId !== registryId
    ) {
      throw new AnthropicEgressError(
        'ERR_DASHBOARD_LLM_SCRUB_MISSING',
        `${registryId} requires the opaque body returned by egressScrub before egress`
      );
    }
    serializedBody = trustedBody.serializedBody;
    if (
      req.capChecked !== true ||
      !validCapReceipt(registryId, serializedBody, req.capReceipt)
    ) {
      throw new AnthropicEgressError(
        'ERR_DASHBOARD_LLM_CAP_UNCHECKED',
        `${registryId} requires an explicit capChecked=true attestation and cap receipt`
      );
    }
  }

  if (serializedBody === undefined && req.body != null) {
    serializedBody = serializeRequestBody(req.body);
  }
  const fetcher = req.fetchImpl ?? fetch;
  const headers = buildHeaders(req, serializedBody !== undefined);
  const init: RequestInit = {
    method: req.method ?? (serializedBody === undefined ? 'GET' : 'POST'),
    headers,
  };
  if (serializedBody !== undefined) {
    init.body = serializedBody;
  }
  return fetcher(`${ANTHROPIC_BASE}${req.path}`, init);
}

export async function callAnthropicMessages(
  registryId: LlmUsageId,
  req: AnthropicChatRequest
): Promise<AnthropicChatResult> {
  const requestModel = trustedScrubbedBodies.get(req.scrubbedBody)?.model;
  const resp = await callAnthropic(registryId, {
    credential: { kind: 'console-key', apiKey: req.apiKey },
    path: '/messages',
    method: 'POST',
    scrubbedBody: req.scrubbedBody,
    containsClaudeData: req.containsClaudeData,
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
  const responseModel =
    typeof parsed.model === 'string' ? parsed.model : undefined;
  return {
    text,
    inputTokens: parsed.usage?.input_tokens ?? 0,
    outputTokens: parsed.usage?.output_tokens ?? 0,
    model: responseModel ?? requestModel ?? '',
    stopReason: parsed.stop_reason ?? null,
  };
}

function normalizeJson<T>(value: T): T {
  return cloneJsonValue(value, new WeakSet<object>()) as T;
}

function cloneJsonValue(
  value: unknown,
  ancestors: WeakSet<object>
): unknown {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value;
    return unsupportedScrubContent('non-finite number');
  }

  if (typeof value !== 'object') {
    return unsupportedScrubContent(typeof value);
  }
  if (ancestors.has(value)) {
    return unsupportedScrubContent('cyclic reference');
  }

  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype) {
      return unsupportedScrubContent('non-plain array');
    }
  } else if (prototype !== Object.prototype && prototype !== null) {
    return unsupportedScrubContent('non-plain object');
  }

  ancestors.add(value);
  try {
    return Array.isArray(value)
      ? cloneJsonArray(value, ancestors)
      : cloneJsonObject(value as Record<string, unknown>, ancestors);
  } finally {
    ancestors.delete(value);
  }
}

function cloneJsonArray(
  value: unknown[],
  ancestors: WeakSet<object>
): unknown[] {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const elementKeys = Reflect.ownKeys(descriptors).filter(
    (key) => key !== 'length'
  );
  if (
    elementKeys.length !== value.length ||
    elementKeys.some(
      (key) =>
        typeof key !== 'string' ||
        !isCanonicalArrayIndex(key, value.length)
    )
  ) {
    return unsupportedScrubContent('sparse or extended array');
  }

  const out: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (
      !descriptor ||
      !descriptor.enumerable ||
      !('value' in descriptor)
    ) {
      return unsupportedScrubContent('array accessor');
    }
    out.push(cloneJsonValue(descriptor.value, ancestors));
  }
  return out;
}

function cloneJsonObject(
  value: Record<string, unknown>,
  ancestors: WeakSet<object>
): Record<string, unknown> {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const out: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;

  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string') {
      return unsupportedScrubContent('symbol property');
    }
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !('value' in descriptor)) {
      return unsupportedScrubContent('non-data property');
    }
    out[key] = cloneJsonValue(descriptor.value, ancestors);
  }
  return out;
}

function isCanonicalArrayIndex(key: string, length: number): boolean {
  const index = Number(key);
  return (
    Number.isInteger(index) &&
    index >= 0 &&
    index < length &&
    String(index) === key
  );
}

function unsupportedScrubContent(kind: string): never {
  throw new AnthropicEgressError(
    'ERR_DASHBOARD_LLM_SCRUB_UNSUPPORTED',
    `Egress scrub accepts only acyclic plain JSON data; rejected ${kind}`
  );
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
  const normalized = normalizeJson(content);
  const inputBytes = jsonByteLength(normalized);
  const redacted = redactSecretsDeep(normalized);
  const receipt: EgressScrubReceipt = Object.freeze({
    registryId,
    mode: entry.egressScrub,
    inputBytes,
    outputBytes: jsonByteLength(redacted),
  });
  const serializedBody = serializeRequestBody(redacted);
  if (serializedBody === undefined) {
    throw new AnthropicEgressError(
      'ERR_DASHBOARD_LLM_SCRUB_UNSERIALIZABLE',
      `${registryId} produced a body that cannot be serialized for egress`
    );
  }
  options.logger(receipt);
  const result: EgressScrubResult<T> = Object.freeze({
    [trustedScrubResultBrand]: true,
    content: redacted,
    receipt,
  });
  trustedScrubbedBodies.set(result, {
    registryId,
    serializedBody,
    model: modelFromSerializedBody(serializedBody),
  });
  return result;
}

function buildHeaders(
  req: CallAnthropicRequest,
  hasBody: boolean
): Record<string, string> {
  const base: Record<string, string> = {
    'anthropic-version': ANTHROPIC_VERSION,
  };
  if (hasBody) {
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

function serializeRequestBody(body: unknown): string | undefined {
  return typeof body === 'string' ? body : JSON.stringify(body);
}

function modelFromSerializedBody(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { model?: unknown } | null;
    return typeof parsed?.model === 'string' ? parsed.model : undefined;
  } catch {
    return undefined;
  }
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
