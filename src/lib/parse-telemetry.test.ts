/**
 * parse-telemetry.test.ts — issue #562
 *
 * Fixtures are shaped exactly like the real artifact
 * (~/.claude/telemetry/1p_failed_events.<session>.<id>.json).
 * additional_metadata is base64-encoded JSON, just as on disk.
 * Secrets (email, device_id, auth, process) are omitted from fixtures.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import {
  parseTelemetryLine,
  parseTelemetryDir,
  analyzeReliability,
  RETRY_STORM_THRESHOLD,
  parseTelemetryLatencyLine,
  parseTelemetryLatencyDir,
  aggregateModelLatency,
  type TelemetryEvent,
  type ModelLatencySample,
} from './parse-telemetry'

// ---------- Fixture helpers ----------

const b64 = (o: Record<string, unknown>): string =>
  Buffer.from(JSON.stringify(o)).toString('base64')

const ENV = {
  platform: 'linux',
  node_version: 'v24.3.0',
  terminal: 'windows-terminal',
  package_managers: 'npm',
  runtimes: 'node',
  is_running_with_bun: true,
  is_ci: false,
  is_github_action: false,
  version: '2.1.150',
  wsl_version: '2',
  arch: 'x64',
  deployment_environment: 'unknown-linux',
  linux_distro_id: 'fedora',
  linux_distro_version: '44',
  linux_kernel: '5.15.167.4-microsoft-standard-WSL2',
  shell: 'bash',
  build_time: '2026-05-23T01:22:49Z',
}

/**
 * Build a raw NDJSON line shaped exactly like a real 1p_failed_events line.
 * process / email / device_id / auth are absent — never included in fixtures.
 */
function makeLine(
  model: string,
  attempt: number,
  elapsed_ms: number,
  session_id = 'e4449e68-559e-4aab-9195-a4ffe3d19542',
  client_timestamp = '2026-05-25T22:49:00.213Z',
): string {
  return JSON.stringify({
    event_type: 'ClaudeCodeInternalEvent',
    event_data: {
      event_name: 'tengu_api_slow_first_byte',
      client_timestamp,
      model,
      session_id,
      user_type: 'external',
      betas: 'claude-code-20250219,oauth-2025-04-20,context-1m-2025-08-07',
      env: ENV,
      entrypoint: 'cli',
      is_interactive: true,
      client_type: 'cli',
      additional_metadata: b64({
        renderer_mode: 'default',
        subscription_type: 'max',
        model,
        provider: 'firstParty',
        attempt,
        elapsed_ms,
      }),
    },
  })
}

// ---------- parseTelemetryLine ----------

