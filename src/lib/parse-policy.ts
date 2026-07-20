import type { DangerousCommand, ToolPromptFriction } from './parse-permissions';
// #2719: import from the detector-free `detectors/shared` leaf, NOT the
// `recommendations` barrel, so browser importers of this module (Permissions,
// PolicyBuilder) never transitively bundle the detector catalog.
import { BASH_SAFE_ALLOW_RULES } from './detectors/shared';

/**
 * Policy Builder (#133) — turns the scattered permission recommendations into
 * an interactive panel. Two deterministic seed sources:
 *
 *  - **Dangerous commands** (`detectDangerousCommands`) -> one row per canonical
 *    deny rule proven to match the observed full invocation, defaulting to
 *    `deny`. Legacy or unprovable records remain evidence-only.
 *  - **Prompt friction** (`rankPromptProneTools`) → one row per safe Bash variant
 *    (`BASH_SAFE_ALLOW_RULES`), plus the dominant non-Bash tool if any, defaulting
 *    to `allow`.
 *
 * The user picks deny / ask / allow per row; `computePolicyDiff` accumulates the
 * selections into the additions needed against the current `settings.json`
 * permissions, and `policyDiffToSnippet` renders the copy-pasteable block. This
 * module is pure (no React, no I/O) so it is unit-testable; v1 never writes.
 */

export type PolicyAction = 'deny' | 'ask' | 'allow';

/** A bucket key in `settings.json` `permissions`. Mirrors PolicyAction. */
type PermissionBuckets = {
  allow?: string[];
  ask?: string[];
  deny?: string[];
};

export interface PolicyCandidate {
  /** The settings rule string, e.g. `Bash(rm -rf:*)` or a bare tool name `Write`. */
  rule: string;
  kind: 'dangerous' | 'friction';
  /** Short human label for the row. */
  label: string;
  /** Sub-line: occurrence / share context that justifies the row. */
  detail: string;
  /** Recommended default action for this row. */
  defaultAction: PolicyAction;
  /** Which bucket the rule already sits in (current settings), or null. */
  current: PolicyAction | null;
}

export interface PolicyDiff {
  allow: string[];
  ask: string[];
  deny: string[];
  /** Total additions across all buckets. */
  count: number;
}

/** Find which bucket a rule already lives in (deny wins, then ask, then allow). */
function currentBucket(rule: string, permissions?: PermissionBuckets): PolicyAction | null {
  if (permissions?.deny?.includes(rule)) return 'deny';
  if (permissions?.ask?.includes(rule)) return 'ask';
  if (permissions?.allow?.includes(rule)) return 'allow';
  return null;
}

/**
 * Build the candidate rows for the Policy Builder from the two detectors and the
 * current settings. Rows are deduped by rule (the first/strongest source wins),
 * dangerous rows first.
 */
export function buildPolicyCandidates(
  dangerous: DangerousCommand[],
  friction: ToolPromptFriction[],
  permissions?: PermissionBuckets
): PolicyCandidate[] {
  const seen = new Set<string>();
  const out: PolicyCandidate[] = [];

  // --- Dangerous rows: aggregate occurrences per canonical rule. ---
  const ruleAgg = new Map<string, { count: number; sessions: Set<string>; patterns: Set<string> }>();
  for (const d of dangerous) {
    const rules = Array.isArray(d.matchingRules) ? d.matchingRules : [];
    for (const rule of rules) {
      if (typeof rule !== 'string') continue;
      let agg = ruleAgg.get(rule);
      if (!agg) {
        agg = { count: 0, sessions: new Set(), patterns: new Set() };
        ruleAgg.set(rule, agg);
      }
      agg.count += 1;
      agg.sessions.add(d.sessionId);
      agg.patterns.add(d.pattern);
    }
  }
  // Most-seen rules first for a stable, useful order.
  const sortedRules = Array.from(ruleAgg.entries()).sort(
    (a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0])
  );
  for (const [rule, agg] of sortedRules) {
    if (seen.has(rule)) continue;
    seen.add(rule);
    const patterns = Array.from(agg.patterns).join(', ');
    out.push({
      rule,
      kind: 'dangerous',
      label: rule,
      detail: `${agg.count} run(s) in ${agg.sessions.size} session(s) — matched: ${patterns}`,
      defaultAction: 'deny',
      current: currentBucket(rule, permissions),
    });
  }

  // --- Friction rows: safe Bash variants + dominant non-Bash tool. ---
  if (friction.length > 0) {
    const bashFriction = friction.find((f) => f.toolName === 'Bash');
    if (bashFriction) {
      for (const rule of BASH_SAFE_ALLOW_RULES) {
        if (seen.has(rule)) continue;
        seen.add(rule);
        out.push({
          rule,
          kind: 'friction',
          label: rule,
          detail: `Safe Bash variant — Bash drives ${bashFriction.share.toFixed(0)}% of prompt-eligible calls`,
          defaultAction: 'allow',
          current: currentBucket(rule, permissions),
        });
      }
    }
    // The single dominant non-Bash tool, if it accounts for a real share.
    const topNonBash = friction.find((f) => f.toolName !== 'Bash' && f.share >= 25 && f.promptableCalls >= 20);
    if (topNonBash && !seen.has(topNonBash.toolName)) {
      seen.add(topNonBash.toolName);
      out.push({
        rule: topNonBash.toolName,
        kind: 'friction',
        label: topNonBash.toolName,
        detail: `${topNonBash.promptableCalls} prompt-eligible call(s) across ${topNonBash.sessionCount} session(s) (${topNonBash.share.toFixed(0)}%)`,
        defaultAction: 'allow',
        current: currentBucket(topNonBash.toolName, permissions),
      });
    }
  }

  return out;
}

/**
 * Accumulate the chosen selections into the additions needed against the current
 * settings. A selection whose rule is already in the chosen bucket is a no-op
 * (excluded from the diff). Buckets are deduped and sorted.
 */
export function computePolicyDiff(
  selections: { rule: string; action: PolicyAction }[],
  permissions?: PermissionBuckets
): PolicyDiff {
  const buckets: Record<PolicyAction, Set<string>> = {
    deny: new Set(),
    ask: new Set(),
    allow: new Set(),
  };
  for (const { rule, action } of selections) {
    if (permissions?.[action]?.includes(rule)) continue; // already set — no change
    buckets[action].add(rule);
  }
  const allow = Array.from(buckets.allow).sort();
  const ask = Array.from(buckets.ask).sort();
  const deny = Array.from(buckets.deny).sort();
  return { allow, ask, deny, count: allow.length + ask.length + deny.length };
}

/**
 * Render a `PolicyDiff` as the copy-pasteable `settings.json` block to deep-merge
 * into `.claude/settings.json`. Only non-empty buckets are emitted; returns ''
 * when there is nothing to add.
 */
export function policyDiffToSnippet(diff: PolicyDiff): string {
  const permissions: PermissionBuckets = {};
  if (diff.allow.length) permissions.allow = diff.allow;
  if (diff.ask.length) permissions.ask = diff.ask;
  if (diff.deny.length) permissions.deny = diff.deny;
  if (diff.count === 0) return '';
  return JSON.stringify({ permissions }, null, 2);
}
