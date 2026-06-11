import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('dataset worker cache policy', () => {
  it('revalidates cached parsed datasets by ETag instead of bypassing cache', async () => {
    const worker = await readFile(new URL('./dataset-worker.ts', import.meta.url), 'utf8');

    expect(worker).toMatch(/indexedDB\.open/);
    expect(worker).toMatch(/If-None-Match/);
    expect(worker).toMatch(/resp\.status\s*===\s*304/);
    expect(worker).not.toMatch(/cache:\s*['"]no-store['"]/);
    expect(worker).not.toMatch(/cache:\s*['"]no-cache['"]/);
  });
});
