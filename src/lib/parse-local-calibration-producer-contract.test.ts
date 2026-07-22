import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { parseLocalCalibration } from './parse-local-calibration';

const producerReceipt = readFileSync(
  new URL('../../fixtures/contracts/calibration-report-v1.pass.json', import.meta.url),
  'utf8'
);

describe('local calibration producer contract', () => {
  it('consumes the versioned producer pass fixture without dropping or coercing a field', () => {
    const raw = JSON.parse(producerReceipt);
    const parsed = parseLocalCalibration(producerReceipt);

    expect(parsed).not.toBeNull();
    expect(parsed).toEqual(raw);
    expect(parsed?.classes[0]).toMatchObject({
      taskClass: 'mechanical',
      localModel: 'local/qwen2.5-coder-32b',
      baselineModel: 'claude-opus-4-8',
      nSamples: 5,
      blindJudgeAgreement: 1,
      costLocal: 0.02,
      costClaude: 1,
      savingsUsdPerTask: 0.98,
      latency: { localMeanMs: 30_000, claudeMeanMs: 40_000 },
      asOf: '2026-07-01',
      verdict: 'pass',
    });
  });
});
