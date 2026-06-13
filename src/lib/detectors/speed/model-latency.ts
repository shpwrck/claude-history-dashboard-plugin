import type { Detector } from '../types';
import {
  aggregateModelLatency,
  type ModelLatency,
  type ModelLatencySample,
} from '../../parse-telemetry';
import { short } from '../shared';

/**
 * speed.model-latency (#915, epic #866) — a hard-gated clock detector.
 *
 * ADR 0006 only allows this finding when it is not just a cost downshift in
 * disguise. The rule therefore reads successful-path API timing only, normalizes
 * by output tokens, requires at least two measured model cohorts, and refuses to
 * emit for legacy-priced Opus 4.1 cases covered by cost.legacy-model-overpay.
 * Sparse or single-model telemetry stays dark rather than inventing a routing
 * claim.
 */

const MIN_MODELS = 2;
const MIN_SAMPLES_PER_MODEL = 2;
const MIN_OUTPUT_TOKENS = 500;
const MIN_SLOW_TOTAL_API_MS = 60_000;
const MIN_OUTLIER_RATIO = 1.5;
const MIN_DELTA_MS_PER_OUTPUT_TOKEN = 10;
const MIN_RECLAIMED_MINUTES = 1;
const WARNING_RECLAIMED_MINUTES = 10;

const LEGACY_OPUS_RE = /^claude-opus-4-1(?:-|$|\[)/;

interface Candidate {
  slow: ModelLatency;
  baseline: ModelLatency;
  reclaimedMs: number;
}

function isLegacyCostCovered(model: string): boolean {
  return LEGACY_OPUS_RE.test(model);
}

function eligible(rows: ModelLatency[]): ModelLatency[] {
  return rows.filter(
    (row) =>
      row.samples >= MIN_SAMPLES_PER_MODEL &&
      row.totalOutputTokens >= MIN_OUTPUT_TOKENS &&
      row.msPerOutputToken !== null
  );
}

function pickCandidate(samples: ModelLatencySample[]): Candidate | null {
  const rows = eligible(aggregateModelLatency(samples));
  if (rows.length < MIN_MODELS) return null;

  const slow = rows
    .filter((row) => !isLegacyCostCovered(row.model))
    .sort((a, b) => (b.msPerOutputToken ?? 0) - (a.msPerOutputToken ?? 0))[0];
  if (!slow || slow.msPerOutputToken === null) return null;
  if (slow.totalApiDurationMs < MIN_SLOW_TOTAL_API_MS) return null;

  const baseline = rows
    .filter((row) => row.model !== slow.model && row.msPerOutputToken !== null)
    .sort((a, b) => (a.msPerOutputToken ?? 0) - (b.msPerOutputToken ?? 0))[0];
  if (!baseline || baseline.msPerOutputToken === null) return null;

  const ratio = slow.msPerOutputToken / baseline.msPerOutputToken;
  const deltaMsPerOutputToken = slow.msPerOutputToken - baseline.msPerOutputToken;
  if (ratio < MIN_OUTLIER_RATIO) return null;
  if (deltaMsPerOutputToken < MIN_DELTA_MS_PER_OUTPUT_TOKEN) return null;

  const reclaimedMs = deltaMsPerOutputToken * slow.totalOutputTokens;
  if (reclaimedMs / 60_000 < MIN_RECLAIMED_MINUTES) return null;

  return { slow, baseline, reclaimedMs };
}

function fmtDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const minutes = ms / 60_000;
  if (minutes < 60) return `${minutes.toFixed(1)}m`;
  const hours = Math.floor(minutes / 60);
  const rem = Math.round(minutes % 60);
  return rem === 0 ? `${hours}h` : `${hours}h ${rem}m`;
}

function fmtMsPerToken(value: number): string {
  return `${value.toFixed(1)}ms/output token`;
}

function evidenceRows(samples: ModelLatencySample[], model: string): string[] {
  return samples
    .filter((sample) => sample.model === model)
    .sort((a, b) => b.apiDurationMs - a.apiDurationMs)
    .slice(0, 5)
    .map(
      (sample) =>
        `${short(sample.session_id)}: ${fmtDuration(sample.apiDurationMs)} API time, ${sample.outputTokens.toLocaleString()} output tokens`
    );
}

export const detector: Detector = {
  id: 'speed.model-latency',
  category: 'speed',
  dataDeps: ['modelLatency'],
  rule(input) {
    const samples = input.modelLatency ?? [];
    if (samples.length === 0) return null;

    const candidate = pickCandidate(samples);
    if (!candidate) return null;

    const reclaimedMin = Number((candidate.reclaimedMs / 60_000).toFixed(1));
    const severity =
      reclaimedMin >= WARNING_RECLAIMED_MINUTES ? 'warning' : 'info';

    return {
      id: 'speed.model-latency',
      category: 'speed',
      severity,
      title: `Route latency-sensitive work off ${candidate.slow.model}`,
      detail:
        `Successful-path telemetry shows ${candidate.slow.model} at ` +
        `${fmtMsPerToken(candidate.slow.msPerOutputToken ?? 0)} across ` +
        `${candidate.slow.samples} session(s), while ${candidate.baseline.model} ` +
        `is ${fmtMsPerToken(candidate.baseline.msPerOutputToken ?? 0)}. ` +
        `The signal comes from tengu_exit API duration, excludes the 30s slow-first-byte timeout ceiling, ` +
        `and estimates ${fmtDuration(candidate.reclaimedMs)} of clock on similar output volume.`,
      action:
        `For latency-sensitive runs that do not need ${candidate.slow.model}'s capability tier, ` +
        `route or pin that workflow to ${candidate.baseline.model} or another measured faster model. ` +
        `Keep ${candidate.slow.model} for tasks that genuinely need its capability.`,
      affected: candidate.slow.samples,
      estTimeReclaimedMin: reclaimedMin,
      view: 'recommendations',
      evidence: evidenceRows(samples, candidate.slow.model),
    };
  },
};
