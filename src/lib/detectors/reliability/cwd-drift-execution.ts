import type {
  Detector,
  Recommendation,
  RecObservation,
  AppliedMarkers,
  RecommendationInput,
} from '../types';
import { claudeMdMarksApplied, hasPreToolUseAnchorGuard, truncate } from '../shared';
import type { ToolCall, ToolUsageData } from '../../parse-tools';

/**
 * `reliability.cwd-drift-execution` (#1870).
 *
 * Signature: a Bash command whose segment INVOKES a repo-resolving family
 * (`git`/`gh`) WITHOUT an explicit anchor — no `git -C <dir>`, no
 * `gh -R owner/repo` / `--repo`, no `GH_REPO=` env prefix, and no preceding
 * `cd <dir> &&` in the same compound command. `git`/`gh` infer their target REPO
 * from the shell's cwd, so when that cwd has drifted *outside the project tree*
 * (a recurring failure on remote/resumed sessions) an unanchored op SILENTLY
 * hits the WRONG repository — committing to the wrong tree, or reading stale
 * state that becomes a false "merged / landed / verified" claim. This is the
 * recurring pain behind AGENTS.md "Never rely on the ambient shell cwd" and the
 * `main-checkout-shared-by-concurrent-sessions` / `bash-cwd-cd-prefix-stripped`
 * memory notes, which the global `cwd-anchor-guard.mjs` PreToolUse hook now
 * *blocks* (committed to `shpwrck/claude`). This detector *measures* the
 * underlying agent behaviour so the guard's impact is visible in the engine (the
 * dogfooding loop, alongside the sibling stale-state detector #1871).
 *
 * Scoping is deliberate and auditable — it mirrors the guard's two-policy split:
 *  - Only `git`/`gh` (REPO-RESOLVING families) are flagged. A drifted cwd makes
 *    them target the wrong repo *silently*, so the guard hard-enforces an anchor
 *    on every one, and so does this detector.
 *  - BUILD families (`npm npx pnpm yarn vite vitest podman`) are EXCLUDED. They
 *    fail loudly in the wrong tree rather than hitting a silent wrong repo, and
 *    whether a bare `npm run build` actually drifted depends on the shell's real
 *    cwd, which is NOT on the wire (the distilled toolData carries only the
 *    command text). Flagging every un-`cd`'d `npm`/`vite` would be noise, since
 *    running them from the (correct) project cwd is the normal case.
 *  - A segment is "anchored" by a per-op flag (`git -C`, `gh -R`/`--repo`,
 *    `GH_REPO=`) or by a `cd <dir>` earlier in the SAME compound command — the
 *    `cd` carries forward exactly as the shell (and the guard) treats it.
 *
 * Segmentation is quote- and heredoc-aware (ported from the guard): the command
 * is split on `&&`/`||`/`;`/`|`/newline, but delimiters inside quotes don't
 * split and heredoc bodies are dropped — so a commit message or PR body that
 * merely *mentions* `git push` is data, not a flagged command.
 *
 * Reads each Bash call's command text via the canonical `input.command ??
 * commandPreview` fallback (parse-tools): the SPA/upload dataset keeps the full
 * `input.command`, while the server dataset strips raw bodies and ships a
 * 200-char `commandPreview` instead — the anchor (`git -C`, a leading `cd <dir>
 * &&`, `gh -R`/`--repo`, `GH_REPO=`) always sits at the command head, so the
 * preview is sufficient to tell anchored from unanchored. Dark on a dataset with
 * no Bash tool calls.
 */

const MIN_UNANCHORED = 3; // noise floor — never fire on one or two
const HIGH_PER_SESSION = 10; // a session this unanchored escalates info → warning
const MAX_EVIDENCE = 5;

// A gated command at the START of a segment, after optional sudo / env-assignment
// prefixes. Capture group 1 = the family name. Mirrors the guard's GATED_RE but
// scoped to the repo-resolving families this detector flags.
const GATED_RE = /^(?:sudo\s+|\w+=\S+\s+)*(git|gh)\b/;
// `cd <dir>` as a whole segment — anchors later ops in the same compound command.
const CD_RE = /^cd\s+(?:"[^"]+"|'[^']+'|\S+)\s*$/;
// `git -C <dir>` right after the verb — an explicit per-op anchor.
const GIT_DASH_C_RE = /^(?:sudo\s+|\w+=\S+\s+)*git\s+(?:-C\s+\S)/;
// `gh ... -R owner/repo` / `--repo owner/repo` — repo is explicit, not cwd-derived.
const GH_REPO_FLAG_RE = /\s(?:-R|--repo)(?:=|\s)/;
// A `GH_REPO=owner/repo` env prefix pins gh's repo independent of cwd.
const LEADING_ENV_RE = /^(?:sudo\s+|\w+=\S+\s+)*/;
const GH_REPO_ENV_RE = /\bGH_REPO=/;

