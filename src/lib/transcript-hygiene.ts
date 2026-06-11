/**
 * Transcript hygiene — secret scrubbing for assistant prose before it is
 * persisted (#204, slice 1 of #181).
 *
 * This is a *different* concern from `config-hygiene.ts` (the P/I/U
 * installed-but-unused engine from #174). That module analyses which
 * configured resources go unused; this one redacts secret-shaped substrings
 * out of raw transcript text so credentials a session happened to echo back
 * never land in the durable SQLite cache.
 *
 * Design:
 *  - Pure and allocation-light: a single pass of well-known credential regexes
 *    over each string. No entropy heuristics (too many false positives on
 *    base64 noise like thinking-block signatures), only shapes that are
 *    unambiguously secrets.
 *  - Conservative replacement: each match collapses to a `[REDACTED:<kind>]`
 *    marker. The marker carries no quotes/braces so scrubbing a value nested
 *    inside a JSON string never breaks the surrounding structure — callers can
 *    scrub a fully-serialised block tree and re-store it verbatim.
 *  - Deterministic: same input always yields the same output (no clock, no
 *    randomness), so it composes with the ingest content-hash gate.
 */

interface SecretPattern {
  kind: string;
  re: RegExp;
}

// Order matters only for the redaction label, not correctness: the first
// pattern that matches a given span wins because matches are applied
// sequentially and a replaced span can't be re-matched by a later pattern.
// All regexes are global so every occurrence in a string is replaced.
const SECRET_PATTERNS: SecretPattern[] = [
  // Anthropic API keys — the canonical case this dashboard cares about.
  { kind: 'anthropic-key', re: /sk-ant-[A-Za-z0-9_-]{16,}/g },
  // OpenAI-style keys (sk-..., sk-proj-...). Kept after the Anthropic rule so
  // `sk-ant-` is labelled specifically rather than as a generic sk- key.
  { kind: 'openai-key', re: /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g },
  // AWS access key id.
  { kind: 'aws-access-key-id', re: /AKIA[0-9A-Z]{16}/g },
  // GitHub personal-access / OAuth / app tokens.
  { kind: 'github-token', re: /gh[pousr]_[A-Za-z0-9]{30,}/g },
  // GitLab personal access tokens.
  { kind: 'gitlab-token', re: /glpat-[A-Za-z0-9_-]{20,}/g },
  // Google API keys.
  { kind: 'google-api-key', re: /AIza[0-9A-Za-z_-]{35}/g },
  // Slack tokens.
  { kind: 'slack-token', re: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
  // Bearer tokens in Authorization headers / curl examples. The hyphen leads
  // the class so it reads unambiguously as a literal rather than a range.
  { kind: 'bearer-token', re: /[Bb]earer\s+[-A-Za-z0-9._~+/]{20,}=*/g },
  // PEM private-key blocks (header line is enough to flag the secret).
  {
    kind: 'private-key',
    re: /-----BEGIN(?:\s[A-Z0-9]+)*\s?PRIVATE KEY-----/g,
  },
];

/**
 * Replace every secret-shaped substring in `text` with a `[REDACTED:<kind>]`
 * marker. Non-string / empty input returns the input unchanged (callers pass
 * arbitrary block values).
 */
export function scrubSecrets(text: string): string {
  if (typeof text !== 'string' || text.length === 0) return text;
  let out = text;
  for (const { kind, re } of SECRET_PATTERNS) {
    out = out.replace(re, `[REDACTED:${kind}]`);
  }
  return out;
}

/**
 * Recursively scrub every string leaf of an arbitrary JSON-ish value (block
 * trees: arrays, plain objects, strings). Preserves structure — only string
 * values change — so a scrubbed content/thinking block tree re-serialises to
 * the same shape with credentials removed from text *and* from nested
 * tool-call inputs (a curl command in a `tool_use.input`, say).
 */
export function scrubValue<T>(value: T): T {
  if (typeof value === 'string') return scrubSecrets(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => scrubValue(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = scrubValue(v);
    }
    return out as unknown as T;
  }
  return value;
}
