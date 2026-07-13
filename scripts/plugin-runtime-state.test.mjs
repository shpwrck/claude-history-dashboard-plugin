#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  configuredMcpPort,
  preferredDashboardPort,
  readActiveDashboardPort,
} from './plugin-runtime-state.mjs';

test('plugin supervisor honors a valid PORT preference', () => {
  assert.equal(preferredDashboardPort({ PORT: '6412' }), 6412);
});

test('plugin supervisor rejects invalid PORT preferences', () => {
  assert.equal(preferredDashboardPort({ PORT: '' }), 5173);
  assert.equal(preferredDashboardPort({ PORT: 'not-a-port' }), 5173);
  assert.equal(preferredDashboardPort({ PORT: '70000' }), 5173);
  assert.equal(preferredDashboardPort({ PORT: '-1' }), 5173);
});

test('plugin supervisor wires the PORT preference into free-port selection', async () => {
  // CI also covers Node 22, while the supervisor intentionally preflights for
  // Node 24 before dispatch. Lock the small CLI wiring here and exercise it for
  // real in the Node 24 publish smoke path.
  const source = await readFile(
    new URL('./plugin-ctl.mjs', import.meta.url),
    'utf8'
  );
  assert.match(
    source,
    /freePort\(preferredDashboardPort\(process\.env\)\)/
  );
});

test('MCP fallback prefers CHD_PORT, then PORT, then 5173', () => {
  assert.equal(configuredMcpPort({ CHD_PORT: '6200', PORT: '6300' }), 6200);
  assert.equal(configuredMcpPort({ CHD_PORT: 'bad', PORT: '6300' }), 6300);
  assert.equal(configuredMcpPort({}), 5173);
});

test('runtime state file wins and malformed state falls back', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chd-plugin-runtime-state-'));
  try {
    await mkdir(root, { recursive: true });
    const env = { CHD_CACHE_DIR: root, CHD_PORT: '6200' };
    await writeFile(join(root, 'plugin-ctl.port'), '6412\n', 'utf8');
    assert.equal(await readActiveDashboardPort(env), 6412);

    await writeFile(join(root, 'plugin-ctl.port'), 'invalid\n', 'utf8');
    assert.equal(await readActiveDashboardPort(env), 6200);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
