#!/usr/bin/env node
// Server-wide route access-policy inventory for scripts/server.mjs.
//
// Every data route the server handles (/api/*, the sessions manifest, history,
// and raw project files) must be classified here with an access policy, so
// adding a route is an explicit security review rather than an accident. Each
// category records the gate the single-user server actually applies. This gate
// fails CI when a handled route is unlisted or a listed route no longer exists.

import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// What the single-user server enforces on every route before a handler runs
// (#3904, epic #3743): open on the loopback default, HTTP Basic when
// DASHBOARD_USER/DASHBOARD_PASS are configured.
const BASE_GATE = 'HTTP Basic when configured; open on the loopback default';
// passesWriteAuth() in scripts/server.mjs, layered on top of BASE_GATE.
const WRITE_GATE = `${BASE_GATE}; plus same-origin Origin, application/json body, and the per-process CSRF token`;

export const ROUTE_ACCESS_POLICIES = {
  'auth-status': {
    requestGate: BASE_GATE,
    dataBoundary: 'neutral single-user session and capability map',
    transcriptExposure: 'none',
    mutating: false,
  },
  'csrf-bootstrap': {
    requestGate: `${BASE_GATE}; GET only, body readable by same-origin pages only`,
    dataBoundary: 'per-process write CSRF token',
    transcriptExposure: 'none',
    mutating: false,
  },
  read: {
    requestGate: BASE_GATE,
    dataBoundary: 'dashboard data derived from the ingested ~/.claude roots',
    transcriptExposure: 'parsed or derived session content',
    mutating: false,
  },
  'raw-read': {
    requestGate: BASE_GATE,
    dataBoundary: 'raw history, transcript, and project files under the ingested roots',
    transcriptExposure: 'raw transcript',
    mutating: false,
  },
  'usage-gauge': {
    requestGate: `${BASE_GATE}; on a Basic server also requires DASHBOARD_ENABLE_SERVER_USAGE_GAUGE`,
    dataBoundary: 'plan-limit headers read with the host Claude OAuth credential (no ~/.claude content sent)',
    transcriptExposure: 'none',
    mutating: false,
  },
  'llm-audit': {
    requestGate: `${BASE_GATE}; runs only with DASHBOARD_ENABLE_SERVER_LLM_AUDITS and a Console API key (ADR 0008)`,
    dataBoundary: 'scrubbed derived findings sent to the Anthropic API under ADR 0008 caps',
    transcriptExposure: 'derived evidence after the egress scrub',
    mutating: false,
  },
  // Tier A "Analyze locally" (#2319, ADR 0018). POST but NON-mutating; no CSRF or
  // same-origin check yet (#3906). It reads
  // the deterministic recommendations and runs a LOCAL model over them. Egress is
  // loopback-only (assertLoopbackEndpoint) with no Anthropic API call.
  'local-analyze': {
    requestGate: `${BASE_GATE}; POST only`,
    dataBoundary: 'local-model analysis over derived recommendations; loopback-only egress (ADR 0018)',
    transcriptExposure: 'derived recommendation evidence only',
    mutating: false,
  },
  write: {
    requestGate: WRITE_GATE,
    dataBoundary: 'policy, adoption receipt, reject-signal, checkpoint answer, and remote session writes',
    transcriptExposure: 'none',
    mutating: true,
  },
  // Non-local: lists RemoteSession resources from the configured cluster.
  'dispatch-list': {
    requestGate: BASE_GATE,
    dataBoundary: 'RemoteSession list read from the configured Kubernetes cluster (non-local)',
    transcriptExposure: 'none',
    mutating: false,
  },
  ingest: {
    requestGate: `${BASE_GATE}; plus PROBAITIO_INGEST_TOKEN (Authorization Bearer, or X-CSRF-Token when HTTP Basic is on); off unless PROBAITIO_INGEST_DIR and the token are set`,
    dataBoundary: 'session-data artifacts pushed by the shipper (config and secrets refused)',
    transcriptExposure: 'writes raw transcripts into the per-source ingest store',
    mutating: true,
  },
};

