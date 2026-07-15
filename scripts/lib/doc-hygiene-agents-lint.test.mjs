import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  AGENTS_LINT_CHECK,
  normalizeAgentsLintReports,
  sanitizeAgentsLintContext,
} from "./doc-hygiene-agents-lint.mjs";

function issue(rule, message, line) {
  return {
    rule,
    severity: rule === "no-missing-path" ? "error" : "warn",
    message,
    line,
  };
}

function report(file, issues) {
  return {
    file,
    score: 0,
    results: [
      {
        checker: "filesystem",
        issues: issues.filter((row) => row.rule === "no-missing-path"),
        passed: 0,
        failed: issues.length,
      },
      {
        checker: "npm-scripts",
        issues: issues.filter((row) => row.rule === "no-missing-script"),
        passed: 0,
        failed: issues.length,
      },
    ],
    totalIssues: issues.length,
    errors: issues.filter((row) => row.severity === "error").length,
    warnings: issues.filter((row) => row.severity === "warn").length,
    infos: 0,
    timestamp: "2026-07-15T00:00:00.000Z",
  };
}

describe("doc-hygiene agents-lint adapter", () => {
  it("masks unsafe upstream path probes without shifting checker line numbers", () => {
    const source = [
      "Use `./scripts/missing-helper.mjs`.",
      "Run `/recs`; served at `GET /api/recommendations.json`.",
      "Host state is in `~/.claude/projects/<slug>/session.jsonl`.",
      "Never inspect `../repo.tar` or `/tmp/host-secret`.",
    ].join("\n");

    const sanitized = sanitizeAgentsLintContext(source);

    assert.equal(sanitized.length, source.length);
    assert.equal(sanitized.split("\n").length, source.split("\n").length);
    assert.ok(sanitized.includes("./scripts/missing-helper.mjs"));
    for (const hidden of [
      "/recs",
      "GET /api/recommendations.json",
      "~/.claude/projects/<slug>/session.jsonl",
      "../repo.tar",
      "/tmp/host-secret",
    ]) {
      assert.equal(sanitized.includes(hidden), false);
    }
  });

  it("masks URI, web-address, and SCP-style remote references before probing", () => {
    const source = [
      "See `www.example.com/docs/foo`.",
      "See `github.com/owner/repo/docs`.",
      "See `git@github.com:owner/repo`.",
      "See `mailto:user@example.com/archive/item`.",
      "See `urn:example:foo/bar`.",
    ].join("\n");

    const sanitized = sanitizeAgentsLintContext(source);

    assert.equal(sanitized.split("\n").length, source.split("\n").length);
    for (const hidden of [
      "www.example.com/docs/foo",
      "github.com/owner/repo/docs",
      "git@github.com:owner/repo",
      "mailto:user@example.com/archive/item",
      "urn:example:foo/bar",
    ]) {
      assert.equal(sanitized.includes(hidden), false);
    }
  });

  it("canonicalizes source line locators before the pinned checker probes paths", () => {
    const source = [
      "See `src/lib/parse-docs.ts#L243`.",
      "See `src/lib/parse-repo-map-join.ts:183:7`.",
    ].join("\n");

    const sanitized = sanitizeAgentsLintContext(source);

    assert.equal(sanitized.split("\n").length, source.split("\n").length);
    assert.ok(sanitized.includes("src/lib/parse-docs.ts"));
    assert.ok(sanitized.includes("src/lib/parse-repo-map-join.ts"));
    assert.equal(sanitized.includes("#L243"), false);
    assert.equal(sanitized.includes(":183:7"), false);
  });

  it("drops known path false-positive classes while preserving real path and npm-script drift", () => {
    const rows = [
      issue("no-missing-path", 'Path does not exist: "/recs"', 3),
      issue("no-missing-path", 'Path does not exist: "/burn-epic"', 4),
      issue(
        "no-missing-path",
        'Path does not exist: "/api/recommendations.json"',
        5,
      ),
      issue("no-missing-path", 'Path does not exist: "#/sessions"', 6),
      issue("no-missing-path", 'Path does not exist: "src/lib/parse-*.ts"', 7),
      issue(
        "no-missing-path",
        'Path does not exist: "~/.claude/usage-data"',
        8,
      ),
      issue(
        "no-missing-path",
        'Path does not exist: "https://example.com/docs"',
        9,
      ),
      issue(
        "no-missing-path",
        'Path does not exist: "www.example.com/docs/foo"',
        9,
      ),
      issue(
        "no-missing-path",
        'Path does not exist: "github.com/owner/repo/docs"',
        9,
      ),
      issue(
        "no-missing-path",
        'Path does not exist: "git@github.com:owner/repo"',
        9,
      ),
      issue(
        "no-missing-path",
        'Path does not exist: "mailto:user@example.com/archive/item"',
        9,
      ),
      issue(
        "no-missing-path",
        'Path does not exist: "urn:example:foo/bar"',
        9,
      ),
      issue(
        "no-missing-path",
        'Path does not exist: "GET /projects/<slug>/<sessionId>.jsonl"',
        9,
      ),
      issue(
        "no-missing-path",
        'Path does not exist: "projects/<slug>/<sessionId>.jsonl"',
        9,
      ),
      issue("no-missing-path", 'Path does not exist: "/tmp/host-secret"', 9),
      issue("no-missing-path", 'Path does not exist: "../repo.tar"', 9),
      issue("no-missing-path", 'Path does not exist: "docs/../../secret"', 9),
      issue(
        "no-missing-path",
        'Path does not exist: "C:\\Users\\host-secret"',
        9,
      ),
      issue(
        "no-missing-path",
        'Path does not exist: "src/lib/parse-gone.ts"',
        10,
      ),
      issue(
        "no-missing-path",
        'Path does not exist: "./src/lib/parse-gone.ts"',
        12,
      ),
      issue(
        "no-missing-path",
        'Path does not exist: "src/lib/parse-docs.ts#L243"',
        10,
      ),
      issue(
        "no-missing-path",
        'Path does not exist: "src/lib/parse-repo-map-join.ts:183:7"',
        10,
      ),
      issue(
        "no-missing-script",
        'Script "refresh:missing" is mentioned but not found in any package.json',
        11,
      ),
    ];

    const findings = normalizeAgentsLintReports([
      report("REFERENCES.md", rows),
    ]);

    assert.equal(findings.length, 2);
    assert.deepEqual(
      findings.map(({ id: _id, ...finding }) => finding),
      [
        {
          check: AGENTS_LINT_CHECK,
          signal: "missing-path",
          severity: "error",
          path: "REFERENCES.md",
          line: 10,
          target: "src/lib/parse-gone.ts",
          message: 'Path does not exist: "src/lib/parse-gone.ts"',
          source: {
            tool: "agents-lint",
            field:
              "reports[].results[checker=filesystem].issues[rule=no-missing-path]",
          },
        },
        {
          check: AGENTS_LINT_CHECK,
          signal: "missing-npm-script",
          severity: "warning",
          path: "REFERENCES.md",
          line: 11,
          target: "npm run refresh:missing",
          message:
            'Script "refresh:missing" is mentioned but not found in any package.json',
          source: {
            tool: "agents-lint",
            field:
              "reports[].results[checker=npm-scripts].issues[rule=no-missing-script]",
          },
        },
      ],
    );
    for (const finding of findings) {
      assert.match(
        finding.id,
        /^context-ref:agents-lint\.context-refs:[0-9a-f]{16}$/,
      );
    }
  });

  it("rejects malformed JSON instead of treating an incompatible report as clean", () => {
    assert.throws(
      () => normalizeAgentsLintReports([{}]),
      /incompatible agents-lint JSON schema/,
    );
    assert.throws(
      () =>
        normalizeAgentsLintReports([
          { file: "AGENTS.md", score: 100, results: [] },
        ]),
      /incompatible agents-lint JSON schema/,
    );
  });

  it("rejects reports missing or duplicating required checker rows", () => {
    const base = report("AGENTS.md", []);
    const filesystem = base.results[0];
    const npmScripts = base.results[1];

    for (const results of [
      [],
      [filesystem],
      [npmScripts],
      [filesystem, filesystem, npmScripts],
      [filesystem, npmScripts, npmScripts],
    ]) {
      assert.throws(
        () => normalizeAgentsLintReports([{ ...base, results }]),
        /incompatible agents-lint JSON schema/,
      );
    }
  });
});
