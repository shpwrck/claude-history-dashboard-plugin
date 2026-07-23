/**
 * Plugin-channel version-sync guard (#2950).
 *
 * `package.json` is the single source of truth for the dashboard version. The
 * committed plugin manifest (`.claude-plugin/plugin.json`) must match it, and
 * the payload assembler stamps that version into the published payload so a
 * consumer can never be misled about which engine they are running. This test
 * makes source skew CI-fatal (the payload stamp is proven end-to-end by
 * scripts/plugin-mcp-payload.test.mjs).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const readRepoJson = (rel: string): { version?: unknown } =>
  JSON.parse(readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8'));

describe('plugin version sync (#2950)', () => {
  const pkgVersion = readRepoJson('package.json').version;

  it('package.json declares a semver-ish version string', () => {
    expect(typeof pkgVersion).toBe('string');
    expect(pkgVersion).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('the committed .claude-plugin/plugin.json version matches package.json', () => {
    const manifestVersion = readRepoJson('.claude-plugin/plugin.json').version;
    expect(manifestVersion).toBe(pkgVersion);
  });
});
