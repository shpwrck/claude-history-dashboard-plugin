/**
 * JSON export validity (#1104, epic #866).
 *
 * Transcript text can carry an unpaired (lone) UTF-16 surrogate code unit — a
 * high surrogate with no following low, or vice-versa — e.g. from a truncated
 * emoji in a captured prompt. `JSON.stringify` well-forms these into `\udXXX`
 * escapes that are legal in the JSON grammar but that STRICT non-JS parsers
 * (Go's encoding/json, Rust serde, jq) reject with "invalid surrogate escape".
 * The 2026-06-10 audit hit exactly this on `/api/dataset.json`.
 *
 * Replacing each lone surrogate with U+FFFD (the Unicode replacement character)
 * BEFORE serialization keeps the export parseable by every consumer. Properly
 * paired surrogates (real emoji) are preserved untouched.
 *
 * Pure and dependency-free so it is safe to import from both the SPA bundle and
 * the register-ts server runtime (which ships no node_modules).
 */

/**
 * Match a lone surrogate: a high surrogate (U+D800–U+DBFF) NOT followed by a low
 * surrogate, or a low surrogate (U+DC00–U+DFFF) NOT preceded by a high one.
 * A correctly paired surrogate (emoji) matches neither alternative.
 */
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Replace every unpaired surrogate in `s` with U+FFFD. Paired surrogates stay. */
export function scrubLoneSurrogates(s: string): string {
  return s.replace(LONE_SURROGATE_RE, '�');
}

/**
 * `JSON.stringify` that first scrubs lone surrogates from every string key and
 * leaf, so the output is parseable by strict (non-JavaScript) JSON parsers as
 * well as `JSON.parse`. Use for any served/exported JSON body
 * (`/api/dataset.json`, `/api/recommendations.json`, per-session SQLite JSON).
 * Behaviour is otherwise identical to `JSON.stringify(value)` for the plain
 * JSON-shaped objects this app serializes.
 */
export function safeJsonStringify(value: unknown): string {
  return JSON.stringify(scrubJsonValue(value, '', new WeakSet<object>()));
}

function scrubJsonValue(value: unknown, key: string, seen: WeakSet<object>): unknown {
  if (
    value &&
    typeof value === 'object' &&
    typeof (value as { toJSON?: unknown }).toJSON === 'function'
  ) {
    value = (value as { toJSON: (key: string) => unknown }).toJSON(key);
  }

  if (typeof value === 'string') return scrubLoneSurrogates(value);
  if (!value || typeof value !== 'object') return value;

  if (seen.has(value)) {
    throw new TypeError('Converting circular structure to JSON');
  }

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      let out: unknown[] | null = null;
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) continue;
        const rawVal = value[index];
        const safeVal = scrubJsonValue(rawVal, String(index), seen);
        if (out) {
          out[index] = safeVal;
        } else if (safeVal !== rawVal) {
          out = value.slice();
          out[index] = safeVal;
        }
      }
      return out ?? value;
    }

    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    let out: Record<string, unknown> | null = null;
    for (let index = 0; index < keys.length; index += 1) {
      const rawKey = keys[index];
      const safeKey = scrubLoneSurrogates(rawKey);
      const rawVal = obj[rawKey];
      const safeVal = scrubJsonValue(rawVal, rawKey, seen);
      if (out) {
        out[safeKey] = safeVal;
      } else if (safeKey !== rawKey || safeVal !== rawVal) {
        out = {};
        for (let prior = 0; prior < index; prior += 1) {
          const priorKey = keys[prior];
          out[priorKey] = obj[priorKey];
        }
        out[safeKey] = safeVal;
      }
    }
    return out ?? value;
  } finally {
    seen.delete(value);
  }
}
