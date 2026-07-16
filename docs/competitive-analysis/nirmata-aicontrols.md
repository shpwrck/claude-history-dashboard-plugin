# Competitive analysis: Nirmata AIControls

## Source

- URL: https://nirmata.com/aicontrols/
- Supporting: ["The AI Governance Market Is Here. Most of the Problem Remains
  Unsolved."](https://nirmata.com/2026/05/19/the-ai-governance-market-is-here-most-of-the-problem-remains-unsolved/),
  [Nirmata Control Hub](https://nirmata.com/nirmata-control-hub/),
  [AI Platform Engineer launch (PR Newswire, Nov 2025)](https://www.prnewswire.com/news-releases/nirmata-launches-ai-platform-engineer-to-automate-cloud-native-infrastructure-governance-and-management-302606691.html)
- Date captured: 2026-06-11
- Category: **Adjacent product** — AI-agent governance / enforcement layer (not a
  direct competitor to the local analytics/coaching job)
- Related issues: #1246 (this note); rolls up under #926 (docs tracking); touches
  the team-framing question in [`../v0.4-proof-engine.md`](../v0.4-proof-engine.md)
  and the multi-seat boundary in [team-observability.md](./team-observability.md)
  / #467

## What It Is

AIControls is Nirmata's **AI governance proxy** — an inline control plane that sits
in the request path between developers/agents and LLM providers (OpenAI, Anthropic,
Gemini, anything via LiteLLM). The pitch is *enforcement before spend*, not
observability after the fact. Policies are declarative YAML stored in Git;
identity for both humans and agents comes from **Kubernetes service accounts** or
corporate SSO (OIDC, Azure AD, Okta).

Its strategic wedge is lineage: it is built on **Kyverno CEL** — the
CNCF-graduated Kubernetes policy engine (claims 3.2B+ downloads, "50% of Fortune
500"). Nirmata frames AI governance as the same policy-as-code problem they
already solve for Kubernetes infrastructure.

Three stated "enforcement planes":

- **Developer Governance** — which humans can call which models for which task.
- **Agent Governance** — what autonomous agents may do (model/tool access, per-
  identity token budgets, human approval for high-risk actions).
- **MCP Governance** — which MCP tools an agent may invoke, blocked *before*
  invocation.

Note: AIControls is distinct from Nirmata's **AI Platform Engineer** (Nov 2025),
an agent that authors/remediates Kyverno policy for infra governance. Same Kyverno
foundation, different product; not relevant to our category.

### Key facts

| Dimension | AIControls |
|---|---|
| Layer | Inline governance **proxy** (in the call path) |
| Posture | Preventive — deterministic enforce *before* tokens are spent (`<2µs` claimed overhead, zero code change) |
| Identity | K8s service accounts or corporate SSO; **agents priced/treated as identities, same as developers** |
| Policy | Kyverno CEL, declarative YAML in Git |
| Deployment | SaaS (Team), self-hosted **Kubernetes via Helm** (Enterprise default), or in-VPC |
| Audit | Immutable trail; NIST / EU AI Act reports; Git-versioned, exportable decision logs; SIEM (Enterprise) |
| Pricing | **$5/identity/mo** (Team, ≤150, 10K req/identity incl.); Enterprise custom |
| Positioning | Punches at observability/gateway tools (LiteLLM, Portkey — now Palo Alto Networks) as "shallow visibility" |

## User Job

For an enterprise platform/security team: *"Stop ungoverned AI spend and risky
agent actions at the boundary, attribute every call to an identity, and produce
audit artifacts I own."* It is a **policy/compliance** job, anchored on a request-
path chokepoint — not an "understand and improve how my agent works" job.

## What It Does Well

- **Preventive enforcement.** Blocks disallowed models/tools and caps budgets
  before tokens are spent. We are entirely retrospective; we cannot stop a call.
- **Identity-anchored attribution.** Per-developer *and* per-agent cost tied to a
  service-account / SSO identity at the chokepoint — structurally cleaner for a
  fleet than parsing local transcripts.
- **Agent + MCP governance with human-in-the-loop.** Tool-invocation enforcement
  and approval workflows for high-risk actions — a security surface we do not
  touch.
- **Owned, exportable audit.** Git-versioned policy history and decision logs
  framed as customer-owned artifacts auditors can use, not a vendor dashboard.
- **Kyverno pedigree + K8s-native deploy.** CNCF-graduated brand and a Helm
  install story that lands directly in the cluster where agents now run.

## Where Claude History Dashboard Is Stronger

- **Depth of understanding, not just allow/deny.** We read full transcripts and
  reconstruct *why* a session cost what it did (context/cache health, retries,
  tool churn, file impact, permissions). Nirmata's cost story stops at attribution
  and caps; it has no answer to *"did this spend produce value?"*
- **Prescription + proof.** The recommendation engine and the v0.4 proof-engine
  direction (shadow/replay causal experiments) tell the user *what to change* and
  *prove the change worked*. Nirmata governs; it does not coach or prove efficacy.
- **Local-first / free.** On a single machine our local-history model wins on
  depth and price (free, no proxy, no `api.anthropic.com`). Nirmata is an
  enterprise proxy with per-identity billing.
- **Claude-Code-native semantics.** We parse the real `~/.claude` artifacts
  (see [`../../REFERENCES.md`](../../REFERENCES.md)); a generic LLM proxy sees HTTP
  traffic, not Claude Code's session/subagent/recommendation structure.

## Product Implications

Why this is relevant **now**: switching to a **Kubernetes-native remote-dispatch
model** (the `add-remote` dispatcher) puts us onto Nirmata's home turf — service-
account identity, Kyverno/CEL, Helm. The relationship is **mostly complementary,
partly collision**.

- **Architectural divergence is the core insight.** Nirmata is *in-band,
  preventive, per-call* ("was this allowed?"). We are *out-of-band, retrospective,
  evidence-generating* ("was it worth it, and what should change?"). Different
  layers of the same stack, not substitutes — a user can run both.
- **The one real collision is per-identity cost attribution.** Inline at the
  boundary (theirs) vs. post-hoc from transcripts (ours). On a laptop we win; for
  *a team running dispatched agents on a cluster*, their identity-anchored
  attribution is cleaner unless we capture the same identity signal.
- **The opportunity the K8s switch unlocks.** A K8s-native dispatch means each
  remote agent can carry a **service-account identity** — the exact signal our
  local-history parser cannot synthesize alone. That enables **per-identity
  efficacy attribution across a fleet**, the bridge from "solo proof" to the
  team framing in [`../v0.4-proof-engine.md`](../v0.4-proof-engine.md). This is a
  layer *above* enforcement that Nirmata does not occupy: they prove governance;
  we would prove ROI.
- **The threat.** Nirmata (plus Portkey-now-PANW) owns the inline
  enforcement + audit + compliance narrative, with a CNCF-graduated brand as moat.
  If our roadmap drifts toward *enforcement* (gating/blocking spend), we enter
  their wedge late and without the Kyverno pedigree. Their identity-based pricing
  also quietly reframes agents as billable governed entities.

### Recommended stance

1. **Do not compete on enforcement.** Stay the measurement/prescription/proof
   layer — "gateways enforce policy; we prove the spend earned its keep."
2. **Exploit the K8s identity signal.** Use service-account-per-dispatch for
   per-identity efficacy attribution across a fleet — the highest-value payoff of
   the dispatch switch.
3. **Interop over rivalry.** Consider ingesting Git-versioned decision logs or
   sitting downstream of a proxy boundary for per-identity ground truth, rather
   than building our own proxy.
4. **Watch for bundling.** If Nirmata or Portkey/PANW add an "ROI/efficacy" view,
   that is the feature that would commoditize our core. Today their cost story
   explicitly stops at attribution + caps — that is our white space.

## Existing Coverage

| Observation | Status | Evidence / issue |
|---|---|---|
| Per-identity / per-agent cost attribution for a fleet | Gap | Local model is single-user; K8s dispatch identity signal not yet consumed for attribution. Relates to #467, [`../v0.4-proof-engine.md`](../v0.4-proof-engine.md) |
| Preventive enforcement (gate/block before spend) | No action | Out of category; we are retrospective by design. ADR 0008 governs server LLM use; we do not proxy provider traffic |
| Efficacy/ROI proof per agent identity (team framing) | Deferred | v0.4 proof-engine direction; team framing parked behind #467 |
| Audit-artifact ingestion / proxy-boundary interop | Gap | Not captured as an issue; only worth filing if a team buyer materializes |
| Multi-seat / team observability boundary | Backlog | #467 (public multi-tenant Coach) |

## Follow-up

- Backlog issue: #1246 (this note). No new implementation issue filed — the
  actionable scope (per-identity efficacy attribution, proxy-boundary interop) is
  **deferred** behind the v0.4 proof-engine and the #467 team boundary, and should
  not be re-filed as standalone work until a team/enterprise buyer is real.
- Documentation issue: rolls up under #926.
- Explicit non-goals: building an inline enforcement proxy; gating/blocking
  provider traffic; competing on policy-as-code or compliance reporting. These are
  Nirmata's category, not ours.
