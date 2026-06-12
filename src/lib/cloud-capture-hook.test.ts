import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const hookScript = join(repoRoot, 'tools/cloud-capture/publish-claude.sh');
const installScript = join(repoRoot, 'tools/cloud-capture/install.sh');

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

function writeTranscript(
  source: string,
  body: string,
  options: { projectSlug?: string; sessionId?: string } = {}
): string {
  const projectSlug = options.projectSlug ?? 'acme-app';
  const sessionId = options.sessionId ?? 'session-1';
  const sessionDir = join(source, '.claude/projects', projectSlug);
  const transcript = join(sessionDir, `${sessionId}.jsonl`);
  const subagents = join(sessionDir, `${sessionId}/subagents`);

  mkdirSync(subagents, { recursive: true });
  writeFileSync(transcript, `${body}\n`);
  writeFileSync(join(subagents, 'agent-a.jsonl'), `${body}\n`);

  return transcript;
}

function runHook(options: {
  cwd: string;
  transcript: string;
  sessionId?: string;
  env?: HookEnv;
}): ReturnType<typeof spawnSync<string>> {
  return spawnSync('bash', [hookScript], {
    cwd: options.cwd,
    input: JSON.stringify({
      session_id: options.sessionId ?? 'session-1',
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

function runSync(options: {
  cwd: string;
  projectsRoot?: string;
  env?: HookEnv;
}): ReturnType<typeof spawnSync<string>> {
  const args = [hookScript, '--sync'];
  if (options.projectsRoot) args.push(options.projectsRoot);
  return spawnSync('bash', args, {
    cwd: options.cwd,
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
      CLAUDE_HUB_CACHE_DIR: '',
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

  it('converges multiple writers by session id without duplicate files', () => {
    withTemp('cloud-capture-converge-', (dir) => {
      const sourceA = join(dir, 'source-a');
      const sourceB = join(dir, 'source-b');
      const sourceC = join(dir, 'source-c');
      initSourceRepo(sourceA);
      initSourceRepo(sourceB);
      initSourceRepo(sourceC, 'https://github.com/acme/api.git');
      const hub = initBareHub(dir);
      const sharedShort = writeTranscript(sourceA, 'shared first turn', {
        sessionId: 'session-shared',
      });
      const sharedLong = writeTranscript(
        sourceB,
        'shared first turn\nshared second turn with more content',
        { sessionId: 'session-shared' }
      );
      const disjoint = writeTranscript(sourceC, 'api session turn', {
        projectSlug: 'acme-api',
        sessionId: 'session-api',
      });

      for (const [cwd, transcript, sessionId] of [
        [sourceA, sharedShort, 'session-shared'],
        [sourceB, sharedLong, 'session-shared'],
        [sourceC, disjoint, 'session-api'],
      ] as const) {
        const result = runHook({
          cwd,
          transcript,
          sessionId,
          env: {
            CLAUDE_CODE_REMOTE: 'true',
            CLAUDE_HUB_REMOTE: `file://${hub}`,
            CLAUDE_HUB_BRANCH: 'main',
            CLAUDE_PROJECT_DIR: cwd,
          },
        });
        expect(result.status, result.stderr).toBe(0);
      }

      expect(hubFile(hub, 'projects/acme-app/session-shared.jsonl')).toContain(
        'shared second turn'
      );
      expect(hubFile(hub, 'projects/acme-api/session-api.jsonl')).toContain(
        'api session turn'
      );

      const shorterRepublish = runHook({
        cwd: sourceA,
        transcript: sharedShort,
        sessionId: 'session-shared',
        env: {
          CLAUDE_CODE_REMOTE: 'true',
          CLAUDE_HUB_REMOTE: `file://${hub}`,
          CLAUDE_HUB_BRANCH: 'main',
          CLAUDE_PROJECT_DIR: sourceA,
        },
      });
      expect(shorterRepublish.status, shorterRepublish.stderr).toBe(0);
      expect(shorterRepublish.stderr).toContain(
        'kept larger existing acme-app/session-shared.jsonl'
      );
      expect(hubFile(hub, 'projects/acme-app/session-shared.jsonl')).toContain(
        'shared second turn'
      );

      const files = git(
        ['--git-dir', hub, 'ls-tree', '-r', '--name-only', 'main'],
        dir
      )
        .split('\n')
        .filter(Boolean);
      expect(
        files.filter((file) => file === 'projects/acme-app/session-shared.jsonl')
      ).toHaveLength(1);
      expect(files).toContain('projects/acme-api/session-api.jsonl');
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

describe('workstation-to-hub sync (#696)', () => {
  it('publishes workstation sessions in local mode with a shared per-machine cache outside any git repo', () => {
    withTemp('hub-local-mode-', (dir) => {
      const home = join(dir, 'home');
      const workdir = join(dir, 'workdir');
      mkdirSync(workdir, { recursive: true });
      const hub = initBareHub(dir);
      const transcript = writeTranscript(home, 'workstation turn');

      const result = runHook({
        cwd: workdir,
        transcript,
        env: {
          CLAUDE_HUB_LOCAL: '1',
          CLAUDE_HUB_REMOTE: `file://${hub}`,
          CLAUDE_HUB_BRANCH: 'main',
          CLAUDE_PROJECT_DIR: workdir,
        },
      });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toContain('published acme-app/session-1.jsonl');
      expect(hubFile(hub, 'projects/acme-app/session-1.jsonl')).toContain(
        'workstation turn'
      );
      expect(
        hubFile(hub, 'projects/acme-app/session-1/subagents/agent-a.jsonl')
      ).toContain('workstation turn');
      // The cache sits next to the transcript tree (~/.claude/cloud-capture-hub),
      // not inside the (non-git) project directory.
      expect(existsSync(join(home, '.claude/cloud-capture-hub/.git'))).toBe(true);
      expect(existsSync(join(workdir, '.git'))).toBe(false);
    });
  });

  it('dedupes a session captured from both cloud and workstation by sessionId, later/larger snapshot wins', () => {
    withTemp('hub-local-dedup-', (dir) => {
      const cloudSource = join(dir, 'cloud-source');
      const home = join(dir, 'home');
      initSourceRepo(cloudSource);
      const hub = initBareHub(dir);

      const cloudTranscript = writeTranscript(
        cloudSource,
        'shared first turn\nshared second turn captured in the cloud'
      );
      const cloud = runHook({
        cwd: cloudSource,
        transcript: cloudTranscript,
        env: {
          CLAUDE_CODE_REMOTE: 'true',
          CLAUDE_HUB_REMOTE: `file://${hub}`,
          CLAUDE_HUB_BRANCH: 'main',
          CLAUDE_PROJECT_DIR: cloudSource,
        },
      });
      expect(cloud.status, cloud.stderr).toBe(0);

      const staleLocal = writeTranscript(home, 'shared first turn');
      const stale = runHook({
        cwd: dir,
        transcript: staleLocal,
        env: {
          CLAUDE_HUB_LOCAL: '1',
          CLAUDE_HUB_REMOTE: `file://${hub}`,
          CLAUDE_HUB_BRANCH: 'main',
          CLAUDE_PROJECT_DIR: dir,
        },
      });
      expect(stale.status, stale.stderr).toBe(0);
      expect(stale.stderr).toContain('kept larger existing acme-app/session-1.jsonl');
      expect(hubFile(hub, 'projects/acme-app/session-1.jsonl')).toContain(
        'captured in the cloud'
      );

      const fullerLocal = writeTranscript(
        home,
        'shared first turn\nshared second turn captured in the cloud\nthird turn finished on the workstation'
      );
      const fuller = runHook({
        cwd: dir,
        transcript: fullerLocal,
        env: {
          CLAUDE_HUB_LOCAL: '1',
          CLAUDE_HUB_REMOTE: `file://${hub}`,
          CLAUDE_HUB_BRANCH: 'main',
          CLAUDE_PROJECT_DIR: dir,
        },
      });
      expect(fuller.status, fuller.stderr).toBe(0);
      expect(hubFile(hub, 'projects/acme-app/session-1.jsonl')).toContain(
        'finished on the workstation'
      );

      const files = git(
        ['--git-dir', hub, 'ls-tree', '-r', '--name-only', 'main'],
        dir
      )
        .split('\n')
        .filter(Boolean);
      expect(
        files.filter((file) => file === 'projects/acme-app/session-1.jsonl')
      ).toHaveLength(1);
    });
  });

  it('batch-syncs an entire projects tree in one commit, idempotently, without clobbering larger hub files', () => {
    withTemp('hub-batch-sync-', (dir) => {
      const home = join(dir, 'home');
      const projectsRoot = join(home, '.claude/projects');
      const hub = initBareHub(dir);

      writeTranscript(home, 'app session turn', {
        projectSlug: 'acme-app',
        sessionId: 'session-app',
      });
      writeTranscript(home, 'api session turn', {
        projectSlug: 'acme-api',
        sessionId: 'session-api',
      });

      const first = runSync({
        cwd: dir,
        projectsRoot,
        env: {
          CLAUDE_HUB_LOCAL: '1',
          CLAUDE_HUB_REMOTE: `file://${hub}`,
          CLAUDE_HUB_BRANCH: 'main',
        },
      });
      expect(first.status, first.stderr).toBe(0);
      expect(first.stderr).toContain('published 2 session(s)');
      expect(hubCommitCount(hub)).toBe(1);
      expect(hubFile(hub, 'projects/acme-app/session-app.jsonl')).toContain(
        'app session turn'
      );
      expect(hubFile(hub, 'projects/acme-api/session-api.jsonl')).toContain(
        'api session turn'
      );
      expect(
        hubFile(hub, 'projects/acme-app/session-app/subagents/agent-a.jsonl')
      ).toContain('app session turn');
      expect(existsSync(join(home, '.claude/cloud-capture-hub/.git'))).toBe(true);

      const second = runSync({
        cwd: dir,
        projectsRoot,
        env: {
          CLAUDE_HUB_LOCAL: '1',
          CLAUDE_HUB_REMOTE: `file://${hub}`,
          CLAUDE_HUB_BRANCH: 'main',
        },
      });
      expect(second.status, second.stderr).toBe(0);
      expect(second.stderr).toContain('no transcript changes to publish (sync)');
      expect(hubCommitCount(hub)).toBe(1);

      // A locally truncated transcript must not clobber the larger hub copy.
      writeTranscript(home, 'app', {
        projectSlug: 'acme-app',
        sessionId: 'session-app',
      });
      const truncated = runSync({
        cwd: dir,
        projectsRoot,
        env: {
          CLAUDE_HUB_LOCAL: '1',
          CLAUDE_HUB_REMOTE: `file://${hub}`,
          CLAUDE_HUB_BRANCH: 'main',
        },
      });
      expect(truncated.status, truncated.stderr).toBe(0);
      expect(truncated.stderr).toContain(
        'kept larger existing acme-app/session-app.jsonl'
      );
      expect(hubFile(hub, 'projects/acme-app/session-app.jsonl')).toContain(
        'app session turn'
      );
    });
  });

  it('fails loudly in sync mode when no hub target is configured', () => {
    withTemp('hub-sync-noconfig-', (dir) => {
      const home = join(dir, 'home');
      const projectsRoot = join(home, '.claude/projects');
      mkdirSync(projectsRoot, { recursive: true });

      const result = runSync({ cwd: dir, projectsRoot });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('CLAUDE_HUB_REPO / CLAUDE_HUB_TOKEN not set');
    });
  });

  it('installs the hook user-level with install.sh --user as the one-step workstation install', () => {
    withTemp('hub-user-install-', (dir) => {
      const claudeDir = join(dir, 'claude-home');

      const result = spawnSync('bash', [installScript, '--user', claudeDir], {
        cwd: dir,
        encoding: 'utf8',
        env: { ...process.env },
      });

      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(existsSync(join(claudeDir, 'hooks/publish-claude.sh'))).toBe(true);

      const settings = JSON.parse(
        readFileSync(join(claudeDir, 'settings.json'), 'utf8')
      ) as {
        hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
      };
      for (const event of ['Stop', 'SessionEnd']) {
        const command = settings.hooks[event][0].hooks[0].command;
        expect(command).toContain('$HOME/.claude/hooks/publish-claude.sh');
        expect(command).toContain('$CLAUDE_PROJECT_DIR/.claude/hooks/publish-claude.sh');
      }
      expect(result.stdout).toContain('CLAUDE_HUB_LOCAL=1');
    });
  });
});