describe('parseTelemetryLine', () => {
  it('decodes base64 additional_metadata and extracts attempt + elapsed_ms', () => {
    const ev = parseTelemetryLine(makeLine('claude-opus-4-7[1m]', 3, 30001))
    expect(ev).not.toBeNull()
    expect(ev!.attempt).toBe(3)
    expect(ev!.elapsed_ms).toBe(30001)
  })

  it('captures model, session_id, event_name, betas', () => {
    const ev = parseTelemetryLine(makeLine('claude-haiku-4-5-20251001', 6, 30001))!
    expect(ev.model).toBe('claude-haiku-4-5-20251001')
    expect(ev.session_id).toBe('e4449e68-559e-4aab-9195-a4ffe3d19542')
    expect(ev.event_name).toBe('tengu_api_slow_first_byte')
    expect(ev.betas).toContain('claude-code-20250219')
  })

  it('extracts env fingerprint fields from env blob', () => {
    const ev = parseTelemetryLine(makeLine('claude-opus-4-7[1m]', 1, 30000))!
    expect(ev.env).toMatchObject({
      node_version: 'v24.3.0',
      terminal: 'windows-terminal',
      wsl_version: '2',
      linux_distro_id: 'fedora',
      arch: 'x64',
      build_time: '2026-05-23T01:22:49Z',
    })
  })

  it('does NOT retain email, device_id, auth, or process on the returned event', () => {
    // Build a line that includes the secret fields as the real artifact does
    const lineWithSecrets = JSON.stringify({
      event_type: 'ClaudeCodeInternalEvent',
      event_data: {
        event_name: 'tengu_api_slow_first_byte',
        client_timestamp: '2026-05-25T22:49:00Z',
        model: 'claude-opus-4-7[1m]',
        session_id: 'sess-1',
        betas: '',
        env: ENV,
        additional_metadata: b64({ attempt: 2, elapsed_ms: 30001 }),
        // secrets:
        email: 'user@example.com',
        device_id: 'deadbeef',
        auth: { organization_uuid: 'org-1', account_uuid: 'acct-1' },
        process: b64({ uptime: 123 }),
      },
    })
    const ev = parseTelemetryLine(lineWithSecrets)!
    expect(ev).not.toBeNull()
    expect(ev).not.toHaveProperty('email')
    expect(ev).not.toHaveProperty('device_id')
    expect(ev).not.toHaveProperty('auth')
    expect(ev).not.toHaveProperty('process')
  })

  it('returns null for empty / blank lines', () => {
    expect(parseTelemetryLine('')).toBeNull()
    expect(parseTelemetryLine('   ')).toBeNull()
  })

  it('returns null for malformed JSON', () => {
    expect(parseTelemetryLine('{bad json')).toBeNull()
  })

  it('returns null when event_data is missing', () => {
    expect(parseTelemetryLine(JSON.stringify({ event_type: 'ClaudeCodeInternalEvent' }))).toBeNull()
  })

  it('tolerates missing additional_metadata (defaults attempt=1, elapsed_ms=0)', () => {
    const line = JSON.stringify({
      event_type: 'ClaudeCodeInternalEvent',
      event_data: {
        event_name: 'tengu_api_slow_first_byte',
        client_timestamp: '2026-05-25T22:00:00Z',
        model: 'claude-sonnet-4-6',
        session_id: 'sess-x',
        betas: '',
        env: ENV,
        // no additional_metadata
      },
    })
    const ev = parseTelemetryLine(line)!
    expect(ev).not.toBeNull()
    expect(ev.attempt).toBe(1)
    expect(ev.elapsed_ms).toBe(0)
  })

  it('tolerates corrupted base64 in additional_metadata (defaults)', () => {
    const line = JSON.stringify({
      event_type: 'ClaudeCodeInternalEvent',
      event_data: {
        event_name: 'tengu_api_slow_first_byte',
        client_timestamp: '2026-05-25T22:00:00Z',
        model: 'claude-sonnet-4-6',
        session_id: 'sess-y',
        betas: '',
        env: ENV,
        additional_metadata: '!!!not-base64!!!',
      },
    })
    const ev = parseTelemetryLine(line)!
    expect(ev).not.toBeNull()
    expect(ev.attempt).toBe(1)
    expect(ev.elapsed_ms).toBe(0)
  })
})

