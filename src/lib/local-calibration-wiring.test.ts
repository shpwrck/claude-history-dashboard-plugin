import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  assembleRecommendationInput,
  buildRecommendations,
  type RecommendationInput,
} from './recommendations';
import type { LocalCalibrationReport } from './parse-local-calibration';

/**
 * Boot-path wiring guard for #2318 (epic #2177), in the same source-level style as
 * `semantic-intent-wiring.test.ts`: vitest cannot BOOT the server module graph
 * (the #1013 zero-node_modules hazard), but it CAN pin the wiring so a refactor
 * that drops the dataset threading — or, most importantly, the restore on the
 * typed `surface=global` path the browser consumes since #2718/#2719 — fails here
 * instead of silently regressing to a /recs-only rec.
 */

const ROOT = process.cwd();
const src = readFileSync(`${ROOT}/scripts/ingest.mjs`, 'utf8');

function span(marker: string, len = 8000): string {
  const idx = src.indexOf(marker);
  expect(idx, `${marker} found in ingest.mjs`).toBeGreaterThan(-1);
  return src.slice(idx, idx + len);
}

const FRESH_PASS_REPORT: LocalCalibrationReport = {
  version: 1,
  kind: 'tier-b-calibration',
  thresholds: { minSamples: 5, minAgreement: 0.8 },
  asOf: '2026-06-15',
  classes: [
    {
      taskClass: 'mechanical',
      localModel: 'local/qwen2.5-coder',
      baselineModel: 'claude-opus-4-8',
      nRecords: 8,
      nSamples: 8,
      blindJudgeAgreement: 0.9,
      costLocal: 0.001,
      costClaude: 0.12,
      savingsUsdPerTask: 0.119,
      latency: { localMeanMs: 1200, claudeMeanMs: 3400 },
      parity: {
        held: true,
        source: 'judge-scores',
        baselineMeanScore: 8.1,
        candidateMeanScore: 8.0,
        delta: -0.1,
        rationale: null,
      },
      asOf: '2026-06-15',
      verdict: 'pass',
      reasons: ['quality parity held (delta -0.1)'],
    },
  ],
};

const NOW = Date.parse('2026-06-20T00:00:00.000Z');

function baseViews(over: Partial<RecommendationInput> = {}): RecommendationInput {
  return {
    tokenData: [],
    toolData: [],
    sessions: [],
    projects: [],
    permissionRows: [],
    apiErrors: [],
    liveConfig: null,
    ...over,
  };
}

describe('local-calibration boot wiring (#2318)', () => {
  it('reads the report as a plain local file, no query-time shell-out', () => {
    expect(src).toContain(
      "join(CLAUDE, 'shadow-calls', 'calibration-report.json')"
    );
    expect(src).toContain('function readLocalCalibration()');
    // The producer is NEVER invoked here — this is a file read only.
    const reader = span('function readLocalCalibration()', 600);
    expect(reader).toContain('parseLocalCalibration(readFileSync(LOCAL_CALIBRATION_REPORT');
    expect(reader).not.toContain('execFileSync');
    expect(reader).not.toContain('spawn');
  });

  it('folds the report into the content hash only when present (guarded)', () => {
    expect(src).toContain('if (existsSync(LOCAL_CALIBRATION_REPORT)) {');
    expect(src).toContain('hashFileSig(LOCAL_CALIBRATION_REPORT, hash);');
  });

  it('threads localCalibration from core through every recommendation-input build site', () => {
    const core = span('function assembleDatasetCore', 20000);
    expect(core).toContain('const localCalibration = readLocalCalibration();');
    expect(core).toMatch(/\n {4}localCalibration,/);

    // Inline embedded-recs input in assembleDataset.
    const dataset = span('export function assembleDataset(', 6000);
    const recsCall = dataset.indexOf('assembleRecommendationInput({');
    expect(recsCall, 'inline recs input call found').toBeGreaterThan(-1);
    expect(dataset.slice(recsCall)).toContain('localCalibration,');

    // The /recs route path.
    const ctx = span('function assembleRecommendationContext', 8000);
    expect(ctx).toContain('localCalibration: dataset.localCalibration ?? null,');

    // The light recs dataset carries it (light/full parity).
    const light = span('export function assembleRecommendationDataset', 4000);
    expect(light).toContain('localCalibration: core.localCalibration');
  });

  it('restores localCalibration on the typed surface=global path (the browser UI)', () => {
    // #2718/#2719 moved Home/Recommendations onto this typed server
    // surface; recommendationViewsFromViewData drops the server-only artifact, so
    // the server MUST restore it here or the rec is /recs-only (the BLOCKER).
    const scoped = span('function assembleScopedRecommendationResult', 8000);
    expect(scoped).toContain('localCalibration: dataset.localCalibration ?? null,');
  });

  it('a pass-row localCalibration survives assembleRecommendationInput and renders the rec', () => {
    const input = assembleRecommendationInput(
      baseViews({ localCalibration: FRESH_PASS_REPORT })
    );
    const recs = buildRecommendations(input, NOW);
    expect(recs.some((r) => r.id.startsWith('cost.local-downroute'))).toBe(true);
  });

  it('the restore is load-bearing: without localCalibration the rec does not render', () => {
    // Proves the browser envelope alone (no restore) would be dark, so the
    // surface=global restore above is not decorative.
    const input = assembleRecommendationInput(baseViews());
    const recs = buildRecommendations(input, NOW);
    expect(recs.some((r) => r.id.startsWith('cost.local-downroute'))).toBe(false);
  });
});
