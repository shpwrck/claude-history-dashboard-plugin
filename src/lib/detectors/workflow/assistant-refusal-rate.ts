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
    };
  },
};
