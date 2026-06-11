import { describe, it, expect } from 'vitest'
import {
  clusterTimelinesByShape,
  describeSignature,
  analyzeHabitImpact,
  computeSessionOutcomes,
  type TimelineShapeSignature,
  type SessionOutcomeTag,
} from './parse-timeline-success'
import type { SessionTimeline, TimelineEntry } from './parse-timeline'
import type { SessionTokenData } from '../types'
import type { ToolUsageData, ToolCall } from './parse-tools'
import type { ApiErrorEvent } from './parse-errors'

// --- Fixture builders -------------------------------------------------------
// The parser only reads a handful of fields off each shape, so we build minimal
// objects and cast. Timestamps drive rhythm/duration; tool calls drive density,
// error-rate, reuse; token entries drive cost; compactionEvents drive the
// compaction flag.

const userEntry = (ts: string): TimelineEntry => ({
  timestamp: ts,
  kind: 'user',
  summary: '',
})

function timeline(
  sessionId: string,
  userTimestamps: string[],
  startTime: string,
  endTime: string
): SessionTimeline {
  return {
    sessionId,
    startTime,
    endTime,
    entries: userTimestamps.map(userEntry),
  } as SessionTimeline
}

function toolCall(name: string, opts: Partial<ToolCall> = {}): ToolCall {
  return {
    timestamp: '2026-01-01T00:00:00Z',
    toolName: name,
    input: {},
    toolUseId: 'id',
    isError: null,
    resultBytes: 0,
    ...opts,
  }
}

function toolData(sessionId: string, calls: ToolCall[]): ToolUsageData {
  return { sessionId, calls }
}

function tokenData(sessionId: string, hasCompaction: boolean): SessionTokenData {
  return {
    sessionId,
    entries: [],
    compactionEvents: hasCompaction ? [{} as never] : [],
  } as unknown as SessionTokenData
}

const apiError = (sessionId: string): ApiErrorEvent =>
  ({ sessionId }) as unknown as ApiErrorEvent

/** Pull the (single) cluster matching a signature key out of the result. */
function clusterFor(
  clusters: ReturnType<typeof clusterTimelinesByShape>,
  key: string
) {
  return clusters.find((c) => c.key === key)
}

// --- Signature derivation ---------------------------------------------------

describe('clusterTimelinesByShape — signature derivation', () => {
  it('derives rapid / heavy / repeated / compacted / <15m from session shape', () => {
    // Three user turns 10s apart → meanGap = 10s ≤ 20 → rapid.
    // 9 tool calls / 3 turns = 3.0 toolsPerTurn ≥ 3 → heavy.
    // 3 api errors → repeated. compaction present. 5 min span → <15m.
    const tl = timeline(
      's1',
      [
        '2026-01-01T00:00:00Z',
        '2026-01-01T00:00:10Z',
        '2026-01-01T00:00:20Z',
      ],
      '2026-01-01T00:00:00Z',
      '2026-01-01T00:05:00Z'
    )
    const tools = toolData('s1', Array.from({ length: 9 }, () => toolCall('Read')))
    const clusters = clusterTimelinesByShape(
      [tl],
      [tokenData('s1', true)],
      [tools],
      [apiError('s1'), apiError('s1'), apiError('s1')]
    )
    expect(clusters).toHaveLength(1)
    expect(clusters[0].signature).toEqual<TimelineShapeSignature>({
      rhythm: 'rapid',
      toolDensity: 'heavy',
      errorSpike: 'repeated',
      hasCompaction: true,
      duration: '<15m',
    })
    expect(clusters[0].key).toBe('rapid|heavy|repeated|compacted|<15m')
  })

  it('derives sparse / light / none / no-compaction / 60-180m from session shape', () => {
    // Two user turns 120s apart → meanGap = 120s ≥ 90 → sparse.
    // 0 tool calls / 2 turns = 0 < 0.5 → light. No errors → none.
    // No compaction. 90 min span → 60-180m.
    const tl = timeline(
      's2',
      ['2026-01-01T00:00:00Z', '2026-01-01T00:02:00Z'],
      '2026-01-01T00:00:00Z',
      '2026-01-01T01:30:00Z'
    )
    const clusters = clusterTimelinesByShape(
      [tl],
      [tokenData('s2', false)],
      [toolData('s2', [])],
      []
    )
    expect(clusters[0].signature).toEqual<TimelineShapeSignature>({
      rhythm: 'sparse',
      toolDensity: 'light',
      errorSpike: 'none',
      hasCompaction: false,
      duration: '60-180m',
    })
    expect(clusters[0].key).toBe('sparse|light|none|no-compact|60-180m')
  })

  it('treats a single-user-turn session as sustained regardless of gaps', () => {
    // userTurns < 2 → sustained branch taken before any gap math.
    // 2 tool calls / 1 turn = 2.0 → medium. 1 tool error → sporadic.
    // 30 min span → 15-60m.
    const tl = timeline(
      's3',
      ['2026-01-01T00:00:00Z'],
      '2026-01-01T00:00:00Z',
      '2026-01-01T00:30:00Z'
    )
    const tools = toolData('s3', [
      toolCall('Bash', { isError: true }),
      toolCall('Bash'),
    ])
    const clusters = clusterTimelinesByShape(
      [tl],
      [tokenData('s3', false)],
      [tools],
      []
    )
    expect(clusters[0].signature).toMatchObject({
      rhythm: 'sustained',
      toolDensity: 'medium',
      errorSpike: 'sporadic',
      duration: '15-60m',
    })
  })

  it('counts tool errors and api errors together toward the error spike bucket', () => {
    // 1 tool error + 2 api errors = 3 total → repeated.
    const tl = timeline(
      's4',
      ['2026-01-01T00:00:00Z', '2026-01-01T00:00:30Z'],
      '2026-01-01T00:00:00Z',
      '2026-01-01T00:10:00Z'
    )
    const tools = toolData('s4', [toolCall('Read', { isError: true })])
    const clusters = clusterTimelinesByShape(
      [tl],
      [tokenData('s4', false)],
      [tools],
      [apiError('s4'), apiError('s4')]
    )
    expect(clusters[0].signature.errorSpike).toBe('repeated')
    // errorRate is tool-error-only: 1 error / 1 call = 1.
    expect(clusters[0].meanErrorRate).toBe(1)
  })
})

