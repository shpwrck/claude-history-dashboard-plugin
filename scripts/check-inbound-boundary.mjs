#!/usr/bin/env node
// Inbound SPA/server boundary gate (#2081 — the inbound half of the #324 split).
//
// The `spa-boundary` CI job guards the OUTBOUND direction: it builds the SPA
// (which aliases @api-client to a no-op stub) and fails if any server-touching
// string survives in the emitted bundle. That is one-directional. This gate
// guards the INBOUND direction: it asserts that every dashboard-server call
// routes through the single `src/lib/api-client.ts` chokepoint, so a stray
// `fetch('/api/…')` or `new EventSource('/api/…')` added to a shared lib,
// detector, or component can't silently bypass the structured client.
//
// We forbid the network PRIMITIVES, not the `/api/` string — `/api/` appears
// pervasively in doc comments across the parsers (each names the route whose
// payload it parses), so a string scan would be all false positives. A server
// call REQUIRES a network primitive, so gating the primitives catches every
// bypass while the prose stays free.
//
// #2963 hardening: the original `fetch(` call-syntax regex was evadable by
// aliasing (`const fetcher = req.fetchImpl ?? fetch;`, `globalThis.fetch`) —
// four modules had drifted through that hole, exempt by accident rather than
// by decision. The `fetch` check is now an AST scan (same approach as
// check-llm-egress.mjs): ANY value-position reference to the global `fetch` in
// a non-owner file fails — bare identifier, `globalThis./window./self.fetch`,
// `['fetch']` indexing, shorthand `{ fetch }`, declaring a binding NAMED
// `fetch` (shadowing) — while `typeof fetch` stays free in both positions
// (a type annotation can't call; runtime `typeof fetch` feature-detection
// can't either), a member named `fetch` on a NON-global receiver stays free
// (`client.fetch()` is that object's API, not the browser primitive), and
// string/comment prose ("run git fetch") never trips because strings and
// comments produce no Identifier nodes.

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// The ONLY modules permitted to reference a raw network primitive. Everything
// else must go through the api-client chokepoint (browser) or an owner below
// (governed server-side egress). Each entry is load-bearing:
export const NETWORK_OWNERS = [
  // — Browser / dashboard-server chokepoint family —
  'lib/api-client.ts', // THE chokepoint — owns every /api/ server call
  'lib/api-client.spa.ts', // its no-op SPA-build alias (no server strings)
  'lib/dataset-worker.ts', // the worker api-client delegates the dataset fetch to (#162); the URL is a param, not a literal
  'lib/dataset-slice-worker.ts', // #2448 off-thread slice decoder (sibling of dataset-worker.ts); slice URLs are params, not literals; imported only by the aliased-away instant-load.ts so it never reaches the SPA bundle
  'lib/instant-load.ts', // #2443 boot-first loader — a LAZY chunk DCE'd from the SPA build (dynamic-imported only under `if (SERVER_AVAILABLE)`), so its /api/ literals never reach the upload bundle
  'lib/claude-api.ts', // BYO Ask-Claude -> the Anthropic API with the user's own key (governed by ADR 0008, not the chokepoint)
  'lib/sample-data.ts', // fetches the build-time static sample zip (SPA tier, no server involved)
  // — Governed server-side egress (#2963: were evading the old call-syntax
  //   regex via aliasing; now allowlisted BY DECISION, each under its own
  //   governance regime, none a dashboard-server call) —
  'lib/anthropic-egress.ts', // ADR 0008 server-side Anthropic chokepoint; every call site is separately gated by the AST-scanning check-llm-egress.mjs + llm-registry.ts
  'lib/local-model-client.ts', // ADR 0018 Tier A local-analyze transport — LOOPBACK ONLY by construction (assertLoopbackEndpoint refuses non-loopback hosts); flag-off default makes zero network calls
  'lib/github-review-sync.ts', // #1127 server-only opt-in GitHub review-event sync — env-gated off by default per the non-local-data rule; never imported by the SPA bundle
  'lib/doc-issue-fetch.ts', // #2710 server-only opt-in GitHub GraphQL doc-issue snapshot — env-gated, SSRF-fixed host, credential never serialized; never imported by the SPA bundle
];

// Non-fetch primitives keep the tight line-regex: real call sites write `new
// EventSource(` etc.; prose never does, and comment lines are skipped anyway.
// (`fetch` moved to the AST scan below — #2963.)
const PRIMITIVE =
  /\bnew\s+(?:EventSource|WebSocket|XMLHttpRequest)\b|\bnavigator\.sendBeacon\b/;

const GLOBAL_RECEIVERS = new Set(['globalThis', 'window', 'self', 'global']);

/** Peel ParenthesizedExpression wrappers: `(globalThis)` -> `globalThis`.
 * The parser keeps parens as real AST nodes (check-llm-egress.mjs unwraps the
 * same shape), so without this `(window).fetch` would read as a non-global
 * receiver and slip through. A receiver laundered through a local alias
 * (`const g = globalThis; g.fetch(...)`) is true alias analysis and out of
 * scope for this syntactic gate — code review owns that residue. */
function unwrapParens(node) {
  while (ts.isParenthesizedExpression(node)) node = node.expression;
  return node;
}

