import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const hookScript = join(repoRoot, 'tools/cloud-capture/publish-claude.sh');

type HookEnv = Record<string, string | undefined>;

function git(args: string[], cwd: string): string {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
    },
  });

  expect(result.status, result.stderr || result.stdout).toBe(0);
  return result.stdout.trim();
}

function maybeGit(args: string[], cwd: string): ReturnType<typeof spawnSync<string>> {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
    },
  });
}

function initSourceRepo(path: string, origin = 'https://github.com/acme/app.git'): void {
  mkdirSync(path, { recursive: true });
  git(['init', '-b', 'main'], path);
  git(['config', 'user.email', 'test@example.com'], path);
  git(['config', 'user.name', 'Test User'], path);
  writeFileSync(join(path, 'README.md'), 'source repo\n');
  git(['add', 'README.md'], path);
  git(['commit', '-m', 'init'], path);
  git(['remote', 'add', 'origin', origin], path);
}

function initBareHub(tempDir: string): string {
  const hub = join(tempDir, 'hub.git');
  git(['init', '--bare', hub], tempDir);
  return hub;
}

function writeTranscript(source: string, body: string): string {
  const sessionDir = join(source, '.claude/projects/acme-app');
  const transcript = join(sessionDir, 'session-1.jsonl');
  const subagents = join(sessionDir, 'session-1/subagents');

  mkdirSync(subagents, { recursive: true });
  writeFileSync(transcript, `${body}\n`);
  writeFileSync(join(subagents, 'agent-a.jsonl'), `${body}\n`);

  return transcript;
}

function runHook(options: {
  cwd: string;
  transcript: string;
  env?: HookEnv;
}): ReturnType<typeof spawnSync<string>> {
  return spawnSync('bash', [hookScript], {
    cwd: options.cwd,
    input: JSON.stringify({
      session_id: 'session-1',
      transcript_path: options.transcript,
      hook_event_name: 'Stop',
    }),
    encoding: 'utf8',
    env: {
      ...process.env,
      CLAUDE_CODE_REMOTE: '',
      CLAUDE_HUB_LOCAL: '',
      CLAUDE_HUB_REMOTE: '',
      CLAUDE_HUB_REPO: '',
      CLAUDE_HUB_TOKEN: '',
      CLAUDE_HUB_BRANCH: '',
      CLAUDE_HUB_SOURCE_ALLOW: '',
      CLAUDE_PROJECT_DIR: '',
      GIT_ALLOW_PROTOCOL: 'file:https:http:ssh',
      GIT_TERMINAL_PROMPT: '0',
      ...options.env,
    },
  });
}

function hubFile(hub: string, path: string): string {
  return git(['--git-dir', hub, 'show', `main:${path}`], dirname(hub));
}

function hubHasBranch(hub: string): boolean {
  return maybeGit(['--git-dir', hub, 'rev-parse', '--verify', 'main'], dirname(hub)).status === 0;
}

function hubCommitCount(hub: string): number {
  return Number(git(['--git-dir', hub, 'rev-list', '--count', 'main'], dirname(hub)));
}

