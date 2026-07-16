# Experiment runtime schema v1

> Implementation addendum (2026-07-14): the later resolutions in #2609 and
> #2610 supersede the illustrative shapes below where they differ. All three
> authoritative documents carry canonical `contentDigest` values; every Run
> carries the complete Behavior Fingerprint and exact `selectionRef`; Verdicts
> reference exact Run digests, carry typed primary effects, and retain only
> source `evidenceBasis`. Cross-harness applicability is derived, never stored
> as authoritative Verdict state. The fingerprint digest covers the complete
> manifest with only its own `digest` omitted.

Status: decision record for [Define the Experiment Definition, Run, and Verdict schema](https://github.com/shpwrck/claude-history-dashboard/issues/2592)

Date: 2026-07-13

Signal basis: [Portable signal inventory](../audits/2026-07-portable-signal-inventory.md)

## Decision

The experiment runtime has three separate JSON document kinds:

1. `ExperimentDefinition` describes an immutable version of an experiment.
2. `ExperimentRun` records one Treatment execution under one harness.
3. `ExperimentVerdict` is the single current comparison outcome for one trial.

JSON Schema is the authoritative wire contract. The documents do not use a
Kubernetes envelope and do not assume any orchestration substrate. JSON and YAML
authoring tools may exist, but they must normalize input to JSON before schema
and semantic validation.

The schemas are closed-world: every core object uses
`additionalProperties: false`. Unknown schema versions are rejected. Optional
vendor or UI data lives only under namespaced `extensions`; extensions are
preserved but cannot affect execution, eligibility, evidence, or judging.

## Common conventions

Every document has:

```json
{
  "schemaVersion": 1,
  "kind": "ExperimentDefinition | ExperimentRun | ExperimentVerdict",
  "extensions": {
    "example.com/annotation": {}
  }
}
```

- `schemaVersion` is the positive integer version of that document kind's JSON
  Schema. It is independent of an Experiment Definition's version.
- `definitionId` is a stable, readable, namespaced string.
- `definitionVersion` is a positive integer. Semantic changes always increment
  it; Definition versions do not make SemVer compatibility claims.
- `runId`, `trialId`, and `verdictId` are generated UUIDs.
- A `definitionRef` always contains `definitionId`, `definitionVersion`, and
  `contentDigest`.
- `contentDigest` is `sha256:` plus the SHA-256 of RFC 8785 canonical JSON for
  the Definition with its own `contentDigest` field omitted.
- All timestamps are RFC 3339 UTC strings.
- Durations are integer milliseconds. Token and count fields are non-negative
  integers. USD amounts are non-negative decimal numbers.
- References use IDs rather than embedding copies of other documents.
- Extension keys match `<dns-namespace>/<name>`. Their values may be arbitrary
  JSON, but the runtime cannot consult them for behavior or evidence.

## ExperimentDefinition

### Shape

```json
{
  "schemaVersion": 1,
  "kind": "ExperimentDefinition",
  "definitionId": "shpwrck/speed.background-first",
  "definitionVersion": 1,
  "contentDigest": "sha256:...",
  "title": "Background long-running verification",
  "description": "Tests whether backgrounding eligible verification reduces wall time.",
  "createdAt": "2026-07-13T00:00:00Z",
  "createdBy": "shpwrck",
  "portability": {
    "class": "portable"
  },
  "studyDesign": {
    "kind": "paired"
  },
  "workload": {
    "selector": {
      "id": "history.completed-coding-task",
      "version": 1,
      "capability": {
        "id": "workload.history.completed-task",
        "minimumSemanticsVersion": 1
      },
      "parameters": {}
    }
  },
  "requiredCapabilities": [
    {
      "id": "execution.headless",
      "minimumSemanticsVersion": 1
    },
    {
      "id": "measurement.turn-wall-time",
      "minimumSemanticsVersion": 1
    }
  ],
  "treatments": [
    {
      "id": "control",
      "label": "Foreground verification",
      "control": true,
      "interventions": []
    },
    {
      "id": "background-first",
      "label": "Background eligible verification",
      "control": false,
      "interventions": [
        {
          "capability": {
            "id": "intervention.background-eligible-work",
            "minimumSemanticsVersion": 1
          },
          "operation": "enable",
          "value": true
        }
      ]
    }
  ],
  "metrics": [
    {
      "id": "turn.wall-time",
      "unit": "ms",
      "scope": "run",
      "basis": "native-turn-duration",
      "semanticsVersion": 1,
      "collector": {
        "capability": {
          "id": "measurement.turn-wall-time",
          "minimumSemanticsVersion": 1
        },
        "operation": "sum-active-turns",
        "parameters": {}
      }
    }
  ],
  "checks": [
    {
      "id": "project.validate",
      "capability": {
        "id": "check.project-command",
        "minimumSemanticsVersion": 1
      },
      "operation": "run",
      "parameters": {
        "commandRef": "project.validate"
      }
    }
  ],
  "estimatedUsage": {
    "wallTimeMs": 900000,
    "totalTokens": 80000,
    "turns": 20,
    "toolCalls": 40
  },
  "limits": {
    "wallTimeMs": 1800000,
    "totalTokens": 160000,
    "turns": 40,
    "toolCalls": 80
  },
  "safeguards": {
    "policy": {
      "id": "runtime.default",
      "version": 1
    },
    "relaxationRequests": []
  },
  "verdictPolicy": {
    "id": "objective-first",
    "version": 1,
    "parameters": {}
  },
  "extensions": {}
}
```

### Portability

`portability` is one of:

```json
{ "class": "portable" }
```

```json
{
  "class": "harness-specific",
  "allowedHarnesses": ["claude-code"]
}
```

A portable Definition may use only capabilities, selectors, interventions,
metric collectors, and checks whose registered semantics are portable. A
harness-specific Definition must name at least one allowed harness. There is no
separate author-editable evidence scope; Evidence Applicability is derived in
the Verdict.

`requiredCapabilities` is a flat all-required list. Version 1 has no nested
AND/OR expression language and never uses raw harness tool names as capability
IDs. Eligibility uses the union of this list and the capability references on
the workload selector, interventions, metric collectors, and checks; referenced
capabilities do not need to be duplicated in the top-level list.

### Study designs and assignment

Version 1 supports only:

```json
{ "kind": "paired" }
```

Every Treatment runs against the same resolved subject.

```json
{
  "kind": "cohort",
  "assignment": { "kind": "explicit" },
  "minimumRunsPerTreatment": 5,
  "maximumRunsPerTreatment": 20
}
```

```json
{
  "kind": "cohort",
  "assignment": { "kind": "randomized" },
  "minimumRunsPerTreatment": 5,
  "maximumRunsPerTreatment": 20
}
```

Randomized assignment is uniform and records its seed on the Run. Weighted,
balanced, stratified, adaptive, and statistical stopping rules are outside
schema v1. `maximumRunsPerTreatment` is optional. Before every Treatment reaches
the minimum, a Verdict may exist only as `inconclusive`.

### Workloads, Treatments, metrics, and checks

- `workload.selector` is a registered, versioned selector. Its parameters are
  validated by that selector's JSON Schema. It produces a content-pinned
  `subjectRef` for each Run; Definitions do not copy prompts or repositories.
- A Definition has at least two Treatments and exactly one has `control: true`.
- Each intervention names a capability and operation. Its `value` is validated
  by that capability operation's JSON Schema. There is no opaque Treatment
  configuration blob.
- Metrics are declared inline. Each declaration supplies ID, unit, scope,
  collection basis, semantics version, and a capability-bound collector. A
  portable metric does not need to belong to a central catalog, but every target
  adapter must certify the declared semantics.
- Checks apply consistently to every Treatment. A portable Definition cannot
  contain a check backed by a proprietary capability.
- The Verdict Policy is runtime-owned and referenced by ID and version.
  Definitions may supply schema-validated parameters but cannot embed executable
  judge code.

### Estimates, limits, and safeguards

`estimatedUsage` and `limits` share the same optional version-1 dimensions:

```json
{
  "wallTimeMs": 1,
  "totalTokens": 1,
  "turns": 1,
  "toolCalls": 1,
  "costUsd": 0.01
}
```

- Estimated Usage is non-binding input to harness selection.
- Limits are hard per-Run ceilings and are never inferred from estimates.
- A token- or cost-based limit makes the corresponding measurement/enforcement
  capability required. Missing support is an eligibility failure, not zero.
- The runtime's kill switch, credential protection, and hard limits cannot be
  relaxed.
- A Definition may request other Safeguard Relaxations. A request has no effect
  until an operator authorizes that exact relaxation for a specific Run.

A relaxation request is declarative and policy-validated:

```json
{
  "requestId": "network.github-read",
  "safeguard": "network.egress",
  "requestedValue": "github-read-only",
  "reason": "The workload selector reads issue evidence"
}
```

### Definition immutability

A Definition Version may be drafted and validated before use. Once any Run
references it, the document is immutable. Every semantic change creates the
next positive integer `definitionVersion` and a new digest. Display-only catalog
annotations live outside the Definition so they cannot rewrite evidence meaning.

## ExperimentRun

### Shape

```json
{
  "schemaVersion": 1,
  "kind": "ExperimentRun",
  "runId": "58b6f848-c708-4cc8-9766-23b89d8613e2",
  "trialId": "ac0d56d9-37cd-4d50-ab42-0ed8fefb193b",
  "definitionRef": {
    "definitionId": "shpwrck/speed.background-first",
    "definitionVersion": 1,
    "contentDigest": "sha256:..."
  },
  "treatmentId": "background-first",
  "retryOf": null,
  "status": "succeeded",
  "createdAt": "2026-07-13T00:00:00Z",
  "startedAt": "2026-07-13T00:00:01Z",
  "finishedAt": "2026-07-13T00:08:00Z",
  "subjectRef": {
    "store": "dashboard-session-corpus",
    "id": "task-123",
    "contentDigest": "sha256:..."
  },
  "assignment": {
    "kind": "paired"
  },
  "selectedHarness": "codex",
  "harnessProvenance": {
    "origin": "claude-code",
    "driver": "codex",
    "worker": "codex",
    "judge": "codex"
  },
  "capabilitySnapshot": [
    {
      "id": "measurement.turn-wall-time",
      "semanticsVersion": 1,
      "state": "available",
      "observedAt": "2026-07-13T00:00:00Z"
    }
  ],
  "effectiveLimits": {
    "wallTimeMs": 1800000,
    "totalTokens": 160000,
    "turns": 40,
    "toolCalls": 80
  },
  "safeguardAuthorizations": [],
  "sessionRef": {
    "harness": "codex",
    "sourceId": "local",
    "sessionId": "019f..."
  },
  "observations": [
    {
      "metricId": "turn.wall-time",
      "value": 479000,
      "unit": "ms",
      "scope": "run",
      "basis": "native-turn-duration",
      "semanticsVersion": 1,
      "confidence": "high",
      "observedAt": "2026-07-13T00:08:00Z"
    }
  ],
  "checkResults": [
    {
      "checkId": "project.validate",
      "outcome": "passed",
      "startedAt": "2026-07-13T00:06:00Z",
      "finishedAt": "2026-07-13T00:08:00Z"
    }
  ],
  "usage": {
    "wallTimeMs": 479000,
    "totalTokens": 72000,
    "turns": 17,
    "toolCalls": 35
  },
  "error": null,
  "extensions": {}
}
```

### Lifecycle

A Run is created immediately before dispatch, after selection and capability
validation succeed:

```text
pending -> running -> succeeded | failed | cancelled
```

Selection refusal returns a structured eligibility error and creates no Run. A
terminal Run is immutable. Retrying creates a new Run ID with `retryOf` pointing
to the terminal attempt.

For a randomized cohort Run, `assignment` is:

```json
{
  "kind": "randomized",
  "seed": "base64url-or-hex-seed"
}
```

An explicit cohort Run records `{ "kind": "explicit" }`. Paired Runs record
`{ "kind": "paired" }`.

### Provenance and strict independence

`harnessProvenance` records origin, driver, worker, and intended judge harness
separately. Origin may differ after a handoff. Driver, worker, and judge must all
equal `selectedHarness`. A harness-as-treatment experiment varies
`selectedHarness` between sibling Treatment Runs; it never mixes harnesses
inside one Run. The Verdict records the actual judge session and validates it
against this intent.

`capabilitySnapshot` captures what the selected adapter certified at dispatch.
Capability states are `available`, `unavailable`, `disabled`, `unsupported`, or
`stale`; a missing signal is never encoded as numeric zero.

### Safeguard authorization

Each effective Safeguard Relaxation is recorded on the Run:

```json
{
  "requestId": "network.github-read",
  "approvedBy": "operator-id",
  "approvedAt": "2026-07-13T00:00:00Z",
  "reason": "Read-only issue evidence is required for this Run"
}
```

The runtime verifies that the authorization exactly matches a request in the
Definition and is allowed by operator policy. Definitions never self-authorize.

### Session and evidence boundary

Each Run has exactly one primary `sessionRef` using the durable
`{harness, sourceId, sessionId}` identity. The dashboard remains authoritative
for transcript, tool output, and subagent relationships. The Run stores only
normalized observations and check outcomes; it does not duplicate session data
or maintain a second session graph.

## ExperimentVerdict

### Shape

```json
{
  "schemaVersion": 1,
  "kind": "ExperimentVerdict",
  "verdictId": "6684a729-33c0-4b11-9726-a3c95224cd6d",
  "trialId": "ac0d56d9-37cd-4d50-ab42-0ed8fefb193b",
  "definitionRef": {
    "definitionId": "shpwrck/speed.background-first",
    "definitionVersion": 1,
    "contentDigest": "sha256:..."
  },
  "policy": {
    "id": "objective-first",
    "version": 1
  },
  "evidence": {
    "includedRunIds": [
      "d28bc67f-05cb-46cc-bd50-078763293c1c",
      "58b6f848-c708-4cc8-9766-23b89d8613e2"
    ],
    "excludedRuns": [
      {
        "runId": "fc4a3b6d-4763-4f0c-84a4-85097e8e58c9",
        "reason": "retry-superseded"
      }
    ]
  },
  "outcome": {
    "kind": "winner",
    "winningTreatmentId": "background-first"
  },
  "policyResult": {
    "basis": "checks-then-wall-time",
    "parameters": {}
  },
  "applicability": {
    "harnesses": ["claude-code", "codex"],
    "capabilitySemantics": [
      {
        "id": "measurement.turn-wall-time",
        "version": 1
      }
    ],
    "reasons": [
      "Definition is portable",
      "All included Runs satisfied the required capability semantics"
    ]
  },
  "judge": {
    "harness": "codex",
    "sessionRef": {
      "harness": "codex",
      "sourceId": "local",
      "sessionId": "019f..."
    }
  },
  "createdAt": "2026-07-13T00:10:00Z",
  "updatedAt": "2026-07-13T00:10:00Z",
  "updateReason": "initial verdict",
  "extensions": {}
}
```

### Outcome

`outcome` is exactly one of:

```json
{ "kind": "winner", "winningTreatmentId": "treatment-id" }
```

```json
{ "kind": "tie" }
```

```json
{ "kind": "inconclusive", "reason": "insufficient-samples" }
```

```json
{ "kind": "invalid", "reason": "integrity-failure" }
```

A failed or cancelled Run does not force an invalid Verdict. The policy may
exclude it and return `inconclusive`; `invalid` is reserved for evidence whose
integrity or safeguard state makes comparison unusable.

### Evidence and correction

The Verdict lists every included Run ID and every excluded Run with a structured
reason. Included and excluded sets are disjoint. Included Runs must belong to the
same trial and exact Definition reference. An included Run must be terminal and
eligible under the selected Verdict Policy.

There is one current Verdict per `trialId`. It is replaceable in place rather
than append-only: `verdictId` and `createdAt` remain stable, while a correction
updates the outcome, evidence, `updatedAt`, and mandatory `updateReason`. Schema
v1 does not model Verdict history.

Evidence Applicability is derived, never supplied by the experiment author. The
Verdict stores the resulting harness set, capability semantic versions, and
human-readable reasons. The detailed confidence and cross-harness replication
algorithm is owned by the downstream portable-evidence decision; this schema
provides the facts it requires without prejudging that policy.

## Validation

Validation has four fail-closed stages.

### 1. Structural JSON Schema validation

- Require the correct `kind` and exact supported `schemaVersion`.
- Reject unknown fields in every core object.
- Enforce discriminated unions, formats, integer bounds, and required fields.
- Permit arbitrary JSON only as values of syntactically namespaced extension
  keys.

### 2. Definition semantic validation

- Recompute and match `contentDigest`.
- Require unique Treatment, metric, and check IDs.
- Require at least two Treatments and exactly one control.
- Resolve every selector, capability, intervention operation, collector, check,
  safeguard policy, and Verdict Policy by ID and version.
- Validate their parameters or values against the owning registered JSON
  Schema.
- Reject proprietary requirements in a portable Definition.
- Require token/cost enforcement capabilities when those limits are present.
- Validate cohort minimum/maximum bounds.

### 3. Run referential and lifecycle validation

- Resolve the exact immutable Definition reference.
- Require the Treatment to exist in that Definition.
- Require the subject digest and primary Session Reference.
- Require the dispatch capability snapshot to satisfy all requirements.
- Enforce allowed status transitions and terminal immutability.
- Validate retry lineage without cycles.
- Validate Treatment assignment against the Study Design.
- Require driver, worker, and judge to equal the Run's selected harness. A
  harness intervention changes the selected harness for a whole Run, not one
  role within it.
- Match Safeguard Relaxation authorizations to Definition requests and operator
  policy.
- Accept observations and check results only when declared by the Definition
  with matching semantics.

### 4. Verdict referential and policy validation

- Require one current Verdict per trial.
- Resolve the exact Definition and registered Verdict Policy.
- Require every evidence Run to belong to that trial and Definition.
- Require included and excluded evidence sets to be complete, unique, and
  disjoint.
- Validate retry selection and Study Design coverage.
- Require cohort minimums before any outcome other than `inconclusive`.
- Require `winningTreatmentId` only for `winner`, and require it to name a
  Treatment with included evidence.
- Derive Evidence Applicability from the Definition and included Run snapshots.
- Validate actual judge provenance against strict single-harness rules.

Writers never persist a record that fails any applicable stage. Readers retain
invalid or corrupt stored records in a quarantine surface with structured
validation errors, but exclude them from Verdicts, evidence, and recommendations.

## Deliberate omissions from version 1

- Kubernetes `apiVersion`, `kind`, `metadata`, `spec`, status subresources, CRDs,
  operators, or admission webhooks.
- Historical-ledger conversion or backward-compatible legacy shapes.
- A separate Trial document.
- Definition SemVer.
- Nested capability expressions.
- A mandatory central metric catalog.
- Embedded transcripts, tool outputs, repository contents, or prompts.
- Weighted, balanced, stratified, adaptive, or statistical assignment/stopping
  languages.
- Append-only Verdict history.
- Behavior-changing extensions.
- Automatic equivalence between proprietary capabilities, raw tool names,
  model tiers, token billing, or latency fields.

## Downstream contracts

- The runtime-boundary decision must make the core own these schemas and
  validation stages while adapters own capability implementations, session
  pointers, execution, measurement, and judging.
- Harness selection consumes `requiredCapabilities`, `estimatedUsage`,
  `limits`, safeguard requests, and capability freshness. It must never turn an
  estimate into a hard limit or missing support into zero.
- Portable-evidence rules consume portability, metric semantics, included Runs,
  capability snapshots, Harness Provenance, and stored applicability reasons.
- The prototype must exercise a paired portable Definition in both harnesses, a
  cohort Definition, a retry, an ineligible capability, an authorized safeguard
  relaxation, and a corrected Verdict.
- Runtime installation must keep the registry and mutable Definition/Run/Verdict
  stores configurable without changing these document shapes.
