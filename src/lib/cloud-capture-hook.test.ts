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

// Isolate every git invocation (helpers and the scripts under test) from the
// host's global/system git config: enforced commit signing, proxies, or
// credential helpers there would make the suite fail or hang (#1416).
const hermeticGitEnv = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
};

function git(args: string[], cwd: string): string {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...hermeticGitEnv,
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
      ...hermeticGitEnv,
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

// One shared scrub list for both entry points (hook and sync) so the two
// cannot drift apart again: every CLAUDE_* knob the script reads is cleared.
const scrubbedHookEnv = {
  CLAUDE_CODE_REMOTE: '',
  CLAUDE_HUB_LOCAL: '',
  CLAUDE_HUB_REMOTE: '',
  CLAUDE_HUB_REPO: '',
  CLAUDE_HUB_TOKEN: '',
  CLAUDE_HUB_BRANCH: '',
  CLAUDE_HUB_SOURCE_ALLOW: '',
  CLAUDE_HUB_CACHE_DIR: '',
  CLAUDE_HUB_LOCK_STALE_SECONDS: '',
  CLAUDE_HUB_PUSH_RETRIES: '',
  CLAUDE_CONFIG_DIR: '',
  CLAUDE_PROJECT_DIR: '',
  GIT_ALLOW_PROTOCOL: 'file:https:http:ssh',
  ...hermeticGitEnv,
};

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
      ...scrubbedHookEnv,
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
      ...scrubbedHookEnv,
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
          CLAUDE_CONFIG_DIR: join(home, '.claude'),
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
          CLAUDE_CONFIG_DIR: join(home, '.claude'),
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
          CLAUDE_CONFIG_DIR: join(home, '.claude'),
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
          CLAUDE_CONFIG_DIR: join(home, '.claude'),
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
          CLAUDE_CONFIG_DIR: join(home, '.claude'),
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
          CLAUDE_CONFIG_DIR: join(home, '.claude'),
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

      const result = runInstall(['--user', claudeDir], dir);

      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(existsSync(join(claudeDir, 'hooks/publish-claude.sh'))).toBe(true);

      const settings = readSettings(join(claudeDir, 'settings.json'));
      for (const event of ['Stop', 'SessionEnd']) {
        const command = settings.hooks[event][0].hooks[0].command;
        // The registration is pinned to the installed user-level copy. It must
        // not probe (and execute) a repo-controlled $CLAUDE_PROJECT_DIR path.
        expect(command).toContain(`${claudeDir}/hooks/publish-claude.sh`);
        expect(command).not.toContain('$CLAUDE_PROJECT_DIR');
      }
      expect(result.stdout).toContain('CLAUDE_HUB_LOCAL=1');
    });
  });
});

type HookSettings = {
  hooks: Record<string, Array<{ hooks: Array<{ type?: string; command: string }> }>>;
};

function readSettings(path: string): HookSettings {
  return JSON.parse(readFileSync(path, 'utf8')) as HookSettings;
}

function runInstall(args: string[], cwd: string): ReturnType<typeof spawnSync<string>> {
  return spawnSync('bash', [installScript, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...hermeticGitEnv },
  });
}

function captureCommands(settings: HookSettings, event: string): string[] {
  return (settings.hooks[event] ?? [])
    .flatMap((entry) => entry.hooks)
    .map((hook) => hook.command)
    .filter((command) => command.includes('publish-claude.sh'));
}

