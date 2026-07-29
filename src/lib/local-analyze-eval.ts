/**
 * Free-form vs schema-constrained repair pass-rate measurement for the Tier A
 * "Analyze locally" contract (issue #2725, epic #2177).
 *
 * The epic's publish-only-if-proven principle: the schema-constrained repair
 * loop (#2682) may ship as MECHANISM, but no claim that it raises local-model
 * reliability can publish without a RECEIPT. This module measures the SAME
 * analyze-contract task two ways over a committed corpus:
 *
 *   - arm 1 "free-form": today's free-form prompt, ONE completion, no repair;
 *     a sample passes iff that single completion parses into the analyze
 *     contract (the exact `validateLocalAnalyzeOutput` used in production).
 *   - arm 2 "constrained": the schema-constrained prompt driven through the
 *     bounded validator repair loop, by calling `runLocalAnalyze` from
 *     local-analyze.ts verbatim. That function imports and runs the #2682
 *     `runRepairLoop` from schema-repair.ts, so the receipt backs the exact
 *     mechanism that ships, not a lookalike. NOTHING in this file re-implements
 *     the repair loop.
 *
 * PURE + TRANSPORT-AGNOSTIC + OFFLINE. The two arms talk to an injected
 * `endpoint` (a loopback/mock transport) — this module imports no network and
 * makes zero external calls. It is host-only test/measurement code: the CLI
 * runner lives in `scripts/local-analyze-eval-run.mjs` (ADR 0007 — inert in the
 * runtime image; never in the server boot graph).
 *
 * The emitted record `{ taskClass, nSamples, passFreeForm, passConstrained,
 * repairRoundsHistogram, asOf }` is shaped for #2138's confidence loop (sibling
 * precedent: #2317's calibration report; #2296's structured-edit eval).
 */

import {
  buildLocalAnalyzePrompt,
  extractRecommendations,
  MAX_PROMPT_RECOMMENDATIONS,
  runLocalAnalyze,
  validateLocalAnalyzeOutput,
  type LocalAnalyzeRecommendation,
  type LocalAnalyzeSend,
} from './local-analyze';
import { DEFAULT_MAX_REPAIR_ROUNDS, type RepairMessage } from './schema-repair';

/** The single task class this eval measures. */
export const ANALYZE_EVAL_TASK_CLASS = 'analyze-ranking' as const;
export type AnalyzeEvalTaskClass = typeof ANALYZE_EVAL_TASK_CLASS;

/** Which arm the mock endpoint is answering. */
export type AnalyzeEvalArm = 'free-form' | 'constrained';

/**
 * Provenance of the endpoint that produced a record: `'scripted'` = an
 * in-process synthetic fixture run (NOT a live receipt), `'live'` = a real
 * local-model transport. Stamped into the record so #2138's confidence loop —
 * and this repo's auditable-claims / publish-only-if-proven posture — can never
 * over-read a scripted fixture run as a live receipt.
 */
export type AnalyzeEvalEndpointKind = 'scripted' | 'live';

/**
 * One committed corpus sample: an analyze input (recommendation set with ids)
 * plus the synthetic model completions the mock endpoint replays for each arm.
 * `freeFormResponse` is the single free-form completion; `constrainedResponses`
 * are the per-round completions the schema-constrained repair loop consumes in
 * order (the last entry is repeated if the loop asks for more rounds).
 */
export interface AnalyzeEvalSample {
  id: string;
  recommendations: LocalAnalyzeRecommendation[];
  freeFormResponse: string;
  constrainedResponses: string[];
  model?: string;
}

/**
 * The mock/loopback transport. Given the sample, the arm, the zero-based call
 * index within that arm, and the running message list, it returns the synthetic
 * completion text. A real loopback endpoint could answer over 127.0.0.1; the
 * default {@link scriptedAnalyzeEndpoint} answers in-process from the sample's
 * scripted responses with no socket at all.
 */
export type AnalyzeEvalEndpoint = (req: {
  sample: AnalyzeEvalSample;
  arm: AnalyzeEvalArm;
  callIndex: number;
  messages: RepairMessage[];
}) => Promise<{ text: string; model?: string | null }>;

/** In-process synthetic endpoint: replays the sample's scripted responses. */
export const scriptedAnalyzeEndpoint: AnalyzeEvalEndpoint = async ({
  sample,
  arm,
  callIndex,
}) => {
  const script =
    arm === 'free-form' ? [sample.freeFormResponse] : sample.constrainedResponses;
  const idx = script.length === 0 ? 0 : Math.min(callIndex, script.length - 1);
  return { text: script[idx] ?? '', model: sample.model ?? null };
};

/** Per-sample outcome across the two arms. */
export interface AnalyzeEvalSampleOutcome {
  id: string;
  passFreeForm: boolean;
  passConstrained: boolean;
  /** Repair rounds the constrained arm spent (0 = first completion validated). */
  repairRounds: number;
}

