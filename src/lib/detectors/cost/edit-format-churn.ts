import type { Detector, Recommendation, RecommendationInput } from '../types';
import type { ToolCall } from '../../parse-tools-types';
import { basename, claudeMdMarksApplied, short, STALE_WEEKS } from '../shared';

/**
 * `cost.edit-format-churn` (#2507, epic #2199) — surface sessions whose
 * Edit/MultiEdit traffic is DOMINATED by formatting-only churn: hunks whose
 * ordered nonblank lines are identical after per-line trim (pure reindent,
 * trailing-space, blank-line shuffles). Every such hunk re-emits the old AND
 * new bodies as billed output tokens while changing nothing semantic.
 *
 * The metric is parser-owned: `ToolCall.editFormatChurn` is derived from the
 * raw `old_string`/`new_string` bodies at parse time, BEFORE distillation
 * drops them (counts and sizes only — no source text reaches this detector).
 *
 * HONESTY CONTRACT. Trim-identical lines are a PROXY for "pointless
 * reformatting" — the human may have asked for the reformat, or a formatter
 * hook may be the real author. The finding therefore says "verify intent",
 * never "this was waste". Conservative gates:
 *  - Only calls whose `file_path` extension is on the countable ALLOWLIST
 *    (brace-structured, whitespace-insignificant languages) count; anything
 *    else — indentation-significant languages, markup/templates, shells,
 *    lockfiles/minified artifacts, unknown extensions — fails closed.
 *  - `truncated` analyses and errored calls are suppressed evidence, never
 *    counted (fail closed).
 *  - Only evidence inside the recent window drives the finding, so a
 *    months-old reformat spree cannot fire a present-tense claim.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** Evidence older than this cannot drive the finding (recent-window handling). */
const RECENT_WINDOW_MS = STALE_WEEKS * 7 * DAY_MS;

/** Floor gates — all three must clear before anything is said. */
const MIN_FORMATTING_ONLY_HUNKS = 12;
const MIN_FORMATTING_ONLY_LINES = 120;
const MIN_HUNK_RATIO = 0.25;

/** Bounded number of file paths cited in the evidence. */
const MAX_EVIDENCE_FILES = 3;
/** Bounded number of session-prefixed evidence rows — the first token of each
 * is the session id, which `recommendationProjects` maps to a project so the
 * project-scoped API can attribute this finding. */
const MAX_EVIDENCE_SESSIONS = 3;

/**
 * ALLOWLIST of extensions where a trim-identical hunk is sound to classify
 * formatting-only (modulo the parser's in-hunk multiline-literal guard):
 * brace/keyword-structured languages whose leading whitespace is never
 * semantic and whose multi-line string forms the parser's guard recognizes.
 * Everything NOT listed fails closed as unknowable — indentation-significant
 * languages (Python/YAML/Haskell/F#/Starlark/...), markup and template files
 * whose whitespace can be rendered output (HTML/JSX/PHP/ERB/...), shells and
 * scripting languages with multi-line quoted strings or heredocs
 * (sh/rb/pl/lua/...), and data/doc formats. An allowlist scales the
 * fail-closed doctrine: an unconsidered language is never countable, instead
 * of every newly-remembered language needing an exclusion entry.
 */
const COUNTABLE_EXTENSIONS = new Set([
  'ts',
  'mts',
  'cts',
  'js',
  'mjs',
  'cjs',
  'java',
  'c',
  'h',
  'cpp',
  'cxx',
  'cc',
  'hpp',
  'hh',
  'hxx',
  'go',
  'kt',
  'kts',
  'swift',
  'scala',
  'dart',
  'proto',
  'json',
  'jsonc',
]);
// NOT listed despite being brace-structured: 'sql' (single-quoted literals
// span lines with no guard-recognizable delimiter), 'cs' (verbatim @"..."
// strings), 'rs' (ORDINARY "..." strings may span physical lines, not just
// the guarded raw forms), and 'css'/'scss'/'less' (a leading space on a
// mid-line Edit slice can turn a compound selector into a descendant
// combinator) — each fails closed instead.
/** Machine-formatted basenames never countable even with a listed extension. */
const EXCLUDED_BASENAMES = new Set(['package-lock.json']);

