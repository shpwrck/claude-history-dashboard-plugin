#!/usr/bin/env node
// Isolated stdio MCP shim for the Claude History Dashboard plugin.
//
// This file is a SEPARATE PROCESS -- it is declared in .mcp.json and launched by
// Claude Code as a stdio MCP server. It is NEVER imported by scripts/server.mjs
// or anything in the server boot graph. Isolation is the only thing that keeps
// @modelcontextprotocol/sdk out of the zero-deps server runtime.
//
// Tools exposed:
//   dashboard_status      -- GET /api/status (or /api/auth/session fallback)
//   get_recommendations   -- GET /api/recommendations.json
//   top_frictions         -- GET /api/recommendations.json, returns top friction items
//   doc_neighborhood      -- LOCAL agent-inject of the #2263 doc neighborhood for
//                            a task anchor (#2322); spawns the host-side producer
//                            scripts/doc-neighborhood-inject.mjs (no server needed)
//
// Env:
//   CHD_PORT   (default 5173) -- port the dashboard server is listening on
//   CHD_HOST   (default 127.0.0.1) -- host the dashboard server is bound to
//
// The HTTP tools are stateless: every call does a fresh fetch to the singleton
// server. Killing the Claude Code session does not stop the dashboard server.
// `doc_neighborhood` is LOCAL — it computes over the repo on disk and needs no
// running server (ADR 0007 host-side artifact pattern); the TS pure logic runs
// in a short-lived child under the register-ts loader, so the shim itself stays
// a thin dispatcher and never imports the .ts / node:fs walk directly.

import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const PORT = Number(process.env.CHD_PORT || process.env.PORT || 5173);
const HOST = process.env.CHD_HOST || '127.0.0.1';
const BASE_URL = `http://${HOST}:${PORT}`;

const execFileAsync = promisify(execFile);
const SHIM_DIR = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

