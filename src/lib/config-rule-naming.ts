/**
 * Canonical rule-file naming helpers, shared by the over-scoped-config-section
 * detector (#1267) and the atomizer codemod (#1268).
 *
 * The detector's recommendation prescribes a rule-file path
 * (`.claude/rules/<topic>.md`) and the codemod writes that file; adoption
 * tracking joins the two on that exact path, so both sides MUST derive the
 * topic slug and the component subtree from the same functions. Before #1427
 * the codemod reused the section-id slug from parse-config-sections instead,
 * so a heading like "Build/Deploy Notes" was prescribed as
 * `build-deploy-notes.md` (detector slug) but written as
 * `builddeploy-notes.md` (parser slug) and the fix never registered as applied.
 *
 * Deliberately dependency-free: the codemod (`scripts/atomize-config.mjs`)
 * imports this module from plain Node (no bundler), so it must not pull in any
 * other module.
 */

/**
 * Rule-file topic slug for a heading: keeps `/` and `_` as `-` and collapses
 * `-` runs. This is NOT the section-id slug from parse-config-sections (which
 * drops `/`, keeps `_`, and never collapses) — section ids address sections
 * inside a document; this slug names the rule FILE a section moves into.
 */
export function ruleTopicSlug(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[^\w\s/-]/g, '')
    .trim()
    .replace(/[/\s_]+/g, '-')
    .replace(/-+/g, '-');
  return slug || 'section';
}

/**
 * Component subtree of a repo-relative path — the detector's single-subtree
 * rule: all of a section's governed/referenced files sharing one subtree is
 * what makes the section a candidate for a path-scoped rule.
 */
export function componentSubtree(path: string): string | null {
  const parts = path
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .split('/')
    .filter(Boolean);
  if (parts.length < 2) return null;
  if (parts[0] === 'src') {
    if (parts.length === 2) return 'src';
    return `src/${parts[1]}`;
  }
  if (parts[0] === 'tools' && parts.length >= 2) return `tools/${parts[1]}`;
  if (parts[0] === '.github' && parts[1] === 'workflows') return '.github/workflows';
  return parts[0];
}