export const ROUTE_INVENTORY = [
  { kind: 'exact', value: '/api/auth/session', access: 'auth-status' },
  { kind: 'exact', value: '/api/csrf-token', access: 'csrf-bootstrap' },
  { kind: 'exact', value: '/api/policy/write', access: 'write' },
  {
    kind: 'exact',
    value: '/api/adoption/receipts',
    access: 'read',
    methodAccess: { POST: 'write' },
  },
  { kind: 'exact', value: '/api/recommendations/reject', access: 'write' },
  {
    kind: 'exact',
    value: '/api/checkpoint/answers',
    access: 'read',
    methodAccess: { POST: 'write' },
  },
  { kind: 'exact', value: '/api/analyze/local', access: 'local-analyze' },
  { kind: 'exact', value: '/api/steer-telemetry', access: 'read' },
  {
    kind: 'exact',
    value: '/api/sessions',
    access: 'dispatch-list',
    methodAccess: { POST: 'write' },
  },
  { kind: 'prefix', value: '/api/sessions/', access: 'write' },
  { kind: 'regex', value: '^\\/api\\/ingest\\/([^/]+)\\/artifacts$', access: 'ingest' },
  { kind: 'exact', value: '/api/dataset.json', access: 'read' },
  { kind: 'exact', value: '/api/dataset/boot', access: 'read' },
  { kind: 'prefix', value: '/api/dataset/slice/', access: 'read' },
  { kind: 'exact', value: '/api/recommendations.json', access: 'read' },
  { kind: 'exact', value: '/api/search', access: 'read' },
  { kind: 'exact', value: '/api/digest', access: 'read' },
  {
    kind: 'regex',
    value: '^\\/api\\/sources\\/([^/]+)\\/history\\.jsonl$',
    access: 'raw-read',
  },
  {
    kind: 'regex',
    value: '^\\/api\\/sources\\/([^/]+)\\/sessions\\/([^/]+)\\/([^/]+)$',
    access: 'raw-read',
  },
  { kind: 'exact', value: '/api/memories', access: 'read' },
  { kind: 'exact', value: '/api/workflows', access: 'read' },
  { kind: 'exact', value: '/api/experiments.json', access: 'read' },
  { kind: 'exact', value: '/api/shadow-experiments.json', access: 'read' },
  { kind: 'exact', value: '/api/usage', access: 'usage-gauge' },
  { kind: 'exact', value: '/api/audit.json', access: 'llm-audit' },
  { kind: 'exact', value: '/api/live', access: 'read' },
  { kind: 'exact', value: '/sessions-manifest.json', access: 'read' },
  { kind: 'exact', value: '/history.jsonl', access: 'raw-read' },
  {
    kind: 'regex',
    value: '^\\/api\\/session\\/([^/]+)\\/timeline(?:\\.json)?$',
    access: 'read',
  },
  {
    kind: 'regex',
    value: '^\\/api\\/session\\/([^/]+)\\/tools(?:\\.json)?$',
    access: 'read',
  },
  {
    kind: 'regex',
    value: '^\\/api\\/transcript\\/([^/]+)\\/thinking$',
    access: 'raw-read',
  },
  {
    kind: 'regex',
    value: '^\\/api\\/transcript\\/([^/]+)$',
    access: 'raw-read',
  },
  {
    kind: 'regex',
    value: '^\\/projects\\/([^/]+)\\/([^/]+)$',
    access: 'raw-read',
  },
  { kind: 'prefix', value: '/projects/', access: 'raw-read' },
];

const GENERIC_PREFIXES = new Set(['/api/']);

export function routeKey(route) {
  return `${route.kind}:${route.value}`;
}

/** Identifiers the server dispatches on: `IDENT.get(pathname)`. */
export function collectPathnameQueriedMaps(source) {
  const names = [];
  for (const match of source.matchAll(
    /\b([A-Za-z_$][\w$]*)\s*\.get\(\s*pathname\s*[,)]/g
  )) {
    names.push(match[1]);
  }
  return names;
}

/**
 * Path keys from dispatched `Map([['/path', handler], ...])` declarations
 * whose identifier is actually queried with `.get(pathname)`. Parenthesis
 * matching bounds the Map argument so unrelated slash-keyed tuples elsewhere
 * in the server cannot become routes by shape alone.
 */
export function collectRouteTablePaths(source) {
  const queried = collectPathnameQueriedMaps(source);
  const paths = [];
  const declaration =
    /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*new\s+Map\(/g;
  for (const match of source.matchAll(declaration)) {
    if (!queried.includes(match[1])) continue;
    const open = match.index + match[0].length - 1;
    const body = balancedSlice(source, open);
    if (body === null) continue;
    for (const entry of body.matchAll(
      /\[\s*'(\/[^']*)'\s*,\s*[A-Za-z_$][\w$]*\s*[,\]]/g
    )) {
      paths.push(entry[1]);
    }
  }
  return paths;
}

