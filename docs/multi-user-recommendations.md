# Multi-user recommendations

Issue #942 asks which existing dashboard data can support team and
organization recommendations without waiting for a new identity system. The
safe answer is narrow: use persisted task ownership and team inbox artifacts
for operational coordination, then join to session/project metadata only for
attribution.

## Existing sources

- `~/.claude/tasks/` via `src/lib/parse-tasks.ts`: task id, subject, owner,
  status, blockers, blocked-by links, PR URL, session id, and task mtime. This
  is the strongest current source for multi-user work ownership because the
  owner is explicit and the status is already normalized.
- `~/.claude/teams/` via `src/lib/parse-teams.ts`: team inboxes, dropped
  assignments, unread counts, stalled agents, and dropped percentages. This is
  the strongest current source for handoff and dispatch failures.
- Transcript-derived `sessions` and `projects`: project names, short project
  labels, session ids, timestamps, entrypoint, and token/tool aggregate joins.
  These make recommendations easier to triage, but they are not durable user
  identity.
- `~/.claude/sessions/` via `src/lib/parse-session-registry.ts`: live process
  cwd, entrypoint, version, and session id. Useful for process attribution, but
  not a durable human or team account model.
- `RecommendationInput.reviewEvents` via the enterprise review-event contract:
  connector-supplied PR review-request records with repository, PR number,
  reviewer id, request state, and request/response timestamps. This is the
  expected GitHub-backed source for review latency and reviewer queue depth; it
  carries no transcript or prompt text.

## GitHub review sync

Issue #1127 adds the first server-side source for `reviewEvents`. In enterprise
server mode an operator can set `DASHBOARD_REVIEW_EVENTS_SOURCE=github`,
`DASHBOARD_GITHUB_REVIEW_TOKEN`, and `DASHBOARD_GITHUB_REVIEW_REPOS` to fetch
open pull requests plus bounded issue timeline events from GitHub. The sync
emits only currently pending individual reviewer requests that have an explicit
`review_requested` timestamp in the timeline. If the source, token, or repo list
is missing, `reviewEvents` stays null and `workflow.review-bottleneck` stays
dark. Timeline reads use a bounded pool (four requests by default), and one
15-second synchronization deadline covers pull-list and timeline fetches across
the configured repositories; operators can narrow both limits explicitly.

The sync cache participates in the existing dataset source signature and content
hash, so `/api/dataset.json` and `/api/recommendations.json` update when the
review-event cache changes. The cache is keyed by a token fingerprint-derived
config hash and repository list, stores no raw token, and is disabled for scoped
member/viewer ingest so the org-wide review queue remains an admin/global view.

## Identity contract

`RecommendationInput.organizationIdentity` is the optional durable identity
aggregate for organization recommendations. It contains stable contributor ids,
display names, team ids, and explicit aliases such as `task-owner`, `email`,
`username`, `git-author`, or `session-user`.

Detectors may use the identity aggregate only through explicit aliases. Unknown
or ambiguous aliases stay unknown or ambiguous; they are not resolved from prompt
text, cwd, session ids, entrypoint values, or display names. This lets local and
SPA datasets keep working without identity data while enterprise deployments can
add configured or IdP-synced contributor maps later.

## Initial recommendation set

- `reliability.dropped-assignments`: existing detector. Flags team inboxes with
  dropped work and stalled agents so a lead can redispatch the queue.
- `workflow.owner-concentration`: new detector. Flags open owned task queues
  where at least two owners are present, at least six open owned tasks exist,
  and one owner group carries at least four tasks plus 60% of the queue. When
  `organizationIdentity` is present, explicit `task-owner` aliases can roll up
  multiple owner strings into one durable contributor. It links to Task Health
  and cites task ownership/status observations in provenance.
- `workflow.review-bottleneck`: new detector. Flags stale pending PR review
  requests only when `reviewEvents` is present. It requires at least three stale
  pending requests overall and at least two on one reviewer, cites concrete
  review-event observations, and can roll reviewer usernames into
  `organizationIdentity` contributors through explicit aliases.

## Larger follow-ups

Organization-wide capacity recommendations still need broader role/capacity
inputs. The current dashboard can infer project attribution from sessions, but
it should not pretend that `sessionId`, process cwd, or entrypoint are durable
organization identities.

Cross-org recommendations should continue using structured aggregate fields.
They should not require inline transcript content or private prompt text.
