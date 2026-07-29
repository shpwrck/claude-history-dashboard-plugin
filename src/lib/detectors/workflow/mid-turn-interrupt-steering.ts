import type { Detector, Recommendation, RecObservation } from '../types';
import type { SessionTimeline, TimelineEntry } from '../../parse-timeline';
import type { SessionTokenData, TokenEntry } from '../../../types';
import { fmtUsd } from '../shared';
import { buildWindowSumIndex, sumInWindow, type WindowSumIndex } from '../shared';
import { getModelPricing } from '../../pricing';

/**
 * `workflow.mid-turn-interrupt-steering` (#1754).
 *
 * Signature: a human cuts the assistant off MID-RESPONSE — the harness records a
 * `user`-type interrupt sentinel (`[Request interrupted by user]`) arriving while
 * the assistant was still producing the turn (between its `tool_use` and the
 * matching `tool_result`, or mid-generation). Everything the assistant emitted in
 * that now-orphaned turn was billed as output but discarded the moment the human
 * steered away — the first direct dollarization of a steering-friction signal.
 *
 * The per-entry classification lives in `parse-timeline.ts` (which alone sees the
 * user text): `entries[].interrupted` flags the literal sentinel, anchored with
 * `startsWith` so a prompt quoting the phrase — or an assistant turn discussing it
 * — is never mistaken for an interrupt. This detector walks those flags, scopes
 * each interrupt's orphaned turn back to the last real human prompt (a non-sentinel
 * `user` entry — a `tool_result` keeps the turn going and never resets it), and
 * sums the output tokens of the assistant messages billed in that window from the
 * joined `parse-sessions` token data, pricing them at each message's own model.
 *
 * HONEST FRAMING (vetting, issue #1754): interrupts are a MINORITY of turns and
 * the wasted dollars are small (cache-read tokens that dominate the bill persist
 * for the resumed turn — they are NOT wasted). This ships as a workflow/autonomy
 * DIAGNOSTIC — it leads with interrupts/session and never books a cost-census
 * reclaim claim, so it cannot inflate the headline bill. The #1266 autonomy-proxy
 * cross-validation (high interrupt rate ⇒ lower autonomy tier) is a follow-on.
 */

/** Noise floor — never fire on one or two stray interrupts. */
const MIN_INTERRUPTS = 3;
const MAX_EVIDENCE = 5;

interface Interrupt {
  sessionId: string;
  interruptTs: string;
  wastedOutputTokens: number;
  wastedUsd: number;
  snippet: string;
}

function tsMs(ts: string): number {
  return Date.parse(ts);
}

/**
 * Output tokens (and their dollar cost at each message's own model) billed by
 * assistant messages whose timestamp falls in the orphaned window
 * `(lowerMs, interruptMs]` — i.e. the in-flight work since the turn began that the
 * interrupt discarded. Joined from `parse-sessions` token entries by timestamp.
 */
function wastedInWindow(
  index: WindowSumIndex,
  lowerMs: number,
  interruptMs: number
): { tokens: number; usd: number } {
  // Lower bound EXCLUSIVE: it is the previous turn/interrupt boundary, and
  // re-counting it would double-bill in-flight work across two interrupts.
  const [tokens, usd] = sumInWindow(index, lowerMs, interruptMs, false);
  return { tokens, usd };
}

// Prefix-sum field order: [0] output tokens, [1] their dollar cost.
const WASTE_FIELDS = 2;

/**
 * Index a session's token entries once so each interrupt's window is a
 * binary-search lookup instead of a full rescan (#3238).
 *
 * `wastedInWindow` used to walk EVERY token entry for EVERY qualifying
 * interrupt — O(I x T) of timestamp parsing and per-model pricing on the
 * detector hot path — to compute a partition that does not depend on which
 * interrupt is asking. Pricing is resolved once per entry here, still at that
 * entry's OWN model, so the dollar figure keeps its per-message attribution.
 */
