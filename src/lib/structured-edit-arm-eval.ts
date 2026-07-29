/**
 * Free-form vs schema-constrained repair measurement for EDIT-class tasks over
 * the structured-edit corpus (issue #2726, epic #2177). The edit-class sibling
 * of local-analyze-eval.ts (#2725): same publish-only-if-proven shape, adapted
 * to edits.
 *
 * The two arms answer the SAME structured-edit task (fix one surgical operator
 * bug in a small TypeScript file):
 *
 *   - arm 1 "free-form": ask the model for the COMPLETE corrected file, ONE
 *     completion, no repair. The completion IS the produced file.
 *   - arm 2 "constrained": ask the model for the edit-DSL from
 *     structured-edit-dsl.ts, drive it through the #2682 bounded validator repair
 *     loop by calling `runRepairLoop` from schema-repair.ts VERBATIM, then
 *     deterministically `applyEditDsl` the validated program to the source. On
 *     repair-loop exhaustion the produced file is the source unchanged (an honest
 *     no-op that fails quality scoring). NOTHING here re-implements the loop.
 *
 * This module GENERATES each arm's produced file + the constrained arm's repair
 * telemetry; it never scores quality. Quality scoring reuses the existing
 * offline `scoreStructuredEdit` path in the host-only runner (the DIRs this feeds
 * are `--responses`-scoreable by scripts/model-eval-run.mjs). The per-task
 * outcomes then fold into `buildStructuredEditArmComparison`
 * (structured-edit-eval.ts).
 *
 * PURE + TRANSPORT-AGNOSTIC + OFFLINE. The arms talk to an injected `endpoint`
 * (a loopback/mock transport); this module imports no network and makes zero
 * external calls. It is host-only measurement code — the CLI runner lives in
 * scripts/structured-edit-arm-run.mjs (ADR 0007: inert in the runtime image).
 */

import {
  runRepairLoop,
  type RepairMessage,
} from './schema-repair';
import { applyEditDsl, validateEditDsl, type EditDslProgram } from './structured-edit-dsl';
import { TASK_CLASSES, type TaskClass } from './task-class';
import type { StructuredEditArm } from './structured-edit-eval';
import type { StructuredEditArmEndpointKind } from './structured-edit-eval';

/**
 * One committed corpus sample: a structured-edit task plus the synthetic model
 * completions the mock endpoint replays for each arm. `source` is the file to
 * edit; `expected` is the target file the host-only scorer compares against.
 * `freeFormResponse` is the single free-form completion (the whole produced
 * file); `constrainedResponses` are the per-round edit-DSL completions the
 * repair loop consumes in order (the last entry repeats if the loop asks for
 * more rounds).
 */
export interface StructuredEditArmSample {
  id: string;
  taskClass: TaskClass;
  instruction: string;
  source: string;
  expected: string;
  freeFormResponse: string;
  constrainedResponses: string[];
  model?: string;
}

/**
 * The mock/loopback transport. Given the sample, the arm, the zero-based call
 * index within that arm, and the running message list, it returns the synthetic
 * completion text. A real loopback endpoint could answer over 127.0.0.1; the
 * default {@link scriptedStructuredEditEndpoint} answers in-process from the
 * sample's scripted responses with no socket at all.
 */
export type StructuredEditArmEndpoint = (req: {
  sample: StructuredEditArmSample;
  arm: StructuredEditArm;
  callIndex: number;
  messages: RepairMessage[];
}) => Promise<{ text: string; model?: string | null }>;

/**
 * A transport paired INSEPARABLY with its provenance (#3430, mirroring #3131).
 *
 * The endpoint that produced the completions and the `endpointKind` stamped
 * onto the record used to be decided in two separate places: the runner looped
 * samples through an endpoint, then ~90 lines later called the record builder
 * with a hand-written `endpointKind: 'scripted'` literal. Nothing compared them,
 * so swapping in a live endpoint while leaving the literal -- or the reverse --
 * produced a record whose provenance did not describe what ran.
 *
 * Unlike #3131 that was never reachable by one mistaken call, because no single
 * API offered both as options; it was a latent trap for the next runner. Closed
 * the same way regardless: the kind travels with the transport, so there is
 * nothing left to hand-write.
 */
export interface StructuredEditArmTransport {
  readonly kind: StructuredEditArmEndpointKind;
  readonly complete: StructuredEditArmEndpoint;
}

