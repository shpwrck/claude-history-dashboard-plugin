import type { Detector, RecObservation } from '../types';
import type { ToolUsageData, ToolCall } from '../../parse-tools';
import type { LiveConfig } from '../../../types';
import { short } from '../shared';

/**
 * Procedural-memory extraction (#2250, epic #2265).
 *
 * "Procedural memory" is knowledge of *how to do things* — in Claude terms, a
 * skill (`~/.claude/skills/`). This detector spots UN-captured procedural memory:
 * a CONTIGUOUS multi-step Bash command procedure (e.g. `git pull → npm run build
 * → docker push app:latest`) that recurs *ad-hoc across sessions* with no backing
 * skill. Capturing it as a skill could reduce the repeat setup of re-entering the
 * same steps each session.
 *
 * Auditable-claim contract (docs/adding-a-recommendation.md):
 *  - EVIDENCE / PROVENANCE: cites the recurring instances as structured
 *    provenance — the FULL list of session ids the procedure appeared in, the
 *    recurrence count, and the ACTUAL command field it was read from
 *    (`input.command`, or `commandPreview` when the bulk/server dataset has
 *    stripped raw bodies). `claimClass:'accounting'` — it MEASURES that a sequence
 *    RECURRED; it does not assert the steps were re-derived each time (they could
 *    be pasted, from shell history, or habit), nor a counterfactual saving.
 *  - MATCH KEY vs DISPLAY LABEL: {@link normalizeStep} returns three forms. The
 *    `matchKey` is the NEAR-LOSSLESS recurrence identity — the command with
 *    OUTSIDE-QUOTE whitespace collapsed (quoted whitespace is DATA and kept
 *    verbatim: `python -c 'print("a  b")'` ≠ `'print("a b")'`), preserving env
 *    assignments (`NODE_ENV=production …`), the FULL executable PATH
 *    (`scripts/prod/deploy.sh` ≠ `scripts/stage/deploy.sh`), ALL flags (bare
 *    `--force`/`--dry-run` included), every arg untruncated, and `cd <dir> &&`
 *    anchors. Two commands share a key only when they are genuinely the same
 *    command — the safe direction for a consumed detector is fewer-but-honest
 *    recurrences. The `label` is a shortened human display; `verbText` is the
 *    UNCAPPED verb tokens for coverage; the `groupKey` is the recurrence IDENTITY
 *    (= `matchKey` on the live path). On the STRIPPED path only a lossy
 *    `commandPreview` survives (parse-tools flattens newlines→spaces then slices),
 *    so `groupKey` folds in the exact `commandFingerprint` (an FNV-1a hash of the
 *    full raw command) — two commands that flatten to the same preview but differ
 *    in the raw body never merge (:296). A preview step with NO fingerprint has no
 *    exact identity to group on, so it BREAKS the run rather than merge on the lossy
 *    preview alone (:373). Grouping/subsumption key on `groupKey`;
 *    display uses `label`; coverage uses `verbText`; the SCAFFOLD and the auditable
 *    CLAIM/DETAIL use the exact command text `stepKeys`/`matchKey` (:547, :590) —
 *    never the shortened label — and when any step is preview-sourced the wording
 *    is SOFTENED ("approximate; matched by fingerprint") since the shown text is a
 *    preview.
 *  - SAME-PROJECT: a recurrence must sit WITHIN ONE project. Procedures are
 *    partitioned by (session's project + identity sequence), so the >= MIN_SESSIONS
 *    qualifying sessions all belong to the same project — three IDENTICAL relative
 *    command runs in three DIFFERENT repos are not one procedure. A session's
 *    project is resolved from its history `Session` row, else from its `tokenData`
 *    record (automation/`sdk-*` sessions carry `project` only there). A session
 *    that STILL can't be resolved gets a UNIQUE per-session bucket, so unresolved
 *    sessions can NEVER cross-merge with each other (:547).
 *  - CONTIGUITY: a "procedure" is a run of ADJACENT, COMPLETED-and-SUCCEEDED Bash
 *    calls. Only `call.isError === false` continues the run; an intervening
 *    non-Bash tool call, an unparseable Bash call, a FAILED call (`isError === true`),
 *    OR an interrupted/still-running call (`isError === null`, no tool_result)
 *    BREAKS it — an unproven step is never asserted as part of the procedure.
 *  - MAXIMAL SEQUENCE: candidate windows are grown to the longest recurring run
 *    (not fixed 3-grams). A sub-window is suppressed in favour of a longer one
 *    ONLY when its recurrence is genuinely SUBSUMED — i.e. the SET of sessions it
 *    qualifies in is a subset of the longer sequence's sessions (no independent
 *    recurrence). A high-support subprocedure that recurs in strictly MORE
 *    sessions than the supersequence is kept, so a rare superprocedure can never
 *    hide a common subprocedure.
 *  - RECURRENCE THRESHOLD: fires only when the identical procedure appears in
 *    >= {@link MIN_SESSIONS} DISTINCT sessions; one-offs are suppressed. It must
 *    also be a genuine MULTI-step procedure ({@link MIN_DISTINCT_STEPS} distinct
 *    step keys), so a single command repeated N times (that is
 *    `workflow.repeated-commands`) does not masquerade as a procedure here.
 *  - SUPPRESSION: only reached when a real skill inventory is available
 *    (`liveConfig` present — see below); coverage consults only the skills
 *    REACHABLE from the procedure's project — GLOBAL (user-scoped) skills plus
 *    that project's own project-scoped skills — so a skill under `/repo-a` can't
 *    suppress a procedure whose sessions are in `/repo-b`. If a reachable
 *    installed/bundled skill shares >= {@link MIN_SKILL_COVER_OVERLAP} of the
 *    procedure's action verbs, stay silent. Verbs and skill id/description are run
 *    through ONE shared tokenizer (script extensions stripped, hyphens split), so
 *    `./deploy.sh`↔`deploy` and `type-check`↔`type`+`check` match (:374). A
 *    package-manager `run <script>` contributes the SCRIPT NAME's tokens (`build`
 *    from `npm run build:prod`), never the generic `run`, so a skill merely
 *    mentioning "run" cannot suppress a script procedure (:440).
 *  - LIVECONFIG REQUIRED: the finding ASSERTS "no backing skill", which is only
 *    knowable when the skill inventory is actually loaded. On the SPA/upload path
 *    `liveConfig` is absent (normalized to `null`), so the detector stays DARK
 *    rather than turn an unknown inventory into a false "no skill" claim.
 *  - STALE HANDLING: recurrences are timestamped; if the latest occurrence is
 *    older than {@link STALE_MS} the wording is demoted to "as of <date>" and the
 *    provenance is marked stale, never phrased as current state.
 *  - FIX: a non-`validated` (`'illustrative'`) skill scaffold — the skill body is
 *    user-specific, so the snippet is an example to adapt, not a copy-paste command.
 */

