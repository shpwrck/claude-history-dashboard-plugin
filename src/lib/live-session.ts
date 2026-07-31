// Live Session widget compute, extracted from scripts/ingest.mjs (#627 slice 2,
// epic #622). This is the PURE computation over a GIVEN session list — file
// reads + parser passes, no SQLite, no session discovery. ingest.mjs keeps a
// thin `computeLiveSession(now)` wrapper that injects the discovery dependency
// (`listSessionsCached()`), preserving the server import surface without an
// import cycle. Server-only in practice: this module imports `node:fs` below.
//
// The dataset cache lags an active session by design; liveness must not — so
// this path is deliberately file-based (readFileSync/statSync), not SQLite.

import { closeSync, openSync, readSync, statSync } from 'node:fs';
import type { SessionTokenData } from '../types';
import { parseSessionJsonl } from './parse-sessions';
import { parseToolUsage, type ToolUsageData } from './parse-tools';
import { parseJsonl, type RawSessionEntry } from './parse-utils';
import { detectRetryGroups } from './parse-errors';
import { parseFileReread } from './parse-file-reread';
import { IDLE_TURN_THRESHOLD_MS } from './parse-runtime-events';
import { OVER_WINDOW } from './context-health';

// How many trailing tool calls the in-progress reread / retry-storm detectors
// scan (#196). Scoping to the recent tail answers "is this pattern happening
// RIGHT NOW", so an old, since-resolved loop earlier in a long session doesn't
// keep the badge lit. The detectors' own thresholds (#139) decide whether the
// scoped slice qualifies; this just bounds the window they see.
const LIVE_PATTERN_WINDOW = 40;
const READ_CHUNK_BYTES = 65_536;

function parseNonNegativeIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

export const LIVE_SESSION_MAX_BYTES = Math.max(
  65_536,
  Math.min(
    67_108_864,
    parseNonNegativeIntEnv('DASHBOARD_LIVE_SESSION_MAX_BYTES', 67_108_864)
  )
);

// Explicit live-poll budgets at the MAX transcript size (#3130). A poll reads at
// most LIVE_SESSION_MAX_BYTES (64 MiB) and now parses that text EXACTLY ONCE —
// the memoized parseJsonl pass is shared across liveness, token, and tool
// derivation, so the peak working set is one decoded string plus one parsed
// line array, not several independent full parses. These are the documented
// ceilings the probe in live-session.test.ts asserts against; they are guidance
// (a benchmark guard), not runtime-enforced limits.
//
// Latency: a single JSON.parse pass over 64 MiB of JSONL plus the token/tool
// derivation is well under a second on commodity hardware; 3 s is a generous
// CI-stable ceiling that a regression to multi-pass parsing would blow.
export const LIVE_SESSION_POLL_LATENCY_BUDGET_MS = 3_000;
// Peak transient memory: the decoded transcript (<= maxBytes) plus one parsed
// line array plus the derived views. ~5x maxBytes is ample headroom for a single
// shared parse; a per-derivation re-parse would multiply this.
export const LIVE_SESSION_POLL_PEAK_MEMORY_BUDGET_BYTES = 5 * LIVE_SESSION_MAX_BYTES;

/**
 * Optional per-poll instrumentation (#3130). When supplied, `liveSession`
 * reports how much transcript it materialized this poll. The single-parse
 * guarantee (merged text is JSON-parsed ONCE, shared across liveness/token/tool)
 * is a structural property of routing every derivation through the memoized
 * `parseJsonl`; the probe in live-session.test.ts pins it with a `JSON.parse`
 * spy rather than a self-reported count.
 */
export interface LivePollInstrumentation {
  /** Bytes of merged transcript text materialized this poll. */
  mergedBytes: number;
  /** Lines in the merged transcript. */
  mergedLines: number;
}

// The session-discovery shape this module operates on. Mirrors what
// listSessions() in ingest.mjs produces: one entry per top-level transcript,
// with the absolute file paths the file-based helpers below read.
export interface LiveSessionInput {
  sessionId: string;
  project: string;
  topPath: string;
  subPaths: string[];
}

export interface LiveSessionResult {
  active: boolean;
  sessionId?: string;
  project?: string;
  model?: string;
  tokensBurned?: number;
  contextTokens?: number;
  contextWindow?: number;
  contextPercent?: number;
  lastEventMs?: number;
  msSinceLastEvent?: number;
  msSinceLastUserTurn?: number | null;
  retryStorm?: boolean;
  rereadLoop?: boolean;
}

