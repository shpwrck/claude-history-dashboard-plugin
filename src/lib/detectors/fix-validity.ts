/**
 * Fix-snippet validity gate (#1101, epic #866).
 *
 * A recommendation's `fix` snippet is a product surface: the UI offers a
 * one-click "Copy fix". The 2026-06-10 audit found snippets that are NOT
 * copy-paste-safe — a `claude-team` CLI not on PATH, a `/fewer-permission-prompts`
 * skill that may not be installed, a `npm run -s typecheck` hook for a repo with
 * no such script. The {@link FixKind} field lets a detector declare how safe its
 * snippet is; this module is the single source of validation truth so the
 * detectors, the gate test, and any future CI step judge it identically.
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
 * External CLI binaries that must NOT appear in a `'validated'` snippet because
 * they are not guaranteed to resolve on PATH in an arbitrary user environment.
 * Each must instead be presented as a `'manual'` (apply-by-hand) fix. Extend
 * deliberately — the source-scan gate test keys on this list.
 *
 * Scope note: this polices the copy-paste SNIPPET only. A *skill* reference
 * (e.g. `/fewer-permission-prompts`) is legitimate in a recommendation's
 * `action` prose ("if installed, the /… skill can …") and is an action-wording
 * concern, not a snippet-portability one — so skills are intentionally not here.
 */
export const NON_PORTABLE_SNIPPET_PATTERNS: { id: string; pattern: RegExp; why: string }[] = [
  {
    id: 'claude-team-cli',
    pattern: /\bclaude-team\b/,
    why: 'claude-team is not a standard on-PATH binary',
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
