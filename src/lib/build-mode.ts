/**
 * Build-variant flags derived from Vite's compile-time `import.meta.env.MODE`
 * (epic #1852, ADR 0014 tiered delivery).
 *
 * Two public SPA builds share the upload-only (`@api-client` stubbed) code path:
 *  - `sample`  — the static marketing front door (coach.skrzypek.dev): sample
 *                data only, NO upload affordance. Instant first impression.
 *  - `spa`     — the upload-focused build (edge-coach.skrzypek.dev): the visitor
 *                analyses their own `~/.claude` client-side.
 *
 * `SAMPLE_MODE` is a runtime flag used to gate the upload UI off and surface a
 * CTA to the upload sibling. The server-bundle-exclusion checks (view-registry)
 * use the literal `import.meta.env.MODE` comparisons directly so Vite can still
 * dead-code-eliminate the server-only branches at build time.
 */
export const SAMPLE_MODE = import.meta.env.MODE === 'sample';

/** The upload-focused sibling the sample front door links to ("use your own data"). */
export const UPLOAD_APP_URL = 'https://edge-coach.skrzypek.dev';
