/**
 * fs-free leaf: the pure telemetry analytics shared by the server-side
 * telemetry parser (`parse-telemetry.ts`) and the browser-bundled consumers
 * (`review-queue.ts`, `report-card.ts`, the #915 `speed.model-latency`
 * detector) — the #3639 slice of the #3613 extraction pattern.
 *
 * This lives in its OWN dependency-free leaf — NOT in `parse-telemetry.ts` —
 * on purpose. `parse-telemetry.ts` transitively imports `node:fs` (via
 * `bounded-fs`, which `parseTelemetryDir` needs), and in the SPA build
 * `node:fs` resolves to an empty stub that throws at module scope. A value
 * import of `analyzeReliability`/`aggregateModelLatency` from the fs-touching
 * module dragged the fs graph into the ReviewQueuePf / AgentReportCardPf view
 * chunks and white-screened them on load (#3639). Browser code imports the
 * analytics from here; only the dir scanners stay behind with the fs graph.
 *
 * Everything in this module is pure: types, thresholds, and aggregation over
 * already-parsed `TelemetryEvent` / `ModelLatencySample` arrays. No I/O.
 */

// ---------- Event types ----------

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
  // perf-index-contract: telemetry-fleet-by-model always-consumed: drained into byModel two statements later on every call that reaches this grouping
  const modelMap = new Map<string, TelemetryEvent[]>()
  for (const ev of events) {
    const bucket = modelMap.get(ev.model) ?? []
    bucket.push(ev)
    modelMap.set(ev.model, bucket)
  }
  // perf-index-contract: telemetry-fleet-by-model always-consumed: the sorted rollup is returned in the analysis object unconditionally
  const byModel = [...modelMap.entries()]
    .map(([model, evs]) => buildModelReliability(model, evs))
    .sort((a, b) => b.wastedMs - a.wastedMs)

  // Group by session
  // perf-index-contract: telemetry-by-session always-consumed: drained into bySession immediately below on every call that reaches this grouping
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
    // perf-index-contract: telemetry-session-by-model always-consumed: drained into sessionByModel two statements later for every session entry
    const sModelMap = new Map<string, TelemetryEvent[]>()
    for (const ev of sevs) {
      const bucket = sModelMap.get(ev.model) ?? []
      bucket.push(ev)
      sModelMap.set(ev.model, bucket)
    }
    // perf-index-contract: telemetry-session-by-model always-consumed: the sorted per-session rollup is returned in the bySession record unconditionally
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
  // perf-index-contract: latency-by-model always-consumed: drained into the returned rollup on every call; the function has no other exit
  const byModel = new Map<string, ModelLatencySample[]>()
  for (const s of samples) {
    const bucket = byModel.get(s.model) ?? []
    bucket.push(s)
    byModel.set(s.model, bucket)
  }
  // perf-index-contract: latency-by-model always-consumed: the sorted rollup IS the return value
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
    // perf-index-contract: latency-by-model always-consumed: the sorted rollup IS the return value
    .sort((a, b) => b.totalApiDurationMs - a.totalApiDurationMs)
}
