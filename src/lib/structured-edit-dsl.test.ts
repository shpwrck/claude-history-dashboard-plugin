import { describe, expect, it } from 'vitest';

import { applyEditDsl, validateEditDsl, type EditDslProgram } from './structured-edit-dsl';

const SOURCE = 'export function canRetry(a: number, max: number): boolean {\n  return a < max;\n}\n';

describe('validateEditDsl', () => {
  it('accepts a well-formed, applicable edit program', () => {
    const raw = JSON.stringify({ edits: [{ find: 'a < max', replace: 'a <= max' }] });
    const result = validateEditDsl(raw, SOURCE);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.edits).toEqual([{ find: 'a < max', replace: 'a <= max' }]);
  });

  it('tolerates code fences / surrounding prose around the JSON object', () => {
    const raw = 'Sure:\n```json\n{"edits":[{"find":"a < max","replace":"a <= max"}]}\n```';
    expect(validateEditDsl(raw, SOURCE).ok).toBe(true);
  });

  it('rejects non-JSON with a domain-phrased (not raw-parser) error', () => {
    const result = validateEditDsl('not json at all', SOURCE);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toMatch(/single JSON object/i);
      expect(result.errors.join(' ')).not.toMatch(/SyntaxError|Unexpected token/i);
    }
  });

  it('rejects an empty or missing edits array with a domain-phrased error', () => {
    const empty = validateEditDsl(JSON.stringify({ edits: [] }), SOURCE);
    const missing = validateEditDsl(JSON.stringify({ notEdits: 1 }), SOURCE);
    expect(empty.ok).toBe(false);
    expect(missing.ok).toBe(false);
    if (!empty.ok) expect(empty.errors[0]).toMatch(/at least one edit/i);
    if (!missing.ok) expect(missing.errors[0]).toMatch(/"edits" array/i);
  });

  it('rejects a non-string find/replace with domain-phrased errors', () => {
    const result = validateEditDsl(
      JSON.stringify({ edits: [{ find: 5, replace: null }] }),
      SOURCE
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => /"find" string/.test(e))).toBe(true);
      expect(result.errors.some((e) => /"replace" string/.test(e))).toBe(true);
    }
  });

  it('rejects an edit whose find text is not present in the file (hallucinated anchor)', () => {
    const raw = JSON.stringify({ edits: [{ find: 'a > max', replace: 'a >= max' }] });
    const result = validateEditDsl(raw, SOURCE);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toMatch(/was not found in the file/i);
      // Domain phrasing: it names the offending text, not a JSON path.
      expect(result.errors[0]).toContain('a > max');
    }
  });

  it('rejects a no-op edit whose find equals replace', () => {
    const raw = JSON.stringify({ edits: [{ find: 'a < max', replace: 'a < max' }] });
    const result = validateEditDsl(raw, SOURCE);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toMatch(/changes nothing/i);
  });

  it('rejects a second edit whose anchor an earlier edit consumed (in-order simulation, #3175)', () => {
    // Both edits anchor on the ONLY "abc" in the source; against the original
    // both anchors "exist", but applying edit 1 consumes it, so edit 2 has no
    // live anchor. A count/existence check passed this; in-order validation must
    // reject it, or applyEditDsl would silently skip edit 2 and present "x" as a
    // fully validated program.
    const raw = JSON.stringify({
      edits: [
        { find: 'abc', replace: 'x' },
        { find: 'abc', replace: 'y' },
      ],
    });
    const result = validateEditDsl(raw, 'abc');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Domain-phrased, names edit 2 and the consumed anchor; no raw parser trace.
      expect(result.errors.some((e) => /Edit 2/.test(e) && e.includes('abc'))).toBe(true);
      expect(result.errors.some((e) => /no longer present|already changed or consumed/i.test(e))).toBe(
        true
      );
      expect(result.errors.join(' ')).not.toMatch(/SyntaxError|Unexpected token/i);
    }
    // And the same program must NOT parse to a "valid" partial application.
    if (result.ok) throw new Error('unreachable: consumed-anchor program must not validate');
  });

  it('still accepts independent multi-edits whose anchors survive earlier edits (#3175 regression guard)', () => {
    const raw = JSON.stringify({
      edits: [
        { find: 'a < max', replace: 'a <= max' },
        { find: 'return', replace: 'return /* checked */' },
      ],
    });
    const result = validateEditDsl(raw, SOURCE);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.edits).toHaveLength(2);
  });

  it('reports every bad edit at once (does not stop at the first)', () => {
    const raw = JSON.stringify({
      edits: [
        { find: 'a < max', replace: 'a <= max' },
        { find: 'not here', replace: 'x' },
        { find: '', replace: 'y' },
      ],
    });
    const result = validateEditDsl(raw, SOURCE);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.length).toBe(2);
  });
});

describe('applyEditDsl', () => {
  it('deterministically applies a single edit to produce the corrected file', () => {
    const program: EditDslProgram = { edits: [{ find: 'a < max', replace: 'a <= max' }] };
    const expected = SOURCE.replace('a < max', 'a <= max');
    expect(applyEditDsl(SOURCE, program)).toBe(expected);
  });

  it('replaces only the first (leftmost) occurrence of find', () => {
    const source = 'x = 1; x = 1;';
    const program: EditDslProgram = { edits: [{ find: 'x = 1', replace: 'x = 2' }] };
    expect(applyEditDsl(source, program)).toBe('x = 2; x = 1;');
  });

  it('applies multiple independent edits in order', () => {
    const source = 'const a = 1;\nconst b = 2;\n';
    const program: EditDslProgram = {
      edits: [
        { find: 'a = 1', replace: 'a = 10' },
        { find: 'b = 2', replace: 'b = 20' },
      ],
    };
    expect(applyEditDsl(source, program)).toBe('const a = 10;\nconst b = 20;\n');
  });

  it('is a total function: an edit whose find is gone is skipped, never throws', () => {
    const source = 'value';
    const program: EditDslProgram = { edits: [{ find: 'absent', replace: 'x' }] };
    expect(applyEditDsl(source, program)).toBe('value');
  });
});
