#!/usr/bin/env node
// Gate the enterprise data-route surface in scripts/server.mjs.
//
// The auth layer already fails closed for unknown /api/* routes. This inventory
// makes the review obligation explicit: when a route is added, it must be
// classified here as public, admin/org, scoped, raw-transcript, or write.

import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ALL_PRINCIPALS = Object.freeze(['anonymous', 'admin', 'member', 'viewer']);
const ADMIN_PRINCIPALS = Object.freeze(['admin']);
const SCOPED_READ_PRINCIPALS = Object.freeze([
  'admin',
  'member-with-data-root',
  'viewer-with-data-root',
]);
const SCOPED_READ_CAPABILITY =
  'canReadOrganizationData or canReadOwnSessions';
const SCOPED_READ_SCOPE =
  'org:read or sessions:read/transcripts:read with scoped data root';

export const ENTERPRISE_ROUTE_ACCESS_POLICIES = {
  'public-auth-status': {
    allowedPrincipals: ALL_PRINCIPALS,
    requiredCapability: 'auth-status',
    scopePosture: 'none',
    dataBoundary: 'authentication metadata only',
    transcriptExposure: 'none',
    mutating: false,
  },
  'admin-audit': {
    allowedPrincipals: ADMIN_PRINCIPALS,
    requiredCapability: 'canReadAuditLog',
    scopePosture: 'audit:read or org:read',
    dataBoundary: 'organization audit events',
    transcriptExposure: 'none',
    mutating: false,
  },
  'admin-organization': {
    allowedPrincipals: ADMIN_PRINCIPALS,
    requiredCapability: 'canReadOrganizationData',
    scopePosture: 'org:read',
    dataBoundary: 'organization roster and security posture',
    transcriptExposure: 'redacted aggregate only',
    mutating: false,
  },
  'admin-organization-rollup': {
    allowedPrincipals: ADMIN_PRINCIPALS,
    requiredCapability: 'canReadOrganizationRollup',
    scopePosture: 'org:read',
    dataBoundary: 'redacted organization aggregate',
    transcriptExposure: 'redacted aggregate only',
    mutating: false,
  },
  'admin-readiness-receipt': {
    allowedPrincipals: ADMIN_PRINCIPALS,
    requiredCapability: 'canReadOrganizationRollup',
    scopePosture: 'org:read',
    dataBoundary: 'redacted readiness evidence',
    transcriptExposure: 'redacted aggregate only',
    mutating: false,
  },
  'policy-write': {
    allowedPrincipals: ADMIN_PRINCIPALS,
    requiredCapability: 'canWritePolicy',
    scopePosture: 'org:write or policy:write',
    dataBoundary: 'global policy and adoption receipt writes',
    transcriptExposure: 'none',
    mutating: true,
  },
  'session-dispatch': {
    allowedPrincipals: ADMIN_PRINCIPALS,
    requiredCapability: 'canWritePolicy',
    scopePosture: 'org:write or sessions:dispatch',
    dataBoundary: 'remote session dispatch (RemoteSession CR create/list/delete)',
    transcriptExposure: 'none',
    mutating: true,
  },
  'session-ingest': {
    allowedPrincipals: ADMIN_PRINCIPALS,
    requiredCapability: 'canWritePolicy',
    scopePosture: 'sessions:ingest (bearer-token, machine-to-machine)',
    dataBoundary: 'session-data artifacts pushed by the shipper (session-data only; config/secret refused)',
    transcriptExposure: 'writes raw transcripts into the per-source ingest store',
    mutating: true,
  },
  'organization-data': {
    allowedPrincipals: ADMIN_PRINCIPALS,
    requiredCapability: 'canReadOrganizationData',
    scopePosture: 'org:read',
    dataBoundary: 'organization-derived dashboard data',
    transcriptExposure: 'derived evidence',
    mutating: false,
  },
  'scoped-or-admin-data': {
    allowedPrincipals: SCOPED_READ_PRINCIPALS,
    requiredCapability: SCOPED_READ_CAPABILITY,
    scopePosture: SCOPED_READ_SCOPE,
    dataBoundary: 'organization data for admins, own scoped root for non-admins',
    transcriptExposure: 'parsed session content',
    mutating: false,
  },
  'scoped-data': {
    allowedPrincipals: SCOPED_READ_PRINCIPALS,
    requiredCapability: SCOPED_READ_CAPABILITY,
    scopePosture: SCOPED_READ_SCOPE,
    dataBoundary: 'organization data for admins, own scoped root for non-admins',
    transcriptExposure: 'derived scoped data',
    mutating: false,
  },
  'scoped-session-list': {
    allowedPrincipals: SCOPED_READ_PRINCIPALS,
    requiredCapability: SCOPED_READ_CAPABILITY,
    scopePosture: SCOPED_READ_SCOPE,
    dataBoundary: 'organization session list for admins, own scoped root for non-admins',
    transcriptExposure: 'session metadata',
    mutating: false,
  },
  'scoped-history': {
    allowedPrincipals: SCOPED_READ_PRINCIPALS,
    requiredCapability: SCOPED_READ_CAPABILITY,
    scopePosture: SCOPED_READ_SCOPE,
    dataBoundary: 'organization history for admins, own scoped root for non-admins',
    transcriptExposure: 'raw history log',
    mutating: false,
  },
  'scoped-session-detail': {
    allowedPrincipals: SCOPED_READ_PRINCIPALS,
    requiredCapability: SCOPED_READ_CAPABILITY,
    scopePosture: SCOPED_READ_SCOPE,
    dataBoundary: 'organization session detail for admins, own scoped root for non-admins',
    transcriptExposure: 'session detail',
    mutating: false,
  },
  'raw-transcript': {
    allowedPrincipals: SCOPED_READ_PRINCIPALS,
    requiredCapability: 'canReadRawTranscripts',
    scopePosture: SCOPED_READ_SCOPE,
    dataBoundary: 'organization transcripts for admins, own scoped root for non-admins',
    transcriptExposure: 'raw transcript',
    mutating: false,
  },
  'scoped-raw-session': {
    allowedPrincipals: SCOPED_READ_PRINCIPALS,
    requiredCapability: SCOPED_READ_CAPABILITY,
    scopePosture: SCOPED_READ_SCOPE,
    dataBoundary: 'organization project files for admins, own scoped root for non-admins',
    transcriptExposure: 'raw session file',
    mutating: false,
  },
};