export interface LiveSessionOptions {
  maxBytes?: number;
  /** Optional per-poll instrumentation sink (#3130); see {@link LivePollInstrumentation}. */
  instrument?: (info: LivePollInstrumentation) => void;
}

type LiveSessionCapError = Error & { code?: string; maxBytes?: number };

function liveSessionTooLargeError(maxBytes: number): LiveSessionCapError {
  const err = new Error(`Live session transcript exceeds ${maxBytes} byte limit`) as LiveSessionCapError;
  err.code = 'ERR_DASHBOARD_LIVE_SESSION_TOO_LARGE';
  err.maxBytes = maxBytes;
  return err;
}

function isLiveSessionTooLargeError(err: unknown): boolean {
  return Boolean(
    err &&
      typeof err === 'object' &&
      (err as { code?: unknown }).code === 'ERR_DASHBOARD_LIVE_SESSION_TOO_LARGE'
  );
}

function normalizedMaxBytes(maxBytes: number | undefined): number {
  if (maxBytes == null || !Number.isFinite(maxBytes) || maxBytes < 0) {
    return LIVE_SESSION_MAX_BYTES;
  }
  return Math.max(65_536, Math.min(67_108_864, Math.floor(maxBytes)));
}

function readUtf8FileCappedSync(
  filePath: string,
  maxBytes: number,
  initialBytes = 0
): { text: string; bytes: number } {
  const fd = openSync(filePath, 'r');
  const chunks: Buffer[] = [];
  let bytes = initialBytes;
  const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, maxBytes + 1));
  try {
    while (true) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      bytes += bytesRead;
      if (bytes > maxBytes) throw liveSessionTooLargeError(maxBytes);
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
  } finally {
    closeSync(fd);
  }
  return {
    text: Buffer.concat(chunks).toString('utf8'),
    bytes,
  };
}

// Render an array-or-string message `content` to plain text. Mirrors
// textBlocksToString() in ingest.mjs; lastUserTurnMs() below needs it to skip
// tool_result-only user turns.
function textBlocksToString(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        typeof b === 'string'
          ? b
          : b && typeof b === 'object' && (b as { type?: unknown }).type === 'text'
            ? String((b as { text?: unknown }).text ?? '')
            : ''
      )
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

// Newest timestamp across every line of a transcript, in epoch-ms. 0 when the
// file has no parseable timestamp. Consumes the SHARED parsed line array
// (parseJsonl, memoized) rather than re-splitting and re-parsing the text, so
// liveness reuses the exact pass the token/tool derivations run over (#3130).
function newestEventMs(entries: RawSessionEntry[]): number {
  let newest = 0;
  for (const o of entries) {
    if (typeof o.timestamp !== 'string') continue;
    const t = Date.parse(o.timestamp);
    if (isFinite(t) && t > newest) newest = t;
  }
  return newest;
}

// Epoch-ms of the last typed user turn (a real `type:"user"` message, not a
// tool_result-only turn or a meta/sidechain line). Mirrors deriveEntries()'s
// notion of a user turn so "time since last user turn" lines up with what the
// Sessions view treats as user input. 0 when none found.
function lastUserTurnMs(entries: RawSessionEntry[]): number {
  let last = 0;
  for (const raw of entries) {
    const o = raw as {
      type?: unknown;
      isMeta?: unknown;
      isSidechain?: unknown;
      message?: { role?: unknown; content?: unknown };
      timestamp?: unknown;
    };
    if (o.type !== 'user' || o.isMeta || o.isSidechain || !o.message) continue;
    if (o.message.role && o.message.role !== 'user') continue;
    const txt = textBlocksToString(o.message.content).trim();
    if (!txt) continue; // skip tool_result-only user turns
    const t = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN;
    if (isFinite(t) && t > last) last = t;
  }
  return last;
}

// Current context occupancy (input + cache-creation + cache-read of the latest
// usage record), matching contextSize() in context-health/compaction-risk. The
// latest entry's context is "how full is the window right now"; peak would be
// the historical high-water mark. We report current fullness for the live view.
function currentContextTokens(tokenData: SessionTokenData | null | undefined): number {
  const entries = tokenData?.entries ?? [];
  if (entries.length === 0) return 0;
  const e = entries[entries.length - 1];
  // Defensive: a missing token field must not poison the sum into NaN.
  return (
    (e.inputTokens || 0) +
    (e.cacheCreationTokens || 0) +
    (e.cacheReadTokens || 0)
  );
}