// The engine's own canned snippet (the `fix.snippet` below). `appliedMarkers`
// keys the fix to this exact wording, so the Adoption loop can recognise its own
// paste-in.
const MARKERS: AppliedMarkers = {
  headings: [/^##\s+Anchor (?:repo|git)\b/i],
  bodyPhrases: ['silently targets the wrong repository'],
};

// A semantically-equivalent USER-AUTHORED anchoring rule with different
// heading/wording also counts as "applied" (#2013). A real example is AGENTS.md
// `## Worktrees & Branches` carrying "Never rely on the ambient shell cwd —
// anchor EVERY git and gh command … an unanchored command may silently read or
// write the WRONG repository". Implemented CONSERVATIVELY — biased toward NOT
// suppressing a real finding — by requiring an anchoring-intent heading AND the
// co-occurrence of an "anchor" phrase AND a "wrong repository" phrase
// (case-insensitive). All three must match before suppression fires, so a
// passing mention of the word "anchor" alone never hides the finding.
const EQUIVALENT_MARKERS: AppliedMarkers = {
  headings: [
    /^#{1,6}\s+.*\b(?:anchor\w*|worktree\w*|cwd|working dir\w*|shell cwd)\b/i,
  ],
  bodyPhrases: ['anchor', 'wrong repository'],
};

/**
 * The detector's CLAUDE.md/AGENTS.md fix is "already applied" when EITHER the
 * engine's canned snippet OR a semantically-equivalent user-authored anchoring
 * rule is present. `claudeMdMarksApplied` is strict-AND within one marker set
 * (heading AND all phrases), so two independent strict-AND checks OR'd together
 * keep each set tight while broadening coverage.
 */
function anchoringRuleApplied(liveConfig: RecommendationInput['liveConfig']): boolean {
  return (
    claudeMdMarksApplied(liveConfig, MARKERS) ||
    claudeMdMarksApplied(liveConfig, EQUIVALENT_MARKERS)
  );
}

interface SessionDrift {
  sessionId: string;
  count: number;
  example: string;
}

// ── Quote- and heredoc-aware command splitting (ported from cwd-anchor-guard) ──

const HEREDOC_OPENER_RE = /<<(-?)\s*(['"]?)([A-Za-z_]\w*)\2/g;
/** Drop heredoc BODIES so their text isn't parsed as commands. */
function stripHeredocs(command: string): string {
  const lines = command.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]);
    const openers = [...lines[i].matchAll(HEREDOC_OPENER_RE)].map((m) => ({
      dash: m[1] === '-',
      delim: m[3],
    }));
    if (!openers.length) continue;
    let j = i + 1;
    for (const op of openers) {
      while (j < lines.length) {
        const term = op.dash ? lines[j].replace(/^\t+/, '') : lines[j];
        j++;
        if (term === op.delim) break;
      }
    }
    i = j - 1;
  }
  return out.join('\n');
}

const SEGMENT_DELIMS = new Set([';', '|', '\n']);
/** Split a command into top-level segments, ignoring delimiters inside quotes. */
function splitSegments(command: string): string[] {
  const src = stripHeredocs(command);
  const segs: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === '\\' && quote === '"' && i + 1 < src.length) {
        cur += c + src[++i];
        continue;
      }
      cur += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      cur += c;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === '&&' || two === '||') {
      segs.push(cur);
      cur = '';
      i++;
      continue;
    }
    if (SEGMENT_DELIMS.has(c)) {
      segs.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  segs.push(cur);
  return segs.map((s) => s.trim()).filter(Boolean);
}

function leadingEnv(seg: string): string {
  const m = seg.match(LEADING_ENV_RE);
  return m ? m[0] : '';
}

/**
 * The command text for a Bash call. Full `input.command` on the SPA/upload
 * dataset; the redacted 200-char `commandPreview` on the server dataset (raw
 * bodies stripped). The anchor always sits at the command head, so the preview
 * suffices. `null` for a non-Bash call or one with no command text either way.
 */
