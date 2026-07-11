import { parseJsonl, parseMessage } from './parse-utils';
import { SECRET_PATTERNS } from './transcript-hygiene';
import type { EvidenceRef } from './evidence';

/**
 * Ingest-time `security.secrets-at-rest` signal parser (#2504, epic #2199).
 *
 * `transcript-hygiene.ts` (#204) scrubs secret-shaped substrings out of
 * ASSISTANT prose before the dashboard persists it — but that scrub only
 * protects the dashboard's OWN SQLite cache. Nothing tells the user that
 * secret-shaped values (API keys, tokens, PEM private keys) sit in plaintext
 * **at rest** in `~/.claude` itself: in their own prompts and in `tool_result`
 * payloads (a `cat .env`, a pasted `curl -H "Authorization: …"`), where they
 * outlive the session for `cleanupPeriodDays` and flow into any transcript
 * sharing/upload path.
 *
 * This parser runs the EXISTING {@link SECRET_PATTERNS} (no new loose regexes)
 * over each user turn's `message.content` text blocks + `tool_result` content
 * and the entry-level `toolUseResult` payload, and emits a tiny NUMERIC
 * per-session feature — the same shape discipline as
 * `parse-deceit-signals.ts` (#685): counts by pattern kind + EvidenceRef
 * coordinates only, so the signal rides the main dataset without an inline
 * transcript.
 *
 * SECURITY INVARIANT (#1 rule of #2504): the matched secret VALUE is NEVER
 * stored, exported, or displayed. Values exist only transiently inside this
 * function (to dedup a value echoed in both `tool_result` and `toolUseResult`
 * of the same entry); the returned shape carries ONLY per-kind counts and
 * EvidenceRef coordinates (`sessionId`, `entryIndex`, `timestamp`,
 * optional `toolUseId`). No field ever holds a matched value or a snippet.
 *
 * Pure and browser-safe (no Node built-ins), so it tree-shakes out of the
 * client bundle while remaining importable by `scripts/ingest.mjs` at ingest
 * time, exactly like the other `parse-*` modules.
 */

export interface SecretsAtRestSignal {
  sessionId: string;
  /**
   * Total secret-shaped values found across the session — the sum of the
   * per-entry DISTINCT-value counts (a value echoed in both the `tool_result`
   * block and the sibling `toolUseResult` of the SAME entry is counted once;
   * the same value in a different entry is a separate at-rest location).
   */
  totalCount: number;
  /**
   * Count of matched values by {@link SECRET_PATTERNS} `kind` (e.g.
   * `anthropic-key`, `aws-access-key-id`, `private-key`). Keys are the pattern
   * kind; values are counts. NEVER a matched value.
   */
  countsByKind: Record<string, number>;
  /**
   * EvidenceRef coordinates of the entries that carried a match, so a reader
   * can locate the offending turn WITHOUT the value being surfaced. Capped;
   * never a matched value.
   */
  evidenceRefs: EvidenceRef[];
  /**
   * Newest matched-entry timestamp (ISO), driving the detector's stale
   * demotion. Absent when no matched entry carried a usable timestamp.
   */
  lastObserved?: string;
}

/** Bound the recorded evidence coordinates so a leaky session can't bloat the row. */
const MAX_EVIDENCE_REFS = 20;
/** Bound recursion into arbitrarily-nested tool_result / toolUseResult payloads. */
const MAX_DEPTH = 12;

/** Recursively collect every string leaf of a JSON-ish value (mirrors scrubValue). */
function collectStrings(value: unknown, out: string[], depth = 0): void {
  if (depth > MAX_DEPTH) return;
  if (typeof value === 'string') {
    if (value.length > 0) out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, out, depth + 1);
    return;
  }
  if (value && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) {
      collectStrings(v, out, depth + 1);
    }
  }
}

