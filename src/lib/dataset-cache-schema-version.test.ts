import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('dataset cache schema version wiring (#1543)', () => {
  it('salts both sourceSignature and ingest contentHash', () => {
    const src = readFileSync(join(process.cwd(), 'scripts', 'ingest.mjs'), 'utf8');

    expect(src).toMatch(/export const DATASET_ASSEMBLY_SCHEMA_VERSION = \d+/);
    expect(src).toMatch(/parts\.push\(datasetAssemblySchemaKey\(\)\)/);
    expect(src).toMatch(/hash\.update\(datasetAssemblySchemaKey\(\)\)/);
  });
});
