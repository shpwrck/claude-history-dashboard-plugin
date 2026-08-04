/**
 * parse-telemetry.ts — issue #562 (P7/Owen, feeds #572 Agent Report Card)
 *
 * Reads ~/.claude/telemetry/1p_failed_events*.json (NDJSON).
 * Each line is a ClaudeCodeInternalEvent. Decodes base64 additional_metadata
 * to extract attempt + elapsed_ms. Drops secrets: email, device_id, auth,
 * process blob are never retained.
 *
 * Despite the file name, these NDJSON files carry many `tengu_*` event types,
 * not only failures: `tengu_api_slow_first_byte` (the 30s timeout ceiling) AND
 * `tengu_exit` (clean shutdown, with successful-path API timing), retries, MCP
 * connection results, etc. The reliability path below keys only on the
 * slow-first-byte `elapsed_ms`; the latency path (#1166) keys only on the
 * `tengu_exit` successful-path API duration. The two never mix.
 *
 * Exports:
 *   TelemetryEvent          — cleaned event record (no secrets)
 *   parseTelemetryDir(dir)  — reads the glob, returns TelemetryEvent[]
 *   analyzeReliability(events) — per-session / per-model reliability metrics
 *   ModelLatencySample      — one successful-path per-model latency sample (#1166)
 *   parseTelemetryLatencyDir(dir) — reads the glob, returns ModelLatencySample[]
 *   aggregateModelLatency(samples) — per-model latency rollup, consumed by the
 *                                    #915 speed.model-latency detector
 *
 * This feeds the #572 consolidated Agent Report Card and (for the latency
 * capture) the shipped #915 speed.model-latency detector
 * (`detectors/speed/model-latency.ts`); AgentReportCardPf and ReviewQueuePf
 * render the results.
 */

import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_ARTIFACT_MAX_ENTRIES,
  normalizeMaxEntries,
  readDirentsBoundedSync,
} from './bounded-fs'
// The slow-first-byte event kind + predicate live in the fs-free
// `telemetry-event-kind` leaf so the browser-bundled upload parser
// (`upload-artifacts.ts`) can share the SAME predicate WITHOUT a runtime import
// edge into this fs-touching module (#3613 — that edge leaked `node:fs` into a
// browser view chunk). Re-exported below so existing `from './parse-telemetry'`
// consumers keep resolving; `parseTelemetryLine` uses the imported binding.
import { SLOW_FIRST_BYTE_EVENT, isSlowFirstByteEvent } from './telemetry-event-kind'

// ---------- Types ----------

/** Environment fingerprint: enough to attribute a reliability verdict to a build/box. */
export interface TelemetryEnvFingerprint {
  node_version: string
  terminal: string
  wsl_version: string
  linux_distro_id: string
  arch: string
  build_time: string
}

/**
 * A single cleaned failed-event record.
 * Joinable on session_id with sessions (sessions.sessionId === telemetry.session_id).
 * Secrets (email, device_id, auth, process blob) are dropped on parse.
 */
export interface TelemetryEvent {
  /** Always "tengu_api_slow_first_byte" in observed files; kept for future event types. */
  event_name: string
  /** ISO timestamp from the client. */
  client_timestamp: string
  /** The model string as emitted (e.g. "claude-opus-4-7[1m]"). */
  model: string
  /** Beta feature flags as a comma-separated string. */
  betas: string
  /** Session ID — join key with sessions parser. */
  session_id: string
  /**
   * Retry attempt number (1-based). Decoded from base64 additional_metadata.
   * 1 = no retry (first attempt failed fast).
   */
  attempt: number
  /**
   * Milliseconds spent waiting for first byte on this attempt before timeout.
   * Typically 30001 for slow-first-byte events.
   */
  elapsed_ms: number
  /** Env fingerprint for attributing the reading to a box/build. */
  env: TelemetryEnvFingerprint
}