/** In-process synthetic endpoint: replays the sample's scripted responses. */
export const scriptedStructuredEditEndpoint: StructuredEditArmEndpoint = async ({
  sample,
  arm,
  callIndex,
}) => {
  const script =
    arm === 'free-form' ? [sample.freeFormResponse] : sample.constrainedResponses;
  const idx = script.length === 0 ? 0 : Math.min(callIndex, script.length - 1);
  return { text: script[idx] ?? '', model: sample.model ?? null };
};

export interface StructuredEditArmPrompt {
  system: string;
  user: string;
}

/** Free-form prompt: return the complete corrected file, no schema. */
export function buildFreeFormEditPrompt(
  source: string,
  instruction: string
): StructuredEditArmPrompt {
  const system =
    'You are a TypeScript code-fixing assistant. Return the COMPLETE corrected ' +
    'file contents and nothing else — no explanation, no commentary, no code ' +
    'fences.';
  const user =
    `${instruction}\n\nHere is the file to edit:\n\n${source}\n\n` +
    'Return the full corrected file.';
  return { system, user };
}

/** Schema-constrained prompt: return ONLY the edit-DSL object. */
export function buildEditDslPrompt(
  source: string,
  instruction: string
): StructuredEditArmPrompt {
  const system =
    'You are a TypeScript code-fixing assistant. Respond with ONLY a single JSON ' +
    'object, no prose and no code fences, of exactly this shape: ' +
    '{"edits": [{"find": string, "replace": string}]}. Each edit replaces the ' +
    'first occurrence of the exact "find" text with "replace". Make the smallest ' +
    'edits that fix the described bug; use exact text copied from the file and do ' +
    'not reformat or restate unchanged code.';
  const user =
    `${instruction}\n\nHere is the file to edit:\n\n${source}\n\n` +
    'Respond with only the JSON edit object described above.';
  return { system, user };
}

/** The constrained arm's produced file plus its repair telemetry. */
export interface ConstrainedEditResult {
  /** applyEditDsl(source, program) on success; the source unchanged on exhaustion. */
  content: string;
  /** True iff some completion produced a valid, applicable edit program. */
  schemaValid: boolean;
  /** Repair rounds spent (0 = the first completion validated). */
  repairRounds: number;
  /** Domain-phrased errors from the final failed attempt; [] on success. */
  errors: string[];
}

/** The constrained arm's transport seam: one completion + the model id that answered. */
export type StructuredEditSend = (
  messages: RepairMessage[]
) => Promise<{ text: string; model?: string | null }>;

/**
 * Drive the schema-constrained edit arm: prompt for the edit-DSL, validate +
 * repair through the bounded loop by calling `runRepairLoop` VERBATIM, and
 * deterministically apply the validated program to `source`. On exhaustion,
 * return the source unchanged with `schemaValid: false`. Never re-implements the
 * loop or its repair prompt.
 */
export async function runConstrainedEditRepair(opts: {
  source: string;
  instruction: string;
  send: StructuredEditSend;
  maxRounds?: number;
}): Promise<ConstrainedEditResult> {
  const { system, user } = buildEditDslPrompt(opts.source, opts.instruction);
  const loop = await runRepairLoop<EditDslProgram>({
    chat: async (messages) => (await opts.send(messages)).text,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    validate: (raw) => validateEditDsl(raw, opts.source),
    maxRounds: opts.maxRounds,
  });
  if (loop.schemaValid && loop.value) {
    return {
      content: applyEditDsl(opts.source, loop.value),
      schemaValid: true,
      repairRounds: loop.repairRounds,
      errors: [],
    };
  }
  return {
    content: opts.source,
    schemaValid: false,
    repairRounds: loop.repairRounds,
    errors: loop.errors,
  };
}

/** Both arms' produced files for one sample, plus the constrained repair telemetry. */
export interface StructuredEditArmGeneration {
  id: string;
  taskClass: TaskClass;
  /** Free-form completion, used verbatim as the produced file. */
  freeFormContent: string;
  /** Constrained arm's produced file (applied edit, or source on exhaustion). */
  constrainedContent: string;
  constrainedSchemaValid: boolean;
  repairRounds: number;
}

/** The synthetic fixture transport. Always `scripted` — it cannot be relabelled. */
export const scriptedStructuredEditTransport: StructuredEditArmTransport = Object.freeze({
  kind: 'scripted' as const,
  complete: scriptedStructuredEditEndpoint,
});

