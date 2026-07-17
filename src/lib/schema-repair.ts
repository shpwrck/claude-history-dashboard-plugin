/**
 * Schema-constrained generate → validate → repair loop (issue #2682, epic #2177).
 *
 * Technique from "DSLs Enable Reliable Use of LLMs" — Unmesh Joshi,
 * martinfowler.com, 2026-07-14 (https://martinfowler.com/articles/llm-and-dsls.html):
 * constrain a model to a validated output shape and, on failure, re-prompt with
 * DOMAIN-PHRASED validator errors (never a raw schema trace) inside a bounded
 * loop. This raises a task class's pass rate without bigger hardware — a
 * calibration lever for the ADR 0018 Tier A "Analyze locally" surface.
 *
 * PURE + TRANSPORT-AGNOSTIC. The loop is parameterized by an injected
 * `chat(messages)` callback (precedent: local-model-client's `fetchImpl` seam)
 * and an injected `validate(raw)` that returns domain-phrased error strings. This
 * module imports NOTHING — no network, no npm package.
 *
 * On the ajv question (the issue framed the shape check as "ajv"): the Tier A
 * loop runs SERVER-SIDE, and the production server image ships ZERO node_modules
 * (Dockerfile copies only dist/scripts/src-lib; ADR 0007). A bare `ajv` import in
 * the server boot graph is rejected by scripts/server-runtime-import-guard and
 * would crash-loop the runtime. The `{ summary, rankedFindingIds }` shape is a
 * handful of typeof guards, so `checkShape` below is that same shape check
 * without the dependency — keeping this module safe in the runtime AND weightless
 * in the client bundle (the route-cap gate). The requirement the article
 * actually turns on — repair prompts carry domain-phrased errors, not raw
 * validator internals — is preserved verbatim.
 */

/** A chat turn, mirroring the OpenAI-compatible role/content shape. */
export interface RepairMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Injected transport: given the running message list, return the completion text. */
export type RepairChat = (messages: RepairMessage[]) => Promise<string>;

/**
 * The outcome of validating one raw completion. On failure `errors` are
 * DOMAIN-PHRASED strings safe to feed back to the model (e.g. `"x" is not one of
 * the provided finding ids.`) — never a raw schema/ajv trace.
 */
export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: string[] };

/** Default bound: the first attempt plus at most this many repair rounds. */
export const DEFAULT_MAX_REPAIR_ROUNDS = 2;

export interface RepairLoopOptions<T> {
  /** Injected transport (wraps the local-model call in the server route). */
  chat: RepairChat;
  /** Initial conversation (system + user); repair turns are appended to a copy. */
  messages: RepairMessage[];
  /** Domain validator returning the typed value or domain-phrased errors. */
  validate: (raw: string) => ValidationResult<T>;
  /** Max REPAIR rounds after the first attempt (default {@link DEFAULT_MAX_REPAIR_ROUNDS}). */
  maxRounds?: number;
  /** Compose the repair user-message from the domain-phrased errors. */
  buildRepairMessage?: (errors: string[], raw: string) => string;
}

export interface RepairLoopResult<T> {
  /** The validated value, or null when every attempt (incl. repairs) failed. */
  value: T | null;
  /** True iff some completion validated. */
  schemaValid: boolean;
  /** REPAIR rounds performed: 0 = the first attempt validated. */
  repairRounds: number;
  /** Domain-phrased errors from the final failed attempt; [] on success. */
  errors: string[];
}

/**
 * The default repair turn: a short instruction plus the domain-phrased errors as
 * a bullet list. Deliberately generic and validator-agnostic — the errors it
 * carries are whatever the injected `validate` produced.
 */
export function defaultRepairMessage(errors: string[]): string {
  const bullets = errors.map((e) => `- ${e}`).join('\n');
  return (
    'Your previous response was not valid. Fix these problems and reply with ' +
    'ONLY the corrected JSON object, no prose or code fences:\n' +
    bullets
  );
}

/**
 * Run the bounded generate → validate → repair loop. Calls `chat`, validates the
 * completion, and — while repair rounds remain — appends the model's reply plus a
 * domain-phrased repair turn and tries again. Returns the first valid value, or a
 * `schemaValid: false` result carrying the last errors and the rounds spent.
 */
export async function runRepairLoop<T>(
  opts: RepairLoopOptions<T>
): Promise<RepairLoopResult<T>> {
  const maxRounds = opts.maxRounds ?? DEFAULT_MAX_REPAIR_ROUNDS;
  const buildRepair = opts.buildRepairMessage ?? defaultRepairMessage;
  const messages: RepairMessage[] = [...opts.messages];
  let lastErrors: string[] = [];

  for (let round = 0; round <= maxRounds; round++) {
    const raw = await opts.chat(messages);
    const result = opts.validate(raw);
    if (result.ok) {
      return { value: result.value, schemaValid: true, repairRounds: round, errors: [] };
    }
    lastErrors = result.errors;
    if (round < maxRounds) {
      messages.push({ role: 'assistant', content: raw });
      messages.push({ role: 'user', content: buildRepair(result.errors, raw) });
    }
  }

  return { value: null, schemaValid: false, repairRounds: maxRounds, errors: lastErrors };
}

/**
 * Parse a model completion into a plain JSON object. Tolerates ```json fences and
 * surrounding prose by extracting the first `{ … }` span. Returns a
 * domain-phrased error (never a raw parser message) so the repair turn stays
 * grounded in the contract, not JS internals.
 */
export function parseJsonObject(
  raw: string
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const trimmed = (raw ?? '').trim();
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  const candidate = start >= 0 && end > start ? unfenced.slice(start, end + 1) : unfenced;
  let value: unknown;
  try {
    value = JSON.parse(candidate);
  } catch {
    return {
      ok: false,
      error: 'The response must be a single JSON object with the required fields.',
    };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'The response must be a single JSON object, not an array or scalar.' };
  }
  return { ok: true, value: value as Record<string, unknown> };
}

/** The field kinds {@link checkShape} understands — enough for flat contracts. */
export type ShapeFieldType = 'string' | 'string[]';
export type ShapeSpec = Record<string, ShapeFieldType>;

/**
 * The zero-dependency stand-in for an ajv shape check (see the module header for
 * why ajv can't run here). Returns DOMAIN-PHRASED errors — one per bad field,
 * phrased for the model — and `[]` when the object matches `spec`.
 */
export function checkShape(value: Record<string, unknown>, spec: ShapeSpec): string[] {
  const errors: string[] = [];
  for (const [key, type] of Object.entries(spec)) {
    const v = value[key];
    if (type === 'string') {
      if (typeof v !== 'string') errors.push(`"${key}" must be a string.`);
    } else {
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
        errors.push(`"${key}" must be an array of strings.`);
      }
    }
  }
  return errors;
}
