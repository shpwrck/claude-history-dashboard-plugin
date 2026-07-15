/**
 * Fix-snippet validity gate (#1101, epic #866).
 *
 * A recommendation's `fix` snippet is a product surface: the UI offers a
 * one-click "Copy fix". The 2026-06-10 audit found snippets that are NOT
 * copy-paste-safe: a `claude-team` CLI not on PATH, a slash command that only
 * exists in one harness, a host-local path, or a `npm run -s typecheck` hook for
 * a repo with no such script. The {@link FixKind} field lets a detector declare
 * how safe its snippet is; this module is the single source of validation truth
 * so the detectors, the gate test, and any future CI step judge it identically.
 *
 * Validity of a hook *command* is relative to the USER's environment, not this
 * repo, so the gate does NOT try to run commands or resolve PATH. Instead it
 * enforces a portability contract: a `'validated'` (copy-paste-safe) snippet may
 * not embed a reference that is not guaranteed to resolve in an arbitrary user
 * environment. Such references must be marked `'manual'` or `'illustrative'`.
 *
 * Dependency-light (leaf types only) so it sits anywhere in the detector graph.
 */
import type { RecFix, FixKind } from './types';

/** The effective kind of a fix — absent `fixKind` means a copy-paste `'validated'`. */
export function effectiveFixKind(fix: Pick<RecFix, 'fixKind'>): FixKind {
  return fix.fixKind ?? 'validated';
}

/**
 * References that must NOT appear in a `'validated'` snippet because they are
 * not guaranteed to resolve in an arbitrary user environment. Each must instead
 * be presented as a `'manual'` (apply-by-hand) or `'illustrative'` fix. Extend
 * deliberately - the source-scan gate test keys on this list.
 *
 * Scope note: this polices the copy-paste SNIPPET only. A slash command or
 * skill reference can still appear in action prose when it is explicitly framed
 * as optional; it cannot live in a default-validated snippet.
 */
export const NON_PORTABLE_SNIPPET_PATTERNS: { id: string; pattern: RegExp; why: string }[] = [
  {
    id: 'claude-team-cli',
    pattern: /\bclaude-team\b/,
    why: 'claude-team is not a standard on-PATH binary',
  },
  {
    id: 'posix-user-path',
    pattern: /\/(?:home|Users)\/[A-Za-z0-9._-]+(?:\/|$)/,
    why: 'absolute user paths only exist on one host',
  },
  {
    id: 'windows-user-path',
    pattern: /\b[A-Za-z]:\\Users\\[^\\\s]+(?:\\|$)/,
    why: 'absolute Windows user paths only exist on one host',
  },
  {
    id: 'slash-command',
    pattern: /(?:^|[\s`'"])(?:\/[a-z][\w-]*)(?=$|[\s`'",.;:)])/m,
    why: 'slash commands are harness-specific, not portable snippet content',
  },
  {
    id: 'host-tool-reference',
    pattern: /\b(?:nodeRepl|mcp__[A-Za-z0-9_-]+|functions\.exec_command)\b/,
    why: 'host-specific tool references only work in the authoring harness',
  },
];

/**
 * Validate a fix against the portability contract. Returns human-readable errors
 * (empty ⇒ compliant). Non-`validated` fixes always pass — they are explicitly
 * labelled examples, so the gate does not police their contents.
 */
export function validateFixSnippet(fix: Pick<RecFix, 'fixKind' | 'snippet'>): string[] {
  if (effectiveFixKind(fix) !== 'validated') return [];
  const errs: string[] = [];
  for (const { pattern, why } of NON_PORTABLE_SNIPPET_PATTERNS) {
    if (pattern.test(fix.snippet)) {
      errs.push(`validated snippet contains a non-portable reference (${why}) — mark it 'manual' or 'illustrative'`);
    }
  }
  return errs;
}

/**
 * A settings.json snippet that sets a top-level `"model"` key is a BLANKET,
 * global model pin — it applies one model to EVERY task class, including
 * code-authoring. For a down-model-for-cost fix that spans task classes (e.g.
 * `cost.automation-share`), such a snippet must NOT be presented as `'validated'`
 * copy-paste-safe: the per-task-class safety boundary (epic #2138,
 * `docs/product/features/down-modelling-confidence.md`) keeps code-authoring on
 * the strong model until a class-scoped replay (T3) with explicit completion
 * and quality gates clears it. A before/after (T2) is directional cost evidence
 * only. Anthropic frames model choice as a capability decision rather
 * than a blanket cost lever (platform.claude.com model/effort guidance). Present
 * it as `'illustrative'` (adapt to the proven-safe scope) instead (#2548).
 *
 * This is a SAFETY predicate a detector's own test asserts against its own fix.
 * It is deliberately NOT wired into the portability gate, because a top-level
 * model pin is legitimately `'validated'` in other contexts (upgrading a retired
 * model, pinning a model when none is set, right-sizing one narrow agent type) —
 * only a cost-down pin that spans task classes is unsafe.
 */
export function isBlanketModelPinSnippet(snippet: string): boolean {
  const trimmed = snippet.trim();
  if (!(trimmed.startsWith('{') && trimmed.endsWith('}'))) return false;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    return typeof parsed.model === 'string';
  } catch {
    return false;
  }
}

/**
 * Extract the script names from any `npm run [-s] <script>` invocations in a
 * snippet. Used by {@link validateNpmRunScripts} for snippets that are meant to
 * run in THIS repo (not user-env hook templates).
 */
export function npmRunScripts(snippet: string): string[] {
  const out: string[] = [];
  const re = /\bnpm\s+run\s+(?:-s\s+|--silent\s+)?([\w:-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(snippet)) !== null) out.push(m[1]);
  return out;
}

/**
 * For a snippet that is meant to run in a KNOWN repo, validate that every
 * `npm run <script>` it references exists in that repo's `package.json`
 * scripts. Returns the missing script names as errors. (Detector hook templates
 * are env-relative and so are marked `'illustrative'` rather than checked here.)
 */
export function validateNpmRunScripts(snippet: string, scripts: ReadonlySet<string>): string[] {
  return npmRunScripts(snippet)
    .filter((s) => !scripts.has(s))
    .map((s) => `npm script "${s}" referenced in snippet is not in package.json`);
}
