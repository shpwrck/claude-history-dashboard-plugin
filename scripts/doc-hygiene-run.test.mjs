import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  EXTERNAL_CHECK,
  EXTERNAL_LINKS_FLAG,
  LOCAL_CHECK,
  normalizeLycheeJson,
  runDocHygiene,
} from "./doc-hygiene-run.mjs";

const EMPTY_LYCHEE = JSON.stringify({
  total: 0,
  successful: 0,
  errors: 0,
  timeouts: 0,
  error_map: {},
  timeout_map: {},
});

function fakeSpawn({ missingLychee = false, lycheeResult = null } = {}) {
  const calls = [];
  const spawn = (command, args, options = {}) => {
    calls.push({ command, args, cwd: options.cwd, env: options.env });
    if (command === "git" && args[0] === "ls-tree") {
      return {
        status: 0,
        stdout: "README.md\n.github/hidden.md\nsrc/not-markdown.ts\n",
        stderr: "",
      };
    }
    if (command === "git" && args[0] === "rev-parse") {
      return { status: 0, stdout: "abcdef1234567890\n", stderr: "" };
    }
    if (command === "git" && args[0] === "archive") {
      return { status: 0, stdout: "", stderr: "" };
    }
    if (command === "tar") {
      return { status: 0, stdout: "", stderr: "" };
    }
    if (command === "lychee" && args[0] === "--version") {
      if (missingLychee) {
        const error = new Error("spawnSync lychee ENOENT");
        error.code = "ENOENT";
        return { status: null, stdout: "", stderr: "", error };
      }
      return { status: 0, stdout: "lychee 0.24.2\n", stderr: "" };
    }
    if (command === "lychee") {
      return typeof lycheeResult === "function"
        ? lycheeResult(options, args)
        : (lycheeResult ?? { status: 0, stdout: EMPTY_LYCHEE, stderr: "" });
    }
    throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
  };
  return { spawn, calls };
}

