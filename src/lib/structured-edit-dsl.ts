/**
 * Constrained edit-DSL for the schema-constrained repair arm of the
 * structured-edit model-eval (issue #2726, epic #2177).
 *
 * The #2682 analyze surface constrains a chat-only local model to a validated
 * `{ summary, rankedFindingIds }` shape; an EDIT task needs its own constrained
 * representation, because the free-form "return the whole edited file" baseline
 * is undefined for a small local model. This module is that representation: a
 * model does not emit file bytes, it emits a small list of exact-text edits, and
 * a DETERMINISTIC apply step turns them into the edited file. The validator's
 * errors read as DOMAIN problems ("the text ... was not found in the file"),
 * never a raw JSON/schema trace, so the #2682 repair loop can carry them back to
 * the model verbatim (the technique the whole repair lever turns on).
 *
 * PURE + TRANSPORT-AGNOSTIC. This module imports only `parseJsonObject` /
 * `ValidationResult` from schema-repair.ts — no network, no npm package. The
 * two-arm harness (structured-edit-arm-eval.ts) drives it through the bounded
 * `runRepairLoop`; nothing here re-implements that loop.
 *
 * Applicability is checked by SIMULATING the edits in order against evolving
 * content (#3175), not against the original source alone. An anchor that exists
 * in the original but is consumed by an earlier edit is rejected, so a validated
 * program is one every edit of which actually applies at its own step — the same
 * order {@link applyEditDsl} runs them in. This closes the trap where two edits
 * that both anchor on the same original text validated but only the first
 * applied, presenting a partial file as validated output.
 */

import { parseJsonObject, type ValidationResult } from './schema-repair';

/** One exact-text replacement: replace the first occurrence of `find` with `replace`. */
export interface EditDslOp {
  find: string;
  replace: string;
}

/** A constrained edit program: an ordered, non-empty list of exact-text edits. */
export interface EditDslProgram {
  edits: EditDslOp[];
}

/**
 * Validate a raw model completion against the edit-DSL AND the domain rule that
 * each edit must actually apply, IN ORDER, to `source`. Returns DOMAIN-PHRASED
 * errors safe to feed straight back to the model in a repair turn — never a raw
 * parser or schema trace.
 *
 * Applicability is checked by simulating the edits against evolving content
 * exactly as {@link applyEditDsl} will run them (#3175). An anchor that is
 * present in the ORIGINAL source but was already consumed by an earlier edit is
 * rejected — distinctly phrased from a `find` that was never in the file at all
 * (a hallucinated anchor, exactly like an out-of-set finding id in #2682). This
 * makes a validated program one whose every edit genuinely applies, so
 * `applyEditDsl` cannot silently skip a "validated" edit and present a partial
 * file as validated output.
 */
export function validateEditDsl(raw: string, source: string): ValidationResult<EditDslProgram> {
  const parsed = parseJsonObject(raw);
  if (!parsed.ok) return { ok: false, errors: [parsed.error] };

  const editsRaw = (parsed.value as Record<string, unknown>).edits;
  if (!Array.isArray(editsRaw) || editsRaw.length === 0) {
    return {
      ok: false,
      errors: [
        'Provide an "edits" array with at least one edit describing the exact text to change.',
      ],
    };
  }

  const errors: string[] = [];
  const edits: EditDslOp[] = [];
  // Evolving content: each accepted edit is applied here so a later edit is
  // validated against the intermediate state its predecessors produced, never
  // the untouched original.
  let content = source;
  editsRaw.forEach((op, index) => {
    const n = index + 1;
    if (!op || typeof op !== 'object' || Array.isArray(op)) {
      errors.push(`Edit ${n} must be an object with "find" and "replace" text.`);
      return;
    }
    const rec = op as Record<string, unknown>;
    const find = rec.find;
    const replace = rec.replace;
    let ok = true;
    if (typeof find !== 'string' || find === '') {
      errors.push(`Edit ${n} needs a non-empty "find" string naming the exact text to replace.`);
      ok = false;
    }
    if (typeof replace !== 'string') {
      errors.push(`Edit ${n} needs a "replace" string with the corrected text.`);
      ok = false;
    }
    if (!ok || typeof find !== 'string' || typeof replace !== 'string') return;
    if (find === replace) {
      errors.push(
        `Edit ${n} replaces "${find}" with identical text, so it changes nothing; give the corrected text.`
      );
      return;
    }
    const idx = content.indexOf(find);
    if (idx === -1) {
      // Was the anchor ever in the file? If so, an earlier edit consumed it —
      // a different (and recoverable) problem than a never-present anchor.
      if (source.includes(find)) {
        errors.push(
          `Edit ${n} cannot be applied: the text "${find}" is no longer present when this edit runs ` +
            `because an earlier edit already changed or consumed it; reorder the edits or target text that still exists.`
        );
      } else {
        errors.push(
          `Edit ${n} cannot be applied: the text "${find}" was not found in the file.`
        );
      }
      return;
    }
    // Advance evolving content so the next edit sees the real intermediate state.
    content = content.slice(0, idx) + replace + content.slice(idx + find.length);
    edits.push({ find, replace });
  });

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { edits } };
}

/**
 * Deterministically apply a validated edit program to `source`. Each edit
 * replaces the FIRST (leftmost) occurrence of its `find` text — a total,
 * order-stable function of `(source, program)`. An edit whose `find` is no
 * longer present is skipped rather than throwing, so apply is total; but for a
 * program {@link validateEditDsl} accepted against the same `source` this skip
 * is now UNREACHABLE — validation simulates the edits in order and rejects any
 * whose anchor a predecessor consumed (#3175), so every edit here has a live
 * anchor at its step. The skip remains only as defence for callers that apply an
 * unvalidated program. Callers pass only programs that {@link validateEditDsl}
 * accepted against the same `source`.
 */
export function applyEditDsl(source: string, program: EditDslProgram): string {
  let content = source;
  for (const op of program.edits) {
    const idx = content.indexOf(op.find);
    if (idx === -1) continue;
    content = content.slice(0, idx) + op.replace + content.slice(idx + op.find.length);
  }
  return content;
}