export interface ParseTelemetryDirOptions {
  maxFileBytes?: number
  maxEntries?: number
}

// ---------- Internal raw shapes ----------

interface RawAdditionalMetadata {
  attempt?: unknown
  elapsed_ms?: unknown
  model?: unknown
  [key: string]: unknown
}

interface RawEnv {
  node_version?: unknown
  terminal?: unknown
  wsl_version?: unknown
  linux_distro_id?: unknown
  arch?: unknown
  build_time?: unknown
  [key: string]: unknown
}

interface RawEventData {
  event_name?: unknown
  client_timestamp?: unknown
  model?: unknown
  betas?: unknown
  session_id?: unknown
  additional_metadata?: unknown
  env?: RawEnv
  // secrets intentionally excluded from type to discourage access
  [key: string]: unknown
}

interface RawLine {
  event_type?: unknown
  event_data?: RawEventData
}

// ---------- Helpers ----------

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && isFinite(v) ? v : fallback
}

// Re-export the fs-free event-kind leaf (imported at the top) so existing
// `import { SLOW_FIRST_BYTE_EVENT } from './parse-telemetry'` consumers still
// resolve. See the import-site comment for why this lives in a separate leaf.
export { SLOW_FIRST_BYTE_EVENT, isSlowFirstByteEvent }

function decodeMetadata(raw: unknown): RawAdditionalMetadata {
  if (typeof raw !== 'string' || !raw) return {}
  try {
    return JSON.parse(Buffer.from(raw, 'base64').toString('utf8')) as RawAdditionalMetadata
  } catch {
    return {}
  }
}

function buildFingerprint(env: RawEnv | undefined): TelemetryEnvFingerprint {
  const e = env ?? {}
  return {
    node_version: str(e.node_version),
    terminal: str(e.terminal),
    wsl_version: str(e.wsl_version),
    linux_distro_id: str(e.linux_distro_id),
    arch: str(e.arch),
    build_time: str(e.build_time),
  }
}

// ---------- Parser ----------

/**
 * Parse one NDJSON line. Returns null on malformed input or missing required fields.
 * Never retains email / device_id / auth / process from the raw payload.
 */
export function parseTelemetryLine(line: string): TelemetryEvent | null {
  if (!line.trim()) return null
  let raw: RawLine
  try {
    raw = JSON.parse(line) as RawLine
  } catch {
    return null
  }
  const ed = raw.event_data
  if (!ed) return null

  const meta = decodeMetadata(ed.additional_metadata)

  const event_name = str(ed.event_name)
  // #3159: the reliability path is slow-first-byte failures only. Other
  // `tengu_*` events (tengu_exit, retries, MCP) would default to attempt 1 /
  // elapsed_ms 0 and dilute totalEvents + depress retryStormPct, so they are
  // dropped before a TelemetryEvent is emitted. (This also rejects an empty
  // event_name.) The tengu_exit latency reader is a separate parse path. The
  // shared {@link isSlowFirstByteEvent} predicate keeps this filter identical to
  // the upload parser's (#3613).
  if (!isSlowFirstByteEvent(event_name)) return null

  const attempt = num(meta.attempt, 1)
  const elapsed_ms = num(meta.elapsed_ms, 0)

  return {
    event_name,
    client_timestamp: str(ed.client_timestamp),
    model: str(ed.model),
    betas: str(ed.betas),
    session_id: str(ed.session_id),
    attempt,
    elapsed_ms,
    env: buildFingerprint(ed.env),
  }
}

/**
 * Iterate every NDJSON line of every 1p_failed_events*.json file in `dir`,
 * invoking `onLine` for each. Tolerates missing directory, missing files, and
 * unreadable files. Shared by both the reliability reader
 * ({@link parseTelemetryDir}) and the latency reader
 * ({@link parseTelemetryLatencyDir}) so the file-glob + size-bound logic lives
 * in one place.
 */
