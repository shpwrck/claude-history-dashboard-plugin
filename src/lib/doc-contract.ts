/**
 * doc-contract.ts — the single, browser-safe doc-category vocabulary shared by
 * the Node doc-graph parser (`parse-docs.ts`, server-only) and the browser-
 * bundled doc-hygiene detector (`detectors/maintenance/doc-hygiene.ts`).
 *
 * `parse-docs.ts` is SERVER-ONLY (it imports `node:fs`/`node:child_process`),
 * so its runtime values can never flow into the browser engine. The detector,
 * however, needs the category vocabulary at RUNTIME to validate an opt-in
 * `category:` frontmatter declaration (#2472). Keeping the `as const` list and
 * its derived `DocCategory` type here — a module with ZERO imports — lets both
 * sides consume ONE source of truth without dragging any Node dependency into
 * the bundle. It mirrors the type-only carry the detector already uses for the
 * rest of the doc-graph shape.
 *
 * BROWSER-SAFE: never add a `node:*` (or any non-portable) import to this file.
 *
 * Issues: #2472 (epic #2256 — doc artifact hygiene)
 */

/**
 * The exhaustive doc-category vocabulary. One bucket per top-level docs subtree,
 * plus `root` for repo-root markdown and `other` for anything outside the
 * recognised layout. `deriveCategory` in `parse-docs.ts` maps a path onto
 * exactly one of these; the #2472 opt-in `category:` frontmatter declaration is
 * validated against this same set (exact-case).
 */
export const DOC_CATEGORIES = [
  'root',
  'doc',
  'adr',
  'audit',
  'competitive',
  'plan',
  'experiment',
  'product',
  'review',
  'backlog',
  'perf',
  'other',
] as const;

/** Coarse doc category, derived purely from a doc's directory (never contents). */
export type DocCategory = (typeof DOC_CATEGORIES)[number];

/** The vocabulary as a Set for O(1) membership checks in the detector. */
const DOC_CATEGORY_SET: ReadonlySet<string> = new Set(DOC_CATEGORIES);

/**
 * Exact-case membership test: is `value` one of the recognised categories?
 * A narrowing type guard so a caller can treat a validated string as a
 * {@link DocCategory}. Case-sensitive by design — an out-of-vocabulary token
 * (including a wrong-case one like `ADR`) is an INVALID declaration, not a match.
 */
export function isDocCategory(value: string): value is DocCategory {
  return DOC_CATEGORY_SET.has(value);
}