function bashText(call: ToolCall): string | null {
  if (call.toolName !== 'Bash') return null;
  const full = call.input?.command;
  if (typeof full === 'string' && full.length > 0) return full;
  const preview = call.commandPreview;
  if (typeof preview === 'string' && preview.length > 0) return preview;
  return null;
}

/** Count unanchored git/gh ops in one command string. */
function countUnanchored(command: string): { count: number; firstExample: string | null } {
  let count = 0;
  let firstExample: string | null = null;
  let sawCd = false; // a `cd` earlier in this compound command anchors later ops
  for (const seg of splitSegments(command)) {
    if (CD_RE.test(seg)) {
      sawCd = true;
      continue;
    }
    const gm = seg.match(GATED_RE);
    if (!gm) continue;
    const family = gm[1];

    let anchored = sawCd;
    if (family === 'git' && GIT_DASH_C_RE.test(seg)) anchored = true;
    else if (
      family === 'gh' &&
      (GH_REPO_FLAG_RE.test(seg) || GH_REPO_ENV_RE.test(leadingEnv(seg)))
    )
      anchored = true;

    if (anchored) continue;
    count += 1;
    if (firstExample === null) firstExample = seg;
  }
  return { count, firstExample };
}

/** Tally a session's unanchored git/gh ops across all its Bash calls. */
function collectSessionDrift(session: ToolUsageData): SessionDrift | null {
  let sawBash = false;
  let count = 0;
  let example = '';
  for (const call of session.calls) {
    const cmd = bashText(call);
    if (cmd === null) continue;
    sawBash = true;
    const { count: n, firstExample } = countUnanchored(cmd);
    count += n;
    if (!example && firstExample) example = firstExample;
  }
  if (!sawBash) return null;

  return count > 0 ? { sessionId: session.sessionId, count, example } : null;
}

