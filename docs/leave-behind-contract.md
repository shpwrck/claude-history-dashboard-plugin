# Leave-behind contract

A durable-state task is human-done only when its operator can resume it from one
committed, state-scoped artifact. That artifact combines the operational map with
the decisions needed to take ownership; a transcript, PR description, or pile of
session-specific notes is not a substitute.

This is the one-artifact standard adopted by
[ADR 0019](./adr/0019-leave-behind-contract.md) for epic
[#2281](https://github.com/shpwrck/claude-history-dashboard/issues/2281).

## When an artifact is required

Create or update a leave-behind when a task materially changes durable state that
is not reconstructed from the checkout alone, including:

- remote hosts, clusters, deployed services, or provider resources;
- generated configuration whose installed output lives outside the checkout;
- system packages, enabled services, cron entries, or named volumes; and
- other persistent state whose location or recovery path a later operator would
  otherwise need to rediscover.

Do not create one for a trivial local-only edit, a routine dependency install
fully reconstructed from a committed manifest and lockfile, or an experiment
that leaves no durable state. The materiality test is practical: would the next
operator face meaningful rediscovery or recovery work without this map?

There is one artifact per stable state scope, not one per issue, PR, agent, or
conversation. Later work on the same state updates the existing artifact.

## Canonical location and marker

The path is:

```text
docs/runbooks/<state-scope>/README.md
```

`<state-scope>` is a lower-case kebab-case name for the durable thing being
operated, such as `app-production` or `dashboard-cache`. It must match the
frontmatter exactly:

```yaml
---
leave-behind: v1
state-scope: app-production
status: current
---
```

The file must be tracked at the current Git HEAD to be conformant. The `v1`
marker describes the contract version; it is not, by itself, proof that the
file is committed.

## Required artifact shape

Use this template. All headings are exact and each subsection needs substantive,
scope-specific content.

```markdown
---
leave-behind: v1
state-scope: app-production
status: current
---

# App production leave-behind

## Operability

### State and access

Name where the state, configuration, credentials, and access procedure live.
Reference a secret manager entry or access role; never copy secret values here.

### Template map

source/template/path -> installed/generated/output/path

### Re-run

Give the canonical idempotent or convergent install/apply command and its
prerequisites. Describe the rerunnable procedure, not the transcript that first
performed it.

### Verify and recover

Give the health check, expected result, failure diagnosis, and rollback or
recovery path.

## Decision log

### Decisions

Record what changed, where it changed, any load-bearing order, why non-obvious
choices were made, constraints, and rejected alternatives a future operator
might otherwise reopen.

### How to drive it

Explain the shortest safe operator loop: what to edit, apply, verify, observe,
and record next. This transfers ownership of this system; it is not a generic
domain tutorial.
```

### Operability

The Operability half answers where credentials, configuration, templates,
generated outputs, and durable state live. Its template map uses literal
`source -> output` notation. Its re-run procedure must be safe to execute again,
and its verify/recover section must let an operator distinguish healthy state
from a partial or failed change.

### Decision log

The Decision log half explains what established the current state, where and in
what order when sequence matters, why it looks that way, and how the next
operator drives it. Keep it situated in the actual state scope. Preserve the
load-bearing sequence, not a chronological transcript, and do not reproduce
generic domain documentation.

## Structural check

[`src/lib/leave-behind.ts`](../src/lib/leave-behind.ts) is the single machine
definition of the path, marker, headings, and structural validator. Callers pass
whether the task required an artifact, the candidate path and content, and the
candidate's Git tracking state:

- `not-required`: the task made no material durable-state mutation;
- `candidate`: the path and content pass, but Git tracking is not observable;
- `conformant`: the structure passes and the file is tracked at HEAD; or
- `invalid`: the path, either half, required subsection, marker, scope, content,
  or tracking check failed.

The transcript parser may inspect a raw full-file `Write` and retain only the
sparse `leaveBehindStructure: "v1"` observation; it discards the markdown. That
observation is deliberately only a structural candidate. The recommendation
detector records a successful full Write as candidate evidence and routes a
candidate-only case to a verification finding only when the candidate follows
the latest durable mutation. That finding books no missing-artifact savings and
requires verifying both Git tracking and coverage of the cited mutation. It does
not treat transcript-only evidence or an unrelated runbook as satisfying the
contract. A later successful nonconformant full Write, Edit, or MultiEdit to the
same canonical path invalidates the candidate; a later conformant full Write
restores it as structural candidate evidence. A repository-aware harness must
pass `trackedAtHead: true` before declaring the artifact conformant.

The checker does not judge prose quality or prove that a re-run command is truly
idempotent. Reviewers still verify those semantic claims. Path-only writes,
partial documents, failed writes, and shell commands that merely mention a
runbook do not satisfy the committed-artifact check.

## Maintenance

Update the same artifact whenever the state layout, access path, source-to-output
map, recovery procedure, or load-bearing decisions change. Mark obsolete content
explicitly or replace it; do not let stale present-tense instructions survive.
The document-graph and staleness work in
[#2256](https://github.com/shpwrck/claude-history-dashboard/issues/2256) and
[#2262](https://github.com/shpwrck/claude-history-dashboard/issues/2262) builds on
this stable path and marker.