function withTemp<T>(name: string, fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), name));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('cloud-capture hook (#689)', () => {
  it('publishes scrubbed parent and subagent transcripts to the dashboard-native layout idempotently', () => {
    withTemp('cloud-capture-publish-', (dir) => {
      const source = join(dir, 'source');
      initSourceRepo(source);
      const hub = initBareHub(dir);
      const secrets = [
        'sk-ant-api03-abcdefghi',
        'sk-1234567890abcdef',
        `ghp_${'A'.repeat(24)}`,
        `github_pat_${'B'.repeat(24)}`,
        'AKIAIOSFODNN7EXAMPLE',
        'xoxb-123456789012-abcdef',
        'Bearer abcdefghijklmnopqrstuvwxyz',
        '"Authorization":"abcdefghijklmnopqrstuvwx"',
        'eyJhbGciOiJIUzI1NiJ9.abcdefghi12345.zyxwvutsrq98765',
        `AIza${'C'.repeat(30)}`,
        `sk_live_${'D'.repeat(24)}`,
      ];
      const transcript = writeTranscript(source, secrets.join(' '));

      const first = runHook({
        cwd: source,
        transcript,
        env: {
          CLAUDE_CODE_REMOTE: 'true',
          CLAUDE_HUB_REMOTE: `file://${hub}`,
          CLAUDE_HUB_BRANCH: 'main',
          CLAUDE_PROJECT_DIR: source,
        },
      });

      expect(first.status, first.stderr).toBe(0);
      expect(first.stderr).toContain('published acme-app/session-1.jsonl');
      expect(existsSync(join(source, '.git/cloud-capture-hub/.git'))).toBe(true);

      const parent = hubFile(hub, 'projects/acme-app/session-1.jsonl');
      const subagent = hubFile(hub, 'projects/acme-app/session-1/subagents/agent-a.jsonl');
      expect(parent).toContain('sk-ant-REDACTED');
      expect(subagent).toContain('sk-ant-REDACTED');
      for (const secret of secrets) {
        expect(parent).not.toContain(secret);
        expect(subagent).not.toContain(secret);
      }

      expect(hubCommitCount(hub)).toBe(1);
      const second = runHook({
        cwd: source,
        transcript,
        env: {
          CLAUDE_CODE_REMOTE: 'true',
          CLAUDE_HUB_REMOTE: `file://${hub}`,
          CLAUDE_HUB_BRANCH: 'main',
          CLAUDE_PROJECT_DIR: source,
        },
      });

      expect(second.status, second.stderr).toBe(0);
      expect(second.stderr).toContain('no transcript changes to publish');
      expect(hubCommitCount(hub)).toBe(1);
    });
  });

  it('reuses the cached checkout instead of recloning for unchanged turns', () => {
    withTemp('cloud-capture-cache-', (dir) => {
      const source = join(dir, 'source');
      initSourceRepo(source);
      const hub = initBareHub(dir);
      const transcript = writeTranscript(source, 'turn without new changes');

      const first = runHook({
        cwd: source,
        transcript,
        env: {
          CLAUDE_CODE_REMOTE: 'true',
          CLAUDE_HUB_REMOTE: `file://${hub}`,
          CLAUDE_HUB_BRANCH: 'main',
          CLAUDE_PROJECT_DIR: source,
        },
      });
      expect(first.status, first.stderr).toBe(0);
      expect(existsSync(join(source, '.git/cloud-capture-hub/.git'))).toBe(true);

      rmSync(hub, { recursive: true, force: true });
      const second = runHook({
        cwd: source,
        transcript,
        env: {
          CLAUDE_CODE_REMOTE: 'true',
          CLAUDE_HUB_REMOTE: `file://${hub}`,
          CLAUDE_HUB_BRANCH: 'main',
          CLAUDE_PROJECT_DIR: source,
        },
      });

      expect(second.status, second.stderr).toBe(0);
      expect(second.stderr).toContain('no transcript changes to publish');
    });
  });

  it('enforces the source allowlist before cloning and allows owner/repo matches', () => {
    withTemp('cloud-capture-allow-', (dir) => {
      const source = join(dir, 'source');
      initSourceRepo(source);
      const hub = initBareHub(dir);
      const transcript = writeTranscript(source, 'turn without secrets');

      const blocked = runHook({
        cwd: source,
        transcript,
        env: {
          CLAUDE_CODE_REMOTE: 'true',
          CLAUDE_HUB_REMOTE: `file://${hub}`,
          CLAUDE_HUB_BRANCH: 'main',
          CLAUDE_PROJECT_DIR: source,
          CLAUDE_HUB_SOURCE_ALLOW: 'other/repo',
        },
      });

      expect(blocked.status, blocked.stderr).toBe(0);
      expect(blocked.stderr).toContain("source 'acme/app' not in CLAUDE_HUB_SOURCE_ALLOW");
      expect(hubHasBranch(hub)).toBe(false);

      const allowed = runHook({
        cwd: source,
        transcript,
        env: {
          CLAUDE_CODE_REMOTE: 'true',
          CLAUDE_HUB_REMOTE: `file://${hub}`,
          CLAUDE_HUB_BRANCH: 'main',
          CLAUDE_PROJECT_DIR: source,
          CLAUDE_HUB_SOURCE_ALLOW: 'acme/app',
        },
      });

      expect(allowed.status, allowed.stderr).toBe(0);
      expect(hubFile(hub, 'projects/acme-app/session-1.jsonl')).toContain('turn without secrets');
    });
  });

  it('no-ops without a hub target and outside cloud sessions', () => {
    withTemp('cloud-capture-noop-', (dir) => {
      const source = join(dir, 'source');
      initSourceRepo(source);
      const hub = initBareHub(dir);
      const transcript = writeTranscript(source, 'turn without publish');

      const missingRemote = runHook({
        cwd: source,
        transcript,
        env: {
          CLAUDE_CODE_REMOTE: 'true',
          CLAUDE_PROJECT_DIR: source,
        },
      });

      expect(missingRemote.status, missingRemote.stderr).toBe(0);
      expect(missingRemote.stderr).toContain('CLAUDE_HUB_REPO / CLAUDE_HUB_TOKEN not set');
      expect(hubHasBranch(hub)).toBe(false);

      const nonRemote = runHook({
        cwd: source,
        transcript,
        env: {
          CLAUDE_HUB_REMOTE: `file://${hub}`,
          CLAUDE_HUB_BRANCH: 'main',
          CLAUDE_PROJECT_DIR: source,
        },
      });

      expect(nonRemote.status, nonRemote.stderr).toBe(0);
      expect(nonRemote.stderr).toContain('not a remote session');
      expect(hubHasBranch(hub)).toBe(false);
    });
  });
});
