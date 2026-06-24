import { describe, it, expect } from 'vitest';
import { buildDatasetBody } from './dataset-body';

// #2070 (epic #1474): the served dataset body + ETag-stable bytes are built from
// a SINGLE serialization. These assert the body round-trips fully, the ETag
// bytes exclude generatedAt (so they are stable across a timestamp-only
// rebuild) and change when a row changes, and edge cases (empty stable, missing
// generatedAt, lone surrogates) stay valid.

describe('buildDatasetBody', () => {
  it('reattaches generatedAt to the body; stable bytes exclude it', () => {
    const ds = { generatedAt: '2026-06-24T00:00:00.000Z', sessions: [{ id: 'a' }], n: 1 };
    const { json, stableJson } = buildDatasetBody(ds);
    expect(JSON.parse(json)).toEqual(ds); // body round-trips with generatedAt
    expect(JSON.parse(stableJson)).toEqual({ sessions: [{ id: 'a' }], n: 1 });
    expect(stableJson.includes('generatedAt')).toBe(false);
    expect(json.startsWith('{"generatedAt":')).toBe(true);
  });

  it('ETag bytes are identical across a generatedAt-only change', () => {
    const a = buildDatasetBody({ generatedAt: 'T1', sessions: [{ id: 'a' }] });
    const b = buildDatasetBody({ generatedAt: 'T2', sessions: [{ id: 'a' }] });
    expect(a.stableJson).toBe(b.stableJson); // ETag would not move
    expect(a.json).not.toBe(b.json); // body reflects the new timestamp
  });

  it('ETag bytes change when a row changes', () => {
    const a = buildDatasetBody({ generatedAt: 'T', sessions: [{ id: 'a' }] });
    const b = buildDatasetBody({ generatedAt: 'T', sessions: [{ id: 'b' }] });
    expect(a.stableJson).not.toBe(b.stableJson);
  });

  it('handles empty stable and a missing generatedAt', () => {
    expect(buildDatasetBody({ generatedAt: 'T' }).json).toBe('{"generatedAt":"T"}');
    const { json, stableJson } = buildDatasetBody({});
    expect(JSON.parse(json)).toEqual({ generatedAt: null });
    expect(stableJson).toBe('{}');
  });

  it('scrubs lone surrogates so the body stays strict-parser valid (#1104)', () => {
    const { json, stableJson } = buildDatasetBody({ generatedAt: 'T', s: 'x\uD800y' });
    expect(() => JSON.parse(json)).not.toThrow();
    expect(stableJson.includes('\uD800')).toBe(false);
  });
});