/** Shortest run of contiguous Bash steps that counts as a candidate procedure. */
const MIN_SEQUENCE_LEN = 3;
/** Longest window grown/reported, to bound work and keep labels legible. */
const MAX_SEQUENCE_LEN = 8;
/** Distinct sessions the procedure must recur in before it is worth capturing. */
const MIN_SESSIONS = 3;
/** A procedure needs at least this many DISTINCT step keys (not a single repeat). */
const MIN_DISTINCT_STEPS = 2;
/** How many action verbs a skill's id/description must share to count as covering. */
const MIN_SKILL_COVER_OVERLAP = 2;
/** How many label parts (binary + args) to keep in the DISPLAY label. */
const MAX_LABEL_PARTS = 4;
/** Cap on an individual arg length inside a DISPLAY label (never the match key). */
const MAX_ARG_LEN = 40;
/** Latest occurrence older than this ⇒ demote to "as of <date>". 30 days. */
const STALE_MS = 30 * 24 * 60 * 60 * 1000;
/** Field key sentinel for the separator between step keys. */
const KEY_SEP = '␟';
/** Separator between a preview step's display text and its exact fingerprint. */
const FP_SEP = '␞';
/** Prefix for the per-session bucket given to a session whose project is unresolved. */
const UNRESOLVED_PREFIX = 'unresolved:';

/**
 * LEADING/global flags that take the following token as a VALUE (rather than it
 * being the sub-command): `git -C /repo pull`, `kubectl --context prod apply`,
 * `npm --prefix app run build`. The near-lossless MATCH KEY keeps every token
 * regardless; this set only shapes the shortened DISPLAY label / verb text, so a
 * leading flag's value is kept as a positional TARGET while the flag keyword is
 * dropped (`git -C api pull` → `git api pull`), rather than the value being
 * mistaken for the sub-command. Unknown flags are treated as boolean (they consume
 * nothing) so a boolean flag before a sub-command (`git --no-pager log`) can't
 * swallow it.
 */
const VALUE_FLAGS = new Set([
  '-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--chdir',
  '--prefix', '--cwd', '-w', '--workspace',
  '-H', '--host', '--context', '--config',
  '-n', '--kubeconfig', '-s', '--server',
  '-f', '--file', '--filename',
  '-i', '--index-url',
  '-m', '--message',
]);

/** Basename of an executable token: `/usr/bin/git` → `git`, `./deploy.sh` → `deploy.sh`. */
function basename(tok: string): string {
  const parts = tok.split('/');
  return parts[parts.length - 1] || tok;
}

