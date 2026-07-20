import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

export const GATE_2702_MAX_SOURCE_BYTES = 32 * 1024 * 1024;
export const GATE_2702_MAX_UNTRACKED_FILES = 4_096;

function fail(message) {
  throw new Error(message);
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalValue(value[key])]),
  );
}

function valueDigest(value) {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(canonicalValue(value)), "utf8")
    .digest("hex")}`;
}

function bytesDigest(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function runGit(worktree, args, encoding = "buffer") {
  const result = spawnSync("git", ["-C", worktree, ...args], {
    encoding: encoding === "buffer" ? null : encoding,
    maxBuffer: GATE_2702_MAX_SOURCE_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) {
    fail(`git ${args.join(" ")} failed while capturing C5 worktree evidence`);
  }
  return result.stdout;
}

function assertRelativeGitPath(path) {
  if (
    typeof path !== "string" ||
    !path ||
    isAbsolute(path) ||
    path === ".." ||
    path.startsWith("../") ||
    path.includes("\0")
  ) {
    fail("git returned an unsafe untracked path");
  }
}

/**
 * Capture the exact tracked patch plus untracked bytes relative to a pinned
 * base. `evidence` is safe to persist in a classification; `diff` additionally
 * carries the bounded bytes used to render a judge artifact.
 */
export function captureGate2702WorktreeEvidence({
  worktreePath,
  baseSha,
  includeBytes = false,
}) {
  if (!/^[0-9a-f]{40}$/.test(baseSha ?? "")) {
    fail("C5 worktree evidence requires a pinned commit SHA");
  }
  const worktree = realpathSync(worktreePath);
  const head = runGit(worktree, ["rev-parse", "HEAD"], "utf8").trim();
  if (head !== baseSha) {
    const ancestor = spawnSync(
      "git",
      ["-C", worktree, "merge-base", "--is-ancestor", baseSha, "HEAD"],
      { stdio: "ignore" },
    );
    if (ancestor.status !== 0) {
      fail("C5 worktree is not based on its pinned commit");
    }
  }

  const patch = runGit(worktree, [
    "diff",
    "--binary",
    "--no-color",
    "--no-ext-diff",
    "--no-renames",
    baseSha,
    "--",
  ]);
  const pathBytes = runGit(worktree, [
    "ls-files",
    "-z",
    "--others",
    "--exclude-standard",
  ]);
  const paths = pathBytes.toString("utf8").split("\0").filter(Boolean).sort();
  if (paths.length > GATE_2702_MAX_UNTRACKED_FILES) {
    fail(`C5 untracked file count exceeds ${GATE_2702_MAX_UNTRACKED_FILES}`);
  }

  let aggregateBytes = patch.length;
  const evidenceEntries = [];
  const diffEntries = [];
  for (const path of paths) {
    assertRelativeGitPath(path);
    const absolute = join(worktree, path);
    const rel = relative(worktree, absolute);
    if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
      fail(`C5 untracked path escapes its worktree: ${path}`);
    }
    const metadata = lstatSync(absolute);
    let kind;
    let encoding;
    let storedBytes;
    let bytes;
    if (metadata.isSymbolicLink()) {
      kind = "symlink";
      encoding = "utf8";
      storedBytes = readlinkSync(absolute);
      bytes = Buffer.from(storedBytes, "utf8");
    } else if (metadata.isFile()) {
      kind = "file";
      encoding = "base64";
      if (metadata.size > GATE_2702_MAX_SOURCE_BYTES - aggregateBytes) {
        fail("aggregate C5 worktree source exceeds its evidence cap");
      }
      bytes = readFileSync(absolute);
      if (bytes.length !== metadata.size) {
        fail(`C5 untracked file changed while being captured: ${path}`);
      }
      storedBytes = bytes.toString("base64");
    } else {
      fail(`unsupported C5 untracked entry: ${path}`);
    }
    aggregateBytes += bytes.length;
    if (aggregateBytes > GATE_2702_MAX_SOURCE_BYTES) {
      fail("aggregate C5 worktree source exceeds its evidence cap");
    }
    const entry = {
      path,
      kind,
      mode: metadata.mode,
      sizeBytes: bytes.length,
      contentDigest: bytesDigest(bytes),
      encoding,
    };
    evidenceEntries.push(entry);
    if (includeBytes) diffEntries.push({ ...entry, bytes: storedBytes });
  }

  const body = {
    baseSha,
    trackedPatch: {
      sizeBytes: patch.length,
      contentDigest: bytesDigest(patch),
    },
    untracked: evidenceEntries,
    aggregateBytes,
  };
  return {
    evidence: { ...body, contentDigest: valueDigest(body) },
    ...(includeBytes
      ? {
          diff: {
            trackedPatch: {
              ...body.trackedPatch,
              encoding: "base64",
              bytes: patch.toString("base64"),
            },
            untracked: diffEntries,
          },
        }
      : {}),
  };
}