describe('cloud-capture local/sync hardening (#1426)', () => {
  it('project install pins the hook command to the project copy without probing fallbacks', () => {
    withTemp('hub-repo-install-', (dir) => {
      const repo = join(dir, 'repo');
      initSourceRepo(repo);

      const result = runInstall([repo], dir);
      expect(result.status, result.stderr || result.stdout).toBe(0);

      const settings = readSettings(join(repo, '.claude/settings.json'));
      for (const event of ['Stop', 'SessionEnd']) {
        const command = settings.hooks[event][0].hooks[0].command;
        expect(command).toContain('$CLAUDE_PROJECT_DIR/.claude/hooks/publish-claude.sh');
        // No fallback probing: a single pinned path, never $HOME.
        expect(command).not.toContain('$HOME');
        expect(command).not.toContain('hook=');
      }
    });
  });

  it('re-running install.sh never duplicates the registration and replaces legacy probing commands', () => {
    withTemp('hub-reinstall-', (dir) => {
      const claudeDir = join(dir, 'claude-home');

      expect(runInstall(['--user', claudeDir], dir).status).toBe(0);
      expect(runInstall(['--user', claudeDir], dir).status).toBe(0);

      let settings = readSettings(join(claudeDir, 'settings.json'));
      for (const event of ['Stop', 'SessionEnd']) {
        expect(captureCommands(settings, event)).toHaveLength(1);
      }

      // Seed the legacy (vulnerable) probing command plus an unrelated hook:
      // a re-run must replace the legacy registration and keep the unrelated one.
      const legacy =
        'hook="$CLAUDE_PROJECT_DIR/.claude/hooks/publish-claude.sh"; [ -f "$hook" ] || hook="$HOME/.claude/hooks/publish-claude.sh"; [ -f "$hook" ] || exit 0; bash "$hook"';
      settings.hooks.Stop = [
        { hooks: [{ type: 'command', command: legacy }] },
        { hooks: [{ type: 'command', command: 'echo unrelated' }] },
      ];
      writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify(settings));

      expect(runInstall(['--user', claudeDir], dir).status).toBe(0);
      settings = readSettings(join(claudeDir, 'settings.json'));

      const stopCommands = captureCommands(settings, 'Stop');
      expect(stopCommands).toHaveLength(1);
      expect(stopCommands[0]).not.toContain('$CLAUDE_PROJECT_DIR');
      expect(stopCommands[0]).toContain(`${claudeDir}/hooks/publish-claude.sh`);
      const allStop = settings.hooks.Stop.flatMap((entry) => entry.hooks).map(
        (hook) => hook.command
      );
      expect(allStop).toContain('echo unrelated');
    });
  });

  it('honors CLAUDE_HUB_SOURCE_ALLOW per transcript in sync mode, failing closed on underivable origins', { timeout: 20000 }, () => {
    withTemp('hub-sync-allow-', (dir) => {
      const home = join(dir, 'home');
      const projectsRoot = join(home, '.claude/projects');
      const hub = initBareHub(dir);
      const allowedRepo = join(dir, 'allowed-repo');
      const deniedRepo = join(dir, 'denied-repo');
      initSourceRepo(allowedRepo, 'https://github.com/acme/app.git');
      initSourceRepo(deniedRepo, 'https://github.com/evil/stuff.git');

      writeTranscript(home, `{"cwd":"${allowedRepo}","text":"allowed turn"}`, {
        projectSlug: 'p-allowed',
        sessionId: 'sess-allowed',
      });
      writeTranscript(home, `{"cwd":"${deniedRepo}","text":"denied turn"}`, {
        projectSlug: 'p-denied',
        sessionId: 'sess-denied',
      });
      writeTranscript(home, '{"text":"no cwd recorded"}', {
        projectSlug: 'p-unknown',
        sessionId: 'sess-unknown',
      });

      const env = {
        CLAUDE_HUB_REMOTE: `file://${hub}`,
        CLAUDE_HUB_BRANCH: 'main',
        CLAUDE_CONFIG_DIR: join(home, '.claude'),
        CLAUDE_HUB_SOURCE_ALLOW: 'acme/app',
      };
      const result = runSync({ cwd: dir, projectsRoot, env });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toContain("source 'evil/stuff' not in CLAUDE_HUB_SOURCE_ALLOW");
      expect(result.stderr).toContain('source origin cannot be derived');
      expect(result.stderr).toContain('published 1 session(s)');

      const files = git(['--git-dir', hub, 'ls-tree', '-r', '--name-only', 'main'], dir)
        .split('\n')
        .filter(Boolean);
      expect(files).toContain('projects/p-allowed/sess-allowed.jsonl');
      expect(files.filter((file) => file.includes('p-denied'))).toHaveLength(0);
      expect(files.filter((file) => file.includes('p-unknown'))).toHaveLength(0);

      // Nothing allowed at all: still loud, still exit 0 (policy, not failure).
      const allSkipped = runSync({
        cwd: dir,
        projectsRoot,
        env: { ...env, CLAUDE_HUB_SOURCE_ALLOW: 'nobody/nothing' },
      });
      expect(allSkipped.status, allSkipped.stderr).toBe(0);
      expect(allSkipped.stderr).toContain('skipped by CLAUDE_HUB_SOURCE_ALLOW');
    });
  });

  it('continues past a poison transcript in sync mode and reports the failure in the exit code', { timeout: 20000 }, () => {
    withTemp('hub-sync-poison-', (dir) => {
      const home = join(dir, 'home');
      const projectsRoot = join(home, '.claude/projects');
      const hub = initBareHub(dir);

      // A directory named *.jsonl is unreadable as a transcript and glob-sorts
      // before both real sessions.
      mkdirSync(join(projectsRoot, 'a-poison/0-bad.jsonl'), { recursive: true });
      writeTranscript(home, 'first good session', {
        projectSlug: 'acme-app',
        sessionId: 'sess-one',
      });
      writeTranscript(home, 'second good session', {
        projectSlug: 'acme-web',
        sessionId: 'sess-two',
      });

      const result = runSync({
        cwd: dir,
        projectsRoot,
        env: {
          CLAUDE_HUB_REMOTE: `file://${hub}`,
          CLAUDE_HUB_BRANCH: 'main',
          CLAUDE_CONFIG_DIR: join(home, '.claude'),
        },
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('continuing with remaining sessions');
      expect(result.stderr).toContain('published 2 session(s)');
      expect(hubFile(hub, 'projects/acme-app/sess-one.jsonl')).toContain('first good session');
      expect(hubFile(hub, 'projects/acme-web/sess-two.jsonl')).toContain('second good session');
    });
  });

  it('breaks a stale hub lock left by a dead publisher (pid- and age-based)', { timeout: 20000 }, () => {
    withTemp('hub-stale-lock-', (dir) => {
      const home = join(dir, 'home');
      const projectsRoot = join(home, '.claude/projects');
      const hub = initBareHub(dir);
      const cacheDir = join(dir, 'hub-cache');
      const lockDir = `${cacheDir}.lock`;
      const env = {
        CLAUDE_HUB_REMOTE: `file://${hub}`,
        CLAUDE_HUB_BRANCH: 'main',
        CLAUDE_CONFIG_DIR: join(home, '.claude'),
        CLAUDE_HUB_CACHE_DIR: cacheDir,
      };

      // A lock whose recorded holder pid is no longer alive.
      const deadPid = spawnSync('bash', ['-c', 'echo $$'], { encoding: 'utf8' })
        .stdout.trim();
      mkdirSync(lockDir, { recursive: true });
      writeFileSync(join(lockDir, 'pid'), `${deadPid}\n`);

      writeTranscript(home, 'session behind a dead lock', {
        projectSlug: 'acme-app',
        sessionId: 'sess-lock',
      });
      const deadLock = runSync({ cwd: dir, projectsRoot, env });
      expect(deadLock.status, deadLock.stderr).toBe(0);
      expect(deadLock.stderr).toContain('breaking stale hub lock');
      expect(deadLock.stderr).toContain(`holder pid ${deadPid} is gone`);
      expect(hubFile(hub, 'projects/acme-app/sess-lock.jsonl')).toContain(
        'session behind a dead lock'
      );
      expect(existsSync(lockDir)).toBe(false);

      // A lock with no recorded pid falls back to the age threshold.
      mkdirSync(lockDir, { recursive: true });
      writeTranscript(home, 'session behind an aged lock with more content', {
        projectSlug: 'acme-app',
        sessionId: 'sess-lock',
      });
      const agedLock = runSync({
        cwd: dir,
        projectsRoot,
        env: { ...env, CLAUDE_HUB_LOCK_STALE_SECONDS: '0' },
      });
      expect(agedLock.status, agedLock.stderr).toBe(0);
      expect(agedLock.stderr).toContain('breaking stale hub lock');
      expect(agedLock.stderr).toContain('no holder pid');
      expect(existsSync(lockDir)).toBe(false);
    });
  });

  it('keys the hub stem by transcript filename even when the payload session_id differs', { timeout: 20000 }, () => {
    withTemp('hub-stem-unify-', (dir) => {
      const source = join(dir, 'source');
      initSourceRepo(source);
      const hub = initBareHub(dir);
      const transcript = writeTranscript(source, 'one session, one stem');

      const result = runHook({
        cwd: source,
        transcript,
        sessionId: 'totally-different-id',
        env: {
          CLAUDE_CODE_REMOTE: 'true',
          CLAUDE_HUB_REMOTE: `file://${hub}`,
          CLAUDE_HUB_BRANCH: 'main',
          CLAUDE_PROJECT_DIR: source,
        },
      });

      expect(result.status, result.stderr).toBe(0);
      const files = git(['--git-dir', hub, 'ls-tree', '-r', '--name-only', 'main'], dir)
        .split('\n')
        .filter(Boolean);
      // Sync mode would publish this transcript as session-1.jsonl; hook mode
      // must land on the same stem instead of forking a second copy.
      expect(files).toContain('projects/acme-app/session-1.jsonl');
      expect(files.filter((file) => file.includes('totally-different-id'))).toHaveLength(0);
    });
  });

  it('never persists the hub token in the cached clone and scrubs legacy tokenized remote URLs', { timeout: 20000 }, () => {
    withTemp('hub-token-', (dir) => {
      const home = join(dir, 'home');
      const projectsRoot = join(home, '.claude/projects');
      const hub = initBareHub(dir);
      const cacheDir = join(dir, 'hub-cache');
      writeTranscript(home, 'token handling session', {
        projectSlug: 'acme-app',
        sessionId: 'sess-token',
      });

      // Seed the persistent cache via a tokenless file:// run.
      const seed = runSync({
        cwd: dir,
        projectsRoot,
        env: {
          CLAUDE_HUB_REMOTE: `file://${hub}`,
          CLAUDE_HUB_BRANCH: 'main',
          CLAUDE_CONFIG_DIR: join(home, '.claude'),
          CLAUDE_HUB_CACHE_DIR: cacheDir,
        },
      });
      expect(seed.status, seed.stderr).toBe(0);

      // Simulate a cache written by the old script version, which baked the
      // token into the persistent .git/config remote URL.
      git(
        [
          'remote',
          'set-url',
          'origin',
          'https://x-access-token:legacy-baked-token@github.example.invalid/acme/hub.git',
        ],
        cacheDir
      );

      writeTranscript(home, 'token handling session grown longer now', {
        projectSlug: 'acme-app',
        sessionId: 'sess-token',
      });
      const tokenRun = runSync({
        cwd: dir,
        projectsRoot,
        env: {
          CLAUDE_HUB_REPO: 'github.example.invalid/acme/hub.git',
          CLAUDE_HUB_TOKEN: 'hub-token-abc123-secret',
          CLAUDE_HUB_BRANCH: 'main',
          CLAUDE_CONFIG_DIR: join(home, '.claude'),
          CLAUDE_HUB_CACHE_DIR: cacheDir,
          CLAUDE_HUB_PUSH_RETRIES: '1',
        },
      });

      // The push cannot succeed (unreachable host); what matters is what the
      // run left on disk.
      expect(tokenRun.status).toBe(1);
      const gitConfig = readFileSync(join(cacheDir, '.git/config'), 'utf8');
      expect(gitConfig).not.toContain('hub-token-abc123-secret');
      expect(gitConfig).not.toContain('legacy-baked-token');
      expect(gitConfig).not.toContain('x-access-token');
      expect(gitConfig).toContain('https://github.example.invalid/acme/hub.git');
    });
  });

  it('exits nonzero in sync mode when the push and the recovery fetch both fail after committing', { timeout: 30000 }, () => {
    withTemp('hub-sync-outage-', (dir) => {
      const home = join(dir, 'home');
      const projectsRoot = join(home, '.claude/projects');
      const hub = initBareHub(dir);
      const env = {
        CLAUDE_HUB_REMOTE: `file://${hub}`,
        CLAUDE_HUB_BRANCH: 'main',
        CLAUDE_CONFIG_DIR: join(home, '.claude'),
        CLAUDE_HUB_PUSH_RETRIES: '2',
      };

      writeTranscript(home, 'outage session first snapshot', {
        projectSlug: 'acme-app',
        sessionId: 'sess-outage',
      });
      const seed = runSync({ cwd: dir, projectsRoot, env });
      expect(seed.status, seed.stderr).toBe(0);

      // Total outage (network down / auth revoked): the remote disappears, so
      // the push fails AND the recovery fetch fails. The commit absorbs the
      // staged changes, but that must not be reported as "nothing to publish".
      rmSync(hub, { recursive: true, force: true });
      writeTranscript(
        home,
        'outage session first snapshot\ngrown second snapshot never reaches the hub',
        { projectSlug: 'acme-app', sessionId: 'sess-outage' }
      );

      const outage = runSync({ cwd: dir, projectsRoot, env });
      expect(outage.status, outage.stderr).toBe(1);
      expect(outage.stderr).toContain('committed snapshot remains unpushed');
      expect(outage.stderr).not.toContain('no transcript changes to publish');

      // Hook mode keeps its never-break-the-session contract: same outage,
      // honest message, but exit 0.
      const transcript = writeTranscript(
        home,
        'outage session first snapshot\ngrown second snapshot never reaches the hub\nthird snapshot from the hook',
        { projectSlug: 'acme-app', sessionId: 'sess-outage' }
      );
      const hookOutage = runHook({
        cwd: dir,
        transcript,
        sessionId: 'sess-outage',
        env: { ...env, CLAUDE_HUB_LOCAL: '1', CLAUDE_PROJECT_DIR: dir },
      });
      expect(hookOutage.status, hookOutage.stderr).toBe(0);
      expect(hookOutage.stderr).toContain('committed snapshot remains unpushed');
    });
  });

  it('fails closed in hook mode when the allowlist is set and the project has no origin, and matches comma+space lists by whole entry', { timeout: 20000 }, () => {
    withTemp('hub-allow-empty-origin-', (dir) => {
      const hub = initBareHub(dir);

      // A project that is a git repo but has NO remote: the derived origin is
      // empty. With "acme, partner" the old substring match turned the double
      // space into a universal match for the empty source slug.
      const noRemote = join(dir, 'no-remote');
      mkdirSync(noRemote, { recursive: true });
      git(['init', '-b', 'main'], noRemote);
      const transcript = writeTranscript(noRemote, 'turn from an originless repo');

      const blocked = runHook({
        cwd: noRemote,
        transcript,
        env: {
          CLAUDE_CODE_REMOTE: 'true',
          CLAUDE_HUB_REMOTE: `file://${hub}`,
          CLAUDE_HUB_BRANCH: 'main',
          CLAUDE_PROJECT_DIR: noRemote,
          CLAUDE_HUB_SOURCE_ALLOW: 'acme, partner',
        },
      });
      expect(blocked.status, blocked.stderr).toBe(0);
      expect(blocked.stderr).toContain('source origin cannot be derived');
      expect(hubHasBranch(hub)).toBe(false);

      // The same comma+space list still allows a real owner match.
      const allowedRepo = join(dir, 'allowed');
      initSourceRepo(allowedRepo, 'https://github.com/acme/app.git');
      const allowedTranscript = writeTranscript(allowedRepo, 'turn from an allowed owner');
      const allowed = runHook({
        cwd: allowedRepo,
        transcript: allowedTranscript,
        env: {
          CLAUDE_CODE_REMOTE: 'true',
          CLAUDE_HUB_REMOTE: `file://${hub}`,
          CLAUDE_HUB_BRANCH: 'main',
          CLAUDE_PROJECT_DIR: allowedRepo,
          CLAUDE_HUB_SOURCE_ALLOW: 'acme, partner',
        },
      });
      expect(allowed.status, allowed.stderr).toBe(0);
      expect(hubFile(hub, 'projects/acme-app/session-1.jsonl')).toContain(
        'turn from an allowed owner'
      );
    });
  });

  it('absolutizes a relative sync root so the post-cd push-race retry still publishes', { timeout: 30000 }, () => {
    withTemp('hub-sync-relative-', (dir) => {
      const home = join(dir, 'home');
      const hub = initBareHub(dir);

      // Seed main with a baseline and a 'race' branch a concurrent writer wins
      // with; the one-shot pre-receive hook rejects the first push to main and
      // advances main to the race branch, forcing the post-cd publish_all retry.
      const writer = join(dir, 'writer-b');
      mkdirSync(join(writer, 'projects/other'), { recursive: true });
      git(['init', '-b', 'main'], writer);
      git(['config', 'user.email', 'writer@example.com'], writer);
      git(['config', 'user.name', 'Writer B'], writer);
      writeFileSync(join(writer, 'projects/other/keep.jsonl'), 'baseline\n');
      git(['add', '-A'], writer);
      git(['commit', '-m', 'baseline'], writer);
      git(['push', '-q', `file://${hub}`, 'HEAD:main'], writer);
      writeFileSync(join(writer, 'projects/other/racer.jsonl'), 'racing writer\n');
      git(['add', '-A'], writer);
      git(['commit', '-m', 'race'], writer);
      git(['push', '-q', `file://${hub}`, 'HEAD:race'], writer);
      writeFileSync(
        join(hub, 'hooks/pre-receive'),
        [
          '#!/bin/sh',
          'while read old new ref; do',
          '  if [ "$ref" = "refs/heads/main" ] && [ ! -f "$GIT_DIR/race-done" ]; then',
          '    : > "$GIT_DIR/race-done"',
          '    env -u GIT_QUARANTINE_PATH -u GIT_OBJECT_DIRECTORY -u GIT_ALTERNATE_OBJECT_DIRECTORIES \\',
          '      git update-ref refs/heads/main refs/heads/race',
          '    exit 1',
          '  fi',
          'done',
          'exit 0',
          '',
        ].join('\n'),
        { mode: 0o755 }
      );

      writeTranscript(home, 'relative root session', {
        projectSlug: 'acme-app',
        sessionId: 'sess-rel',
      });

      // RELATIVE sync root: before the fix the retry re-ran publish_all from
      // inside the hub checkout, matched nothing, and exited 0 publishing nothing.
      const result = runSync({
        cwd: dir,
        projectsRoot: 'home/.claude/projects',
        env: {
          CLAUDE_HUB_REMOTE: `file://${hub}`,
          CLAUDE_HUB_BRANCH: 'main',
          CLAUDE_CONFIG_DIR: join(home, '.claude'),
        },
      });

      expect(result.status, result.stderr).toBe(0);
      // The race fired (first push was rejected) ...
      expect(existsSync(join(hub, 'race-done'))).toBe(true);
      // ... the publish label carries the absolutized root ...
      expect(result.stderr).toMatch(
        /published 1 session\(s\) from \/\S*home\/\.claude\/projects/
      );
      // ... and the session actually landed on the retry.
      expect(hubFile(hub, 'projects/acme-app/sess-rel.jsonl')).toContain(
        'relative root session'
      );
    });
  });

  it('preserves a custom env-wrapper hook registration on re-install without duplicating it', () => {
    withTemp('hub-custom-wrapper-', (dir) => {
      const claudeDir = join(dir, 'claude-home');

      expect(runInstall(['--user', claudeDir], dir).status).toBe(0);
      let settings = readSettings(join(claudeDir, 'settings.json'));

      // The user replaced the pinned Stop registration with an env-carrying
      // wrapper of their own; SessionEnd keeps the installer's pinned command.
      const wrapper = `CLAUDE_HUB_LOCAL=1 CLAUDE_HUB_REPO=github.com/acme/hub bash "${claudeDir}/hooks/publish-claude.sh"`;
      settings.hooks.Stop = [{ hooks: [{ type: 'command', command: wrapper }] }];
      writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify(settings));

      const rerun = runInstall(['--user', claudeDir], dir);
      expect(rerun.status, rerun.stderr || rerun.stdout).toBe(0);
      expect(rerun.stdout).toContain('preserved 1 existing custom publish-claude.sh registration');

      settings = readSettings(join(claudeDir, 'settings.json'));
      const stopCommands = captureCommands(settings, 'Stop');
      expect(stopCommands).toHaveLength(1);
      expect(stopCommands[0]).toBe(wrapper);
      // The installer-shaped SessionEnd registration is still replaced/pinned.
      const endCommands = captureCommands(settings, 'SessionEnd');
      expect(endCommands).toHaveLength(1);
      expect(endCommands[0]).toBe(`[ -f "${claudeDir}/hooks/publish-claude.sh" ] || exit 0; bash "${claudeDir}/hooks/publish-claude.sh"`);
      // The hook script file itself was still refreshed.
      expect(existsSync(join(claudeDir, 'hooks/publish-claude.sh'))).toBe(true);
    });
  });

  it('keeps the larger hub copy when a push race lands a newer snapshot first', { timeout: 30000 }, () => {
    withTemp('hub-push-race-', (dir) => {
      const home = join(dir, 'home');
      const hub = initBareHub(dir);

      // Seed main with a baseline commit and a 'race' branch carrying a LARGER
      // copy of the same session.
      const writer = join(dir, 'writer-b');
      mkdirSync(join(writer, 'projects/other'), { recursive: true });
      git(['init', '-b', 'main'], writer);
      git(['config', 'user.email', 'writer@example.com'], writer);
      git(['config', 'user.name', 'Writer B'], writer);
      writeFileSync(join(writer, 'projects/other/keep.jsonl'), 'baseline\n');
      git(['add', '-A'], writer);
      git(['commit', '-m', 'baseline'], writer);
      git(['push', '-q', `file://${hub}`, 'HEAD:main'], writer);
      mkdirSync(join(writer, 'projects/acme-app'), { recursive: true });
      writeFileSync(
        join(writer, 'projects/acme-app/session-1.jsonl'),
        'shared first turn\nshared second turn with much more content from the racing writer\n'
      );
      git(['add', '-A'], writer);
      git(['commit', '-m', 'race'], writer);
      git(['push', '-q', `file://${hub}`, 'HEAD:race'], writer);

      // One-shot pre-receive race: reject the first push to main and advance
      // main to the racing (larger) snapshot instead, exactly as a concurrent
      // writer winning the push race would.
      writeFileSync(
        join(hub, 'hooks/pre-receive'),
        [
          '#!/bin/sh',
          'while read old new ref; do',
          '  if [ "$ref" = "refs/heads/main" ] && [ ! -f "$GIT_DIR/race-done" ]; then',
          '    : > "$GIT_DIR/race-done"',
          '    env -u GIT_QUARANTINE_PATH -u GIT_OBJECT_DIRECTORY -u GIT_ALTERNATE_OBJECT_DIRECTORIES \\',
          '      git update-ref refs/heads/main refs/heads/race',
          '    exit 1',
          '  fi',
          'done',
          'exit 0',
          '',
        ].join('\n'),
        { mode: 0o755 }
      );

      // The local writer holds only a stale, smaller snapshot of that session.
      const transcript = writeTranscript(home, 'shared first turn');
      const result = runHook({
        cwd: dir,
        transcript,
        env: {
          CLAUDE_HUB_LOCAL: '1',
          CLAUDE_HUB_REMOTE: `file://${hub}`,
          CLAUDE_HUB_BRANCH: 'main',
          CLAUDE_CONFIG_DIR: join(home, '.claude'),
          CLAUDE_PROJECT_DIR: dir,
        },
      });

      expect(result.status, result.stderr).toBe(0);
      // The race fired (first push was rejected) ...
      expect(existsSync(join(hub, 'race-done'))).toBe(true);
      // ... and the retry did NOT resurrect the stale smaller snapshot over
      // the newer larger hub copy (the old '-X theirs' rebase did).
      expect(result.stderr).toContain('kept larger existing acme-app/session-1.jsonl');
      expect(hubFile(hub, 'projects/acme-app/session-1.jsonl')).toContain(
        'more content from the racing writer'
      );
    });
  });
});