/** Strip surrounding quotes and cap length so a DISPLAY arg stays compact/stable. */
function sanitizeArg(tok: string): string {
  return tok.replace(/^['"]|['"]$/g, '').slice(0, MAX_ARG_LEN);
}

/**
 * Collapse whitespace runs that sit OUTSIDE single/double quotes to a single
 * space, and trim the ends — but leave whitespace INSIDE quotes verbatim, because
 * there it is DATA (finding :161): `python -c 'print("a  b")'` must stay distinct
 * from `python -c 'print("a b")'`. A naive `\s+ → ' '` collapse would merge them
 * and manufacture a false recurrence.
 */
function collapseWsOutsideQuotes(s: string): string {
  let out = '';
  let quote: string | null = null;
  let prevWs = false;
  for (const ch of s) {
    if (quote) {
      out += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      prevWs = false;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v') {
      if (!prevWs) out += ' ';
      prevWs = true;
      continue;
    }
    out += ch;
    prevWs = false;
  }
  return out.trim();
}

/**
 * Peel leading `cd <dir> &&` / `export X=Y &&` anchors off a chained command.
 * Returns the anchor segments (whitespace-collapsed, in order) and the remaining
 * primary segment. The anchor DIR is distinguishing — `cd api && npm test` ≠
 * `cd web && npm test` — so the match key re-attaches it; the display label peels
 * it for brevity.
 */
function splitAnchors(command: string): { anchors: string[]; core: string } {
  let c = command.trim();
  const anchors: string[] = [];
  for (;;) {
    const m = c.match(/^(cd\s+[^&|;]+|export\s+[A-Za-z_][A-Za-z0-9_]*=[^&|;]*)&&\s*(.*)$/s);
    if (!m) break;
    anchors.push(collapseWsOutsideQuotes(m[1]));
    c = m[2].trim();
  }
  return { anchors, core: c };
}

interface NormalizedStep {
  /**
   * NEAR-LOSSLESS recurrence identity: the whitespace-normalized command,
   * preserving env assignments, the FULL executable path, ALL flags (bare +
   * inline), every arg untruncated, and `cd <dir>` anchors. Two commands share a
   * key only when they are genuinely the same command. Grouping is keyed on this.
   */
  matchKey: string;
  /** Short human display (basename bin, keyword flags dropped, args capped). */
  label: string;
  /**
   * UNCAPPED bin (basename) + positional/verb tokens (keyword flags dropped, no
   * part cap, no arg truncation), used ONLY for skill-coverage verb extraction so
   * a long target value can never push a real action verb past the label cap.
   */
  verbText: string;
}

/**
 * Normalize a Bash command into a near-lossless {@link NormalizedStep.matchKey},
 * a short {@link NormalizedStep.label}, and an uncapped
 * {@link NormalizedStep.verbText}. Returns null for an empty/unusable command.
 */
function normalizeStep(command: string): NormalizedStep | null {
  const { anchors, core } = splitAnchors(command);
  // Quote-aware collapse (finding :161): outside-quote whitespace is noise, but
  // whitespace inside quotes is data and must survive into the match key.
  const cleaned = collapseWsOutsideQuotes(core);
  if (!cleaned) return null;
  // Empty tokens can only arise from whitespace preserved inside quotes; drop them
  // for label/verb tokenization (the match key is built from `cleaned`, not tokens).
  const tokens = cleaned.split(' ').filter((t) => t.length > 0);
  if (tokens.length === 0) return null;

  // Locate the executable, skipping any leading `X=Y` env assignments. They STAY
  // in the match key (they distinguish the command — env findings) but are not
  // part of the display binary.
  let envEnd = 0;
  while (envEnd < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[envEnd])) envEnd += 1;
  if (envEnd >= tokens.length) return null; // env-only, no command → not a step
  const binBase = basename(tokens[envEnd]); // display binary (path collapsed)
  if (!binBase) return null;

  // The DISPLAY label (capped) and the VERB text (uncapped) share token selection
  // but differ on caps: a long target must not push a real verb out of coverage.
  const labelParts: string[] = [binBase];
  const verbParts: string[] = [binBase];
  const addPart = (raw: string): void => {
    if (labelParts.length < MAX_LABEL_PARTS) labelParts.push(sanitizeArg(raw));
    verbParts.push(raw);
  };
  let sawPositional = false; // have we passed the sub-command yet?
  let i = envEnd + 1;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (tok.startsWith('-')) {
      const leading = !sawPositional;
      const inlineValue = tok.includes('=');
      if (leading && !inlineValue && VALUE_FLAGS.has(tok) && i + 1 < tokens.length) {
        // Leading target-bearing flag (`-C api`, `--context prod`): keep its VALUE
        // as a positional target; drop the flag keyword from the display/verb text.
        addPart(tokens[i + 1]);
        i += 2;
        continue;
      }
      if (inlineValue) {
        // `--flag=value` carries its own distinguishing value → keep it verbatim.
        addPart(tok);
        i += 1;
        continue;
      }
      // A bare boolean flag carries no target of its own → dropped from the
      // display label + verb text (it is STILL preserved in the near-lossless
      // match key, which keeps the whole command). A following positional is kept.
      i += 1;
      continue;
    }
    addPart(tok);
    sawPositional = true;
    i += 1;
  }

  // MATCH KEY = the whitespace-normalized command (anchors + env + full-path bin +
  // ALL flags + all args). Near-lossless: only whitespace differences collapse.
  const anchorKey = anchors.length ? `${anchors.join(' && ')} && ` : '';
  return {
    matchKey: anchorKey + cleaned,
    label: labelParts.join(' '),
    verbText: verbParts.join(' '),
  };
}

/**
 * Length parse-tools caps `commandPreview` at (`MAX_COMMAND_PREVIEW_LEN`).
 * parse-tools slices the preview to exactly this length when the raw command is
 * longer, so a preview AT/OVER this length may already have a truncated tail (a
 * differentiating target/tag) and cannot back an EXACT recurrence claim (:248).
 */
const PREVIEW_CAP_LEN = 200;

/**
 * The command text of a Bash call + which field it came from (for provenance) +
 * the exact `commandFingerprint` (finding :296). The live `input.command` is the
 * full body. On stripped bulk/client data `input.command` is gone and only
 * `commandPreview` survives — which parse-tools produces by FLATTENING newlines to
 * spaces then slicing to {@link PREVIEW_CAP_LEN}. So a preview is lossy (two
 * different multi-line commands can flatten to the same text) AND, at/over the
 * cap, truncated → a preview alone cannot back an EXACT recurrence. `text` is what
 * we DISPLAY; `fingerprint` (an FNV-1a hash of the FULL raw command, precomputed
 * before stripping — its documented purpose is "repeat grouping after raw Bash
 * text is stripped") is what we GROUP on when only a preview is available.
 */