/**
 * AST scan of one source file for value-position references to the global
 * `fetch` (#2963). Returns `{ line, text }[]` (1-based lines).
 */
export function findFetchReferences(fileName, text) {
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const lines = text.split('\n');
  const hits = [];

  const report = (node) => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    hits.push({ line: line + 1, text: (lines[line] ?? '').trim() });
  };

  const visit = (node) => {
    // `x['fetch']` — bracket indexing reaches the primitive on any receiver
    // that turns out to be a global; ban the pattern outright (a non-global
    // member named fetch has no reason to be read via a string index).
    if (
      ts.isElementAccessExpression(node) &&
      (ts.isStringLiteral(node.argumentExpression) ||
        ts.isNoSubstitutionTemplateLiteral(node.argumentExpression)) &&
      node.argumentExpression.text === 'fetch'
    ) {
      report(node);
    }

    if (ts.isIdentifier(node) && node.text === 'fetch') {
      const parent = node.parent;
      if (
        // `typeof fetch` in a TYPE position (`fetchImpl?: typeof fetch`) —
        // a type annotation cannot call the primitive.
        ts.isTypeQueryNode(parent) ||
        // runtime `typeof fetch` feature detection — cannot call it either.
        ts.isTypeOfExpression(parent) ||
        // right side of a type-level qualified name (`SomeNS.fetch`).
        (ts.isQualifiedName(parent) && parent.right === node) ||
        // member NAMED fetch on a non-global receiver: `client.fetch()` is
        // that object's API. Global receivers — however parenthesized —
        // fall through to the flag.
        (ts.isPropertyAccessExpression(parent) &&
          parent.name === node &&
          !(
            ts.isIdentifier(unwrapParens(parent.expression)) &&
            GLOBAL_RECEIVERS.has(unwrapParens(parent.expression).text)
          )) ||
        // property NAME positions: `{ fetch: impl }`, `interface X { fetch: F }`,
        // `class Y { fetch() {} }` — names are inert; shorthand `{ fetch }`
        // is a ShorthandPropertyAssignment and still flags below.
        ((ts.isPropertyAssignment(parent) ||
          ts.isPropertySignature(parent) ||
          ts.isPropertyDeclaration(parent) ||
          ts.isMethodSignature(parent) ||
          ts.isMethodDeclaration(parent)) &&
          parent.name === node)
      ) {
        // allowed context
      } else {
        // Everything else is a value-position reference (call, alias
        // assignment, `?? fetch` fallback, argument, shorthand property,
        // import/export specifier) or a binding NAMED fetch (a shadow that
        // makes later bare references ambiguous) — all flagged.
        report(node);
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

/**
 * Scan a src tree for raw network primitives outside the owner allowlist.
 * Returns `{ file, line, text }[]` (empty when clean). Skips `*.test.ts(x)`;
 * comment/string prose is free (comments are skipped line-wise for the regex
 * pass and produce no AST identifiers for the fetch pass).
 */
export function findInboundViolations(srcDir, owners = NETWORK_OWNERS) {
  const allow = new Set(owners);
  const violations = [];

  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry.name) || /\.test\.(ts|tsx)$/.test(entry.name)) {
        continue;
      }
      const rel = relative(srcDir, full).split('\\').join('/');
      if (allow.has(rel)) continue;

      const text = readFileSync(full, 'utf8');
      const lines = text.split('\n');
      lines.forEach((line, i) => {
        const trimmed = line.trim();
        // Skip whole comment lines (line, block, JSDoc continuation).
        if (
          trimmed.startsWith('//') ||
          trimmed.startsWith('*') ||
          trimmed.startsWith('/*')
        ) {
          return;
        }
        const code = line.replace(/\/\/.*$/, ''); // drop a trailing line comment
        if (PRIMITIVE.test(code)) {
          violations.push({ file: rel, line: i + 1, text: line.trim() });
        }
      });

      for (const hit of findFetchReferences(rel, text)) {
        violations.push({ file: rel, line: hit.line, text: hit.text });
      }
    }
  };

  walk(srcDir);
  return violations.sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line
  );
}

// CLI: scan ../src and exit non-zero on any violation.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const srcDir = join(fileURLToPath(new URL('..', import.meta.url)), 'src');
  const violations = findInboundViolations(srcDir);
  if (violations.length) {
    console.error(
      'Inbound SPA/server boundary violation (#2081/#2963): a raw network primitive reference lives outside the sanctioned owners.\n'
    );
    for (const v of violations) {
      console.error(`  src/${v.file}:${v.line}: ${v.text}`);
    }
    console.error(
      '\nRoute dashboard-server calls through src/lib/api-client.ts (the spa-boundary' +
        ' job guards the outbound half), and do not alias the global fetch —' +
        ' accept an injected fetchImpl WITHOUT a `?? fetch` fallback instead. If this' +
        ' module is a genuine network owner (a governed egress chokepoint), add it to' +
        ' NETWORK_OWNERS in scripts/check-inbound-boundary.mjs with a justifying comment.'
    );
    process.exit(1);
  }
  console.log(
    `Inbound boundary clean: no raw network primitive references outside the ${NETWORK_OWNERS.length} sanctioned owners.`
  );
}