/**
 * Wrap a REAL transport so its records carry live provenance.
 *
 * Refuses {@link scriptedStructuredEditEndpoint}: wrapping the fixture would
 * recreate the mislabelling this exists to prevent, one layer up.
 */
export function liveStructuredEditTransport(
  complete: StructuredEditArmEndpoint
): StructuredEditArmTransport {
  if (complete === scriptedStructuredEditEndpoint) {
    throw new Error(
      'liveStructuredEditTransport: refusing to label the scripted fixture endpoint as live — ' +
        'use scriptedStructuredEditTransport for fixture runs (#3430)'
    );
  }
  return Object.freeze({ kind: 'live' as const, complete });
}

/**
 * Generate both arms' produced files for one sample against the endpoint.
 * Free-form: build the free-form prompt, take a SINGLE completion, use it as the
 * produced file. Constrained: delegate to {@link runConstrainedEditRepair},
 * which runs the #2682 loop. This function does NOT score quality — the host-only
 * runner scores the produced files through the existing `scoreStructuredEdit`
 * path.
 */
export async function generateStructuredEditArmSample(
  sample: StructuredEditArmSample,
  // The TRANSPORT, not a bare endpoint (#3430): the caller that supplies the
  // completions is now the same object the record's provenance is read from, so
  // the two cannot be chosen independently.
  transport: StructuredEditArmTransport,
  maxRounds?: number
): Promise<StructuredEditArmGeneration> {
  const endpoint = transport.complete;
  const { system, user } = buildFreeFormEditPrompt(sample.source, sample.instruction);
  const freeFormContent = (
    await endpoint({
      sample,
      arm: 'free-form',
      callIndex: 0,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    })
  ).text;

  let callIndex = 0;
  const send: StructuredEditSend = async (messages) => {
    const res = await endpoint({ sample, arm: 'constrained', callIndex, messages });
    callIndex += 1;
    return res;
  };
  const constrained = await runConstrainedEditRepair({
    source: sample.source,
    instruction: sample.instruction,
    send,
    maxRounds,
  });

  return {
    id: sample.id,
    taskClass: sample.taskClass,
    freeFormContent,
    constrainedContent: constrained.content,
    constrainedSchemaValid: constrained.schemaValid,
    repairRounds: constrained.repairRounds,
  };
}

function isTaskClass(value: unknown): value is TaskClass {
  return typeof value === 'string' && (TASK_CLASSES as readonly string[]).includes(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Fail-closed parser for the committed structured-edit arm corpus. Accepts a
 * bare array or a `{ samples: [...] }` envelope. Rejects the WHOLE corpus (returns
 * null) on ANY malformed sample — a bad id, an unknown/absent task class, a
 * missing/empty task field, a non-string free-form response, or empty/non-string
 * constrained responses — and, mirroring {@link parseStructuredEditCorpus},
 * requires every one of the three {@link TASK_CLASSES} to be represented so a
 * per-class comparison is never silently short a class. No silent drops.
 */
export function parseStructuredEditArmCorpus(
  value: unknown
): StructuredEditArmSample[] | null {
  if (!value || typeof value !== 'object') return null;
  const rawSamples = Array.isArray(value)
    ? (value as unknown[])
    : Array.isArray((value as { samples?: unknown }).samples)
      ? (value as { samples: unknown[] }).samples
      : null;
  if (!rawSamples || rawSamples.length === 0) return null;

  const out: StructuredEditArmSample[] = [];
  const ids = new Set<string>();
  for (const item of rawSamples) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const r = item as Record<string, unknown>;
    const id = typeof r.id === 'string' ? r.id.trim() : '';
    if (!id || !/^[a-z0-9][a-z0-9-]*$/.test(id) || ids.has(id)) return null;
    if (!isTaskClass(r.taskClass)) return null;
    if (!nonEmptyString(r.instruction) || !nonEmptyString(r.source) || !nonEmptyString(r.expected)) {
      return null;
    }
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
      taskClass: r.taskClass,
      instruction: r.instruction,
      source: r.source,
      expected: r.expected,
      freeFormResponse: r.freeFormResponse,
      constrainedResponses: r.constrainedResponses as string[],
      model,
    });
  }
  if (TASK_CLASSES.some((taskClass) => !out.some((s) => s.taskClass === taskClass))) {
    return null;
  }
  return out.length > 0 ? out : null;
}
