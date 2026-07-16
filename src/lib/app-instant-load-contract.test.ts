import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
const reload = source.slice(
  source.indexOf('const reloadFromDisk'),
  source.indexOf('const dataAccessReady')
);

describe('App instant-load boundary', () => {
  it('locks interactions before requesting the lazy chunk', () => {
    expect(reload.indexOf('active: true')).toBeGreaterThanOrEqual(0);
    expect(reload.indexOf('active: true')).toBeLessThan(reload.indexOf("import('@instant-load')"));
  });

  it('falls back to the monolith when the lazy chunk rejects', () => {
    const catchBlock = reload.slice(reload.indexOf('} catch {'));
    expect(catchBlock).toContain('fetchDataset');
    expect(catchBlock).toContain('active: false');
  });

  it('uses an applied-dataset signal instead of session count for reload preservation', () => {
    expect(source).toContain('setDatasetApplied(true)');
    expect(source).toContain('reloadFromDisk(datasetApplied)');
    expect(source).not.toContain('reloadFromDisk(SERVER_AVAILABLE && sessions.length > 0)');
  });

  it('wires progressive slices through the targeted one-slice App seam', () => {
    const progressiveDispatcher = source.slice(
      source.indexOf('const applyDatasetSlice = useCallback'),
      source.indexOf('// Apply a fetched dataset')
    );
    expect(source).toContain('const applyDatasetSlice = useCallback');
    expect(reload).toContain('applySlice: applyDatasetSlice');
    expect(source).toContain('const exhaustive: never = key');
    expect(progressiveDispatcher).toContain("case 'docGraph':");
    expect(progressiveDispatcher).not.toContain("case 'workflows':");
  });
});
