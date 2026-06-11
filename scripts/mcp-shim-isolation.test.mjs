#!/usr/bin/env node
// Verify the MCP shim isolation contract:
//
// 1. scripts/server.mjs must NOT import scripts/mcp-shim.mjs (not in its
//    boot graph at all).
// 2. scripts/mcp-shim.mjs MUST import @modelcontextprotocol/sdk (it's the
//    shim's sole reason for existence as a separate process).
// 3. .mcp.json must declare the shim as a stdio server so Claude Code can
//    wire it up.
//
// Run with: node scripts/mcp-shim-isolation.test.mjs

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(SCRIPTS_DIR, '..');

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) {
    process.stdout.write(`  ok  ${name}\n`);
  } else {
    failures += 1;
    process.stderr.write(`FAIL  ${name}${detail ? ` :: ${detail}` : ''}\n`);
  }
}

// ---------------------------------------------------------------------------
// 1. server.mjs must not reference mcp-shim.mjs
// ---------------------------------------------------------------------------

const serverSrc = await readFile(join(SCRIPTS_DIR, 'server.mjs'), 'utf8');

check(
  'server.mjs does not import mcp-shim.mjs',
  !serverSrc.includes('mcp-shim'),
  'Found "mcp-shim" reference inside server.mjs -- the shim must stay isolated'
);

check(
  'server.mjs does not import @modelcontextprotocol/sdk',
  !serverSrc.includes('@modelcontextprotocol/sdk'),
  'Found MCP SDK import inside server.mjs -- the SDK must only appear in mcp-shim.mjs'
);

// ---------------------------------------------------------------------------
// 2. mcp-shim.mjs must import @modelcontextprotocol/sdk
// ---------------------------------------------------------------------------

const shimSrc = await readFile(join(SCRIPTS_DIR, 'mcp-shim.mjs'), 'utf8');

check(
  'mcp-shim.mjs imports @modelcontextprotocol/sdk',
  shimSrc.includes('@modelcontextprotocol/sdk'),
  'mcp-shim.mjs must import the SDK -- it is the shim\'s sole reason for existing as a separate process'
);

check(
  'mcp-shim.mjs declares all four expected tools',
  shimSrc.includes('dashboard_status') &&
    shimSrc.includes('get_recommendations') &&
    shimSrc.includes('top_frictions'),
  'Missing one or more tool names in mcp-shim.mjs'
);

check(
  'mcp-shim.mjs uses StdioServerTransport',
  shimSrc.includes('StdioServerTransport'),
  'mcp-shim.mjs must use the official stdio transport from the SDK'
);

// ---------------------------------------------------------------------------
// 3. .mcp.json must declare the shim as a stdio server
// ---------------------------------------------------------------------------

let mcpJson;
try {
  const raw = await readFile(join(PROJECT_DIR, '.mcp.json'), 'utf8');
  mcpJson = JSON.parse(raw);
} catch (err) {
  check('.mcp.json is readable JSON', false, err.message);
  process.exit(failures > 0 ? 1 : 0);
}

check('.mcp.json has mcpServers object', typeof mcpJson?.mcpServers === 'object');

const shimEntry = mcpJson?.mcpServers?.['claude-history-dashboard'];

check(
  '.mcp.json declares claude-history-dashboard server',
  shimEntry !== undefined,
  'Expected mcpServers["claude-history-dashboard"] entry'
);

check(
  '.mcp.json uses stdio transport type',
  shimEntry?.type === 'stdio',
  `Got type: ${shimEntry?.type}`
);

check(
  '.mcp.json points to mcp-shim.mjs',
  shimEntry?.args?.some((a) => String(a).includes('mcp-shim.mjs')),
  `args: ${JSON.stringify(shimEntry?.args)}`
);

// ---------------------------------------------------------------------------
// 4. ts-resolver excludes mcp-shim.mjs from the runtime import guard
// ---------------------------------------------------------------------------

const resolverSrc = await readFile(join(SCRIPTS_DIR, 'ts-resolver.mjs'), 'utf8');

check(
  'ts-resolver.mjs excludes mcp-shim.mjs from the runtime import guard',
  resolverSrc.includes('mcp-shim.mjs'),
  'ts-resolver.mjs should explicitly exclude mcp-shim.mjs from the boot-graph guard'
);

if (failures > 0) process.exit(1);
