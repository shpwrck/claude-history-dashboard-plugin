# Product naming brainstorm

What we are naming: the product currently called "Claude History Dashboard" / "Claude
Coach" (repo `claude-history-dashboard`). Issue #845's working name
`coding-agent-dashboard` is an accurate placeholder, not a brand. This picks the real name.

## What the name must serve

A vendor-neutral, multi-harness coding-agent **operations + intelligence + proof**
substrate that (1) aggregates session history across harnesses behind an artifact-source
interface, (2) analyzes it into prescriptive recs + a scorecard, (3) runs controlled
cross-vendor experiments to **prove** which changes help (the v0.4 north star, #995), and
(4) dispatches remote agent sessions as Kubernetes pods via an operator reconciling a CRD
(#1249). The name pins, at once: brand + tagline, the **k8s API group** shared by
`RemoteSession` and a dashboard-instance kind, the operator name, the image namespace, the
CLI binary, and the npm/package identity. It coexists with the chosen env var
`CODING_AGENT_SOURCES` and the kind `RemoteSession`.

Strategic heart: **multi-LLM + multi-harness neutrality** — the layer ABOVE all coding
agents and all models, the one stance a model vendor can never credibly take. Audience now
includes enterprise (OpenShift Operator + OLM). So the name must read as credible
infrastructure, not a consumer coach or a mascot.

## Hard constraints applied as a screen

- Vendor-neutral: no "Claude", "Anthropic", "Codex", "GPT", "Coach".
- Enterprise-credible, pronounceable, works as a CLI binary and a domain.
- No AI-naming slop (-ify/-ly/-AI, Nexus/Forge/Pulse/Flow/Sense/Mind/Brain/Sphere/Hub/
  Loop/Synth/Cortex) unless earned with a specific operational meaning.

---

## 1. Screening — what gets cut and why

The four namers between them proposed 16 candidates. Screening kills the following before
scoring:

| Candidate | Verdict | Reason |
| --- | --- | --- |
| **AgentOps** | CUT | Direct product collision — AgentOps (agentops.ai) is an established LLM-agent observability SaaS, and "AgentOps" is a near-generic category term. Unprotectable, domain/npm taken. The namer flagged it as the benchmark, not a real pick. Also the same "category-slug" placeholder failure as `coding-agent-dashboard`. |
| **Steward** | CUT | Extremely common English word and software name (Steward Health, countless internal tools); `steward.io`/`.com` long gone, weak mark, noisy SEO. Forgettable platform-team default; under-sells the proof moat. |
| **Crucible** | CUT | Hard head-on collision: Atlassian shipped a developer code-review product literally named **Crucible** (FishEye/Crucible) — same buyer, adjacent category. Also a Destiny game mode and an Oxide storage project. Great metaphor, fatal availability. |
| **Bellwether** | CUT | The namer's own last-ranked pick. Heavy business-jargon ("pitch-deck vocabulary"), crowded across finance/biotech/analytics, premium domains gone. "Leading indicator" skews predictive/oracle — oversells what is a deterministic proof of what *helped*. |
| **Touchstone** | CUT | Meaning is perfect, availability is the problem: Touchstone Pictures/Disney, Touchstone Energy, multiple fintech/testing brands; npm and good `.com`s taken; weak exclusive mark on a common noun. |
| **Hallmark** | CUT | Globally famous greeting-card trademark (Hallmark Cards). Different Nice class, but consumer-brand recognition guarantees search dilution and "like the cards?" confusion. Too established a word to own as devtools infra. |
| **Specula** | CUT | Unforced phonetic liability: "specula" is the Latin plural of *speculum* and reads/echoes as the medical instrument. A namer should not ship an avoidable "speculum" snicker into RBAC YAML. Also leans on observe/watch, under-serving the proof north star. |
| **Adjunct** | CUT (borderline) | Precise meaning ("attached alongside, augments the principal"), but reads too quiet/academic, carries an "adjunct professor" off-register connotation, and under-plays the proof-engine ambition — it needs the tagline to carry the whole product. Survivable but dominated by stronger neutral-authority names. |
| **Mensura** | CUT (borderline) | Clean Latin "measurement" root, good namespace, but "measure" is a softer claim than "prove/judge" — a measurer is less obviously vendor-can't-copy than an arbiter. Strategically a notch blunt; dominated by Probata/Arbiter for the proof thesis. |

That leaves **7 survivors** to score: Quorum, Provenant, Tribunal, Arbiter, Probata,
Mensura-adjacent is cut above, Plumbline. (Provenant was proposed twice — functional and
pragmatic — converging independently, which is itself signal.)

Survivors scored: **Quorum, Provenant, Tribunal, Arbiter, Probata, Plumbline**, plus
**Adjunct** carried as a low-risk dark horse for the score table.

---

## 2. Scoring (1–5, higher is better)

Axes: **VN** vendor-neutral · **EC** enterprise-credible · **ML** meaningful for an
ops/proof layer · **OW** ownable (domain/CLI/trademark headroom) · **K8s** clean as a k8s
API group.

| Candidate | VN | EC | ML | OW | K8s | Total |
| --- | --: | --: | --: | --: | --: | --: |
| **Provenant** | 5 | 5 | 5 | 4 | 5 | **24** |
| **Probata** | 5 | 4 | 5 | 5 | 5 | **24** |
| **Tribunal** | 5 | 4 | 5 | 3 | 4 | **21** |
| **Arbiter** | 5 | 5 | 5 | 2 | 4 | **21** |
| **Quorum** | 5 | 4 | 4 | 2 | 4 | **19** |
| **Plumbline** | 5 | 3 | 4 | 4 | 4 | **20** |
| **Adjunct** | 5 | 3 | 3 | 4 | 4 | **19** |

Notes on the scoring:

- **Provenant** and **Probata** tie at the top by two different routes: Provenant maxes
  meaning/credibility (provenance + proof = the receipt moat) and reads instantly as
  supply-chain/lineage infra (in-toto/SLSA register); Probata maxes ownability (a near-pure
  coinage, exact-match domains plausible) at a slight credibility cost (less instantly
  parseable).
- **Arbiter** scores the meaning/neutrality thesis perfectly (a binding, impartial judge —
  exactly the cross-vendor proof verdict) but is gutted on ownability: it is a common word
  with existing devtool/build-dependency and security-product uses; the bare CLI binary and
  exact domains are likely contested.
- **Tribunal** carries neutrality in the word and motivates a beautiful CRD family
  (`Verdict`, `Evidence`), but the judicial frame risks an adversarial/punitive tone for a
  tool meant to *help* engineers, and it is a crowded generic word (legal + gaming).
- **Quorum** is semantically strong (a quorum renders a binding collective verdict =
  cross-model adjudication) but heavily pre-owned (Quorum public-affairs SaaS, ConsenSys
  GoQuorum); exact domains gone, hard mark.
- **Plumbline** is the freshest metaphor and quite ownable on `.dev`, but the
  surveying/builder register skews artisanal/quality-tool rather than control-plane —
  weaker enterprise-infra read.

---

## 3. Shortlist (top 5)

### 1. Provenant — `provenant.io/v1alpha1`

> Provenant — the vendor-neutral provenance and proof plane for coding agents: aggregate
> every session, prescribe what to change, prove it works.

- **API group:** `provenant.io/v1alpha1` → `kind: RemoteSession`, `kind: DashboardInstance`.
  Group is a noun, kinds stay distinct, no stutter.
- **Reads as:** product **Provenant** · CLI `provenant` (alias `prov`: `prov run`,
  `prov prove`, `prov receipts`) · operator `provenant-operator` ·
  image `ghcr.io/provenant/*` · npm `@provenant/cli`.
- **Main risk:** slightly abstract/Latinate — a platform team may not parse the whole
  product from the name alone; phonetic proximity to provenance-themed lineage tools and to
  *Provenir* (fintech) warrants a knockout trademark search. `-ant` coinage is the one slop
  tell, but it's earned (prove + provenance + agent-that-does-it).
- **Scores:** VN 5 · EC 5 · ML 5 · OW 4 · K8s 5 — **24**.

### 2. Probata — `probata.io/v1alpha1`

> Probata — proven, not promised: the cross-vendor proof engine for coding agents.

- **API group:** `probata.io/v1alpha1` → `kind: RemoteSession`, `kind: DashboardInstance`.
- **Reads as:** product **Probata** · CLI `probata` (alias `prv`) · operator
  `probata-operator` · image `ghcr.io/probata/*` · npm `@probata/cli`.
- **Main risk:** mild confusion with *probate* (estate law) and *Provata*/*Provenir*; `-a`
  ending is fashionable in startup naming so a skeptic may first-glance it as vowel-soup —
  but the Latin neuter-plural etymology ("the things that have been proven") defends it and
  maps one-to-one to the deliverable (the proof receipt).
- **Scores:** VN 5 · EC 4 · ML 5 · OW 5 · K8s 5 — **24**. Best ownability of the field.

### 3. Tribunal — `tribunal.dev/v1alpha1`

> Tribunal — the impartial court for coding-agent work: it hears every session, weighs
> controlled experiments, and issues a verdict on what to ship.

- **API group:** `tribunal.dev/v1alpha1` → `kind: RemoteSession` (a session brought before
  the tribunal), `kind: DashboardInstance`; motivates future `kind: Verdict` / `kind: Evidence`.
- **Reads as:** product **Tribunal** · CLI `tribunal` (alias `trib`) · operator
  `tribunal-operator` · image `ghcr.io/tribunal/*` · npm `@tribunal/cli`.
- **Main risk:** common dictionary word with heavy legal + pop-culture (Elder Scrolls,
  League of Legends "Tribunal") associations; weaker exclusive mark, crowded SEO, and a
  faintly punitive/adversarial tone for a help-the-engineer tool.
- **Scores:** VN 5 · EC 4 · ML 5 · OW 3 · K8s 4 — **21**.

### 4. Arbiter — `arbiter.dev/v1alpha1`

> Arbiter — the impartial operations and proof layer above every coding agent and model.

- **API group:** `arbiter.dev/v1alpha1` → `kind: RemoteSession`, `kind: DashboardInstance`.
- **Reads as:** product **Arbiter** · CLI `arbiter` (`arbiter run`, `arbiter sessions`) ·
  operator `arbiter-operator` · image `ghcr.io/arbiter/*` · npm `@arbiter/cli`.
- **Main risk:** the meaning is *perfect* but the word is *obvious* — a common noun with
  existing build-dependency/monorepo tools, security products, and gaming uses; bare CLI
  binary and exact `.dev`/`.io` likely contested. Most apt, least ownable.
- **Scores:** VN 5 · EC 5 · ML 5 · OW 2 · K8s 4 — **21**.

### 5. Plumbline — `plumbline.dev/v1alpha1`

> Plumbline — the impartial reference that tells your agents what's true and what to fix.

- **API group:** `plumbline.dev/v1alpha1` → `kind: RemoteSession`, `kind: DashboardInstance`.
- **Reads as:** product **Plumbline** · CLI `plumbline` (alias `plumb`: `plumb prove`) ·
  operator `plumbline-operator` · image `ghcr.io/plumbline/*` · npm `@plumbline/cli`.
- **Main risk:** surveying/builder register skews artisanal — could read as a linting/quality
  tool, not an operator-backed control plane, unless positioning copy carries the
  dispatch/proof story; bare `plumb` collides with plumbing/devops and the `plumbum` Python lib.
- **Scores:** VN 5 · EC 3 · ML 4 · OW 4 · K8s 4 — **20**.

---

## 4. Top recommendation and runner-up

### TOP: **Provenant** — `provenant.io/v1alpha1`

Provenant wins because it is the only survivor that scores at or near the top on **every**
axis at once — it is the rare name that is simultaneously meaningful, enterprise-credible,
ownable, and clean as an API group — and because it names the *defensible* part of the
product directly. The moat is the proof receipt: an impartial, after-the-fact
**provenance** record proving "this change was cheapest-that-passes, here is the evidence
chain." That is semantically a layer ABOVE the agents — exactly the vendor-neutral stance a
model vendor is token-revenue-conflicted out of building. It reads in the supply-chain /
data-lineage register (in-toto, SLSA provenance) that enterprise platform teams already
trust, never as a consumer coach, and `provenant.io/v1alpha1` types cleanly in RBAC next to
`kind: RemoteSession` with no stutter. Two independent namers (functional and pragmatic)
landed on it from different starting philosophies — convergence is corroborating signal, not
coincidence. Its one real weakness (mild abstractness) is precisely what the tagline is for.

### RUNNER-UP: **Probata** — `probata.io/v1alpha1`

Tied on raw score, Probata is the runner-up rather than the pick because its edge is
ownability (a cleaner coinage with more plausible exact-match domains) while its cost is
immediate legibility — it's a beat slower to parse than Provenant and one trademark-knockout
search could flip the ranking. It is the right choice if a clearance pass shows `provenant.io`
or the Provenir/provenance neighborhood is too contested: Probata gives the same
"proven, not promised" thesis with the strongest available namespace headroom in the field.

---

## 5. Domains to acquire

Pick the name **and** lock its domain in the same motion — for an enterprise/OLM-credible
operator the API group must be a project-owned product domain, not a personal one.

- **Provenant (pick):** acquire **`provenant.io`** (the API group root) — and defensively
  grab `provenant.dev`. Run a trademark knockout vs *Provenir* (fintech) and provenance-named
  lineage/blockchain projects before committing.
- **Probata (runner-up):** acquire **`probata.io`** (+ `probata.dev`). The coinage makes
  exact-match availability the most likely of the whole field; clear vs *Provata* / *probate*.
- If a clearance pass kills both `.io`s, the next-cleanest API-group domains are
  `plumbline.dev` (good `.dev` headroom) and `tribunal.dev`; **Arbiter** and **Quorum**
  should only be adopted with a qualified domain (`getarbiter.*`/compound) given their
  contested bare names.

---

## 6. DECISION (2026-06-11)

**Pinned name: `Probaitio` — API group `probaitio.com/v1alpha1`.**

Path to the decision: the maintainer gravitated to **Probata** (the runner-up) for its sound
and "proven, not promised" thesis, but **Probata** is taken (existing products/companies) and a
proposed **Probatai** (Probata + "ai") was rejected — the `-ai` suffix is the AI-naming-slop tell
we screened against, it pulls the brand *into* the AI-tool category the product is meant to sit
*above*, and the `tai` cluster is ambiguous to pronounce. A targeted availability pass over the
`probāre`/`probātus` ("to prove / proven") root found:

- **Probatum** — taken (Probatum Technologies, corrections case-management; `probatum.com`); also
  a "probaition/corrections" association we don't want. Rejected.
- **Probaitio** — clear in software/AI (nearest neighbors Probo, Provarity AI are unrelated);
  `probaitio.com` open. **Chosen.**
- **Probandum** — clear in tech (only an obscure mining co.) but forward-looking ("that which is
  *to be* proved") rather than the proven receipt, and longer. Runner-up.

**Why Probaitio:** Latin *probātiō* = "the proving / a proof / a trial" (the evidentiary stage of a
Roman trial) — it literally names *the act of producing proof*, which is what the engine does. It
keeps the Probata sound the maintainer liked, reads as credible enterprise infrastructure (not a
consumer coach, not an AI-hype name), is vendor-neutral, and types cleanly as a k8s API group.

**What this pins (supersedes the `coding-agent-dashboard` working name from #844/#845 as the
BRAND; the generic vocabulary — coding agent, coding harness, agent session — stays):**

- **Product / brand:** Probaitio. Repo/package/image identity migrates to `probaitio`.
- **k8s API group:** `probaitio.com/v1alpha1`, shared by `kind: RemoteSession` (#1249 dispatch) and
  `kind: DashboardInstance` (the #467 hosted-deployment kind — replaces the `ClaudeCoach` CRD
  sketched in `00-refined-plan.md` §C1, which is now obsolete).
- **Operator:** `probaitio-operator` · **CLI:** `probaitio` · **images:** `ghcr.io/probaitio/*` (mirror
  to Quay for OpenShift) · **npm:** `@probaitio/cli`.
- **Domains to acquire:** `probaitio.com` (API-group root) + defensively `probaitio.dev`. Run a
  trademark knockout before announcing.

**Downstream doc edits owed:** `00-refined-plan.md` §C1 (resolve the CR group to
`probaitio.com/v1alpha1`, kind `DashboardInstance`, not `coach.skrzypek.dev`/`ClaudeCoach`),
`20-go-reconciler.md` and `30-olm-bootstrap.md` (every `coach.skrzypek.dev` / `claudecoaches` /
`ClaudeCoach` reference → `probaitio.com` / `dashboardinstances` / `DashboardInstance`), and the
reconciliation of this operator with the #1247/#1249 agent-ops operator (one operator, one API
group, two kinds).
