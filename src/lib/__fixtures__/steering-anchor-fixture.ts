/**
 * Labeled steering-anchor fixture (#1751) — the precision-gate evidence for the
 * structural-anchor corrective classifier in `parse-steering.ts`.
 *
 * Each turn is a real-shaped user message with a hand label:
 *  - `corrective: true`  — the human is reacting to and redirecting the agent's
 *    immediately-prior action (the signal we want to catch).
 *  - `corrective: false` — additive instructions, clarifying answers, approvals,
 *    polite chatter, and "polite-corrective / negation-corrective" near-misses
 *    that a deterministic lexicon over 200-char summaries cannot cleanly separate
 *    (the failure mode named in the issue).
 *
 * `firstInSpan` marks the kickoff turn of a session (no prior assistant action
 * to back-reference); the classifier must treat those as non-corrective.
 *
 * `cohort` is the (anonymized) user whose phrasing the turn imitates, so the
 * per-user cohort-bias test can check that classifier errors do not concentrate
 * in one person's voice. Three cohorts with deliberately different styles:
 *   - `terse`   — clipped, lowercase, imperative.
 *   - `polite`  — softened, hedged, question-framed.
 *   - `verbose` — long, explanatory, multi-clause.
 *
 * 60 turns, balanced ~50/50 corrective vs not, across all three cohorts.
 */
export interface LabeledSteeringTurn {
  cohort: 'terse' | 'polite' | 'verbose';
  text: string;
  corrective: boolean;
  firstInSpan: boolean;
}

