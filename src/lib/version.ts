// In-app version stamp (#646).
//
// The build bakes `__APP_VERSION__` via `define` in vite.config.ts. We read it
// defensively so this module is also importable under vitest (which has no
// `define`) — the pure formatters below are unit-tested without a build.

export interface VersionInfo {
  /** Semver from package.json, e.g. "0.1.0". */
  version: string
  /** Short commit SHA (7 chars), or "" when git was unavailable at build. */
  sha: string
  /** Tag name when built from a tagged commit (a real release), else "". */
  releaseTag: string
}

export const APP_VERSION: VersionInfo =
  typeof __APP_VERSION__ !== 'undefined'
    ? __APP_VERSION__
    : { version: '0.0.0', sha: '', releaseTag: '' }

/** True when this build was cut from a tagged commit (a published release). */
export function isRelease(info: VersionInfo): boolean {
  return info.releaseTag.length > 0
}

/**
 * Compact label for the UI. The shape answers the core question — "am I on a
 * release or a specific commit?" — at a glance:
 *   - release build  -> "v0.1.0"            (clean, tag-derived)
 *   - commit build   -> "v0.1.0+abc1234"    (the `+sha` flags it as untagged)
 *   - no git at all  -> "v0.1.0-dev"
 */
export function versionLabel(info: VersionInfo): string {
  if (isRelease(info)) return normalizeTag(info.releaseTag)
  if (info.sha) return `v${info.version}+${info.sha}`
  return `v${info.version}-dev`
}

/** Fuller, tooltip-ready description of exactly what this build is. */
export function versionTitle(info: VersionInfo): string {
  if (isRelease(info)) {
    const base = `Release ${normalizeTag(info.releaseTag)}`
    return info.sha ? `${base} (commit ${info.sha})` : base
  }
  if (info.sha) {
    return `Built from commit ${info.sha} — v${info.version}, not a tagged release`
  }
  return `Local/dev build — v${info.version}`
}

/** Ensure a single leading "v" so "0.1.0" and "v0.1.0" render consistently. */
function normalizeTag(tag: string): string {
  return tag.startsWith('v') ? tag : `v${tag}`
}
