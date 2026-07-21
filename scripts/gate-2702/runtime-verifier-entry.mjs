// Build-only entry for the self-contained #2702 verifier shipped in the
// zero-node_modules server runtime. Keep the wire adapter pointed at the narrow
// read API; Vite tree-shakes the CLI entry points while bundling Ajv and every
// local verification dependency behind this export.
export { loadCurrentEvaluation } from "./evaluate.mjs";
