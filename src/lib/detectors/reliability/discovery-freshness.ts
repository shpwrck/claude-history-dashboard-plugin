import type {
  Detector,
  Recommendation,
  RecObservation,
  RecProvenance,
  AppliedMarkers,
} from '../types';
import { claudeMdMarksApplied, basename, splitSegments } from '../shared';
import type { ToolCall, ToolUsageData } from '../../parse-tools';
import type { RepoMapDataset } from '../../parse-repo-map-join';

/**
 * `reliability.discovery-freshness` (#2325, epic #1868).
 *
 * The FILE-READ sibling of `reliability.stale-state-assertion` (#1871). Where
 * #1871 owns the git-ref-QUERY flavor — reading `origin/master`/`master` from a
 * local tree with no prior `git fetch` — this detector owns the distinct
 * file-READ flavor: the agent `Read` a source file, the file then changed (a
 * repo-map `mtimeMs` falls inside the read-to-edit interval) OR the working tree
 * moved under it, and the agent went on to `Edit`/`Write` that same file WITHOUT
 * re-reading it. This is the recurring pain behind the
 * `fetch-before-checking-master` / `gh-api-edits-fetch-from-master` memory notes,
 * on the FILE side rather than the git-query side.
 *
 * Honest-signal note (auditability, epic #866). New repo-map artifacts carry a
 * host-captured per-file `mtimeMs`. A direct finding requires that timestamp to
 * be strictly newer than the Read and no later than the acting Edit/Write; merely
 * being newer than the Read is insufficient because the edit itself (or a later
 * change) may have produced the current mtime. The concrete observed proxy — an
 * intervening working-tree-mutating git command — remains alongside it because a
 * later snapshot mtime cannot disprove an earlier change.
 * Both paths are deliberately stricter than plain read-then-edit, the normal
 * editing flow. Emitted as a HYPOTHESIS
 * (`claimClass:'causal'` held at `proofTier:'observational'`), never a proven miss.
 *
 * Boundary with #1871 (never double-counts). The COUNTED unit here is a
 * (`Read`, `Edit`/`Write`) file-tool pair; #1871's counted unit is a `Bash` git
 * read command. A single `ToolCall` has one `toolName`, so the two flagged sets
 * are disjoint. This detector inspects `Bash` commands ONLY to recognise an
 * intervening tree-move as CONTEXT — it never counts a `Bash` command as a
 * finding (that stays #1871's territory).
 *
 * Substrate gate. Returns null when `repoMap` is absent/null or carries neither
 * a usable per-file mtime nor a non-null project generation sha.
 * Reads `toolData` (file + Bash calls), `repoMap` (tracked-path oracle +
 * generation sha), and `liveConfig` (self-suppression). Dark on a dataset with
 * no tool calls or no repo-map.
 */

const MIN_STALE_READS = 3; // noise floor — never fire on one or two (matches #1871)
const HIGH_PER_SESSION = 4; // a session this repetitive escalates info → warning
const MAX_EVIDENCE = 5;
const FRESHNESS_DAYS = 28; // flagged activity older than this → demote to "as of <date>"
const DAY_MS = 24 * 60 * 60 * 1000;

const READ_TOOLS = new Set(['Read']);
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