function bashText(
  call: ToolCall
): { text: string; source: string; fingerprint?: string } | null {
  if (call.toolName !== 'Bash') return null;
  const fingerprint = call.commandFingerprint;
  const raw = call.input?.command;
  if (typeof raw === 'string' && raw.length > 0) {
    return { text: raw, source: 'input.command', fingerprint };
  }
  const preview = call.commandPreview;
  if (typeof preview === 'string' && preview.length > 0) {
    if (preview.length >= PREVIEW_CAP_LEN) return null; // at/over cap ⇒ truncated — not exact
    // A preview is LOSSY (parse-tools flattened newlines→spaces then sliced): its
    // exact recurrence identity relies on the precomputed `commandFingerprint`.
    // Without a fingerprint we could neither group it exactly — distinct raw
    // commands that flatten to the same under-cap preview would cross-merge into a
    // FALSE recurrence — nor honestly cite a fingerprint-backed match. So treat a
    // fingerprint-less preview step as unusable and let it BREAK the run, rather
    // than manufacture a lossy recurrence or a false provenance claim (:373).
    if (!fingerprint) return null;
    return { text: preview, source: 'commandPreview', fingerprint };
  }
  return null;
}

interface StepEvent {
  /**
   * The recurrence-GROUPING identity. On the live path it equals `matchKey` (the
   * exact command). On the stripped preview path — where the display text is lossy
   * — it folds in the exact `commandFingerprint` so two commands that flatten to
   * the same preview but differ in the raw body do NOT merge (finding :296).
   */
  groupKey: string;
  /** The near-lossless / preview command text — DISPLAY, scaffold, and claim. */
  matchKey: string;
  label: string;
  verbText: string;
  /** True when this step's text came from a lossy `commandPreview` (fidelity note). */
  fromPreview: boolean;
  ts: number | undefined;
  source: string;
}

/**
 * Split a session's calls into MAXIMAL contiguous runs of parseable, COMPLETED
 * Bash steps. Only a proven-succeeded call (`isError === false`) continues the
 * run; a non-Bash call, an unparseable Bash call, a FAILED call
 * (`isError === true`), or an interrupted/still-running call (`isError === null`,
 * no tool_result) ends it — so the "contiguous, succeeded" claim is honest and a
 * failed/incomplete command is never captured as a reusable procedure (:277).
 */
function sessionRuns(session: ToolUsageData): StepEvent[][] {
  const runs: StepEvent[][] = [];
  let current: StepEvent[] = [];
  const flush = (): void => {
    if (current.length) runs.push(current);
    current = [];
  };
  for (const call of session.calls) {
    const parsed = bashText(call);
    const norm = parsed ? normalizeStep(parsed.text) : null;
    if (!parsed || norm === null || call.isError !== false) {
      // Non-Bash / unparseable / FAILED / INCOMPLETE work breaks contiguity.
      flush();
      continue;
    }
    const ms = Date.parse(call.timestamp);
    const fromPreview = parsed.source === 'commandPreview';
    // Group EXACTLY: on the lossy preview path fold in the raw-command fingerprint
    // so distinct commands that flatten to the same preview never merge (:296).
    const groupKey =
      fromPreview && parsed.fingerprint ? `${norm.matchKey}${FP_SEP}${parsed.fingerprint}` : norm.matchKey;
    current.push({
      groupKey,
      matchKey: norm.matchKey,
      label: norm.label,
      verbText: norm.verbText,
      fromPreview,
      ts: Number.isFinite(ms) ? ms : undefined,
      source: parsed.source,
    });
  }
  flush();
  return runs;
}

export interface Procedure {
  key: string;
  /** The project all this procedure's sessions belong to (a unique sentinel per
   *  session when unresolved, so unresolved sessions can never cross-merge). */
  project: string;
  /** The GROUPING-identity sequence (fingerprint-exact on the preview path). */
  groupKeys: string[];
  /** The command-text sequence — the exact command (or preview) for scaffold + claim. */
  stepKeys: string[];
  /** The display-label sequence — used for evidence. */
  steps: string[];
  /** The UNCAPPED verb-text sequence — used for skill-coverage verb extraction. */
  verbSteps: string[];
  sessions: Set<string>;
  latestTs: number | undefined;
  sources: Set<string>;
  /** True when any step's text came from a lossy `commandPreview` (:296 fidelity). */
  fromPreview: boolean;
}

/** Script executable extensions stripped to the basename STEM for tokenizing so a
 *  `deploy.sh` executable matches a skill named `deploy` (finding :374). */
const SCRIPT_EXT = /\.(sh|bash|zsh|fish|py|rb|js|mjs|cjs|ts|tsx|pl|ps1|bat|cmd|go|rs)$/;

/**
 * ONE shared tokenizer for BOTH procedure verbs and skill id/description text
 * (finding :374), so the two sides can actually match: strip a trailing script
 * extension, then split on hyphens/underscores/other non-alphanumerics. Thus
 * `deploy.sh` → [`deploy`] and `type-check` → [`type`,`check`] on either side.
 */
function actionTokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\s+/)
    .flatMap((w) => w.replace(SCRIPT_EXT, '').split(/[^a-z0-9]+/))
    .filter((t) => /^[a-z][a-z0-9]*$/.test(t));
}

/**
 * Package-manager binaries whose `run <script>` sub-command names a SCRIPT whose
 * own action tokens are the real verbs (`build` in `npm run build:prod`), not the
 * generic `run` keyword. Without this, the script name is dropped by the
 * letters-only verb gate below (a `:`/digits make `build:prod` fail isVerbWord),
 * leaving `run` as the sole verb — which collapses the coverage threshold to 1 and
 * lets ANY skill merely mentioning "run" spuriously suppress the procedure (:440).
 */
