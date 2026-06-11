import { describe, it, expect } from 'vitest'
import {
  aggregateFiles,
  aggregateDirs,
  readOnlyFiles,
  topChurnFiles,
  redundantReads,
} from './parse-files'
import type { ToolCall, ToolUsageData } from './parse-tools'
import type { SessionTokenData } from '../types'

const call = (toolName: string, filePath: string, timestamp = 't'): ToolCall => ({
  timestamp,
  toolName,
  input: { file_path: filePath },
  toolUseId: 'u',
  isError: null,
  resultBytes: 0,
})

const session = (sessionId: string, calls: ToolCall[]): ToolUsageData => ({ sessionId, calls })

describe('aggregateFiles', () => {
  it('tallies reads/edits/writes per file, tracks lastTouched, sorts by total desc', () => {
    const data = [
      session('s', [
        call('Read', '/a.ts', '2026-01-01'),
        call('Edit', '/a.ts', '2026-01-03'),
        call('Read', '/a.ts', '2026-01-02'),
        call('Write', '/b.ts', '2026-01-01'),
      ]),
    ]
    const files = aggregateFiles(data)
    expect(files[0]).toMatchObject({ filePath: '/a.ts', reads: 2, edits: 1, writes: 0, total: 3, lastTouched: '2026-01-03' })
    expect(files[1]).toMatchObject({ filePath: '/b.ts', writes: 1, total: 1 })
  })

  it('ignores non-file tools and calls without a file_path', () => {
    const data = [
      session('s', [
        call('Bash', ''), // no file_path → skipped
        { ...call('Read', '/real.ts') },
      ]),
    ]
    const files = aggregateFiles(data)
    expect(files).toHaveLength(1)
    expect(files[0].filePath).toBe('/real.ts')
  })

  it('counts MultiEdit and NotebookEdit as edits', () => {
    const data = [session('s', [call('MultiEdit', '/a.ts'), call('NotebookEdit', '/a.ts')])]
    expect(aggregateFiles(data)[0].edits).toBe(2)
  })
})

describe('aggregateDirs', () => {
  it('rolls files up by directory and sorts by total ops', () => {
    const files = aggregateFiles([
      session('s', [
        call('Read', '/src/a.ts'),
        call('Edit', '/src/a.ts'),
        call('Read', '/src/b.ts'),
        call('Read', '/docs/c.md'),
      ]),
    ])
    const dirs = aggregateDirs(files)
    expect(dirs[0]).toMatchObject({ dir: '/src', fileCount: 2, totalOps: 3 })
    expect(dirs[1]).toMatchObject({ dir: '/docs', fileCount: 1, totalOps: 1 })
  })

  it('labels a path with no slash as the "." directory', () => {
    const files = aggregateFiles([session('s', [call('Read', 'top.ts')])])
    expect(aggregateDirs(files)[0].dir).toBe('.')
  })
})

describe('readOnlyFiles', () => {
  it('keeps only files that were read and never mutated', () => {
    const files = aggregateFiles([
      session('s', [call('Read', '/ro.ts'), call('Read', '/rw.ts'), call('Edit', '/rw.ts')]),
    ])
    expect(readOnlyFiles(files).map((f) => f.filePath)).toEqual(['/ro.ts'])
  })
})

describe('topChurnFiles', () => {
  it('ranks by mutating ops (edits+writes), excluding reads, with session counts', () => {
    const data = [
      session('s1', [call('Read', '/a.ts'), call('Edit', '/a.ts'), call('Edit', '/a.ts')]),
      session('s2', [call('Edit', '/a.ts'), call('Write', '/b.ts')]),
    ]
    const churn = topChurnFiles(data)
    const a = churn.find((c) => c.filePath === '/a.ts')!
    expect(a).toMatchObject({ churn: 3, edits: 3, writes: 0, sessions: 2 })
    expect(a.editsPerSession).toBeCloseTo(1.5)
    // /a.ts (churn 3) ranks above /b.ts (churn 1)
    expect(churn[0].filePath).toBe('/a.ts')
  })
})

describe('redundantReads', () => {
  it('flags files read >= minReads within one session and cross-links compactions', () => {
    const data = [session('sess1', [call('Read', '/big.md'), call('Read', '/big.md'), call('Read', '/big.md')])]
    const tokenData = [
      { sessionId: 'sess1', compactionEvents: [{}, {}] } as unknown as SessionTokenData,
    ]
    const out = redundantReads(data, tokenData)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ sessionId: 'sess1', filePath: '/big.md', reads: 3, compactions: 2 })
    expect(out[0].hint).toMatch(/Compaction/)
  })

  it('does not flag files read fewer than minReads times', () => {
    const data = [session('s', [call('Read', '/a.ts'), call('Read', '/a.ts')])]
    expect(redundantReads(data)).toHaveLength(0)
  })

  it('uses the no-compaction hint when the session never compacted', () => {
    const data = [session('s', [call('Read', '/a.ts'), call('Read', '/a.ts'), call('Read', '/a.ts')])]
    expect(redundantReads(data)[0].hint).toMatch(/Re-read repeatedly/)
  })
})
