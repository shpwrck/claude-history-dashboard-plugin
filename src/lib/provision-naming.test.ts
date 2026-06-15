import { describe, it, expect } from 'vitest';
import {
  parseGitHubRepo,
  rfc1123Slug,
  remoteSessionName,
  envNameFor,
} from './provision-naming';
// The server-side mirror (zero-dep, the authority that writes metadata.name). This test is the
// load-bearing DRIFT GUARD: the TS and JS copies must produce byte-identical naming.
import * as dispatch from '../../scripts/lib/remotesession-dispatch.mjs';
import {
  validateDispatchInput,
  buildRemoteSessionManifest,
} from '../../scripts/lib/remotesession-dispatch.mjs';

const FIXTURES = [
  { cluster: 'hub', repo: 'https://github.com/shpwrck/claude-history-dashboard' },
  { cluster: 'hub', repo: 'shpwrck/claude-history-dashboard' },
  { cluster: 'hub', repo: 'shpwrck/Foo.Bar' },
  { cluster: 'hub', repo: 'git@github.com:owner/repo.git' },
  { cluster: 'sage', repo: 'https://github.com/a/b.git' },
  { cluster: 'My_Cluster', repo: 'Owner/Repo_Name' },
];

describe('provision-naming', () => {
  it('parses github URLs and bare owner/repo, rejects other hosts', () => {
    expect(parseGitHubRepo('https://github.com/o/r')).toEqual({ owner: 'o', repo: 'r' });
    expect(parseGitHubRepo('git@github.com:o/r.git')).toEqual({ owner: 'o', repo: 'r' });
    expect(parseGitHubRepo('o/r')).toEqual({ owner: 'o', repo: 'r' });
    expect(parseGitHubRepo('https://gitlab.com/o/r')).toBeNull();
    expect(parseGitHubRepo('https://github.com/o/r/extra')).toBeNull();
    expect(parseGitHubRepo('not a repo')).toBeNull();
    // host must be ANCHORED to github.com, not merely contain it in the path
    expect(parseGitHubRepo('https://attacker.example/github.com/owner/repo')).toBeNull();
    // dot-only / dot-leading owner or repo segments are rejected
    expect(parseGitHubRepo('owner/..')).toBeNull();
    expect(parseGitHubRepo('../repo')).toBeNull();
    expect(parseGitHubRepo('.')).toBeNull();
    expect(parseGitHubRepo('https://github.com/owner/..')).toBeNull();
  });

  it('produces RFC1123-valid names (<=63, no leading/trailing dash, lowercase)', () => {
    const long = remoteSessionName('hub', 'owner/' + 'a'.repeat(80));
    expect(long.length).toBeLessThanOrEqual(63);
    expect(long).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);
    expect(remoteSessionName('hub', 'shpwrck/Foo.Bar')).toBe('hub-shpwrck-foo-bar');
    expect(rfc1123Slug('--A_b..C--')).toBe('a-b-c');
  });

  it('derives a human env label', () => {
    expect(envNameFor('hub', 'shpwrck/claude-history-dashboard')).toBe(
      'hub/shpwrck/claude-history-dashboard'
    );
  });

  it('TS and server-side JS naming never drift (byte-identical over fixtures)', () => {
    for (const { cluster, repo } of FIXTURES) {
      expect(dispatch.remoteSessionName(cluster, repo)).toBe(remoteSessionName(cluster, repo));
      expect(dispatch.envNameFor(cluster, repo)).toBe(envNameFor(cluster, repo));
    }
  });
});

describe('remotesession-dispatch (server)', () => {
  it('validates repo + clamps poolSize', () => {
    expect(validateDispatchInput({ repo: '' }).ok).toBe(false);
    expect(validateDispatchInput({ repo: 'https://evil.com/a/b' }).ok).toBe(false);
    expect(validateDispatchInput({ repo: 'o/r', poolSize: 9 }).ok).toBe(false);
    expect(validateDispatchInput({ repo: 'o/r', poolSize: -1 }).ok).toBe(false);
    expect(validateDispatchInput({ repo: 'o/r', ref: 'a; rm -rf /' }).ok).toBe(false);
    const ok = validateDispatchInput({ repo: 'o/r' });
    expect(ok.ok).toBe(true);
    expect(ok.poolSize).toBe(1); // default
  });

  it('builds a sanitized RemoteSession manifest (clone URL rebuilt from parsed parts)', () => {
    const m = buildRemoteSessionManifest({
      cluster: 'hub',
      repo: 'https://github.com/shpwrck/claude-history-dashboard',
      ref: 'main',
      displayName: '',
      poolSize: 2,
    });
    expect(m.apiVersion).toBe('probaitio.com/v1alpha1');
    expect(m.kind).toBe('RemoteSession');
    expect(m.metadata.name).toBe('hub-shpwrck-claude-history-dashboard');
    expect(m.spec.mode).toBe('interactive');
    expect(m.spec.poolSize).toBe(2);
    expect(m.spec.repo).toBe('https://github.com/shpwrck/claude-history-dashboard');
    expect(m.spec.ref).toBe('main');
    expect(m.spec.displayName).toBe('hub/shpwrck/claude-history-dashboard');
  });
});
