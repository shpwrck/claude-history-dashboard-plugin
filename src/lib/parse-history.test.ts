import { describe, it, expect } from 'vitest'
import {
  parseHistoryJsonl,
  groupBySessions,
  groupByProjects,
  groupWorktrees,
  deriveEntriesFromTranscript,
  unionEntries,
} from './parse-history'
import type { HistoryEntry, ProjectStats, Session } from '../types'

const entry = (o: Partial<HistoryEntry>): HistoryEntry => ({
  display: 'a message',
  pastedContents: {},
  timestamp: 0,
  project: '/home/u/proj',
  sessionId: 's1',
  ...o,
})

describe('parseHistoryJsonl', () => {
  it('parses one entry per line and skips blank lines', () => {
    const text = [
      JSON.stringify(entry({ sessionId: 's1', timestamp: 1 })),
      '',
      JSON.stringify(entry({ sessionId: 's2', timestamp: 2 })),
    ].join('\n')
    const out = parseHistoryJsonl(text)
    expect(out).toHaveLength(2)
    expect(out.map((e) => e.sessionId)).toEqual(['s1', 's2'])
  })

  it('trims surrounding whitespace before splitting', () => {
    const text = `\n${JSON.stringify(entry({}))}\n`
    expect(parseHistoryJsonl(text)).toHaveLength(1)
  })
})

describe('groupBySessions', () => {
  it('groups entries by sessionId and sorts entries chronologically', () => {
    const entries = [
      entry({ sessionId: 's1', timestamp: 30 }),
      entry({ sessionId: 's1', timestamp: 10 }),
      entry({ sessionId: 's1', timestamp: 20 }),
    ]
    const [session] = groupBySessions(entries)
    expect(session.entries.map((e) => e.timestamp)).toEqual([10, 20, 30])
    expect(session.startTime).toBe(10)
    expect(session.endTime).toBe(30)
    expect(session.duration).toBe(20)
  })

  it('excludes init/exit entries from messageCount', () => {
    const entries = [
      entry({ sessionId: 's1', display: 'init', timestamp: 1 }),
      entry({ sessionId: 's1', display: 'real message', timestamp: 2 }),
      entry({ sessionId: 's1', display: 'exit', timestamp: 3 }),
    ]
    const [session] = groupBySessions(entries)
    expect(session.messageCount).toBe(1)
    expect(session.entries).toHaveLength(3)
  })

  it('sorts sessions by most-recent endTime first', () => {
    const entries = [
      entry({ sessionId: 'old', timestamp: 10 }),
      entry({ sessionId: 'new', timestamp: 100 }),
    ]
    expect(groupBySessions(entries).map((s) => s.sessionId)).toEqual(['new', 'old'])
  })

  it('preserves source provenance on grouped sessions', () => {
    const [session] = groupBySessions([
      entry({
        sessionId: 's1',
        sourceId: 'claude-code',
        harness: 'claude-code',
      }),
    ])

    expect(session.sourceId).toBe('claude-code')
    expect(session.harness).toBe('claude-code')
  })
})

describe('groupByProjects', () => {
  it('aggregates message counts across a project and sorts by messageCount desc', () => {
    const sessions = groupBySessions([
      entry({ project: '/home/u/quiet', sessionId: 'a', timestamp: 1 }),
      entry({ project: '/home/u/busy', sessionId: 'b', timestamp: 1 }),
      entry({ project: '/home/u/busy', sessionId: 'b', timestamp: 2 }),
      entry({ project: '/home/u/busy', sessionId: 'c', timestamp: 3 }),
    ])
    const projects = groupByProjects(sessions)
    expect(projects.map((p) => p.project)).toEqual(['/home/u/busy', '/home/u/quiet'])
    const busy = projects[0]
    expect(busy.sessionCount).toBe(2)
    expect(busy.messageCount).toBe(3)
  })
})

