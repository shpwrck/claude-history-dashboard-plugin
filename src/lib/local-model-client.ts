/**
 * Tier A local-model transport (issue #2319, ADR 0018).
 *
 * Calls a LOCAL, OpenAI-compatible chat-completions endpoint (vLLM / ollama, or
 * LiteLLM / agentgateway fronting them per ADR 0010 — no custom broker) over
 * LOOPBACK ONLY.
 *
 * GOVERNANCE (ADR 0018 hard guardrails):
 *  - This is the ONLY network egress the "Analyze locally" surface performs, and
 *    it is pinned to loopback (127.0.0.0/8, ::1, localhost) by
 *    `assertLoopbackEndpoint`. The surface therefore CANNOT reach a third-party
 *    API by construction — any non-loopback host is refused before any request
 *    is made.
 *  - There is deliberately NO external fallback wired in v0.6.0: the default
 *    deployment path (endpoint unset) makes ZERO network calls, and an
 *    unset / unreachable / refused endpoint degrades to the deterministic engine
 *    result upstream (see local-analyze.ts `degradedResult`).
 */

/** Env var pointing at the local OpenAI-compatible base URL (e.g. http://127.0.0.1:11434/v1). */
export const LOCAL_MODEL_ENDPOINT_ENV = 'CHD_LOCAL_MODEL_ENDPOINT';
/** Env var overriding the model id sent to the local endpoint. */
export const LOCAL_MODEL_NAME_ENV = 'CHD_LOCAL_MODEL_NAME';
/** Default model id when `CHD_LOCAL_MODEL_NAME` is unset. */
export const DEFAULT_LOCAL_MODEL = 'local-model';

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_TOKENS = 512;

export interface LocalModelConfig {
  endpoint: string;
  model: string;
}

export class LocalModelError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'LocalModelError';
    this.code = code;
  }
}

/**
 * Read the local-model configuration from the environment. Returns null when the
 * endpoint is unset/empty — the "operator has not opted in" case, which the
 * route treats as graceful degradation (zero network calls on the default path).
 */
export function readLocalModelConfig(
  env: Record<string, string | undefined> = process.env
): LocalModelConfig | null {
  const endpoint = (env[LOCAL_MODEL_ENDPOINT_ENV] ?? '').trim();
  if (!endpoint) return null;
  const model = (env[LOCAL_MODEL_NAME_ENV] ?? '').trim() || DEFAULT_LOCAL_MODEL;
  return { endpoint, model };
}

/** True only for loopback hosts: 127.0.0.0/8, ::1, and `localhost`. */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1') return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  return false;
}

/**
 * Parse + validate a local-model endpoint. Throws `LocalModelError` unless it is
 * an http(s) URL whose host is loopback. This is the hard guardrail that makes
 * external egress (including any third-party LLM API) structurally impossible:
 * every call routes through here before a request is issued.
 */
export function assertLoopbackEndpoint(endpoint: string): URL {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new LocalModelError(
      'ERR_LOCAL_MODEL_ENDPOINT_INVALID',
      `Local model endpoint is not a valid URL: ${endpoint}`
    );
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new LocalModelError(
      'ERR_LOCAL_MODEL_ENDPOINT_PROTOCOL',
      `Local model endpoint must be http(s), got ${url.protocol}`
    );
  }
  if (!isLoopbackHost(url.hostname)) {
    throw new LocalModelError(
      'ERR_LOCAL_MODEL_ENDPOINT_NOT_LOOPBACK',
      `Local model endpoint must be loopback (127.0.0.1 / ::1 / localhost); refusing host "${url.hostname}"`
    );
  }
  return url;
}

/** Resolve the OpenAI-compatible chat-completions URL from a loopback base. */
export function chatCompletionsUrl(endpoint: string): URL {
  const url = assertLoopbackEndpoint(endpoint);
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = /\/chat\/completions$/.test(path)
    ? path
    : `${path}/chat/completions`;
  return url;
}

export interface LocalModelMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LocalModelChatRequest {
  endpoint: string;
  model: string;
  messages: LocalModelMessage[];
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

export interface LocalModelChatResult {
  text: string;
  model: string;
}

function extractChatText(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return '';
  const first = choices[0] as { message?: { content?: unknown }; text?: unknown };
  if (first?.message && typeof first.message.content === 'string') {
    return first.message.content;
  }
  if (typeof first?.text === 'string') return first.text;
  return '';
}

function extractModel(body: unknown): string | null {
  if (body && typeof body === 'object') {
    const m = (body as { model?: unknown }).model;
    if (typeof m === 'string' && m) return m;
  }
  return null;
}

/**
 * POST a chat completion to the LOCAL endpoint. Guards loopback first (so no
 * request is ever issued to a non-loopback host), bounds the call with a timeout
 * so a hung local model degrades instead of hanging the surface, and normalizes
 * the OpenAI-compatible response. Throws `LocalModelError` on any failure — the
 * caller catches it and degrades to the deterministic result.
 */
export async function callLocalModel(
  req: LocalModelChatRequest
): Promise<LocalModelChatResult> {
  const url = chatCompletionsUrl(req.endpoint); // loopback-guarded; throws otherwise
  const fetcher = req.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (req.signal) {
    if (req.signal.aborted) controller.abort();
    else
      req.signal.addEventListener('abort', () => controller.abort(), {
        once: true,
      });
  }

  let resp: Response;
  try {
    resp = await fetcher(url.toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: req.model,
        messages: req.messages,
        max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
        temperature: req.temperature ?? 0.2,
        stream: false,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    throw new LocalModelError(
      'ERR_LOCAL_MODEL_UNREACHABLE',
      err instanceof Error ? err.message : 'Local model endpoint unreachable'
    );
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) {
    throw new LocalModelError(
      'ERR_LOCAL_MODEL_HTTP',
      `Local model endpoint returned HTTP ${resp.status}`
    );
  }

  let body: unknown;
  try {
    body = await resp.json();
  } catch {
    throw new LocalModelError(
      'ERR_LOCAL_MODEL_BAD_RESPONSE',
      'Local model endpoint returned a non-JSON response'
    );
  }

  return { text: extractChatText(body), model: extractModel(body) ?? req.model };
}