/** Text inside `source[open]`'s balanced parentheses, or null. */
function balancedSlice(source, open) {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const character = source[index];
    if (character === '(') depth += 1;
    else if (character === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  return null;
}

export function collectServerRouteKeys(source) {
  const routes = new Map();

  for (const match of source.matchAll(/pathname\s*===\s*(['"])([^'"]+)\1/g)) {
    const value = match[2];
    if (isGatedDataRoute(value)) {
      routes.set(routeKey({ kind: 'exact', value }), {
        kind: 'exact',
        value,
      });
    }
  }

  for (const value of collectRouteTablePaths(source)) {
    if (isGatedDataRoute(value)) {
      routes.set(routeKey({ kind: 'exact', value }), {
        kind: 'exact',
        value,
      });
    }
  }

  for (const match of source.matchAll(
    /pathname\.startsWith\((['"])([^'"]+)\1\)/g
  )) {
    const value = match[2];
    if (GENERIC_PREFIXES.has(value)) continue;
    if (isGatedDataRoute(value)) {
      routes.set(routeKey({ kind: 'prefix', value }), {
        kind: 'prefix',
        value,
      });
    }
  }

  for (const match of source.matchAll(/pathname\.match\(\s*\/\^(.+?)\$\/\s*\)/gs)) {
    const value = `^${match[1]}$`;
    if (isGatedDataRoute(regexRoutePrefix(value))) {
      routes.set(routeKey({ kind: 'regex', value }), {
        kind: 'regex',
        value,
      });
    }
  }

  return [...routes.values()].sort((a, b) =>
    routeKey(a).localeCompare(routeKey(b))
  );
}

export function validateRouteInventory(
  sourceRoutes,
  inventory = ROUTE_INVENTORY,
  policies = ROUTE_ACCESS_POLICIES
) {
  const errors = [];
  const sourceKeys = new Set(sourceRoutes.map(routeKey));
  const inventoryKeys = new Set(inventory.map(routeKey));
  const usedAccess = new Set();
  const policyKeys = new Set(Object.keys(policies));

  for (const route of sourceRoutes) {
    if (!inventoryKeys.has(routeKey(route))) {
      errors.push(
        `${routeKey(route)} is handled by scripts/server.mjs but missing from ROUTE_INVENTORY`
      );
    }
  }

  for (const route of inventory) {
    if (!sourceKeys.has(routeKey(route))) {
      errors.push(
        `${routeKey(route)} is listed in ROUTE_INVENTORY but not found in scripts/server.mjs`
      );
    }
    if (!route.access?.trim()) {
      errors.push(`${routeKey(route)} must declare an access category`);
    } else if (!policyKeys.has(route.access)) {
      errors.push(
        `${routeKey(route)} declares unknown access category "${route.access}"`
      );
    } else {
      usedAccess.add(route.access);
    }
    if (
      route.methodAccess !== undefined
      && (
        !route.methodAccess
        || typeof route.methodAccess !== 'object'
        || Array.isArray(route.methodAccess)
      )
    ) {
      errors.push(`${routeKey(route)} methodAccess must be an object`);
    } else {
      for (const [method, access] of Object.entries(route.methodAccess || {})) {
        if (!/^(?:GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(method)) {
          errors.push(`${routeKey(route)} declares invalid methodAccess method "${method}"`);
        }
        if (typeof access !== 'string' || !access.trim()) {
          errors.push(`${routeKey(route)} methodAccess.${method} must declare an access category`);
        } else if (!policyKeys.has(access)) {
          errors.push(
            `${routeKey(route)} methodAccess.${method} declares unknown access category "${access}"`
          );
        } else {
          usedAccess.add(access);
        }
      }
    }
  }

  for (const [access, policy] of Object.entries(policies)) {
    if (!usedAccess.has(access)) {
      errors.push(
        `access policy "${access}" is listed in ROUTE_ACCESS_POLICIES but not used by ROUTE_INVENTORY`
      );
    }
    errors.push(...validateAccessPolicy(access, policy));
  }

  return errors;
}

function validateAccessPolicy(access, policy) {
  const errors = [];
  if (!policy || typeof policy !== 'object') {
    return [`access policy "${access}" must declare a policy object`];
  }
  for (const field of [
    'requestGate',
    'dataBoundary',
    'transcriptExposure',
  ]) {
    if (typeof policy[field] !== 'string' || policy[field].trim() === '') {
      errors.push(`access policy "${access}" must declare ${field}`);
    }
  }
  if (typeof policy.mutating !== 'boolean') {
    errors.push(`access policy "${access}" must declare boolean mutating`);
  }
  return errors;
}

function isGatedDataRoute(value) {
  return (
    value.startsWith('/api/') ||
    value === '/sessions-manifest.json' ||
    value === '/history.jsonl' ||
    value.startsWith('/projects/')
  );
}

function regexRoutePrefix(value) {
  return value
    .replace(/^\^/, '')
    .replace(/^\\\//, '/')
    .replace(/\\\//g, '/')
    .replace(/\(.+$/, '');
}

function report(errors) {
  if (errors.length === 0) return;
  console.error('Route access-policy inventory gate failed.');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

function main() {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const sourcePath = join(root, 'scripts', 'server.mjs');
  const source = readFileSync(sourcePath, 'utf8');
  const sourceRoutes = collectServerRouteKeys(source);
  const errors = validateRouteInventory(sourceRoutes);
  report(errors);
  console.log(
    `Route access-policy inventory gate passed (${sourceRoutes.length} route pattern(s), ${Object.keys(ROUTE_ACCESS_POLICIES).length} access policy category(s)).`
  );
}

const invokedDirectly =
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;

if (invokedDirectly) main();
