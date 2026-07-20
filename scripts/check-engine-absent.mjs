#!/usr/bin/env node
// #2719 (epic #2443): prove the recommendation ENGINE — the detector catalog and
// `buildRecommendations` — is transitively ABSENT from an emitted browser bundle.
//
// The browser is a VIEWER of server-computed recommendation analysis; it must
// never bundle the engine (that is the whole point of the instant-load epic: a
// smaller, faster client that cannot recompute analysis). This gate greps the
// emitted assets for the `DETECTOR_CATALOG_MARKER` sentinel defined in
// `src/lib/detectors/index.ts` and referenced by `buildRecommendations`, so its
// presence in the dist means the engine leaked into the browser build.
//
// Run once per browser flavor after its build (server frontend `npm run build`
// AND SPA `npm run build:spa`), mirroring the spa-boundary dist-grep gate:
//   node scripts/check-engine-absent.mjs [distDir=dist]
//
// A leak is almost always a VALUE import of `src/lib/recommendations.ts` (or
// `./detectors`) reaching browser code — import types with `import type`, and
// import runtime helpers from the detector-free leaves (`./detectors/shared`,
// `./reclaim`, `./coverage-types`) instead of the heavy barrel.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Kept in sync with DETECTOR_CATALOG_MARKER in src/lib/detectors/index.ts.
const MARKER = 'CHD_DETECTOR_CATALOG_v2719_PRESENT';
const distDir = process.argv[2] || 'dist';

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

let files;
try {
  files = walk(distDir).filter((f) => /\.(js|mjs|cjs|html)$/.test(f));
} catch (err) {
  console.error(`check-engine-absent: cannot read ${distDir}: ${err.message}`);
  process.exit(2);
}

const hits = files.filter((f) => readFileSync(f, 'utf8').includes(MARKER));
if (hits.length > 0) {
  console.error(
    `FAIL: the recommendation engine leaked into the browser build (${distDir}).\n` +
      `The DETECTOR_CATALOG_MARKER sentinel was found in:\n` +
      hits.map((f) => `  - ${f}`).join('\n') +
      `\n\nThe browser must be a viewer of server-computed analysis (#2719): no\n` +
      `detector catalog, no buildRecommendations. Look for a VALUE import of\n` +
      `src/lib/recommendations.ts or src/lib/detectors reaching browser code and\n` +
      `repoint it at a detector-free leaf (detectors/shared, reclaim, coverage-types).`
  );
  process.exit(1);
}
console.log(
  `ok: recommendation engine absent from ${distDir} (${files.length} browser assets scanned for the catalog sentinel)`
);
