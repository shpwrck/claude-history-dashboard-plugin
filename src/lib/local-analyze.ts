/**
 * Tier A "Analyze locally" shared contract (issue #2319, ADR 0018).
 *
 * Pure, dependency-free helpers + result types shared by the server route
 * (POST /api/analyze/local), the api-client chokepoint, and LocalAnalyze.tsx.
 * NOTHING in this module touches the network — the local-model transport lives
 * in local-model-client.ts (server-only, loopback-guarded).
 *
 * Governance (ADR 0018): the "Analyze locally" surface runs a LOCAL model over
 * the SAME deterministic recommendation call sites. It is local-by-construction
 * (no external egress; no ADR-0008 fallback wired in v0.6.0), it is NEVER
 * labeled or formatted as "insights", and it never mimics the CLI /insights
 * report. When the local endpoint is absent or unreachable the result degrades
 * to `source: 'deterministic'` — the engine's own recommendations — with no
 * error.
 *
 * Reliability floor (issue #2682): the local-model call is SCHEMA-CONSTRAINED to
 * `{ summary, rankedFindingIds }` and driven through the bounded validator repair
 * loop in schema-repair.ts. `summary` maps into the `analysis` slot; the model's
 * `rankedFindingIds` (validated as a subset of the input finding ids) orders the
 * deterministic recommendations for display. On repair-loop exhaustion the
 * surface degrades to the deterministic result exactly as an unreachable endpoint
 * does — no new failure mode. `repairRounds` / `schemaValid` are captured for the
 * calibration telemetry the ADR 0018 loop reads.
 */

import {
  checkShape,
  parseJsonObject,
  runRepairLoop,
  type RepairMessage,
  type ValidationResult,
} from './schema-repair';

export type LocalAnalyzeSource = 'local-model' | 'deterministic';

/** The subset of a deterministic engine `Recommendation` this surface carries. */
export interface LocalAnalyzeRecommendation {
  id: string;
  category: string;
  severity: string;
  title: string;
  detail: string;
  action: string;
}

export interface LocalAnalyzeResult {
  /** 'local-model' when the loopback endpoint answered; 'deterministic' on degrade. */
  source: LocalAnalyzeSource;
  /**
   * The deterministic engine's recommendations — ALWAYS present. This is the
   * graceful-degradation payload: when the local model is unavailable the
   * surface still shows these.
   */
  recommendations: LocalAnalyzeRecommendation[];
  /** The local model's natural-language analysis; null when degraded. */
  analysis: string | null;
  /** The local model id that answered; null when degraded. */
  model: string | null;
  /**
   * Why the surface degraded (endpoint unset / unreachable / refused / failed
   * schema validation), surfaced to the user for transparency. null on the happy
   * path.
   */
  reason: string | null;
  /**
   * The model's ranking of the input finding ids (most important first),
   * validated as a subset of the provided ids. Present only when `schemaValid`;
   * null on every degraded path. Drives the display order of `recommendations`.
   */
  rankedFindingIds: string[] | null;
  /**
   * Repair rounds spent in the schema-constrained loop: 0 = the first completion
   * validated. Always present (0 on paths that never called the model).
   * Telemetry the #2725 receipt / #2138 confidence loop read.
   */
  repairRounds: number;
  /** True iff the local model produced a schema-valid `{ summary, rankedFindingIds }`. */
  schemaValid: boolean;
}

/** Cap the number of findings summarized into the local-model prompt. */
export const MAX_PROMPT_RECOMMENDATIONS = 12;

/**
 * Pull the carried recommendation fields out of the deterministic engine's
 * output. Tolerates both the served `{ recommendations: [...] }` envelope and a
 * bare array, and skips malformed rows — a defensive read, never throws.
 */
export function extractRecommendations(
  recsJson: unknown,
  limit = MAX_PROMPT_RECOMMENDATIONS
): LocalAnalyzeRecommendation[] {
  const list = Array.isArray(recsJson)
    ? (recsJson as unknown[])
    : recsJson &&
        typeof recsJson === 'object' &&
        Array.isArray((recsJson as { recommendations?: unknown }).recommendations)
      ? ((recsJson as { recommendations: unknown[] }).recommendations)
      : [];
  const out: LocalAnalyzeRecommendation[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    if (typeof r.id !== 'string' || typeof r.title !== 'string') continue;
    out.push({
      id: r.id,
      category: typeof r.category === 'string' ? r.category : '',
      severity: typeof r.severity === 'string' ? r.severity : '',
      title: r.title,
      detail: typeof r.detail === 'string' ? r.detail : '',
      action: typeof r.action === 'string' ? r.action : '',
    });
    if (out.length >= limit) break;
  }
  return out;
}

