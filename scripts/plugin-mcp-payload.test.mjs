#!/usr/bin/env node
// Runtime contract for the installed Claude Code plugin MCP server.
//
// The child process is always launched from an OS temp directory whose parent
// cannot contain this checkout's node_modules. That catches dependencies which
// were present while publishing but omitted from the marketplace payload.

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js';

import {
  assemblePluginPayload,
  stampedPluginManifest,
} from './assemble-plugin-payload.mjs';

// Unit: the version stamp overrides whatever version the source manifest
// carried and preserves every other key, so a stale committed plugin.json
// version can never reach the published payload (#2950).
{
  const stamped = JSON.parse(
    stampedPluginManifest('{\n  "name": "x",\n  "version": "0.0.0-stale"\n}\n', '9.9.9')
  );
  assert.equal(stamped.version, '9.9.9', 'stamp must override the source version');
  assert.equal(stamped.name, 'x', 'stamp must preserve other manifest keys');
}

const EXPECTED_TOOLS = [
  'dashboard_status',
  'doc_neighborhood',
  'get_recommendations',
  'top_frictions',
];

function cleanEnvironment() {
  // Deliberately exclude NODE_PATH and other arbitrary parent variables: the
  // child must prove it can boot from only the marketplace payload.
  return getDefaultEnvironment();
}

function expandPluginRoot(value, pluginRoot) {
  return String(value).replaceAll('${CLAUDE_PLUGIN_ROOT}', pluginRoot);
}

async function listen(marker, authRequired) {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/auth/session') {
      res.end(JSON.stringify({ authRequired, enterpriseMode: false, marker }));
      return;
    }
    if (req.url === '/api/recommendations.json') {
      res.end(JSON.stringify({ recommendations: [], marker }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found' }));
  });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  assert(address && typeof address === 'object');
  return {
    port: address.port,
    close: () => new Promise((resolveClose) => server.close(resolveClose)),
  };
}

function parseTextResult(result) {
  const text = result.content?.find((item) => item.type === 'text')?.text;
  assert.equal(typeof text, 'string', 'tool result should contain text JSON');
  return JSON.parse(text);
}

async function assertDestructiveOutputGuard() {
  const safetyRoot = await mkdtemp(
    join(tmpdir(), 'chd-plugin-assembly-guard-')
  );
  try {
    const projectDir = join(safetyRoot, 'project');
    const marker = join(safetyRoot, 'keep-me');
    await mkdir(projectDir, { recursive: true });
    await writeFile(marker, 'preserved\n', 'utf8');
    await assert.rejects(
      assemblePluginPayload({ projectDir, outputDir: safetyRoot }),
      /Refusing to remove an output path that contains the project root/
    );
    assert.equal(await readFile(marker, 'utf8'), 'preserved\n');

    const scriptsDir = join(projectDir, 'scripts');
    const sourceMarker = join(scriptsDir, 'source-file');
    await mkdir(scriptsDir, { recursive: true });
    await writeFile(sourceMarker, 'source\n', 'utf8');
    await assert.rejects(
      assemblePluginPayload({ projectDir, outputDir: scriptsDir }),
      /Refusing to remove a plugin payload source path/
    );
    assert.equal(await readFile(sourceMarker, 'utf8'), 'source\n');
  } finally {
    await rm(safetyRoot, { recursive: true, force: true });
  }
}

await assertDestructiveOutputGuard();

const tempRoot = await mkdtemp(join(tmpdir(), 'chd-plugin-mcp-payload-'));
const payloadRoot = join(tempRoot, 'plugin');
const stateDir = join(tempRoot, 'state');
const isolatedHome = join(tempRoot, 'home');
const sensitiveDocRoot = join(isolatedHome, '.claude');
const sensitiveSentinel = 'MCP_DOC_ROOT_SENTINEL_3090';
const sensitiveAlias = join(tempRoot, 'claude-data-alias');
const approvedWorkspace = join(tempRoot, 'approved-workspace');
const unapprovedRoot = join(tempRoot, 'unapproved');
const nodeSpawnMarker = join(tempRoot, 'node-spawns.log');
const nodeSpawnPreload = join(tempRoot, 'node-spawn-preload.cjs');
let client;
let stateServer;
let fallbackServer;
let childStderr = '';
let childStdout = '';