// Read a transcript's text, returning the top-level file and the merged
// (top-level + subagents) text. Liveness + token parsing use `merged` so
// subagent activity counts; "time since last user turn" uses `top` so subagent
// task prompts aren't mistaken for the human's input (mirrors deriveEntries).
// `top` is '' (and `merged` therefore '') when the top file is unreadable;
// subagent reads are best-effort.
function readTranscriptTexts(
  s: LiveSessionInput,
  maxBytes: number
): { top: string; merged: string } {
  let topRead: { text: string; bytes: number };
  try {
    topRead = readUtf8FileCappedSync(s.topPath, maxBytes);
  } catch {
    return { top: '', merged: '' };
  }
  const top = topRead.text;
  let merged = top;
  let mergedBytes = topRead.bytes;
  for (const sp of s.subPaths) {
    try {
      const prefix = merged.length && !merged.endsWith('\n') ? '\n' : '';
      const prefixBytes = Buffer.byteLength(prefix, 'utf8');
      if (mergedBytes + prefixBytes >= maxBytes) break;
      const { text, bytes } = readUtf8FileCappedSync(
        sp,
        maxBytes,
        mergedBytes + prefixBytes
      );
      if (prefix) merged += prefix;
      merged += text;
      mergedBytes = bytes;
    } catch (err) {
      if (isLiveSessionTooLargeError(err)) break;
      /* skip unreadable subagent file */
    }
  }
  return { top, merged };
}

// In-progress "why" badge (#196). Run the #139 retry-storm and re-read-loop
// detectors over the RECENT tail of the live session's tool calls and report
// whether either bad pattern is currently active. Reuses detectRetryGroups and
// parseFileReread with the exact same thresholds the evaluator landing uses
// (EvaluatorLanding.tsx): detectRetryGroups(calls, 60) — a run of >=2
// back-to-back same-tool calls within a 60s gap — and parseFileReread(...,
// threshold=3) — the same file Read >=3 times. No new numbers, no duplicated
// detection logic. Scoped to the last LIVE_PATTERN_WINDOW tool calls so the
// badge reflects the current loop, not one resolved earlier in the session.
function detectLivePatterns(tool: ToolUsageData | null | undefined): {
  retryStorm: boolean;
  rereadLoop: boolean;
} {
  const allCalls = tool?.calls ?? [];
  if (allCalls.length === 0) {
    return { retryStorm: false, rereadLoop: false };
  }
  const recentCalls = allCalls.slice(-LIVE_PATTERN_WINDOW);
  const scoped: ToolUsageData[] = [{ sessionId: tool!.sessionId, calls: recentCalls }];

  // Retry storm: any run of back-to-back same-tool calls within 60s (the
  // evaluator's gapSec). detectRetryGroups only emits groups of length >= 2.
  const retryStorm = detectRetryGroups(scoped, 60).length > 0;

  // Re-read loop: the same file Read >= 3x (parseFileReread's default
  // threshold) in the scoped window.
  const reread = parseFileReread(scoped, [], 3);
  const rereadLoop = reread.repeats.length > 0;

  return { retryStorm, rereadLoop };
}

