/**
 * Centralized transmission-grade secret redaction (#3111).
 *
 * These patterns used to live privately inside `anthropic-egress.ts`, where only
 * `egressScrub` could reach them. But the egress scrub is not the only place
 * `~/.claude`-derived content is turned into an LLM prompt: the tier-3 judge
 * audits render stored transcripts (assistant prose + tool-use inputs) into
 * prompt text, and that text can carry API keys, bearer headers, env-style
 * secret assignments, and absolute home paths straight out of the user's own
 * history. Hoisting the patterns into this dependency-free leaf gives every
 * boundary ONE redactor to call, so a new prompt-building path cannot silently
 * ship with weaker rules than the egress chokepoint.
 *
 * Patterns are conservative: they match secret-SHAPED substrings (keys, tokens,
 * JWTs, emails, home paths, env secrets), so non-secret strings (model ids,
 * roles, instructions) pass through unchanged. This is intentionally over-eager
 * on the secret side — for an egress boundary a false redaction is cheap, a
 * false pass is not.
 */

const REDACTIONS: { re: RegExp; to: string }[] = [
  // Anthropic / OpenAI-style API keys (sk-..., sk-ant-...).
  { re: /\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}/g, to: '[REDACTED_KEY]' },
  // JWT / OAuth-style three-part tokens.
  {
    re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}/g,
    to: '[REDACTED_JWT]',
  },
  // Authorization: Bearer <token>.
  { re: /\bBearer\s+[A-Za-z0-9._~+/=-]{10,}/gi, to: 'Bearer [REDACTED_TOKEN]' },
  // Email addresses.
  {
    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    to: '[REDACTED_EMAIL]',
  },
  // Absolute home/user paths.
  { re: /\/(?:Users|home)\/[^\s"']+/g, to: '[REDACTED_PATH]' },
  // Env-style secret assignments: FOO_TOKEN=..., API_KEY=..., PASSWORD=...
  {
    re: /\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASS|CREDENTIAL)[A-Z0-9_]*)\s*=\s*\S+/g,
    to: '$1=[REDACTED]',
  },
  // Long hex blobs (>=32) — covers many opaque credentials/hashes.
  { re: /\b[A-Fa-f0-9]{32,}\b/g, to: '[REDACTED_HEX]' },
];

/** Redact every secret-shaped substring in one string. */
export function redactSecrets(value: string): string {
  let out = value;
  for (const { re, to } of REDACTIONS) out = out.replace(re, to);
  return out;
}

/**
 * Structure-preserving redaction: walks arrays/objects and redacts every string
 * leaf. Returns a copy — the input is never mutated.
 */
export function redactSecretsDeep<T>(value: T): T {
  if (typeof value === 'string') return redactSecrets(value) as unknown as T;
  if (Array.isArray(value)) {
    return value.map((item) => redactSecretsDeep(item)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactSecretsDeep(v);
    }
    return out as T;
  }
  return value;
}
