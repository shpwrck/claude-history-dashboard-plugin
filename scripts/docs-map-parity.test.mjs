// Seam parity for the versioned docs-map contract (#2709) — the
// doc-git-times-parity sibling.
//
// The declaration location, the reader bounds, and the deploy-side identity
// locator are consumed from several places (ingest, the Dockerfile packaging
// test, deploy.sh, base compose). A drift is a silent-death class: a moved
// relpath makes the runtime read nothing and every wrapper quietly degrades
// to null (permanent #2489 suppression); a locator dropped from BASE compose
// is silently discarded by podman-compose 1.5.0 when re-added via override.
// This fence fails CI instead.
//
// Run: node --import ./scripts/register-ts.mjs --test scripts/docs-map-parity.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DOCS_MAP_MAX_FILE_BYTES,
  DOCS_MAP_RELPATH,
  parseDocsMap,
} from '../src/lib/parse-docs-map.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('ingest derives the docs-map location from the exported seam constant', () => {
  const src = readFileSync(join(ROOT, 'scripts', 'ingest.mjs'), 'utf8');
  assert.match(
    src,
    /join\(DOC_GRAPH_ROOT, DOCS_MAP_RELPATH\)/,
    'ingest must build DOCS_MAP_PATH from the seam constant'
  );
  assert.doesNotMatch(
    src,
    /['"]docs\/docs-map\.json['"]/,
    'ingest must not re-hardcode the docs-map relpath'
  );
});

test('the committed declaration lives at the seam relpath, within the reader cap, and parses', () => {
  const path = join(ROOT, DOCS_MAP_RELPATH);
  assert.ok(existsSync(path), `expected the committed declaration at ${DOCS_MAP_RELPATH}`);
  const raw = readFileSync(path, 'utf8');
  assert.ok(
    Buffer.byteLength(raw, 'utf8') <= DOCS_MAP_MAX_FILE_BYTES,
    'the committed declaration must stay within the bounded-read cap'
  );
  assert.notEqual(
    parseDocsMap(JSON.parse(raw)),
    null,
    'the committed declaration must satisfy the strict v1 contract'
  );
});

test('the identity locator is plumbed host -> BASE compose (#2709 review)', () => {
  const deploy = readFileSync(join(ROOT, 'scripts', 'deploy.sh'), 'utf8');
  assert.match(
    deploy,
    /export CHD_DOCS_MAP_REPOSITORY/,
    'deploy.sh must derive and export the checkout slug for the gitless runtime'
  );
  assert.match(
    deploy,
    /normalizeGitRemoteUrl/,
    'deploy.sh must derive the slug through the SAME shared normalizer'
  );

  const compose = readFileSync(join(ROOT, 'docker-compose.yml'), 'utf8');
  assert.match(
    compose,
    /CHD_DOCS_MAP_REPOSITORY: \$\{CHD_DOCS_MAP_REPOSITORY:-\}/,
    'base compose must pass the locator through with an empty default'
  );

  // podman-compose 1.5.0 drops override env ADDITIONS — the locator must live
  // in the BASE file only, so an override never becomes its accidental owner.
  const override = readFileSync(join(ROOT, 'docker-compose.local.yml'), 'utf8');
  assert.doesNotMatch(
    override,
    /CHD_DOCS_MAP_REPOSITORY/,
    'the locator must stay in BASE compose (podman-compose drops override env additions)'
  );
});
