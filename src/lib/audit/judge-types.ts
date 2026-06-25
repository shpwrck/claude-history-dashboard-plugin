/**
 * Leaf type module for the tier-3 judge-audit harness (#1582).
 *
 * The injectable judge contract ({@link JudgeFn} / {@link JudgeVerdict}) used to
 * live in `./judge`, which also imports VALUES from every per-audit module
 * (agentic-opportunities, boomerang-rework, judge-deceit, mcp-adoption-gap,
 * natural-experiment, start-stop-oracle). Each of those audits in turn needs only
 * the judge CONTRACT — they imported `import type { JudgeFn } from './judge'`,
 * closing a (type-only, runtime-erased) madge cycle per audit.
 *
 * Hoisting the contract into this dependency-free leaf lets the per-audit modules
 * import the type from a non-cyclic path, so madge no longer reports the cycle —
 * with zero runtime change (the back-edges were already `import type`, erased at
 * compile time). `./judge` re-exports both from here, so every existing
 * `import { JudgeFn, JudgeVerdict } from './judge'` consumer is unaffected.
 *
 * Its only dependency is the audit-types leaf (`./types`), which imports nothing,
 * so this stays a true leaf.
 */
import type { AuditConfidence } from './types';

/** A judge's verdict over one candidate. */
export interface JudgeVerdict {
  isFinding: boolean;
  rationale: string;
  confidence: AuditConfidence;
}

/** The judge call, abstracted so tests inject a deterministic fake. */
export type JudgeFn = (prompt: {
  system: string;
  user: string;
}) => Promise<JudgeVerdict>;