export const ENTERPRISE_ROUTE_INVENTORY = [
  { kind: 'exact', value: '/api/auth/session', access: 'public-auth-status' },
  { kind: 'exact', value: '/api/enterprise/audit-log', access: 'admin-audit' },
  {
    kind: 'exact',
    value: '/api/enterprise/audit-export.ndjson',
    access: 'admin-audit',
  },
  {
    kind: 'exact',
    value: '/api/enterprise/organization',
    access: 'admin-organization',
  },
  {
    kind: 'exact',
    value: '/api/enterprise/readiness-receipt',
    access: 'admin-readiness-receipt',
  },
  {
    kind: 'exact',
    value: '/api/organization/rollup.json',
    access: 'admin-organization-rollup',
  },
  { kind: 'exact', value: '/api/csrf-token', access: 'policy-write' },
  { kind: 'exact', value: '/api/policy/write', access: 'policy-write' },
  { kind: 'exact', value: '/api/adoption/receipts', access: 'organization-data' },
  { kind: 'exact', value: '/api/recommendations/reject', access: 'policy-write' },
  { kind: 'exact', value: '/api/steer-telemetry', access: 'organization-data' },
  { kind: 'exact', value: '/api/sessions', access: 'session-dispatch' },
  { kind: 'prefix', value: '/api/sessions/', access: 'session-dispatch' },
  { kind: 'regex', value: '^\\/api\\/ingest\\/([^/]+)\\/artifacts$', access: 'session-ingest' },
  { kind: 'exact', value: '/api/dataset.json', access: 'scoped-or-admin-data' },
  { kind: 'exact', value: '/api/dataset/boot', access: 'scoped-or-admin-data' },
  { kind: 'prefix', value: '/api/dataset/slice/', access: 'scoped-or-admin-data' },
  {
    kind: 'exact',
    value: '/api/recommendations.json',
    access: 'scoped-or-admin-data',
  },
  { kind: 'exact', value: '/api/search', access: 'scoped-or-admin-data' },
  { kind: 'exact', value: '/api/digest', access: 'scoped-or-admin-data' },
  {
    kind: 'regex',
    value: '^\\/api\\/sources\\/([^/]+)\\/history\\.jsonl$',
    access: 'scoped-history',
  },
  {
    kind: 'regex',
    value: '^\\/api\\/sources\\/([^/]+)\\/sessions\\/([^/]+)\\/([^/]+)$',
    access: 'scoped-raw-session',
  },
  { kind: 'exact', value: '/api/memories', access: 'scoped-data' },
  { kind: 'exact', value: '/api/workflows', access: 'scoped-data' },
  { kind: 'exact', value: '/api/experiments.json', access: 'scoped-data' },
  { kind: 'exact', value: '/api/shadow-experiments.json', access: 'scoped-data' },
  { kind: 'exact', value: '/api/usage', access: 'organization-data' },
  { kind: 'exact', value: '/api/audit.json', access: 'organization-data' },
  { kind: 'exact', value: '/api/live', access: 'scoped-or-admin-data' },
  {
    kind: 'exact',
    value: '/sessions-manifest.json',
    access: 'scoped-session-list',
  },
  { kind: 'exact', value: '/history.jsonl', access: 'scoped-history' },
  {
    kind: 'regex',
    value: '^\\/api\\/session\\/([^/]+)\\/timeline(?:\\.json)?$',
    access: 'scoped-session-detail',
  },
  {
    kind: 'regex',
    value: '^\\/api\\/session\\/([^/]+)\\/tools(?:\\.json)?$',
    access: 'scoped-session-detail',
  },
  {
    kind: 'regex',
    value: '^\\/api\\/transcript\\/([^/]+)\\/thinking$',
    access: 'raw-transcript',
  },
  {
    kind: 'regex',
    value: '^\\/api\\/transcript\\/([^/]+)$',
    access: 'raw-transcript',
  },
  { kind: 'prefix', value: '/api/transcript/', access: 'raw-transcript' },
  {
    kind: 'regex',
    value: '^\\/projects\\/([^/]+)\\/([^/]+)$',
    access: 'scoped-raw-session',
  },
  { kind: 'prefix', value: '/projects/', access: 'scoped-raw-session' },
];