export const STEERING_ANCHOR_FIXTURE: LabeledSteeringTurn[] = [
  // ── terse cohort ──────────────────────────────────────────────────────────
  { cohort: 'terse', text: 'build the login form', corrective: false, firstInSpan: true },
  { cohort: 'terse', text: 'no, that uses the wrong endpoint', corrective: true, firstInSpan: false },
  { cohort: 'terse', text: 'revert that change', corrective: true, firstInSpan: false },
  { cohort: 'terse', text: 'now add a logout button', corrective: false, firstInSpan: false },
  { cohort: 'terse', text: 'actually you broke the import', corrective: true, firstInSpan: false },
  { cohort: 'terse', text: 'fix it', corrective: true, firstInSpan: false },
  { cohort: 'terse', text: 'also wire up the api client', corrective: false, firstInSpan: false },
  { cohort: 'terse', text: 'stop, undo it', corrective: true, firstInSpan: false },
  { cohort: 'terse', text: 'yes the file is src/auth.ts', corrective: false, firstInSpan: false },
  { cohort: 'terse', text: "that's wrong, use POST", corrective: true, firstInSpan: false },
  { cohort: 'terse', text: 'add tests next', corrective: false, firstInSpan: false },
  { cohort: 'terse', text: 'wait, keep the old name', corrective: true, firstInSpan: false },
  { cohort: 'terse', text: 'ok ship it', corrective: false, firstInSpan: false },
  { cohort: 'terse', text: 'you changed the wrong file', corrective: true, firstInSpan: false },
  { cohort: 'terse', text: 'make a new component', corrective: false, firstInSpan: false },
  { cohort: 'terse', text: 'no not like that', corrective: true, firstInSpan: false },
  { cohort: 'terse', text: 'create the readme', corrective: false, firstInSpan: false },
  { cohort: 'terse', text: 'undo the last edit', corrective: true, firstInSpan: false },
  { cohort: 'terse', text: 'lgtm', corrective: false, firstInSpan: false },
  { cohort: 'terse', text: 'remove that line you added', corrective: true, firstInSpan: false },

  // ── polite cohort ─────────────────────────────────────────────────────────
  { cohort: 'polite', text: 'could you set up the dashboard layout please', corrective: false, firstInSpan: true },
  { cohort: 'polite', text: "actually, that isn't quite what I meant, can we go back", corrective: true, firstInSpan: false },
  { cohort: 'polite', text: 'thanks, that looks great', corrective: false, firstInSpan: false },
  { cohort: 'polite', text: "hold on, I think you misunderstood the layout", corrective: true, firstInSpan: false },
  { cohort: 'polite', text: 'next, would you mind adding a footer', corrective: false, firstInSpan: false },
  { cohort: 'polite', text: "sorry, that's not right, please revert it", corrective: true, firstInSpan: false },
  { cohort: 'polite', text: 'yes, please use the blue theme', corrective: false, firstInSpan: false },
  { cohort: 'polite', text: "wait, you removed the wrong import there", corrective: true, firstInSpan: false },
  { cohort: 'polite', text: 'looks good, go ahead', corrective: false, firstInSpan: false },
  { cohort: 'polite', text: "hmm, actually let's not do that, undo it", corrective: true, firstInSpan: false },
  { cohort: 'polite', text: 'could you also document the props', corrective: false, firstInSpan: false },
  { cohort: 'polite', text: "that's not the file I meant, please change it back", corrective: true, firstInSpan: false },
  { cohort: 'polite', text: 'perfect, thank you', corrective: false, firstInSpan: false },
  { cohort: 'polite', text: "no, that approach won't work, can you redo it", corrective: true, firstInSpan: false },
  { cohort: 'polite', text: 'please create a settings page', corrective: false, firstInSpan: false },
  { cohort: 'polite', text: "actually you changed too much, just revert that part", corrective: true, firstInSpan: false },
  { cohort: 'polite', text: 'the answer is option B', corrective: false, firstInSpan: false },
  { cohort: 'polite', text: "wait, that's wrong, the endpoint should stay", corrective: true, firstInSpan: false },
  { cohort: 'polite', text: 'thanks, ship it when ready', corrective: false, firstInSpan: false },
  { cohort: 'polite', text: "don't do that, keep the original signature please", corrective: true, firstInSpan: false },

  // ── verbose cohort ────────────────────────────────────────────────────────
  {
    cohort: 'verbose',
    text: 'I want to build out the reporting module that aggregates the weekly metrics and renders them as a table',
    corrective: false,
    firstInSpan: true,
  },
  {
    cohort: 'verbose',
    text: "no, that's not what I asked for at all, you completely rewrote the aggregation when I only wanted the table",
    corrective: true,
    firstInSpan: false,
  },
  {
    cohort: 'verbose',
    text: 'now that the table works, let us also add a CSV export button below it so people can download the data',
    corrective: false,
    firstInSpan: false,
  },
  {
    cohort: 'verbose',
    text: "wait, you put the export logic in the wrong module, that belongs in the service layer not the component, please move it",
    corrective: true,
    firstInSpan: false,
  },
  {
    cohort: 'verbose',
    text: 'next I think we should write some integration tests that cover the aggregation path end to end',
    corrective: false,
    firstInSpan: false,
  },
  {
    cohort: 'verbose',
    text: "actually the change you just made broke the existing tests, revert it and try a smaller diff this time",
    corrective: true,
    firstInSpan: false,
  },
  {
    cohort: 'verbose',
    text: 'yes, the configuration file you are looking for lives under config/reporting.yaml in the repo root',
    corrective: false,
    firstInSpan: false,
  },
  {
    cohort: 'verbose',
    text: "that is wrong, you misunderstood the schema, the totals column is a sum not an average, please fix that",
    corrective: true,
    firstInSpan: false,
  },
  {
    cohort: 'verbose',
    text: 'after this is done, please create a short README section describing how to run the reporting job locally',
    corrective: false,
    firstInSpan: false,
  },
  {
    cohort: 'verbose',
    text: "hold on, undo the last edit, you changed the public API signature and that will break every downstream caller",
    corrective: true,
    firstInSpan: false,
  },
  {
    cohort: 'verbose',
    text: 'this looks good to me overall, I am happy with where the reporting module landed, thanks for the work',
    corrective: false,
    firstInSpan: false,
  },
  {
    cohort: 'verbose',
    text: "no, do not use a global variable for the cache there, that is exactly the pattern we agreed to avoid, please change it",
    corrective: true,
    firstInSpan: false,
  },
  {
    cohort: 'verbose',
    text: 'let us also add pagination to the table once the export work is finished, the dataset can get large',
    corrective: false,
    firstInSpan: false,
  },
  {
    cohort: 'verbose',
    text: "you removed the wrong dependency from the package file, put it back, I only wanted the dev one gone",
    corrective: true,
    firstInSpan: false,
  },
  {
    cohort: 'verbose',
    text: 'please implement a caching layer in front of the aggregation query so repeated dashboard loads are fast',
    corrective: false,
    firstInSpan: false,
  },
  {
    cohort: 'verbose',
    text: "instead of what you did, just keep the original loop, the refactor you wrote is harder to read and not faster",
    corrective: true,
    firstInSpan: false,
  },
  {
    cohort: 'verbose',
    text: 'go ahead and open the pull request now, the build is green and I have reviewed the diff myself already',
    corrective: false,
    firstInSpan: false,
  },
  {
    cohort: 'verbose',
    text: "that change is wrong, the date format you used is US-only and our users are international, revert it",
    corrective: true,
    firstInSpan: false,
  },
  {
    cohort: 'verbose',
    text: 'as a separate task, set up a nightly cron that regenerates the cached report and stores it in the bucket',
    corrective: false,
    firstInSpan: false,
  },
  {
    cohort: 'verbose',
    text: "don't touch the migration files, you keep editing them and that is not part of this task, leave them alone",
    corrective: true,
    firstInSpan: false,
  },
];
