#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { parse as parseYaml } from 'yaml';

const PROJECT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const RUN_CONTAINER_PROBE =
  process.env.CHD_TEST_SPA_CONTAINER_HEALTH === '1';
const HEALTH_COMMAND =
  'wget -q --spider -T 2 "http://127.0.0.1:${SPA_PORT:-8325}/" || exit 1';
const COMPOSE_HEALTH_COMMAND =
  'wget -q --spider -T 2 "http://127.0.0.1:$${SPA_PORT:-8325}/" || exit 1';

test('SPA image and self-contained Compose declare the bounded static-root probe', () => {
  const dockerfile = readFileSync(join(PROJECT_DIR, 'Dockerfile.spa'), 'utf8');
  const instructions = dockerfile
    .split(/\r?\n/)
    .filter((line) => /^HEALTHCHECK\b/.test(line));
  assert.deepEqual(instructions, [
    `HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=3 CMD ${HEALTH_COMMAND}`,
  ]);
  assert.doesNotMatch(instructions[0], /\bcurl\b|\/api\//);

  const compose = parseYaml(
    readFileSync(join(PROJECT_DIR, 'docker-compose.spa.yml'), 'utf8'),
  );
  assert.deepEqual(compose.services.spa.healthcheck, {
    test: ['CMD-SHELL', COMPOSE_HEALTH_COMMAND],
    interval: '5s',
    timeout: '3s',
    start_period: '5s',
    retries: 3,
  });
});

function podman(args, timeout = 120_000) {
  return spawnSync('podman', args, {
    cwd: PROJECT_DIR,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    timeout,
  });
}

function expectSuccess(result, operation) {
  assert.equal(
    result.status,
    0,
    `${operation} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result.stdout.trim();
}

function inspectJson(kind, name) {
  const output = expectSuccess(
    podman([kind, 'inspect', name]),
    `podman ${kind} inspect`,
  );
  const parsed = JSON.parse(output);
  assert.equal(parsed.length, 1, `expected one ${kind} inspection`);
  return parsed[0];
}

function containerHealth(name) {
  return inspectJson('container', name).State.Health?.Status ?? 'missing';
}

async function waitForHealth(name, expected, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let observed = 'missing';
  while (Date.now() < deadline) {
    observed = containerHealth(name);
    if (observed === expected) return observed;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.equal(observed, expected, `container health did not become ${expected}`);
}

test(
  'built SPA image becomes unhealthy when nginx stops serving',
  {
    skip: RUN_CONTAINER_PROBE
      ? false
      : 'set CHD_TEST_SPA_CONTAINER_HEALTH=1 to run the Podman probe',
    timeout: 600_000,
  },
  async (t) => {
    const suffix = `${process.pid}-${randomUUID().slice(0, 8)}`;
    const image = `localhost/chd-spa-healthcheck-test:${suffix}`;
    const container = `chd-spa-healthcheck-test-${suffix}`;
    try {
      expectSuccess(
        podman(
          [
            'build',
            '--quiet',
            '--format',
            'docker',
            '--file',
            'Dockerfile.spa',
            '--tag',
            image,
            '.',
          ],
          480_000,
        ),
        'SPA image build',
      );
      // Podman's JSON schema exposes image Healthcheck at the top level; its
      // Go-template compatibility view aliases the same value as .Config.
      const healthcheck = inspectJson('image', image).Healthcheck;
      assert.deepEqual(healthcheck, {
        Test: ['CMD-SHELL', HEALTH_COMMAND],
        Interval: 5_000_000_000,
        Timeout: 3_000_000_000,
        StartPeriod: 5_000_000_000,
        Retries: 3,
      });

      expectSuccess(
        podman([
          'run',
          '--detach',
          '--name',
          container,
          '--env',
          'SPA_PORT=18325',
          image,
          '/bin/sh',
          '-c',
          '/docker-entrypoint.d/20-envsubst-on-templates.sh; ' +
            'nginx -g "daemon off;" & nginx_pid=$!; ' +
            'while kill -0 "$nginx_pid" 2>/dev/null; do sleep 1; done; ' +
            'exec tail -f /dev/null',
        ]),
        'SPA container start',
      );
      await waitForHealth(container, 'healthy', 30_000);

      const stoppedAt = Date.now();
      expectSuccess(
        podman(['exec', container, 'nginx', '-s', 'quit']),
        'nginx stop',
      );
      await waitForHealth(container, 'unhealthy', 30_000);
      const unhealthyAfterMs = Date.now() - stoppedAt;
      t.diagnostic(`SPA became unhealthy ${unhealthyAfterMs} ms after nginx stopped`);
      assert.ok(
        unhealthyAfterMs <= 30_000,
        `health transition exceeded the 30,000 ms observation budget`,
      );
    } finally {
      podman(['container', 'rm', '--force', container]);
      podman(['image', 'rm', '--force', image]);
    }
  },
);