/** Render the deterministic findings as compact plain text for the prompt. */
export function summarizeRecommendationsForPrompt(
  recs: LocalAnalyzeRecommendation[],
  options: { includeIds?: boolean } = {}
): string {
  if (recs.length === 0) {
    return 'The deterministic engine surfaced no active recommendations for this scope.';
  }
  return recs
    .map((r, i) => {
      const head = [r.severity, r.category].filter(Boolean).join(' · ');
      const label = head ? `[${head}] ` : '';
      const idTag = options.includeIds ? ` (id: ${r.id})` : '';
      const lines = [`${i + 1}. ${label}${r.title}${idTag}`];
      if (r.detail) lines.push(`   Detail: ${r.detail}`);
      if (r.action) lines.push(`   Suggested action: ${r.action}`);
      return lines.join('\n');
    })
    .join('\n');
}

export interface LocalAnalyzePrompt {
  system: string;
  user: string;
}

/**
 * Build the local-model prompt from the deterministic findings. The system
 * prompt is deliberately worded to keep the model grounded in the listed
 * findings and to make clear this is a local analysis — NOT a report of any
 * skill output — so the surface never impersonates the CLI /insights skill.
 */
export function buildLocalAnalyzePrompt(
  recs: LocalAnalyzeRecommendation[]
): LocalAnalyzePrompt {
  const system =
    'You are a local analysis assistant for a Claude Code usage dashboard. ' +
    'You are given the deterministic recommendation engine findings and you write ' +
    'a short, plain-language analysis: group related findings, name the ' +
    'highest-leverage one to act on first, and keep it to a few sentences. ' +
    'Do not invent findings that are not in the list. This is a local-model ' +
    'analysis of the listed findings only; it is not a report of any tool or ' +
    'skill output.';
  const user =
    'Here are the current deterministic recommendation findings:\n\n' +
    summarizeRecommendationsForPrompt(recs) +
    '\n\nWrite a brief, prioritized analysis of these findings.';
  return { system, user };
}

/**
 * The graceful-degradation result: the deterministic engine's recommendations
 * with `source: 'deterministic'` and a human-readable reason. Used whenever the
 * local endpoint is unset, unreachable, or refused — the surface never errors.
 */
export function degradedResult(
  recommendations: LocalAnalyzeRecommendation[],
  reason: string,
  telemetry: { repairRounds?: number } = {}
): LocalAnalyzeResult {
  return {
    source: 'deterministic',
    recommendations,
    analysis: null,
    model: null,
    reason,
    rankedFindingIds: null,
    repairRounds: telemetry.repairRounds ?? 0,
    schemaValid: false,
  };
}

/** The schema-constrained contract the Tier A local model must return. */
export interface LocalAnalyzeModelOutput {
  /** Short, plain-language analysis of the findings; maps into `analysis`. */
  summary: string;
  /** The input finding ids ranked most-important-first (subset of the inputs). */
  rankedFindingIds: string[];
}

/** The flat shape ajv would check; validated here dependency-free (see schema-repair.ts). */
const LOCAL_ANALYZE_SHAPE = { summary: 'string', rankedFindingIds: 'string[]' } as const;

/**
 * Validate a raw local-model completion against the `{ summary, rankedFindingIds }`
 * schema PLUS the domain rule: every ranked id must be one of the provided finding
 * ids (deterministic — stronger than shape-checking, since re-emitting a finding
 * the model wasn't given is a hallucination). Returns domain-phrased errors the
 * repair turn can carry verbatim, never a raw parser/schema trace.
 */
export function validateLocalAnalyzeOutput(
  raw: string,
  validIds: string[]
): ValidationResult<LocalAnalyzeModelOutput> {
  const parsed = parseJsonObject(raw);
  if (!parsed.ok) return { ok: false, errors: [parsed.error] };

  const shapeErrors = checkShape(parsed.value, LOCAL_ANALYZE_SHAPE);
  if (shapeErrors.length > 0) return { ok: false, errors: shapeErrors };

  const obj = parsed.value as unknown as LocalAnalyzeModelOutput;
  const domainErrors: string[] = [];
  // Domain rule: an empty summary is shape-valid but useless (the surface renders
  // `analysis` only when non-empty), so require real content — a repair round is
  // cheaper than a valid-but-blank analysis.
  if (obj.summary.trim() === '') {
    domainErrors.push('"summary" must be a non-empty analysis of the findings.');
  }
  // Domain rule: every ranked id must be one of the provided finding ids.
  const allowed = new Set(validIds);
  for (const id of obj.rankedFindingIds) {
    if (!allowed.has(id)) domainErrors.push(`"${id}" is not one of the provided finding ids.`);
  }
  if (domainErrors.length > 0) return { ok: false, errors: domainErrors };

  return { ok: true, value: { summary: obj.summary, rankedFindingIds: obj.rankedFindingIds } };
}

