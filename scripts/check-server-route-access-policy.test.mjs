// Unit tests for the server route access-policy inventory gate (#1180, #3825).
//
// Run:
//   node scripts/check-server-route-access-policy.test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  ROUTE_ACCESS_POLICIES,
  ROUTE_INVENTORY,
  collectServerRouteKeys,
  routeKey,
  validateRouteInventory,
} from './check-server-route-access-policy.mjs';

let failures = 0;
function check(label, fn) {
  try {
    fn();
    console.log(`  ok  ${label}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL ${label}: ${err.message}`);
  }
}

check('collector finds exact, prefix, and regex gated data routes', () => {
  const source = [
    "if (pathname === '/api/dataset.json') return;",
    "if (pathname === '/sessions-manifest.json') return;",
    "if (pathname.startsWith('/projects/')) return;",
    "if (pathname.startsWith('/api/')) return false;",
    "const t = pathname.match(/^\\/api\\/session\\/([^/]+)\\/timeline(?:\\.json)?$/);",
    "const tools = pathname.match(/^\\/api\\/session\\/([^/]+)\\/tools(?:\\.json)?$/);",
  ].join('\n');

  assert.deepEqual(collectServerRouteKeys(source).map(routeKey), [
    'exact:/api/dataset.json',
    'exact:/sessions-manifest.json',
    'prefix:/projects/',
    'regex:^\\/api\\/session\\/([^/]+)\\/timeline(?:\\.json)?$',
    'regex:^\\/api\\/session\\/([^/]+)\\/tools(?:\\.json)?$',
  ]);
});

check('collector inventories double-quoted exact and prefix handlers', () => {
  const source = [
    'if (pathname === "/api/new-sensitive-route") return;',
    'if (pathname.startsWith("/api/private/")) return;',
  ].join('\n');

  const routes = collectServerRouteKeys(source);
  assert.deepEqual(routes.map(routeKey), [
    'exact:/api/new-sensitive-route',
    'prefix:/api/private/',
  ]);
  assert.deepEqual(
    validateRouteInventory(routes, [], {}),
    [
      'exact:/api/new-sensitive-route is handled by scripts/server.mjs but missing from ROUTE_INVENTORY',
      'prefix:/api/private/ is handled by scripts/server.mjs but missing from ROUTE_INVENTORY',
    ]
  );
});

check('collector follows route tables actually dispatched by pathname', () => {
  const source = `
    const PATH_METADATA = new Map([
      ['/api/not-dispatched', describeRoute],
    ]);
    const DATASET_ROUTES = new Map([
      ['/api/table-only', handleTableOnly],
      ['/api/second-table-only', handleSecondTableOnly],
    ]);
    const route = DATASET_ROUTES.get(pathname);
  `;

  const routes = collectServerRouteKeys(source);
  assert.deepEqual(routes.map(routeKey), [
    'exact:/api/second-table-only',
    'exact:/api/table-only',
  ]);
  assert.deepEqual(
    validateRouteInventory(routes, [], {}),
    [
      'exact:/api/second-table-only is handled by scripts/server.mjs but missing from ROUTE_INVENTORY',
      'exact:/api/table-only is handled by scripts/server.mjs but missing from ROUTE_INVENTORY',
    ]
  );
});

check('inventory covers the current server route surface', () => {
  const source = readFileSync(new URL('./server.mjs', import.meta.url), 'utf8');
  const routes = collectServerRouteKeys(source);
  assert.equal(routes.length, ROUTE_INVENTORY.length);
  assert.deepEqual(
    routes.map(routeKey),
    ROUTE_INVENTORY.map(routeKey).sort((a, b) =>
      a.localeCompare(b)
    )
  );
  assert.deepEqual(validateRouteInventory(routes), []);
});

check('inventory access categories all have explicit policies', () => {
  const inventoryAccess = new Set(
    ROUTE_INVENTORY.flatMap((route) => [
      route.access,
      ...Object.values(route.methodAccess || {}),
    ])
  );
  assert.deepEqual(
    [...inventoryAccess].sort(),
    Object.keys(ROUTE_ACCESS_POLICIES).sort()
  );
});

