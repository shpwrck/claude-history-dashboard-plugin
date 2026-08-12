// Shared review-gate registry for the audit harness (docs/audits/v060-review-phase-audit.md).
//
// Gate-agnostic by design: the harness runs ANY SUBSET of these gates — the FIND
// stage applies each active gate's `spec`, and the FILE router files each finding
// to its gate's epic. Select a subset with `--gates a,b` (router) / `args.gates`
// (workflow); the default is DEFAULT_GATES. To reuse the harness for another
// release, add/adjust entries here (epic + milestone) — no other file changes.
//
// `lens` in the findings JSON is the gate key. Keys are the single source of truth
// shared by the router, the workflow, and any harness-neutral orchestrator.

export const GATES = {
  security: {
    epic: 2217,
    label: 'security',
    milestone: 'v0.7.0',
    spec:
      'authz/authn/CSRF; filesystem write / path-traversal; LLM egress governance & secrets ' +
      '(ADR 0008 — the subscription OAuth cred must never send ~/.claude content); SPA/server ' +
      'boundary & client web-vuln (XSS/CSP); command/SQL injection; k8s operator RBAC; ' +
      'container/proxy/TLS/secrets-in-repo/supply-chain.',
  },
  'data-integrity': {
    epic: 2218,
    label: 'data-integrity',
    milestone: 'v0.7.0',
    spec:
      'for detectors/parsers/calculation code: every recommendation claim evidence-backed and ' +
      'reproducible (cite artifact/field, structured provenance per docs/adding-a-recommendation.md); ' +
      'arithmetic re-derived and faultless; historical/stale signals demoted to "as of <date>"; every ' +
      '`validated` fix snippet copy-paste-safe.',
  },
  performance: {
    epic: 2215,
    label: 'performance',
    milestone: 'v0.7.0',
    spec:
      'hot-path code: bundle weight; wasteful re-render / re-compute (N× per request); ingest/assemble ' +
      'memory or latency hotspots; a new surface shipped without a probe/budget.',
  },
  subtraction: {
    epic: 2994,
    label: 'tech-debt',
    milestone: 'v0.7.0',
    spec:
      'unearned surface that is wired and reachable but dormant: CI-dark pilots, superseded tools, ' +
      'completed one-shot harnesses, and abandoned experiments. Require bounded provenance that the ' +
      'surface is never exercised or is superseded. Name the exact cut, affected consumers, the condition ' +
      'that would justify keeping it, and git-history reversibility. Do not infer that a surface is ' +
      'unreferenced; repo-wide reachability is a separate mechanical pre-pass.',
    boundedEvidence: [
      {
        triggerFiles: ['Caddyfile'],
        surface: ['Caddyfile', 'docker-compose.tls.yml'],
        source: 'docs/audits/v060-file-audit.md:92',
        observation:
          'The completed v0.6 file audit records zero Caddy containers on the known operator host and no CI exercise.',
        keepIf: 'The hosted/self-hoster tier ships; otherwise demote the TLS flavor to a documentation recipe.',
      },
    ],
  },
  architecture: {
    epic: 2216,
    label: 'tech-debt',
    milestone: 'v0.7.0',
    spec:
      'file placement; dead code; stale content; layering/ownership; dependency direction; ' +
      'duplicated abstractions and boundaries that no longer match runtime ownership.',
  },
};

// The standing v0.7 set when no explicit subset is given. Subtraction recurs so
// every review can remove as well as add surface.
export const DEFAULT_GATES = [
  'architecture',
  'security',
  'data-integrity',
  'performance',
  'subtraction',
];

export function gateNames() {
  return Object.keys(GATES);
}

// Resolve a requested gate set (array or comma-string) to a validated list.
// Empty/undefined -> DEFAULT_GATES. Throws on an unknown gate name.
export function resolveGates(requested) {
  if (requested == null || requested === '') return [...DEFAULT_GATES];
  const list = Array.isArray(requested) ? requested : String(requested).split(',');
  const names = list.map((s) => String(s).trim()).filter(Boolean);
  const bad = names.filter((n) => !GATES[n]);
  if (bad.length) throw new Error(`unknown gate(s): ${bad.join(', ')} (known: ${gateNames().join(', ')})`);
  return names;
}