try {
  const suppliedPayload = process.env.PLUGIN_PAYLOAD_ROOT;
  if (suppliedPayload) {
    await cp(resolve(suppliedPayload), payloadRoot, { recursive: true });
  } else {
    const fixtureDist = join(tempRoot, 'fixture-dist');
    await mkdir(fixtureDist, { recursive: true });
    await writeFile(
      join(fixtureDist, 'index.html'),
      '<!doctype html>\n',
      'utf8'
    );
    await assemblePluginPayload({
      outputDir: payloadRoot,
      distDir: fixtureDist,
    });
  }

  await assert.rejects(
    access(join(payloadRoot, 'node_modules')),
    undefined,
    'assembled plugin must not ship node_modules'
  );
  await assert.rejects(
    access(join(payloadRoot, '.mcp.json')),
    undefined,
    'plugin MCP config belongs inline in plugin.json, not at payload root'
  );
  await access(join(payloadRoot, 'REFERENCES.md'));
  await access(join(payloadRoot, 'docs', 'adding-a-recommendation.md'));
  await access(
    join(payloadRoot, 'scripts', 'gate-2702', 'runtime-verifier.bundle.mjs')
  );
  assert.equal(
    await readFile(join(payloadRoot, 'README.md'), 'utf8'),
    await readFile(resolve('docs/plugin-mirror-README.md'), 'utf8'),
    'the payload doc graph should use the marketplace-specific README'
  );

  const manifest = JSON.parse(
    await readFile(join(payloadRoot, '.claude-plugin', 'plugin.json'), 'utf8')
  );
  const pkg = JSON.parse(await readFile(resolve('package.json'), 'utf8'));
  assert.equal(
    manifest.version,
    pkg.version,
    'assembled plugin.json version must be stamped from package.json — no plugin-channel version skew (#2950)'
  );
  const declaration = manifest.mcpServers?.['claude-history-dashboard'];
  assert(
    declaration,
    'plugin manifest must declare claude-history-dashboard MCP'
  );

  stateServer = await listen('state-file', true);
  fallbackServer = await listen('configured-fallback', false);
  await mkdir(stateDir, { recursive: true });
  await mkdir(isolatedHome, { recursive: true });
  await mkdir(join(sensitiveDocRoot, 'docs'), { recursive: true });
  await mkdir(approvedWorkspace, { recursive: true });
  await mkdir(unapprovedRoot, { recursive: true });
  await symlink(sensitiveDocRoot, sensitiveAlias, 'dir');
  await writeFile(
    join(sensitiveDocRoot, 'docs', 'secret.md'),
    `# ${sensitiveSentinel}\n\nThis content must never enter an MCP response.\n`,
    'utf8'
  );
  await writeFile(
    join(approvedWorkspace, 'guide.md'),
    '# Approved Workspace\n\nThis document is safe to return.\n',
    'utf8'
  );
  await writeFile(
    join(unapprovedRoot, 'private.md'),
    '# Unapproved\n\nThis directory is not a configured workspace.\n',
    'utf8'
  );
  await writeFile(
    join(isolatedHome, '.claude.json'),
    JSON.stringify({
      projects: {
        [approvedWorkspace]: {},
        // The absolute ~/.claude deny must override even an accidentally
        // configured project-root entry.
        [sensitiveDocRoot]: {},
      },
    }),
    'utf8'
  );
  await writeFile(
    nodeSpawnPreload,
    [
      "const { appendFileSync } = require('node:fs');",
      "appendFileSync(process.env.MCP_SPAWN_MARKER, `${process.pid}\\n`);",
      '',
    ].join('\n'),
    'utf8'
  );
  await writeFile(
    join(stateDir, 'plugin-ctl.port'),
    String(stateServer.port),
    'utf8'
  );

  const command = expandPluginRoot(declaration.command, payloadRoot);
  const args = (declaration.args ?? []).map((arg) =>
    expandPluginRoot(arg, payloadRoot)
  );
  const declaredEnv = Object.fromEntries(
    Object.entries(declaration.env ?? {}).map(([key, value]) => [
      key,
      expandPluginRoot(value, payloadRoot),
    ])
  );
  const transport = new StdioClientTransport({
    command,
    args,
    cwd: tempRoot,
    stderr: 'pipe',
    env: {
      ...cleanEnvironment(),
      ...declaredEnv,
      HOME: isolatedHome,
      USERPROFILE: isolatedHome,
      NODE_PATH: '',
      PATH: dirname(process.execPath),
      CHD_CACHE_DIR: stateDir,
      CHD_PORT: String(fallbackServer.port),
      MCP_SPAWN_MARKER: nodeSpawnMarker,
      NODE_OPTIONS: `--require=${nodeSpawnPreload}`,
    },
  });
  transport.stderr?.on('data', (chunk) => {
    childStderr += chunk.toString();
  });

  client = new Client({ name: 'plugin-payload-test', version: '1.0.0' });
  await client.connect(transport, { timeout: 10_000 });
  transport._process?.stdout?.on('data', (chunk) => {
    childStdout += chunk.toString();
  });

  const spawnCount = async () =>
    (await readFile(nodeSpawnMarker, 'utf8')).trim().split('\n').filter(Boolean)
      .length;
  const shimOnlySpawnCount = await spawnCount();

  const listed = await client.listTools(undefined, { timeout: 10_000 });
  assert.deepEqual(
    listed.tools.map((tool) => tool.name).sort(),
    EXPECTED_TOOLS,
    'assembled plugin should initialize and expose every shipped tool'
  );

  const firstStatus = parseTextResult(
    await client.callTool(
      { name: 'dashboard_status', arguments: {} },
      undefined,
      { timeout: 10_000 }
    )
  );
  assert.equal(firstStatus.running, true);
  assert.equal(firstStatus.auth_required, true);
  assert.equal(firstStatus.url, `http://127.0.0.1:${stateServer.port}`);

  const protectedRootResult = await client.callTool(
    {
      name: 'doc_neighborhood',
      arguments: {
        anchor_doc: 'docs/secret',
        root: sensitiveDocRoot,
      },
    },
    undefined,
    { timeout: 10_000 }
  );
  assert.equal(
    protectedRootResult.isError,
    true,
    'doc_neighborhood must reject ~/.claude before producing a response'
  );
  assert.match(
    protectedRootResult.content?.find((item) => item.type === 'text')?.text ?? '',
    /protected Claude data directory/
  );
  assert.doesNotMatch(
    JSON.stringify(protectedRootResult),
    new RegExp(sensitiveSentinel),
    'the protected document sentinel must not enter the MCP response'
  );
  assert.doesNotMatch(
    childStdout,
    new RegExp(sensitiveSentinel),
    'the protected document sentinel must not enter MCP stdout'
  );
  assert.equal(
    await spawnCount(),
    shimOnlySpawnCount,
    'rejecting ~/.claude must happen before the producer process is spawned'
  );

  const protectedAliasResult = await client.callTool(
    {
      name: 'doc_neighborhood',
      arguments: {
        anchor_doc: 'secret',
        root: join(sensitiveAlias, 'docs'),
      },
    },
    undefined,
    { timeout: 10_000 }
  );
  assert.equal(
    protectedAliasResult.isError,
    true,
    'doc_neighborhood must reject symlink aliases into ~/.claude'
  );
  assert.doesNotMatch(JSON.stringify(protectedAliasResult), new RegExp(sensitiveSentinel));
  assert.doesNotMatch(childStdout, new RegExp(sensitiveSentinel));
  assert.equal(
    await spawnCount(),
    shimOnlySpawnCount,
    'rejecting a ~/.claude symlink alias must happen before producer spawn'
  );

  const unapprovedRootResult = await client.callTool(
    {
      name: 'doc_neighborhood',
      arguments: {
        anchor_doc: 'private',
        root: unapprovedRoot,
      },
    },
    undefined,
    { timeout: 10_000 }
  );
  assert.equal(
    unapprovedRootResult.isError,
    true,
    'doc_neighborhood must reject roots outside configured workspaces'
  );
  assert.equal(
    await spawnCount(),
    shimOnlySpawnCount,
    'rejecting an unapproved root must happen before producer spawn'
  );

  const approvedRootResult = await client.callTool(
    {
      name: 'doc_neighborhood',
      arguments: {
        anchor_doc: 'guide',
        root: approvedWorkspace,
      },
    },
    undefined,
    { timeout: 10_000 }
  );
  assert.notEqual(
    approvedRootResult.isError,
    true,
    'a root approved by the ~/.claude.json projects map must remain usable'
  );
  const approvedNeighborhood = parseTextResult(approvedRootResult);
  assert.deepEqual(approvedNeighborhood.anchor, { kind: 'doc', slug: 'guide' });
  assert(
    approvedNeighborhood.nodes.some(
      (node) => node.slug === 'guide' && node.path === 'guide.md'
    ),
    'approved workspace response should contain its requested document'
  );
  assert(
    (await spawnCount()) > shimOnlySpawnCount,
    'an approved workspace call should reach the producer'
  );

  // A long-lived MCP process must follow a dashboard restart onto a new port.
  await writeFile(
    join(stateDir, 'plugin-ctl.port'),
    String(fallbackServer.port),
    'utf8'
  );
  const secondStatus = parseTextResult(
    await client.callTool(
      { name: 'dashboard_status', arguments: {} },
      undefined,
      { timeout: 10_000 }
    )
  );
  assert.equal(secondStatus.running, true);
  assert.equal(secondStatus.auth_required, false);
  assert.equal(secondStatus.url, `http://127.0.0.1:${fallbackServer.port}`);

  process.stdout.write('Plugin payload MCP handshake passed.\n');
} catch (err) {
  if (childStderr) process.stderr.write(`MCP child stderr:\n${childStderr}\n`);
  throw err;
} finally {
  await client?.close().catch(() => {});
  await stateServer?.close();
  await fallbackServer?.close();
  await rm(tempRoot, { recursive: true, force: true });
}
