import type { Detector } from '../types';
import { permissionsContain } from '../shared';
import { nativeToolBypass, nativeBypassByScope } from '../../parse-tools';
import { MIN_BYPASS_CALLS } from '../shared';
import { scopeKeyOf, type ReclaimClaim } from '../../reclaim';

/** Chars-per-token proxy (same coarse heuristic as parse-file-reread). */
const CHARS_PER_TOKEN = 4;

/** Shell commands that re-implement a first-class tool. */
export const detector: Detector = {
  id: 'workflow.native-bypass',
  category: 'workflow',
  dataDeps: ['toolData', 'tokenData', 'liveConfig'],
  rule(input) {
    const bypass = nativeToolBypass(input.toolData);
    if (bypass.totalBypass < MIN_BYPASS_CALLS) return null;
    const top = bypass.categories.slice(0, 4);
    // Snippet shape is dynamic — built from `top`. Compute the same deny list the
    // fix would emit and skip the rec when every rule is already present in
    // settings (matches "deny" OR "ask" — both steer to native tools).
    const DENY_RULE: Partial<Record<(typeof top)[number]['category'], string>> = {
      grep: 'Bash(grep:*)',
      find: 'Bash(find:*)',
      cat: 'Bash(cat:*)',
      sed: 'Bash(sed:*)',
      awk: 'Bash(awk:*)',
    };
    const denyRules = top
      .map((c) => DENY_RULE[c.category])
      .filter((r): r is string => Boolean(r));
    const fixDeny = denyRules.length > 0
      ? denyRules
      : ['Bash(grep:*)', 'Bash(find:*)', 'Bash(cat:*)'];
    if (
      permissionsContain(input.liveConfig?.settings, 'deny', fixDeny) ||
      permissionsContain(input.liveConfig?.settings, 'ask', fixDeny)
    ) {
      return null;
    }

    // Direct byte-delta dollar lever (#951, doc §3 "native-tool-bypass … yes"):
    // the result bytes the bypass shell commands streamed back into context (a
    // direct char-count proxy, /4 → tokens) that a native Grep/Read would not have
    // re-billed the same way. Book a `scaleTokens` deletion of those tokens against
    // the bypassing sessions' INPUT pool; the cascade's `residual ≥ 0` guard caps
    // each cell so we never reclaim more than the real input bill. Needs tokenData
    // to resolve real priced cells — absent ⇒ no claim (the rec still surfaces).
    const byScope = nativeBypassByScope(input.toolData);
    const bytesBySession = new Map<string, number>();
    for (const s of byScope) {
      if (s.resultBytes > 0) bytesBySession.set(s.sessionId, s.resultBytes);
    }
    const scopeKeys = new Set<string>();
    let inScopeInputTokens = 0;
    let directWasteTokens = 0;
    for (const d of input.tokenData ?? []) {
      const bytes = bytesBySession.get(d.sessionId);
      if (!bytes) continue;
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
      title: 'Use native tools instead of shell equivalents',
      detail: `${bypass.totalBypass} Bash commands re-implemented a native tool: ${top
        .map((c) => `${c.category} (${c.count})`)
        .join(', ')}.`,
      action:
        'Prefer Grep/Glob/Read/Edit over grep/find/cat/sed — they are faster, cheaper, and integrate with permissions.',
      ...(reclaim ? { reclaim } : {}),
      affected: bypass.totalBypass,
      evidence: top.map((c) => `${c.category} → ${c.nativeTool}: ${c.count}×`),
      view: 'tools',
      fix: {
        target: 'settings.json',
        label: 'Add deny rules',
        note: 'Merge into the "permissions" object in .claude/settings.json (deep-merge the "deny" array). Use "ask" instead of "deny" if you want a prompt rather than a hard block — both steer Claude onto native Grep/Glob/Read.',
        snippet: JSON.stringify({ permissions: { deny: fixDeny } }, null, 2),
      },
    };
  },
};
