# Doc-hygiene borrow stack decision

Status: accepted for #2260 on 2026-07-09. This decides the #2256 borrow/build
boundary for repo-tracked Markdown hygiene.

## Corpus and commands

Evaluated against `origin/master` at `69794d2` in an isolated worktree. The
current tracked Markdown corpus is 140 files
(`git ls-tree -r --name-only HEAD | grep -c '\.md$'`), not the older 189-file
count in the epic text. (An `rg --files -g '*.md' | wc -l` run reports only 134
because ripgrep skips hidden directories, missing the 5 `.claude/agents/*.md`
agent definitions and `.github/ISSUE_TEMPLATE/epic.md`; the git-tracked count is
authoritative.) Doc hygiene is scoped to **all** git-tracked Markdown, including
these hidden-directory docs, because agent definitions are load-bearing docs the
hygiene checks must cover.

Tools tested:

| Tool | Version / source | Command evidence | Fit |
|---|---|---|---|
| `lychee` | 0.24.2, release binary, Apache-2.0 | Full run: `lychee --include-fragments --format json '**/*.md'` found 35 errors across 328 links. Local-only run: `lychee --include-fragments --scheme file --format json '**/*.md'` found 7 deterministic missing-file errors. | Borrow for link checks, host-side only. |
| `agents-lint` | 0.5.0 via `npx`, npm metadata says MIT | JSON runs on `AGENTS.md`, `CLAUDE.md`, and `REFERENCES.md` passed npm-script checks but over-reported slash commands, product routes, globs, and home-relative artifacts as missing paths. | Borrow only behind a project allowlist/adapter. Raw output is not recommendation-ready. |
| `zk` | 0.15.5 release binary, GPL-3.0 | Indexed 134 notes and emitted a 134-node / 212-link graph. `list --orphan` returned 56 notes; `list --broken-links` returned 10 note paths, including false positives for existing non-Markdown refs such as `../bundle-budget.json` and `../scripts/check-bundle-size.mjs`. The graph JSON did not expose missing-target edges. | Reject as graph source. |
| `@driftdev/cli` | 1.3.0, npm metadata says MIT | `npx --yes @driftdev/cli --help` failed with `EUNSUPPORTEDPROTOCOL` because the published package depends on `@driftdev/clarity-adapter: workspace:*`. | Reject for now; too heavy and not currently npm-runnable here. |
| OpenSSF Scorecard | Pattern only, Apache-2.0 | Upstream docs use named checks with scores, reasons, details, and a composite score. | Borrow the output shape, not the tool. |

## Decision

Use a hybrid boundary:

1. Keep the repo-owned `buildDocGraph` / `docGraph` path from
   `src/lib/parse-docs.ts` as the graph source. It is already zero-dependency,
   repo-specific, and understands this repo's categories, ADR ordinals,
   `#NNNN` issue refs, and `src/...` refs. `zk` adds a GPL-3.0 Go binary,
   note-tool semantics, false positives for valid non-note refs, and no useful
   missing-edge payload, so it is not worth borrowing.
2. Add the borrowed checkers only in a host-side runner, alongside the existing
   host-side artifact producers. Do not import them into the browser bundle or
   the zero-`node_modules` runtime container.
3. Default the runner to local deterministic checks only. External URL checks
   make network calls and must stay opt-in under an explicit env flag such as
   `CHD_DOC_HYGIENE_EXTERNAL_LINKS=1`; with the flag unset, the runner must make
   zero external calls.
4. Treat unavailable host tools as skipped checks in the artifact, not runtime
   failures. A later integration can pin host/dev tooling, but this spike adds no
   runtime dependency.
5. Feed one normalized artifact into the ordinary recommendation engine. The
   detector remains a normal `maintenance.doc-hygiene` detector with structured
   provenance and manual fixes.

## Normalized artifact schema

The runner should emit one JSON object shaped after Scorecard: a top-level run,
named checks, per-check scores, and normalized findings. Suggested shape:

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-07-09T00:00:00.000Z",
  "repo": {
    "root": "/abs/repo",
    "commit": "69794d2",
    "markdownFiles": 140
  },
  "summary": {
    "score": 7,
    "findingCount": 12,
    "errorCount": 7,
    "warningCount": 5
  },
  "checks": [
    {
      "name": "lychee.local-links",
      "tool": "lychee",
      "toolVersion": "0.24.2",
      "status": "completed",
      "score": 6,
      "reason": "7 local Markdown links target missing files",
      "findingIds": ["doc-link:docs/competitive-analysis/headroom.md:73"]
    },
    {
      "name": "agents-lint.context-refs",
      "tool": "agents-lint",
      "toolVersion": "0.5.0",
      "status": "completed-with-adapter",
      "score": 8,
      "reason": "npm script refs validated; path refs require route/command allowlist",
      "findingIds": []
    }
  ],
  "findings": [
    {
      "id": "doc-link:docs/competitive-analysis/headroom.md:73",
      "check": "lychee.local-links",
      "signal": "broken-internal-link",
      "severity": "warning",
      "path": "docs/competitive-analysis/headroom.md",
      "line": 73,
      "target": "../v0.4-efficiency-accounting.md",
      "message": "Resolved Markdown target is missing",
      "source": {
        "tool": "lychee",
        "field": "error_map[].span"
      }
    }
  ],
  "skipped": [
    {
      "name": "lychee.external-links",
      "reason": "external URL checks disabled; set CHD_DOC_HYGIENE_EXTERNAL_LINKS=1"
    }
  ]
}
```

The detector can then map checks to recommendations without re-parsing raw tool
formats. `docGraph` remains the source for graph-native signals such as orphan
docs, issue refs, source refs, categories, frontmatter, and declared index nodes.
The normalized artifact is the source for tool-native signals that need line
spans or checker-specific status.

## Downstream alignment

- #2257: keep the existing `parse-docs` graph as the canonical graph source.
  The spike rejects `zk`, so there is no reason to replace `buildDocGraph`.
- #2258: implement `maintenance.doc-hygiene` over `input.docGraph` plus the
  normalized host-runner artifact. Start with deterministic local signals:
  broken internal Markdown links, dangling `src/...` refs, and true orphan docs
  after entry-point allowlists.
- #2259: do not use Drift for TypeScript/prose drift. #2259 covers the
  higher-signal, lower-certainty half — dangling issue-refs (a `#NNNN` cited as
  open but closed/nonexistent, resolved against issue-state data), stale-claims
  (an "as of \<date\>"/version string older than the active milestone, or a
  draft doc whose referenced issue is closed), and declared-vs-derived mismatches
  (frontmatter category/status disagreeing with path/git-derived reality). Keep
  stale-claim wording demoted per the recommendation actionability contract. The
  `src-ref` extraction plus file-exists check for source refs is #2258's
  dangling-src-ref signal, not #2259's.

## License note

`zk` is GPL-3.0. Even if a later design invoked it as a host-side binary rather
than linking it, distributing or requiring it would need deliberate license
review. Given the weaker fit above, the project should avoid adding that review
burden to this doc-hygiene slice.
