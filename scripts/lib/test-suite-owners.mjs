// Workflow-root ownership for package.json `test:*` commands (#3742).
//
// Only commands executed explicitly by a workflow are registered under a CI
// owner. Commands whose underlying suite is already reached by `npm test` or
// another workflow root remain ordinary convenience aliases, so this registry
// does not create duplicate CI execution. Interactive/update commands are
// registered as `manual` to make that exception explicit and reviewable.

export const ALLOWED_TEST_SUITE_OWNERS = Object.freeze([
  'lint',
  'build',
  'gates',
  'test',
  'browser/performance',
  'manual',
]);

// Executable workflow jobs mapped onto the bounded conceptual owners above.
// A new job that invokes `npm run test:*` must declare its owner here; this is
// what lets the checker distinguish a valid owner word from the RIGHT owner.
export const WORKFLOW_TEST_OWNER_BY_JOB = Object.freeze({
  'browser-compat.yml#browser-compat': 'browser/performance',
  'ci.yml#changes': 'lint',
  'ci.yml#lint': 'lint',
  'ci.yml#build': 'build',
  'ci.yml#gates': 'gates',
  'ci.yml#llm-egress': 'gates',
  'ci.yml#sample-boundary': 'gates',
  'pages-publish-plugin.yml#build-and-publish': 'test',
  'test.yml#test': 'test',
});

export const TEST_SUITE_OWNER_GROUPS = Object.freeze({
  lint: Object.freeze([
    'test:action-pins-gate',
    'test:agent-cross-review-vendor',
    'test:arc-dind-sandbox',
    'test:backfill-release-notes',
    'test:ci-docs-only',
    'test:cloud-capture',
    'test:enterprise-auth',
    'test:enterprise-readiness-gate',
    'test:enterprise-route-inventory',
    'test:env-skills-agent-contract',
    'test:gate-discrimination',
    'test:label-milestone-prs',
    'test:milestone-guard',
    'test:no-binary-sources',
    'test:openapi-freshness',
    'test:perf-index-contracts',
    'test:personal-paths',
    'test:policy-write',
    'test:pr-workflow-trust',
    'test:refresh-image-digests',
    'test:release-gate',
    'test:seed-release-gates',
    'test:shell-quote-gate',
    'test:shell-quote-parity',
    'test:suite-coverage',
  ]),
  build: Object.freeze(['test:package-surface']),
  gates: Object.freeze([
    'test:analyze-bundle',
    'test:artifact-cache',
    'test:audit-evidence',
    'test:audit-file-findings',
    'test:audit-hook-timing-receipt',
    'test:audit-orchestrate',
    'test:audit-scope',
    'test:audit-state',
    'test:audit-usage',
    'test:checkpoint-answers',
    'test:cold-ingest-bench',
    'test:compose-runtime-hardening',
    'test:daily-digest',
    'test:dataset-cache-schema',
    'test:dataset-field-sizes',
    'test:dataset-version-header',
    'test:doc-git-times',
    'test:doc-hygiene-host',
    'test:doc-issue-parity',
    'test:doc-neighborhood-inject',
    'test:docs-map',
    'test:engine-absent',
    'test:experiments-route',
    'test:host-producer',
    'test:inbound-boundary',
    'test:ingest-guidance',
    'test:instant-shell-server',
    'test:isolated-views',
    'test:llm-egress-gate',
    'test:perf-probe',
    'test:push-ingest',
    'test:push-ingest-second-source',
    'test:read-workflows-bounds',
    'test:recommendations-statusline',
    'test:recommendations-surface',
    'test:recommendations-swr',
    'test:recs-dataset-reuse',
    'test:recs-light-dataset',
    'test:recs-worker',
    'test:reject-suppression',
    'test:render-churn',
    'test:repo-map-artifact-path',
    'test:repo-map-gate',
    'test:repo-map-generate',
    'test:repo-map-refresh',
    'test:sample-boundary',
    'test:sample-no-node-fs',
    'test:scripts-parity',
    'test:search-digest-cache',
    'test:server-hardening',
    'test:server-healthcheck',
    'test:server-http-timeouts',
    'test:server-scale-budget',
    'test:session-blob-cache',
    'test:session-timeline-route',
    'test:sessions-scale',
    'test:shadow-experiments-route',
    'test:source-routes',
    'test:stat-gated-cache',
    'test:static-serving',
    'test:transcript-cache',
    'test:transcript-rewrite-staleness',
    'test:transcript-warm-cache',
    'test:upload-server-parity',
    'test:workflow-cache',
  ]),
  test: Object.freeze([
    'test:mcp-shim-frictions',
    'test:mcp-shim-isolation',
    'test:plugin-ctl',
    'test:plugin-mcp-payload',
    'test:plugin-runtime-state',
    'test:server-runtime-imports',
  ]),
  'browser/performance': Object.freeze(['test:e2e']),
  manual: Object.freeze([
    'test:e2e:visual-pilot',
    'test:e2e:visual-pilot:update',
    'test:e2e:webkit',
    'test:watch',
  ]),
});

function flattenOwnerGroups(groups) {
  const entries = [];
  // perf-index-contract: test-suite-owner-uniqueness always-consumed: every registry construction checks and records each declared script before emitting the flattened owner map
  const seen = new Set();
  for (const [owner, scripts] of Object.entries(groups)) {
    for (const script of scripts) {
      if (seen.has(script)) {
        throw new Error(`Duplicate test-suite owner registration: ${script}`);
      }
      seen.add(script);
      entries.push([script, owner]);
    }
  }
  return Object.freeze(Object.fromEntries(entries));
}

export const TEST_SUITE_OWNERS = flattenOwnerGroups(TEST_SUITE_OWNER_GROUPS);