/**
 * The two-arm comparison record. `passFreeForm`/`passConstrained` are pass
 * COUNTS (0..nSamples); `nSamples` makes the rate derivable.
 * `repairRoundsHistogram` maps a round count (as a string key) to how many
 * constrained-arm samples spent that many rounds. NOTE: a bucket merges two
 * outcomes — "passed after N repairs" and "failed, exhausted at N" — because a
 * constrained FAILURE always lands at exactly `maxRepairRounds`; cross-reference
 * `passConstrained` to separate the terminal bucket's passes from its failures.
 * Consumable by #2138's confidence loop.
 */
export interface AnalyzeEvalRecord {
  schemaVersion: 1;
  kind: 'local-analyze-repair-eval';
  /** Synthetic-vs-live provenance; see {@link AnalyzeEvalEndpointKind}. */
  endpointKind: AnalyzeEvalEndpointKind;
  taskClass: AnalyzeEvalTaskClass;
  nSamples: number;
  passFreeForm: number;
  passConstrained: number;
  /** The repair-round bound the constrained arm ran under. */
  maxRepairRounds: number;
  repairRoundsHistogram: Record<string, number>;
  asOf: string;
}

/**
 * A transport paired INSEPARABLY with its provenance (#3131).
 *
 * `endpoint` and `endpointKind` used to be independent options, so
 * `{ endpoint: scriptedAnalyzeEndpoint, endpointKind: 'live' }` was a
 * representable call — it ran the synthetic fixture and stamped the record as
 * real local-model evidence, which #2138's confidence loop then consumes as
 * calibration. Nothing detected it, because the two fields were simply never
 * compared. The repo's own test asserted that pairing worked.
 *
 * Carrying the kind ON the transport removes the pairing entirely: there is no
 * longer a field to disagree with. The only way to obtain `kind: 'live'` is
 * {@link liveAnalyzeTransport}, which refuses the scripted endpoint.
 */
export interface AnalyzeEvalTransport {
  readonly kind: AnalyzeEvalEndpointKind;
  readonly complete: AnalyzeEvalEndpoint;
}

/** The synthetic fixture transport. Always `scripted` — it cannot be relabelled. */
export const scriptedAnalyzeTransport: AnalyzeEvalTransport = Object.freeze({
  kind: 'scripted' as const,
  complete: scriptedAnalyzeEndpoint,
});

/**
 * Wrap a REAL local-model transport so its records carry live provenance.
 *
 * Refuses {@link scriptedAnalyzeEndpoint} outright: wrapping the fixture would
 * recreate the exact mislabelling this abstraction exists to prevent, one layer
 * up. A caller that genuinely wants fixture behaviour uses
 * {@link scriptedAnalyzeTransport}, which is honest about what it is.
 */
export function liveAnalyzeTransport(
  complete: AnalyzeEvalEndpoint
): AnalyzeEvalTransport {
  if (complete === scriptedAnalyzeEndpoint) {
    throw new Error(
      'liveAnalyzeTransport: refusing to label the scripted fixture endpoint as live — ' +
        'use scriptedAnalyzeTransport for fixture runs (#3131)'
    );
  }
  return Object.freeze({ kind: 'live' as const, complete });
}

export interface RunAnalyzeEvalOptions {
  samples: AnalyzeEvalSample[];
  /**
   * The transport AND its provenance, inseparable. Defaults to
   * {@link scriptedAnalyzeTransport}; a real run passes
   * {@link liveAnalyzeTransport}(realEndpoint).
   */
  transport?: AnalyzeEvalTransport;
  /** ISO timestamp stamped onto the record's `asOf`. */
  asOf: string;
  /** Repair-round bound for the constrained arm; defaults to the #2682 default. */
  maxRounds?: number;
}

/**
 * Run both arms for one sample against the endpoint. Free-form: build today's
 * free-form prompt, take a SINGLE completion, and pass iff it parses into the
 * analyze contract. Constrained: delegate to {@link runLocalAnalyze}, which runs
 * the #2682 schema-repair loop — this file never re-implements it.
 */
export async function runAnalyzeEvalSample(
  sample: AnalyzeEvalSample,
  endpoint: AnalyzeEvalEndpoint,
  maxRounds: number
): Promise<AnalyzeEvalSampleOutcome> {
  const recs = sample.recommendations;
  const validIds = recs.map((r) => r.id);
  const model = sample.model ?? 'mock-local-model';

  // Arm 1 - free-form: reuse the free-form prompt verbatim, one completion, no
  // repair. Pass iff the raw output parses into the analyze contract.
  const { system, user } = buildLocalAnalyzePrompt(recs);
  const freeFormMessages: RepairMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
  const freeFormRaw = (
    await endpoint({ sample, arm: 'free-form', callIndex: 0, messages: freeFormMessages })
  ).text;
  const passFreeForm = validateLocalAnalyzeOutput(freeFormRaw, validIds).ok;

  // Arm 2 - constrained: drive the schema-constrained + bounded repair loop by
  // calling runLocalAnalyze verbatim. The send seam adapts the endpoint to the
  // loop's transport; the repair loop itself lives in schema-repair.ts.
  let callIndex = 0;
  const send: LocalAnalyzeSend = async (messages) => {
    const res = await endpoint({ sample, arm: 'constrained', callIndex, messages });
    callIndex += 1;
    return res;
  };
  const constrained = await runLocalAnalyze({
    send,
    recommendations: recs,
    model,
    maxRounds,
  });

  return {
    id: sample.id,
    passFreeForm,
    passConstrained: constrained.schemaValid,
    repairRounds: constrained.repairRounds,
  };
}

