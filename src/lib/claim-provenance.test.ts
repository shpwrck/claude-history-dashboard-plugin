import { describe, expect, it } from 'vitest';
import {
  validateClaimProvenance,
  type ClaimProvenance,
} from './claim-provenance';

const receipt = (): ClaimProvenance => ({
  observations: [
    {
      id: 'session.errors',
      claim: '2 tool calls recorded an error outcome',
      source: 'parse-tools',
      record: 'session-1',
      field: 'calls[].isError',
      value: 2,
    },
  ],
  derivations: [
    {
      id: 'review-queue.score',
      formula: 'base + errorCountWeight',
      operands: { base: 55, errorCountWeight: 12 },
      value: 67,
    },
  ],
  inference: 'The observed errors crossed the review threshold.',
  capturedAt: '2026-07-30T12:34:56.789Z',
  asOf: '2026-07-30',
});

describe('repository-wide claim provenance contract', () => {
  it('accepts row-addressed observations and finite derivations', () => {
    expect(validateClaimProvenance(receipt())).toEqual([]);
  });

  it('rejects malformed/non-finite derivation operands and values', () => {
    for (const derivation of [
      { id: '', formula: 'x', operands: { x: 1 }, value: 1 },
      { id: 'x', formula: '', operands: { x: 1 }, value: 1 },
      { id: 'x', formula: 'x', operands: {}, value: 1 },
      {
        id: 'x',
        formula: 'x',
        operands: { x: Number.POSITIVE_INFINITY },
        value: 1,
      },
      {
        id: 'x',
        formula: 'x',
        operands: { x: 1 },
        value: Number.NaN,
      },
    ]) {
      expect(
        validateClaimProvenance({
          ...receipt(),
          derivations: [derivation],
        }).length
      ).toBeGreaterThan(0);
    }
  });

  it('rejects duplicate derivation ids', () => {
    const derivation = receipt().derivations![0];
    expect(
      validateClaimProvenance({
        ...receipt(),
        derivations: [derivation, derivation],
      }).length
    ).toBeGreaterThan(0);
  });

  it('requires canonical capture instants and real as-of dates', () => {
    expect(
      validateClaimProvenance({
        ...receipt(),
        capturedAt: '2026-07-30T12:34:56Z',
      }).length
    ).toBeGreaterThan(0);
    expect(
      validateClaimProvenance({
        ...receipt(),
        asOf: '2026-02-30',
      }).length
    ).toBeGreaterThan(0);
  });
});