describe('groupWorktrees', () => {
  const stat = (project: string, messageCount: number): ProjectStats => ({
    project,
    projectShort: project,
    sessionCount: 1,
    messageCount,
    firstSeen: 0,
    lastSeen: 1,
    sessions: [] as Session[],
  })

  it('folds worktree checkouts under their parent repo with rolled-up totals', () => {
    const groups = groupWorktrees([
      stat('/home/u/repo', 5),
      stat('/home/u/repo/.claude/worktrees/feature-x/sub', 3),
    ])
    expect(groups).toHaveLength(1)
    const g = groups[0]
    expect(g.repo).toBe('/home/u/repo')
    expect(g.messageCount).toBe(8)
    expect(g.sessionCount).toBe(2)
    // Main checkout sorts first, worktree follows.
    expect(g.worktrees.map((w) => w.branch)).toEqual(['main', 'feature-x'])
  })

  it('keeps marker-less projects as their own single-child group labelled main', () => {
    const groups = groupWorktrees([stat('/home/u/solo', 4)])
    expect(groups).toHaveLength(1)
    expect(groups[0].worktrees[0].branch).toBe('main')
  })

  it('keeps same-named repos in different base dirs as distinct groups', () => {
    const groups = groupWorktrees([
      stat('/home/u/project/x', 1),
      stat('/home/u/src/x', 1),
    ])
    expect(groups).toHaveLength(2)
  })
})

describe('deriveEntriesFromTranscript', () => {
  const line = (o: object) => JSON.stringify(o)

  it('derives a history-style entry from a top-level user turn, project from cwd', () => {
    const text = [
      line({
        type: 'user',
        timestamp: '2026-01-01T00:00:00.000Z',
        cwd: '/home/u/real-proj',
        message: { role: 'user', content: 'do the thing' },
      }),
    ].join('\n')
    const entries = deriveEntriesFromTranscript(text, 'sess-1', '/fallback')
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      display: 'do the thing',
      project: '/home/u/real-proj',
      sessionId: 'sess-1',
      timestamp: Date.parse('2026-01-01T00:00:00.000Z'),
    })
  })

  it('falls back to the path-derived project when the turn has no cwd (the #399 fix)', () => {
    const text = line({
      type: 'user',
      message: { role: 'user', content: 'automation prompt' },
    })
    const entries = deriveEntriesFromTranscript(text, 'sdk-sess', '/home/u/proj')
    expect(entries).toHaveLength(1)
    expect(entries[0].project).toBe('/home/u/proj')
  })

  it('flattens text-block array content and attaches the title when given', () => {
    const text = line({
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'first' },
          { type: 'image' },
          { type: 'text', text: 'second' },
        ],
      },
    })
    const entries = deriveEntriesFromTranscript(text, 's', '/p', 'My Title')
    expect(entries[0].display).toBe('first\nsecond')
    expect(entries[0].title).toBe('My Title')
  })

  it('skips meta, sidechain, non-user, and tool_result-only turns', () => {
    const text = [
      line({ type: 'user', isMeta: true, message: { content: 'meta' } }),
      line({ type: 'user', isSidechain: true, message: { content: 'sidechain' } }),
      line({ type: 'assistant', message: { role: 'assistant', content: 'hi' } }),
      line({ type: 'user', message: { role: 'user', content: '   ' } }),
      line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'x' }] } }),
      'not json',
    ].join('\n')
    expect(deriveEntriesFromTranscript(text, 's', '/p')).toHaveLength(0)
  })
})

describe('unionEntries', () => {
  it('lets transcript-derived entries win over history for the same session', () => {
    const history = [entry({ sessionId: 'dup', project: '_unknown', display: 'from-history' })]
    const transcript = [entry({ sessionId: 'dup', project: '/real', display: 'from-transcript' })]
    const merged = unionEntries(history, transcript)
    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({ project: '/real', display: 'from-transcript' })
  })

  it('keeps history entries for sessions that have no transcript', () => {
    const history = [entry({ sessionId: 'h-only', project: '/h' })]
    const transcript = [entry({ sessionId: 't-only', project: '/t' })]
    const merged = unionEntries(history, transcript)
    expect(merged.map((e) => e.sessionId).sort()).toEqual(['h-only', 't-only'])
  })

  it('can suppress history for transcript files that produce no entries', () => {
    const history = [
      entry({ sessionId: 'transcript-with-no-entries', project: '/h' }),
      entry({ sessionId: 'h-only', project: '/h' }),
    ]
    const transcript = [entry({ sessionId: 't-only', project: '/t' })]
    const merged = unionEntries(history, transcript, [
      't-only',
      'transcript-with-no-entries',
    ])
    expect(merged.map((e) => e.sessionId).sort()).toEqual(['h-only', 't-only'])
  })
})