/** Fold per-sample outcomes into the emitted two-arm record. */
export function buildAnalyzeEvalRecord(
  outcomes: AnalyzeEvalSampleOutcome[],
  meta: { asOf: string; maxRounds: number; endpointKind: AnalyzeEvalEndpointKind }
): AnalyzeEvalRecord {
  const repairRoundsHistogram: Record<string, number> = {};
  let passFreeForm = 0;
  let passConstrained = 0;
  for (const o of outcomes) {
    if (o.passFreeForm) passFreeForm += 1;
    if (o.passConstrained) passConstrained += 1;
    const key = String(o.repairRounds);
    repairRoundsHistogram[key] = (repairRoundsHistogram[key] ?? 0) + 1;
  }
  return {
    schemaVersion: 1,
    kind: 'local-analyze-repair-eval',
    endpointKind: meta.endpointKind,
    taskClass: ANALYZE_EVAL_TASK_CLASS,
    nSamples: outcomes.length,
    passFreeForm,
    passConstrained,
    maxRepairRounds: meta.maxRounds,
    repairRoundsHistogram,
    asOf: meta.asOf,
  };
}

/** Run the full two-arm eval over the corpus and emit the comparison record. */
export async function runAnalyzeEval(
  options: RunAnalyzeEvalOptions
): Promise<AnalyzeEvalRecord> {
  const transport = options.transport ?? scriptedAnalyzeTransport;
  const maxRounds = options.maxRounds ?? DEFAULT_MAX_REPAIR_ROUNDS;
  const outcomes: AnalyzeEvalSampleOutcome[] = [];
  for (const sample of options.samples) {
    outcomes.push(await runAnalyzeEvalSample(sample, transport.complete, maxRounds));
  }
  // Provenance is read off the transport that actually ran, never from a
  // caller-supplied field (#3131).
  return buildAnalyzeEvalRecord(outcomes, {
    asOf: options.asOf,
    maxRounds,
    endpointKind: transport.kind,
  });
}

/**
 * Fail-closed parser for the committed corpus. Accepts either a bare array or a
 * `{ samples: [...] }` envelope. Reuses {@link extractRecommendations} verbatim
 * to normalize the analyze inputs, but is GENUINELY fail-closed: a sample is
 * rejected (whole corpus returns null) if any recommendation row is malformed
 * (strict extraction drops it) or if the row count exceeds
 * {@link MAX_PROMPT_RECOMMENDATIONS} (where the default cap would silently
 * truncate). A silent drop would shift `validIds` and corrupt the measurement,
 * so we refuse the corpus rather than measure the wrong thing.
 */
export function parseAnalyzeEvalCorpus(value: unknown): AnalyzeEvalSample[] | null {
  if (!value || typeof value !== 'object') return null;
  const rawSamples = Array.isArray(value)
    ? (value as unknown[])
    : Array.isArray((value as { samples?: unknown }).samples)
      ? ((value as { samples: unknown[] }).samples)
      : null;
  if (!rawSamples || rawSamples.length === 0) return null;

  const out: AnalyzeEvalSample[] = [];
  const ids = new Set<string>();
  for (const item of rawSamples) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const r = item as Record<string, unknown>;
    const id = typeof r.id === 'string' ? r.id.trim() : '';
    if (!id || !/^[a-z0-9][a-z0-9-]*$/.test(id) || ids.has(id)) return null;

    // The corpus MUST supply a bare array of recommendation rows. Reject the
    // envelope form here: the strict length comparison below needs the raw row
    // count, and the committed corpus is a plain array per sample.
    if (!Array.isArray(r.recommendations) || r.recommendations.length === 0) return null;
    // A >cap sample would be silently truncated by the default limit — refuse it.
    if (r.recommendations.length > MAX_PROMPT_RECOMMENDATIONS) return null;
    const recs = extractRecommendations(r.recommendations, MAX_PROMPT_RECOMMENDATIONS);
    // At/under the cap, extractRecommendations only drops MALFORMED rows, so a
    // count mismatch means a row was bad — reject rather than shift validIds.
    if (recs.length !== r.recommendations.length) return null;

    if (typeof r.freeFormResponse !== 'string') return null;
    if (
      !Array.isArray(r.constrainedResponses) ||
      r.constrainedResponses.length === 0 ||
      r.constrainedResponses.some((x) => typeof x !== 'string')
    ) {
      return null;
    }
    const model =
      typeof r.model === 'string' && r.model.trim() ? r.model.trim() : undefined;

    ids.add(id);
    out.push({
      id,
      recommendations: recs,
      freeFormResponse: r.freeFormResponse,
      constrainedResponses: r.constrainedResponses as string[],
      model,
    });
  }
  return out.length > 0 ? out : null;
}