describe('parseTelemetryDir', () => {
  it('skips telemetry files above the configured byte cap', () => {
    const dir = mkdtempSync(join(tmpdir(), 'parse-telemetry-test-'))
    try {
      writeFileSync(
        join(dir, '1p_failed_events.small.json'),
        `${makeLine('claude-sonnet-4-6', 1, 5000, 'small-session')}\n`,
      )
      writeFileSync(
        join(dir, '1p_failed_events.large.json'),
        `${makeLine('claude-opus-4-7[1m]', 5, 30001, 'large-session')}\n${'x'.repeat(16_384)}`,
      )

      const events = parseTelemetryDir(dir, { maxFileBytes: 8_192 })

      expect(events.map((event) => event.session_id)).toEqual(['small-session'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('caps telemetry artifact directory discovery', () => {
    const dir = mkdtempSync(join(tmpdir(), 'parse-telemetry-cap-'))
    try {
      writeFileSync(
        join(dir, '1p_failed_events.a.json'),
        `${makeLine('claude-sonnet-4-6', 1, 5000, 'session-a')}\n`,
      )
      writeFileSync(
        join(dir, '1p_failed_events.b.json'),
        `${makeLine('claude-sonnet-4-6', 1, 5000, 'session-b')}\n`,
      )

      const events = parseTelemetryDir(dir, { maxEntries: 1 })

      expect(events).toHaveLength(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('restricts the reliability path to slow-first-byte events, leaving tengu_exit to the latency reader (#3159)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'parse-telemetry-3159-'))
    try {
      writeFileSync(
        join(dir, '1p_failed_events.mixed.json'),
        [
          makeLine('claude-opus-4-8[1m]', 4, 30001, 'mixed-session'),
          makeExitLine('claude-opus-4-8[1m]', { last_session_api_duration: 12345 }, 'mixed-session'),
        ].join('\n'),
      )

      // Reliability sees only the one attempt-4 slow-first-byte failure; the
      // tengu_exit no longer dilutes totalEvents or depresses retryStormPct.
      const events = parseTelemetryDir(dir)
      expect(events).toHaveLength(1)
      expect(events[0].event_name).toBe('tengu_api_slow_first_byte')
      const reliability = analyzeReliability(events)
      expect(reliability.totalEvents).toBe(1)
      expect(reliability.totalStormEvents).toBe(1)
      expect(reliability.retryStormPct).toBe(100)

      // …while the separate latency reader still captures the tengu_exit sample.
      const latency = parseTelemetryLatencyDir(dir)
      expect(latency).toHaveLength(1)
      expect(latency[0].apiDurationMs).toBe(12345)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ---------- analyzeReliability ----------

/**
 * Reference mock from the prototype:
 *   opus:  attempts [3, 5, 6, 2, 4]  — 3 storms (>=4)
 *   haiku: attempts [6, 5, 6, 1]     — 3 storms
 *   sonnet: attempts [2]             — 0 storms
 *   Total 10 events, 6 storms → 60% storm rate.
 *   All elapsed_ms = 30001ms → wasted = 10 * 30001 = 300010ms.
 */
function buildProtoEvents(): TelemetryEvent[] {
  const SESSION = 'e4449e68-559e-4aab-9195-a4ffe3d19542'
  const cases: [string, number, number][] = [
    ['claude-opus-4-7[1m]', 3, 30001],
    ['claude-opus-4-7[1m]', 5, 30002],
    ['claude-opus-4-7[1m]', 6, 30001],
    ['claude-opus-4-7[1m]', 2, 30000],
    ['claude-opus-4-7[1m]', 4, 30001],
    ['claude-haiku-4-5-20251001', 6, 30001],
    ['claude-haiku-4-5-20251001', 5, 30001],
    ['claude-haiku-4-5-20251001', 6, 30002],
    ['claude-haiku-4-5-20251001', 1, 30000],
    ['claude-sonnet-4-6', 2, 30001],
  ]
  return cases.map(([model, attempt, elapsed_ms]) =>
    parseTelemetryLine(makeLine(model, attempt, elapsed_ms, SESSION))!,
  )
}

describe('analyzeReliability', () => {
  it('returns empty analysis for an empty events list', () => {
    const a = analyzeReliability([])
    expect(a.totalEvents).toBe(0)
    expect(a.totalStormEvents).toBe(0)
    expect(a.retryStormPct).toBe(0)
    expect(a.byModel).toHaveLength(0)
    expect(a.bySession).toHaveLength(0)
  })

  it('computes correct retry-storm rate (prototype: 60%)', () => {
    const a = analyzeReliability(buildProtoEvents())
    expect(a.totalEvents).toBe(10)
    expect(a.totalStormEvents).toBe(6) // attempts >=4: 5,6,4 (opus) + 6,5,6 (haiku)
    expect(a.retryStormPct).toBe(60)
  })

  it('computes correct total wasted wall-clock (sum of all elapsed_ms)', () => {
    const a = analyzeReliability(buildProtoEvents())
    // 30001+30002+30001+30000+30001 + 30001+30001+30002+30000+30001 = 300010
    expect(a.totalWastedMs).toBe(300010)
  })

  it('reports correct maxAttempt (prototype: 6)', () => {
    const a = analyzeReliability(buildProtoEvents())
    expect(a.maxAttempt).toBe(6)
  })

  it('builds an attempt histogram matching prototype distribution', () => {
    const a = analyzeReliability(buildProtoEvents())
    // attempts: 3,5,6,2,4 + 6,5,6,1 + 2 → {1:1, 2:2, 3:1, 4:1, 5:2, 6:3}
    expect(a.histogram[1]).toBe(1)
    expect(a.histogram[2]).toBe(2)
    expect(a.histogram[3]).toBe(1)
    expect(a.histogram[4]).toBe(1)
    expect(a.histogram[5]).toBe(2)
    expect(a.histogram[6]).toBe(3)
  })

  it('breaks down by model correctly', () => {
    const a = analyzeReliability(buildProtoEvents())
    const opus = a.byModel.find((m) => m.model === 'claude-opus-4-7[1m]')!
    expect(opus).toBeDefined()
    expect(opus.totalEvents).toBe(5)
    expect(opus.stormEvents).toBe(3) // attempts 5,6,4
    expect(opus.maxAttempt).toBe(6)

    const haiku = a.byModel.find((m) => m.model === 'claude-haiku-4-5-20251001')!
    expect(haiku).toBeDefined()
    expect(haiku.totalEvents).toBe(4)
    expect(haiku.stormEvents).toBe(3) // attempts 6,5,6

    const sonnet = a.byModel.find((m) => m.model === 'claude-sonnet-4-6')!
    expect(sonnet.stormEvents).toBe(0)
    expect(sonnet.retryStormPct).toBe(0)
  })

  it('provides per-session breakdown joinable on session_id', () => {
    const a = analyzeReliability(buildProtoEvents())
    expect(a.bySession).toHaveLength(1)
    const sess = a.bySession[0]
    expect(sess.session_id).toBe('e4449e68-559e-4aab-9195-a4ffe3d19542')
    expect(sess.totalEvents).toBe(10)
    expect(sess.retryStormPct).toBe(60)
    expect(sess.totalWastedMs).toBe(300010)
    expect(sess.maxAttempt).toBe(6)
  })

  it('splits per-session byModel correctly', () => {
    const a = analyzeReliability(buildProtoEvents())
    const sess = a.bySession[0]
    const opusSess = sess.byModel.find((m) => m.model === 'claude-opus-4-7[1m]')!
    expect(opusSess.totalEvents).toBe(5)
  })

  it('aggregates correctly across multiple sessions', () => {
    const SESSION_A = 'session-aaa'
    const SESSION_B = 'session-bbb'
    const eventsA = [
      parseTelemetryLine(makeLine('claude-opus-4-7[1m]', 5, 30001, SESSION_A))!,
      parseTelemetryLine(makeLine('claude-opus-4-7[1m]', 2, 30001, SESSION_A))!,
    ]
    const eventsB = [
      parseTelemetryLine(makeLine('claude-sonnet-4-6', 1, 5000, SESSION_B))!,
    ]
    const a = analyzeReliability([...eventsA, ...eventsB])
    expect(a.totalEvents).toBe(3)
    expect(a.totalStormEvents).toBe(1) // only the attempt=5
    expect(a.bySession).toHaveLength(2)
    const sessA = a.bySession.find((s) => s.session_id === SESSION_A)!
    const sessB = a.bySession.find((s) => s.session_id === SESSION_B)!
    expect(sessA.stormEvents).toBe(1)
    expect(sessB.stormEvents).toBe(0)
    expect(sessB.totalWastedMs).toBe(5000)
  })

  it('retry-storm threshold is exported as RETRY_STORM_THRESHOLD = 4', () => {
    expect(RETRY_STORM_THRESHOLD).toBe(4)
  })

  it('session byModel sorted by wastedMs descending', () => {
    const events = buildProtoEvents()
    const a = analyzeReliability(events)
    const sess = a.bySession[0]
    // haiku wastedMs: 30001+30001+30002+30000 = 120004
    // opus  wastedMs: 30001+30002+30001+30000+30001 = 150005
    // opus wasted > haiku wasted, so opus should be first
    expect(sess.byModel[0].model).toBe('claude-opus-4-7[1m]')
  })

  it('preserves env fingerprint from first event in session', () => {
    const a = analyzeReliability(buildProtoEvents())
    const sess = a.bySession[0]
    expect(sess.env.node_version).toBe('v24.3.0')
    expect(sess.env.terminal).toBe('windows-terminal')
    expect(sess.env.wsl_version).toBe('2')
    expect(sess.env.linux_distro_id).toBe('fedora')
  })
})

// ---------- Successful-turn per-model latency (#1166) ----------

/**
 * Build a raw NDJSON `tengu_exit` line shaped like the real artifact:
 * additional_metadata base64-encodes the last_session_* timing/token fields.
 */
function makeExitLine(
  model: string,
  meta: Record<string, unknown>,
  session_id = 'ba2fed12-674a-47b9-92d5-7fbf19118d16',
  client_timestamp = '2026-06-08T08:45:00.000Z',
): string {
  return JSON.stringify({
    event_type: 'ClaudeCodeInternalEvent',
    event_data: {
      event_name: 'tengu_exit',
      client_timestamp,
      model,
      session_id,
      additional_metadata: b64({ subscription_type: 'max', ...meta }),
      env: ENV,
    },
  })
}

describe('parseTelemetryLatencyLine', () => {
  it('captures successful-path per-model API duration from tengu_exit', () => {
    const s = parseTelemetryLatencyLine(
      makeExitLine('claude-opus-4-8[1m]', {
        last_session_api_duration: 17906,
        last_session_tool_duration: 2417,
        last_session_total_input_tokens: 12366,
        last_session_total_output_tokens: 931,
      }),
    )!
    expect(s).not.toBeNull()
    expect(s.model).toBe('claude-opus-4-8[1m]')
    expect(s.apiDurationMs).toBe(17906)
    expect(s.toolDurationMs).toBe(2417)
    expect(s.inputTokens).toBe(12366)
    expect(s.outputTokens).toBe(931)
    expect(s.session_id).toBe('ba2fed12-674a-47b9-92d5-7fbf19118d16')
  })

  it('does NOT count the 30s slow-first-byte timeout ceiling as latency', () => {
    // The exact failure-ceiling line the reliability path consumes must never
    // produce a latency sample.
    expect(parseTelemetryLatencyLine(makeLine('claude-opus-4-7[1m]', 3, 30001))).toBeNull()
  })

  it('drops a tengu_exit with zero/absent API duration (no fake 0ms latency)', () => {
    expect(
      parseTelemetryLatencyLine(
        makeExitLine('claude-opus-4-8[1m]', {
          last_session_api_duration: 0,
          last_session_duration: 60611,
        }),
      ),
    ).toBeNull()
    expect(parseTelemetryLatencyLine(makeExitLine('claude-opus-4-8[1m]', {}))).toBeNull()
  })

  it('ignores non-exit events and malformed lines', () => {
    expect(parseTelemetryLatencyLine('')).toBeNull()
    expect(parseTelemetryLatencyLine('{bad json')).toBeNull()
    expect(
      parseTelemetryLatencyLine(JSON.stringify({ event_type: 'ClaudeCodeInternalEvent' })),
    ).toBeNull()
  })

  it('clamps negative durations/tokens to zero but still requires positive api duration', () => {
    const s = parseTelemetryLatencyLine(
      makeExitLine('claude-sonnet-4-6', {
        last_session_api_duration: 5635,
        last_session_tool_duration: -1,
        last_session_total_output_tokens: -3,
      }),
    )!
    expect(s.apiDurationMs).toBe(5635)
    expect(s.toolDurationMs).toBe(0)
    expect(s.outputTokens).toBe(0)
  })
})

describe('aggregateModelLatency', () => {
  const samples: ModelLatencySample[] = [
    {
      session_id: 'a',
      model: 'claude-opus-4-8[1m]',
      apiDurationMs: 17906,
      toolDurationMs: 2417,
      inputTokens: 12366,
      outputTokens: 931,
      client_timestamp: '2026-06-08T08:45:00.000Z',
    },
    {
      session_id: 'b',
      model: 'claude-opus-4-8[1m]',
      apiDurationMs: 5635,
      toolDurationMs: 0,
      inputTokens: 12306,
      outputTokens: 365,
      client_timestamp: '2026-06-07T21:22:00.000Z',
    },
    {
      session_id: 'c',
      model: 'claude-sonnet-4-6',
      apiDurationMs: 4000,
      toolDurationMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      client_timestamp: '2026-06-06T08:51:00.000Z',
    },
  ]

  it('rolls up per model, sorted by total API duration descending', () => {
    const rows = aggregateModelLatency(samples)
    expect(rows.map((r) => r.model)).toEqual(['claude-opus-4-8[1m]', 'claude-sonnet-4-6'])
    const opus = rows[0]
    expect(opus.samples).toBe(2)
    expect(opus.totalApiDurationMs).toBe(23541)
    expect(opus.avgApiDurationMs).toBe(Math.round(23541 / 2))
    expect(opus.totalOutputTokens).toBe(1296)
    expect(opus.msPerOutputToken).toBeCloseTo(23541 / 1296)
  })

  it('returns null msPerOutputToken when no output tokens were recorded', () => {
    const sonnet = aggregateModelLatency(samples).find((r) => r.model === 'claude-sonnet-4-6')!
    expect(sonnet.msPerOutputToken).toBeNull()
  })

  it('returns an empty array for no samples', () => {
    expect(aggregateModelLatency([])).toEqual([])
  })
})

describe('parseTelemetryLatencyDir', () => {
  it('reads tengu_exit latency samples from 1p_failed_events files and skips ceilings', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tel-latency-'))
    try {
      const lines = [
        makeExitLine('claude-opus-4-8[1m]', {
          last_session_api_duration: 17906,
          last_session_total_output_tokens: 931,
        }),
        makeLine('claude-opus-4-7[1m]', 3, 30001), // slow_first_byte ceiling — must be ignored
        makeExitLine('claude-opus-4-8[1m]', { last_session_api_duration: 0 }), // dropped
      ].join('\n')
      writeFileSync(
        join(dir, '1p_failed_events.ba2fed12-674a-47b9-92d5-7fbf19118d16.x.json'),
        lines,
      )
      // A non-telemetry file in the same dir must be ignored.
      writeFileSync(
        join(dir, 'other.json'),
        makeExitLine('claude-sonnet-4-6', { last_session_api_duration: 9999 }),
      )
      const samples = parseTelemetryLatencyDir(dir)
      expect(samples).toHaveLength(1)
      expect(samples[0].apiDurationMs).toBe(17906)
      expect(samples[0].model).toBe('claude-opus-4-8[1m]')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('tolerates a missing directory', () => {
    expect(parseTelemetryLatencyDir(join(tmpdir(), 'does-not-exist-telemetry-xyz'))).toEqual([])
  })
})