// A git subcommand at a segment head (after optional sudo / env-assignment
// prefixes). Group 1 captures any run of GLOBAL options (`-C <dir>`, `-c x=y`,
// `--work-tree=…`, …) that may precede the subcommand (#2335); group 2 is the
// subcommand; group 3 the rest. Working-tree-MUTATING forms move HEAD and/or
// rewrite tracked file content, so a file read BEFORE one and edited AFTER it —
// with no re-read — was acted on against pre-move content. `restore` is the
// modern `git checkout -- <path>`.
const GIT_MOVE_HEAD_RE =
  /^(?:sudo\s+|\w+=\S+\s+)*git\s+((?:-C\s+(?:"[^"]+"|'[^']+'|\S+)\s+|-c\s+\S+\s+|--[\w-]+=\S+\s+|--[\w-]+\s+|-\w\s+)*)(checkout|switch|restore|pull|merge|rebase|reset|cherry-pick|revert|stash)\b(.*)$/i;

// Read-only or index-only variants that do NOT rewrite tracked working-tree
// content, so they must NOT advance the freshness epoch (Codex #2335):
//  - `git stash list`/`show`/`drop`/`clear`/`create` (inspect/manage, no tree change);
//  - `git reset` without `--hard`/`--merge`/`--keep` (bare/`--soft`/`--mixed` leave the tree);
//  - `git restore --staged` without `--worktree` (touches the index only);
//  - `git checkout -b <name>` / `git switch -c <name>` with NO start-point ref
//    (creates a branch at HEAD, files unchanged).
// `git fetch`/`log`/`show`/`status`/`diff` never head-match (not in the verb set),
// and remote-ref reads are #1871's concern.
function isWorkingTreeMutator(sub: string, rest: string): boolean {
  const s = sub.toLowerCase();
  if (s === 'stash') return !/^\s*(?:list|show|drop|clear|create)\b/.test(rest);
  if (s === 'reset') return /(?:^|\s)(?:--hard|--merge|--keep)\b/.test(rest);
  if (s === 'restore')
    return !(/(?:^|\s)--staged\b/.test(rest) && !/(?:^|\s)--worktree\b/.test(rest));
  if (s === 'checkout' || s === 'switch') {
    const bc = rest.match(/(?:^|\s)-[bBcC]\s+\S+(.*)$/);
    // branch-create: a tree-move only if a start-point positional (not a flag) follows the new name
    if (bc) return /\S/.test(bc[1].replace(/(?:^|\s)-\S+/g, '').trim());
  }
  return true; // checkout/switch (branch switch), pull / merge / rebase / cherry-pick / revert
}

const MARKERS: AppliedMarkers = {
  headings: [/^##\s+Read freshness\b/i],
  bodyPhrases: ['re-read the target after the ref moves before acting'],
};

const SHA_SHORT = 12;

/**
 * The command text for a Bash call: full `input.command` on the SPA/upload
 * dataset, else the redacted 200-char `commandPreview` on the server dataset.
 * KNOWN LIMITATION (#2335): on the server dataset a tree-move verb sitting beyond
 * the 200-char preview (e.g. after a long heredoc/setup) is invisible, so that
 * chain is missed — an under-firing (safe) gap that needs an ingest change to
 * preserve git-move segments before stripping (tracked with #2334). `null` for a
 * non-Bash call or one with no command text either way.
 */
function bashText(call: ToolCall): string | null {
  if (call.toolName !== 'Bash') return null;
  const full = call.input?.command;
  if (typeof full === 'string' && full.length > 0) return full;
  const preview = call.commandPreview;
  if (typeof preview === 'string' && preview.length > 0) return preview;
  return null;
}

/**
 * The explicit `-C <dir>` targets of every working-tree-mutating git op in a
 * command. Quote- and heredoc-aware via the shared `splitSegments`, so a
 * `git checkout` inside a quoted commit message (`git commit -m "…; git checkout
 * main"`) stays inside its segment and never head-matches (Codex #2335). `null`
 * in the result means a cwd-relative op whose target repo can't be told from the
 * command text.
 */
const CD_SEG_RE = /^cd\s+("[^"]+"|'[^']+'|\S+)\s*$/;
function treeMoveTargets(command: string): (string | null)[] {
  const targets: (string | null)[] = [];
  let cdDir: string | null = null; // a leading `cd <dir>` anchors later ops in the same command (#2335)
  for (const seg of splitSegments(command)) {
    const cd = seg.match(CD_SEG_RE);
    if (cd) {
      cdDir = cd[1].replace(/^["']|["']$/g, '');
      continue;
    }
    const m = seg.match(GIT_MOVE_HEAD_RE);
    if (!m) continue;
    if (!isWorkingTreeMutator(m[2], m[3] ?? '')) continue;
    const cm = (m[1] ?? '').match(/-C\s+("[^"]+"|'[^']+'|\S+)/);
    const dashC = cm ? cm[1].replace(/^["']|["']$/g, '') : null;
    targets.push(dashC ?? cdDir); // explicit -C wins; else the cd anchor; else cwd-relative (null)
  }
  return targets;
}

function getFilePath(call: ToolCall): string | null {
  const fp = call.input?.file_path;
  return typeof fp === 'string' && fp.length > 0 ? fp : null;
}

function normalizeSlashes(path: string): string {
  return path.replace(/\\/g, '/');
}

/** Repo-relative form of `path` if it sits under `root`, else null (strict). */
function repoRelativeUnder(path: string, root: string): string | null {
  const p = normalizeSlashes(path);
  const r = normalizeSlashes(root).replace(/\/+$/, '');
  if (p === r) return '';
  if (p.startsWith(`${r}/`)) return p.slice(r.length + 1);
  return null;
}

interface ProjectAnchor {
  root: string;
  sha: string | null;
  files: Map<string, number | undefined>;
}

/**
 * Projects with a generation sha (tree-mover proxy) or a usable per-file
 * mtime (direct signal). A read only counts when it maps to one of these.
 */
function projectAnchors(repoMap: RepoMapDataset): ProjectAnchor[] {
  const anchors: ProjectAnchor[] = [];
  for (const project of repoMap.projects) {
    const sha =
      typeof project.generatedAtGitSha === 'string' && project.generatedAtGitSha.length > 0
        ? project.generatedAtGitSha
        : null;
    const files = new Map(
      project.files.map((file) => [
        file.path,
        typeof file.mtimeMs === 'number' && Number.isFinite(file.mtimeMs) && file.mtimeMs >= 0
          ? file.mtimeMs
          : undefined,
      ] as const)
    );
    if (sha === null && ![...files.values()].some((mtimeMs) => mtimeMs !== undefined)) continue;
    anchors.push({
      root: project.root,
      sha,
      files,
    });
  }
  return anchors;
}

/** Project freshness fields for a read of `filePath`, when it maps to a tracked file. */
function anchorFor(
  filePath: string,
  anchors: ProjectAnchor[]
): { root: string; sha: string | null; mtimeMs?: number } | null {
  // A raw repo-relative tool path (rare — Read/Edit normally record absolute
  // paths) falls back to a direct membership check against the map's repo-relative
  // keys, so those sessions aren't silently under-counted (#2335).
  const relKey = normalizeSlashes(filePath).replace(/^\.\//, '');
  let best: { root: string; sha: string | null; mtimeMs?: number } | null = null;
  let bestLen = -1;
  for (const a of anchors) {
    const rel = repoRelativeUnder(filePath, a.root);
    const key = rel !== null ? rel : relKey;
    if (!a.files.has(key)) continue;
    // prefer the NEAREST (longest) containing root when maps nest (/repo, /repo/sub)
    const len = rel !== null ? normalizeSlashes(a.root).replace(/\/+$/, '').length : 0;
    if (len > bestLen) {
      const mtimeMs = a.files.get(key);
      best = { root: a.root, sha: a.sha, ...(mtimeMs !== undefined ? { mtimeMs } : {}) };
      bestLen = len;
    }
  }
  return best;
}

/** The nearest project root a `git -C <dir>` op targets, when <dir> sits in a known project. */
function rootForDir(dir: string, anchors: ProjectAnchor[]): string | null {
  const d = normalizeSlashes(dir).replace(/\/+$/, '');
  let best: string | null = null;
  let bestLen = -1;
  for (const a of anchors) {
    const r = normalizeSlashes(a.root).replace(/\/+$/, '');
    // longest containing root wins, so `-C /repo/sub` bumps /repo/sub, not /repo (#2335)
    if ((d === r || d.startsWith(`${r}/`) || r.startsWith(`${d}/`)) && r.length > bestLen) {
      best = a.root;
      bestLen = r.length;
    }
  }
  return best;
}

/** Ascending-by-timestamp, stable on equal/undatable timestamps (original order). */
function chronological(calls: ToolCall[]): ToolCall[] {
  return calls
    .map((c, i) => ({ c, i, t: Date.parse(c.timestamp) }))
    .sort((a, b) => {
      const at = Number.isFinite(a.t) ? a.t : Number.POSITIVE_INFINITY;
      const bt = Number.isFinite(b.t) ? b.t : Number.POSITIVE_INFINITY;
      return at - bt || a.i - b.i;
    })
    .map((x) => x.c);
}

interface StaleRead {
  sessionId: string;
  path: string;
  sha: string | null;
  signal: 'mtime' | 'tree-move';
  mtimeMs?: number;
  /** ms of the acting Edit/Write — the moment the stale content was applied. */
  actedMs: number;
}

/**
 * Walk one session in chronological order and collect stale-read acts: a `Read`
 * of a tracked path, direct mtime or tree-mover evidence that it went stale,
 * then an `Edit`/`Write` of the same path with no re-`Read` in between.
 */
function collectSessionStale(
  session: ToolUsageData,
  anchors: ProjectAnchor[]
): StaleRead[] {
  // Assumes transcript timestamps are present (they always are in ~/.claude, per
  // parse-tools). An undatable intervening tree-move would sort last via
  // chronological() and be missed — an under-firing (safe) failure, not a false
  // positive.
  const out: StaleRead[] = [];
  // Per-project-root move epochs — a tree-move in one checkout must NOT
  // invalidate reads under a DIFFERENT project (Codex #2335): `git -C /repoB pull`
  // bumps only /repoB's epoch. A cwd-relative op (no `-C`) can't be attributed to
  // a root, so it conservatively bumps every known root.
  const epochByRoot = new Map<string, number>();
  const epochOf = (root: string) => epochByRoot.get(root) ?? 0;
  const bump = (root: string) => epochByRoot.set(root, epochOf(root) + 1);
  // A pending read waiting to be acted on. The read timestamp brackets the
  // direct mtime test; the epoch preserves the tree-mover proxy.
  const pending = new Map<
    string,
    { root: string; epoch: number; sha: string | null; mtimeMs?: number; readMs: number }
  >();

  for (const call of chronological(session.calls)) {
    if (READ_TOOLS.has(call.toolName)) {
      const path = getFilePath(call);
      if (!path) continue;
      const anchor = anchorFor(path, anchors);
      if (anchor === null) continue; // not a repo-mapped tracked file
      // (re-)read refreshes the path to its project's current epoch
      const readMs = Date.parse(call.timestamp);
      pending.set(path, {
        root: anchor.root,
        epoch: epochOf(anchor.root),
        sha: anchor.sha,
        ...(anchor.mtimeMs !== undefined ? { mtimeMs: anchor.mtimeMs } : {}),
        readMs: Number.isFinite(readMs) ? readMs : Number.NaN,
      });
      continue;
    }

    const cmd = bashText(call);
    if (cmd !== null) {
      for (const dir of treeMoveTargets(cmd)) {
        if (dir === null) {
          for (const a of anchors) bump(a.root); // cwd-relative → bump every root
        } else {
          const root = rootForDir(dir, anchors);
          if (root) bump(root); // an explicit -C to an untracked repo affects no tracked read
        }
      }
      continue;
    }

    if (EDIT_TOOLS.has(call.toolName)) {
      const path = getFilePath(call);
      if (!path) continue;
      const p = pending.get(path);
      if (!p) continue;
      const actedMs = Date.parse(call.timestamp);
      const directMtime =
        p.mtimeMs !== undefined &&
        Number.isFinite(p.readMs) &&
        Number.isFinite(actedMs) &&
        p.mtimeMs > p.readMs &&
        p.mtimeMs < actedMs;
      // A current snapshot mtime outside this interval cannot disprove an
      // earlier observed tree move, so retain the existing proxy independently.
      const treeMoved = p.sha !== null && p.epoch < epochOf(p.root);
      if (directMtime || treeMoved) {
        out.push({
          sessionId: session.sessionId,
          path,
          sha: p.sha,
          signal: directMtime ? 'mtime' : 'tree-move',
          ...(directMtime ? { mtimeMs: p.mtimeMs } : {}),
          actedMs: Number.isFinite(actedMs) ? actedMs : Number.NaN,
        });
      }
      pending.delete(path); // consume — one stale chain per read, no double count
    }
  }

  return out;
}

export const detector: Detector = {
  id: 'reliability.discovery-freshness',
  category: 'reliability',
  dataDeps: ['toolData', 'repoMap', 'liveConfig'],
  appliedMarkers: MARKERS,
  rule(input, now): Recommendation | null {
    if (claudeMdMarksApplied(input.liveConfig, MARKERS)) return null;

    const toolData = input.toolData;
    if (!toolData || toolData.length === 0) return null;

    const repoMap = input.repoMap;
    if (!repoMap || repoMap.projects.length === 0) return null;
    const anchors = projectAnchors(repoMap);
    if (anchors.length === 0) return null; // no mtime and no generation sha

    const stale: StaleRead[] = [];
    for (const session of toolData) stale.push(...collectSessionStale(session, anchors));

    if (stale.length < MIN_STALE_READS) return null;

    const totalStale = stale.length;
    const sessionsAffected = new Set(stale.map((s) => s.sessionId)).size;

    const perSessionCount = new Map<string, number>();
    for (const s of stale) perSessionCount.set(s.sessionId, (perSessionCount.get(s.sessionId) ?? 0) + 1);
    const maxPerSession = Math.max(...perSessionCount.values());

    // asOf = the date of the most recent stale ACT (the observation the claim
    // rests on), not a fabricated map-generation date. stale=true when that is
    // older than the freshness window → the finding is historical, so present-
    // tense wording is demoted to "As of <date>, …".
    const actedTimes = stale.map((s) => s.actedMs).filter((t) => Number.isFinite(t));
    const latestActMs = actedTimes.length > 0 ? Math.max(...actedTimes) : Number.NaN;
    const asOf = Number.isFinite(latestActMs)
      ? new Date(latestActMs).toISOString().slice(0, 10)
      : undefined;
    const isStale = asOf !== undefined && now - latestActMs > FRESHNESS_DAYS * DAY_MS;

    // Historical findings never escalate to warning — stale data should not
    // drive urgent action, so the demotion pins severity to info.
    const severity: Recommendation['severity'] = isStale
      ? 'info'
      : maxPerSession >= HIGH_PER_SESSION
        ? 'warning'
        : 'info';

    const directCount = stale.filter((s) => s.signal === 'mtime').length;
    const treeMoveCount = totalStale - directCount;
    const shaShort = stale.find((s) => s.sha !== null)?.sha?.slice(0, SHA_SHORT);

    const evidence = [...stale]
      .slice(0, MAX_EVIDENCE)
      .map((s) =>
        s.signal === 'mtime'
          ? `${s.sessionId.slice(0, 8)}: read \`${basename(s.path)}\`, its repo-map mtime advanced inside the read-to-edit interval (${Math.round(s.mtimeMs as number)} ms), then it was edited without re-reading`
          : `${s.sessionId.slice(0, 8)}: read \`${basename(s.path)}\`, then a git checkout/pull/rebase moved the tree, then edited it without re-reading (repo-map @ ${(s.sha as string).slice(0, SHA_SHORT)})`
      );

    const observations: RecObservation[] = [
      {
        claim: `${totalStale} file read(s) across ${sessionsAffected} session(s) had freshness evidence before an Edit/Write of the SAME path with no intervening re-Read`,
        source: 'parse-tools',
        field: 'toolData[].calls[] (Read.timestamp / input.file_path; Edit/Write.timestamp)',
        value: totalStale,
      },
    ];
    if (directCount > 0) {
      observations.push({
        claim: `${directCount} read(s) had a host-captured per-file mtime strictly after the Read timestamp and before the acting Edit/Write`,
        source: 'parse-repo-map-join',
        field: 'repoMap.projects[].files[].mtimeMs',
        value: directCount,
      });
    }
    if (treeMoveCount > 0) {
      observations.push({
        claim: `${treeMoveCount} read(s) had the tree-mover proxy: an observed working-tree-moving git command occurred before the Edit/Write`,
        source: 'parse-tools',
        field: 'toolData[].calls[] (Bash input.command / commandPreview)',
        value: treeMoveCount,
      });
    }
    if (shaShort) {
      observations.push({
        claim: `Reads are scoped to repo-map-tracked files; a repo-map generation sha is ${shaShort}`,
        source: 'parse-repo-map-join',
        field: 'repoMap.projects[].generatedAtGitSha / files[].path',
        value: shaShort,
      });
    }

    const provenance: RecProvenance = {
      observations,
      inference:
        'A per-file mtime inside the read-to-edit interval is direct metadata evidence that the file changed after the read; an intervening working-tree-moving git op remains an observed proxy when the snapshot mtime is absent or inconclusive. Editing without re-reading may therefore have acted on stale content, but the downstream error is not proven, so this remains an observational hypothesis.',
      ...(asOf ? { asOf } : {}),
      ...(asOf ? { stale: isStale } : {}),
    };

    const lead = isStale ? `As of ${asOf}, ` : '';
    const signalSummary = [
      directCount > 0
        ? `${directCount} had a repo-map file mtime after the Read and before the Edit/Write`
        : null,
      treeMoveCount > 0
        ? `${treeMoveCount} had the observed tree-mover proxy`
        : null,
    ]
      .filter((part): part is string => part !== null)
      .join('; ');
    const fallbackOnly = directCount === 0;

    return {
      id: 'reliability.discovery-freshness',
      category: 'reliability',
      severity,
      title: isStale
        ? 'Files were edited after freshness signals (historical)'
        : 'Files edited after freshness signals',
      detail: fallbackOnly
        ? `${lead}${totalStale} file read(s) across ${sessionsAffected} session(s) were followed by a working-tree-moving git command ` +
          `(checkout/switch/restore/pull/merge/rebase/reset/cherry-pick/revert/stash) and then an Edit/Write of the same file with no re-Read in ` +
          `between, so the edit may have been applied against content the ref moved past. Anchored on the repo-map snapshot @ ${shaShort}; ` +
          `git-ref reads (origin/master with no fetch) are the sibling reliability.stale-state-assertion's concern, not this one.`
        : `${lead}${totalStale} file read(s) across ${sessionsAffected} session(s) were edited without a re-Read after freshness evidence appeared: ${signalSummary}. ` +
          `The edit may therefore have acted on stale content; git-ref reads (origin/master with no fetch) remain reliability.stale-state-assertion's concern.`,
      action: fallbackOnly
        ? 're-read the target after the ref moved (a git checkout, pull, rebase, merge, or reset) before acting on it, rather than editing from a read taken before the move.'
        : 're-read the target after its file metadata or working tree changes before acting on it, rather than editing from the earlier read.',
      affected: totalStale,
      view: 'tools',
      evidence,
      provenance,
      claimClass: 'causal',
      proofTier: 'observational',
      fix: {
        target: 'CLAUDE.md',
        label: 'Add a re-read-after-ref-move rule',
        note: 'Append to your project or global CLAUDE.md so every session re-reads a file after the tree moves before editing it.',
        snippet:
          `## Read freshness\n\n` +
          `After a \`git checkout\`, \`pull\`, \`rebase\`, \`merge\`, or \`reset\` moves the working tree, ` +
          `re-read the target after the ref moves before acting: a file you read BEFORE the move and ` +
          `edit AFTER it — without re-reading — is edited against content the ref moved past, which lands ` +
          `stale changes. Re-read the file (or diff it) once the tree has moved, then edit.`,
        fixKind: 'illustrative',
        appliedMarkers: MARKERS,
      },
    };
  },
};