/**
 * Build the schema-constrained prompt. Extends the grounding of
 * {@link buildLocalAnalyzePrompt} (never invent findings; never impersonate the
 * CLI /insights skill) with an explicit JSON contract and the finding ids the
 * model must rank. Governance copy is unchanged — this surface is a local-model
 * analysis of the listed findings only.
 */
export function buildSchemaAnalyzePrompt(
  recs: LocalAnalyzeRecommendation[]
): LocalAnalyzePrompt {
  const system =
    'You are a local analysis assistant for a Claude Code usage dashboard. ' +
    'You are given the deterministic recommendation engine findings, each with a ' +
    'stable id. Respond with ONLY a single JSON object, no prose and no code ' +
    'fences, of exactly this shape: {"summary": string, "rankedFindingIds": ' +
    'string[]}. "summary" is a short, plain-language analysis (a few sentences) ' +
    'that groups related findings and names the highest-leverage one to act on ' +
    'first. "rankedFindingIds" lists the provided finding ids ordered from most ' +
    'to least important to act on; use ONLY ids from the provided list and do not ' +
    'invent ids or findings. This is a local-model analysis of the listed ' +
    'findings only; it is not a report of any tool or skill output.';
  const user =
    'Here are the current deterministic recommendation findings:\n\n' +
    summarizeRecommendationsForPrompt(recs, { includeIds: true }) +
    '\n\nRespond with only the JSON object described above.';
  return { system, user };
}

/**
 * Order `recs` by the model's `rankedFindingIds` (most important first), then
 * append any recommendation the ranking omitted in its original deterministic
 * order. Pure and defensive: unknown or duplicate ids are ignored, so a partial
 * ranking still yields a stable, complete list.
 */
export function orderRecommendationsByRankedIds(
  recs: LocalAnalyzeRecommendation[],
  rankedIds: string[] | null | undefined
): LocalAnalyzeRecommendation[] {
  if (!rankedIds || rankedIds.length === 0) return recs;
  const byId = new Map(recs.map((r) => [r.id, r]));
  const seen = new Set<string>();
  const ordered: LocalAnalyzeRecommendation[] = [];
  for (const id of rankedIds) {
    const rec = byId.get(id);
    if (rec && !seen.has(id)) {
      ordered.push(rec);
      seen.add(id);
    }
  }
  for (const rec of recs) {
    if (!seen.has(rec.id)) ordered.push(rec);
  }
  return ordered;
}

/** Transport passed to {@link runLocalAnalyze}: one chat completion + the model id that answered. */
export type LocalAnalyzeSend = (
  messages: RepairMessage[]
) => Promise<{ text: string; model?: string | null }>;

export interface RunLocalAnalyzeOptions {
  /** Wraps the loopback local-model call (server injects callLocalModel here). */
  send: LocalAnalyzeSend;
  /** The deterministic findings — the model's input and the degrade payload. */
  recommendations: LocalAnalyzeRecommendation[];
  /** The requested model id; used when the endpoint does not report one back. */
  model: string;
  /** Repair-round bound; defaults to the loop's own default (2). */
  maxRounds?: number;
}

/**
 * Drive the schema-constrained Tier A analysis: prompt the local model for
 * `{ summary, rankedFindingIds }`, validate + repair in a bounded loop, and map a
 * valid result into the `LocalAnalyzeResult` contract (summary -> analysis,
 * rankedFindingIds carried for display order). On exhaustion, degrade to the
 * deterministic result with a reason — same shape as an unreachable endpoint —
 * while still reporting `repairRounds` / `schemaValid`. Never throws for a
 * validation failure; transport errors propagate to the caller's existing
 * degrade path.
 */
export async function runLocalAnalyze(
  opts: RunLocalAnalyzeOptions
): Promise<LocalAnalyzeResult> {
  const recs = opts.recommendations;
  const validIds = recs.map((r) => r.id);
  const { system, user } = buildSchemaAnalyzePrompt(recs);

  let reportedModel: string | null = null;
  const loop = await runRepairLoop<LocalAnalyzeModelOutput>({
    chat: async (messages) => {
      const res = await opts.send(messages);
      if (res.model) reportedModel = res.model;
      return res.text;
    },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    validate: (raw) => validateLocalAnalyzeOutput(raw, validIds),
    maxRounds: opts.maxRounds,
  });

  if (loop.schemaValid && loop.value) {
    return {
      source: 'local-model',
      recommendations: recs,
      analysis: loop.value.summary,
      model: reportedModel ?? opts.model,
      reason: null,
      rankedFindingIds: loop.value.rankedFindingIds,
      repairRounds: loop.repairRounds,
      schemaValid: true,
    };
  }

  const rounds = loop.repairRounds;
  const plural = rounds === 1 ? 'round' : 'rounds';
  return degradedResult(
    recs,
    `Local model output failed schema validation after ${rounds} repair ${plural}`,
    { repairRounds: rounds }
  );
}
