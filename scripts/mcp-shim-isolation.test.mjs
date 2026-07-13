#!/usr/bin/env node
// Verify the MCP shim isolation contract:
//
// 1. scripts/server.mjs must NOT import scripts/mcp-shim.mjs (not in its
//    boot graph at all). Bare-package isolation for the full transitive server
//    graph is exercised by server-runtime-import-guard.test.mjs; a source grep
//    here cannot prove that contract.
// 2. scripts/mcp-shim.mjs MUST import @modelcontextprotocol/sdk (it's the
//    shim's sole reason for existence as a separate process).
// 3. The plugin manifest must declare the shim inline so Claude Code can wire
//    it up without leaving a plugin-only .mcp.json at the repository root.
//
// Run with: node scripts/mcp-shim-isolation.test.mjs

import { access, readFile } from 'node:fs/promises';
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
    shimSrc.includes('top_frictions') &&
    shimSrc.includes('doc_neighborhood'),
  'Missing one or more tool names in mcp-shim.mjs'
);

check(
  'mcp-shim.mjs uses StdioServerTransport',
  shimSrc.includes('StdioServerTransport'),
  'mcp-shim.mjs must use the official stdio transport from the SDK'
);

// ---------------------------------------------------------------------------
// 3. plugin.json must declare the shim inline; repo root must stay clean
// ---------------------------------------------------------------------------

let pluginManifest;
try {
  const raw = await readFile(
    join(PROJECT_DIR, '.claude-plugin', 'plugin.json'),
    'utf8'
  );
  pluginManifest = JSON.parse(raw);
} catch (err) {
  check('.claude-plugin/plugin.json is readable JSON', false, err.message);
  process.exit(failures > 0 ? 1 : 0);
}

check(
  'plugin.json has inline mcpServers object',
  typeof pluginManifest?.mcpServers === 'object' &&
    !Array.isArray(pluginManifest.mcpServers)
);

const shimEntry = pluginManifest?.mcpServers?.['claude-history-dashboard'];

check(
  'plugin.json declares claude-history-dashboard server',
  shimEntry !== undefined,
  'Expected mcpServers["claude-history-dashboard"] entry'
);

check(
  'plugin.json launches the MCP server with Node',
  shimEntry?.command === 'node',
  `Got command: ${shimEntry?.command}`
);

check(
  'plugin.json points to mcp-shim.mjs',
  shimEntry?.args?.some((a) => String(a).includes('mcp-shim.mjs')),
  `args: ${JSON.stringify(shimEntry?.args)}`
);

let rootMcpExists = true;
try {
  await access(join(PROJECT_DIR, '.mcp.json'));
} catch {
  rootMcpExists = false;
}
check(
  'repository root has no plugin-only .mcp.json',
  !rootMcpExists,
  'A repo-root descriptor is auto-loaded as project config without CLAUDE_PLUGIN_ROOT'
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
