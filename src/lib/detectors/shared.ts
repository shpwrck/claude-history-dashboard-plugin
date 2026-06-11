/**
 * Shared detector helpers — gating thresholds, severity scaling, live-settings
 * checks, permission-rule parsing, and CLAUDE.md suppression matching.
 *
 * Imported by both the legacy in-file rules (`recommendations.ts`) and the
 * per-file detectors under `src/lib/detectors/`. Lives below `types.ts` and
 * above the detector files in the dependency graph, so nothing here imports
 * `recommendations.ts` (which would create a cycle). `recommendations.ts`
 * re-exports the public helpers (`bumpSeverity`, `claudeMdMarksApplied`,
 * `DANGEROUS_DENY_RULES`, `BASH_SAFE_ALLOW_RULES`) for back-compat.
 */
import type { LiveConfig, LiveSettings, SessionTokenData } from '../../types';
import type { AppliedMarkers, RecSeverity } from './types';
import { estimateCost, isUnattendedEntrypoint } from '../parse-sessions';

/** Higher = surfaced first. Drives the primary sort in `buildRecommendations`. */
export const SEVERITY_RANK: Record<RecSeverity, number> = {
  critical: 3,
  warning: 2,
  info: 1,
};

/**
 * Raise a severity exactly one level on the three-level scale
 * (`info → warning → critical`), capped at `critical`. Used by safety rules
 * that scale severity by context (e.g. a destructive command that ran under an
 * unattended `sdk-*` entrypoint reads one level hotter than the same command
 * typed interactively — #197). No new severity level is introduced.
 */
export function bumpSeverity(sev: RecSeverity): RecSeverity {
  if (sev === 'info') return 'warning';
  if (sev === 'warning') return 'critical';
  return 'critical';
}

// ── Rule gating thresholds ──────────────────────────────────────────────
// Minimum effect sizes below which a rule stays silent, so the panel only
// shows things worth acting on.
export const MIN_SAVINGS_USD = 0.05;
export const MIN_BYPASS_CALLS = 10;
export const MIN_TOOL_ERROR_RATE = 0.2; // 20%
export const MIN_TOOL_ERROR_CALLS = 5;
export const MIN_RETRY_GROUP_COUNT = 4; // back-to-back same-tool calls
export const HIGH_CHURN = 15; // mutating ops on one file
export const STALE_WEEKS = 4; // no activity for N weeks → "stale"
export const MIN_STALE_SESSIONS = 3; // only nudge on projects with real history
export const MIN_ASSISTANT_TURNS = 50; // enough assistant turns to trust a behaviour rate (#206)
export const HIGH_REFUSAL_RATE = 0.15; // ≥15% of turns concede/refuse → prompt-clarity friction
export const RATE_LIMIT_STATUSES = new Set(['429', '529']);

/** First 8 chars of an id — the canonical short session id used in evidence rows. */
export const short = (id: string) => id.slice(0, 8);

// ─────────────────────────────────────────────────────────────────────────
// LIVE-SETTINGS HELPERS
// ─────────────────────────────────────────────────────────────────────────
// Each rule that emits a `settings.json` or `hook` fix calls one of these to
// answer "is my fix already present in the user's live settings?". Returning
// true makes the rule skip itself entirely so the recommendation doesn't keep
// nagging after the user has copied the snippet in. See issue #166.

export function permissionsContain(
  settings: LiveSettings | null | undefined,
  bucket: 'allow' | 'ask' | 'deny',
  rules: string[]
): boolean {
  const have = settings?.permissions?.[bucket];
  if (!Array.isArray(have) || have.length === 0) return false;
  const set = new Set(have);
  return rules.every((r) => set.has(r));
}

// ── Permission-rule parsing/matching (#175) ─────────────────────────────
// Claude Code permission rules are `Tool(specifier)` or a bare `Tool`. For
// Bash the specifier is a command prefix; a trailing `:*` means "any args
// after this prefix", its absence means an exact command. These helpers power
// the two settings-safety rules (deny-never-triggered, allow-overlaps-deny).

interface PermRule {
  tool: string;
  /** null = bare `Tool` rule (matches any use of the tool). */
  specifier: string | null;
}

export function parsePermRule(rule: string): PermRule {
  const m = /^([A-Za-z][\w-]*)\((.*)\)$/.exec(rule.trim());
  if (m) return { tool: m[1], specifier: m[2] };
  return { tool: rule.trim(), specifier: null };
}

/** Bash specifier → its literal prefix and whether it is a prefix (`:*`) match. */
function bashSpec(specifier: string): { literal: string; prefix: boolean } {
  if (specifier.endsWith(':*')) {
    return { literal: specifier.slice(0, -2).trim(), prefix: true };
  }
  return { literal: specifier.trim(), prefix: false };
}

/**
 * Does a recorded tool call match a permission rule? Returns `null` when the
 * rule can't be evaluated confidently (a non-Bash rule with a specifier — path
 * globs etc.), so callers can decline to judge it rather than guess. Bash rules
 * and bare-tool rules are evaluated exactly.
 */
