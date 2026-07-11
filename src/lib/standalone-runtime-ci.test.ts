import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('standalone runtime isolation CI wiring (#1349)', () => {
  it('keeps every standalone runtime isolation suite in the required test job', () => {
    const workflow = readFileSync('.github/workflows/test.yml', 'utf8');

    for (const script of [
      'test:server-runtime-imports',
      'test:mcp-shim-isolation',
      'test:plugin-ctl',
    ]) {
      expect(workflow).toContain(`npm run ${script}`);
    }
  });
});