const MARKERS = {
  headings: [/^##\s+Formatting discipline\b/i],
  bodyPhrases: ['do not reformat code you are not otherwise changing'],
};

/** True when the edited path may carry formatting-churn claims (allowlist). */
function isCountablePath(filePath: string): boolean {
  // Normalize Windows separators first: a backslash path would otherwise make
  // the whole path the "basename" and defeat both checks below.
  const lowerBase = basename(filePath.replace(/\\/g, '/')).toLowerCase();
  if (EXCLUDED_BASENAMES.has(lowerBase)) return false;
  if (lowerBase.includes('.min.')) return false;
  const dot = lowerBase.lastIndexOf('.');
  if (dot <= 0) return false; // no extension → language unknowable → fail closed
  return COUNTABLE_EXTENSIONS.has(lowerBase.slice(dot + 1));
}

/**
 * Non-time evidence eligibility — shared by the rule and the cache-validity
 * seam so both observe the same countable-call set. Only a PROVEN-successful
 * call counts: `isError` must be exactly `false` (a `null` — no tool_result
 * seen, e.g. an interrupted session — is unproven churn, suppressed).
 * `truncated` calls remain COUNTABLE here: they cannot contribute hunks, but
 * their presence in the window vetoes the whole finding (unknown hunks make a
 * dominance claim unprovable), so they affect the output — and therefore the
 * cache validity — exactly like counted evidence.
 */
function countableChurn(call: ToolCall): boolean {
  const churn = call.editFormatChurn;
  if (!churn) return false;
  if (call.isError !== false) return false;
  if (typeof call.input.file_path !== 'string' || call.input.file_path === '') {
    return false; // the allowlist needs a path → fail closed
  }
  return isCountablePath(call.input.file_path);
}

/** An Edit/MultiEdit call whose churn metric may count as evidence NOW. */
function eligibleChurn(call: ToolCall, now: number): boolean {
  if (!countableChurn(call)) return false;
  const ts = Date.parse(call.timestamp);
  if (!Number.isFinite(ts)) return false;
  return now - ts <= RECENT_WINDOW_MS && ts <= now;
}

export interface EditFormatChurnCacheValidity {
  /** Exclusive lower clock bound for which a cached output remains valid. */
  after: number | null;
  /** Inclusive upper clock bound for which a cached output remains valid. */
  through: number | null;
}

/**
 * Freshness crossings for the recommendations response cache (mirrors
 * `skillHookIntegrityCacheValidity`): each countable call's evidence exits the
 * recent window at `ts + RECENT_WINDOW_MS` (and a future-dated call enters it
 * at `ts`), changing this detector's output with NO source change. A cached
 * body is valid strictly after the latest past crossing and through the
 * earliest future one.
 */
export function editFormatChurnCacheValidity(
  input: Pick<RecommendationInput, 'toolData'>,
  now: number
): EditFormatChurnCacheValidity {
  if (!input.toolData || !Number.isFinite(now)) {
    return { after: null, through: null };
  }
  let after: number | null = null;
  let through: number | null = null;
  // Strictly-past crossings are lower bounds; a crossing AT `now` is still the
  // last instant of the current segment (both eligibility bounds are
  // inclusive), so it belongs to `through` — a body built at that instant is
  // valid at it and invalid one millisecond later.
  const observe = (crossing: number) => {
    if (crossing < now) {
      if (after === null || crossing > after) after = crossing;
    } else if (through === null || crossing < through) {
      through = crossing;
    }
  };
  for (const session of input.toolData) {
    for (const call of session.calls) {
      if (!countableChurn(call)) continue;
      const ts = Date.parse(call.timestamp);
      if (!Number.isFinite(ts)) continue;
      // A call becomes eligible AT ts (`ts <= now`), so a body is only valid
      // through the instant BEFORE it enters — recorded unconditionally so the
      // entry boundary also holds as a lower bound if this helper is evaluated
      // with an earlier `now` (e.g. after a backward clock correction).
      observe(ts - 1);
      observe(ts + RECENT_WINDOW_MS);
    }
  }
  return { after, through };
}

export function editFormatChurnCacheValidityContains(
  validity: EditFormatChurnCacheValidity,
  now: number
): boolean {
  if (!Number.isFinite(now)) return false;
  return (
    (validity.after === null || now > validity.after) &&
    (validity.through === null || now <= validity.through)
  );
}

export const detector: Detector = {
  id: 'cost.edit-format-churn',
  appliedMarkers: MARKERS,
  category: 'cost',
  dataDeps: ['toolData', 'liveConfig'],
  rule(input, now): Recommendation | null {
    if (claudeMdMarksApplied(input.liveConfig, MARKERS)) return null;
    const sessions = input.toolData;
    if (!sessions || sessions.length === 0) return null;

    let hunks = 0;
    let formattingOnlyHunks = 0;
    let formattingOnlyLines = 0;
    let formattingOnlyChars = 0;
    let latestMs = 0;
    // The hunk denominator spans every ELIGIBLE session; the finding's
    // `affected` names only sessions that contributed formatting-only churn.
    // Keeping both scopes explicit keeps the rendered percentage reconcilable.
    const eligibleSessionIds = new Set<string>();
    const formattingSessionIds = new Set<string>();
    const linesByFile = new Map<string, number>();
    const churnBySession = new Map<string, { lines: number; hunks: number }>();

    for (const session of sessions) {
      for (const call of session.calls) {
        if (!eligibleChurn(call, now)) continue;
        const churn = call.editFormatChurn!;
        // A truncated analysis in the window means UNKNOWN hunks exist: a
        // "format-dominated" claim over that window is unprovable, so the
        // whole finding is vetoed (honest null) rather than quietly computed
        // over the analyzed subset.
        if (churn.truncated) return null;
        hunks += churn.hunks;
        eligibleSessionIds.add(session.sessionId);
        // asOf must cover EVERY hunk in the denominator, not just the
        // formatting-only ones, or the rendered date can predate the evidence.
        const ts = Date.parse(call.timestamp);
        if (ts > latestMs) latestMs = ts;
        if (churn.formattingOnlyHunks === 0) continue;
        formattingOnlyHunks += churn.formattingOnlyHunks;
        formattingOnlyLines += churn.formattingOnlyLines;
        formattingOnlyChars += churn.formattingOnlyChars;
        formattingSessionIds.add(session.sessionId);
        const perSession = churnBySession.get(session.sessionId) ?? { lines: 0, hunks: 0 };
        perSession.lines += churn.formattingOnlyLines;
        perSession.hunks += churn.formattingOnlyHunks;
        churnBySession.set(session.sessionId, perSession);
        const path = call.input.file_path!;
        linesByFile.set(path, (linesByFile.get(path) ?? 0) + churn.formattingOnlyLines);
      }
    }

    // Honest null: below the floor there is nothing worth saying.
    if (
      hunks === 0 ||
      formattingOnlyHunks < MIN_FORMATTING_ONLY_HUNKS ||
      formattingOnlyLines < MIN_FORMATTING_ONLY_LINES ||
      formattingOnlyHunks / hunks < MIN_HUNK_RATIO
    ) {
      return null;
    }

    const ratioPct = Math.round((formattingOnlyHunks / hunks) * 100);
    const asOf = new Date(latestMs).toISOString().slice(0, 10);
    const topFiles = [...linesByFile.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_EVIDENCE_FILES)
      .map(([path, lines]) => `${path} (${lines} formatting-only lines)`);
    // Session-id-first rows: the project-scoped API attributes a finding by
    // resolving each evidence row's first token — which its index stores as
    // the 8-char short(sessionId) prefix, so the row must lead with that form.
    const topSessions = [...churnBySession.entries()]
      .sort((a, b) => b[1].lines - a[1].lines)
      .slice(0, MAX_EVIDENCE_SESSIONS)
      .map(
        ([id, v]) =>
          `${short(id)} contributed ${v.hunks} formatting-only hunk(s) / ${v.lines} line(s)`
      );

    return {
      id: 'cost.edit-format-churn',
      category: 'cost',
      severity: 'info',
      title: 'Format-dominated Edit churn (proxy — verify intent)',
      detail:
        `As of ${asOf}, ${formattingOnlyHunks} of ${hunks} recent Edit/MultiEdit hunks ` +
        `(${ratioPct}%, counted across ${eligibleSessionIds.size} session(s) with recent edit ` +
        `activity) changed ONLY formatting — concentrated in ${formattingSessionIds.size} ` +
        `session(s). Their nonblank lines are identical after per-line trim (pure reindent / ` +
        `blank-line / trailing-space churn), ~${formattingOnlyLines.toLocaleString()} lines re-emitted. ` +
        `Each such hunk bills the old AND new bodies as output tokens without a semantic ` +
        `change. This is a proxy signal: verify intent before acting — the reformat may ` +
        `have been requested, or a formatter hook may be the real author. ` +
        `Only brace-structured, whitespace-insignificant languages are counted; ` +
        `indentation-significant languages, markup/templates, shells, and ` +
        `machine-formatted files are excluded.`,
      action:
        'If the reformatting was not asked for, steer the agent to keep diffs semantic-minimal: ' +
        'do not reformat code it is not otherwise changing, and delegate whole-file formatting ' +
        'to the project formatter instead of Edit calls.',
      affected: formattingSessionIds.size,
      evidence: [
        `${formattingOnlyHunks}/${hunks} recent hunks formatting-only (${ratioPct}%), ~${formattingOnlyLines.toLocaleString()} lines / ~${formattingOnlyChars.toLocaleString()} chars re-emitted`,
        ...topSessions,
        ...topFiles,
      ],
      view: 'cost',
      claimClass: 'accounting',
      proofTier: 'accounting',
      provenance: {
        observations: [
          {
            claim: `${formattingOnlyHunks} of ${hunks} Edit/MultiEdit hunks in the last ${STALE_WEEKS} weeks were formatting-only (ordered nonblank lines identical after per-line trim)`,
            source: 'parse-tools',
            field: 'toolData[].calls[].editFormatChurn',
            value: formattingOnlyHunks,
          },
          {
            claim: `~${formattingOnlyLines.toLocaleString()} lines re-emitted by formatting-only hunks across ${formattingSessionIds.size} session(s)`,
            source: 'parse-tools',
            field: 'editFormatChurn.formattingOnlyLines',
            value: formattingOnlyLines,
          },
        ],
        inference:
          'Trim-identical hunks re-emit both bodies as billed output tokens while changing nothing semantic — a proxy for unrequested reformatting. Intent is not observable from transcripts alone, so the finding asks to verify it; only an allowlist of whitespace-insignificant languages is counted (everything else fails closed), and truncated analyses and failed calls are never counted.',
        asOf,
      },
      fix: {
        target: 'CLAUDE.md',
        label: 'Add a formatting-discipline directive',
        note: 'Append to CLAUDE.md so agents keep diffs semantic-minimal. Skip if the reformatting was intentional.',
        snippet: `## Formatting discipline

- Keep diffs semantic-minimal: do not reformat code you are not otherwise changing (reindent, blank-line, or trailing-space churn).
- Whole-file formatting belongs to the project formatter (one command), not to Edit calls that re-emit the file body.`,
        appliedMarkers: MARKERS,
      },
    };
  },
};