export function permRuleMatchesCall(
  rule: string,
  call: { toolName: string; input: { command?: string } }
): boolean | null {
  const { tool, specifier } = parsePermRule(rule);
  if (call.toolName !== tool) return false;
  if (specifier === null) return true; // bare tool rule matches any use
  if (tool === 'Bash') {
    const cmd =
      typeof call.input?.command === 'string' ? call.input.command.trim() : '';
    if (!cmd) return false;
    const { literal, prefix } = bashSpec(specifier);
    return prefix ? cmd === literal || cmd.startsWith(literal + ' ') : cmd === literal;
  }
  return null; // non-Bash specifier — not confidently evaluable
}

/**
 * Is `allow` fully shadowed by `deny`? When every command the allow would
 * permit is also caught by the deny, the allow is dead (deny always wins).
 * Conservative for non-Bash specifiers (equality only) so we never claim a
 * shadow we can't prove.
 */
export function allowShadowedByDeny(allow: string, deny: string): boolean {
  const A = parsePermRule(allow);
  const D = parsePermRule(deny);
  if (A.tool !== D.tool) return false;
  if (D.specifier === null) return true; // deny whole tool → any allow is dead
  if (A.specifier === null) return false; // allow whole tool ⊄ a specific deny
  if (A.tool === 'Bash') {
    const a = bashSpec(A.specifier);
    const d = bashSpec(D.specifier);
    if (d.prefix) {
      // Every cmd starting with a.literal also starts with d.literal.
      return a.literal === d.literal || a.literal.startsWith(d.literal + ' ');
    }
    // Exact deny shadows only an identical exact allow.
    return !a.prefix && a.literal === d.literal;
  }
  return A.specifier === D.specifier; // non-Bash: conservative equality
}

// Dangerous-command stems whose `deny` guards are *expected* to sit unused —
// a never-fired `rm -rf` guard is the rule working, not dead config. The
// deny-never-triggered rule excludes these so it never nudges toward weakening
// a real safety guard (the only kind of deny on many setups). Matched as a
// command-prefix against the Bash rule's literal.
const DANGEROUS_DENY_STEMS = [
  'rm', 'rmdir', 'dd', 'mkfs', 'shred', 'curl', 'wget', 'sudo',
  'chmod', 'chown', 'chgrp', 'kill', 'pkill', 'killall', 'shutdown',
  'reboot', 'halt', 'fdisk', 'parted', 'mkswap', 'git reset --hard',
  'git clean', 'git push --force', 'git push -f', 'git push --force-with-lease',
];

/** A Bash deny rule guarding a known-destructive command — never flagged as clutter. */
export function isDangerousDenyRule(rule: string): boolean {
  const { tool, specifier } = parsePermRule(rule);
  if (tool !== 'Bash' || specifier === null) return false;
  const { literal } = bashSpec(specifier);
  const lit = literal.toLowerCase();
  return DANGEROUS_DENY_STEMS.some(
    (stem) => lit === stem || lit.startsWith(stem + ' ')
  );
}

export function hasPostEditHook(settings: LiveSettings | null | undefined): boolean {
  const post = settings?.hooks?.PostToolUse;
  if (!Array.isArray(post)) return false;
  // Match any hook whose matcher mentions Edit or Write. We don't validate the
  // inner `command` — the user may swap in their own typecheck/lint, which is
  // explicitly what the rec's "note" tells them to do.
  return post.some((h) => {
    const m = typeof h?.matcher === 'string' ? h.matcher : '';
    return /\bEdit\b|\bWrite\b/.test(m);
  });
}

export function isModelPinned(settings: LiveSettings | null | undefined): boolean {
  return typeof settings?.model === 'string' && settings.model.length > 0;
}

/**
 * True when a `Stop` hook is currently configured in settings. Used by the
 * stale-input contract (#1102): a historical "stop hooks errored" finding must
 * not be phrased in the present tense when no Stop hook is configured anymore.
 * We don't validate the inner command — any configured Stop hook counts.
 */
export function hasStopHook(settings: LiveSettings | null | undefined): boolean {
  const stop = settings?.hooks?.Stop;
  return Array.isArray(stop) && stop.length > 0;
}

export function isHaikuPinned(settings: LiveSettings | null | undefined): boolean {
  return typeof settings?.model === 'string' && /\bhaiku\b/i.test(settings.model);
}

/**
 * The merged CLAUDE.md text the suppression matcher runs against. Concatenates
 * the global file (`~/.claude/CLAUDE.md`) with every per-project CLAUDE.md
 * value in the bundle. Phase 1 of #173 only delivers `global` — per-project
 * support arrives when the container gains read access to project roots.
 */