check('checkpoint answer inventory distinguishes org read from org write', () => {
  const route = ROUTE_INVENTORY.find(
    (candidate) => candidate.kind === 'exact'
      && candidate.value === '/api/checkpoint/answers'
  );
  assert.equal(route?.access, 'organization-data');
  assert.deepEqual(route?.methodAccess, {
    POST: 'organization-efficacy-write',
  });
  assert.deepEqual(
    ROUTE_ACCESS_POLICIES['organization-efficacy-write'],
    {
      allowedPrincipals: ['admin'],
      requiredCapability: 'canWriteOrganizationData',
      scopePosture: 'org:write',
      dataBoundary: 'organization checkpoint efficacy evidence',
      transcriptExposure: 'none',
      mutating: true,
    }
  );
});

check('validator rejects handled routes missing from inventory', () => {
  const routes = [{ kind: 'exact', value: '/api/new-sensitive-route' }];
  const errors = validateRouteInventory(routes, []);
  assert.match(
    errors.join('\n'),
    /exact:\/api\/new-sensitive-route is handled/
  );
});

check('validator rejects stale inventory entries', () => {
  const inventory = [
    { kind: 'exact', value: '/api/stale-route', access: 'organization-data' },
  ];
  const errors = validateRouteInventory([], inventory);
  assert.match(
    errors.join('\n'),
    /exact:\/api\/stale-route is listed in ROUTE_INVENTORY/
  );
});

check('validator requires an access category', () => {
  const route = { kind: 'exact', value: '/api/dataset.json' };
  const errors = validateRouteInventory([route], [route]);
  assert.match(errors.join('\n'), /must declare an access category/);
});

check('validator rejects unknown access categories', () => {
  const route = {
    kind: 'exact',
    value: '/api/dataset.json',
    access: 'surprise-production-access',
  };
  const errors = validateRouteInventory([route], [route]);
  assert.match(
    errors.join('\n'),
    /declares unknown access category "surprise-production-access"/
  );
});

check('validator rejects unknown method-specific access categories', () => {
  const route = {
    kind: 'exact',
    value: '/api/checkpoint/answers',
    access: 'organization-data',
    methodAccess: { POST: 'surprise-write-access' },
  };
  const errors = validateRouteInventory([route], [route]);
  assert.match(
    errors.join('\n'),
    /methodAccess\.POST declares unknown access category "surprise-write-access"/
  );
});

check('validator rejects stale access policies', () => {
  const route = {
    kind: 'exact',
    value: '/api/dataset.json',
    access: 'scoped-or-admin-data',
  };
  const policies = {
    'scoped-or-admin-data': ROUTE_ACCESS_POLICIES['scoped-or-admin-data'],
    stale: {
      allowedPrincipals: ['admin'],
      requiredCapability: 'canReadOrganizationData',
      scopePosture: 'org:read',
      dataBoundary: 'unused',
      transcriptExposure: 'none',
      mutating: false,
    },
  };
  const errors = validateRouteInventory([route], [route], policies);
  assert.match(errors.join('\n'), /access policy "stale" is listed/);
});

check('validator requires policy posture fields', () => {
  const route = {
    kind: 'exact',
    value: '/api/dataset.json',
    access: 'scoped-or-admin-data',
  };
  const policies = {
    'scoped-or-admin-data': {
      ...ROUTE_ACCESS_POLICIES['scoped-or-admin-data'],
      transcriptExposure: '',
      mutating: 'no',
    },
  };
  const errors = validateRouteInventory([route], [route], policies);
  assert.match(errors.join('\n'), /must declare transcriptExposure/);
  assert.match(errors.join('\n'), /must declare boolean mutating/);
});

check('validator reports malformed policy objects', () => {
  const route = {
    kind: 'exact',
    value: '/api/dataset.json',
    access: 'scoped-or-admin-data',
  };
  const errors = validateRouteInventory(
    [route],
    [route],
    { 'scoped-or-admin-data': null }
  );
  assert.match(errors.join('\n'), /must declare a policy object/);
});

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nAll route access-policy inventory gate checks passed.');