function wasteIndexFor(tokenEntries: TokenEntry[]): WindowSumIndex {
  return buildWindowSumIndex(
    tokenEntries,
    (e) => tsMs(e.timestamp),
    (e) => {
      // Entries with no output contribute nothing, exactly as the old
      // `outputTokens <= 0` skip did. A negative value must not be summed in:
      // prefix subtraction cannot re-derive which rows were skipped.
      const out = e.outputTokens > 0 ? e.outputTokens : 0;
      return [out, (out / 1_000_000) * getModelPricing(e.model).output];
    },
    WASTE_FIELDS
  );
}

/**
 * Collect mid-turn interrupts in one session. An interrupt counts only when the
 * assistant was actively producing the turn (≥1 assistant/tool_use/thinking entry
 * since the turn began) — that is the "mid-flight" cadence gate that keeps a normal
 * user-after-`tool_result` message (which is never the sentinel anyway) out.
 */
function collectSessionInterrupts(
  tl: SessionTimeline,
  tokenEntries: TokenEntry[]
): Interrupt[] {
  // Built ONCE per session, and only if a qualifying interrupt actually asks.
  //
  // Eager construction would have relocated the cost rather than removed it:
  // interrupts are a MINORITY of turns (see the module note above) and the
  // detector walks EVERY supplied timeline, so indexing up front would add
  // O(T log T) to the common no-interrupt session, which previously touched
  // `tokenEntries` not at all. Reported by Codex review on PR #3480 — the same
  // trap as the eager index caught on PR #3467.
  let wasteIndex: WindowSumIndex | null = null;
  const wasteIndexOnce = (): WindowSumIndex =>
    (wasteIndex ??= wasteIndexFor(tokenEntries));
  const interrupts: Interrupt[] = [];
  const entries = tl.entries;
  // `turnStartMs` resets on every real human prompt; `boundaryMs` additionally
  // advances past a prior interrupt so two interrupts in one turn never
  // double-count the same in-flight tokens.
  let turnStartMs = entries.length ? tsMs(entries[0].timestamp) - 1 : 0;
  let boundaryMs = turnStartMs;
  let inFlight = false; // assistant produced output since `boundaryMs`?
  let lastAssistant: TimelineEntry | null = null;

  for (const e of entries) {
    if (e.kind === 'user' && !e.interrupted) {
      // A real human prompt opens a fresh turn.
      turnStartMs = tsMs(e.timestamp);
      boundaryMs = turnStartMs;
      inFlight = false;
      lastAssistant = null;
      continue;
    }
    if (e.kind === 'assistant' || e.kind === 'tool_use' || e.kind === 'thinking') {
      inFlight = true;
      if (e.kind === 'assistant') lastAssistant = e;
      continue;
    }
    if (e.kind === 'user' && e.interrupted) {
      const interruptMs = tsMs(e.timestamp);
      if (inFlight && Number.isFinite(interruptMs)) {
        const { tokens, usd } = wastedInWindow(wasteIndexOnce(), boundaryMs, interruptMs);
        interrupts.push({
          sessionId: tl.sessionId,
          interruptTs: e.timestamp,
          wastedOutputTokens: tokens,
          wastedUsd: usd,
          snippet: (lastAssistant?.summary ?? '').trim(),
        });
      }
      // Next interrupt in the same turn measures only NEW in-flight work.
      boundaryMs = Number.isFinite(interruptMs) ? interruptMs : boundaryMs;
      inFlight = false;
      lastAssistant = null;
    }
  }
  return interrupts;
}

