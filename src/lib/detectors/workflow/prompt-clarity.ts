import type { Detector, PromptAnalysis } from '../types';
import type { SessionTimeline } from '../../parse-timeline';
import type { ApiErrorEvent } from '../../parse-errors';
import { newestIsoDate, short, STALE_WEEKS } from '../shared';
import { isAsOfStale } from '../provenance';

const MIN_SESSIONS = 6;
const MIN_BUCKET_SESSIONS = 2;
const MIN_CORRELATION = 0.45;
const MIN_FOLLOW_UP_GAP = 1;
const LOW_SPECIFICITY_RATE = 0.5;

interface Sample {
  sessionId: string;
  promptTurns: number;
  lowSpecificityTurns: number;
  isLowSpecificity: boolean;
  followUpTurns: number;
  apiErrorCount: number;
  proxyScore: number;
}

function followUpTurns(timeline: SessionTimeline | undefined): number | null {
  if (!timeline) return null;
  const userTurns = timeline.entries.filter((entry) => entry.kind === 'user').length;
  return Math.max(0, userTurns - 1);
}

function apiErrorsBySession(events: ApiErrorEvent[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const event of events) {
    out.set(event.sessionId, (out.get(event.sessionId) ?? 0) + 1);
  }
  return out;
}

function mean(values: number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function pearson(xs: number[], ys: number[]): number {
  if (xs.length !== ys.length || xs.length < 2) return 0;
  const xMean = mean(xs);
  const yMean = mean(ys);
  let numerator = 0;
  let xSquares = 0;
  let ySquares = 0;
  for (let i = 0; i < xs.length; i++) {
    const dx = xs[i] - xMean;
    const dy = ys[i] - yMean;
    numerator += dx * dy;
    xSquares += dx * dx;
    ySquares += dy * dy;
  }
  const denominator = Math.sqrt(xSquares * ySquares);
  return denominator === 0 ? 0 : numerator / denominator;
}

function toSample(
  analysis: PromptAnalysis,
  timeline: SessionTimeline | undefined,
  apiErrorCount: number
): Sample | null {
  if (!analysis.sessionId || analysis.promptTurnCount <= 0) return null;
  const followUps = followUpTurns(timeline);
  if (followUps === null) return null;

  const lowRate = analysis.lowSpecificityTurnCount / analysis.promptTurnCount;
  const isLowSpecificity = lowRate >= LOW_SPECIFICITY_RATE;

  return {
    sessionId: analysis.sessionId,
    promptTurns: analysis.promptTurnCount,
    lowSpecificityTurns: analysis.lowSpecificityTurnCount,
    isLowSpecificity,
    followUpTurns: followUps,
    apiErrorCount,
    proxyScore: followUps + apiErrorCount,
  };
}

const fmt = (value: number) => value.toFixed(1);

export const detector: Detector = {
  id: 'workflow.prompt-clarity',
  category: 'workflow',
  dataDeps: ['promptAnalysis', 'timelines', 'apiErrors'],
  rule(input, now) {
    const promptAnalysis = input.promptAnalysis ?? [];
    if (promptAnalysis.length === 0) return null;

    const timelinesBySession = new Map(
      (input.timelines ?? []).map((timeline) => [timeline.sessionId, timeline])
    );
    const errorCounts = apiErrorsBySession(input.apiErrors);
    const samples = promptAnalysis
      .map((analysis) =>
        toSample(
          analysis,
          timelinesBySession.get(analysis.sessionId),
          errorCounts.get(analysis.sessionId) ?? 0
        )
      )
      .filter((sample): sample is Sample => sample !== null);

    if (samples.length < MIN_SESSIONS) return null;

    const low = samples.filter((sample) => sample.isLowSpecificity);
    const comparison = samples.filter((sample) => !sample.isLowSpecificity);
    if (
      low.length < MIN_BUCKET_SESSIONS ||
      comparison.length < MIN_BUCKET_SESSIONS
    ) {
      return null;
    }

    const lowFollowUps = mean(low.map((sample) => sample.followUpTurns));
    const comparisonFollowUps = mean(
      comparison.map((sample) => sample.followUpTurns)
    );
    const followUpGap = lowFollowUps - comparisonFollowUps;
    const correlation = pearson(
      samples.map((sample) => (sample.isLowSpecificity ? 1 : 0)),
      samples.map((sample) => sample.proxyScore)
    );

    if (followUpGap < MIN_FOLLOW_UP_GAP || correlation < MIN_CORRELATION) {
      return null;
    }

    const examples = low
      .slice()
      .sort((a, b) => b.followUpTurns - a.followUpTurns)
      .slice(0, 3)
      .map(
        (sample) =>
          `${short(sample.sessionId)}: ${sample.followUpTurns} follow-up turns, ` +
          `${sample.lowSpecificityTurns}/${sample.promptTurns} low-specificity prompts`
      );
    const sampleIds = new Set(samples.map((sample) => sample.sessionId));
    const contributingSessionIds = [...sampleIds].sort();
    const promptRows = samples.map((sample) => ({
      sessionId: sample.sessionId,
      lowSpecificityTurnCount: sample.lowSpecificityTurns,
      promptTurnCount: sample.promptTurns,
    }));
    const timelineRows = samples.map((sample) => {
      const timeline = timelinesBySession.get(sample.sessionId);
      return {
        sessionId: sample.sessionId,
        userTurns:
          timeline?.entries.filter((entry) => entry.kind === 'user').length ?? 0,
        followUpTurns: sample.followUpTurns,
      };
    });
    const apiErrorRows = samples.map((sample) => ({
      sessionId: sample.sessionId,
      apiErrorCount: sample.apiErrorCount,
    }));
    // Date only the timestamped fields that feed the sample rows. A newer
    // assistant/tool entry in the same timeline is unrelated to the user-turn
    // count and must not make this historical relationship look fresh.
    const asOf = newestIsoDate([
      ...(input.timelines ?? []).flatMap((timeline) =>
        sampleIds.has(timeline.sessionId)
          ? timeline.entries
              .filter((entry) => entry.kind === 'user')
              .map((entry) => entry.timestamp)
          : []
      ),
      ...input.apiErrors
        .filter((event) => sampleIds.has(event.sessionId))
        .map((event) => event.timestamp),
    ]);
    const stale = isAsOfStale(asOf, now, STALE_WEEKS * 7);
    const historyLead = stale ? `As of ${asOf}, across` : 'Across';
    const aggregateValue =
      `${low.length}/${comparison.length}/` +
      `${fmt(lowFollowUps)}/${fmt(comparisonFollowUps)}/` +
      `${correlation.toFixed(2)}`;

    return {
      id: 'workflow.prompt-clarity',
      category: 'workflow',
      severity: 'info',
      title: 'Prompt specificity tracks with follow-up loops',
      detail:
        `${historyLead} ${samples.length} sessions, low-specificity prompts traveled with ` +
        `${fmt(lowFollowUps)} follow-up turns/session vs ${fmt(
          comparisonFollowUps
        )} for more specific prompts (r=${correlation.toFixed(2)}). ` +
        'This is correlation, not causation; treat it as one of the patterns worth noticing, not a rule about what caused the extra turns.',
      action:
        'Use this as a review cue, not a rule: compare future sessions where the prompt names files, constraints, or acceptance checks against this baseline.',
      affected: low.length,
      view: 'patterns',
      evidence: [
        `${low.length} low-specificity sessions averaged ${fmt(lowFollowUps)} follow-up turns`,
        `${comparison.length} comparison sessions averaged ${fmt(
          comparisonFollowUps
        )} follow-up turns`,
        ...examples,
      ],
      provenance: {
        observations: [
          {
            claim: `${samples.length} contributing session(s) were joined by session id`,
            source:
              'parse-prompt-analysis + parse-timeline + parse-errors',
            field: 'promptAnalysis[].sessionId',
            value: contributingSessionIds.join(','),
          },
          {
            claim:
              'each contributing prompt row records its low-specificity and total prompt counts',
            source: 'parse-prompt-analysis',
            field:
              'promptAnalysis[].{sessionId,lowSpecificityTurnCount,promptTurnCount}',
            value: JSON.stringify(promptRows),
          },
          {
            claim:
              'each contributing timeline row records its user-turn and derived follow-up counts',
            source: 'parse-timeline',
            field: 'timelines[].entries[].{kind,timestamp}',
            value: JSON.stringify(timelineRows),
          },
          {
            claim:
              'each contributing session records its native/text API-error count',
            source: 'parse-errors',
            field: 'apiErrors[].{sessionId,timestamp}',
            value: JSON.stringify(apiErrorRows),
          },
          {
            claim:
              `${low.length} low-specificity and ${comparison.length} comparison ` +
              `session(s) produced means ${fmt(lowFollowUps)} and ` +
              `${fmt(comparisonFollowUps)}, with Pearson r=${correlation.toFixed(2)}`,
            source: 'workflow.prompt-clarity sample calculation',
            field:
              'samples[].{isLowSpecificity,followUpTurns,proxyScore}',
            value: aggregateValue,
          },
          {
            claim:
              `the low-specificity split is ${LOW_SPECIFICITY_RATE}, minimum bucket ` +
              `size is ${MIN_BUCKET_SESSIONS}, follow-up gap floor is ` +
              `${MIN_FOLLOW_UP_GAP}, and correlation floor is ${MIN_CORRELATION}`,
            source: 'workflow.prompt-clarity detector',
            field:
              'LOW_SPECIFICITY_RATE / MIN_BUCKET_SESSIONS / MIN_FOLLOW_UP_GAP / MIN_CORRELATION',
            value:
              `${LOW_SPECIFICITY_RATE}/${MIN_BUCKET_SESSIONS}/` +
              `${MIN_FOLLOW_UP_GAP}/${MIN_CORRELATION}`,
          },
        ],
        inference:
          'The measured bucket means and Pearson correlation describe association, ' +
          'not causation. Follow-up turns plus API-error counts are a friction proxy; ' +
          'they do not establish that prompt specificity caused the extra work.',
        ...(asOf ? { asOf, stale } : {}),
      },
    };
  },
};
