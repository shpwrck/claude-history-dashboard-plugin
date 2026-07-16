# 0019 — One-artifact leave-behind contract for durable state

- **Status:** Accepted (2026-07-15)
- **Date:** 2026-07-15
- **Deciders:** repo owner
- **Related:** epic [#2281](https://github.com/shpwrck/claude-history-dashboard/issues/2281),
  inverse-value framing [#1934](https://github.com/shpwrck/claude-history-dashboard/issues/1934),
  detector foundation [#2312](https://github.com/shpwrck/claude-history-dashboard/issues/2312),
  contract implementation [#2313](https://github.com/shpwrck/claude-history-dashboard/issues/2313),
  profiling receipt [#2315](https://github.com/shpwrck/claude-history-dashboard/issues/2315),
  document graph [#2256](https://github.com/shpwrck/claude-history-dashboard/issues/2256),
  and stale-document handling [#2262](https://github.com/shpwrck/claude-history-dashboard/issues/2262)

## Context

An agent can finish a mechanism while leaving its human operator unable to find
credentials, map a source template to installed state, rerun an installation,
recover a failure, or understand why a non-obvious choice was made. That gap is
the agent-to-human inverse of #1934: machine-done is not necessarily human-done.

Ad hoc runbooks do not close the gap reliably. A path can look like a runbook
while containing only one side of the handoff. Splitting operations and rationale
across files creates another discovery problem. Creating one document per session
or PR produces conflicting snapshots rather than an owned operational surface.

The repository therefore needs one stable artifact contract that humans,
harnesses, and `workflow.value-of-agent-handoff` can recognize consistently.

The issue requested ADR number 0018, but that number was already allocated to
[tiered local-model invocation](./0018-tiered-local-model-invocation.md). ADR
numbers are immutable, so this decision uses the next available number, 0019.

## Decision

### One state-scoped artifact

A material durable-state mutation requires one committed artifact at:

```text
docs/runbooks/<state-scope>/README.md
```

The artifact is scoped to the durable system, not to an issue, PR, agent, or
conversation. Subsequent changes update it in place. A task with no material
durable-state mutation requires no artifact.

### Two inseparable halves

The artifact contains both exact H2 sections:

1. `## Operability` maps state and access, source templates to generated outputs,
   an idempotent/convergent re-run procedure, and verification plus recovery.
2. `## Decision log` records non-obvious choices and gives a situated "how to
   drive it" operator loop.

Neither half is sufficient alone. Operability without rationale makes future
changes unsafe; rationale without operability leaves the system undiscoverable.
The canonical template and materiality guidance live in
[`docs/leave-behind-contract.md`](../leave-behind-contract.md).

### Machine-recognizable contract

The artifact carries this frontmatter:

```yaml
---
leave-behind: v1
state-scope: <state-scope>
status: current
---
```

The browser-safe validator in `src/lib/leave-behind.ts` is the single definition
of the path, marker, headings, and structural requirements. It distinguishes:

- tasks where no artifact is required;
- structurally valid candidates whose Git state is not observable;
- conformant artifacts verified as tracked at HEAD; and
- invalid artifacts, including either missing half or an untracked file.

The transcript parser evaluates only raw full-file `Write` content and persists a
sparse `leaveBehindStructure: "v1"` field. It does not retain markdown. The
recommendation detector imports the shared contract and records only successful,
final Writes as structural candidates; a later successful full Write, Edit, or
MultiEdit invalidates prior candidate evidence for that path. Transcript-only
candidates cannot prove Git tracking, so candidate-only sessions produce an
accounting verification finding only when the candidate follows the latest
durable mutation. It books no missing-artifact savings and requires verification
of both HEAD tracking and semantic coverage; an earlier or unrelated runbook
does not displace the missing-write signal. A repository-aware harness must
separately prove Git tracking before claiming the stronger `conformant` status.

### Security and truthfulness

The artifact names credential locations and access procedures, never credential
values. A structure marker is evidence of observed structure, not proof of prose
quality, command idempotence, or Git commitment. Product claims and harness output
must preserve those distinctions.

## Consequences

- A future operator has one predictable entry point for both action and context.
- The optimal artifact rate follows material durable-state changes instead of
  incentivizing documentation for every task.
- Parser and dataset caches must turn over when the sparse marker is introduced,
  or old calls would be indistinguishable from newly evaluated failures.
- Existing runbooks outside the canonical path do not suppress the detector until
  deliberately migrated; false negatives are safer than false confidence.
- The structural check catches missing halves and marker/path errors, but humans
  remain responsible for semantic accuracy and safe rerun/recovery instructions.
- Stable paths and markers give #2256 and #2262 a reliable basis for document
  graph and freshness work.

## Alternatives rejected

- **Separate runbook and decision-log files.** This preserves the discovery and
  drift problem the contract is intended to remove.
- **One artifact per PR or conversation.** Durable state outlives both and would
  accumulate contradictory snapshots.
- **Require an artifact for every task.** This creates noise and weakens the
  signal; reconstructible local work has no material handoff cost.
- **Accept path-only or command-based evidence.** A filename cannot prove either
  required half, success, or safe operational content.
- **Require only a narrative transcript.** A transcript is chronological residue,
  not an idempotent operating and recovery interface.

---

Back-link: this ADR records the contract implemented by
[#2313](https://github.com/shpwrck/claude-history-dashboard/issues/2313) under
epic [#2281](https://github.com/shpwrck/claude-history-dashboard/issues/2281).
