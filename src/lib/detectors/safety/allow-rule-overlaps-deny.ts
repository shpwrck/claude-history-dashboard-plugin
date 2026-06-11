import type { Detector } from '../types';
import { allowShadowedByDeny } from '../shared';

/**
 * Permission `allow` rules fully shadowed by a `deny` (#175). Deny always wins,
 * so such an allow is dead — a contradictory, misleading entry. Pure settings
 * analysis, no history needed. Conservative shadow test (Bash prefix coverage;
 * equality for non-Bash) so we never claim a shadow we can't prove. Inherently
 * suppressible per #166: deleting the dead allow removes it from `allow` and
 * the finding stops.
 */
export const detector: Detector = {
  id: 'safety.allow-rule-overlaps-deny',
  category: 'safety',
  dataDeps: ['liveConfig'],
  rule(input) {
    const perms = input.liveConfig?.settings?.permissions;
    const allow = Array.isArray(perms?.allow) ? perms.allow : [];
    const deny = Array.isArray(perms?.deny) ? perms.deny : [];
    if (allow.length === 0 || deny.length === 0) return null;

    const dead: { allow: string; deny: string }[] = [];
    for (const a of allow) {
      if (typeof a !== 'string') continue;
      for (const d of deny) {
        if (typeof d !== 'string') continue;
        if (allowShadowedByDeny(a, d)) {
          dead.push({ allow: a, deny: d });
          break; // first shadowing deny is enough
        }
      }
    }
    if (dead.length === 0) return null;

    return {
      id: 'safety.allow-rule-overlaps-deny',
      category: 'safety',
      severity: 'warning',
      title: 'Allow rules shadowed by a deny',
      detail: `${dead.length} permission allow rule(s) are fully covered by a deny rule — deny always wins, so the allow never takes effect.`,
      action:
        'Remove the dead allow entries (or narrow the deny if the allow was the intent) so settings.json reflects what actually happens.',
      evidence: dead.map((p) => `${p.allow}  ⊂  deny ${p.deny}`),
      affected: dead.length,
      view: 'permissions',
      fix: {
        target: 'settings.json',
        label: 'Remove shadowed allow rules',
        note: 'These "permissions.allow" entries are overridden by a broader "deny" (deny wins), so they do nothing. Delete them, or narrow the conflicting deny if the allow was intended.',
        snippet: JSON.stringify(
          { permissions: { allow: dead.map((p) => p.allow) } },
          null,
          2
        ),
      },
    };
  },
};