function eachTelemetryLine(
  dir: string,
  opts: ParseTelemetryDirOptions,
  onLine: (line: string) => void,
): void {
  const maxEntries = normalizeMaxEntries(opts.maxEntries, DEFAULT_ARTIFACT_MAX_ENTRIES)
  const files = readDirentsBoundedSync(dir, maxEntries)
    .map((entry) => entry.name)
    .filter((f) => f.includes('1p_failed_events'))
  const maxFileBytes =
    typeof opts.maxFileBytes === 'number' &&
    Number.isFinite(opts.maxFileBytes) &&
    opts.maxFileBytes >= 0
      ? Math.floor(opts.maxFileBytes)
      : -1

  for (const f of files) {
    let text: string
    try {
      const filePath = join(dir, f)
      const fileStat = statSync(filePath)
      if (
        !fileStat.isFile() ||
        (maxFileBytes >= 0 && fileStat.size > maxFileBytes)
      ) {
        continue
      }
      text = readFileSync(filePath, 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) onLine(line)
  }
}

/**
 * Read all 1p_failed_events*.json files from the given telemetry directory.
 * Files are NDJSON (one JSON object per line).
 * Tolerates missing directory, missing files, and malformed lines.
 */
export function parseTelemetryDir(
  dir: string,
  opts: ParseTelemetryDirOptions = {},
): TelemetryEvent[] {
  const events: TelemetryEvent[] = []
  eachTelemetryLine(dir, opts, (line) => {
    const ev = parseTelemetryLine(line)
    if (ev) events.push(ev)
  })
  return events
}

// ---------- Reliability analysis ----------

/** Attempt histogram bucket: count of events at each attempt number. */
export type AttemptHistogram = Record<number, number>

/** Per-model reliability breakdown. */
export interface ModelReliability {
  /** The model string. */
  model: string
  /** Total failed events for this model. */
  totalEvents: number
  /** Events at attempt >= RETRY_STORM_THRESHOLD. */
  stormEvents: number
  /** Percentage of events that were retry storms (0-100). */
  retryStormPct: number
  /** Highest attempt number seen for this model. */
  maxAttempt: number
  /** Total elapsed_ms across all events for this model. */
  wastedMs: number
  /** Attempt distribution for this model. */
  histogram: AttemptHistogram
}

/**
 * Per-session reliability summary — joinable on session_id.
 * This is the join key that the #572 Report Card uses to match against sessions.
 */
export interface SessionReliability {
  /** Join key: matches sessions.sessionId. */
  session_id: string
  /** Total failed events in this session. */
  totalEvents: number
  /** Events at attempt >= RETRY_STORM_THRESHOLD. */
  stormEvents: number
  /** Percentage of events that were retry storms (0-100). */
  retryStormPct: number
  /** Highest attempt number seen in this session. */
  maxAttempt: number
  /**
   * Total wasted wall-clock ms from slow-first-byte timeouts.
   * Each event contributes its elapsed_ms regardless of attempt count,
   * as every failed event represents dead wait time.
   */
  totalWastedMs: number
  /** Attempt distribution for this session. */
  histogram: AttemptHistogram
  /** Per-model breakdown within this session. */
  byModel: ModelReliability[]
  /** Env fingerprint (from the first event in this session). */
  env: TelemetryEnvFingerprint
}

/** Fleet-wide reliability metrics (across all sessions). */
export interface ReliabilityAnalysis {
  /** Total events analyzed. */
  totalEvents: number
  /** Events at attempt >= RETRY_STORM_THRESHOLD. */
  totalStormEvents: number
  /** Fleet-wide retry-storm rate as a percentage (0-100). */
  retryStormPct: number
  /** Highest single attempt seen across the fleet. */
  maxAttempt: number
  /**
   * Total wasted wall-clock ms from slow-first-byte timeouts (fleet-wide).
   * Represents real per-task cost invisible in transcripts.
   */
  totalWastedMs: number
  /** Fleet-wide attempt histogram. */
  histogram: AttemptHistogram
  /** Per-model breakdown across the fleet. */
  byModel: ModelReliability[]
  /**
   * Per-session breakdown, joinable on session_id for the #572 Report Card.
   * sessions.sessionId === telemetry.session_id
   */
  bySession: SessionReliability[]
}

/**
 * Attempt number at or above which an event is classified as a "retry storm".
 * Mirrors the prototype threshold (attempt >= 4).
 */
export const RETRY_STORM_THRESHOLD = 4

function buildHistogram(events: TelemetryEvent[]): AttemptHistogram {
  const h: AttemptHistogram = {}
  for (const ev of events) {
    h[ev.attempt] = (h[ev.attempt] ?? 0) + 1
  }
  return h
}

function buildModelReliability(model: string, events: TelemetryEvent[]): ModelReliability {
  const storms = events.filter((e) => e.attempt >= RETRY_STORM_THRESHOLD)
  const wastedMs = events.reduce((s, e) => s + e.elapsed_ms, 0)
  const maxAttempt = events.reduce((m, e) => Math.max(m, e.attempt), 0)
  const pct = events.length ? Math.round((storms.length / events.length) * 100) : 0
  return {
    model,
    totalEvents: events.length,
    stormEvents: storms.length,
    retryStormPct: pct,
    maxAttempt,
    wastedMs,
    histogram: buildHistogram(events),
  }
}

/**
 * Compute per-session and per-model reliability metrics from a flat list of
 * TelemetryEvent records. Returns a ReliabilityAnalysis object whose bySession
 * array is joinable on session_id for the #572 consolidated Agent Report Card.
 *
 * Threshold: attempt >= 4 == "retry storm" (prototype parity).
 */
export function analyzeReliability(events: TelemetryEvent[]): ReliabilityAnalysis {
  if (events.length === 0) {
    return {
      totalEvents: 0,
      totalStormEvents: 0,
      retryStormPct: 0,
      maxAttempt: 0,
      totalWastedMs: 0,
      histogram: {},
      byModel: [],
      bySession: [],
    }
  }

  // Fleet-level
  const stormEvents = events.filter((e) => e.attempt >= RETRY_STORM_THRESHOLD)
  const totalWastedMs = events.reduce((s, e) => s + e.elapsed_ms, 0)
  const maxAttempt = events.reduce((m, e) => Math.max(m, e.attempt), 0)
  const retryStormPct = Math.round((stormEvents.length / events.length) * 100)

  // Group by model (fleet)
  const modelMap = new Map<string, TelemetryEvent[]>()
  for (const ev of events) {
    const bucket = modelMap.get(ev.model) ?? []
    bucket.push(ev)
    modelMap.set(ev.model, bucket)
  }
  const byModel = [...modelMap.entries()]
    .map(([model, evs]) => buildModelReliability(model, evs))
    .sort((a, b) => b.wastedMs - a.wastedMs)

  // Group by session
  const sessionMap = new Map<string, TelemetryEvent[]>()
  for (const ev of events) {
    const bucket = sessionMap.get(ev.session_id) ?? []
    bucket.push(ev)
    sessionMap.set(ev.session_id, bucket)
  }

  const bySession: SessionReliability[] = [...sessionMap.entries()].map(([session_id, sevs]) => {
    const sStorms = sevs.filter((e) => e.attempt >= RETRY_STORM_THRESHOLD)
    const sWasted = sevs.reduce((s, e) => s + e.elapsed_ms, 0)
    const sMax = sevs.reduce((m, e) => Math.max(m, e.attempt), 0)
    const sPct = sevs.length ? Math.round((sStorms.length / sevs.length) * 100) : 0

    // Per-model breakdown within this session
    const sModelMap = new Map<string, TelemetryEvent[]>()
    for (const ev of sevs) {
      const bucket = sModelMap.get(ev.model) ?? []
      bucket.push(ev)
      sModelMap.set(ev.model, bucket)
    }
    const sessionByModel = [...sModelMap.entries()]
      .map(([model, evs]) => buildModelReliability(model, evs))
      .sort((a, b) => b.wastedMs - a.wastedMs)

    return {
      session_id,
      totalEvents: sevs.length,
      stormEvents: sStorms.length,
      retryStormPct: sPct,
      maxAttempt: sMax,
      totalWastedMs: sWasted,
      histogram: buildHistogram(sevs),
      byModel: sessionByModel,
      env: sevs[0].env,
    }
  })

  return {
    totalEvents: events.length,
    totalStormEvents: stormEvents.length,
    retryStormPct,
    maxAttempt,
    totalWastedMs,
    histogram: buildHistogram(events),
    byModel,
    bySession,
  }
}

// ---------- Successful-turn per-model latency (#1166, epic #866) ----------
//
// Precondition for the deferred `speed.model-latency` detector (#915): a clean
// per-model latency signal that is NOT the `tengu_api_slow_first_byte` timeout
// ceiling (`elapsed_ms`, observed as a flat 30001ms model-agnostic dead-wait).
//
// The one successful-path timing the telemetry corpus actually carries per model
// is `tengu_exit.last_session_api_duration`: the cumulative wall-clock the client
// spent IN the model API across the session, recorded on a clean shutdown. It is
//   - successful-path: emitted on `tengu_exit`, never on a timeout;
//   - per-model: the event's `model` attributes it;
//   - ADR-0006 isolable: `last_session_tool_duration` (tool wall-clock) is carried
//     separately so a consumer can subtract tool time, and the slow-first-byte
//     dead-wait lives on a different event entirely, so neither retry/queue
//     inflation nor the timeout ceiling can pollute this number.
//
// Known limitation (documented for #915): this is session-CUMULATIVE API time,
// not per-turn time-to-first-token. Per-turn TTFB does exist, but in the *debug*
// logs (`parse-debug.ts`: `[API REQUEST] /v1/messages` -> `Stream started`), a
// different artifact. #1166's scope is the telemetry parser hook; #915 decides
// whether session-cumulative API duration (optionally normalized per output
// token via the carried token counts) is a usable latency basis or whether it
// must join the debug TTFB signal. We capture what telemetry has; we build no
// recommendation here.

/**
 * One successful-path per-model latency sample, from a `tengu_exit` event.
 * Joinable on `session_id` with sessions and with {@link SessionReliability}.
 * Secrets are never read (we only touch the timing/token/model fields).
 */
export interface ModelLatencySample {
  /** Join key: matches sessions.sessionId. */
  session_id: string
  /** The model string as emitted (e.g. "claude-opus-4-8[1m]"). */
  model: string
  /**
   * Cumulative successful-path API wall-clock for the session, in ms
   * (`tengu_exit.last_session_api_duration`). Time spent in the model API only;
   * excludes tool time and the slow-first-byte timeout path. Always > 0 for a
   * captured sample — zero/absent durations are dropped, not recorded as 0ms.
   */
  apiDurationMs: number
  /**
   * Cumulative tool wall-clock for the session, in ms
   * (`tengu_exit.last_session_tool_duration`). Carried so a consumer can isolate
   * model time from tool time (ADR 0006). May be 0.
   */
  toolDurationMs: number
  /** Session input tokens (`last_session_total_input_tokens`); 0 if absent. */
  inputTokens: number
  /** Session output tokens (`last_session_total_output_tokens`); 0 if absent. */
  outputTokens: number
  /** ISO timestamp from the client. */
  client_timestamp: string
}

/**
 * Parse one NDJSON line into a {@link ModelLatencySample}, or null.
 *
 * Returns null unless the line is a well-formed `tengu_exit` event whose decoded
 * metadata carries a positive `last_session_api_duration`. By construction this
 * EXCLUDES `tengu_api_slow_first_byte` (and every other event), so the 30s
 * timeout ceiling can never enter the latency signal. A `tengu_exit` with a
 * zero/absent API duration (e.g. a headless/SDK session that recorded none) is
 * dropped rather than emitted as a misleading 0ms latency.
 */
export function parseTelemetryLatencyLine(line: string): ModelLatencySample | null {
  if (!line.trim()) return null
  let raw: RawLine
  try {
    raw = JSON.parse(line) as RawLine
  } catch {
    return null
  }
  const ed = raw.event_data
  if (!ed) return null
  if (str(ed.event_name) !== 'tengu_exit') return null

  const meta = decodeMetadata(ed.additional_metadata)
  const apiDurationMs = num(meta.last_session_api_duration, 0)
  if (apiDurationMs <= 0) return null

  return {
    session_id: str(ed.session_id),
    model: str(ed.model),
    apiDurationMs,
    toolDurationMs: Math.max(0, num(meta.last_session_tool_duration, 0)),
    inputTokens: Math.max(0, num(meta.last_session_total_input_tokens, 0)),
    outputTokens: Math.max(0, num(meta.last_session_total_output_tokens, 0)),
    client_timestamp: str(ed.client_timestamp),
  }
}

/**
 * Read all 1p_failed_events*.json files and return the successful-path per-model
 * latency samples (one per `tengu_exit` with positive API duration). Same glob,
 * size bounds, and fault tolerance as {@link parseTelemetryDir}.
 */
export function parseTelemetryLatencyDir(
  dir: string,
  opts: ParseTelemetryDirOptions = {},
): ModelLatencySample[] {
  const samples: ModelLatencySample[] = []
  eachTelemetryLine(dir, opts, (line) => {
    const s = parseTelemetryLatencyLine(line)
    if (s) samples.push(s)
  })
  return samples
}

/** Per-model latency rollup across samples. No recommendation — groundwork for #915. */
export interface ModelLatency {
  /** The model string. */
  model: string
  /** Number of samples (sessions) contributing. */
  samples: number
  /** Sum of `apiDurationMs` across samples. */
  totalApiDurationMs: number
  /** Mean API wall-clock per session, ms (`totalApiDurationMs / samples`). */
  avgApiDurationMs: number
  /** Sum of `outputTokens` across samples. */
  totalOutputTokens: number
  /**
   * API ms per output token (`totalApiDurationMs / totalOutputTokens`), or null
   * when no output tokens were recorded. A coarse latency-per-work proxy #915 may
   * refine; null is honest "not derivable" rather than a divide-by-zero.
   */
  msPerOutputToken: number | null
}

/**
 * Aggregate {@link ModelLatencySample}s into a per-model rollup, sorted by total
 * API duration descending. Pure; no I/O. Builds no recommendation (that is #915).
 */
export function aggregateModelLatency(samples: ModelLatencySample[]): ModelLatency[] {
  const byModel = new Map<string, ModelLatencySample[]>()
  for (const s of samples) {
    const bucket = byModel.get(s.model) ?? []
    bucket.push(s)
    byModel.set(s.model, bucket)
  }
  return [...byModel.entries()]
    .map(([model, evs]) => {
      const totalApiDurationMs = evs.reduce((sum, e) => sum + e.apiDurationMs, 0)
      const totalOutputTokens = evs.reduce((sum, e) => sum + e.outputTokens, 0)
      return {
        model,
        samples: evs.length,
        totalApiDurationMs,
        avgApiDurationMs: Math.round(totalApiDurationMs / evs.length),
        totalOutputTokens,
        msPerOutputToken:
          totalOutputTokens > 0 ? totalApiDurationMs / totalOutputTokens : null,
      }
    })
    .sort((a, b) => b.totalApiDurationMs - a.totalApiDurationMs)
}