function git(root, args) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function committedRepo(files) {
  const root = mkdtempSync(join(tmpdir(), "doc-hygiene-fixture-"));
  git(root, ["init", "--quiet"]);
  for (const [path, contents] of Object.entries(files)) {
    writeFileSync(join(root, path), contents);
  }
  git(root, ["add", "."]);
  git(root, [
    "-c",
    "user.name=Doc Hygiene Test",
    "-c",
    "user.email=doc-hygiene@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  ]);
  return root;
}

function runWithSnapshotInspection(root, inspect, resultForSnapshot) {
  let checks = 0;
  const spawn = (command, args, options) => {
    if (command === "lychee" && args[0] === "--version") {
      return { status: 0, stdout: "lychee 0.24.2\n", stderr: "" };
    }
    if (command === "lychee") {
      checks += 1;
      inspect(options.cwd);
      return resultForSnapshot(options.cwd);
    }
    return spawnSync(command, args, options);
  };
  const artifact = runDocHygiene({ root, env: {}, spawn });
  assert.equal(checks, 1);
  return artifact;
}

describe("doc-hygiene Lychee normalizer", () => {
  it("normalizes official error_map/span JSON into the Scorecard finding shape", () => {
    const findings = normalizeLycheeJson(
      {
        total: 2,
        successful: 1,
        errors: 1,
        timeouts: 0,
        error_map: {
          "docs/guide.md": [
            {
              url: "file:///repo/docs/missing.md#install",
              status: { text: "Cannot find file" },
              span: { line: 73, column: 9 },
            },
          ],
        },
        timeout_map: {},
      },
      { root: "/repo", check: LOCAL_CHECK },
    );

    assert.equal(findings.length, 1);
    assert.match(findings[0].id, /^doc-link:lychee\.local-links:[0-9a-f]{16}$/);
    assert.deepEqual(
      { ...findings[0], id: "<stable-check-target-digest>" },
      {
        id: "<stable-check-target-digest>",
        check: LOCAL_CHECK,
        signal: "broken-internal-link",
        severity: "warning",
        path: "docs/guide.md",
        line: 73,
        target: "docs/missing.md#install",
        message: "Cannot find file",
        source: { tool: "lychee", field: "error_map[].span" },
      },
    );
  });

  it("includes check and target semantics in otherwise colliding finding ids", () => {
    const base = {
      total: 1,
      successful: 0,
      errors: 1,
      timeouts: 0,
      timeout_map: {},
    };
    const local = normalizeLycheeJson(
      {
        ...base,
        error_map: {
          "docs/guide.md": [
            { url: "file:///repo/docs/missing.md", span: { line: 7 } },
          ],
        },
      },
      { root: "/repo", check: LOCAL_CHECK },
    );
    const external = normalizeLycheeJson(
      {
        ...base,
        error_map: {
          "docs/guide.md": [
            { url: "https://example.invalid", span: { line: 7 } },
          ],
        },
      },
      { root: "/repo", check: EXTERNAL_CHECK },
    );

    assert.notEqual(local[0].id, external[0].id);
    assert.match(local[0].id, /lychee\.local-links/);
    assert.match(external[0].id, /lychee\.external-links/);
  });

  it("normalizes targets outside the snapshot to stable repo-relative evidence", () => {
    const findingAt = (root) =>
      normalizeLycheeJson(
        {
          total: 1,
          successful: 0,
          errors: 1,
          timeouts: 0,
          error_map: {
            [join(root, "README.md")]: [
              {
                url: pathToFileURL(join(root, "..", "outside.md")).href,
                status: {
                  text: `Cannot find ${join(root, "..", "outside.md")}`,
                },
                span: { line: 4 },
              },
            ],
          },
          timeout_map: {},
        },
        { root, check: LOCAL_CHECK },
      )[0];

    const first = findingAt("/tmp/chd-doc-hygiene-one/repo");
    const second = findingAt("/tmp/chd-doc-hygiene-two/repo");
    assert.equal(first.target, "../outside.md");
    assert.equal(first.message, "Cannot find <repo>/../outside.md");
    assert.equal(first.id, second.id);
    assert.doesNotMatch(JSON.stringify(first), /chd-doc-hygiene-/);
  });
});

describe("doc-hygiene runner gating", () => {
  it("emits a valid skipped artifact when Lychee is absent", () => {
    const { spawn } = fakeSpawn({ missingLychee: true });
    const artifact = runDocHygiene({
      root: "/repo",
      env: {},
      spawn,
      now: () => Date.parse("2026-07-09T00:00:00.000Z"),
    });

    assert.equal(artifact.schemaVersion, 1);
    assert.equal(artifact.repo.markdownFiles, 2);
    assert.equal(artifact.summary.score, null);
    assert.deepEqual(artifact.checks, []);
    assert.ok(artifact.skipped.some((row) => row.name === LOCAL_CHECK));
    assert.ok(
      artifact.skipped.some(
        (row) =>
          row.name === EXTERNAL_CHECK &&
          row.reason.includes(EXTERNAL_LINKS_FLAG),
      ),
    );
  });

  it("flag-off constructs only the offline file-scheme invocation", () => {
    const { spawn, calls } = fakeSpawn();
    runDocHygiene({ root: "/repo", env: {}, spawn });

    const checks = calls.filter(
      (call) => call.command === "lychee" && call.args[0] !== "--version",
    );
    assert.equal(checks.length, 1);
    assert.notEqual(checks[0].cwd, "/repo");
    assert.match(checks[0].cwd, /chd-doc-hygiene-/);
    assert.ok(checks[0].args.includes("--offline"));
    const configIndex = checks[0].args.indexOf("--config");
    assert.ok(configIndex >= 0);
    assert.match(checks[0].args[configIndex + 1], /chd-doc-hygiene-/);
    assert.match(checks[0].args[configIndex + 1], /lychee-empty\.toml$/);
    assert.deepEqual(
      checks[0].args.slice(
        checks[0].args.indexOf("--scheme"),
        checks[0].args.indexOf("--scheme") + 2,
      ),
      ["--scheme", "file"],
    );
    assert.ok(!checks[0].args.includes("http"));
    assert.ok(!checks[0].args.includes("https"));
  });

  it("disables lazy fetching on every Git read without dropping the host environment", () => {
    const { spawn, calls } = fakeSpawn();
    runDocHygiene({ root: "/repo", env: {}, spawn });

    const gitCalls = calls.filter((call) => call.command === "git");
    assert.deepEqual(
      gitCalls.map((call) => call.args[0]),
      ["rev-parse", "ls-tree", "archive"],
    );
    for (const call of gitCalls) {
      assert.equal(call.env?.GIT_NO_LAZY_FETCH, "1");
      assert.equal(call.env?.PATH, process.env.PATH);
    }
  });

  it("uses a known-empty config instead of executing repo-defined preprocessors", () => {
    const { spawn } = fakeSpawn({
      lycheeResult: (_options, args) => {
        const index = args.indexOf("--config");
        assert.ok(index >= 0);
        assert.equal(readFileSync(args[index + 1], "utf8"), "");
        return { status: 0, stdout: EMPTY_LYCHEE, stderr: "" };
      },
    });

    const artifact = runDocHygiene({ root: "/repo", env: {}, spawn });
    assert.equal(artifact.checks[0].name, LOCAL_CHECK);
  });

  it("flag-on adds the explicit HTTP/HTTPS invocation", () => {
    const { spawn, calls } = fakeSpawn();
    const artifact = runDocHygiene({
      root: "/repo",
      env: { [EXTERNAL_LINKS_FLAG]: "1" },
      spawn,
    });

    const checks = calls.filter(
      (call) => call.command === "lychee" && call.args[0] !== "--version",
    );
    assert.equal(checks.length, 2);
    const external = checks.find((call) => call.args.includes("http"));
    assert.ok(external);
    assert.ok(external.args.includes("https"));
    assert.ok(!external.args.includes("--offline"));
    assert.ok(artifact.checks.some((check) => check.name === EXTERNAL_CHECK));
    assert.ok(!artifact.skipped.some((row) => row.name === EXTERNAL_CHECK));
  });

  it("never turns empty or incompatible JSON into a clean score of 10", () => {
    const { spawn } = fakeSpawn({
      lycheeResult: { status: 0, stdout: "{}", stderr: "" },
    });
    const artifact = runDocHygiene({ root: "/repo", env: {}, spawn });

    assert.deepEqual(artifact.checks, []);
    assert.equal(artifact.summary.score, null);
    assert.ok(
      artifact.skipped.some(
        (row) =>
          row.name === LOCAL_CHECK &&
          row.reason.includes("incompatible JSON schema"),
      ),
    );
  });

  it("skips runtime/config failures even when stdout resembles valid JSON", () => {
    const { spawn } = fakeSpawn({
      lycheeResult: {
        status: 1,
        stdout: EMPTY_LYCHEE,
        stderr: "unexpected runtime failure",
      },
    });
    const artifact = runDocHygiene({ root: "/repo", env: {}, spawn });

    assert.deepEqual(artifact.checks, []);
    assert.equal(artifact.summary.score, null);
    assert.ok(artifact.skipped[0].reason.includes("exit 1"));
  });

  it("scrubs the temporary snapshot path from checker failure details", () => {
    const { spawn } = fakeSpawn({
      lycheeResult: ({ cwd }) => ({
        status: 1,
        stdout: "",
        stderr: `cannot read ${cwd}/README.md`,
      }),
    });
    const artifact = runDocHygiene({ root: "/repo", env: {}, spawn });

    assert.equal(
      artifact.skipped[0].reason,
      "lychee check unavailable: cannot read <repo>/README.md",
    );
    assert.doesNotMatch(JSON.stringify(artifact), /chd-doc-hygiene-/);
  });

  it("accepts documented exit 2 only when JSON reports represented link failures", () => {
    const failed = JSON.stringify({
      total: 2,
      successful: 1,
      errors: 1,
      timeouts: 0,
      error_map: {
        "docs/guide.md": [
          {
            url: "file:///repo/docs/missing.md",
            status: { text: "Cannot find file" },
            span: { line: 73 },
          },
        ],
      },
      timeout_map: {},
    });
    const { spawn } = fakeSpawn({
      lycheeResult: { status: 2, stdout: failed, stderr: "" },
    });
    const artifact = runDocHygiene({ root: "/repo", env: {}, spawn });

    assert.equal(artifact.checks.length, 1);
    assert.equal(artifact.checks[0].score, 5);
    assert.equal(artifact.findings.length, 1);
    assert.ok(!artifact.skipped.some((row) => row.name === LOCAL_CHECK));
  });

  it("counts timeout_map rows against Lychee timeouts rather than errors", () => {
    const timedOut = JSON.stringify({
      total: 1,
      successful: 0,
      errors: 0,
      timeouts: 1,
      error_map: {},
      timeout_map: {
        "docs/guide.md": [
          {
            url: "file:///repo/docs/slow.md",
            status: { text: "Timeout" },
            span: { line: 21 },
          },
        ],
      },
    });
    const { spawn } = fakeSpawn({
      lycheeResult: { status: 2, stdout: timedOut, stderr: "" },
    });
    const artifact = runDocHygiene({ root: "/repo", env: {}, spawn });

    assert.equal(artifact.checks.length, 1);
    assert.equal(artifact.findings[0].source.field, "timeout_map[].span");
    assert.equal(artifact.findings[0].line, 21);
  });

  it("rejects swapped error/timeout counters even when the total still matches", () => {
    const inconsistent = JSON.stringify({
      total: 1,
      successful: 0,
      errors: 1,
      timeouts: 0,
      error_map: {},
      timeout_map: {
        "docs/guide.md": [
          {
            url: "file:///repo/docs/slow.md",
            status: { text: "Timeout" },
            span: { line: 21 },
          },
        ],
      },
    });
    const { spawn } = fakeSpawn({
      lycheeResult: { status: 2, stdout: inconsistent, stderr: "" },
    });
    const artifact = runDocHygiene({ root: "/repo", env: {}, spawn });

    assert.deepEqual(artifact.checks, []);
    assert.deepEqual(artifact.findings, []);
    assert.ok(
      artifact.skipped[0].reason.includes("disagrees with JSON summary"),
    );
  });
});

describe("doc-hygiene commit snapshot binding", () => {
  it("reads a modified tracked non-Markdown target from the stamped commit", () => {
    const root = committedRepo({
      "README.md": "![tracked image](asset.png)\n",
      "asset.png": "committed bytes\n",
    });
    try {
      writeFileSync(join(root, "asset.png"), "dirty worktree bytes\n");
      const artifact = runWithSnapshotInspection(
        root,
        (snapshot) => {
          assert.notEqual(snapshot, root);
          assert.equal(
            readFileSync(join(snapshot, "asset.png"), "utf8"),
            "committed bytes\n",
          );
        },
        () => ({ status: 0, stdout: EMPTY_LYCHEE, stderr: "" }),
      );

      assert.equal(artifact.repo.commit, git(root, ["rev-parse", "HEAD"]));
      assert.equal(artifact.summary.findingCount, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not let an untracked target hide a link broken at the stamped commit", () => {
    const root = committedRepo({
      "README.md": "[future doc](future.md)\n",
    });
    try {
      writeFileSync(join(root, "future.md"), "# Untracked\n");
      const artifact = runWithSnapshotInspection(
        root,
        (snapshot) => {
          assert.equal(existsSync(join(snapshot, "future.md")), false);
        },
        (snapshot) => ({
          status: 2,
          stdout: JSON.stringify({
            total: 1,
            successful: 0,
            errors: 1,
            timeouts: 0,
            error_map: {
              [join(snapshot, "README.md")]: [
                {
                  url: pathToFileURL(join(snapshot, "future.md")).href,
                  status: {
                    text: `Cannot find ${join(snapshot, "future.md")}`,
                  },
                  span: { line: 1 },
                },
              ],
            },
            timeout_map: {},
          }),
          stderr: "",
        }),
      );

      assert.equal(artifact.findings.length, 1);
      assert.equal(artifact.findings[0].path, "README.md");
      assert.equal(artifact.findings[0].target, "future.md");
      assert.equal(
        artifact.findings[0].message,
        "Cannot find <repo>/future.md",
      );
      assert.doesNotMatch(JSON.stringify(artifact), /chd-doc-hygiene-/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
