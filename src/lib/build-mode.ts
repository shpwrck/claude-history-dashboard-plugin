/**
 * Build-variant flags derived from Vite's compile-time `import.meta.env.MODE`
 * (epic #1852, ADR 0014 tiered delivery).
 *
 * The `sample` build is the static marketing front door
 * (coach.skrzypek.dev): sample data only, no upload affordance, and no server.
 *
 * `SAMPLE_MODE` is a runtime flag used to gate the upload UI off. The
 * server-bundle-exclusion checks (view-registry) use the literal
 * `import.meta.env.MODE` comparison directly so Vite can still
 * dead-code-eliminate the server-only branches at build time.
 */
export const SAMPLE_MODE = import.meta.env.MODE === 'sample';