export const detector: Detector = {
  id: 'reliability.cwd-drift-execution',
  category: 'reliability',
  dataDeps: ['toolData', 'liveConfig'],
  appliedMarkers: MARKERS,
  rule(input): Recommendation | null {
    // Suppress when an anchoring rule is already documented — the engine's own
    // canned snippet OR a semantically-equivalent user-authored rule (#2013).
    if (anchoringRuleApplied(input.liveConfig)) return null;

    const toolData = input.toolData;
    if (!toolData || toolData.length === 0) return null;

    const perSession: SessionDrift[] = [];
    for (const session of toolData) {
      const s = collectSessionDrift(session);
      if (s) perSession.push(s);
    }

    const totalUnanchored = perSession.reduce((sum, s) => sum + s.count, 0);
    if (totalUnanchored < MIN_UNANCHORED) return null;

    const sessionsAffected = perSession.length;
    const maxPerSession = perSession.reduce((m, s) => Math.max(m, s.count), 0);

    // Hook-aware historical demotion (#2013, mirroring hook-errors' #1102
    // stale-input demotion). `totalUnanchored` is an all-time cumulative count.
    // When the readable bundle shows a cwd-anchor-guard PreToolUse hook
    // configured now, the behaviour is already blocked going forward — so the
    // finding is HISTORICAL, not a current failure: demote to `info` and rephrase
    // to past tense. `null` liveConfig means "can't tell" → keep the present-tense
    // WARNING (don't hide a real finding). Mirrors hook-errors exactly.
    const configReadable = input.liveConfig != null;
    const guardConfigured = hasPreToolUseAnchorGuard(input.liveConfig?.settings);
    const demote = configReadable && guardConfigured;

    const severity = demote
      ? 'info'
      : maxPerSession >= HIGH_PER_SESSION
        ? 'warning'
        : 'info';

    const evidence = [...perSession]
      .sort((a, b) => b.count - a.count)
      .slice(0, MAX_EVIDENCE)
      .map(
        (s) =>
          `${s.sessionId.slice(0, 8)}: ${s.count} unanchored git/gh command(s) — e.g. \`${truncate(
            s.example,
            70
          )}\``
      );

    const observations: RecObservation[] = [
      {
        claim: `${totalUnanchored} git/gh command(s) across ${sessionsAffected} session(s) ran with no anchor (\`git -C <dir>\`, a preceding \`cd <dir> &&\`, \`gh -R owner/repo\`, or \`GH_REPO=\`)`,
        source: 'parse-tools',
        field: 'toolData[].calls[].input.command ?? commandPreview',
        value: totalUnanchored,
      },
      {
        claim:
          'only git/gh (repo-resolving) ops are counted — build families (npm/npx/vite/vitest/podman) fail loudly in the wrong tree and their drift cannot be judged from command text without the shell cwd, which is not on the wire',
        source: 'parse-tools',
        field: 'toolData[].calls[].input.command ?? commandPreview',
      },
      {
        claim: guardConfigured
          ? 'a cwd-anchor-guard PreToolUse hook is currently configured'
          : configReadable
            ? 'no cwd-anchor-guard PreToolUse hook is currently configured'
            : 'current settings.json could not be read',
        source: 'settings.json',
        field: 'hooks.PreToolUse',
      },
    ];

    return {
      id: 'reliability.cwd-drift-execution',
      category: 'reliability',
      severity,
      title: demote
        ? 'git/gh ran unanchored in the past (cwd-anchor guard configured now)'
        : 'git/gh commands run unanchored to the project directory',
      detail: demote
        ? `${totalUnanchored} \`git\`/\`gh\` command(s) across ${sessionsAffected} session(s) ran with no explicit anchor (no \`git -C <dir>\`, no preceding \`cd <dir> &&\`, no \`gh -R owner/repo\`/\`GH_REPO=\`) across your history. A cwd-anchor-guard PreToolUse hook is now configured and blocks these going forward, so this is historical — an unanchored git/gh op run from a drifted cwd would otherwise silently target the wrong repository (committing to the wrong tree, or reading stale state behind a false "merged/landed/verified" claim).`
        : `${totalUnanchored} \`git\`/\`gh\` command(s) across ${sessionsAffected} session(s) ran with no explicit anchor (no \`git -C <dir>\`, no preceding \`cd <dir> &&\`, no \`gh -R owner/repo\`/\`GH_REPO=\`). git/gh infer their target repo from the shell cwd, so if that cwd has drifted outside the project tree the op silently targets the wrong repository — committing to the wrong tree or reading stale state behind a false "merged/landed/verified" claim. Build families are excluded: they fail loudly in the wrong tree, and their drift can't be judged from command text alone.`,
      action: demote
        ? 'No action needed while the cwd-anchor guard stays configured; it blocks unanchored git/gh going forward. If you remove it, anchor every git/gh command yourself — `git -C <project-dir> …` (or `cd <project-dir> && git …`), and `gh -R owner/repo …` / `GH_REPO=owner/repo gh …`.'
        : 'Anchor every git/gh command to an explicit target the first time — `git -C <project-dir> …` (or `cd <project-dir> && git …`), and `gh -R owner/repo …` / `GH_REPO=owner/repo gh …` — rather than relying on the ambient shell cwd, or rely on the cwd-anchor guard hook to enforce it.',
      affected: totalUnanchored,
      view: 'tools',
      estTimeReclaimedMin: sessionsAffected * 2,
      evidence,
      provenance: {
        observations,
        inference: demote
          ? 'The unanchored-op count is historical and a cwd-anchor-guard PreToolUse hook is configured now, so the behaviour is already blocked going forward — the finding is not current and is demoted to past tense. (An unanchored git/gh op resolves its target repo from the shell cwd, which silently selects the wrong repo on a drifted session.)'
          : 'A git/gh op with no explicit anchor resolves its target repository from the shell cwd; on a session whose cwd has drifted outside the project tree that silently selects the wrong repo, so commits land in the wrong tree and reads feed false merge/landing/verification claims. Anchoring each op (or the cwd-anchor guard) removes the ambient-cwd dependency.',
      },
      fix: {
        target: 'CLAUDE.md',
        label: 'Add a cwd-anchoring rule',
        note: 'Append to your project or global CLAUDE.md so every session anchors git/gh ops instead of trusting the ambient cwd.',
        snippet:
          `## Anchor repo commands to the project directory\n\n` +
          `Never rely on the ambient shell cwd. Anchor every git/gh command to an ` +
          `explicit target the first time: \`git -C <project-dir> …\` (or a preceding ` +
          `\`cd <project-dir> && git …\`), and \`gh -R owner/repo …\` / ` +
          `\`GH_REPO=owner/repo gh …\`. An unanchored git/gh command run from a drifted ` +
          `cwd silently targets the wrong repository — commits land in the wrong tree, ` +
          `and reads feed false "merged / landed / verified" claims.`,
        fixKind: 'validated',
        appliedMarkers: MARKERS,
      },
    };
  },
};
