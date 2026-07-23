/**
 * Tier-3 judge-audit types (#605 / #738).
 *
 * The deterministic recommendation engine (`src/lib/detectors/`) emits
 * {@link import('../detectors/types').Recommendation}s where every claim is
 * computed from a rule. Tier-3 auditing is the opposite contract: every claim
 * is *judge-sourced* — a Claude model interprets candidate evidence and decides
 * whether it is a genuine finding. So an {@link AuditFinding} has NO
 * deterministic field; its authority is the judge's rationale plus the evidence
 * refs it was shown.
 *
 * This module is RUNTIME server-only: `scripts/server.mjs` imports it behind
 * the `/api/audit.json` route. `api-client.ts`, `api-client.spa.ts`, and
 * `Recommendations.tsx` take TYPE-only imports (erased at build), so no
 * runtime code is ever pulled into the SPA bundle (the SPA has no API key and
 * no `/api/*`).
 */

/**
 * Coarse subject area a finding speaks to. Mirrors the detector categories —
 * `'security'` is the agent-trustworthiness category the Slice-B deceit detector
 * (`detectors/security/model-deceit.ts`, #686) established, reused here so the
 * judge-based deceit audit (#687) speaks to the same section.
 */
export type AuditDomain =
  | 'quality'
  | 'cost'
  | 'workflow'
  | 'safety'
  | 'security';

/** How sure the judge is that the candidate is a real finding. */
export type AuditConfidence = 'low' | 'medium' | 'high';

/**
 * One judge-interpreted finding. Unlike a deterministic recommendation, every
 * substantive field here originates from the judge — `summary` and
 * `judgeRationale` are the model's words, `evidenceRefs` are the deterministic
 * anchors it was given (so a reader can trace the claim back to source rows).
 */
export interface AuditFinding {
  /** Stable id: `<audit-id>:<subject>` — lets callers dedupe across runs. */
  id: string;
  domain: AuditDomain;
  /** One-line, human-readable claim (judge-authored). */
  summary: string;
  /** Deterministic anchors the judge reasoned over, e.g. `session:<id>`. */
  evidenceRefs: string[];
  /** The judge's reasoning for why this is (or how strongly it is) a finding. */
  judgeRationale: string;
  confidence: AuditConfidence;
}