/**
 * Find every secret-shaped span in `text`, labelled by kind. Uses the SAME
 * sequential first-pattern-wins masking as `scrubSecrets` — each match is
 * blanked out before a later, looser pattern runs — so a `sk-ant-…` key is
 * labelled `anthropic-key` (not double-counted as the looser `openai-key`),
 * matching the scrubber's redaction semantics exactly.
 *
 * The returned values are used ONLY transiently by the caller to dedup within
 * an entry; they are never persisted.
 */
function findSecrets(text: string): { kind: string; value: string }[] {
  if (typeof text !== 'string' || text.length === 0) return [];
  const found: { kind: string; value: string }[] = [];
  let masked = text;
  for (const { kind, re } of SECRET_PATTERNS) {
    // Fresh regex per call so a shared /g pattern's lastIndex can't leak.
    masked = masked.replace(new RegExp(re.source, re.flags), (m) => {
      found.push({ kind, value: m });
      // Blank the span so a later looser pattern cannot re-match it, and so
      // adjacent text cannot fuse into a spurious match.
      return ' ';
    });
  }
  return found;
}

/** The first `tool_result` block's `tool_use_id`, when the user turn carries one. */
function firstToolUseId(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    if (
      block &&
      typeof block === 'object' &&
      (block as { type?: unknown }).type === 'tool_result' &&
      typeof (block as { tool_use_id?: unknown }).tool_use_id === 'string'
    ) {
      return (block as { tool_use_id: string }).tool_use_id;
    }
  }
  return undefined;
}

/**
 * Walk a session transcript and emit its per-session secrets-at-rest signal.
 * Returns `null` when no secret-shaped value is found (so the persisted blob
 * stays empty and the detector is dark), mirroring the null-when-nothing
 * contract of the other per-session signal parsers.
 */
export function parseSecretsAtRest(
  text: string,
  fileName: string
): SecretsAtRestSignal | null {
  const sessionId = fileName.replace(/\.jsonl$/, '');
  const entries = parseJsonl(text);

  const countsByKind: Record<string, number> = {};
  const evidenceRefs: EvidenceRef[] = [];
  let totalCount = 0;
  let lastObservedMs = -Infinity;
  let lastObserved: string | undefined;

  entries.forEach((entry, entryIndex) => {
    if (entry.type !== 'user') return;
    const msg = parseMessage(entry.message);

    const strings: string[] = [];
    if (msg) collectStrings(msg.content, strings);
    // The entry-level structured tool-result payload (Claude Code writes it
    // alongside the message's tool_result block for many tools).
    collectStrings((entry as { toolUseResult?: unknown }).toolUseResult, strings);
    if (strings.length === 0) return;

    // Per-entry DISTINCT-value dedup: a value present in both the tool_result
    // block and its sibling toolUseResult is one at-rest secret, not two. The
    // value is the transient dedup key ONLY — it never leaves this function.
    const kindByValue = new Map<string, string>();
    for (const s of strings) {
      for (const { kind, value } of findSecrets(s)) {
        if (!kindByValue.has(value)) kindByValue.set(value, kind);
      }
    }
    if (kindByValue.size === 0) return;

    for (const kind of kindByValue.values()) {
      countsByKind[kind] = (countsByKind[kind] ?? 0) + 1;
      totalCount += 1;
    }

    if (evidenceRefs.length < MAX_EVIDENCE_REFS) {
      const ref: EvidenceRef = {
        sessionId,
        entryIndex,
        timestamp: typeof entry.timestamp === 'string' ? entry.timestamp : '',
      };
      const toolUseId = msg ? firstToolUseId(msg.content) : undefined;
      if (toolUseId) ref.toolUseId = toolUseId;
      evidenceRefs.push(ref);
    }

    if (typeof entry.timestamp === 'string') {
      const ms = Date.parse(entry.timestamp);
      if (Number.isFinite(ms) && ms > lastObservedMs) {
        lastObservedMs = ms;
        lastObserved = entry.timestamp;
      }
    }
  });

  if (totalCount === 0) return null;

  return {
    sessionId,
    totalCount,
    countsByKind,
    evidenceRefs,
    ...(lastObserved ? { lastObserved } : {}),
  };
}
