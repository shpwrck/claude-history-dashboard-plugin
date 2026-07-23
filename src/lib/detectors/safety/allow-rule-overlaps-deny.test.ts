/**
 * Behavioral tests for safety.allow-rule-overlaps-deny (#175, coverage gap
 * #2967). A SAFETY detector: it flags permission `allow` rules that a `deny`
 * fully shadows (deny always wins, so the allow is dead). Before this the
 * detector — and its underlying `allowShadowedByDeny` shadow check — had no
 * behavioral test, so a regression in the Bash-prefix coverage would have
 * shipped silently.
 *
 * Fixtures are shaped exactly like `~/.claude/settings.json` permissions
 * (`Bash(git push:*)`, `Read(/etc/**)`, …).
 */
import { describe, it, expect } from 'vitest';
import { detector } from './allow-rule-overlaps-deny';
import { allowShadowedByDeny } from '../../permission-rules';
import type { RecommendationInput } from '../types';

// ── Fixture helper ─────────────────────────────────────────────────────────
// Only `liveConfig.settings.permissions` is read by this detector; build the
// minimal bundle and cast (the established light-fixture pattern).
function input(permissions?: {
  allow?: unknown[];
  deny?: unknown[];
}): RecommendationInput {
  return {
    tokenData: [],
    toolData: [],
    sessions: [],
    projects: [],
    permissionRows: [],
    apiErrors: [],
    liveConfig: permissions
      ? ({ settings: { permissions } } as unknown as RecommendationInput['liveConfig'])
      : null,
  };
}

// ── Detector: fires / does-not-fire ─────────────────────────────────────────

describe('safety.allow-rule-overlaps-deny detector', () => {
  it('fires when an allow is fully shadowed by a deny prefix', () => {
    const rec = detector.rule(
      input({ allow: ['Bash(git push origin)'], deny: ['Bash(git push:*)'] }),
      0
    );
    expect(rec).not.toBeNull();
    expect(rec!.id).toBe('safety.allow-rule-overlaps-deny');
    expect(rec!.category).toBe('safety');
    expect(rec!.severity).toBe('warning');
    expect(rec!.affected).toBe(1);
    expect(rec!.evidence?.[0]).toBe('Bash(git push origin)  ⊂  deny Bash(git push:*)');
    // The suggested fix lists exactly the dead allow to remove.
    expect(rec!.fix?.snippet).toContain('Bash(git push origin)');
  });

  it('counts every shadowed allow (affected + evidence)', () => {
    const rec = detector.rule(
      input({
        allow: ['Bash(git push origin)', 'Read(/etc/hosts)', 'Bash(npm test)'],
        deny: ['Bash(git push:*)', 'Read(/etc/hosts)'],
      }),
      0
    );
    expect(rec).not.toBeNull();
    // Bash(git push origin) ⊂ Bash(git push:*) and Read(/etc/hosts) shadowed;
    // Bash(npm test) has no covering deny.
    expect(rec!.affected).toBe(2);
    expect(rec!.evidence).toHaveLength(2);
  });

  it('does not fire when no allow is shadowed', () => {
    expect(
      detector.rule(
        input({ allow: ['Bash(npm test)'], deny: ['Bash(git push:*)'] }),
        0
      )
    ).toBeNull();
  });

  it('does not fire when allow is empty', () => {
    expect(detector.rule(input({ allow: [], deny: ['Bash'] }), 0)).toBeNull();
  });

  it('does not fire when deny is empty', () => {
    expect(
      detector.rule(input({ allow: ['Bash(git push origin)'], deny: [] }), 0)
    ).toBeNull();
  });

  it('does not fire when there is no live config', () => {
    expect(detector.rule(input(), 0)).toBeNull();
  });

  it('ignores non-string entries without throwing', () => {
    const rec = detector.rule(
      input({ allow: [42, 'Bash(git push origin)'], deny: [null, 'Bash(git push:*)'] }),
      0
    );
    expect(rec).not.toBeNull();
    expect(rec!.affected).toBe(1);
  });
});

// ── Shadow-check edge cases (allowShadowedByDeny) ────────────────────────────
// The conservative shadow test is the load-bearing safety logic; cover its
// branches directly so a regression in the Bash-prefix coverage fails here.

describe('allowShadowedByDeny shadow check', () => {
  it('is false when the tools differ', () => {
    expect(allowShadowedByDeny('Bash(git status)', 'Read(/x)')).toBe(false);
  });

  it('a tool-wide deny (no specifier) shadows any allow of that tool', () => {
    expect(allowShadowedByDeny('Bash(git status)', 'Bash')).toBe(true);
  });

  it('a specific deny does NOT shadow a tool-wide allow', () => {
    expect(allowShadowedByDeny('Bash', 'Bash(git status)')).toBe(false);
  });

  describe('Bash with a prefix deny (`:*`)', () => {
    it('shadows an allow whose literal equals the deny prefix', () => {
      expect(allowShadowedByDeny('Bash(git push)', 'Bash(git push:*)')).toBe(true);
    });

    it('shadows an allow that extends the deny prefix by a space-delimited arg', () => {
      expect(
        allowShadowedByDeny('Bash(git push origin main)', 'Bash(git push:*)')
      ).toBe(true);
    });

    it('shadows an equal allow prefix', () => {
      expect(allowShadowedByDeny('Bash(git push:*)', 'Bash(git push:*)')).toBe(true);
    });

    it('does NOT shadow when the boundary is not a space (git pushx vs git push)', () => {
      expect(allowShadowedByDeny('Bash(git pushx)', 'Bash(git push:*)')).toBe(false);
    });
  });

  describe('Bash with a literal deny (no `:*`)', () => {
    it('shadows an identical literal allow', () => {
      expect(allowShadowedByDeny('Bash(git status)', 'Bash(git status)')).toBe(true);
    });

    it('does NOT shadow a broader prefix allow (allow is `:*`, deny is literal)', () => {
      expect(allowShadowedByDeny('Bash(git status:*)', 'Bash(git status)')).toBe(false);
    });

    it('does NOT shadow a different literal', () => {
      expect(allowShadowedByDeny('Bash(git status)', 'Bash(git diff)')).toBe(false);
    });
  });

  describe('non-Bash tools use exact specifier equality', () => {
    it('shadows an identical specifier', () => {
      expect(allowShadowedByDeny('Read(/etc/**)', 'Read(/etc/**)')).toBe(true);
    });

    it('does NOT shadow a different specifier', () => {
      expect(allowShadowedByDeny('Read(/a)', 'Read(/b)')).toBe(false);
    });
  });
});
