# Project conventions

Harness-agnostic conventions for this repo — they apply to any coding agent (Claude Code,
Codex, …). Harness-specific instructions live in a sibling file that imports this one:
`CLAUDE.md` pulls this in via `@AGENTS.md` and adds Claude-Code-only rules. Keep anything
only one harness can do (its slash-commands, hooks) out of this file.

## External data shapes

See [`REFERENCES.md`](./REFERENCES.md) for the authoritative map of every
`~/.claude/` artifact this dashboard reads (transcripts, history,
`/insights` outputs, settings, skills, agents, commands, plugins,
`~/.claude.json` MCP config) and which `src/lib/parse-*.ts` consumes each
one. Start there before reverse-engineering a parser.

When a change leverages this mapping in any way — to find the right
parser, locate a path constant, or confirm a field shape — and you
notice the mapping is stale or incomplete, **file a `documentation` +
`backlog` issue** capturing what's wrong. Don't repair it inline on an
unrelated PR; that's how scope balloons. The repair goes through the
normal backlog queue like any other doc fix.

## Local-first by default: non-local data is opt-in

The product is local-first: the free, automatic path answers from local
`~/.claude` (and `~/.codex`) artifacts, stays fast, and produces no
side effects. So any dashboard/recs feature whose data is **not** immediately
answerable from those local artifacts — it needs the network, an external fetch
(`gh`/GitHub API), a separate service, or any other non-local source — must be
**opt-in and off by default**, gated behind an explicit env flag. With the flag
unset the default deployment path is byte-identical and makes **zero external
calls**; state that flag-off guarantee in the spec/PR and verify it. Worked
examples: `CHD_GIT_OUTCOMES=owner/repo` gates the git delivery-outcome `gh`
fetch (#1757), and `CHD_INGEST_CODEX=1` gates Codex ingest (#1756). This is the
general non-local-data rule; it complements — and does not restate — the
SPA/server free/paid split (see *Build & deploy* and the *Other load-bearing
notes* SPA/server entry) and the Anthropic-egress governance in
[ADR 0008](./docs/adr/0008-server-llm-usage-governance.md).

## Recommendations are auditable claims

A recommendation is an **auditable product claim**, not vibes or generic advice
— agents consume `/api/recommendations.json` as operating guidance (via `/recs`),
so a false claim, a stale present-tense assertion, or an unsafe copy-paste fix
erodes trust in the whole engine (epic #866; audit #1049). When you add or change
a recommendation detector you MUST keep it auditable: evidence-backed and
reproducible (cite the artifact/field, prefer structured `provenance`); fix
snippets declare their `fixKind` and a `validated` snippet is genuinely
copy-paste-safe (no non-portable reference — `detectors/fix-validity.ts`);
historical/stale signals are demoted to "as of \<date\>" or suppressed, never
phrased as current state; and the detector ships tests for evidence, stale-data
handling, suppression, and fix validity. The full contract and recipe live in
[`docs/adding-a-recommendation.md`](./docs/adding-a-recommendation.md). Agent
consumers of `/recs` output must treat non-`validated` fix snippets as examples
to adapt, never as mandatory commands.

## Backlog & tracking

**The backlog lives in GitHub issues, not in any agent's in-session task list.**
When the user says "add this to the backlog" or names new work, capture it as an
issue immediately, before starting implementation — that way the work survives
session boundaries and is visible to any future agent (or human) opening this
repo.

### Release/epic model

Since `v0.1` (see [`docs/RELEASING.md`](./docs/RELEASING.md)) work is organized
around **releases**: a milestone (`v0.2`, …) buckets the **epics** committed to
that release. An epic is an `epic`-labelled issue decomposed into **sub-issues**
via the convention: clean titles (no `[epic]`/prefix tags), an `epic-NNN` label
on each child, and native GitHub **sub-issue links** (so the epic shows a
progress rollup). Milestones compose with the `backlog` label — an issue can be
both — so the automation below is unaffected.

Two **Claude Code skills** drive this (other harnesses can't invoke them, but must
respect the resulting structure when filing or picking up issues):

- **`/groom-release`** (interactive) — real release grooming: pick the epics for
  a release, and confirm each is well-specced or **decompose** it into specced
  sub-issues. It assigns epics to the milestone and writes sub-issues; it
  interviews the user for scope decisions.
- **`/burn-epic`** (autonomous) — burns one epic at a time: takes the active
  release milestone's highest-priority epic, implements its best eligible
  sub-issue (worktree → lint/build → PR), files new sub-issues it discovers for
  that epic, just-files unrelated work as plain `backlog` issues, then moves to
  the next epic; falls back to loose backlog issues when epics are drained.

### Filing & labels

- New ask → `gh issue create --title "..." --body "..." --label backlog`
  (add domain labels like `ui`, `infra`, `tech-debt`, `documentation`,
  `enhancement` as fits — they already exist). A child of an epic also gets its
  `epic-NNN` label + a sub-issue link to the parent.
- If the work's deliverable is **not** dashboard-repo code — e.g. it edits the
  `burn-epic`/`groom-release` skill scripts under `~/.claude/`, or it's a
  pure process change with no repo diff — also add the `meta` label. The
  `burn-epic` picker skips `meta` issues (its worktree → lint/build → PR →
  deploy contract can't apply); they're handled directly/manually. Repo files
  like `.github/workflows/`, `docker-compose*.yml`, and `CLAUDE.md`/`AGENTS.md`
  themselves are **not** meta — those produce normal PRs.
- Starting work → `gh issue edit <N> --add-label in-progress` (create the
  label on first use if needed) and reference the issue in your branch name
  (e.g. `feature/123-ask-claude-overlay`).
- Finishing work → put `Closes #N` in the PR body so the merge auto-closes
  the issue.
- Picking up cold → `gh issue list --label backlog --state open` is the
  authoritative queue (epics: `--label epic`; a release: `--milestone v0.2`).
  Do NOT trust any local task list, SPRINT_STATUS.md, or memory note as the
  source of truth — those are session-scoped scratch.

If a request is ambiguous about whether it's "do now" vs. "queue for later",
default to queueing as an issue first, then start work against that issue.
The user can always say "skip the issue and just do it" for trivial one-liners.

### Autonomous work queue (`for-agent`) — coder/reviewer contract

This repo's groomed work is burned down by **agents** playing one **role** —
**coder** or **reviewer** — each invoked through its cross-harness skill (`coder`,
`reviewer`). Role is decoupled from **vendor** (Claude or Codex runs the skill)
and from **instance** (one running agent). Several coders and reviewers may run at
once; the rules below keep them from overlapping. Claude's `/burn-epic` loop is a
separate consumer of plain `groomed` work and its picker treats `for-agent` as
ineligible, so the two loops never grab the same issue.

- **One queue label: `for-agent`.** A `groomed` issue tagged `for-agent` is ready
  for a coder. Your queue is the pairing:
  `gh issue list --label for-agent --label groomed --state open`. There is no
  vendor in the label — re-running the role skill on a different model is just a
  later run, not a different label. Claude stamps the label via `/handoff-to-agent`
  (other harnesses can't invoke the skill but must respect the resulting labels).
- **Signing — every issue/PR comment ends with a signature**, so authorship is
  recoverable even when agents share a GitHub account:

  ```
  <!-- agent-sig v1 vendor=codex role=coder instance=coder-1 -->
  Signed: Codex coder (coder-1)
  ```

  `instance` is the unique, stable name of this running agent (`coder-1`, `rev-2`,
  …), set when it is provisioned and kept across all its turns. PR bodies are
  signed the same way. Never edit or delete another agent's signed comment.
- **Claim lock (non-overlap).** A coder claims an issue with the `in-progress`
  label **and** a signed claim comment; a reviewer claims a PR with `in-review`
  **and** a signed claim comment. Take **new** work only when it is unclaimed (no
  `in-progress`/`in-review`, no `blocked`); **resume** only work whose latest claim
  signature carries **your own `instance`**; never act on an item claimed by a
  different instance. Drop your claim label if you abandon work so it returns to
  the queue.
- **Dependency gating (self-clearing build order).** An issue that must wait on
  another carries `blocked` and a `**Blocked by** #N` line; coders skip `blocked`.
  When a reviewer merges the PR that closes #N, it removes `blocked` from every
  issue whose listed blockers are now **all** closed — so the queue opens itself in
  dependency order. (Keystone-first epics rely on this: the shared primitive lands,
  then its slices unblock.)
- **If the spec looks thin** (a `**Where./Fix./Acceptance./Priority.**` field is
  empty or a `TBD`/"groom later" stub), don't guess — leave a signed comment noting
  the gap and move on; `for-agent` means *routed*, not *fully designed*.
- **Finishing (coder)** → open the PR with `Closes #N` and a signed body; remove
  `in-progress` (keep `groomed` + `for-agent`). **Finishing (reviewer)** → when
  satisfied and CI is green, approve and merge, then reconcile `blocked` on
  dependents. Out-of-scope discoveries are **filed to the backlog** as new signed
  issues, never fixed inline.

## Build & deploy

- Build: `npm run build` (`tsc -b && vite build`) — type-clean as of #978, and
  CI runs the same full build, so a type regression fails CI. `npx vite build`
  skips the typecheck when you only need the bundle (faster).
- Typecheck / validate: `npm run typecheck` (`tsc -b`); `npm run validate`
  (lint + test + full build) is the pre-PR gate.
- Lint: `npm run lint`
- Deploy: `CHD_APP_IMAGE=localhost/claude-history-dashboard:local podman compose -f docker-compose.yml -f docker-compose.local.yml up --build -d`
  from the repo root. The container holds port 5173. Verify on
  `http://127.0.0.1:5173` (pasta networking is IPv4-only — `localhost` may
  resolve to `::1` and reset). There is no systemd service.
  - Keep `--build` when shipping local frontend changes — it rebuilds the image
    from the working tree (this is what `/ship` and the deploy hooks rely on).
  - To deploy the **published** image instead (no rebuild; faster; pinnable
    rollback target), `pull` then `up -d` without `--build`. The committed
    default is digest-pinned, so registry tag movement cannot change the
    selected executable:
    `podman compose -f docker-compose.yml -f docker-compose.local.yml pull && podman compose -f docker-compose.yml -f docker-compose.local.yml up -d`.
    Every push to `master` publishes `ghcr.io/shpwrck/claude-history-dashboard:latest`
    + `:sha-<short>` via `.github/workflows/docker-publish.yml`.
  - `npm run deploy` (wrapping `scripts/deploy.sh`) is the canonical deploy: it
    **refreshes the host-side repo-map artifacts** (`npm run refresh:repo-map` →
    `scripts/repo-map-generate.mjs` per ingested root) before the same `compose
    … up`, so the `context.repo-map-context-waste` recommendation stays live on
    real data (#1650). Generation needs devDeps + the WASM Tree-sitter grammars
    and must stay **host-side** — never in the zero-node_modules runtime
    container (ADR 0007, #1013/#1195). `npm run deploy:pull` refreshes then runs
    the published-image path; `scripts/deploy.sh --no-refresh` skips the refresh.
- SPA build (#324/#325): `npm run build:spa` (`vite build --mode spa`) emits the
  upload-only static bundle. Deploy it standalone with the **self-contained**
  `docker-compose.spa.yml` (nginx image `Dockerfile.spa`, host port 8325, **no
  `~/.claude` bind mount, no `/api/*`**):
  `CHD_SPA_IMAGE=localhost/claude-history-dashboard-spa:local podman compose -f docker-compose.spa.yml up --build -d`, verify on
  `http://127.0.0.1:8325`. The same publish workflow pushes
  `ghcr.io/shpwrck/claude-history-dashboard-spa:latest` + `:sha-<short>`. Any new
  server call MUST route through `src/lib/api-client.ts` or the `spa-boundary` CI
  job fails — see the SPA/server split note below.

## Worktrees & the shared checkout

**Create a git worktree before any branch-scoped work in this repo — do not commit,
branch, or stash in the main checkout.** The main checkout
(`project/claude-history-dashboard`) and the standing `chd-main` / `chd-spa`
instances are each a single working directory that **more than one live agent
session can share at once**. A working tree has exactly one HEAD, so a `git checkout`
in one session is a global mutation that drags HEAD, the index, and tracked files
out from under every other session in that directory — silently, at any moment.

A start-of-task `git branch --show-current` check does **not** protect you: it is a
point-in-time read that races against a concurrent checkout landing afterward (this
recurred in #954/#955 — the check passed, then a foreign checkout moved HEAD, and a
`git stash` workaround wrote conflict markers into another session's uncommitted
files). Only worktree isolation is immune, because each worktree has its own HEAD.

- Start PR work with `git worktree add -b <branch> ../<dir> origin/master` and work
  in that directory. Confirm with `pwd` + `git branch --show-current` there.
- A fresh worktree off `origin/master` does **not** carry untracked files from the
  main checkout. If the file to commit exists only as an untracked file there, pass
  its content into the worktree (re-create + `git add`) or commit via `gh api` —
  never branch-switch the shared checkout to grab it.
- Failure signature to recognize: `git stash` → `CONFLICT` / `Aborting` / "Please
  move or remove them before you switch branches" usually means you are mutating a
  shared checkout. Stop and move to a worktree.

## PR scope gate

Merging approved PRs to `master` is **in scope** for agent sessions, with a
machine-review guardrail that replaces the human review step the maintainer no
longer performs. Open the PR via `gh pr create`, then merge it ONLY once **both**
hold:

1. **CI is green** — every required GitHub check has passed (not pending, not
   absent). The `PR has a diff` (`pr-nonempty.yml`), `spa-boundary`, and `test`
   jobs are load-bearing here; a missing/empty-diff PR must never be merged (see
   [`docs/adr/0001-squash-merge-missing-commits.md`](./docs/adr/0001-squash-merge-missing-commits.md)).
2. **Self-review passed** — run a self-review pass on the diff (in Claude Code,
   `/code-review`; otherwise the harness's equivalent) and surface anything
   notable in the conversation before merging. Don't merge over an unresolved
   high-confidence finding without flagging it.

Prefer pushing a single squashed commit per PR, and after merge verify the
expected files actually landed on `master` (`git show master -- <file>`) — CI
can't catch a partial push (#124). If either gate can't be satisfied, stop and
surface the PR for manual merge rather than forcing it.

## Kubernetes substrate: reuse over build

The k8s agent-ops substrate (epic #1247) runs on the CNCF ecosystem, which means
almost every cross-cutting concern already has a battle-tested off-the-shelf
component. **The default is to compile our intent onto an existing enforcer, not
write a new one.** Before building any mechanism — egress control, admission,
per-credential budgets/rate limits, content scrubbing, MCP/LLM brokering, secret
delivery, scheduling, observability — name the component that already does it
(NetworkPolicy/Cilium, Kyverno/OPA, LiteLLM, agentgateway, External Secrets,
ResourceQuota, seccomp/AppArmor, kagent, …) and justify in the sub-issue why it is
insufficient. Custom code is the exception and carries the burden of proof.

What genuinely stays ours is the harness-native seam no ecosystem tool models: the
operator's reconcile of `RemoteSession`, the config bake + sidecar shipper + the
`~/.claude` tree classification, and the subscription-OAuth credential path (LLM
proxies are built for API keys — they absorb the enterprise-API path's
budgets/scrub/spend, not the OAuth path). See
[ADR 0010](./docs/adr/0010-k8s-substrate-reuse-over-build.md) for the full posture
and the concern→component table; #1255 carries the narrower "don't invent an
enforcement runtime" form for the policy layer. Reuse changes *who enforces*, not
*who wins* — enforced policy stays a ceiling the in-pod `settings.json` may only
narrow.

## Other load-bearing notes

- **Avoid emoji wherever possible — prefer plain characters.** In UI copy,
  code, docs, commit messages, and especially GitHub Actions workflow output,
  use a plain character instead of an emoji. The repo's established convention
  is the check-mark character `✓` (used in `SessionList.tsx`, `PFLayout.tsx`,
  `ConfigHygiene.tsx`) rather than the `✅` emoji — e.g. `notify-ready.yml`
  posts `✓ All checks green`, not `✅`. Emoji render inconsistently across
  terminals, fonts, and email/notification surfaces; plain characters don't.
  The deliberate symbol-character nav-icon scheme in `nav-prefs.ts`
  (`★ ⚙ ◎ ✦ ○` …) is fine — those are characters, not emoji.
- **Anthropic API governance is scoped, not blanket.** Free, automatic, and
  local analysis paths stay local and must not call `api.anthropic.com`. Server
  components may call Anthropic only under
  [ADR 0008](./docs/adr/0008-server-llm-usage-governance.md): the call site is
  registered, the feature is opt-in, it uses an explicitly configured Console
  API key, content passes the egress scrub, and spend is capped. The user's
  subscription OAuth credential must never send
  `~/.claude`-derived content. This does not change ADR 0005's free-path rule
  or the global `~/.claude` shadow-calls rule; those remain local-only.
- **`service_tier` is an API field, not deployment infrastructure.** It
  appears in token-usage parsers (`src/lib/parse-sessions.ts`,
  `src/lib/parse-timeline.ts`, `src/types.ts`, `src/components/SessionTimeline.tsx`).
  Don't over-match it when sweeping for "systemd" or related deploy refs.
- **PRs can merge with missing/empty diffs when work commits never reach
  the branch head.** Earlier this was misdiagnosed as "GitHub squash drops
  the second commit." It isn't — squash-merge faithfully squashes whatever
  is on the branch head. The investigation (issue #177, see
  [`docs/adr/0001-squash-merge-missing-commits.md`](./docs/adr/0001-squash-merge-missing-commits.md))
  found PRs #115 and #119 merged an **empty** diff and #124 a **partial**
  one because their branch heads held only a stale shared commit
  (`8519e3f3e` "Sprint status…"), not the intended work — a push/worktree
  race during the parallel sprint that opened #104–#113 at once. The repo's
  `squash_commit_title=COMMIT_OR_PR_TITLE` setting is why those merges were
  even titled "Sprint status…" instead of the PR title: a branch with one
  commit ahead of base squashes under that commit's headline. **Guardrail:**
  the `PR has a diff` CI check (`.github/workflows/pr-nonempty.yml`) fails
  any PR whose diff against the base is empty — the exact silent failure that
  hit #115/#119. CI can't detect a *partial* push (#124), so still verify the
  expected files landed on master after merge (`git show master -- <file>`),
  and prefer pushing a single squashed commit per PR.