const SCRIPT_RUNNERS = new Set(['npm', 'yarn', 'pnpm', 'bun', 'deno']);
/** Generic package-runner sub-verbs that carry no action of their own — the script
 *  name that FOLLOWS them does. Dropped so a lone `run` can't become a one-token
 *  coverage key (:440). */
const RUNNER_VERBS = new Set(['run', 'run-script']);

/**
 * Action verbs of a procedure: the positional (non-binary) VERB-like tokens of
 * each step's UNCAPPED verb text — `git pull` → `pull`, `npm run build:prod` →
 * `build`,`prod` (the SCRIPT NAME's tokens, not the generic `run`),
 * `docker push app:latest` → `push` (the `app:latest` target is not a verb). A word
 * is verb-like when, after stripping a script extension, it is letters + hyphens
 * only — so targets with digits/colons/slashes stay excluded but
 * `deploy.sh`/`type-check` qualify; each qualifying word is then run through the
 * shared {@link actionTokens} so it matches skill text identically (:374). Fed
 * `verbText` (not the capped label) so a long target can't hide a verb (:445).
 * EXCEPTION (:320): a single-token step with no sub-command (`make`, `pytest`,
 * `./deploy.sh`) contributes the BINARY itself, else a covering skill is missed.
 * RUNNER EXCEPTION (:440, #2410): in a package-manager `run` step the FIRST generic
 * `run`/`run-script` keyword is dropped and the FIRST following non-flag script name
 * the letters-only gate rejects for a `:`/digit/punctuation (`build:prod`,
 * `_postinstall`) contributes its action tokens. Scanning past a workspace value
 * before it (`npm run -w app build:prod`, `npm run --workspace=app build:prod`) keeps
 * the real action from hiding behind the workspace name; stopping after the script
 * keeps trailing script args (`… -- app:v2`) out, a script literally named `run` is
 * still counted, and punctuation-led names are rescued (actionTokens strips it).
 */
function procedureVerbs(steps: string[]): Set<string> {
  const verbs = new Set<string>();
  const isVerbWord = (w: string): boolean => /^[a-z][a-z-]*$/.test(w.replace(SCRIPT_EXT, ''));
  const addWord = (w: string): void => {
    for (const t of actionTokens(w)) verbs.add(t);
  };
  for (const step of steps) {
    const words = step.split(' ');
    const bin = words[0]?.toLowerCase() ?? '';
    const isRunner = SCRIPT_RUNNERS.has(bin);
    let runVerbSeen = false; // have we dropped the generic `run`/`run-script` keyword?
    let scriptRescued = false; // have we rescued the one `:`/digit script name yet?
    let added = 0;
    for (let k = 1; k < words.length; k += 1) {
      const w = words[k].toLowerCase();
      if (isRunner && !runVerbSeen && RUNNER_VERBS.has(w)) {
        // Drop the generic runner verb — but only the FIRST one, so a package script
        // literally named `run` (`npm run run`) is still counted below (:440, #2410).
        runVerbSeen = true;
        continue;
      }
      if (isVerbWord(w)) {
        addWord(w);
        added += 1;
      } else if (isRunner && runVerbSeen && !scriptRescued && !w.startsWith('-')) {
        // The FIRST non-flag token after `run` that the letters-only gate rejects for
        // a `:`/digit/punctuation (`build:prod`, `test:e2e`, `_postinstall`) is the
        // SCRIPT NAME — tokenize it and stop. Scanning PAST a workspace value before
        // it (`npm run -w app build:prod` → verbText `npm run app build:prod`, where
        // `app` is a plain positional handled above) keeps the real action from hiding
        // behind the workspace name; stopping AFTER the script keeps later script ARGS
        // (`… -- app:v2`) out of the verb set. Excluding only `-`-prefixed tokens
        // (rather than requiring a leading letter) rescues punctuation-led scripts,
        // since `actionTokens` strips the punctuation anyway (:440, #2410).
        addWord(w);
        added += 1;
        scriptRescued = true;
      }
    }
    if (added === 0 && isVerbWord(bin)) addWord(bin); // single-token command → binary is the verb
  }
  return verbs;
}

/** One entry in the skill-coverage inventory: a directly-installed skill or a
 *  plugin-bundled skill. `description` is present only for installed skills. */
interface CoverageSkill {
  id: string;
  description?: string;
}

/**
 * The skill-coverage inventory REACHABLE from a given project (finding :345):
 * GLOBAL (user-scoped) skills, which any project can invoke, PLUS the project's
 * OWN project-scoped skills. A skill scoped to `/repo-a` (`scope:'project'`,
 * `projectPath:'/repo-a'`) must not cover a procedure whose sessions are in
 * `/repo-b`, or it would draw a false suppression. Plugin-bundled skills
 * (`liveConfig.plugins[].bundled.skills`) are folded in for user-scoped plugins;
 * project-scoped plugins carry no `projectPath`, so their reachability can't be
 * verified and they are conservatively excluded (never suppress on an
 * unverifiable resource). A skill/plugin with no explicit scope is treated as
 * reachable (global) for back-compat.
 */
function reachableInventory(liveConfig: LiveConfig, project: string): CoverageSkill[] {
  const out: CoverageSkill[] = [];
  for (const s of liveConfig.skills ?? []) {
    if (s.scope === 'project' && s.projectPath !== project) continue; // other project's skill
    out.push({ id: s.id, description: s.description });
  }
  for (const plugin of liveConfig.plugins ?? []) {
    if (plugin.scope === 'project') continue; // no projectPath ⇒ can't verify reachability
    for (const sid of plugin.bundled?.skills ?? []) out.push({ id: sid });
  }
  return out;
}