async function fetchJSON(path) {
  const url = `${BASE_URL}${path}`;
  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new Error(`Dashboard unreachable at ${url}: ${err.message}`);
  }
  if (!res.ok) {
    throw new Error(`Dashboard returned HTTP ${res.status} for ${path}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

async function toolDashboardStatus() {
  // Try /api/auth/session which is lightweight and always available.
  let data;
  try {
    data = await fetchJSON('/api/auth/session');
  } catch (err) {
    return {
      running: false,
      url: BASE_URL,
      error: err.message,
    };
  }
  return {
    running: true,
    url: BASE_URL,
    auth_required: data?.authRequired ?? false,
    enterprise_mode: data?.enterpriseMode ?? false,
  };
}

async function toolGetRecommendations() {
  const data = await fetchJSON('/api/recommendations.json');
  return data;
}

async function toolTopFrictions() {
  const data = await fetchJSON('/api/recommendations.json');
  // Recommendations payload is an array of rec objects; filter for friction
  // category and return the top five by severity/priority.
  const recs = Array.isArray(data)
    ? data
    : Array.isArray(data?.recommendations)
      ? data.recommendations
      : [];

  const frictions = recs
    .filter(
      (r) =>
        r?.category === 'friction' ||
        r?.kind === 'friction' ||
        r?.type === 'friction' ||
        String(r?.category).toLowerCase().includes('friction') ||
        String(r?.kind).toLowerCase().includes('friction')
    )
    .slice(0, 5);

  return {
    total_recommendations: recs.length,
    top_frictions: frictions.length > 0 ? frictions : recs.slice(0, 5),
    note:
      frictions.length === 0
        ? 'No friction-category recommendations found; showing top 5 recommendations instead.'
        : undefined,
  };
}

// Build the host-side producer's argv from the tool arguments (exactly one anchor).
function docNeighborhoodArgs(args) {
  const out = [];
  if (args.anchor_file) out.push('--file', String(args.anchor_file));
  else if (args.anchor_issue != null) out.push('--issue', String(args.anchor_issue));
  else if (args.anchor_doc) out.push('--doc', String(args.anchor_doc));
  else {
    throw new Error(
      'one of anchor_file / anchor_issue / anchor_doc is required'
    );
  }
  if (args.root) out.push('--root', String(args.root));
  if (args.max_distance != null) out.push('--max-distance', String(args.max_distance));
  if (args.max_nodes != null) out.push('--max-nodes', String(args.max_nodes));
  return out;
}

// LOCAL doc-neighborhood inject (#2322). Spawns the ADR-0007 host-side producer
// under the register-ts loader (like ingest.mjs) so the pure TS logic + the
// buildDocGraph walk run OUT of the shim process. Empty stdout means the anchor
// resolved to nothing — surfaced as an explicit `neighborhood: null` so the
// caller stays silent (inject nothing).
async function toolDocNeighborhood(args = {}) {
  const loader = join(SHIM_DIR, 'register-ts.mjs');
  const script = join(SHIM_DIR, 'doc-neighborhood-inject.mjs');
  const injectArgs = docNeighborhoodArgs(args);
  const cwd = args.root ? String(args.root) : process.cwd();

  const { stdout } = await execFileAsync(
    process.execPath,
    ['--import', loader, script, ...injectArgs],
    { cwd, timeout: 20_000, maxBuffer: 8 * 1024 * 1024 }
  );
  const out = stdout.trim();
  if (!out) {
    return {
      neighborhood: null,
      note:
        'No doc neighborhood for this anchor (empty graph, unresolved anchor, ' +
        'or empty cluster) — nothing to inject.',
    };
  }
  return JSON.parse(out);
}

// ---------------------------------------------------------------------------
// MCP server wiring
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'dashboard_status',
    description:
      'Check whether the Claude History Dashboard server is running and reachable. ' +
      'Returns { running, url, auth_required, enterprise_mode } or { running: false, error }.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_recommendations',
    description:
      'Fetch the full recommendations payload from the running dashboard server ' +
      '(same as GET /api/recommendations.json). Returns agent-behaviour findings ' +
      'covering workflow, context, reliability, and safety.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'top_frictions',
    description:
      'Fetch recommendations from the dashboard and return the top friction items ' +
      '(up to 5). Frictions are recommendations whose category/kind contains ' +
      '"friction". Falls back to the top 5 recommendations of any category if none ' +
      'are tagged as friction.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'doc_neighborhood',
    description:
      'Agent-inject the task-relevant doc NEIGHBORHOOD for an anchor (a changed ' +
      'file, an issue number, or a doc slug): the bounded, relevance-ranked cluster ' +
      "of the repo's own Markdown docs around the anchor, each with hygiene flags " +
      '(dangling / stale / contradictory) and an honest lifecycle status (a stale ' +
      'doc is "demoted" and shown "as of <date>", never as current), plus a ' +
      'structured ambiguity-trigger signal when the neighborhood carries a ' +
      'contradiction/staleness/dangling flag. Computes LOCALLY over the repo on ' +
      'disk (no running server needed). Returns { neighborhood: null } when the ' +
      'anchor resolves to nothing — inject nothing then.',
    inputSchema: {
      type: 'object',
      properties: {
        anchor_file: {
          type: 'string',
          description: 'Changed/target file path (repo-relative) to anchor on.',
        },
        anchor_issue: {
          type: 'number',
          description: 'GitHub issue number to anchor on (docs that mention it).',
        },
        anchor_doc: {
          type: 'string',
          description: 'Doc slug or .md path to anchor on directly.',
        },
        root: {
          type: 'string',
          description:
            'Repo root to build the doc graph over. Defaults to the shim cwd.',
        },
        max_distance: {
          type: 'number',
          description: 'Max hop distance from the anchor seeds (default 2).',
        },
        max_nodes: {
          type: 'number',
          description: 'Cap on ranked nodes returned (default: no cap).',
        },
      },
      required: [],
    },
  },
];

const server = new Server(
  {
    name: 'claude-history-dashboard',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: toolArgs } = request.params;

  let result;
  try {
    if (name === 'dashboard_status') {
      result = await toolDashboardStatus();
    } else if (name === 'get_recommendations') {
      result = await toolGetRecommendations();
    } else if (name === 'top_frictions') {
      result = await toolTopFrictions();
    } else if (name === 'doc_neighborhood') {
      result = await toolDocNeighborhood(toolArgs ?? {});
    } else {
      return {
        content: [
          {
            type: 'text',
            text: `Unknown tool: ${name}`,
          },
        ],
        isError: true,
      };
    }
  } catch (err) {
    return {
      content: [
        {
          type: 'text',
          text: `Tool "${name}" failed: ${err.message}`,
        },
      ],
      isError: true,
    };
  }

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(result, null, 2),
      },
    ],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
