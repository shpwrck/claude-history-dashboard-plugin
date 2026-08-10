import { afterEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function runDeployWithoutNode(args: string[]) {
  const root = mkdtempSync(join(tmpdir(), 'chd-deploy-no-node-'));
  roots.push(root);
  const logPath = join(root, 'engine.log');
  const dirnamePath = join(root, 'dirname');
  const podmanPath = join(root, 'podman');
  writeFileSync(dirnamePath, [
    '#!/bin/sh',
    'arg=$1',
    'case "$arg" in',
    '  */*) printf "%s\\n" "${arg%/*}" ;;',
    '  *) printf ".\\n" ;;',
    'esac',
  ].join('\n'));
  writeFileSync(podmanPath, [
    '#!/bin/sh',
    'printf "%s|%s|%s\\n" "${CHD_HOST_ENV_NAMES+x}:${CHD_HOST_ENV_NAMES-}" "${CHD_APP_IMAGE+x}:${CHD_APP_IMAGE-}" "$*" >> "$FAKE_ENGINE_LOG"',
  ].join('\n'));
  chmodSync(dirnamePath, 0o755);
  chmodSync(podmanPath, 0o755);

  const env = { ...process.env };
  delete env.CHD_APP_IMAGE;
  const result = spawnSync(
    '/usr/bin/bash',
    [resolve(process.cwd(), 'scripts/deploy.sh'), ...args],
    {
      encoding: 'utf8',
      env: {
        ...env,
        PATH: root,
        FAKE_ENGINE_LOG: logPath,
      },
    }
  );
  return {
    ...result,
    engineLog: readFileSync(logPath, 'utf8').trim().split('\n'),
  };
}

function runSourceDeployWithFailingGitTimesProducer() {
  const root = mkdtempSync(join(tmpdir(), 'chd-deploy-git-times-fail-'));
  roots.push(root);
  const scriptsDir = join(root, 'scripts');
  const binDir = join(root, 'bin');
  const deployPath = join(scriptsDir, 'deploy.sh');
  const engineLog = join(root, 'engine.log');
  const staleManifest = join(root, 'data', 'doc-git-times.json');
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  mkdirSync(join(root, 'data'), { recursive: true });
  writeFileSync(staleManifest, '{"stale":true}\n');
  writeFileSync(deployPath, readFileSync(resolve(process.cwd(), 'scripts/deploy.sh')));
  chmodSync(deployPath, 0o755);

  const nodePath = join(binDir, 'node');
  const podmanPath = join(binDir, 'podman');
  writeFileSync(
    nodePath,
    [
      '#!/bin/sh',
      'case "$*" in',
      '  *doc-git-times-generate.mjs*) exit 42 ;;',
      '  *" -e "*) printf "[]" ;;',
      '  *) exit 0 ;;',
      'esac',
    ].join('\n')
  );
  writeFileSync(
    podmanPath,
    ['#!/bin/sh', 'printf "%s\n" "$*" >> "$FAKE_ENGINE_LOG"'].join('\n')
  );
  chmodSync(nodePath, 0o755);
  chmodSync(podmanPath, 0o755);

  const result = spawnSync('/usr/bin/bash', [deployPath], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      FAKE_ENGINE_LOG: engineLog,
    },
  });
  return {
    ...result,
    engineLog: existsSync(engineLog) ? readFileSync(engineLog, 'utf8') : '',
    staleManifestExists: existsSync(staleManifest),
  };
}

describe('scripts/deploy.sh host environment snapshot', () => {
  it('refuses a source build when the packaged git-times refresh fails (#2743)', () => {
    const result = runSourceDeployWithFailingGitTimesProducer();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'refusing source build with a potentially stale manifest'
    );
    expect(result.engineLog).toBe('');
    expect(result.staleManifestExists).toBe(false);
  });

  it.each([
    {
      name: 'source --no-refresh',
      args: ['--no-refresh'],
      expectedCommands: ['compose', 'up --build -d'],
      expectedImageEnv: 'x:localhost/claude-history-dashboard:local',
    },
    {
      name: 'published --no-refresh',
      args: ['--pull', '--no-refresh'],
      expectedCommands: ['compose', 'pull', 'up -d'],
      expectedImageEnv: ':',
    },
    {
      name: 'published with best-effort refresh',
      args: ['--pull'],
      expectedCommands: ['compose', 'pull', 'up -d'],
      expectedImageEnv: ':',
    },
  ])('keeps $name deploys usable when Node is unavailable', ({
    args,
    expectedCommands,
    expectedImageEnv,
  }) => {
    const result = runDeployWithoutNode(args);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('host environment snapshot unavailable');
    expect(result.engineLog).not.toHaveLength(0);
    for (const line of result.engineLog) {
      expect(line).toMatch(/^x:\|/);
      expect(line.split('|')[1]).toBe(expectedImageEnv);
    }
    for (const command of expectedCommands) {
      expect(result.engineLog.join('\n')).toContain(command);
    }
  });
});
