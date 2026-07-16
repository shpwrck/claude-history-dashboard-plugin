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
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js';

import { assemblePluginPayload } from './assemble-plugin-payload.mjs';

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
  const safetyRoot = await mkdtemp(join(tmpdir(), 'chd-plugin-assembly-guard-'));
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
let client;
let stateServer;
let fallbackServer;
let childStderr = '';

try {
  const suppliedPayload = process.env.PLUGIN_PAYLOAD_ROOT;
  if (suppliedPayload) {
    await cp(resolve(suppliedPayload), payloadRoot, { recursive: true });
  } else {
    const fixtureDist = join(tempRoot, 'fixture-dist');
    await mkdir(fixtureDist, { recursive: true });
    await writeFile(join(fixtureDist, 'index.html'), '<!doctype html>\n', 'utf8');
    await assemblePluginPayload({ outputDir: payloadRoot, distDir: fixtureDist });
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
  assert.equal(
    await readFile(join(payloadRoot, 'README.md'), 'utf8'),
    await readFile(resolve('docs/plugin-mirror-README.md'), 'utf8'),
    'the payload doc graph should use the marketplace-specific README'
  );

  const manifest = JSON.parse(
    await readFile(join(payloadRoot, '.claude-plugin', 'plugin.json'), 'utf8')
  );
  const declaration = manifest.mcpServers?.['claude-history-dashboard'];
  assert(declaration, 'plugin manifest must declare claude-history-dashboard MCP');

  stateServer = await listen('state-file', true);
  fallbackServer = await listen('configured-fallback', false);
  await mkdir(stateDir, { recursive: true });
  await mkdir(isolatedHome, { recursive: true });
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
    },
  });
  transport.stderr?.on('data', (chunk) => {
    childStderr += chunk.toString();
  });

  client = new Client({ name: 'plugin-payload-test', version: '1.0.0' });
  await client.connect(transport, { timeout: 10_000 });

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
