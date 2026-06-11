import { describe, it, expect } from 'vitest'
import { isRelease, versionLabel, versionTitle } from './version'

describe('version formatting (#646)', () => {
  const release = { version: '0.1.0', sha: 'abc1234', releaseTag: 'v0.1.0' }
  const commit = { version: '0.1.0', sha: 'abc1234', releaseTag: '' }
  const dev = { version: '0.1.0', sha: '', releaseTag: '' }

  it('detects a release vs a commit build', () => {
    expect(isRelease(release)).toBe(true)
    expect(isRelease(commit)).toBe(false)
    expect(isRelease(dev)).toBe(false)
  })

  it('labels a tagged release with the clean tag', () => {
    expect(versionLabel(release)).toBe('v0.1.0')
  })

  it('flags an untagged commit build with +sha', () => {
    expect(versionLabel(commit)).toBe('v0.1.0+abc1234')
  })

  it('marks a build with no git as -dev', () => {
    expect(versionLabel(dev)).toBe('v0.1.0-dev')
  })

  it('normalizes a tag that lacks a leading v', () => {
    expect(versionLabel({ ...release, releaseTag: '0.1.0' })).toBe('v0.1.0')
  })

  it('describes each build kind in the tooltip', () => {
    expect(versionTitle(release)).toBe('Release v0.1.0 (commit abc1234)')
    expect(versionTitle(commit)).toBe(
      'Built from commit abc1234 — v0.1.0, not a tagged release'
    )
    expect(versionTitle(dev)).toBe('Local/dev build — v0.1.0')
  })
})
