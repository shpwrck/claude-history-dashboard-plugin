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
 * each edit must actually apply to `source`. Returns DOMAIN-PHRASED errors safe
 * to feed straight back to the model in a repair turn — never a raw parser or
 * schema trace. Applicability is checked against the ORIGINAL source (the strong
 * signal the model can act on: a `find` that is not in the file is a
 * hallucinated anchor, exactly like an out-of-set finding id in #2682).
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
    if (!source.includes(find)) {
      errors.push(
        `Edit ${n} cannot be applied: the text "${find}" was not found in the file.`
      );
      return;
    }
    edits.push({ find, replace });
  });

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { edits } };
}

/**
 * Deterministically apply a validated edit program to `source`. Each edit
 * replaces the FIRST (leftmost) occurrence of its `find` text — a total,
 * order-stable function of `(source, program)`. An edit whose `find` is no
 * longer present (a prior edit consumed it) is skipped rather than throwing, so
 * apply never fails on a validated program; for the single-surgical-edit corpus
 * this never occurs. Callers pass only programs that {@link validateEditDsl}
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
