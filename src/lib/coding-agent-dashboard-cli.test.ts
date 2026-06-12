import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const BIN = resolve(process.cwd(), 'bin/coding-agent-dashboard.mjs');
const PACKAGE_JSON = JSON.parse(
  readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')
) as { version: string };

function runCli(args: string[], env: Record<string, string | undefined> = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function tempFixture() {
  const root = mkdtempSync(join(tmpdir(), 'cad-cli-'));
  const home = join(root, 'home');
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude.json'), '{}\n');
  const log = join(root, 'runtime.log');
  return {
    root,
    home,
    log,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function writeFakeRuntime(dir: string, name: string, infoStatus = 0) {
  const runtimePath = join(dir, name);
  writeFileSync(
    runtimePath,
    `#!/bin/sh
printf '${name}\\t%s\\n' "$*" >> "$CAD_RUNTIME_LOG"
case "$1" in
  info) exit ${infoStatus} ;;
  rm) exit 0 ;;
  run) echo fake-container-id; exit 0 ;;
  *) exit 0 ;;
esac
`
  );
  chmodSync(runtimePath, 0o755);
}

describe('coding-agent-dashboard CLI', () => {
  it('prints help and version without requiring a container runtime', () => {
    const help = runCli(['--help']);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('coding-agent-dashboard serve');
    expect(help.stdout).toContain('coding-agent-dashboard stop');

    const version = runCli(['--version']);
    expect(version.status).toBe(0);
    expect(version.stdout.trim()).toBe(PACKAGE_JSON.version);
  });

  it('rejects unknown commands with a nonzero exit and help text', () => {
    const result = runCli(['launch']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Unknown command: launch');
    expect(result.stderr).toContain('Usage:');
  });

  it('prefers podman, keeps the bind mount read-only, and passes CODING_AGENT_SOURCES through', () => {
    const fixture = tempFixture();
    try {
      writeFakeRuntime(fixture.root, 'podman');
      writeFakeRuntime(fixture.root, 'docker');
      const result = runCli(['serve', '--port', '4321'], {
        CAD_RUNTIME_LOG: fixture.log,
        CODING_AGENT_SOURCES: '[{"id":"team"}]',
        HOME: fixture.home,
        PATH: fixture.root,
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('fake-container-id');
      expect(result.stdout).toContain('http://127.0.0.1:4321');

      const log = readFileSync(fixture.log, 'utf8');
      expect(log).toContain('podman\tinfo');
      expect(log).toContain('podman\trm -f coding-agent-dashboard');
      expect(log).toContain('podman\trun --detach --name coding-agent-dashboard');
      expect(log).toContain('--publish 127.0.0.1:4321:5173');
      expect(log).toContain(`--volume ${join(fixture.home, '.claude')}:/home/node/.claude:ro`);
      expect(log).toContain(`--volume ${join(fixture.home, '.claude.json')}:/home/node/.claude.json:ro`);
      expect(log).toContain('--env CODING_AGENT_SOURCES');
      expect(log).toContain('--userns=keep-id');
      expect(log).toContain('ghcr.io/shpwrck/claude-history-dashboard:latest');
      expect(log).not.toContain('docker\t');
    } finally {
      fixture.cleanup();
    }
  });

  it('falls back to docker without podman-only flags', () => {
    const fixture = tempFixture();
    try {
      writeFakeRuntime(fixture.root, 'docker');
      const result = runCli(['serve', '--host', '0.0.0.0', '--port', '4999'], {
        CAD_RUNTIME_LOG: fixture.log,
        HOME: fixture.home,
        PATH: fixture.root,
      });

      expect(result.status).toBe(0);
      const log = readFileSync(fixture.log, 'utf8');
      expect(log).toContain('docker\tinfo');
      expect(log).toContain('--publish 0.0.0.0:4999:5173');
      expect(log).not.toContain('--userns=keep-id');
    } finally {
      fixture.cleanup();
    }
  });

  it('stop removes only the managed coding-agent-dashboard container name', () => {
    const fixture = tempFixture();
    try {
      writeFakeRuntime(fixture.root, 'podman');
      const result = runCli(['stop'], {
        CAD_RUNTIME_LOG: fixture.log,
        HOME: fixture.home,
        PATH: fixture.root + delimiter + process.env.PATH,
      });

      expect(result.status).toBe(0);
      const log = readFileSync(fixture.log, 'utf8');
      expect(log).toContain('podman\trm -f coding-agent-dashboard');
      expect(log).not.toContain('rm -f claude-history-dashboard');
    } finally {
      fixture.cleanup();
    }
  });

  it('fails serve clearly when no runtime is healthy', () => {
    const fixture = tempFixture();
    try {
      const result = runCli(['serve'], {
        CAD_RUNTIME_LOG: fixture.log,
        HOME: fixture.home,
        PATH: fixture.root,
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('Neither podman nor docker is available and healthy');
    } finally {
      fixture.cleanup();
    }
  });
});