/** Word tokens of a skill's id + description via the SAME {@link actionTokens}
 *  tokenizer the verbs use, so `deploy`↔`deploy.sh` and `type`+`check`↔`type-check`
 *  match on both sides (finding :374). */
function skillTokens(skill: CoverageSkill): Set<string> {
  return new Set(actionTokens(`${skill.id} ${skill.description ?? ''}`));
}

/** The verb-overlap threshold at which a skill counts as covering this procedure. */
function coverThreshold(verbCount: number): number {
  return Math.min(MIN_SKILL_COVER_OVERLAP, verbCount);
}

/** The id of an installed/bundled skill that already covers this procedure, or null. */
function coveringSkill(steps: string[], skills: CoverageSkill[]): string | null {
  const verbs = procedureVerbs(steps);
  if (verbs.size === 0) return null;
  const threshold = coverThreshold(verbs.size);
  for (const skill of skills) {
    const toks = skillTokens(skill);
    let overlap = 0;
    for (const v of verbs) if (toks.has(v)) overlap += 1;
    if (overlap >= threshold) return skill.id;
  }
  return null;
}

/** Is `sub` a CONTIGUOUS sub-sequence of `sup` (same order, adjacent)? */
function isContiguousSubsequence(sub: string[], sup: string[]): boolean {
  if (sub.length > sup.length) return false;
  for (let s = 0; s + sub.length <= sup.length; s += 1) {
    let ok = true;
    for (let k = 0; k < sub.length; k += 1) {
      if (sup[s + k] !== sub[k]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

/** Is every element of `a` also in `b`? (a ⊆ b) */
function isSubsetOf(a: Set<string>, b: Set<string>): boolean {
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/**
 * Keep only MAXIMAL qualifying procedures (#3240).
 *
 * A candidate `p` is suppressed only when a STRICTLY-LONGER qualifying `q`
 * CONTAINS its group-key sequence contiguously AND subsumes its sessions (see
 * finding #5). The old code ran that predicate as `qualifying.filter(p =>
 * !qualifying.some(q => …))` — an all-pairs O(C²) scan over the full candidate
 * list on every detector evaluation, unbounded in the number of qualifying
 * windows a long recurring run produces.
 *
 * Here each candidate is indexed under every PROPER contiguous sub-block of its
 * group keys (at most O(L²) blocks, L ≤ {@link MAX_SEQUENCE_LEN}), keyed by
 * `project + block identity`. Because any `q` that contains `p` contiguously and
 * is strictly longer must have registered `p`'s exact group-key sequence as one
 * of its proper sub-blocks, `p`'s only possible supersequences are
 * `supersByBlock.get(blockKey(p))` — a small bounded set instead of all C
 * candidates. The predicate applied to that set is byte-identical to the
 * original (same `isContiguousSubsequence` + `isSubsetOf` guards), so the
 * surfaced maximal set is unchanged; only the candidate enumeration shrinks from
 * quadratic to O(C·L² + matches).
 */
export function selectMaximalProcedures(qualifying: Procedure[]): Procedure[] {
  const blockKey = (project: string, groupKeys: string[]): string =>
    `${project}${KEY_SEP}${groupKeys.join(KEY_SEP)}`;

  const supersByBlock = new Map<string, Procedure[]>();
  for (const q of qualifying) {
    const gk = q.groupKeys;
    const seenBlocks = new Set<string>(); // register each q at most once per block
    for (let start = 0; start < gk.length; start += 1) {
      for (let end = start + 1; end <= gk.length; end += 1) {
        if (end - start >= gk.length) continue; // PROPER sub-block only (shorter than q)
        const key = blockKey(q.project, gk.slice(start, end));
        if (seenBlocks.has(key)) continue;
        seenBlocks.add(key);
        const bucket = supersByBlock.get(key);
        if (bucket) bucket.push(q);
        else supersByBlock.set(key, [q]);
      }
    }
  }

  return qualifying.filter((p) => {
    const supers = supersByBlock.get(blockKey(p.project, p.groupKeys));
    if (!supers) return true;
    return !supers.some(
      (q) =>
        q !== p &&
        q.groupKeys.length > p.groupKeys.length &&
        isContiguousSubsequence(p.groupKeys, q.groupKeys) &&
        isSubsetOf(p.sessions, q.sessions)
    );
  });
}

/**
 * Enumerate every contiguous window (length {@link MIN_SEQUENCE_LEN}..
 * {@link MAX_SEQUENCE_LEN}) across all sessions' Bash runs, keyed by its
 * (PROJECT + match-key sequence), tracking the DISTINCT sessions it appears in,
 * the latest timestamp, and which command fields fed it. Partitioning by project
 * (finding :417) means the sessions of any one procedure all belong to the SAME
 * project; a session whose project can't be resolved falls into a single shared
 * bucket (`''`). Windows are later filtered so a sub-window only loses to a longer
 * sequence that actually subsumes its sessions.
 */
function buildProcedures(
  toolData: ToolUsageData[],
  sessionProject: Map<string, string>
): Map<string, Procedure> {
  const procedures = new Map<string, Procedure>();
  for (const session of toolData) {
    // Finding :547 — an UNRESOLVED project must not collapse to a shared bucket
    // (automation sessions across many repos would cross-merge into a false
    // "same-project recurrence"); give each a UNIQUE bucket so they never
    // aggregate with each other.
    const project =
      sessionProject.get(session.sessionId) ?? `${UNRESOLVED_PREFIX}${session.sessionId}`;
    for (const run of sessionRuns(session)) {
      const maxLen = Math.min(run.length, MAX_SEQUENCE_LEN);
      for (let len = MIN_SEQUENCE_LEN; len <= maxLen; len += 1) {
        for (let s = 0; s + len <= run.length; s += 1) {
          const window = run.slice(s, s + len);
          const groupKeys = window.map((w) => w.groupKey);
          if (new Set(groupKeys).size < MIN_DISTINCT_STEPS) continue; // not a multi-step procedure
          const key = `${project}${KEY_SEP}${groupKeys.join(KEY_SEP)}`; // project + identity
          const winLatest = window.reduce<number | undefined>(
            (acc, w) => (w.ts === undefined ? acc : Math.max(acc ?? w.ts, w.ts)),
            undefined
          );
          const existing = procedures.get(key);
          if (existing) {
            existing.sessions.add(session.sessionId);
            for (const w of window) existing.sources.add(w.source);
            if (winLatest !== undefined) {
              existing.latestTs =
                existing.latestTs === undefined ? winLatest : Math.max(existing.latestTs, winLatest);
            }
          } else {
            procedures.set(key, {
              key,
              project,
              groupKeys,
              stepKeys: window.map((w) => w.matchKey),
              steps: window.map((w) => w.label),
              verbSteps: window.map((w) => w.verbText),
              sessions: new Set([session.sessionId]),
              latestTs: winLatest,
              sources: new Set(window.map((w) => w.source)),
              fromPreview: window.some((w) => w.fromPreview),
            });
          }
        }
      }
    }
  }
  return procedures;
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Detect a recurring, uncaptured multi-step Bash procedure and recommend a skill. */
export const detector: Detector = {
  id: 'workflow.procedural-memory',
  category: 'workflow',
  dataDeps: ['toolData', 'liveConfig', 'sessions', 'tokenData'],
  rule(input, now) {
    // The finding ASSERTS "no backing skill" — only knowable with a real skill
    // inventory. Absent liveConfig (SPA/upload path) ⇒ stay dark, never claim
    // absence of a skill from an unknown inventory.
    const liveConfig = input.liveConfig;
    if (!liveConfig) return null;

    // Session → project map (finding :417) partitions recurrences so they stay
    // WITHIN one project. Resolve from the history `Session` row FIRST, then fall
    // back to the token record's `project` (finding :547) — automation/`sdk-*`
    // sessions are transcript-only with no `Session` row but DO carry `project` on
    // `tokenData`. A session left unresolved gets a UNIQUE bucket in
    // buildProcedures, so unresolved sessions can never cross-merge across repos.
    const sessionProject = new Map<string, string>();
    for (const s of input.sessions ?? []) {
      if (s.project) sessionProject.set(s.sessionId, s.project);
    }
    for (const t of input.tokenData ?? []) {
      if (t.project && !sessionProject.has(t.sessionId)) sessionProject.set(t.sessionId, t.project);
    }
    const procedures = buildProcedures(input.toolData, sessionProject);

    // Qualifying = recurs enough (in ONE project) AND not covered by a skill
    // REACHABLE from that project. Coverage runs on the UNCAPPED verb text
    // (finding :445) against global + this-project skills only (finding :345).
    const qualifying = [...procedures.values()]
      .filter((p) => p.sessions.size >= MIN_SESSIONS)
      .filter((p) => coveringSkill(p.verbSteps, reachableInventory(liveConfig, p.project)) === null);

    // Finding #5: suppress a sub-window ONLY when a LONGER qualifying candidate
    // truly SUBSUMES it — i.e. the sub-window's occurrences are a subset of the
    // longer sequence's sessions, so it has no independent recurrence. Basing this
    // on the session SETS (not mere containment) keeps a HIGH-support subprocedure
    // that recurs in strictly more sessions than a rare supersequence — the round-3
    // regression dropped it in favour of the longer, lower-support flow.
    const maximal = selectMaximalProcedures(qualifying);

    const candidates = maximal.sort(
      (a, b) =>
        b.sessions.size - a.sessions.size ||
        b.groupKeys.length - a.groupKeys.length ||
        a.key.localeCompare(b.key)
    );

    const top = candidates[0];
    if (!top) return null;

    // Skills reachable from THIS procedure's project — the same set the coverage
    // check consulted for `top` — so the "checked N skill(s)" count is honest.
    const inventory = reachableInventory(liveConfig, top.project);
    const n = top.sessions.size;
    const stepCount = top.steps.length;
    const sessionIds = [...top.sessions];
    // seqLabel = shortened human display (evidence rows). seqExact = the EXACT
    // recurring commands (finding :590) — the claim/detail must not hide `--force`
    // or a long arg behind the label.
    const seqLabel = top.steps.join(' → ');
    const seqExact = top.stepKeys.join(' → ');
    const asOfMs = top.latestTs ?? now;
    const asOf = isoDate(asOfMs);
    const stale = top.latestTs !== undefined && now - top.latestTs > STALE_MS;
    // Fidelity (finding :296): if any step's text came from a lossy `commandPreview`
    // (newlines flattened, tail sliced) the DISPLAYED command is approximate even
    // though grouping is fingerprint-exact — soften the wording and cite the
    // fingerprint as the field that actually backed the match.
    const fromPreview = top.fromPreview;
    const previewNote = fromPreview
      ? ' The command text is shown from stripped-dataset command previews (approximate; the recurrence itself was matched by exact command fingerprint).'
      : '';
    const commandField = `toolData[].calls[].${[...top.sources].sort().join(' ?? ')}${
      fromPreview ? ' + commandFingerprint' : ''
    }`;

    // Claim wording (finding :395): the logs prove the sequence RECURRED — not
    // that it was re-derived each run. Frame the skill as reducing repeat setup.
    const detail = stale
      ? `As of ${asOf}, a ${stepCount}-step Bash procedure had recurred across ${n} sessions with no backing skill: ${seqExact}.${previewNote} Capturing it as a skill could reduce the repeat setup of running these steps ad-hoc.`
      : `A ${stepCount}-step Bash procedure recurs across ${n} sessions with no backing skill: ${seqExact}.${previewNote} Capturing it as a skill could reduce the repeat setup of running these steps ad-hoc each session.`;

    // Coverage-claim wording (finding :407): state the ACTUAL verb-overlap
    // threshold the suppression check uses, and cite the fields it reads
    // (skill id + description tokens vs the procedure's action verbs).
    const verbCount = procedureVerbs(top.verbSteps).size;
    const coverageClaim =
      verbCount === 0
        ? `this procedure exposes no action verbs to match, so no installed or plugin-bundled skill can cover it (checked ${inventory.length} skill(s))`
        : `no installed or plugin-bundled skill shares >= ${coverThreshold(verbCount)} of this procedure's ${verbCount} action verb(s) (checked ${inventory.length} skill(s))`;

    const observations: RecObservation[] = [
      {
        claim: `this ${stepCount}-step Bash sequence recurred as a contiguous run in ${n} distinct sessions${
          fromPreview ? ' (matched by command fingerprint; command text from previews)' : ''
        }: ${seqExact}`,
        source: 'parse-tools',
        field: commandField,
        value: n,
      },
      {
        claim: coverageClaim,
        source: 'liveConfig',
        field: 'skills[].id/description + plugins[].bundled.skills',
        value: inventory.length,
      },
      {
        // Finding :399 — the human claim/evidence may truncate the id list, but
        // the auditable observation carries EVERY session id so `n` is reproducible.
        claim: `the ${n} distinct sessions the procedure recurred in`,
        source: 'parse-tools',
        field: 'toolData[].sessionId',
        value: sessionIds.join(', '),
      },
    ];

    // Finding :547 — the scaffold must use the EXACT recurring command
    // (`stepKeys`/match key), not the shortened display label, or it would tell
    // the user to run a different/incomplete command (`git push --force …` scaffolded
    // as `git push …`). The label stays the human-readable evidence only.
    const stepBullets = top.stepKeys.map((s, i) => `${i + 1}. \`${s}\``).join('\n');

    return {
      id: 'workflow.procedural-memory',
      category: 'workflow',
      severity: 'info',
      title: 'Recurring command procedure is uncaptured procedural memory',
      // Proof posture (ADR 0017): this MEASURES that a procedure recurred N times
      // (arithmetic on cited toolData) — an accounting claim, not a counterfactual
      // saving, so it stays at the accounting tier and needs no experiment.
      claimClass: 'accounting',
      proofTier: 'accounting',
      detail,
      action:
        'Capture this recurring procedure as a skill (e.g. via /write-a-skill or skill-creator) so future sessions invoke one learned procedure instead of re-entering the steps ad-hoc.',
      affected: n,
      evidence: [
        `procedure: ${seqLabel}`,
        `recurred in ${n} sessions: ${sessionIds.slice(0, 5).join(', ')}${n > 5 ? ', …' : ''}`,
        // Finding :540 — lead a row with a session id (short form) so per-project
        // rec filtering (`recommendationProjects`, which indexes each row's first
        // token) can attribute and reach this finding under `?project=...`.
        `${short(sessionIds[0])} ran this ${stepCount}-step procedure (1 of ${n} recurring sessions)`,
      ],
      view: 'tools',
      provenance: {
        observations,
        inference:
          'A multi-step sequence that recurs across sessions with no covering skill repeats the same setup each time; capturing it as procedural memory (a skill) could reduce that repeat setup. This is a measured recurrence — the tool logs show the sequence ran, not that its steps were worked out afresh each time (they may be pasted, from shell history, or habit).',
        asOf,
        ...(stale ? { stale: true } : {}),
      },
      // NON-validated fix: the skill body is user-specific, so the scaffold is an
      // example to adapt, never a copy-paste-safe command (fixKind 'illustrative').
      fix: {
        target: 'command',
        label: 'Scaffold a skill for this procedure',
        note: 'Adapt this scaffold (name it, describe when to run it, prune the steps) and commit it under ~/.claude/skills/. skill-creator can generate a richer skill from the same steps.',
        fixKind: 'illustrative',
        snippet:
          `# Example scaffold — adapt the name/description/steps, then commit the skill.\n` +
          `mkdir -p ~/.claude/skills/<your-skill-name>\n` +
          `cat > ~/.claude/skills/<your-skill-name>/SKILL.md <<'SKILL'\n` +
          `---\n` +
          `name: <your-skill-name>\n` +
          `description: <when Claude should run this procedure>\n` +
          `---\n` +
          `# <procedure title>\n` +
          `Run these steps in order:\n` +
          `${stepBullets}\n` +
          `SKILL`,
      },
    };
  },
};
