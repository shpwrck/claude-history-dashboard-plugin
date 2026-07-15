import type { AppliedMarkers, Detector } from '../types';
import {
  allowShadowedByDeny,
  claudeMdMarksApplied,
  MIN_BYPASS_CALLS,
  parsePermRule,
  STALE_WEEKS,
} from '../shared';
import { isAsOfStale } from '../provenance';
import { nativeToolBypass, nativeBypassByScope } from '../../parse-tools';
import { nativeBypassGuidanceSnippet } from '../../native-bypass-snippet';
import { scopeKeyOf, type ReclaimClaim } from '../../reclaim';

/** Chars-per-token proxy (same coarse heuristic as parse-file-reread). */
const CHARS_PER_TOKEN = 4;
const MAX_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;

const MARKERS_NATIVE_BYPASS: AppliedMarkers = {
  headings: [/^##\s+Prefer native tools and path-safe shell usage\b/i],
  bodyPhrases: [
    'choose native tools or path-safe alternatives before Bash',
  ],
};

/** Shell commands that re-implement a first-class tool. */
export const detector: Detector = {
  id: 'workflow.native-bypass',
  appliedMarkers: MARKERS_NATIVE_BYPASS,
  category: 'workflow',
  dataDeps: ['toolData', 'tokenData', 'liveConfig'],
  rule(input, now) {
    const bypass = nativeToolBypass(input.toolData);
    if (bypass.distinctBypassCalls < MIN_BYPASS_CALLS) return null;
    // The category set is statically bounded (six parser-owned families). Keep
    // every category visible because adoption/suppression is evaluated across
    // every category: hiding a fifth family would make the finding impossible
    // to explain or fully act on from its own evidence and fix.
    const reported = bypass.categories;
    // The policy sentence is deliberately category-independent while the
    // examples remain observation-specific. This keeps static adoption,
    // append idempotency, and detector suppression on one predicate.
    if (claudeMdMarksApplied(input.liveConfig, MARKERS_NATIVE_BYPASS)) return null;

    // Existing matching ask/deny rules are a stronger adoption signal, but the
    // detector never generates them: blanket shell denies can break legitimate
    // pipelines and concatenation. Only rules derived from observed, safely
    // mappable categories participate; an all-unmappable finding stays visible.
    const allObservedCommandsMappable = bypass.categories.every(
      (category) =>
        category.observedCommandHeads !== null &&
        category.observedCommandHeads.length > 0
    );
    const permissionRules = bypass.categories.flatMap((category) =>
      (category.observedCommandHeads ?? []).map(
        (command) => `Bash(${command}:*)`
      )
    );
    const settings = input.liveConfig?.settings;
    const configuredAskOrDeny = [
      ...(settings?.permissions?.deny ?? []),
      ...(settings?.permissions?.ask ?? []),
    ];
    // A whole-tool ask/deny covers every Bash call, including guidance-only or
    // deliberately unmappable categories such as standalone cd and env-wrapped
    // commands. It is stronger evidence than any per-head mapping.
    if (
      configuredAskOrDeny.some((configured) => {
        const parsed = parsePermRule(configured);
        return parsed.tool === 'Bash' && parsed.specifier === null;
      })
    ) {
      return null;
    }
    const everyRuleConfigured = permissionRules.every((rule) =>
      configuredAskOrDeny.some((configured) =>
        allowShadowedByDeny(rule, configured)
      )
    );
    if (
      allObservedCommandsMappable &&
      permissionRules.length > 0 &&
      everyRuleConfigured
    ) {
      return null;
    }

    const latestTimestampMs = bypass.latestTimestamp
      ? Date.parse(bypass.latestTimestamp)
      : Number.NaN;
    const latestTimestampIsPlausible =
      Number.isFinite(latestTimestampMs) &&
      (!Number.isFinite(now) ||
        now <= 0 ||
        latestTimestampMs <= now + MAX_FUTURE_SKEW_MS);
    const hasCompleteTimestampCoverage =
      bypass.undatedBypassMatches === 0 &&
      bypass.datedBypassMatches === bypass.totalBypass &&
      latestTimestampIsPlausible;
    const asOf = hasCompleteTimestampCoverage
      ? bypass.latestTimestamp?.slice(0, 10)
      : undefined;
    const stale = asOf
      ? isAsOfStale(asOf, now, STALE_WEEKS * 7)
      : false;
    const historyLead = asOf
      ? stale
        ? `As of ${asOf}, the available tool history contained`
        : `Through ${asOf}, the available tool history recorded`
      : 'The available tool history recorded';
    const categorySummary = bypass.categories
      .map((category) => `${category.category}=${category.count}`)
      .join(', ');

    // Direct byte-delta dollar lever (#951, doc §3 "native-tool-bypass … yes"):
    // the result bytes the bypass shell commands streamed back into context (a
    // direct char-count proxy, /4 → tokens) that a native Grep/Read would not have
    // re-billed the same way. Book a `scaleTokens` deletion of those tokens against
    // the bypassing sessions' INPUT pool; the cascade's `residual ≥ 0` guard caps
    // each cell so we never reclaim more than the real input bill. Needs tokenData
    // to resolve real token cells — absent ⇒ no claim (the rec still surfaces).
    const byScope = nativeBypassByScope(input.toolData);
    const bytesBySession = new Map<string, number>();
    const resultCallsBySession = new Map<string, number>();
    for (const s of byScope) {
      if (s.resultBytes > 0) {
        bytesBySession.set(s.sessionId, s.resultBytes);
        resultCallsBySession.set(s.sessionId, s.resultBearingCalls);
      }
    }
    const scopeKeys = new Set<string>();
    let inScopeInputTokens = 0;
    let directWasteTokens = 0;
    let attributedResultBytes = 0;
    let attributedResultCalls = 0;
    for (const d of input.tokenData ?? []) {
      const bytes = bytesBySession.get(d.sessionId);
      if (!bytes) continue;
      attributedResultBytes += bytes;
      attributedResultCalls += resultCallsBySession.get(d.sessionId) ?? 0;
      directWasteTokens += bytes / CHARS_PER_TOKEN;
      for (const e of d.entries) {
        scopeKeys.add(scopeKeyOf(d.sessionId, e.model || 'unknown'));
        inScopeInputTokens += e.inputTokens;
      }
    }

    let reclaim: ReclaimClaim | undefined;
    if (directWasteTokens > 0 && scopeKeys.size > 0 && inScopeInputTokens > 0) {
      const inputFrac = directWasteTokens / inScopeInputTokens;
      reclaim = {
        leverId: 'workflow.native-bypass',
        category: 'workflow',
        cause: 'workflow-rework',
        // Behavioural band [10,40): reliability(10) → safety(20) → workflow(30).
        orderKey: 30,
        ownedPools: ['input'],
        scopeKeys: [...scopeKeys],
        counterfactual: { kind: 'scaleTokens', poolDeltaFrac: { input: inputFrac } },
        evidenceTokens: Math.round(directWasteTokens),
      };
    }

    return {
      id: 'workflow.native-bypass',
      category: 'workflow',
      severity: 'info',
      title: 'Review shell patterns for native or path-safe alternatives',
      detail: `${historyLead} ${bypass.distinctBypassCalls} distinct native-tool-bypass Bash call(s); those calls produced ${bypass.totalBypass} category match(es): ${reported
        .map((c) => `${c.category} (${c.count})`)
        .join(', ')}.`,
      action:
        'Prefer Grep/Glob/Read/Edit for equivalent file work. Avoid standalone cd calls by using absolute paths or a same-command `cd <dir> && <cmd>` anchor.',
      ...(reclaim ? { reclaim } : {}),
      affected: bypass.distinctBypassCalls,
      evidence: [
        `${bypass.distinctBypassCalls} distinct Bash call(s) produced ${bypass.totalBypass} category match(es)`,
        ...reported.map(
          (c) =>
            `${c.category} → ${c.nativeTool}: ${c.count} category match(es)`
        ),
      ],
      view: 'tools',
      claimClass: 'causal',
      proofTier: 'auditable',
      fix: {
        target: 'CLAUDE.md',
        fixKind: 'illustrative',
        label: 'Add native-tool guidance',
        note:
          'Adapt this CLAUDE.md example to the observed categories. It is behavioural guidance, not a blanket permission rule.',
        snippet: nativeBypassGuidanceSnippet(
          reported.map((category) => ({
            category: category.category,
            nativeTool: category.nativeTool,
            observedCommands: category.observedCommandAliases,
          }))
        ),
        appliedMarkers: MARKERS_NATIVE_BYPASS,
      },
      provenance: {
        observations: [
          {
            claim: `${bypass.distinctBypassCalls} distinct native-tool bypass Bash call(s) were recorded`,
            source: 'parse-tools',
            field:
              'toolData[].calls[].commandBypassCategories / input.command',
            value: bypass.distinctBypassCalls,
          },
          {
            claim: `Those calls produced ${bypass.totalBypass} native-tool bypass category match(es)`,
            source: 'parse-tools',
            field:
              'toolData[].calls[].commandBypassCategories / input.command',
            value: bypass.totalBypass,
          },
          {
            claim: `Observed bypass categories and counts were ${categorySummary}`,
            source: 'parse-tools',
            field:
              'toolData[].calls[].commandBypassCategories / input.command',
            value: categorySummary,
          },
          {
            claim:
              `${bypass.datedBypassMatches} of ${bypass.totalBypass} bypass category match(es) ` +
              'carried a valid RFC3339 timestamp',
            source: 'parse-tools',
            field: 'toolData[].calls[].timestamp',
            value: `${bypass.datedBypassMatches}/${bypass.totalBypass}`,
          },
          ...(reclaim
            ? [
                {
                  claim:
                    `${attributedResultBytes} result character(s) from result-bearing Bash calls ` +
                    'were counted once per call and linked ' +
                    'to sessions with input-token data used to scope the reclaim',
                  source: 'parse-tools + tokenData',
                  field:
                    'toolData[].calls[].resultBytes joined by sessionId to tokenData[].entries[].inputTokens',
                  value: attributedResultBytes,
                },
                {
                  claim:
                    `${attributedResultCalls} result-bearing Bash call(s) supplied those ` +
                    'linked result characters',
                  source: 'parse-tools + tokenData',
                  field:
                    'count(toolData[].calls[].resultBytes > 0) joined by sessionId to tokenData[].entries[].inputTokens',
                  value: attributedResultCalls,
                },
                {
                  claim:
                    `${directWasteTokens} unrounded input-token proxy units form the requested ` +
                    'scaleTokens counterfactual before cascade caps and overlap reduction',
                  source: 'reclaim cascade input',
                  field:
                    'sum(linked toolData[].calls[].resultBytes) / 4, requested as scaleTokens(input) before cascade guards',
                  value: directWasteTokens,
                },
              ]
            : []),
          ...(asOf
            ? [
                {
                  claim: `The newest contributing Bash call was recorded on ${asOf}`,
                  source: 'parse-tools',
                  field: 'toolData[].calls[].timestamp',
                  value: asOf,
                },
              ]
            : []),
        ],
        inference:
          'These category matches are candidates for first-class tool use or, for standalone cd, path-safe shell usage; whether each call is replaceable depends on its semantics. The guidance is therefore conditional and does not justify blanket shell-command denies. When result bytes are linked to input-token data, requesting their unrounded /4 token proxy as avoided by the native alternative is an auditable causal hypothesis, not a measured intervention effect; the cascade can cap or overlap-reduce that request.',
        ...(asOf ? { asOf, stale } : {}),
      },
    };
  },
};
