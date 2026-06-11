/**
 * Thin browser-side client for the Anthropic Messages API.
 *
 * The dashboard ingests `~/.claude` locally and otherwise has no LLM access of
 * its own. This module lets the user paste their own Anthropic API key, store
 * it in `localStorage`, and call api.anthropic.com directly from the browser —
 * no backend round-trip and no server custody of the key.
 *
 * Calls require the `anthropic-dangerous-direct-browser-access: true` header
 * (Anthropic refuses browser-origin requests without it).
 */

const API_KEY_STORAGE = 'claude-history-dashboard:anthropic-api-key';
const MODEL_STORAGE = 'claude-history-dashboard:anthropic-default-model';

import {
  ANTHROPIC_PICKER_MODELS,
  CURRENT_MODEL_IDS,
} from './model-registry';

export const ANTHROPIC_MODELS = ANTHROPIC_PICKER_MODELS;

export type AnthropicModelId =
  (typeof CURRENT_MODEL_IDS)[keyof typeof CURRENT_MODEL_IDS];

export const DEFAULT_MODEL: AnthropicModelId = CURRENT_MODEL_IDS.sonnet;

const ANTHROPIC_BASE = 'https://api.anthropic.com/v1';
const ANTHROPIC_VERSION = '2023-06-01';

export function getApiKey(): string | null {
  try {
    return localStorage.getItem(API_KEY_STORAGE);
  } catch {
    return null;
  }
}

export function setApiKey(key: string): void {
  try {
    localStorage.setItem(API_KEY_STORAGE, key);
  } catch {
    /* localStorage may be disabled (private mode etc.) — silently fail */
  }
}

export function clearApiKey(): void {
  try {
    localStorage.removeItem(API_KEY_STORAGE);
  } catch {
    /* see setApiKey */
  }
}

export function getDefaultModel(): AnthropicModelId {
  try {
    const stored = localStorage.getItem(MODEL_STORAGE);
    if (stored && ANTHROPIC_MODELS.some((m) => m.id === stored)) {
      return stored as AnthropicModelId;
    }
  } catch {
    /* fall through to default */
  }
  return DEFAULT_MODEL;
}

export function setDefaultModel(model: AnthropicModelId): void {
  try {
    localStorage.setItem(MODEL_STORAGE, model);
  } catch {
    /* see setApiKey */
  }
}

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  messages: AnthropicMessage[];
  model?: AnthropicModelId | string;
  maxTokens?: number;
  system?: string;
  apiKey?: string;
}

export interface ChatResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
  stopReason: string | null;
}

export class ClaudeApiError extends Error {
  status: number;
  body: unknown;
  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = 'ClaudeApiError';
    this.status = status;
    this.body = body;
  }
}

function authHeaders(apiKey: string): Record<string, string> {
  return {
    'x-api-key': apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
    'anthropic-dangerous-direct-browser-access': 'true',
    'content-type': 'application/json',
  };
}

function describeError(status: number, body: unknown): string {
  if (status === 401) {
    return 'Invalid API key (401). Double-check the key starts with `sk-ant-` and is still active in your Anthropic console.';
  }
  if (status === 403) {
    return 'Key rejected (403). The key may lack access to this model, or this origin is not allowed.';
  }
  if (status === 429) {
    return 'Rate limited (429). Wait a moment and try again, or check your plan limits.';
  }
  if (status >= 500) {
    return `Anthropic server error (${status}). Try again shortly.`;
  }
  const detail =
    typeof body === 'object' && body !== null && 'error' in body
      ? ((body as { error?: { message?: string } }).error?.message ?? '')
      : '';
  return `Anthropic API error (${status})${detail ? `: ${detail}` : ''}.`;
}

/**
 * Lightweight liveness check. Hits `/v1/models` because it's cheap, requires
 * auth, and surfaces the same auth errors as `/v1/messages` without consuming
 * any output tokens.
 */
export async function testConnection(apiKey: string): Promise<void> {
  let resp: Response;
  try {
    resp = await fetch(`${ANTHROPIC_BASE}/models`, {
      method: 'GET',
      headers: authHeaders(apiKey),
    });
  } catch (err) {
    throw new ClaudeApiError(
      `Network error reaching api.anthropic.com: ${
        err instanceof Error ? err.message : String(err)
      }`,
      0
    );
  }
  if (!resp.ok) {
    const body = await safeJson(resp);
    throw new ClaudeApiError(describeError(resp.status, body), resp.status, body);
  }
}

export async function chat({
  messages,
  model,
  maxTokens = 1024,
  system,
  apiKey: explicitKey,
}: ChatOptions): Promise<ChatResult> {
  const apiKey = explicitKey ?? getApiKey();
  if (!apiKey) {
    throw new ClaudeApiError(
      'No Anthropic API key configured. Open Settings to paste one.',
      0
    );
  }
  const chosenModel = model ?? getDefaultModel();

  let resp: Response;
  try {
    resp = await fetch(`${ANTHROPIC_BASE}/messages`, {
      method: 'POST',
      headers: authHeaders(apiKey),
      body: JSON.stringify({
        model: chosenModel,
        max_tokens: maxTokens,
        ...(system ? { system } : {}),
        messages,
      }),
    });
  } catch (err) {
    throw new ClaudeApiError(
      `Network error reaching api.anthropic.com: ${
        err instanceof Error ? err.message : String(err)
      }`,
      0
    );
  }

  const body = await safeJson(resp);
  if (!resp.ok) {
    throw new ClaudeApiError(describeError(resp.status, body), resp.status, body);
  }

  const parsed = body as {
    content?: { type: string; text?: string }[];
    model?: string;
    stop_reason?: string | null;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const text = (parsed.content ?? [])
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('');

  return {
    text,
    inputTokens: parsed.usage?.input_tokens ?? 0,
    outputTokens: parsed.usage?.output_tokens ?? 0,
    model: parsed.model ?? chosenModel,
    stopReason: parsed.stop_reason ?? null,
  };
}

async function safeJson(resp: Response): Promise<unknown> {
  try {
    return await resp.json();
  } catch {
    return null;
  }
}