// --- Clustering -------------------------------------------------------------

describe('clusterTimelinesByShape — grouping', () => {
  it('groups two sessions with the same shape into one cluster', () => {
    const mk = (id: string): SessionTimeline =>
      timeline(
        id,
        ['2026-01-01T00:00:00Z', '2026-01-01T00:00:10Z'],
        '2026-01-01T00:00:00Z',
        '2026-01-01T00:05:00Z'
      )
    const clusters = clusterTimelinesByShape(
      [mk('a'), mk('b')],
      [tokenData('a', false), tokenData('b', false)],
      [toolData('a', []), toolData('b', [])],
      []
    )
    expect(clusters).toHaveLength(1)
    expect(clusters[0].sessionCount).toBe(2)
    expect(clusters[0].examples.map((e) => e.sessionId).sort()).toEqual(['a', 'b'])
  })

  it('keeps sessions with different shapes in separate clusters', () => {
    // Same rhythm/density but one compacts and one does not → distinct keys.
    const mk = (id: string): SessionTimeline =>
      timeline(
        id,
        ['2026-01-01T00:00:00Z', '2026-01-01T00:00:10Z'],
        '2026-01-01T00:00:00Z',
        '2026-01-01T00:05:00Z'
      )
    const clusters = clusterTimelinesByShape(
      [mk('a'), mk('b')],
      [tokenData('a', true), tokenData('b', false)],
      [toolData('a', []), toolData('b', [])],
      []
    )
    expect(clusters).toHaveLength(2)
    expect(clusterFor(clusters, 'rapid|light|none|compacted|<15m')!.sessionCount).toBe(1)
    expect(clusterFor(clusters, 'rapid|light|none|no-compact|<15m')!.sessionCount).toBe(1)
  })

  it('ranks the lower-error / no-compaction cluster above the higher one', () => {
    // Cluster "clean": no errors, no compaction.
    // Cluster "messy": repeated errors + compaction.
    // With error/compaction the only varying axes, clean should score higher.
    const clean = timeline(
      'clean',
      ['2026-01-01T00:00:00Z', '2026-01-01T00:00:10Z'],
      '2026-01-01T00:00:00Z',
      '2026-01-01T00:05:00Z'
    )
    const messy = timeline(
      'messy',
      ['2026-01-01T00:00:00Z', '2026-01-01T00:00:10Z'],
      '2026-01-01T00:00:00Z',
      '2026-01-01T00:05:00Z'
    )
    const messyTools = toolData('messy', [
      toolCall('Read', { isError: true }),
      toolCall('Read', { isError: true }),
      toolCall('Read', { isError: true }),
    ])
    const clusters = clusterTimelinesByShape(
      [clean, messy],
      [tokenData('clean', false), tokenData('messy', true)],
      [toolData('clean', []), messyTools],
      []
    )
    expect(clusters).toHaveLength(2)
    expect(clusters[0].examples[0].sessionId).toBe('clean')
    expect(clusters[0].goodOutcomeScore).toBeGreaterThan(clusters[1].goodOutcomeScore)
    expect(clusters[1].examples[0].sessionId).toBe('messy')
  })

  it('computes mean tool-reuse rate: repeated identical calls count as reused', () => {
    // 4 calls, 3 of them the same Bash command (count ≥ 2 → all 3 reused).
    const tl = timeline(
      'r',
      ['2026-01-01T00:00:00Z', '2026-01-01T00:00:10Z'],
      '2026-01-01T00:00:00Z',
      '2026-01-01T00:05:00Z'
    )
    const tools = toolData('r', [
      toolCall('Bash', { input: { command: 'ls' } }),
      toolCall('Bash', { input: { command: 'ls' } }),
      toolCall('Bash', { input: { command: 'ls' } }),
      toolCall('Bash', { input: { command: 'pwd' } }),
    ])
    const clusters = clusterTimelinesByShape(
      [tl],
      [tokenData('r', false)],
      [tools],
      []
    )
    expect(clusters[0].meanToolReuseRate).toBe(3 / 4)
  })
})

