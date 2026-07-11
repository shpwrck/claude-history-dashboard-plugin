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
 */

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
   * Why the surface degraded (endpoint unset / unreachable / refused), surfaced
   * to the user for transparency. null on the happy path.
   */
  reason: string | null;
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
  recs: LocalAnalyzeRecommendation[]
): string {
  if (recs.length === 0) {
    return 'The deterministic engine surfaced no active recommendations for this scope.';
  }
  return recs
    .map((r, i) => {
      const head = [r.severity, r.category].filter(Boolean).join(' · ');
      const label = head ? `[${head}] ` : '';
      const lines = [`${i + 1}. ${label}${r.title}`];
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
  reason: string
): LocalAnalyzeResult {
  return {
    source: 'deterministic',
    recommendations,
    analysis: null,
    model: null,
    reason,
  };
}
