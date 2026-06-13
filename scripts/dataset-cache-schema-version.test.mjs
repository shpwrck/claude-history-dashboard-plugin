// Regression coverage for persisted dataset cache invalidation (#1543).
//
// The dataset_cache table stores compressed `/api/dataset.json` bodies across
// deploys. If assembleDataset() changes shape while source artifacts do not,
// a source-only content hash can reuse JSON built by older code. The exported
// schema key must therefore feed both the cheap source signature and the
// contentHash gate returned by ingest().

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));

async function loadIngest(home) {
  process.env.HOME = home;
  process.env.CHD_DB_PATH = join(tmpdir(), `chd-1543-db-${randomUUID()}.db`);
  return import(`./ingest.mjs?fixture=${randomUUID()}`);
}

test('dataset assembly schema key feeds sourceSignature and ingest content hash (#1543)', async () => {
  const origHome = process.env.HOME;
  const origDb = process.env.CHD_DB_PATH;
  const home = join(tmpdir(), `chd-1543-home-${randomUUID()}`);
  mkdirSync(join(home, '.claude', 'projects'), { recursive: true });

  try {
    const ingest = await loadIngest(home);
    assert.equal(typeof ingest.DATASET_ASSEMBLY_SCHEMA_VERSION, 'number');
    assert.ok(ingest.DATASET_ASSEMBLY_SCHEMA_VERSION > 0);

    const key = ingest.datasetAssemblySchemaKey();
    assert.equal(key, `dataset-schema:v${ingest.DATASET_ASSEMBLY_SCHEMA_VERSION}`);
    assert.match(
      ingest.sourceSignature(),
      new RegExp(`(^|\\\\|)${key.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}(\\\\||$)`)
    );

    const src = readFileSync(join(HERE, 'ingest.mjs'), 'utf8');
    assert.match(
      src,
      /hash\.update\(datasetAssemblySchemaKey\(\)\)/,
      'ingest() contentHash must include the dataset schema key'
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origDb === undefined) delete process.env.CHD_DB_PATH;
    else process.env.CHD_DB_PATH = origDb;
  }
});
