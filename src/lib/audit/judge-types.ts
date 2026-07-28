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

/**
 * What kind of data a judge prompt carries (#3111).
 *
 * `claude-derived` marks prompt text built out of the user's `~/.claude` tree —
 * transcript prose, tool-use inputs, anything read back from stored sessions.
 * ADR 0008 forbids sending that content under the subscription OAuth
 * credential, so a judge backed by that credential must refuse the call BEFORE
 * any network dispatch. Carrying the classification on the prompt makes that a
 * checkable property of the call itself, rather than an out-of-band caller
 * convention the prompt-building module cannot enforce.
 */
export type JudgeDataClassification = 'synthetic' | 'claude-derived';

/** One judge call's prompt. */
export interface JudgePrompt {
  system: string;
  user: string;
  /**
   * Omitted means `synthetic`: the prompt is built from aggregate metrics only
   * (counts, ratios, ids) and carries no `~/.claude`-derived content.
   */
  classification?: JudgeDataClassification;
}

/** The judge call, abstracted so tests inject a deterministic fake. */
export type JudgeFn = (prompt: JudgePrompt) => Promise<JudgeVerdict>;