// --- describeSignature ------------------------------------------------------

describe('describeSignature', () => {
  it('renders each bucket to its human phrase, comma-joined', () => {
    const sig: TimelineShapeSignature = {
      rhythm: 'rapid',
      toolDensity: 'heavy',
      errorSpike: 'repeated',
      hasCompaction: true,
      duration: '<15m',
    }
    expect(describeSignature(sig)).toBe(
      'rapid turns, heavy tool use, repeated errors, compacted, <15m'
    )
  })

  it('renders the sparse / light / sporadic / no-compaction variants', () => {
    const sig: TimelineShapeSignature = {
      rhythm: 'sparse',
      toolDensity: 'light',
      errorSpike: 'sporadic',
      hasCompaction: false,
      duration: '60-180m',
    }
    expect(describeSignature(sig)).toBe(
      'sparse turns, light tool use, sporadic errors, no compaction, 60-180m'
    )
  })

  it('renders the sustained / medium / none defaults', () => {
    const sig: TimelineShapeSignature = {
      rhythm: 'sustained',
      toolDensity: 'medium',
      errorSpike: 'none',
      hasCompaction: false,
      duration: '>180m',
    }
    expect(describeSignature(sig)).toBe(
      'sustained pace, medium tool use, no errors, no compaction, >180m'
    )
  })
})

// --- analyzeHabitImpact (#323) ----------------------------------------------

describe('analyzeHabitImpact — per-factor split', () => {
  // All sessions share a rapid, tool-light, <15m shape so only the factor under
  // test splits; the others land entirely on one side and are suppressed.
  const rapid = (id: string): SessionTimeline =>
    timeline(
      id,
      ['2026-01-01T00:00:00Z', '2026-01-01T00:00:10Z'],
      '2026-01-01T00:00:00Z',
      '2026-01-01T00:05:00Z'
    )
  const tagMap = (entries: Record<string, SessionOutcomeTag>) =>
    new Map<string, SessionOutcomeTag>(Object.entries(entries))

  it('isolates the compaction factor and calls it "helps" when the compacted side wins', () => {
    const ids = ['c1', 'c2', 'c3', 'n1', 'n2', 'n3']
    const timelines = ids.map(rapid)
    const tokens = [
      tokenData('c1', true),
      tokenData('c2', true),
      tokenData('c3', true),
      tokenData('n1', false),
      tokenData('n2', false),
      tokenData('n3', false),
    ]
    const tools = ids.map((id) => toolData(id, []))
    // Compacted sessions tagged good, non-compacted tagged bad.
    const tags = tagMap({
      c1: 'good', c2: 'good', c3: 'good',
      n1: 'bad', n2: 'bad', n3: 'bad',
    })

    const report = analyzeHabitImpact(timelines, tokens, tools, [], tags)
    const compaction = report.factors.find((f) => f.key === 'compaction')
    expect(compaction).toBeDefined()
    expect(compaction!.high.label).toBe('compacted')
    expect(compaction!.high.sessionCount).toBe(3)
    expect(compaction!.high.goodRate).toBe(1)
    expect(compaction!.low.goodRate).toBe(0)
    expect(compaction!.verdict).toBe('helps')
    expect(report.labelledCount).toBe(6)
    expect(report.proxyCount).toBe(0)
    // No tools anywhere → tool-errors/density/repetition factors are suppressed.
    expect(report.factors.map((f) => f.key)).toEqual(['compaction'])
  })

  it('suppresses a factor when either side has fewer than 3 sessions', () => {
    const ids = ['c1', 'c2', 'n1', 'n2', 'n3']
    const timelines = ids.map(rapid)
    const tokens = [
      tokenData('c1', true),
      tokenData('c2', true), // only 2 compacted → high side < 3
      tokenData('n1', false),
      tokenData('n2', false),
      tokenData('n3', false),
    ]
    const tools = ids.map((id) => toolData(id, []))
    const report = analyzeHabitImpact(timelines, tokens, tools, [], new Map())
    expect(report.factors.find((f) => f.key === 'compaction')).toBeUndefined()
  })

  it('falls back to the cost+cleanliness proxy for untagged sessions', () => {
    const ids = ['c1', 'c2', 'c3', 'n1', 'n2', 'n3']
    const timelines = ids.map(rapid)
    const tokens = ids.map((id) => tokenData(id, id.startsWith('c')))
    const tools = ids.map((id) => toolData(id, []))
    // No tags at all → every session is proxy-anchored.
    const report = analyzeHabitImpact(timelines, tokens, tools, [], new Map())
    expect(report.labelledCount).toBe(0)
    expect(report.proxyCount).toBe(6)
  })

  it('isolates tool errors and calls it "hurts" when the error side loses', () => {
    const ids = ['e1', 'e2', 'e3', 'k1', 'k2', 'k3']
    const timelines = ids.map(rapid)
    const tokens = ids.map((id) => tokenData(id, false))
    // Each session runs 2 tool calls (medium density, suppressed); the "e" set
    // has one erroring call, the "k" set is clean.
    const tools = ids.map((id) =>
      toolData(
        id,
        id.startsWith('e')
          ? [toolCall('Read', { isError: true }), toolCall('Read')]
          : [toolCall('Read'), toolCall('Read')]
      )
    )
    const tags = tagMap({
      e1: 'bad', e2: 'bad', e3: 'bad',
      k1: 'good', k2: 'good', k3: 'good',
    })
    const report = analyzeHabitImpact(timelines, tokens, tools, [], tags)
    const errs = report.factors.find((f) => f.key === 'tool-errors')
    expect(errs).toBeDefined()
    expect(errs!.high.label).toBe('with tool errors')
    expect(errs!.high.goodRate).toBe(0)
    expect(errs!.low.goodRate).toBe(1)
    expect(errs!.verdict).toBe('hurts')
  })
})