export function mergedClaudeMdText(
  liveConfig: LiveConfig | null | undefined
): string {
  if (!liveConfig?.claudeMd) return '';
  const parts: string[] = [];
  if (liveConfig.claudeMd.global) parts.push(liveConfig.claudeMd.global);
  for (const text of Object.values(liveConfig.claudeMd.perProject ?? {})) {
    if (typeof text === 'string' && text.length > 0) parts.push(text);
  }
  return parts.join('\n\n');
}

/**
 * Strict-AND check: a rec's CLAUDE.md fix is considered applied only when
 * **every declared marker category matches** the merged CLAUDE.md text.
 *
 *  - Rules without `appliedMarkers` always return false (never suppressed).
 *  - Empty arrays inside a marker category degrade to "category not declared"
 *    so an author can opt out of one signal without writing a marker that's
 *    impossible to satisfy.
 *
 * Bias is intentional: we'd rather nag the user about a rec they've already
 * addressed in prose than silently hide a real finding. See #173.
 *
 * Exported because downstream tooling (phase-2 P/I/U recs, ad-hoc
 * verification scripts) reuses the same matcher against the same bundle.
 */
export function claudeMdMarksApplied(
  liveConfig: LiveConfig | null | undefined,
  markers: AppliedMarkers | undefined
): boolean {
  if (!markers) return false;
  const headings =
    Array.isArray(markers.headings) && markers.headings.length > 0
      ? markers.headings
      : null;
  const phrases =
    Array.isArray(markers.bodyPhrases) && markers.bodyPhrases.length > 0
      ? markers.bodyPhrases
      : null;
  if (!headings && !phrases) return false;
  const text = mergedClaudeMdText(liveConfig);
  if (text.length === 0) return false;
  if (headings) {
    const headingLines = text
      .split('\n')
      .filter((line) => /^#{1,6}\s+/.test(line));
    const anyHit = headings.some((re) =>
      headingLines.some((line) => re.test(line))
    );
    if (!anyHit) return false;
  }
  if (phrases) {
    const lower = text.toLowerCase();
    const allHit = phrases.every((phrase) =>
      lower.includes(phrase.toLowerCase())
    );
    if (!allHit) return false;
  }
  return true;
}

// ── Canonical permission-rule lists ─────────────────────────────────────
// Kept module-scope so a rule's "already applied?" check sees the exact same
// strings the pasted snippet emits.

/** deny block the dangerous-bypass fix pastes in. */
export const DANGEROUS_DENY_RULES = [
  'Bash(rm -rf:*)',
  'Bash(rm -fr:*)',
  'Bash(git reset --hard:*)',
  'Bash(git clean -fd:*)',
  'Bash(git push --force:*)',
  'Bash(git push -f:*)',
  'Bash(dd:*)',
  'Bash(mkfs:*)',
  'Bash(shred:*)',
  'Bash(curl:*)',
  'Bash(wget:*)',
];

/** ask block the dangerous-commands fix pastes in (deny minus curl/wget). */
export const DANGEROUS_ASK_RULES = [
  'Bash(rm -rf:*)',
  'Bash(rm -fr:*)',
  'Bash(git reset --hard:*)',
  'Bash(git clean -fd:*)',
  'Bash(git push --force:*)',
  'Bash(git push -f:*)',
  'Bash(dd:*)',
  'Bash(mkfs:*)',
  'Bash(shred:*)',
];

/** Allowlist the prompt-friction rec proposes for Bash. */
export const BASH_SAFE_ALLOW_RULES = [
  'Bash(ls:*)',
  'Bash(pwd)',
  'Bash(echo:*)',
  'Bash(git status:*)',
  'Bash(git diff:*)',
  'Bash(git log:*)',
  'Bash(git show:*)',
];

// ── small formatting helpers ────────────────────────────────────────────
export function fmtUsd(n: number): string {
  if (!isFinite(n)) return '$0.00';
  if (n > 0 && n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

export function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

export function truncate(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max) + '…' : flat;
}

export function daysAgo(ts: number, now: number): number {
  return Math.max(0, Math.round((now - ts) / (24 * 60 * 60 * 1000)));
}

/**
 * Shared automation-cost math: estimated spend on unattended (`sdk-*`) sessions,
 * the total estimated spend across all sessions, and automation's percentage
 * share of that total.
 *
 * Extracted from `ruleAutomationCost` (#299) so the Automation view's
 * cost-summary band and the recommendation rule read from ONE computation — they
 * must show the same number and never recompute it inline. `share` is a
 * percentage in [0, 100]; it is `0` when there's no billable total, so callers
 * don't have to guard a divide-by-zero.
 */
export function automationCostShare(tokenData: SessionTokenData[]): {
  autoCost: number;
  total: number;
  share: number;
} {
  let autoCost = 0;
  let total = 0;
  for (const d of tokenData) {
    const c = estimateCost(d);
    total += c;
    if (isUnattendedEntrypoint(d.entrypoint)) {
      autoCost += c;
    }
  }
  const share = total > 0 ? (autoCost / total) * 100 : 0;
  return { autoCost, total, share };
}
