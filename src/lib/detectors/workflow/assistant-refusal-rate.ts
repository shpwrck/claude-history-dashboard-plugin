import type { Detector } from '../types';
import { MIN_ASSISTANT_TURNS, HIGH_REFUSAL_RATE } from '../shared';

// #206: when the assistant concedes/refuses on a large share of turns, the
// recurring context (CLAUDE.md, project conventions) is probably underspecified
// — the user keeps correcting it. Reads only the numeric per-session features
// derived at ingest; no transcript text is consulted here.
export const detector: Detector = {
  id: 'workflow.assistant-refusal-rate',
  category: 'workflow',
  dataDeps: ['assistantFeatures'],
  rule(input) {
    const feats = input.assistantFeatures ?? [];
    if (feats.length === 0) return null;
    let turns = 0;
    let refusals = 0;
    for (const f of feats) {
      turns += f.assistantTurnCount;
      refusals += f.refusalCount;
    }
    if (turns < MIN_ASSISTANT_TURNS) return null;
    const rate = refusals / turns;
    if (rate < HIGH_REFUSAL_RATE) return null;
    const pct = Math.round(rate * 100);
    return {
      id: 'workflow.assistant-refusal-rate',
      category: 'workflow',
      severity: 'info',
      title: 'Assistant frequently course-corrects',
      detail: `${pct}% of assistant turns (${refusals} of ${turns}) contain a refusal or concession ("I cannot", "I apologize", "you're right") — often a sign the prompt or project context left it guessing.`,
      action:
        'Tighten recurring instructions in CLAUDE.md (constraints, file locations, conventions) so the assistant needs fewer corrections.',
      affected: refusals,
      provenance: {
        observations: [
          {
            claim: `${refusals} assistant turn(s) matched a refusal/concession marker`,
            source: 'parse-assistant-features (assistantFeatures[], summed across sessions)',
            field: 'refusalCount',
            value: refusals,
          },
          {
            claim: `${turns} assistant turn(s) were examined across ${feats.length} session(s)`,
            source: 'parse-assistant-features (assistantFeatures[], summed across sessions)',
            field: 'assistantTurnCount',
            value: turns,
          },
          {
            // "=" would be a false equality whenever the rate is not a whole
            // percent: 10/51 is 19.6%, displayed as 20%. The claim has to say
            // it ROUNDS, or a reader reproducing the division gets a different
            // number from the one on the card.
            claim: `${refusals} / ${turns} of assistant turns, which rounds to ${pct}%`,
            source: 'detectors/workflow/assistant-refusal-rate',
            field: 'refusalCount / assistantTurnCount',
            value: pct,
          },
          {
            claim:
              `withheld below MIN_ASSISTANT_TURNS = ${MIN_ASSISTANT_TURNS} examined turns, ` +
              `and below a rate of HIGH_REFUSAL_RATE = ${HIGH_REFUSAL_RATE}`,
            source: 'detectors/shared',
            field: 'MIN_ASSISTANT_TURNS / HIGH_REFUSAL_RATE',
            value: MIN_ASSISTANT_TURNS,
          },
        ],
        // `refusalCount` counts TURNS containing a marker phrase — not phrases,
        // and not a judgement that the assistant was wrong. The "left it
        // guessing" reading in `detail` is the inference, not the measurement.
        //
        // No `asOf`: `AssistantFeatures` carries `sessionId` plus numeric counts
        // ONLY — it has no timestamp — so this rate cannot honestly be dated
        // from its own source. Borrowing a date off another artifact would
        // assert a freshness this evidence does not have, so the field is
        // omitted rather than fabricated.
        inference:
          'Turns matching a refusal/concession phrase are counted; whether the ' +
          'assistant was actually wrong, and whether project context caused it, are ' +
          'not measured. A sustained rate is read as underspecified recurring ' +
          'instructions — an interpretation of the count, not the count itself.',
      },
    };
  },
};
