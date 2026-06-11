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
//
// Env:
//   CHD_PORT   (default 5173) -- port the dashboard server is listening on
//   CHD_HOST   (default 127.0.0.1) -- host the dashboard server is bound to
//
// The shim is stateless: every tool call does a fresh fetch to the singleton
// server. Killing the Claude Code session does not stop the dashboard server.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const PORT = Number(process.env.CHD_PORT || process.env.PORT || 5173);
const HOST = process.env.CHD_HOST || '127.0.0.1';
const BASE_URL = `http://${HOST}:${PORT}`;

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
  const { name } = request.params;

  let result;
  try {
    if (name === 'dashboard_status') {
      result = await toolDashboardStatus();
    } else if (name === 'get_recommendations') {
      result = await toolGetRecommendations();
    } else if (name === 'top_frictions') {
      result = await toolTopFrictions();
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
