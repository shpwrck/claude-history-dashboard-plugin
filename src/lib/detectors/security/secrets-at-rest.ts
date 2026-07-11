import type { Detector, RecObservation } from '../types';
import type { EvidenceRef } from '../../evidence';
import { short } from '../shared';

/**
 * security.secrets-at-rest (#2504, epic #2199) — surface secret-shaped values
 * (API keys, tokens, PEM private keys) that sit in PLAINTEXT at rest in
 * `~/.claude` transcripts: the user's own prompts and `tool_result` /
 * `toolUseResult` payloads (a `cat .env`, a pasted authorization header).
 *
 * This is a thin read of the ingest-time signal (`parse-secrets-at-rest.ts`),
 * which ran the shared {@link SECRET_PATTERNS} (same shapes the transcript
 * scrubber redacts) over each session and recorded ONLY per-kind counts +
 * EvidenceRef coordinates. THE MATCHED VALUE IS NEVER STORED, EXPORTED, OR
 * DISPLAYED — this detector likewise emits only counts, kinds, short session
 * ids, and evidence coordinates. It never reconstructs a value.
 *
 * `claimClass:'accounting'`: the claim is an arithmetic MEASUREMENT of what is
 * already on disk ("N secret-shaped values sit in plaintext"), not a
 * counterfactual — so it proves out at the accounting tier with no experiment.
 *
 * Optional/empty `secretsAtRest` (a transcript-free dataset, or a clean
 * history) ⇒ the detector stays dark. It self-suppresses once the user has
 * bounded local retention to the recommended window (or tighter) via
 * `settings.json` `cleanupPeriodDays`.
 */

// How many days we recommend bounding local transcript retention to. The fix
// snippet writes exactly this, and the self-suppression check reads it: once
// `cleanupPeriodDays <= RECOMMENDED_CLEANUP_DAYS` the user has acted, so the
// finding stops nagging (rotation guidance stays in the action prose).
const RECOMMENDED_CLEANUP_DAYS = 7;
// The default Claude Code local-transcript retention window when unset.
const DEFAULT_CLEANUP_DAYS = 30;
// A last-observed date older than this is demoted to "as of <date>" instead of
// present-tense (the #1102 stale-input contract).
const STALE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_EVIDENCE = 5;
const MAX_EVIDENCE_REFS = 10;

// The credential kinds severe enough that a single one at rest reads CRITICAL:
// non-cheaply-revocable cloud/provider keys and PEM private keys. Everything
// else (bearer/github/gitlab/slack tokens) reads a WARNING.
const CRITICAL_KINDS = new Set([
  'private-key',
  'aws-access-key-id',
  'anthropic-key',
  'openai-key',
  'google-api-key',
]);

/** ISO `YYYY-MM-DD` slice of an ISO timestamp, or undefined if unparseable. */
function isoDate(ts: string | undefined): string | undefined {
  if (!ts) return undefined;
  const ms = Date.parse(ts);
  if (!Number.isFinite(ms)) return undefined;
  return new Date(ms).toISOString().slice(0, 10);
}

