# vs. — how Probaitio differs

The field around Probaitio is not one market but several tiers at very different
crowding levels. Probaitio deliberately anchors in the empty tier and treats the
crowded tier's output as input.

## The one-row difference

Everyone in the neighborhood **measures**. Probaitio **proves**.

| | What they do | What Probaitio adds |
|---|---|---|
| **Cost trackers** (ccusage, tokview, headroom) | Count tokens and spend; assert what to fix | Causal verdict on whether the fix actually helped |
| **LLM observability** (Helicone, Langfuse, LangSmith) | Trace, log, and score model calls | Controlled experiments on *how you work with the agent*, not just what the model returned |
| **Org analytics** (first-party cost APIs, Faros "Experiments") | Aggregate, post-hoc, leadership-facing | Session-level forensics on your own local history; solo proof, team framing |
| **Hidden routers** (Sakana Fugu) | Route to the cheapest model and hide the decision | The auditable receipt for *why* a route is safe — you set the policy |

The differentiator is the same in every row: **causal proof on your own real
history, vendor-neutral, local.** Measurement is table stakes; proof is the
product.

## Why it is defensible

Three properties stack into a moat:

1. **Causal, not correlational.** Everyone measures; Probaitio runs controlled
   trials and produces *evidence* that a change caused the improvement.
2. **Real history, not benchmarks.** A no-ground-truth per-task success proxy
   lets proof run on your actual sessions instead of a synthetic suite. A
   benchmark-fitness competitor needs a ground-truth signal Probaitio
   deliberately does not require — the apparent weakness is the moat.
3. **Vendor- / harness-neutral.** Model vendors are structurally conflicted out
   of prescribing "spend less / finish faster" — it is their revenue. An
   independent layer above any single harness is not.

## The first-party recommender: funnel, not fight

Anthropic ships a first-party setup plugin that **statically scans a codebase**
(deps, file tree, existing `.claude/`) and maps those to template suggestions. It
is one-shot, stateless, and **never reads `~/.claude` history**.

It owns the cold-start moment and Probaitio will not out-distribute it. But it
collides with vocabulary ("recommendations for your setup"), not with the moat:
its claims are generic static templates; Probaitio's are auditable claims from
your real history with cited provenance, declared fix validity, and stale
demotion. The relationship is a hand-off — *static setup tells you what to
install; Probaitio tells you, from your own week of sessions, what is actually
costing you and whether the change worked* — so lean on **"from your real
history"** and **"proven"** wherever "recommendation" appears.

## When this helps — and when it does not

Borrowing the honest-anti-use-case pattern:

**Probaitio earns its keep when**

- your spend is automation-heavy and a routing or workflow change could move it;
- you have enough session history for a trial to reach its confidence threshold;
- you are willing to believe a receipt more than a model-written summary, and you
  can change team instructions, skills, hooks, or workflow norms.

**Probaitio is the wrong tool when**

- you only want a live spend meter — a cost tracker is lighter;
- a change cannot be randomized or replayed (no controllable treatment, no
  causal claim is possible);
- you want a per-run guarantee — proof is distributional, never per-session
  (see [Reading a proof receipt](./reading-a-proof-receipt.md)).