const GENERIC_PREFIXES = new Set(['/api/']);

export function routeKey(route) {
  return `${route.kind}:${route.value}`;
}

export function collectEnterpriseRouteKeys(source) {
  const routes = new Map();

  for (const match of source.matchAll(/pathname\s*===\s*'([^']+)'/g)) {
    const value = match[1];
    if (isEnterpriseDataRoute(value)) {
      routes.set(routeKey({ kind: 'exact', value }), {
        kind: 'exact',
        value,
      });
    }
  }

  for (const match of source.matchAll(/pathname\.startsWith\('([^']+)'\)/g)) {
    const value = match[1];
    if (GENERIC_PREFIXES.has(value)) continue;
    if (isEnterpriseDataRoute(value)) {
      routes.set(routeKey({ kind: 'prefix', value }), {
        kind: 'prefix',
        value,
      });
    }
  }

  for (const match of source.matchAll(/pathname\.match\(\s*\/\^(.+?)\$\/\s*\)/gs)) {
    const value = `^${match[1]}$`;
    if (isEnterpriseDataRoute(regexRoutePrefix(value))) {
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

export function validateEnterpriseRouteInventory(
  sourceRoutes,
  inventory = ENTERPRISE_ROUTE_INVENTORY,
  policies = ENTERPRISE_ROUTE_ACCESS_POLICIES
) {
  const errors = [];
  const sourceKeys = new Set(sourceRoutes.map(routeKey));
  const inventoryKeys = new Set(inventory.map(routeKey));
  const usedAccess = new Set();
  const policyKeys = new Set(Object.keys(policies));

  for (const route of sourceRoutes) {
    if (!inventoryKeys.has(routeKey(route))) {
      errors.push(
        `${routeKey(route)} is handled by scripts/server.mjs but missing from ENTERPRISE_ROUTE_INVENTORY`
      );
    }
  }

  for (const route of inventory) {
    if (!sourceKeys.has(routeKey(route))) {
      errors.push(
        `${routeKey(route)} is listed in ENTERPRISE_ROUTE_INVENTORY but not found in scripts/server.mjs`
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
  }

  for (const [access, policy] of Object.entries(policies)) {
    if (!usedAccess.has(access)) {
      errors.push(
        `access policy "${access}" is listed in ENTERPRISE_ROUTE_ACCESS_POLICIES but not used by ENTERPRISE_ROUTE_INVENTORY`
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
  if (!Array.isArray(policy.allowedPrincipals) || policy.allowedPrincipals.length === 0) {
    errors.push(`access policy "${access}" must declare allowedPrincipals`);
  }
  for (const field of [
    'requiredCapability',
    'scopePosture',
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

function isEnterpriseDataRoute(value) {
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
  console.error('Enterprise route inventory gate failed.');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

function main() {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const sourcePath = join(root, 'scripts', 'server.mjs');
  const source = readFileSync(sourcePath, 'utf8');
  const sourceRoutes = collectEnterpriseRouteKeys(source);
  const errors = validateEnterpriseRouteInventory(sourceRoutes);
  report(errors);
  console.log(
    `Enterprise route inventory gate passed (${sourceRoutes.length} route pattern(s), ${Object.keys(ENTERPRISE_ROUTE_ACCESS_POLICIES).length} access policy category(s)).`
  );
}

const invokedDirectly =
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;

if (invokedDirectly) main();
