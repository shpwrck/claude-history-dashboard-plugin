import { describe, it, expect } from 'vitest';
import { detector } from './procedural-memory';
import type { RecommendationInput } from '../types';
import type { ToolCall, ToolUsageData } from '../../parse-tools';
import type { LiveResource } from '../../../types';
import { validateRecommendationProvenance } from '../provenance';
import { effectiveFixKind, validateFixSnippet } from '../fix-validity';
import { buildSessionProjectIndex, recommendationProjects } from '../../recommendations';

const NOW = Date.parse('2026-07-09T00:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
/** parse-tools caps `commandPreview` at this length (MAX_COMMAND_PREVIEW_LEN). */
const PREVIEW_CAP = 200;

// COMPLETED-and-SUCCEEDED Bash call (isError === false) — the only kind that
// continues a procedure run under the :277 rule. Interrupted (`isError:null`) and
// failed (`isError:true`) variants are constructed inline where a test needs them.
const bashCall = (command: string, timestamp = 't'): ToolCall => ({
  timestamp,
  toolName: 'Bash',
  input: { command },
  toolUseId: 'u',
  isError: false,
  resultBytes: 0,
});

/** A completed Bash call whose raw body has been stripped (bulk/server dataset) —
 *  only the compact `commandPreview` (and, on real data, the exact
 *  `commandFingerprint`) survives. */
const previewCall = (preview: string, timestamp = 't', fingerprint?: string): ToolCall => ({
  timestamp,
  toolName: 'Bash',
  input: {},
  toolUseId: 'u',
  isError: false,
  resultBytes: 0,
  commandPreview: preview,
  ...(fingerprint ? { commandFingerprint: fingerprint } : {}),
});

/** A non-Bash tool call — must BREAK a procedure run. */
const readCall = (): ToolCall => ({
  timestamp: 't',
  toolName: 'Read',
  input: { file_path: '/repo/x.ts' },
  toolUseId: 'u',
  isError: null,
  resultBytes: 0,
});

const session = (sessionId: string, commands: string[], timestamp = 't'): ToolUsageData => ({
  sessionId,
  calls: commands.map((c) => bashCall(c, timestamp)),
});

const rawSession = (sessionId: string, calls: ToolCall[]): ToolUsageData => ({ sessionId, calls });

const skill = (id: string, description?: string): LiveResource => ({
  id,
  scope: 'user',
  path: `~/.claude/skills/${id}`,
  ...(description ? { description } : {}),
});

/** A PROJECT-scoped skill (reachable only from `projectPath`) — finding :345. */
const projectSkill = (id: string, projectPath: string, description?: string): LiveResource => ({
  id,
  scope: 'project',
  projectPath,
  path: `${projectPath}/.claude/skills/${id}`,
  ...(description ? { description } : {}),
});

/** Minimal Session carrying just the sessionId → project mapping the detector reads. */
const sessMeta = (sessionId: string, project: string): RecommendationInput['sessions'][number] =>
  ({ sessionId, project }) as unknown as RecommendationInput['sessions'][number];

/** Minimal token record carrying the sessionId → project mapping — the fallback
 *  the detector reads for automation/sdk-* sessions with no history Session row. */
const tokenMeta = (sessionId: string, project: string): RecommendationInput['tokenData'][number] =>
  ({ sessionId, project }) as unknown as RecommendationInput['tokenData'][number];

type BundledPlugin = { id: string; bundled?: { skills?: string[] } };

const liveConfigWith = (
  skills: LiveResource[],
  plugins: BundledPlugin[] = []
): RecommendationInput['liveConfig'] =>
  ({
    settings: {},
    settingsHealth: null,
    claudeMd: { global: null, perProject: {} },
    plugins,
    mcpServers: [],
    skills,
    subagents: [],
    commands: [],
  }) as unknown as RecommendationInput['liveConfig'];

const input = (over: Partial<RecommendationInput> = {}): RecommendationInput => {
  const merged: RecommendationInput = {
    tokenData: [],
    toolData: [],
    sessions: [],
    projects: [],
    permissionRows: [],
    apiErrors: [],
    liveConfig: liveConfigWith([]), // present but empty → firing path unless overridden
    ...over,
  };
  // The detector now buckets UNRESOLVED-project sessions UNIQUELY (no project ⇒ no
  // recurrence). Unless a test supplies its OWN `sessions`/`tokenData` project
  // mapping, put every toolData session in ONE shared project so procedures can
  // aggregate — matching every pre-round-7 test's intent.
  if (over.sessions === undefined && over.tokenData === undefined && merged.toolData.length > 0) {
    merged.sessions = merged.toolData.map((t) => sessMeta(t.sessionId, '/repo/default'));
  }
  return merged;
};

const PROC = ['git pull', 'npm run build', 'docker push app:latest'];

describe('workflow.procedural-memory (#2250)', () => {
  it('fires with cited provenance when a 3-step procedure recurs across 3 sessions', () => {
    const rec = detector.rule(
      input({
        toolData: [session('a', PROC), session('b', PROC), session('c', PROC)],
      }),
      NOW
    );
    expect(rec?.id).toBe('workflow.procedural-memory');
    expect(rec?.category).toBe('workflow');
    expect(rec?.affected).toBe(3);
    // Evidence names the full sequence (target kept) and the recurring sessions.
    expect(rec?.evidence?.[0]).toBe(
      'procedure: git pull → npm run build → docker push app:latest'
    );
    expect(rec?.evidence?.[1]).toContain('a');
    // Provenance is well-formed and cites the recurrence count + the real field.
    expect(validateRecommendationProvenance(rec!)).toEqual([]);
    expect(rec?.provenance?.observations[0].value).toBe(3);
    expect(rec?.provenance?.observations[0].source).toBe('parse-tools');
    expect(rec?.provenance?.observations[0].field).toContain('input.command');
    expect(rec?.provenance?.observations[1].value).toBe(0); // 0 skills checked
    expect(rec?.provenance?.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Fresh recurrence → present tense, not "as of".
    expect(rec?.provenance?.stale).toBeUndefined();
    expect(rec?.detail).not.toContain('As of');
    // Accounting posture, not a causal saving.
    expect(rec?.claimClass).toBe('accounting');
    expect(rec?.proofTier).toBe('accounting');
  });

  // ── Finding 1: require liveConfig before claiming "no backing skill" ─────────
  it('stays DARK when liveConfig is absent (cannot claim absence of a skill)', () => {
    const rec = detector.rule(
      {
        ...input({ toolData: [session('a', PROC), session('b', PROC), session('c', PROC)] }),
        liveConfig: null,
      },
      NOW
    );
    expect(rec).toBeNull();
  });

  it('stays silent below the recurrence threshold (only 2 sessions)', () => {
    const rec = detector.rule(
      input({ toolData: [session('a', PROC), session('b', PROC)] }),
      NOW
    );
    expect(rec).toBeNull();
  });

  it('stays silent for a one-off (single session)', () => {
    const rec = detector.rule(input({ toolData: [session('a', PROC)] }), NOW);
    expect(rec).toBeNull();
  });

  it('suppresses when an installed skill already covers the procedure', () => {
    const rec = detector.rule(
      input({
        toolData: [session('a', PROC), session('b', PROC), session('c', PROC)],
        liveConfig: liveConfigWith([
          skill('deploy', 'Pull latest, run build, and push the docker image'),
        ]),
      }),
      NOW
    );
    expect(rec).toBeNull();
  });

  it('does not fire for a single repeated command (that is repeated-commands, not a procedure)', () => {
    const repeated = ['npm run build', 'npm run build', 'npm run build'];
    const rec = detector.rule(
      input({
        toolData: [session('a', repeated), session('b', repeated), session('c', repeated)],
      }),
      NOW
    );
    expect(rec).toBeNull();
  });

  it('demotes stale recurrences to "as of <date>" instead of present tense', () => {
    const old = NOW - 60 * DAY;
    const oldIso = new Date(old).toISOString();
    const oldDate = oldIso.slice(0, 10);
    const rec = detector.rule(
      input({
        toolData: [
          session('a', PROC, oldIso),
          session('b', PROC, oldIso),
          session('c', PROC, oldIso),
        ],
      }),
      NOW
    );
    expect(rec?.detail).toContain(`As of ${oldDate}`);
    expect(rec?.provenance?.stale).toBe(true);
    expect(rec?.provenance?.asOf).toBe(oldDate);
    expect(validateRecommendationProvenance(rec!)).toEqual([]);
  });

  it('emits a non-validated (illustrative) skill-scaffold fix', () => {
    const rec = detector.rule(
      input({ toolData: [session('a', PROC), session('b', PROC), session('c', PROC)] }),
      NOW
    );
    expect(rec?.fix?.target).toBe('command');
    expect(effectiveFixKind(rec!.fix!)).toBe('illustrative');
    // The scaffold echoes the real steps and stays portable (no host path / CLI).
    expect(rec?.fix?.snippet).toContain('npm run build');
    expect(rec?.fix?.snippet).toContain('docker push app:latest');
    expect(validateFixSnippet(rec!.fix!)).toEqual([]);
  });

  // ── Finding 2: provenance cites the ACTUAL command field used ────────────────
  it('cites commandPreview in provenance when raw command bodies are stripped', () => {
    // Real stripped data carries the precomputed fingerprint alongside the preview
    // (a fingerprint-less preview can't back an exact recurrence — see :373 below),
    // so give each command a stable fingerprint that recurs across sessions.
    const previewSession = (id: string): ToolUsageData => ({
      sessionId: id,
      calls: PROC.map((c) => previewCall(c, 't', `fp-${c}`)),
    });
    const rec = detector.rule(
      input({ toolData: [previewSession('a'), previewSession('b'), previewSession('c')] }),
      NOW
    );
    expect(rec?.id).toBe('workflow.procedural-memory');
    expect(rec?.provenance?.observations[0].field).toContain('commandPreview');
    expect(rec?.provenance?.observations[0].field).not.toContain('input.command');
  });

  // ── Round-4 finding (:83): a leading `-C <dir>` value is a DISTINGUISHING
  // target — the match key keeps it, so distinct dirs do NOT merge. (This
  // replaces the round-3 test that collapsed `git -C /repo pull` → `git pull`;
  // the intent — the sub-command `pull` is still correctly surfaced, never the
  // dir — is preserved by the same-dir case below.)
  it('does NOT merge distinct `-C <dir>` targets into one recurring procedure', () => {
    const inDir = (dir: string) => [`git -C ${dir} pull`, 'npm run build', 'docker push app:latest'];
    const rec = detector.rule(
      input({
        toolData: [session('a', inDir('api')), session('b', inDir('web')), session('c', inDir('db'))],
      }),
      NOW
    );
    // Three different working dirs → three distinct procedures, each seen once.
    expect(rec).toBeNull();
  });

  it('keeps the sub-command AND the `-C` dir in the label when the same dir recurs', () => {
    const proc = ['git -C api pull', 'npm run build', 'docker push app:latest'];
    const rec = detector.rule(
      input({ toolData: [session('a', proc), session('b', proc), session('c', proc)] }),
      NOW
    );
    expect(rec?.id).toBe('workflow.procedural-memory');
    // `pull` is not mistaken for the `-C` value, and the dir survives the label.
    expect(rec?.evidence?.[0]).toContain('git api pull');
  });

  // ── Round-4 finding (:83): a leading `--context <ctx>` target distinguishes ──
  it('does NOT merge distinct `--context` targets (prod vs stage vs dev)', () => {
    const withCtx = (ctx: string) => ['git pull', 'npm run build', `kubectl --context ${ctx} apply`];
    const rec = detector.rule(
      input({
        toolData: [session('a', withCtx('prod')), session('b', withCtx('stage')), session('c', withCtx('dev'))],
      }),
      NOW
    );
    expect(rec).toBeNull();
  });

  // ── Round-4 finding (:140): an inline `--flag=value` target distinguishes ────
  it('does NOT merge distinct inline `--flag=value` targets', () => {
    const withFile = (f: string) => ['git pull', 'npm run build', `kubectl apply --filename=${f}`];
    const rec = detector.rule(
      input({
        toolData: [session('a', withFile('prod.yaml')), session('b', withFile('stage.yaml')), session('c', withFile('dev.yaml'))],
      }),
      NOW
    );
    expect(rec).toBeNull();
  });

  // ── Round-4 finding (:107): a leading `cd <dir>` anchor distinguishes ────────
  it('does NOT merge steps anchored to distinct `cd <dir>` directories', () => {
    const inDir = (d: string) => [`cd ${d} && git pull`, `cd ${d} && npm ci`, `cd ${d} && npm test`];
    const rec = detector.rule(
      input({
        toolData: [session('a', inDir('api')), session('b', inDir('web')), session('c', inDir('db'))],
      }),
      NOW
    );
    // Same three verbs, but each session anchored to a different dir → three
    // distinct procedures, each seen once.
    expect(rec).toBeNull();
  });

  it('fires when the same `cd <dir>` anchor recurs (control for the anchor case)', () => {
    const inApi = ['cd api && git pull', 'cd api && npm ci', 'cd api && npm test'];
    const rec = detector.rule(
      input({ toolData: [session('a', inApi), session('b', inApi), session('c', inApi)] }),
      NOW
    );
    expect(rec?.id).toBe('workflow.procedural-memory');
  });

  // ── Round-4 finding (:97): the match key keeps FULL args past the 40-char cap ─
  it('does NOT merge push targets that differ only past the 40-char display cap', () => {
    const long = (tag: string) =>
      `docker push registry.example.com/team/service-with-a-very-long-image-name:${tag}`;
    const proc = (tag: string) => ['git pull', 'npm run build', long(tag)];
    const rec = detector.rule(
      input({
        toolData: [session('a', proc('alpha')), session('b', proc('bravo')), session('c', proc('charlie'))],
      }),
      NOW
    );
    // The differing tag sits past the 40-char label cap, so the DISPLAY label is
    // identical for all three — but the match key keeps the full arg, so these are
    // three distinct procedures, each seen once (no false recurrence).
    expect(rec).toBeNull();
  });

  // ── Finding 4: grow to the MAXIMAL recurring sequence, not fixed 3-grams ─────
  it('reports the full 4-step procedure, not a truncated 3-gram', () => {
    const proc4 = ['git pull', 'npm ci', 'npm test', 'docker push app:latest'];
    const rec = detector.rule(
      input({
        toolData: [session('a', proc4), session('b', proc4), session('c', proc4)],
      }),
      NOW
    );
    expect(rec?.detail).toContain('4-step');
    expect(rec?.detail).toContain('git pull → npm ci → npm test → docker push app:latest');
    // The scaffold must include every step so it can't omit a required one.
    for (const step of proc4) expect(rec?.fix?.snippet).toContain(step);
  });

  // ── Finding 5: keep target args so distinct procedures don't over-collapse ───
  it('does not merge distinct push targets into one recurring procedure', () => {
    const withTarget = (target: string) => ['git pull', 'npm run build', `docker push ${target}`];
    const rec = detector.rule(
      input({
        toolData: [
          session('a', withTarget('app:a')),
          session('b', withTarget('app:b')),
          session('c', withTarget('app:c')),
        ],
      }),
      NOW
    );
    // Three DIFFERENT procedures (distinct targets), each seen once → no recurrence.
    expect(rec).toBeNull();
  });

  // ── Finding 6: an intervening non-Bash call breaks contiguity ────────────────
  it('does not treat steps split by non-Bash work as one contiguous procedure', () => {
    const split = (id: string) =>
      rawSession(id, [
        bashCall('git pull'),
        bashCall('npm run build'),
        readCall(), // breaks the run
        bashCall('docker push app:latest'),
      ]);
    const rec = detector.rule(
      input({ toolData: [split('a'), split('b'), split('c')] }),
      NOW
    );
    // No contiguous 3-step run exists → the procedure claim would be false.
    expect(rec).toBeNull();
  });

  it('still fires when the same steps ARE contiguous (control for finding 6)', () => {
    const rec = detector.rule(
      input({ toolData: [session('a', PROC), session('b', PROC), session('c', PROC)] }),
      NOW
    );
    expect(rec?.id).toBe('workflow.procedural-memory');
  });

  // ── Re-review finding 1: keep post-verb option TARGETS; don't over-collapse ──
  it('keeps a post-verb `-f <target>` so distinct deploys do not merge', () => {
    const withFile = (file: string) => ['git pull', 'npm run build', `kubectl apply -f ${file}`];
    // 2 sessions deploy prod overlay, 1 deploys stage. Under the old (buggy)
    // behavior all three collapsed to `kubectl apply` → false 3-session recurrence.
    const rec = detector.rule(
      input({
        toolData: [
          session('a', withFile('overlays/prod.yaml')),
          session('b', withFile('overlays/prod.yaml')),
          session('c', withFile('overlays/stage.yaml')),
        ],
      }),
      NOW
    );
    expect(rec).toBeNull();
  });

  it('preserves the -f target in the emitted label when the deploy DOES recur', () => {
    const proc = ['git pull', 'npm run build', 'kubectl apply -f overlays/prod.yaml'];
    const rec = detector.rule(
      input({ toolData: [session('a', proc), session('b', proc), session('c', proc)] }),
      NOW
    );
    expect(rec?.evidence?.[0]).toContain('kubectl apply overlays/prod.yaml');
  });

  // ── Re-review finding 2: a CAPPED preview is not exact evidence ──────────────
  it('does not assert an exact recurrence from a truncated (capped) preview', () => {
    // A 210-char preview (>= the 200-char parse-tools cap) is truncated: its tail
    // could differ. Sitting mid-run, it must break contiguity rather than be
    // asserted as an exact step. Under the old behavior it was used verbatim →
    // three sessions collapsed to one false 3-step procedure.
    const capped = `docker push registry.example.com/team/${'x'.repeat(200)}:prod`.slice(0, 210);
    const split = (id: string) =>
      rawSession(id, [bashCall('git pull'), previewCall(capped), bashCall('docker push app:latest')]);
    const rec = detector.rule(
      input({ toolData: [split('a'), split('b'), split('c')] }),
      NOW
    );
    expect(rec).toBeNull();
  });

  // ── Re-review finding 3: plugin-bundled skills count as coverage ─────────────
  it('suppresses when an ENABLED plugin bundles a covering skill', () => {
    const rec = detector.rule(
      input({
        toolData: [session('a', PROC), session('b', PROC), session('c', PROC)],
        liveConfig: liveConfigWith([], [
          { id: 'deploy-plugin@registry', bundled: { skills: ['pull-build-push'] } },
        ]),
      }),
      NOW
    );
    // The bundled `pull-build-push` skill shares the pull/build/push verbs → covered.
    expect(rec).toBeNull();
  });

  it('still fires when the plugin bundles only UNRELATED skills', () => {
    const rec = detector.rule(
      input({
        toolData: [session('a', PROC), session('b', PROC), session('c', PROC)],
        liveConfig: liveConfigWith([], [
          { id: 'lint-plugin@registry', bundled: { skills: ['format-lint'] } },
        ]),
      }),
      NOW
    );
    expect(rec?.id).toBe('workflow.procedural-memory');
  });

  // ── Finding 5: a higher-support subprocedure survives a rarer supersequence ──
  // (This replaces the round-3 test that let a rare 4-step flow suppress a common
  // 3-step subprocedure — the over-suppression regression. Test 233 above remains
  // the counter-case: when the subwindow has NO independent recurrence (equal
  // session sets), the longer maximal sequence still wins.)
  it('keeps a 5-session subprocedure over a 3-session supersequence (support preserved)', () => {
    const proc4 = ['git pull', 'npm ci', 'npm test', 'docker push app:latest'];
    const prefix3 = proc4.slice(0, 3); // git pull → npm ci → npm test
    const rec = detector.rule(
      input({
        toolData: [
          session('a', proc4),
          session('b', proc4),
          session('c', proc4),
          session('d', prefix3), // ran only the first three steps
          session('e', prefix3), // ran only the first three steps
        ],
      }),
      NOW
    );
    // prefix3 recurs in 5 sessions (a-e); the 4-step flow only in 3 (a-c). The
    // subprocedure has independent recurrence (d,e are NOT covered by the 4-step's
    // session set), so it must NOT be suppressed — the higher-support procedure
    // wins, and its scaffold does not fabricate the rare final step.
    expect(rec?.detail).toContain('3-step');
    expect(rec?.detail).toContain('git pull → npm ci → npm test');
    expect(rec?.detail).not.toContain('docker push');
    expect(rec?.affected).toBe(5);
    for (const step of prefix3) expect(rec?.fix?.snippet).toContain(step);
    expect(rec?.fix?.snippet).not.toContain('docker push');
  });

  // ── Findings 3/6/8: provenance/claim accuracy (auditable-claims contract) ────
  it('states the ACTUAL verb-overlap threshold in the coverage observation (finding :407)', () => {
    const rec = detector.rule(
      input({ toolData: [session('a', PROC), session('b', PROC), session('c', PROC)] }),
      NOW
    );
    const cov = rec?.provenance?.observations[1];
    // The claim must describe the ">= N action verbs" threshold the suppression
    // check actually uses — not overstate "shares none of its action verbs".
    expect(cov?.claim).toMatch(/>=\s*\d+\b.*action verb/);
    expect(cov?.claim).not.toMatch(/none share|share no/i);
    // Cite the fields coveringSkill actually reads (skill id + DESCRIPTION tokens).
    expect(cov?.field).toContain('description');
    expect(validateRecommendationProvenance(rec!)).toEqual([]);
  });

  it('frames the finding as measured recurrence, not re-derivation (finding :395)', () => {
    // Fresh and stale wording must both avoid asserting the steps were re-planned
    // / re-derived each run — the logs only prove RECURRENCE.
    const fresh = detector.rule(
      input({ toolData: [session('a', PROC), session('b', PROC), session('c', PROC)] }),
      NOW
    );
    const oldIso = new Date(NOW - 60 * DAY).toISOString();
    const staleRec = detector.rule(
      input({ toolData: [session('a', PROC, oldIso), session('b', PROC, oldIso), session('c', PROC, oldIso)] }),
      NOW
    );
    for (const rec of [fresh, staleRec]) {
      const prose = [rec?.detail, rec?.provenance?.inference, rec?.action].join(' ').toLowerCase();
      expect(prose).not.toMatch(/re-?plan|re-?deriv|re-?reason|from scratch/);
      // It still frames the skill as REDUCING repeat setup off the measured recurrence.
      expect(prose).toMatch(/recur/);
      expect(prose).toMatch(/repeat setup/);
    }
  });

  it('embeds the FULL session-id list in provenance for procedures seen in > 5 sessions (finding :399)', () => {
    const ids = ['s1', 's2', 's3', 's4', 's5', 's6', 's7'];
    const rec = detector.rule(input({ toolData: ids.map((id) => session(id, PROC)) }), NOW);
    expect(rec?.affected).toBe(7);
    // The human evidence row may truncate to 5 (+ ellipsis); a structured
    // observation must carry EVERY session id so the count is reproducible.
    expect(rec?.evidence?.[1]).toContain('…');
    const full = rec?.provenance?.observations.find(
      (o) => typeof o.value === 'string' && o.value.includes('s7')
    );
    expect(full).toBeDefined();
    for (const id of ids) expect(String(full?.value)).toContain(id);
    expect(validateRecommendationProvenance(rec!)).toEqual([]);
  });

  // ── Round-5 findings: match key must be near-lossless (safe = don't collapse) ──
  it('does NOT merge commands that differ only by a bare flag (finding :195)', () => {
    // `git push origin main`, `git push --force origin main`, and
    // `git push --dry-run origin main` are DIFFERENT commands. Under the old key
    // (bare flags dropped) all three collapsed to one false 3-session recurrence.
    const withPush = (flag: string) => ['git pull', 'npm run build', `git push ${flag}origin main`];
    const rec = detector.rule(
      input({
        toolData: [session('a', withPush('')), session('b', withPush('--force ')), session('c', withPush('--dry-run '))],
      }),
      NOW
    );
    expect(rec).toBeNull();
  });

  it('does NOT merge commands that differ only by an env assignment (finding :155)', () => {
    const withEnv = (env: string) => ['git pull', `${env}npm run build`, 'docker push app:latest'];
    const rec = detector.rule(
      input({
        toolData: [
          session('a', withEnv('NODE_ENV=production ')),
          session('b', withEnv('NODE_ENV=staging ')),
          session('c', withEnv('CI=1 ')),
        ],
      }),
      NOW
    );
    // Distinct env → distinct commands → distinct procedures, each seen once.
    expect(rec).toBeNull();
  });

  it('does NOT merge distinct script PATHS that share a basename (finding :105)', () => {
    const withScript = (dir: string) => ['git pull', 'npm run build', `scripts/${dir}/deploy.sh build push`];
    const rec = detector.rule(
      input({
        toolData: [session('a', withScript('prod')), session('b', withScript('stage')), session('c', withScript('dev'))],
      }),
      NOW
    );
    // basename collapses `deploy.sh`, but the full path distinguishes them.
    expect(rec).toBeNull();
  });

  it('runs coverage on UNCAPPED steps so a long target cannot hide the verb (finding :445)', () => {
    // The action verb `deploy` is the 4th token of step 1 — past the 4-part
    // DISPLAY cap, so the capped label drops it. The installed `deployer` skill
    // shares `install` + `deploy`; only when coverage sees the UNCAPPED verb
    // `deploy` does the overlap reach the threshold and suppress the (false)
    // "no backing skill" finding.
    const proc = ['kubectl t1 t2 t3 deploy', 'helm install foo1', 'systemctl restart svc1'];
    const rec = detector.rule(
      input({
        toolData: [session('a', proc), session('b', proc), session('c', proc)],
        liveConfig: liveConfigWith([skill('deployer', 'install and deploy the service')]),
      }),
      NOW
    );
    expect(rec).toBeNull();
  });

  it('treats an at-cap-length (200) preview as INEXACT (truncated) so it breaks the run (finding :248)', () => {
    // parse-tools slices the preview to exactly 200 when the raw command is
    // longer, so a 200-char preview may have a missing tail and cannot back an
    // exact-sequence claim. Sitting mid-run, it must break contiguity.
    const prefix = 'docker push ';
    const atCap = prefix + 'x'.repeat(PREVIEW_CAP - prefix.length);
    expect(atCap.length).toBe(PREVIEW_CAP);
    const run = (id: string) =>
      rawSession(id, [previewCall('git pull'), previewCall(atCap), previewCall('npm run build')]);
    const rec = detector.rule(input({ toolData: [run('a'), run('b'), run('c')] }), NOW);
    // The capped preview breaks the run → no contiguous 3-step procedure → null.
    expect(rec).toBeNull();
  });

  it('leads an evidence row with a session id so project filtering can reach the rec (finding :540)', () => {
    const rec = detector.rule(
      input({ toolData: [session('sess-alpha', PROC), session('sess-beta', PROC), session('sess-gamma', PROC)] }),
      NOW
    );
    // recommendationProjects indexes the FIRST token of each evidence row against
    // short(sessionId); at least one row must lead with a session id.
    const index = buildSessionProjectIndex([
      { sessionId: 'sess-alpha', project: '/repo/alpha' },
      { sessionId: 'sess-beta', project: '/repo/beta' },
      { sessionId: 'sess-gamma', project: '/repo/gamma' },
    ]);
    expect(recommendationProjects(rec!, index)).toContain('/repo/alpha');
  });

  it('breaks the run on a FAILED Bash call so a repeatedly-failed command is not captured (finding :269)', () => {
    const failCall = (command: string): ToolCall => ({ ...bashCall(command), isError: true });
    const run = (id: string) =>
      rawSession(id, [
        bashCall('git pull'),
        failCall('npm run build'), // failed → breaks contiguity
        bashCall('docker push app:latest'),
      ]);
    const rec = detector.rule(input({ toolData: [run('a'), run('b'), run('c')] }), NOW);
    // No contiguous 3-step run of SUCCEEDED calls exists → nothing to capture.
    expect(rec).toBeNull();
  });

  // ── Round-6 conservative scope-down: clean, same-project, completed evidence ──
  it('does NOT merge the SAME procedure across DIFFERENT projects (finding :417)', () => {
    // Three identical relative-command runs, but each session is in a different
    // repo. That is three project-specific procedures, not one recurrence.
    const rec = detector.rule(
      input({
        toolData: [session('a', PROC), session('b', PROC), session('c', PROC)],
        sessions: [sessMeta('a', '/repo/one'), sessMeta('b', '/repo/two'), sessMeta('c', '/repo/three')],
      }),
      NOW
    );
    expect(rec).toBeNull();
  });

  it('DOES merge the same procedure within ONE project (control for :417)', () => {
    const rec = detector.rule(
      input({
        toolData: [session('a', PROC), session('b', PROC), session('c', PROC)],
        sessions: [sessMeta('a', '/repo/one'), sessMeta('b', '/repo/one'), sessMeta('c', '/repo/one')],
      }),
      NOW
    );
    expect(rec?.affected).toBe(3);
  });

  it('a project-scoped skill in ANOTHER project does not suppress (finding :345)', () => {
    const sessions = [sessMeta('a', '/repo/a'), sessMeta('b', '/repo/a'), sessMeta('c', '/repo/a')];
    const desc = 'Pull latest, run build, and push the docker image';
    // Skill scoped to /repo/b must NOT cover a procedure whose sessions are /repo/a.
    const wrongProject = detector.rule(
      input({
        toolData: [session('a', PROC), session('b', PROC), session('c', PROC)],
        sessions,
        liveConfig: liveConfigWith([projectSkill('deploy', '/repo/b', desc)]),
      }),
      NOW
    );
    expect(wrongProject?.id).toBe('workflow.procedural-memory'); // fires — not suppressed
    // The SAME skill scoped to /repo/a IS reachable → covers → suppressed.
    const rightProject = detector.rule(
      input({
        toolData: [session('a', PROC), session('b', PROC), session('c', PROC)],
        sessions,
        liveConfig: liveConfigWith([projectSkill('deploy', '/repo/a', desc)]),
      }),
      NOW
    );
    expect(rightProject).toBeNull();
  });

  it('attributes the single-project procedure via a session id in that project (finding :569)', () => {
    const sessions = [
      sessMeta('sess-alpha', '/repo/alpha'),
      sessMeta('sess-beta', '/repo/alpha'),
      sessMeta('sess-gamma', '/repo/alpha'),
    ];
    const rec = detector.rule(
      input({
        toolData: [session('sess-alpha', PROC), session('sess-beta', PROC), session('sess-gamma', PROC)],
        sessions,
      }),
      NOW
    );
    const index = buildSessionProjectIndex(sessions.map((s) => ({ sessionId: s.sessionId, project: s.project })));
    // All sessions share the project, so the session-id evidence row resolves to it.
    expect(recommendationProjects(rec!, index)).toEqual(['/repo/alpha']);
  });

  it('breaks the run on an INTERRUPTED (isError:null) call — not a proven step (finding :277)', () => {
    const interrupted = (command: string): ToolCall => ({ ...bashCall(command), isError: null });
    const run = (id: string) =>
      rawSession(id, [
        bashCall('git pull'),
        interrupted('npm run build'), // still-running / no tool_result → breaks
        bashCall('docker push app:latest'),
      ]);
    const rec = detector.rule(input({ toolData: [run('a'), run('b'), run('c')] }), NOW);
    expect(rec).toBeNull();
  });

  it('preserves quoted whitespace in the match key so distinct commands do not merge (finding :161)', () => {
    // Whitespace INSIDE quotes is data. A naive collapse would fold all three into
    // `python -c 'print("a b")'` and manufacture a 3-session recurrence.
    const withGaps = (gaps: number) => ['git pull', `python -c 'print("a${' '.repeat(gaps)}b")'`, 'npm run build'];
    const rec = detector.rule(
      input({ toolData: [session('a', withGaps(2)), session('b', withGaps(3)), session('c', withGaps(4))] }),
      NOW
    );
    expect(rec).toBeNull();
  });

  it('scaffolds the EXACT recurring command, not the shortened display label (finding :547)', () => {
    const proc = ['git pull', 'npm run build', 'git push --force origin main'];
    const rec = detector.rule(
      input({ toolData: [session('a', proc), session('b', proc), session('c', proc)] }),
      NOW
    );
    expect(rec?.id).toBe('workflow.procedural-memory');
    // Human evidence uses the shortened label (bare flag dropped)…
    expect(rec?.evidence?.[0]).toContain('git push origin main');
    // …but the SCAFFOLD carries the exact command so the user runs the right thing.
    expect(rec?.fix?.snippet).toContain('git push --force origin main');
  });

  it('uses the binary as a coverage verb for single-token commands so a skill can cover (finding :320)', () => {
    // `make`/`pytest`/`lint` have no sub-command token; without the binary-as-verb
    // rule they yield no verbs, coverage is skipped, and a covering skill is missed.
    const proc = ['make', 'pytest', 'lint'];
    const rec = detector.rule(
      input({
        toolData: [session('a', proc), session('b', proc), session('c', proc)],
        liveConfig: liveConfigWith([skill('ci-runner', 'run make pytest and lint checks')]),
      }),
      NOW
    );
    expect(rec).toBeNull();
  });

  // ── Round-7: resolve project from tokenData; never cross-merge unresolved ─────
  it('does NOT merge automation sessions (project only on tokenData) across repos (finding :547)', () => {
    // sdk-* sessions carry `project` on tokenData, not on a history Session row.
    const rec = detector.rule(
      input({
        toolData: [session('a', PROC), session('b', PROC), session('c', PROC)],
        sessions: [], // no history rows (automation)
        tokenData: [tokenMeta('a', '/repo/one'), tokenMeta('b', '/repo/two'), tokenMeta('c', '/repo/three')],
      }),
      NOW
    );
    expect(rec).toBeNull();
  });

  it('DOES merge automation sessions sharing a tokenData project (control for :547)', () => {
    const rec = detector.rule(
      input({
        toolData: [session('a', PROC), session('b', PROC), session('c', PROC)],
        sessions: [],
        tokenData: [tokenMeta('a', '/repo/one'), tokenMeta('b', '/repo/one'), tokenMeta('c', '/repo/one')],
      }),
      NOW
    );
    expect(rec?.affected).toBe(3);
  });

  it('gives each UNRESOLVED-project session a unique bucket so they never merge (finding :547)', () => {
    // No sessions AND no tokenData project mapping → every session unresolved.
    const rec = detector.rule(
      input({
        toolData: [session('a', PROC), session('b', PROC), session('c', PROC)],
        sessions: [], // explicit empty → helper does NOT synthesize a shared project
      }),
      NOW
    );
    expect(rec).toBeNull();
  });

  // ── Round-7: the auditable claim shows the EXACT command, not the label ───────
  it('builds the detail + provenance claim from the exact command, not the display label (finding :590)', () => {
    const proc = ['git pull', 'npm run build', 'git push --force origin main'];
    const rec = detector.rule(
      input({ toolData: [session('a', proc), session('b', proc), session('c', proc)] }),
      NOW
    );
    // The auditable claim/detail must not hide `--force` behind the shortened label.
    expect(rec?.detail).toContain('git push --force origin main');
    expect(rec?.provenance?.observations[0].claim).toContain('git push --force origin main');
    // Human evidence rows may still use the shortened label.
    expect(rec?.evidence?.[0]).toContain('git push origin main');
  });

  // ── Round-7: don't assert exactness from a lossy preview ──────────────────────
  it('uses the exact fingerprint (not the flattened preview) so multi-line commands do not merge (finding :296)', () => {
    // Three DIFFERENT multi-line commands that all FLATTEN to the same preview
    // text but have distinct fingerprints must not merge into one recurrence.
    const flat = 'bash -c cat <<EOF hello EOF'; // same flattened preview for all three
    const step2 = (fp: string) => previewCall(flat, 't', fp);
    // The bracketing steps carry a stable fingerprint (required for a preview step
    // to be usable, :373) so the 3-step run stays intact — the distinct MIDDLE
    // fingerprint is what must keep the sessions from merging.
    const run = (id: string, fp: string) =>
      rawSession(id, [
        previewCall('git pull', 't', 'fp-pull'),
        step2(fp),
        previewCall('npm run build', 't', 'fp-build'),
      ]);
    const rec = detector.rule(
      input({ toolData: [run('a', 'fp-a'), run('b', 'fp-b'), run('c', 'fp-c')] }),
      NOW
    );
    // Distinct fingerprints → distinct identities → each seen once → no recurrence.
    expect(rec).toBeNull();
  });

  it('softens the claim wording when the command text is preview-sourced (finding :296)', () => {
    // Same command in 3 sessions (same preview + same fingerprint) → recurs, but
    // the shown text is a preview, so the claim/detail must flag it as approximate.
    const run = (id: string) =>
      rawSession(id, [
        previewCall('git pull', 't', 'fp1'),
        previewCall('npm run build', 't', 'fp2'),
        previewCall('docker push app:latest', 't', 'fp3'),
      ]);
    const rec = detector.rule(input({ toolData: [run('a'), run('b'), run('c')] }), NOW);
    expect(rec?.id).toBe('workflow.procedural-memory');
    expect(rec?.detail?.toLowerCase()).toContain('preview');
    expect(rec?.detail?.toLowerCase()).toContain('approximate');
    expect(rec?.provenance?.observations[0].claim.toLowerCase()).toContain('preview');
    // The cited field reflects that the exact match came from the fingerprint.
    expect(rec?.provenance?.observations[0].field).toContain('commandFingerprint');
  });

  // ── Round-7: shared tokenizer matches script basenames / hyphenated verbs ─────
  it('suppresses a script-command procedure via a covering skill (basename/hyphen) (finding :374)', () => {
    // `./deploy.sh` must match a `deploy` skill, and `type-check` must match
    // `type`+`check` — both sides run through the same tokenizer.
    const proc = ['./deploy.sh', 'type-check', 'git status'];
    const rec = detector.rule(
      input({
        toolData: [session('a', proc), session('b', proc), session('c', proc)],
        liveConfig: liveConfigWith([skill('deploy-typecheck', 'deploy and type-check the project')]),
      }),
      NOW
    );
    expect(rec).toBeNull();
  });

  it('still fires when the script-command skill is UNRELATED (control for :374)', () => {
    const proc = ['./deploy.sh', 'type-check', 'git status'];
    const rec = detector.rule(
      input({
        toolData: [session('a', proc), session('b', proc), session('c', proc)],
        liveConfig: liveConfigWith([skill('lint-format', 'lint and format the code')]),
      }),
      NOW
    );
    expect(rec?.id).toBe('workflow.procedural-memory');
  });

  // ── Round-8 finding (:373): a fingerprint-less preview breaks the run ──────────
  it('breaks the run on a preview step with NO fingerprint (no exact identity to group on) (finding :373)', () => {
    // A stripped preview is lossy; without the precomputed fingerprint it cannot
    // back an exact recurrence, so a fingerprint-less preview step must break
    // contiguity — grouping on the flattened preview alone would cross-merge
    // distinct raw commands and then falsely cite a fingerprint-backed match.
    const run = (id: string) =>
      rawSession(id, [
        previewCall('git pull', 't', 'fp-pull'),
        previewCall('npm run build', 't'), // NO fingerprint → breaks the run
        previewCall('docker push app:latest', 't', 'fp-push'),
      ]);
    const rec = detector.rule(input({ toolData: [run('a'), run('b'), run('c')] }), NOW);
    // The fingerprint-less middle step splits the run → no contiguous 3-step procedure.
    expect(rec).toBeNull();
  });

  // ── Round-8 finding (:440): npm-script procedures aren't suppressed on `run` ───
  it('does NOT let a generic "run" skill suppress an npm-script procedure (finding :440)', () => {
    // `npm run build:prod` etc.: the SCRIPT NAME carries the real action (`build`),
    // not the generic `run` keyword. An unrelated skill named `run` shares only the
    // dropped `run` token, so it must NOT suppress this genuinely-uncaptured procedure.
    const proc = ['npm run build:prod', 'npm run test:e2e', 'npm run deploy:prod'];
    const rec = detector.rule(
      input({
        toolData: [session('a', proc), session('b', proc), session('c', proc)],
        liveConfig: liveConfigWith([skill('run', 'Launch and drive this project app')]),
      }),
      NOW
    );
    expect(rec?.id).toBe('workflow.procedural-memory'); // fires — not falsely suppressed
  });

  it('uses the npm-script NAME as a coverage verb so a real skill still suppresses (finding :440)', () => {
    // Flip side: the script name's action tokens (build/test/deploy) ARE the
    // procedure's verbs, so a skill covering build+test+deploy legitimately suppresses.
    const proc = ['npm run build:prod', 'npm run test:e2e', 'npm run deploy:prod'];
    const rec = detector.rule(
      input({
        toolData: [session('a', proc), session('b', proc), session('c', proc)],
        liveConfig: liveConfigWith([skill('pipeline', 'build test and deploy the project')]),
      }),
      NOW
    );
    expect(rec).toBeNull(); // covered by the build/test/deploy skill
  });
});