export const detector: Detector = {
  id: 'workflow.mid-turn-interrupt-steering',
  category: 'workflow',
  dataDeps: ['timelines', 'tokenData'],
  rule(input): Recommendation | null {
    const timelines = input.timelines;
    if (!timelines || timelines.length === 0) return null;

    const tokenBySession = new Map<string, SessionTokenData>(
      (input.tokenData ?? []).map((d) => [d.sessionId, d])
    );

    const interrupts: Interrupt[] = [];
    for (const tl of timelines) {
      if (!tl.entries || tl.entries.length === 0) continue;
      const td = tokenBySession.get(tl.sessionId);
      interrupts.push(...collectSessionInterrupts(tl, td?.entries ?? []));
    }
    if (interrupts.length < MIN_INTERRUPTS) return null;

    const sessions = new Set(interrupts.map((i) => i.sessionId)).size;
    const totalWastedTokens = interrupts.reduce((s, i) => s + i.wastedOutputTokens, 0);
    const totalWastedUsd = interrupts.reduce((s, i) => s + i.wastedUsd, 0);
    // Fleet average across ALL sessions (not just affected ones) — the autonomy
    // signal the issue cites. Labelled "across all sessions" everywhere it surfaces
    // so it is never read as a per-affected-session rate.
    const perSession = interrupts.length / timelines.length;
    const perSessionStr = perSession.toFixed(2);

    const dollars = totalWastedUsd > 0 ? ` (~${fmtUsd(totalWastedUsd)})` : '';

    const evidence = [...interrupts]
      .sort((a, b) => b.wastedOutputTokens - a.wastedOutputTokens)
      .slice(0, MAX_EVIDENCE)
      .map((i) => {
        const id = i.sessionId.slice(0, 8);
        const snip = i.snippet ? ` "${i.snippet.slice(0, 60)}"` : '';
        return `${id}:${snip} → ~${i.wastedOutputTokens.toLocaleString()} in-flight output tokens discarded`;
      });

    const observations: RecObservation[] = [
      {
        claim: `${interrupts.length} mid-turn interrupt(s) across ${sessions} session(s) (~${perSessionStr}/session across all ${timelines.length} session(s)): a "[Request interrupted by user]" sentinel arrived while the assistant was producing the turn`,
        source: 'parse-timeline',
        field: 'entries[].interrupted',
        value: interrupts.length,
      },
      {
        claim: `~${Math.round(totalWastedTokens).toLocaleString()} output tokens were billed by the now-orphaned assistant turns and discarded${dollars}`,
        source: 'parse-sessions',
        field: 'entries[].outputTokens',
        value: Math.round(totalWastedTokens),
      },
    ];

    return {
      id: 'workflow.mid-turn-interrupt-steering',
      category: 'workflow',
      severity: 'info',
      title: 'Mid-turn interrupts discard billed in-flight work',
      detail:
        `${interrupts.length} mid-turn interrupt(s) across ${sessions} session(s) (~${perSessionStr}/session across all ${timelines.length}) cut the assistant off mid-response (literal "[Request interrupted by user]" sentinel), discarding ~${Math.round(
          totalWastedTokens
        ).toLocaleString()} already-billed in-flight output tokens${dollars}. ` +
        `This is a workflow/autonomy diagnostic, not a flagship cost lever — interrupts are a minority of turns and cached context survives the resume, so the wasted dollars are small; the value is the steering signal.`,
      action:
        'Cut mid-flight steering: scope the task up front (plan-mode-first) and tighten the prompt so the turn does not need redirecting, and let a turn finish (or checkpoint it) rather than interrupting between a tool call and its result. A high interrupt rate usually means under-scoped prompts.',
      ...(totalWastedUsd > 0 ? { estSavingsUsd: totalWastedUsd } : {}),
      affected: interrupts.length,
      view: 'timeline',
      evidence,
      provenance: {
        observations,
        inference:
          'A user interrupt arriving mid-response orphans the turn: the output tokens the assistant already emitted that turn were billed but thrown away when the human steered elsewhere. Counted only when the assistant was actively producing (cadence gate), priced at each message\'s own model, and never booked as a cost-census reclaim — the honest unit is interrupts/session, with the small discarded dollars as a secondary diagnostic.',
      },
    };
  },
};