describe('cloud-capture data-loss hardening (#1430)', () => {
  it('rescues a prior-run unpushed snapshot across a source prune before the cross-run reset discards it', { timeout: 30000 }, () => {
    withTemp('hub-rescue-crossrun-', (dir) => {
      const home = join(dir, 'home');
      const projectsRoot = join(home, '.claude/projects');
      const hub = initBareHub(dir);
      const cacheDir = join(dir, 'hub-cache');
      const baseEnv = {
        CLAUDE_HUB_REMOTE: `file://${hub}`,
        CLAUDE_HUB_BRANCH: 'main',
        CLAUDE_CONFIG_DIR: join(home, '.claude'),
        CLAUDE_HUB_CACHE_DIR: cacheDir,
      };

      // Run 1: publish v1 successfully. Hub main holds v1; the cache is synced.
      writeTranscript(home, 'first snapshot', {
        projectSlug: 'acme-app',
        sessionId: 'sess-x',
      });
      expect(runSync({ cwd: dir, projectsRoot, env: baseEnv }).status).toBe(0);

      // Run 2: grow to v2, then a TOTAL outage (push and recovery fetch both
      // fail) leaves the v2 commit committed-but-unpushed in the cache — the
      // only copy of v2 now lives in the cache HEAD.
      rmSync(hub, { recursive: true, force: true });
      writeTranscript(home, 'first snapshot\nsecond snapshot only in the local cache', {
        projectSlug: 'acme-app',
        sessionId: 'sess-x',
      });
      const outage = runSync({
        cwd: dir,
        projectsRoot,
        env: { ...baseEnv, CLAUDE_HUB_PUSH_RETRIES: '1' },
      });
      expect(outage.status).toBe(1);
      expect(outage.stderr).toContain('committed snapshot remains unpushed');

      // Recreate the hub at v1 only (it never received v2), so the next run's
      // fetch succeeds and prepare_hub_checkout's hard reset onto v1 would drop
      // the local v2 commit. v1 is the cache's pre-outage commit (HEAD~1).
      git(['init', '--bare', hub], dir);
      git(
        ['--git-dir', join(cacheDir, '.git'), 'push', `file://${hub}`, 'HEAD~1:refs/heads/main'],
        dir
      );

      // The source transcript is pruned before the next run — the exact window
      // where v2 would become unrecoverable without the rescue ref.
      rmSync(join(projectsRoot, 'acme-app/sess-x.jsonl'), { force: true });
      rmSync(join(projectsRoot, 'acme-app/sess-x'), { recursive: true, force: true });

      // Run 3: hub reachable again. prepare_hub_checkout fetches v1 and resets
      // over the unpushed v2 commit; the rescue ref must preserve it first.
      const run3 = runSync({ cwd: dir, projectsRoot, env: baseEnv });
      expect(run3.status, run3.stderr).toBe(0);
      expect(run3.stderr).toContain('preserved unpushed hub snapshot as rescue ref');

      // Exactly one rescue ref (only prepare_hub_checkout rescues; the in-process
      // retry loop does not), and its tree carries the v2 content that never
      // reached the hub and was pruned from the source — proving it is the LOCAL
      // discarded snapshot, recoverable from the persistent cache.
      const rescueRefs = git(
        ['for-each-ref', '--format=%(refname)', 'refs/cloud-capture/rescue'],
        cacheDir
      )
        .split('\n')
        .filter(Boolean);
      expect(rescueRefs).toHaveLength(1);
      const rescued = git(
        ['show', `${rescueRefs[0]}:projects/acme-app/sess-x.jsonl`],
        cacheDir
      );
      expect(rescued).toContain('second snapshot only in the local cache');
    });
  });
});