describe('computeSessionOutcomes — per-session good/bad map (#739)', () => {
  // Same rapid, <15m shape used by the habit-impact tests so only the outcome
  // anchoring is under test here.
  const rapid = (id: string): SessionTimeline =>
    timeline(
      id,
      ['2026-01-01T00:00:00Z', '2026-01-01T00:00:10Z'],
      '2026-01-01T00:00:00Z',
      '2026-01-01T00:05:00Z'
    )

  it('takes user good/bad labels at face value (anchor: label)', () => {
    const ids = ['g1', 'b1']
    const timelines = ids.map(rapid)
    const tokens = ids.map((id) => tokenData(id, false))
    const tools = ids.map((id) => toolData(id, []))
    const tags = new Map<string, SessionOutcomeTag>([
      ['g1', 'good'],
      ['b1', 'bad'],
    ])
    const out = computeSessionOutcomes(timelines, tokens, tools, [], tags)
    expect(out.get('g1')).toEqual({ good: true, anchor: 'label' })
    expect(out.get('b1')).toEqual({ good: false, anchor: 'label' })
  })

  it('falls back to the cost+cleanliness proxy for untagged sessions', () => {
    // Two clean (no-compaction) sessions and one compacted, error-prone one; the
    // proxy should call the clean ones good and the costly compacted one bad,
    // all anchored 'proxy' since no labels are supplied (the server-side case).
    const ids = ['p1', 'p2', 'p3']
    const timelines = ids.map(rapid)
    const tokens = [
      tokenData('p1', false),
      tokenData('p2', false),
      tokenData('p3', true), // compacted -> loses a proxy point
    ]
    const tools = [
      toolData('p1', [toolCall('Read'), toolCall('Read')]),
      toolData('p2', [toolCall('Read'), toolCall('Read')]),
      toolData('p3', [toolCall('Read', { isError: true }), toolCall('Read')]),
    ]
    const out = computeSessionOutcomes(timelines, tokens, tools, [], new Map())
    expect(out.get('p1')).toEqual({ good: true, anchor: 'proxy' })
    expect(out.get('p2')).toEqual({ good: true, anchor: 'proxy' })
    expect(out.get('p3')!.anchor).toBe('proxy')
    expect(out.get('p3')!.good).toBe(false)
  })

  it('returns an entry for every timeline session', () => {
    const ids = ['s1', 's2', 's3']
    const out = computeSessionOutcomes(
      ids.map(rapid),
      ids.map((id) => tokenData(id, false)),
      ids.map((id) => toolData(id, [])),
      [],
      new Map()
    )
    expect([...out.keys()].sort()).toEqual(ids)
  })
})
