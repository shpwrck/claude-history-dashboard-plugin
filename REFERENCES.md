---
# Declared doc-freshness contract (#2488). This map of ~/.claude artifacts ->
# parsers drifts as code moves, and AGENTS.md polices that drift by hand. The
# opt-in windows below make the expectation explicit: warn/error when the last
# authoritative Git edit is older than the window. Refresh the map or revise the
# contract when it fires; a fresh commit resets the clock.
freshness.warn_after: 180d
freshness.error_after: 365d
---

# External references

This dashboard reads most of its data **live** from the Claude Code install on
the host, plus a small number of dashboard-produced host artifacts called out
below. Nothing in `src/lib/parse-*.ts` invents wire formats — every parser is
just a reader for an on-disk artifact. When a field looks wrong, the ground
truth is one of the paths and producers below, not the parser.

The public `anthropics/claude-code` repo is mostly docs and a minified
`cli.js`, so it is not a useful schema reference. The authoritative shapes
live in the **installed npm package** and the **`~/.claude/` tree on any
machine running Claude Code**. Paths below assume default installs; adjust
for your own `$HOME` and `$NVM_DIR`/global `node_modules` location.

## `~/.claude/` — runtime state and host-produced dashboard artifacts

| Path | What it is | Consumed by |
| --- | --- | --- |
| `~/.claude/projects/<slug>/<sessionId>.jsonl` | Per-session transcript. One JSON object per line; carries top-level `type`, `timestamp`, `version`, `gitBranch`, `entrypoint`, and a `message` that is either an object or a JSON-encoded string. Authoritative source for every per-session view. | `src/lib/parse-utils.ts` (shared scaffolding), `parse-sessions.ts`, `parse-timeline.ts`, `parse-tools.ts`, `parse-tool-inventory.ts`, `parse-errors.ts`, `parse-permissions.ts`, `parse-agents.ts`, `parse-runtime-events.ts`, `parse-churn-geometry.ts`, `parse-assistant-features.ts`, `parse-titles.ts`. Served at `GET /projects/<slug>/<sessionId>.jsonl` by `scripts/server.mjs`; `GET /api/sources/claude-code/sessions/<slug>/<sessionId>.jsonl` is the source-scoped alias. |
| `~/.claude/projects/<slug>/<sessionId>/subagents/*.jsonl` | One transcript per Task-tool subagent invocation. Concatenated onto the parent session before parsing so subagent activity counts toward the parent. | Merged in `scripts/server.mjs` (`readMergedSession`) and `scripts/ingest.mjs` (`listSessions`/`ingestOne`) before any parser runs. |
| `~/.claude/projects/<slug>/<sessionId>/subagents/workflows/<runId>/agent-*.jsonl` | One message-level transcript per agent of a Workflow-tool run (same schema as a session/subagent file; assistant lines carry `message.usage`). **As of #636 these ARE merged** (a second recursion level) so workflow-agent tokens/tool-use/failures count toward the parent and reconcile with the Tokens/Cost tab. The sibling `agent-*.meta.json` sidecars and the run's `journal.jsonl` are NOT merged (meta is not `.jsonl`; the journal is an orchestration log with no `usage`). The per-`msg.id` max-merge in `parse-sessions.ts` makes the merge idempotent, so the manifest's separate per-run accounting (below) never double-counts. | Enumerated by `scripts/workflow-transcripts.mjs` (`nestedWorkflowAgentTranscripts`), folded into the merged blob by both `readMergedSession` and `ingestOne`. |
| `~/.claude/projects/<slug>/<sessionId>/workflows/wf_*.json` | Per-run manifest written on completion of a Workflow-tool run: `workflowName, status, startTime, durationMs, agentCount, totalTokens, totalToolCalls, phases[]`, and `workflowProgress[]` (per-agent `label, phaseIndex, model, state, startedAt, durationMs, tokens, toolCalls, promptPreview, resultPreview`). Self-contained — needs no transcript parsing. | `scripts/read-workflows.mjs` projects the manifests; `src/lib/parse-workflows.ts` normalizes them into the `workflows` dataset key and `/api/workflows` view payload. |
| `~/.claude/projects/<slug>/<sessionId>/workflows/scripts/*.js` | Snapshot of the orchestration script each Workflow run executed (the persisted workflow source). | **Not yet consumed.** |
| `~/.claude/history.jsonl` | Flat log of every prompt the user ever sent, with `cwd` and timestamp. Older sessions that have no transcript on disk are unioned in from here. When a session also appears in `history.d/<sessionId>.jsonl`, the per-session part supersedes the legacy flat entries for that session. | `src/lib/parse-history.ts`. Served at `GET /history.jsonl`; `GET /api/sources/claude-code/history.jsonl` is the source-scoped alias. |
| `~/.claude/history.d/<sessionId>.jsonl` | Per-session prompt-history parts using the same `HistoryEntry` JSONL shape as `history.jsonl`. Parts are read in deterministic path order and override legacy flat `history.jsonl` entries for the same `sessionId`; transcript-derived entries still override both. See `docs/plans/history-d-session-parts.md` for the merge contract. | `src/lib/parse-history.ts` (`parseHistoryJsonl`, `unionHistoryParts`) via `scripts/ingest.mjs`. |
| `~/.claude/shadow-calls/ledger.jsonl` | Shadow-calls experiment ledger (epic #513). One JSON record per Main-vs-Shadow experiment: `mode` (`live`/`replay`), `axis`, `variation`, `main`/`shadow` run blocks, `judge.winner`, replay fields (`baseCommit`/`reproMode`/`coldControl`/`historicalRef`). Written by the `~/.claude/shadow-calls/` tooling (`lib/ledger.mjs`), read fresh per `assembleDataset` and folded into the dataset-cache content hash. Schema: `~/.claude/shadow-calls/SCHEMA.md`. | `src/lib/parse-shadow-calls.ts` (`parseShadowCalls` → per-axis + per-(source, axis) aggregate) → `workflow.shadow-axis-wins` + `workflow.uncovered-shadow-axis` (discovery) detectors; `src/lib/shadow-experiments.ts` (`parseShadowCallRows` → flat per-experiment rows) → `GET /api/shadow-experiments.json` (#2152) and the Shadow Calls drill-down/trends. |
| `~/.claude/shadow-calls/calibration-report.json` | Tier B per-task-class **calibration report** (#2318, epic #2177) — the JSON output of `~/.claude/shadow-calls/lib/calibration-report.mjs` (#2317, mirrored on `shpwrck/claude`), a derived rollup of the shadow-calls ledger's `mode:replay, axis:model, shadow.model=local/*` records. Envelope `{version, kind:'tier-b-calibration', thresholds, asOf, classes[]}`; each class carries `{taskClass, localModel, baselineModel, nSamples, blindJudgeAgreement, costLocal, costClaude, savingsUsdPerTask, latency, parity, asOf, verdict}` with `verdict ∈ pass|fail|insufficient`. Read as a plain local file at ingest (`readLocalCalibration` in `scripts/ingest.mjs`) — NO query-time shell-out, zero network/Anthropic egress; folded into the dataset-cache content hash (guarded, so the absent-report default stays byte-identical). Server-only; absent on SPA/upload. | `src/lib/parse-local-calibration.ts` (`parseLocalCalibration`, pure/browser-safe) → key `localCalibration` → `cost.local-downroute` detector (#2318): PROVEN down-route rec on a `pass` row, HONEST-NULL on a `fail` row, suppressed on `insufficient`/absent; stale rows demoted "as of <date>" via `detectors/provenance.ts`. |
| `~/.claude/shadow-calls/gate-2702/<definitionDigest>/<trialId>/` | **OPT-IN (`CHD_EXPERIMENT_2702=1`), local-only C5 bridge state** (#2818–#2822). The fixed 12-arm registration/terminal/classification/accounting/judge receipts and any authorized retry receipts remain mutable operational evidence until `scripts/gate-2702/seal.mjs seal` independently validates them. Sealing copies every retained receipt, the settled Sidekick ledger bytes, and each worktree's complete tracked/untracked Git diff into `seal/bundles/<contentDigest>/`; it publishes `seal/verified.json` last. The bundle is content-addressed and self-verifying after cleanup. Production sealing rejects test-mode registrations and noncanonical worker argv. This raw bridge state is evidence for recreating C5, **not** a general experiment dataset. | Produced and consumed only by the narrow `scripts/gate-2702/{run,classify,accounting,judge,seal}.mjs` bridge. `run.mjs cleanup` invokes the bundle verifier before removing registered worktrees. It is not read by dashboard ingest or `src/lib/parse-*.ts`; canonical v1 `Run` artifacts inside the sealed bundle are the handoff boundary for later analysis. |
| `~/.claude/settings.json` | Global user settings (model, `permissions.{allow,ask,deny}`, `hooks.*`, `enabledPlugins`, `cleanupPeriodDays`). | `scripts/ingest.mjs` → `readLiveSettings` / `mergeLiveSettings`. Feeds the `liveConfig.settings` slot of `/api/dataset.json` and config-aware recommendations. |
| `~/.claude/settings.local.json` | Per-machine override layered on top of `settings.json` with Claude Code's own merge rules (scalars take the deeper value; `permissions.*` arrays union; `hooks.*` arrays concat). | Same as above. |
| `~/.claude/CLAUDE.md` | Global user instructions injected into every conversation. | `scripts/ingest.mjs` → `assembleLiveConfig.claudeMd.global`. Used to suppress recommendations that would re-tell the user something they already wrote here. |
| `~/.claude/skills/<id>/SKILL.md` (+ bundled resources) | User-scoped skill manifests. Dir-as-resource: each subdir is one skill. The frontmatter `description` is read into the resource's `description` field (trigger keywords for the discovery-failure detector, #136). | `scripts/ingest.mjs` → `assembleLiveConfig()` → `listResources(SKILLS_DIR, 'directory')` (+ `readSkillDescription`). Surfaced as `liveConfig.skills`; consumed by `src/lib/discovery-failures.ts` and config hygiene. |
| `~/.claude/agents/<id>.md` | User-scoped subagent definitions (flat `.md` files). | `scripts/ingest.mjs` → `assembleLiveConfig()` → `listResources(AGENTS_DIR, 'file')`. Surfaced as `liveConfig.subagents`. |
| `~/.claude/commands/<id>.md` | User-scoped slash-command definitions (flat `.md` files). | `scripts/ingest.mjs` → `assembleLiveConfig()` → `listResources(COMMANDS_DIR, 'file')`. Surfaced as `liveConfig.commands`. |
| `~/.claude/plugins/installed_plugins.json` | Registry of installed plugins keyed by id, each entry recording `installPath`, `scope`, `version`, `installedAt`. | `scripts/ingest.mjs` → `readPlugins`. Bundled skills/agents/commands under each plugin's `installPath` are enumerated only when the plugin is in `enabledPlugins`. |
| `~/.claude/plugins/cache/...` | Plugin install trees. Each plugin may carry its own `skills/`, `agents/`, `commands/` subdirs using the same conventions as the global dirs. | `scripts/ingest.mjs` → `enumeratePluginBundle`. |
| `~/.claude.json` (note: **dotfile at `$HOME`**, not under `~/.claude/`) | Top-level Claude Code config. Carries `mcpServers` (global) and a `projects` map keyed by absolute project path with per-project `mcpServers` and `enabledMcpjsonServers`; those project roots also seed readable project-resource discovery. | `scripts/ingest.mjs` → `readMcpServers` and `assembleLiveConfig()`. Drives the MCP-server attribution rollup and project-scoped liveConfig roots. |
| `<project>/CLAUDE.md` and `<project>/.claude/{settings.json,settings.local.json,skills/<id>/SKILL.md,agents/<id>.md,commands/<id>.md}` | Project-scoped Claude Code guidance and resources. Read only when the project root is named by `~/.claude.json.projects`, a repo-map artifact, or the explicit `DASHBOARD_PROJECT_CONFIG_ROOTS` allowlist **and** is readable by the server (container users must opt in with read-only project-root mounts). No arbitrary project files are read beyond these known locations. | `scripts/ingest.mjs` passes project roots into `assembleLiveConfig()`; surfaced as `liveConfig.claudeMd.perProject`, `liveConfig.projectSettings`, and `liveConfig.{skills,subagents,commands}` entries with `scope:"project"` / `projectPath`. Config hygiene treats usage within the matching project only. |
| `~/.claude/tasks/<sessionId>/<n>.json` | Canonical Task/TodoWrite state, stored as numbered JSON files (`1.json`, `2.json`, …) under one directory per session; `_session.json` sidecars are skipped. Each task carries `id, subject, description, activeForm, owner, status` (`pending`/`in_progress`/`completed`), `blocks[]`, `blockedBy[]`, `metadata.pr`; the parser derives `sessionId` from the immediate child directory. The cross-agent dependency DAG + PR linkage transcript TodoWrite calls don't resolve. **Server-only** (epic #539, #559). | `src/lib/parse-tasks.ts` (`parseTasksDir` / `summarizeTasks`) → `assembleDataset` key `tasks`; feeds the `workflow.abandoned-tasks` + `workflow.blocked-task-pileup` detectors and the Task Health view. |
| `~/.claude/teams/<id>/inboxes/<agent>.json` | Inter-agent message inboxes: `{from, text (JSON task_assignment payload), timestamp, type, read}`. **Server-only** (#560). Never reads `.credentials.json` / `paste-cache/`. | `src/lib/parse-teams.ts` (`parseTeamsDir` / `analyzeTeams`) → key `teams`; feeds `reliability.dropped-assignments` + the Team Coordination view. |
| `~/.claude/sessions/<pid>.json` | Live process registry: `pid, sessionId, cwd, startedAt, procStart, version, peerProtocol, kind, entrypoint`. Authoritative entrypoint/cwd/version without parsing transcripts. **Attribute on `entrypoint`, NEVER `kind`** — `kind` reports `interactive` even for `sdk-cli` runs. **Server-only** (#561). | `src/lib/parse-session-registry.ts` (`parseSessionRegistryDir` / `analyzeAttribution`) → key `sessionRegistry`; feeds the #572 Agent Report Card. |
| `~/.claude/telemetry/1p_failed_events*.json` | First-party telemetry (NDJSON, one event/line). **The `*_failed_events` filename is a misnomer** — the files carry the full `tengu_*` event stream, not only failures: e.g. `tengu_feature_ok`, `tengu_skill_loaded`, `tengu_api_retry` (`delayMs`, `attempt_duration_ms`), `tengu_exit` (`last_session_api_duration`, `last_session_tool_duration`, token totals, frame/hook duration percentiles), `tengu_spinner_stalled_ui` (`time_since_last_token_ms`), `tengu_timer`, `tengu_dir_search`. Each event: `event_name, model, betas, session_id`, base64 `additional_metadata` (e.g. `attempt`, `elapsed_ms`), full `env`. Secrets (`email`/`device_id`/`auth`/`process`) dropped on parse. **Server-only** (#562). | `src/lib/parse-telemetry.ts` exposes two paths over these files: the reliability path (`parseTelemetryDir` / `analyzeReliability` — `tengu_api_slow_first_byte` + retry climb) → key `telemetry`, feeds the #572 Agent Report Card; and the latency path (`parseTelemetryLatencyDir` / `aggregateModelLatency` — successful-turn `tengu_exit` api-duration, #1166) → key `modelLatency`, feeds `speed.model-latency`. |
| `~/.claude/debug/*.txt` (+ `debug/latest`) | LSP/hook/fast-mode debug logs. TTFB (`[API REQUEST] /v1/messages` → `Stream started`), retry climb (`API error (attempt N/11)`), 30s `Slow first byte` stalls, `Fast mode unavailable` tax. `sessionId` from filename. **Server-only** (#569). | `src/lib/parse-debug.ts` (`parseDebugDir`) → key `debugLogs`; feeds the #572 Agent Report Card. |
| `~/.claude/stats-cache.json` | CLI-precomputed daily rollup: `dailyActivity[]{date, messageCount, sessionCount, toolCallCount}, version, lastComputedDate`. **Server-only** (#563). | `src/lib/parse-stats-cache.ts` (`parseStatsCache` / `analyzeActivityTrend`) → key `statsCache`; feeds `activity.activity-trend` + the Usage Pulse view. |
| `~/.claude/model-evals/results/*.json` | Completed model-eval result artifacts in the committed #1079 schema (`kind: 'model-eval-result'`: runs, scores, vetoes, exclusions, scoped routing recommendations), emitted by the meta runner outside this repo (epic #975 artifact contract). **Server-only** (#1242). | `src/lib/model-eval-ingest.ts` (`ingestModelEvalResults`) summarizes all artifacts -> key `modelEvalSummary`; boot path reads the dir in `scripts/ingest.mjs` `assembleArtifacts()`. |
| `~/.claude/model-evals/semantic-intent/*.json` | **OPT-IN (`CHD_SEMANTIC_INTENT=1`), server-only** (#2574, epic #2177). Bounded semantic-intent receipts (`kind: 'semantic-intent-receipts'`) written by a host-side runner **outside this repo** that invokes an existing local classifier (vLLM Semantic Router / mmBERT) over loopback against already-captured calls. Each row carries `{evidenceRef, contentSha256, intentClass, confidence, canonicalTaskClass, classifiedAt}` plus artifact-level `taxonomyVersion` + `classifier{id,revision}` — **never prompt prose**, so content cannot leave the host through this path. This repo defines the contract + parser only; it never invokes the classifier, downloads weights, or opens a socket. Flag unset ⇒ the dir is never stat'ed or read, the cache signature is unchanged, and the key ships null. | `src/lib/semantic-intent.ts` (`ingestSemanticIntent`; join helper `intentForEvidenceRef`) -> key `semanticIntent`; boot path reads the dir in `scripts/ingest.mjs` `assembleArtifacts()`. Consumed by the `cost.model-eval-routing-gap` detector (#2647, `semanticRoutingScope`) for SCOPE only — intent narrows a claim that already clears its own evidence bar, and never establishes one. With no usable intent evidence the detector emits its pre-#2647 card unchanged, so "no enrichment" never reads as "no finding". |
| `~/.claude/usage-data/doc-hygiene/*.json` | Normalized schema-v1 documentation-hygiene artifacts produced on the host by `scripts/doc-hygiene-run.mjs`. Direct host runs use a collision-safe checkout-root filename; canonical deploys use `CHD_DOC_HYGIENE_ARTIFACT_KEY` as the shared host/container filename and artifact identity, with `CHD_DOC_HYGIENE_EXPECTED_COMMIT` binding the artifact to the host commit and the runtime image's `GIT_SHA`. Local checks are offline and default-on. External URL checks run only when `CHD_DOC_HYGIENE_EXTERNAL_LINKS` is truthy (`1`, `true`, `yes`, or `on`); with the flag unset the producer makes **zero external calls**. | `src/lib/doc-hygiene-artifact.ts` (`parseDocHygieneArtifact`) validates bounded fields and freshness; `scripts/ingest.mjs` (`readDocHygieneArtifact`) locates and tolerantly consumes the file -> server-only `RecommendationInput.docHygieneArtifact` -> `maintenance.doc-hygiene`. An absent, malformed, identity-mismatched, or stale artifact degrades to `null` and never sinks recommendation assembly. |
| `~/.claude/file-history/<sessionId>/<hash>@v2` | Pre-edit snapshot store (the CLI undo/checkpoint store). Read **structurally only** — snapshot counts + dir/file mtimes, **never file bodies** (no exfil surface). **Server-only** (#564). | `src/lib/parse-file-history.ts` (`parseFileHistoryDir`) → key `fileHistory`; feeds `workflow.rework-signature`. |
| `~/.claude/plans/*.md` | Saved plan-mode / ExitPlanMode documents, reduced to a structural signature (`## ` section count, numbered file-refs, word count, `## Verification`/`## Test` presence) — no prose retained. **Server-only** (#565). | `src/lib/parse-plans.ts` (`parsePlansDir` / `clusterPlans`) → key `plans`; feeds `workflow.plan-missing-verification` + the Plan Shapes view. |
| `~/.claude/.last-update-result.json` | CLI self-update outcome — a **single record, overwritten each update**: `version_from`→`version_to`, `outcome`, `error_code`. **Server-only** (#566). | `src/lib/parse-last-update.ts` (`parseLastUpdate` / `analyzeUpdateHealth`) → key `updateResults` (wrapped in a 1-element array); feeds `reliability.self-update-health`. |
| `~/.claude/mcp-needs-auth-cache.json` | MCP servers needing interactive re-auth (`{}` = clear; transient gate, not a hygiene score). **Server-only** (#567). | `src/lib/parse-mcp-auth.ts` (`parseMcpAuthCache` / `classifyAuthServers`) → key `mcpAuth`; feeds `reliability.mcp-needs-auth`. |
| `~/.claude/backups/.claude.json.backup.<ts>` | Timestamped `~/.claude.json` snapshots. Consecutive snapshots are diffed (**structural config keys only, never credential values**) into config-drift events (trust flips, `enableAllProjectMcpServers` flips, servers entering `disabledMcpjsonServers`, repo `.mcp.json` churn). **Server-only** (#568). | `src/lib/parse-backups.ts` (`parseBackupsDir` / `diffConfigDrift`) → key `configBackups`; feeds `reliability.config-drift`. |

## Repository-bundled reference artifacts

| Path | What it is | Consumed by |
| --- | --- | --- |
| `data/external-guidance/*.json` | Committed, trust-tiered snapshots of externally-authored static guidance. Each snapshot carries `source`, `trustTier`, `url`, `fetchedAt`, a combined `contentHash`, a reference-only `suggestion`, optional structured `facts`, a `target` keyed to an EMITTED recommendation id or category, and per-page provenance `pages[]` (`url` + `title` + `contentHash` + extracted `content` per fetched page, #1407) so drift localizes to the page that changed. These docs are attached only as "Learn More" references after a built-in recommendation fires (#1302); they are never standalone recommendations and are not fetched at runtime. The article list itself lives in `src/lib/external-guidance-registry.ts` (single source of truth; a coverage test pins snapshot ↔ registry agreement) and `scripts/ingest-guidance.mjs` refreshes snapshots on the `ingest-guidance.yml` weekly cron (#1303). | `src/lib/parse-external-guidance.ts` (`readExternalGuidanceSnapshots` / `parseExternalGuidanceSnapshot`; pure core in `src/lib/external-guidance.ts`) → dataset key `externalGuidance` (assembled in `scripts/ingest.mjs`); `buildRecommendations` attaches matching snapshots to fired recommendations as `references[]`. |
| Root `*.md` + `docs/**/*.md` | The dashboard repository's own bounded Markdown corpus. The runtime Docker image ships this surface unchanged. The marketplace plugin ships the same paths but deliberately replaces root `README.md` with `docs/plugin-mirror-README.md`, so its graph reflects the deployed plugin corpus; no network fetch is involved. | `src/lib/parse-docs.ts` (`buildDocGraph`) → dataset key `docGraph`; feeds `maintenance.doc-hygiene` and is carried to live client recommendation surfaces (null in SPA/upload data). |
| `data/doc-git-times.json` | Generated (git-ignored, never committed) manifest of repo-relative Markdown path → last Git commit ISO time, bound to a full `sourceCommit`, with `schemaVersion` and `complete` flags (#2707). Produced ONLY in a non-shallow checkout by `scripts/doc-git-times-generate.mjs` (local deploy `REFRESH=1` block; `docker-publish.yml` after a `fetch-depth: 0` checkout) and packaged into the runtime image via the Dockerfile `data/` COPY — `.git` itself never ships. Dirty/untracked docs are omitted; a shallow, partial, over-cap, or failed run writes nothing. | `src/lib/doc-git-times.ts` (`parseDocGitTimesManifest`) validates fail-closed (schema, commit binding vs runtime `GIT_SHA`/`CHD_DOC_GIT_TIMES_EXPECTED_COMMIT`, path bounds, future-dating); `src/lib/parse-docs.ts` (`buildDocGraph`) joins it into `DocNode.gitMtimeIso` + `gitMtimeProvenance` (`git` > `manifest` > `filesystem` > `unavailable`). A missing/mismatched manifest never promotes Docker COPY mtime to Git history. |
| `docs/docs-map.json` | Versioned (v1) docs-map contract (#2709, epic #2256): a source-bound declaration mapping each opted-in repo document to the source files and exported symbols it claims to cover. Strictly bounded (max file bytes, documents, sources per document, symbols per source; normalized repo-relative paths; `owner/repo` slug) and rejected WHOLE to `null` on an unknown version or any malformed/partial entry — partial acceptance could fabricate reverse drift. Ships in the runtime image via the `docs/` COPY. At ingest the parsed map is wrapped with the supplying checkout's identity: normalized Git-remote slug + clean HEAD commit (gitless-runtime fallback: `CHD_DOCS_MAP_REPOSITORY` + the image's `GIT_SHA` stamp; a dirty tree yields `commit: null`). The later #2489 detector may make absence claims only when exactly one non-truncated repo-map project matches BOTH wrapper fields. | `src/lib/parse-docs-map.ts` (`parseDocsMap`, pure/browser-safe) validates; `scripts/ingest.mjs` (`readDocsMap`) does the bounded read + identity wrap → dataset key `docsMap`, carried through full/light datasets and every client recommendation surface (null in SPA/upload data). SIGNAL ONLY — no detector reads it yet. |
| `${CHD_CACHE_DIR}/doc-issues/<owner>__<repo>.json` | Opt-in (#2710, epic #2256) bounded GitHub issue-state snapshot for the doc graph's `issue:<n>` references. Produced ONLY when `CHD_DOC_ISSUES=owner/repo` is set with a credential (read FILE-FIRST from `CHD_DOC_ISSUES_TOKEN_FILE`, falling back to `CHD_DOC_ISSUES_TOKEN`; never logged/persisted/serialized/hashed); with the flag unset the dashboard makes **zero external calls** and the key is absent. The server preamble does a single-flight GraphQL POST to the fixed `https://api.github.com/graphql`, ≤50 aliases per batch, capped at 1000 refs; each number normalizes to `open`/`closed`/`not-found` (a merged PR is `closed`; `not-found` only for an explicit null alias on an error-free response). Fail-closed: any incompleteness (over-cap, non-200, GraphQL errors, null repository, missing alias, malformed node, timeout, response-cap) never proves absence or replaces the last complete cache. Atomic 0600 write bound to `sha256(repo + sorted ref set)`; reused <15m, single-flight refresh at ≥15m, usable through 24h after a failed refresh. | `src/lib/doc-issue-snapshot.ts` (browser-safe schema/validation/normalization/freshness) + `src/lib/doc-issue-fetch.ts` (`parseDocIssueConfig`/`refreshDocIssueSnapshot`/`readDocIssueCache`, server-only). `scripts/server.mjs` refreshes in the request preamble; `scripts/ingest.mjs` (`readDocIssueSnapshot`) reads the validated cache synchronously and NEVER fetches → server-produced, client-carried `RecommendationInput.docIssueSnapshot` (null in SPA/upload data). Consumer detector is #2711. |

## Wire-format notes worth knowing

- **Transcript `message` is bimodal.** Some lines carry `message` as an
  object, others as a JSON-encoded string. `parseMessage` in
  `src/lib/parse-utils.ts` handles both — new parsers should reuse it
  instead of re-implementing the dual decode.
- **Per-session dimensions live top-level on every transcript line**, not
  in `message`. `version`, `gitBranch`, `entrypoint`, and (on assistant
  usage lines) `message.usage.service_tier` are how `parse-timeline.ts`
  builds the session-dimensions view. `service_tier` is an API field on
  the usage record — don't confuse it with deployment infra.
  - **`entrypoint` has three real values** in live data: `cli` (interactive
    human CLI), `sdk-cli` (automation via the SDK CLI, e.g. burn-backlog
    runs), and `sdk-py` (automation via the Python SDK). Any `sdk-*` value is
    **unattended**; `cli` (and an absent value) is interactive — classify via
    `isUnattendedEntrypoint()` in `src/lib/parse-sessions.ts`, the single source of
    truth shared by `recommendations.ts` (`ruleAutomationCost`) and
    `SessionTimeline.tsx`. There is **no `cron` or `interactive` entrypoint
    value**: `cron` is only a scheduled-fire *content* marker in
    `parse-runtime-events.ts`, a separate concept.
- **Runtime events ride on `type: "system"` lines.** `parse-runtime-events.ts`
  pulls four subtypes — `turn_duration`, `stop_hook_summary`,
  `afk_activity`, scheduled-wakeup telemetry — for measured per-turn
  latency and hook overhead. Most other `type: "system"` lines are
  ignored. **`stop_hook_summary` caveat:** its `hookInfos[]` elements carry a
  `command` string (always) but **no hook `name`/`id`**, and `durationMs` is
  present on only ~7% of them (measured over 279 live events). So hook overhead
  is a sparse, best-effort total — not a dense per-hook timing — and there's no
  clean key to break it down by named hook. Don't build per-hook latency on this
  without re-checking the data (issues #261, #134).
- **Subagent merge order matters.** `scripts/server.mjs` concatenates
  `subagents/*.jsonl` sorted lexically after the parent transcript. If
  you write a parser that depends on monotonic timestamps, sort by
  `timestamp` yourself — the on-disk order is filename-driven.
- **Cloud-capture hub repos mirror the native transcript layout.**
  `tools/cloud-capture/publish-claude.sh` publishes cloud-session transcripts
  into `projects/<slug>/<sessionId>.jsonl` plus one-level
  `projects/<slug>/<sessionId>/subagents/*.jsonl`, so a hub checkout can be
  ingested like a `~/.claude/` transcript tree. The server then ingests an
  additive hub checkout via `DASHBOARD_HUB_PROJECTS_DIR=/path/to/hub/projects`
  or `CLAUDE_HUB_DIR=/path/to/hub` (those roots mirror the same layout), so no
  new wire format or client/server call is introduced. The hub contract is one
  canonical branch, dedup by `sessionId` filename, one file per session, and
  one matching `subagents/` directory. Re-publishing the same session updates
  those paths in place; the publisher keeps a larger existing scrubbed file
  rather than overwriting it with a shorter stale snapshot. Concurrent writers
  rely on disjoint per-session paths plus fetch/rebase/push retry, not
  per-source branches. Local workstations join the same hub through the same
  publisher in local mode (`CLAUDE_HUB_LOCAL=1`, #696): their existing
  `projects/<slug>/<sessionId>.jsonl` tree already matches the hub layout (the
  mapping is identity), dedup against cloud-sourced sessions is by `sessionId`
  with the same later/larger-snapshot-wins policy, and
  `publish-claude.sh --sync [projects-dir]` is the cron-able batch fallback.
- **The subagent merge is two levels (as of #636).** Both `readMergedSession`
  (server) and `listSessions`/`ingestOne` (ingest) read the immediate
  `subagents/*.jsonl` files **and** recurse one level into
  `subagents/workflows/<runId>/agent-*.jsonl` (the per-agent transcripts of a
  Workflow-tool run), via `nestedWorkflowAgentTranscripts` in
  `scripts/workflow-transcripts.mjs`. The run's `journal.jsonl` and the
  `agent-*.meta.json` sidecars are still excluded (no `usage`; not `.jsonl`).
  **Consequence:** workflow-agent token spend, tool use, and failures now flow
  through every `c.merged` parser and reconcile with the Tokens/Cost view —
  closing the #438 caveat. The `msg.id` max-merge in `parse-sessions.ts` keeps
  this idempotent, so a `workflows/wf_*.json` manifest's separate per-run
  `totalTokens` (the Workflow-tab MVP #435 reads those fresh per request) is an
  independent accounting view and does not double-count against the Cost tab.
- **Title lines.** `ai-title` (auto-generated) and `custom-title` (user-set)
  are emitted multiple times per session as they get re-rendered;
  `parse-titles.ts` keeps the last non-empty value per kind, and a
  `custom-title` always wins over an `ai-title` for the same session.
- **Evidence refs.** `src/lib/evidence.ts` defines the shared
  `EvidenceRef` coordinate for evidence-backed features: `sessionId`,
  `entryIndex`, `timestamp`, and optional `toolUseId`. `parse-timeline.ts`
  produces `TimelineEntry.toolUseId` from assistant `tool_use.id` and user
  `tool_result.tool_use_id`, so value-flow edges, forensic graph nodes, Ask
  citations, and risky-action findings can all resolve through
  `resolveEvidenceRef()` to the same timeline entry.

## Installed CLI bundle

```
$(npm root -g)/@anthropic-ai/claude-code/
├── bin/claude.exe       # the launcher symlinked from `which claude`
├── cli-wrapper.cjs
├── install.cjs
├── sdk-tools.d.ts       # canonical SDK tool types
├── package.json
└── node_modules/
```

When you need to confirm a field name actually exists in the CLI (e.g. a
new transcript subtype, a new settings key), grep the bundled `.cjs`
files under this tree. It is minified but greppable. `sdk-tools.d.ts`
in particular is the only non-minified TypeScript surface and is the
fastest place to look up tool input/output shapes.

## In-repo entry points

- `docs/openapi/openapi.yaml` — OpenAPI 3.1 contract for the live server's
  `/api/*` surface (and the two root data feeds `GET /sessions-manifest.json`,
  `GET /history.jsonl`). It is the machine-readable version of the
  `src/lib/api-client.ts` SPA boundary and documents the **server** flavor only
  (the SPA build ships no `/api`). Author it from `scripts/server.mjs` when a
  route's method, params, or response shape changes.
- `scripts/server.mjs` — HTTP server. The legacy default-source routes that
  touch `~/.claude` directly are `GET /projects/<slug>/<file>.jsonl` (with
  subagent merge) and `GET /history.jsonl`; the generic aliases are
  `GET /api/sources/<sourceId>/sessions/<slug>/<file>.jsonl` and
  `GET /api/sources/<sourceId>/history.jsonl`.
- `scripts/ingest.mjs` — incremental ingest. Drives the SQLite cache
  keyed by `mtime+size` per session file, unions `history.jsonl` with
  `history.d/*.jsonl` before transcript precedence is applied, and assembles the
  `liveConfig` bundle. Read this first when
  adding a new live-config field.
- `src/lib/parse-utils.ts` — shared JSONL scaffolding (`parseMessage`,
  `summarize`, `RawSessionEntry`). Every per-session parser builds on
  it; new parsers should too.

## `src/lib/parse-*.ts` → `assembleDataset()` dataset key

The tables above are organised by *artifact*. This one is organised by
*parser*, for filling a `**Where.**` field or tracing a dashboard field back to
its origin. Each row was read off the parser source and `scripts/ingest.mjs`
(`ingestOne` + `assembleDataset`); nothing is guessed.

### Ingest-time parsers (run in `ingestOne` / `assembleDataset`; populate a dataset key)

| `src/lib/` module | Reads (`~/.claude/`) | `assembleDataset()` key it feeds |
| --- | --- | --- |
| `sources.ts` (`resolveSources`) | source configuration (`CLAUDE_DIR`, `CLAUDE_HOME_DIR`, optional `CODING_AGENT_SOURCES`) pointing at `~/.claude`-style roots | `sources`, `sourceId`, `harness` |
| `parse-sessions.ts` (`parseSessionJsonl`) | session transcripts | `tokenData` (each row carries token totals, per-session dimensions, and `opener` — the first user message text, flattened + truncated to ~200 chars per #743) |
| `parse-tools.ts` (`parseToolUsage`) | session transcripts | `toolData` |
| `parse-tool-inventory.ts` (`parseToolInventory`) | session transcripts | `toolInventories` |
| `parse-timeline.ts` (`parseSessionTimeline`) | session transcripts | `timelines` (including stable `toolUseId` on `tool_use` and matching `tool_result` entries for `EvidenceRef`) |
| `parse-errors.ts` (`parseApiErrors`) | session transcripts | `apiErrors` |
| `parse-permissions.ts` (`parsePermissionData`) | session transcripts | `permissionRows`, `permissionChanges` |
| `parse-agents.ts` (`parseAgentSettings` / `parseAttribution`) | session transcripts | `agentSettings`, `attribution` |
| `parse-runtime-events.ts` (`parseRuntimeEvents`) | session transcripts | `runtimeEvents` |
| `parse-steering.ts` (`computeTaskSteering`) | assembled user prompt entries + `runtimeEvents` stop-hook spans + `tokenData` | `taskSteering` |
| `parse-task-success.ts` (`parseTaskSuccess`) | session transcripts (`stop_hook_summary` spans, real next human turns, assistant text claims, tool_use/tool_result blocks) | `taskSuccess` |
| `parse-churn-geometry.ts` (`parseChurnGeometry`) | session transcripts (`toolUseResult.structuredPatch` line geometry plus `stop_hook_summary` task boundaries) | `churnGeometry` |
| `parse-value-flow.ts` (`parseValueFlow`) | session transcripts (`tool_result` content and later `tool_use.input`, resolved through timeline `EvidenceRef`s) | `valueFlow` |
| `parse-assistant-features.ts` (`parseAssistantFeatures`) | session transcripts | `assistantFeatures` |
| `parse-prompt-analysis.ts` (`parsePromptAnalysis`) | assembled user prompt entries (`entries[].display` from transcripts + history JSONL sources) | `promptAnalysis` |
| `parse-deceit-signals.ts` (`parseDeceitSignals`) | session transcripts | `deceitSignals` |
| `parse-secrets-at-rest.ts` (`parseSecretsAtRest`) | session transcripts (user-turn `message.content` text + `tool_result` content + `toolUseResult` payloads, matched with the shared `SECRET_PATTERNS`) | `secretsAtRest` (per-kind counts + `EvidenceRef` coords only — the matched value is never stored; feeds `security.secrets-at-rest`) |
| `parse-titles.ts` (`parseSessionTitles`) | session transcripts | folded into `entries[].title` (no own key) |
| `parse-history.ts` (`parseHistoryJsonl`, `unionHistoryParts`) | `history.jsonl`, `history.d/*.jsonl` (+ transcripts via `deriveEntries`) | `entries` (its `groupBySessions`/`groupByProjects` derive `sessions`/`projects` client-side) |
| `parse-shadow-calls.ts` (`parseShadowCalls`) | `shadow-calls/ledger.jsonl` | `shadowCalls` (per-axis aggregate; feeds `workflow.shadow-axis-wins` + `workflow.uncovered-shadow-axis`) |
| `parse-workflows.ts` (`parseWorkflows`) | projected `workflows/wf_*.json` manifests from `scripts/read-workflows.mjs` | `workflows` (server-only; SPA upload builds the same shape client-side) |
| `parse-external-guidance.ts` (`readExternalGuidanceSnapshots`) | repository-bundled `data/external-guidance/*.json` snapshots | `externalGuidance` (repo-committed reference docs attached to fired recommendations) |
| `parse-docs.ts` (`buildDocGraph`) | repository-bundled root `*.md` + `docs/**/*.md` (+ generated `data/doc-git-times.json`, #2707) | `docGraph` (bounded Markdown node/edge graph; server-produced, client-carried; null in SPA/upload data); nodes carry `gitMtimeProvenance` |
| `doc-git-times.ts` (`parseDocGitTimesManifest`; pure, browser-safe) | generated `data/doc-git-times.json` (producer: `scripts/doc-git-times-generate.mjs`) | joined by `buildDocGraph` into `DocNode.gitMtimeIso`/`gitMtimeProvenance` (no own dataset key; fail-closed on any schema/commit/bounds violation) |
| `parse-docs-map.ts` (`parseDocsMap`) | repository-bundled `docs/docs-map.json` (bounded read + checkout-identity wrap in `scripts/ingest.mjs` `readDocsMap`) | `docsMap` (#2709; versioned source-bound docs-map wrapper, whole-map reject to null; SIGNAL ONLY — no detector reads it yet; null in SPA/upload data) |
| `parse-tasks.ts` (`parseTasksDir`) | `tasks/<sessionId>/<n>.json` (numbered per-session files; `_session.json` skipped) | `tasks` (epic #539, #559; server-only) |
| `parse-teams.ts` (`parseTeamsDir`+`analyzeTeams`) | `teams/<id>/inboxes/*.json` | `teams` (#560; server-only) |
| `parse-session-registry.ts` (`parseSessionRegistryDir`) | `sessions/<pid>.json` | `sessionRegistry` (#561; server-only; feeds #572 report card) |
| `parse-telemetry.ts` (`parseTelemetryDir` / `parseTelemetryLatencyDir`) | `telemetry/1p_failed_events*.json` (full `tengu_*` stream, not only failures) | `telemetry` (#562; server-only; feeds #572 reliability), `modelLatency` (#1166/#915; server-only; successful `tengu_exit` api-duration samples feeding `speed.model-latency`) |
| `parse-debug.ts` (`parseDebugDir`) | `debug/*.txt` | `debugLogs` (#569; server-only; feeds #572) |
| `parse-stats-cache.ts` (`parseStatsCache`) | `stats-cache.json` | `statsCache` (#563; server-only) |
| `parse-file-history.ts` (`parseFileHistoryDir`) | `file-history/<sessionId>/<hash>@v2` (counts + mtimes only) | `fileHistory` (#564; server-only) |
| `parse-plans.ts` (`parsePlansDir`) | `plans/*.md` | `plans` (#565; server-only) |
| `model-eval-ingest.ts` (`ingestModelEvalResults`) | `model-evals/results/*.json` (completed eval-result artifacts, #1079 schema) | `modelEvalSummary` (#1242; server-only; null when the dir is absent) |
| `semantic-intent.ts` (`ingestSemanticIntent`; pure, browser-safe) | `model-evals/semantic-intent/*.json` (bounded intent receipts; producer is a host-side local-classifier runner outside this repo) | `semanticIntent` (#2574; server-only; **opt-in** via `CHD_SEMANTIC_INTENT=1`; null when the flag is unset or the dir is absent; malformed/low-confidence/taxonomy-mismatched/duplicate rows suppress to `unknown` with counted reasons rather than inventing a class) |
| `parse-last-update.ts` (`parseLastUpdate`) | `.last-update-result.json` | `updateResults` (#566; server-only) |
| `parse-mcp-auth.ts` (`parseMcpAuthCache`) | `mcp-needs-auth-cache.json` | `mcpAuth` (#567; server-only) |
| `parse-backups.ts` (`parseBackupsDir`+`diffConfigDrift`) | `backups/.claude.json.backup.*` | `configBackups` (#568; server-only) |
| `parse-config-sections.ts` (`parseConfigSections` / `parseConfigSet`) | config markdown and manifests (`AGENTS.md`, `CLAUDE.md`, project `.claude/*`, `skills/`, `agents/`, `commands/`) | `repoMap.configSections` (nested under the `repoMap` dataset key; no own top-level key) |
| `parse-config-attribution.ts` (`attributeConfigSections` / `summarizeConfigAttribution`) | `repoMap.configSections` plus existing session/tool signals | `repoMap.configAttribution` (nested under the `repoMap` dataset key; no own top-level key) |
| `parse-repo-map-join.ts` (`buildRepoMapDataset`) | repo-map artifacts plus `configSections`, `configAttribution`, file reread/churn signals, and recommendations | `repoMap` (server-only structural join; empty/null in SPA data) |
| `parse-git-outcome.ts` (`buildGitOutcomes`) | per-session `gitBranch` (`SessionDimensions`) joined to PR records the ingest step fetches via `gh`/GitHub API (`readGitOutcomes` in `scripts/ingest.mjs`; opt-in via `CHD_GIT_OUTCOMES=owner/repo`, server-side, no `api.anthropic.com` egress) | `gitOutcomes` (#1757, epic #1911; per-session delivery-outcome label `merged-clean`/`merged-then-reverted`/`merged-then-fixed`/`abandoned` + `provenance`; pure classifier, network-free in tests; SIGNAL ONLY — no detector reads it yet; empty unless `CHD_GIT_OUTCOMES` set or on SPA data) |
| `parse-local-calibration.ts` (`parseLocalCalibration`; pure, browser-safe) | the shadow-calls Tier B calibration report `~/.claude/shadow-calls/calibration-report.json` (`readLocalCalibration` in `scripts/ingest.mjs`; local file read, no query-time shell-out, no `api.anthropic.com` egress) | `localCalibration` (#2318, epic #2177; per-class `pass`/`fail`/`insufficient` calibration rows; server-only; null when no report or on SPA data; consumed by `cost.local-downroute` — proven down-route only on a `pass` receipt, honest-null on `fail`, suppressed on `insufficient`/absent, stale-demoted via provenance.ts) |
| `doc-issue-fetch.ts` (`refreshDocIssueSnapshot`) + `doc-issue-snapshot.ts` (browser-safe schema) | the doc graph's unique `issue:<n>` references resolved against GitHub's GraphQL API in the server preamble (opt-in `CHD_DOC_ISSUES=owner/repo` + file-first credential; fixed host; no `api.anthropic.com` egress; `scripts/ingest.mjs` `readDocIssueSnapshot` reads the validated cache synchronously and never fetches) | `docIssueSnapshot` (#2710, epic #2256; per-ref `open`/`closed`/`not-found`, complete + freshness-bounded (15m/24h) + `sha256(repo+refs)` fingerprinted; fail-closed — incompleteness never proves absence; server-produced, client-carried; null unless `CHD_DOC_ISSUES` set or on SPA data; consumed by #2711) |
| `parse-utils.ts` | — (shared scaffolding) | — (used by the parsers above) |

`parse-config-sections.ts` keeps the repo-map privacy invariant: section bodies
are never persisted, only headings, structural hashes, governing source scopes,
and typed references. `parse-config-attribution.ts` maps those sections to
observable behaviour signatures over existing signals (`toolData` Bash commands
and native Read/Grep/Glob calls). `parse-repo-map-join.ts` is the server-only
join that folds those records into the `repoMap` dataset key alongside file-level
repo-map, reread, churn, and recommendation references.

`liveConfig` is **not** produced by a `parse-*.ts` module — `assembleLiveConfig()`
inside `scripts/ingest.mjs` reads `settings.json`, `CLAUDE.md`, `skills/`,
`agents/`, `commands/`, `plugins/`, `~/.claude.json`, and the same known
project-scoped Claude Code files under readable project roots directly. See the
artifact tables above for those paths and mount requirements.

### API/upload parsers (parse projected payloads; no top-level `assembleDataset()` key)

| `src/lib/` module | Consumes | Output / consumer |
| --- | --- | --- |
| `parse-memories.ts` (`parseMemories`) | raw `GET /api/memories` response, or the equivalent SPA upload collection from `memory/*.md` files | `ProjectMemories[]` for the Memories view (no top-level dataset key; the server route and upload worker provide the payload) |
| `parse-memories.ts` (`buildMemoryStores`, `parseMemoryIndex`) | same raw `GET /api/memories` response, including the `MEMORY.md` index when present (#1965) | `ProjectMemoryStore[]` (per-project fact store split from the `MEMORY.md` index) supplied on `RecommendationInput.memoryStores` at the ingest call site — foundation for the #1779 memory-hygiene `maintenance` detector. NB: the live `readMemories` route still excludes `MEMORY.md`, so the index is empty until that read is widened with #1779. |

### Derived parsers (client-side; consume dataset keys, read no `~/.claude/` artifact)

These run in the browser over the assembled dataset arrays — they have no
`~/.claude/` source and feed no `assembleDataset()` key.

| `src/lib/` module | Consumes (dataset keys) |
| --- | --- |
| `parse-files.ts` (`aggregateFiles`) | `toolData` |
| `parse-file-reread.ts` (`parseFileReread`) | `toolData`, `tokenData` |
| `parse-compaction-risk.ts` (`computeCompactionRisk`) | `tokenData`, `toolData`, `timelines` |
| `parse-tool-effectiveness.ts` (`computeToolEffectiveness`) | `toolData`, `apiErrors`, `timelines` |
| `parse-agent-effectiveness.ts` (`computeAgentEffectiveness`) | `agentSettings`, `attribution`, `runtimeEvents`, `toolData` |
| `parse-timeline-success.ts` (`clusterTimelinesByShape`) | `timelines` |
| `parse-model-recommendation.ts` (`computeModelRecommendations`) | `tokenData` |
| `activity-pulse.ts` (`buildCalendarDays`) | `sessions`, `projects` |
| `automation-runs.ts` (`selectAutomationRuns`) | `timelines`, `sessions` |
| `conversation-patterns.ts` (`aggregateConversations`) | `timelines` |
| `cost-trend.ts` (`computeCostTrend`) | `tokenData` |
| `cost-attribution.ts` (`attributeCostByTool` / `attributeCostByProject` / `topExpensiveSessions`) | `tokenData`, `toolData`, `sessions`, `entries` |
| `context-health.ts` (`scoreSessionHealth` + `compute*`) | `tokenData` |
| `session-overview.ts` (`computeSessionOverview`) | `tokenData`, `toolData`, `timelines`, `apiErrors` |
| `weekly-delta.ts` (`computeWeeklyDeltas`) | `tokenData`, `toolData`, `apiErrors` |
| `parse-policy.ts` (`buildPolicyCandidates`) | `permissionRows`, `permissionChanges` |
| `discovery-failures.ts` (`detectDiscoveryFailures`) | `toolData`, `liveConfig` |
| `config-hygiene.ts` (`computeConfigHygiene`) | `liveConfig` |
| `recommendations.ts` (`buildRecommendations`) | `tokenData`, `toolData`, `sessions`, `projects`, `permissionRows`, `apiErrors`, `liveConfig`, `assistantFeatures`, `timelines`, `agentSettings`, `attribution`, `runtimeEvents`, `taskSteering`, `taskSuccess`, `valueFlow`, `toolInventories`, plus the #539 artifact keys (`tasks`, `teams`, `sessionRegistry`, `telemetry`, `modelLatency`, `debugLogs`, `statsCache`, `fileHistory`, `plans`, `updateResults`, `mcpAuth`, `configBackups`) |
| `report-card.ts` (`buildReportCard`) | `sessionRegistry`, `telemetry`, `debugLogs` (joins all three per project → the #572 Agent Report Card; used by the `reliability.agent-report-card` detector and the Report Card view) |
| `claude-context.ts` (`buildContext`) | the whole dataset (AskClaude prompt context) |

Two of these client modules also expose helpers that `scripts/ingest.mjs`
imports directly: `context-health.ts`'s `OVER_WINDOW` constant (shared
context-window denominator) and `transcript-hygiene.ts`'s `scrubValue`
(secret-scrubbing applied to assistant prose before it is persisted, #204).
Those are ingest-time *helpers*, not dataset-key parsers, so they don't appear
in the ingest table above. Pure browser/UI infra (`api-client.ts`,
`claude-api.ts`, `pricing.ts`, `format.ts`, `theme.ts`, `usage.ts`,
`nav-prefs.ts`, `use-session-tags.ts`, `dataset-worker.ts`, `unzip-upload.ts`)
reads no `~/.claude/` artifact and feeds no dataset key, so it is out of scope
for both tables.

Every dataset key the engine consumes is wired through the single
`assembleRecommendationInput()` mapper in `recommendations.ts`, called by both
the server route (`scripts/ingest.mjs` → `/api/recommendations.json`) and the
client view (`src/components/Recommendations.tsx`). To feed a **new** signal to a
detector, add an optional field to `RecommendationInput` (in
`src/lib/detectors/types.ts`) and map it there — no new server-side computation
is needed for any parser that already populates a dataset key above. New
detectors live one-per-file under `src/lib/detectors/<category>/` and are listed
in the static `src/lib/detectors/index.ts` barrel. Full recipe:
[`docs/adding-a-recommendation.md`](./docs/adding-a-recommendation.md).
