/**
 * Agent-executed, mid-session, opt-in CLAUDE.md auto-append (issue #584, ADR 0005
 * item #10). Pure text transformation: given the *current per-project* CLAUDE.md
 * body and a recommendation's CLAUDE.md fix, produce the body that results from
 * appending the fix snippet to the end of that file.
 *
 * This is the dashboard-owned contract the agent-facing `recs` skill follows when
 * the user opts in to "apply this fix to my project CLAUDE.md" mid-session (the
 * executable wiring is meta, tracked at shpwrck/claude#12). It is deliberately
 * NOT executed by the global SessionStart hook — that hook fires before the
 * repo/cwd is known, so it cannot safely target the current repo's CLAUDE.md, and
 * writing global `~/.claude/CLAUDE.md` is a cross-repo blast-radius violation. See
 * ADR 0005 "Auto-apply is OUT of v0 — propose-only" and the deferred opt-in
 * append decomposed as item #10.
 *
 * Three structural guarantees, mirroring the issue's Acceptance:
 *  1. Opt-in / never global — this function only transforms the project body text
 *     handed to it. It never reads or names `~/.claude/CLAUDE.md`; the caller
 *     decides the destination, and a non-`CLAUDE.md` fix target is rejected.
 *  2. Append-only — existing content is preserved byte-for-byte; the snippet is
 *     concatenated at the end. Existing sections are never rewritten, and an
 *     already-applied fix (markers already present) is a no-op.
 *  3. Adoption via the normal marker transition — the appended snippet carries the
 *     fix's `appliedMarkers`, so the next engine pass suppresses the finding
 *     through the ordinary `claudeMdMarksApplied` check. No special-casing in the
 *     Adoption Card.
 */
import type { RecFix } from './detectors/types';
import { claudeMdMarksApplied } from './detectors/shared';

/** Outcome of an opt-in CLAUDE.md append attempt. */
export interface ClaudeMdAppendResult {
  /**
   * What happened:
   * - `appended` — the snippet was added to the end of the body.
   * - `already-applied` — the fix markers already match the current body, so the
   *   body is returned unchanged (idempotent).
   * - `not-applicable` — the fix does not target CLAUDE.md, or has no snippet, so
   *   nothing was appended.
   */
  status: 'appended' | 'already-applied' | 'not-applicable';
  /** The resulting CLAUDE.md body. Equal to the input body unless `appended`. */
  body: string;
  /** The exact text that was appended (empty unless `appended`). */
  appended: string;
}

/**
 * Heuristic, marker-free dedupe: has the snippet's exact text already been pasted
 * into the body? Reused for fixes that declare no `appliedMarkers` (those can
 * still be append-only and idempotent on literal text). Whitespace-insensitive at
 * the edges only — we never rewrite the interior.
 */
function bodyContainsSnippet(body: string, snippet: string): boolean {
  const trimmed = snippet.trim();
  if (trimmed.length === 0) return false;
  return body.includes(trimmed);
}

/**
 * Produce the per-project CLAUDE.md body that results from an opt-in append of a
 * recommendation's CLAUDE.md fix. Pure — does no I/O. The caller is responsible
 * for having obtained user opt-in and for writing `result.body` back to the
 * *project* file (never the global one).
 *
 * @param currentBody The current per-project CLAUDE.md text (`''` if the file
 *   does not yet exist). Only this single project's body is ever passed in;
 *   the merged/global bundle is not a valid input.
 * @param fix The recommendation's fix. Must have `target === 'CLAUDE.md'`.
 */
export function appendClaudeMdFix(
  currentBody: string,
  fix: RecFix | undefined | null
): ClaudeMdAppendResult {
  const body = currentBody ?? '';
  if (!fix || fix.target !== 'CLAUDE.md') {
    return { status: 'not-applicable', body, appended: '' };
  }
  const snippet = (fix.snippet ?? '').trim();
  if (snippet.length === 0) {
    return { status: 'not-applicable', body, appended: '' };
  }

  // Idempotency: if the fix's adoption markers already match (the same check the
  // engine uses to suppress the finding), or the literal snippet is already in
  // the body, appending again would be a duplicate. Treat as already-applied.
  const markersMatch = fix.appliedMarkers
    ? claudeMdMarksApplied({ claudeMd: { global: null, perProject: { project: body } } } as unknown as Parameters<typeof claudeMdMarksApplied>[0], fix.appliedMarkers)
    : false;
  if (markersMatch || bodyContainsSnippet(body, snippet)) {
    return { status: 'already-applied', body, appended: '' };
  }

  // Append-only: preserve the existing body verbatim and add the snippet at the
  // end, separated by a blank line. A trailing newline is normalised so repeated
  // appends stay tidy without ever touching interior content.
  const base = body.replace(/\s*$/, '');
  const appended = snippet + '\n';
  const nextBody = base.length === 0 ? appended : base + '\n\n' + appended;

  return { status: 'appended', body: nextBody, appended };
}