export const detector: Detector = {
  id: 'security.secrets-at-rest',
  category: 'security',
  dataDeps: ['secretsAtRest', 'liveConfig'],
  rule(input, now) {
    const signals = input.secretsAtRest ?? [];
    if (signals.length === 0) return null;

    // Settings-key self-suppression: the user has already bounded local
    // transcript retention to the recommended window or tighter, so the
    // plaintext copy ages out — stop nagging (rotation is a one-time action,
    // not a recurring config the engine can verify).
    const cleanup = input.liveConfig?.settings?.cleanupPeriodDays;
    if (typeof cleanup === 'number' && cleanup <= RECOMMENDED_CLEANUP_DAYS) {
      return null;
    }

    const countsByKind: Record<string, number> = {};
    const evidenceRefs: EvidenceRef[] = [];
    const evidence: string[] = [];
    let totalCount = 0;
    let flaggedSessions = 0;
    let newestMs = -Infinity;
    let newestIso: string | undefined;

    for (const s of signals) {
      if (!s || s.totalCount <= 0) continue;
      flaggedSessions += 1;
      totalCount += s.totalCount;
      for (const [kind, n] of Object.entries(s.countsByKind ?? {})) {
        if (typeof n === 'number' && n > 0) {
          countsByKind[kind] = (countsByKind[kind] ?? 0) + n;
        }
      }
      if (s.lastObserved) {
        const ms = Date.parse(s.lastObserved);
        if (Number.isFinite(ms) && ms > newestMs) {
          newestMs = ms;
          newestIso = s.lastObserved;
        }
      }
      // Evidence rows and refs carry ONLY counts + kinds + coordinates —
      // never a matched value.
      if (evidence.length < MAX_EVIDENCE) {
        const kinds = Object.keys(s.countsByKind ?? {}).sort().join(', ');
        evidence.push(
          `${short(s.sessionId)}: ${s.totalCount} secret-shaped value(s)` +
            (kinds ? ` [${kinds}]` : '')
        );
      }
      for (const ref of s.evidenceRefs ?? []) {
        if (evidenceRefs.length < MAX_EVIDENCE_REFS) evidenceRefs.push(ref);
      }
    }

    if (totalCount === 0) return null;

    const kinds = Object.keys(countsByKind).sort();
    const kindsStr = kinds.map((k) => `${k} ×${countsByKind[k]}`).join(', ');
    const severity = kinds.some((k) => CRITICAL_KINDS.has(k))
      ? 'critical'
      : 'warning';

    const asOf = isoDate(newestIso);
    const stale = asOf ? now - Date.parse(asOf) > STALE_DAYS * DAY_MS : false;
    // Honest wording: a stale last-observed date is demoted to "as of <date>";
    // a fresh one still reads as a current at-rest exposure.
    const whenClause = asOf
      ? stale
        ? ` (last observed ${asOf}; may already be cleaned up)`
        : `, as of ${asOf}`
      : '';

    const retentionClause =
      typeof cleanup === 'number'
        ? `Local transcripts are retained for ${cleanup} day(s) (settings.json cleanupPeriodDays), so the plaintext copy lingers that long.`
        : `With no cleanupPeriodDays set, Claude Code keeps local transcripts for the default ${DEFAULT_CLEANUP_DAYS} days, so the plaintext copy lingers that long.`;

    const observations: RecObservation[] = [
      {
        claim: `${totalCount} secret-shaped value(s) matched known credential patterns in user prompts and tool-result payloads across ${flaggedSessions} session(s)`,
        source: '~/.claude/projects/<slug>/<sessionId>.jsonl',
        field: 'message.content / toolUseResult (SECRET_PATTERNS)',
        value: totalCount,
      },
      ...kinds.map((k) => ({
        claim: `${countsByKind[k]} value(s) of kind ${k}`,
        source: 'parse-secrets-at-rest',
        field: `countsByKind.${k}`,
        value: countsByKind[k],
      })),
    ];
    if (typeof cleanup === 'number') {
      observations.push({
        claim: `local transcript retention is set to ${cleanup} day(s)`,
        source: '~/.claude/settings.json',
        field: 'cleanupPeriodDays',
        value: cleanup,
      });
    }

    return {
      id: 'security.secrets-at-rest',
      category: 'security',
      severity,
      title: `${totalCount} secret-shaped value(s) persisted in plaintext transcripts`,
      detail:
        `${totalCount} secret-shaped value(s) (kinds: ${kindsStr}) sit in plaintext in ${flaggedSessions} session(s)' ` +
        `user prompts and tool-result payloads in ~/.claude${whenClause}. ${retentionClause} ` +
        `The matched value itself was never stored — only its shape, count, and location.`,
      action:
        'Rotate any of these that are real credentials NOW (the value cannot be recovered from this report — only its shape and location were recorded). ' +
        'Avoid echoing env/credential dumps into the session (e.g. `cat .env`, pasting `curl -H "Authorization: …"`), and bound how long local transcripts keep the plaintext copy by setting cleanupPeriodDays.',
      affected: flaggedSessions,
      view: 'sessions',
      evidence,
      evidenceRefs,
      claimClass: 'accounting',
      proofTier: 'accounting',
      provenance: {
        observations,
        inference:
          'Secret-shaped values in plaintext at rest outlive the session for the retention window and flow into any transcript sharing/upload path; rotating the real credentials and bounding retention limits the exposure. The matched value is never stored, exported, or displayed by this engine.',
        ...(asOf ? { asOf } : {}),
        ...(asOf ? { stale } : {}),
      },
      fix: {
        target: 'settings.json',
        label: 'Bound transcript retention',
        note:
          `Add to ~/.claude/settings.json to age out local transcripts (and the secrets echoed into them) after ${RECOMMENDED_CLEANUP_DAYS} days. ` +
          'WARNING: this permanently deletes local transcripts older than the given days — including the data this dashboard reads. ' +
          'Retention-bounding only limits how long the plaintext copy lingers; rotating the exposed credentials is still required.',
        snippet: `{\n  "cleanupPeriodDays": ${RECOMMENDED_CLEANUP_DAYS}\n}`,
        fixKind: 'validated',
      },
    };
  },
};