// Pure Live Session compute over a GIVEN session list. ingest.mjs's
// computeLiveSession(now) injects the discovered+cached session set; tests pass
// a hand-built list. `now` is supplied by the caller (epoch-ms).
export function liveSession(
  sessions: LiveSessionInput[],
  now: number,
  options: LiveSessionOptions = {}
): LiveSessionResult {
  const maxBytes = normalizedMaxBytes(options.maxBytes);
  // Pick the candidate cheaply by file mtime: the active transcript is the one
  // being written to right now, so its freshest file has the newest mtime. We
  // stat the top-level file AND each subagent file (#266 review #2) so a session
  // busy only in a subagents/*.jsonl loop — its parent's top file untouched —
  // still wins the candidate. Only that candidate is read + fully parsed.
  let candidate: LiveSessionInput | null = null;
  let candidateMtime = -Infinity;
  for (const s of sessions) {
    let mtime = -Infinity;
    for (const p of [s.topPath, ...s.subPaths]) {
      try {
        const m = statSync(p).mtimeMs;
        if (m > mtime) mtime = m;
      } catch {
        /* skip unstatable file */
      }
    }
    if (mtime > candidateMtime) {
      candidateMtime = mtime;
      candidate = s;
    }
  }
  if (!candidate) return { active: false };

  // Read the transcript up front: liveness must see subagent timestamps too
  // (#266 review #2), or a session whose only recent activity is in a subagent
  // loop reads as idle. The `merged` text feeds liveness + the token parser; the
  // `top` text feeds last-user-turn. We read each file once.
  const { top, merged } = readTranscriptTexts(candidate, maxBytes);
  if (!merged) return { active: false };

  // ONE parse pass over the merged transcript, shared across liveness, tokens,
  // and tools (#3130). parseJsonl memoizes by text, so the explicit call here
  // populates the cache and the parseSessionJsonl / parseToolUsage passes below
  // reuse it instead of each re-splitting and re-parsing 64 MiB. newestEventMs
  // consumes the parsed array directly rather than doing its own JSON.parse loop.
  const mergedEntries = parseJsonl(merged);
  if (options.instrument) {
    options.instrument({
      mergedBytes: Buffer.byteLength(merged, 'utf8'),
      mergedLines: mergedEntries.length,
    });
  }

  // Liveness is decided on the transcript's newest EVENT timestamp, not file
  // mtime (an mtime can move without a new event, e.g. a touch). < 15 min old ==
  // active, reusing the IDLE_TURN_THRESHOLD_MS notion from #74.
  const newestMs = newestEventMs(mergedEntries);
  if (newestMs === 0 || now - newestMs >= IDLE_TURN_THRESHOLD_MS) {
    return { active: false };
  }

  // Token/model facts come from the same parser the dataset uses, over the
  // merged transcript so subagent burn is counted. It reuses the shared
  // parseJsonl pass above (cache hit).
  const name = `${candidate.sessionId}.jsonl`;
  const token = parseSessionJsonl(merged, name);
  if (!token) return { active: false };

  // In-progress "why" badge (#196): same parser the dataset's tool views use,
  // over the merged transcript, then the #139 detectors over its recent tail.
  // Live polls read only error/retry patterns; skip the edit-churn derivation
  // so an active transcript's Edit bodies aren't split on every poll (#2507).
  // Also a parseJsonl cache hit — no re-parse.
  const tool = parseToolUsage(merged, name, { editFormatChurn: false });
  const { retryStorm, rereadLoop } = detectLivePatterns(tool);

  // Tokens burned so far = every token type the session has consumed (input +
  // output + cache writes + cache reads). This is cumulative usage, distinct
  // from the context-occupancy number below.
  const tokensBurned =
    token.totalInputTokens +
    token.totalOutputTokens +
    token.totalCacheCreationTokens +
    token.totalCacheReadTokens;
  const contextTokens = currentContextTokens(token) || 0;
  // Same denominator (200K) the compaction-risk / context-health views use.
  // isFinite-fenced so a bad token field can never render NaN% / a broken bar.
  const rawPercent = (contextTokens / OVER_WINDOW) * 100;
  const contextPercent = isFinite(rawPercent)
    ? Math.min(100, Math.max(0, rawPercent))
    : 0;

  // "Time since last user turn" stays on the top-level file only: subagent
  // "user" lines are task prompts, not the human's input (mirrors deriveEntries).
  // parseJsonl memoizes, so when top === merged (no subagents) this is a cache
  // hit; otherwise it is a single parse of the smaller top-level file.
  const lastUserMs = lastUserTurnMs(parseJsonl(top));
  const msSinceLastUserTurn =
    lastUserMs > 0 ? Math.max(0, now - lastUserMs) : null;

  return {
    active: true,
    sessionId: candidate.sessionId,
    project: candidate.project,
    model: token.model,
    tokensBurned,
    contextTokens,
    contextWindow: OVER_WINDOW,
    contextPercent,
    lastEventMs: newestMs,
    msSinceLastEvent: Math.max(0, now - newestMs),
    msSinceLastUserTurn,
    // #196 "why" badge: true when the recent tail of this session is in a
    // retry storm / re-read loop right now.
    retryStorm,
    rereadLoop,
  };
}
