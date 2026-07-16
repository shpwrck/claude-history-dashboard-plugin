import { describe, it, expect } from 'vitest';
import {
  detector,
  editFormatChurnCacheValidity,
  editFormatChurnCacheValidityContains,
} from './edit-format-churn';
import { validateRecommendationProvenance } from '../provenance';
import { validateFixSnippet } from '../fix-validity';
import type { RecommendationInput } from '../types';
import type { EditFormatChurn, ToolCall, ToolUsageData } from '../../parse-tools-types';

const NOW = Date.parse('2026-01-10T00:00:00.000Z');
const RECENT = new Date(NOW - 60 * 60 * 1000).toISOString();
const ANCIENT = new Date(NOW - 6 * 7 * 24 * 60 * 60 * 1000).toISOString();

function churn(over: Partial<EditFormatChurn> = {}): EditFormatChurn {
  return {
    hunks: 1,
    formattingOnlyHunks: 1,
    lines: 12,
    formattingOnlyLines: 12,
    chars: 600,
    formattingOnlyChars: 600,
    ...over,
  };
}

function editCall(over: Partial<ToolCall> = {}): ToolCall {
  return {
    timestamp: RECENT,
    toolName: 'Edit',
    input: { file_path: '/repo/src/reformatted.ts' },
    toolUseId: 'u',
    isError: false,
    resultBytes: 0,
    editFormatChurn: churn(),
    ...over,
  };
}

function calls(n: number, over: Partial<ToolCall> = {}): ToolCall[] {
  return Array.from({ length: n }, (_, i) => editCall({ toolUseId: `u${i}`, ...over }));
}

function input(
  toolData: ToolUsageData[],
  over: Partial<RecommendationInput> = {}
): RecommendationInput {
  return { toolData, ...over } as unknown as RecommendationInput;
}

const run = (toolData: ToolUsageData[], over: Partial<RecommendationInput> = {}) =>
  detector.rule(input(toolData, over), NOW);

describe('cost.edit-format-churn', () => {
  it('fires on format-dominated recent churn with proxy wording and counts', () => {
    const rec = run([{ sessionId: 's1', calls: calls(12) }]);
    expect(rec).not.toBeNull();
    expect(rec!.id).toBe('cost.edit-format-churn');
    expect(rec!.severity).toBe('info');
    expect(rec!.affected).toBe(1);
    expect(rec!.detail).toContain('verify intent');
    expect(rec!.detail).toContain('As of 2026-01-09');
    expect(rec!.detail).toContain('12 of 12');
    expect(rec!.claimClass).toBe('accounting');
  });

  it('stays silent below the formatting-only hunk floor', () => {
    expect(run([{ sessionId: 's1', calls: calls(11) }])).toBeNull();
  });

  it('stays silent below the hunk ratio floor', () => {
    // 12 formatting-only of 60 hunks (0.2) is below the 0.25 ratio gate.
    const mixed = [
      ...calls(12),
      ...calls(48, {
        editFormatChurn: churn({
          formattingOnlyHunks: 0,
          formattingOnlyLines: 0,
          formattingOnlyChars: 0,
        }),
      }),
    ];
    expect(run([{ sessionId: 's1', calls: mixed }])).toBeNull();
  });

  it('stays silent below the line-mass floor', () => {
    const small = calls(12, { editFormatChurn: churn({ lines: 5, formattingOnlyLines: 5 }) });
    expect(run([{ sessionId: 's1', calls: small }])).toBeNull();
  });

  it('excludes whitespace-semantic and machine-formatted paths, and unknowable ones (fail closed)', () => {
    for (const file_path of [
      '/repo/app/main.py',
      '/repo/deploy/config.yaml',
      '/repo/docs/README.md',
      '/repo/Makefile',
      '/repo/package-lock.json',
      '/repo/dist/app.min.js',
      '/repo/bin/script', // no extension → language unknowable
      '/repo/site/index.html', // markup: whitespace can be rendered value
      '/repo/src/App.tsx', // template nodes: whitespace can be rendered value
      '/repo/web/page.php', // templates + heredoc/nowdoc bodies
      '/repo/tools/defs.bzl', // Starlark: indentation-significant
      '/repo/scripts/run.sh', // multi-line quoted strings are runtime value
      '/repo/db/schema.sql', // single-quoted literals span lines unguarded
      '/repo/app/Program.cs', // verbatim @"..." strings span lines unguarded
    ]) {
      expect(
        run([{ sessionId: 's1', calls: calls(20, { input: { file_path } }) }]),
        `expected silence for ${file_path}`
      ).toBeNull();
    }
    // Missing file_path entirely → exclusions cannot apply → fail closed.
    expect(run([{ sessionId: 's1', calls: calls(20, { input: {} }) }])).toBeNull();
  });

  it('never counts truncated analyses, failed calls, or unproven (resultless) calls', () => {
    const truncated = calls(20, { editFormatChurn: churn({ truncated: true }) });
    expect(run([{ sessionId: 's1', calls: truncated }])).toBeNull();
    const failed = calls(20, { isError: true });
    expect(run([{ sessionId: 's1', calls: failed }])).toBeNull();
    // No tool_result seen (interrupted session / live tail): isError stays
    // null — unproven churn is suppressed evidence.
    const unproven = calls(20, { isError: null });
    expect(run([{ sessionId: 's1', calls: unproven }])).toBeNull();
  });

  it('vetoes the whole finding when a truncated analysis sits in the window', () => {
    // 12 clean formatting-only hunks would fire on their own, but one
    // truncated call means UNKNOWN hunks exist — a dominance claim over the
    // window is unprovable, so the card is suppressed entirely.
    const mixed = [
      ...calls(12),
      editCall({
        toolUseId: 'trunc',
        editFormatChurn: churn({ hunks: 0, formattingOnlyHunks: 0, truncated: true }),
      }),
    ];
    expect(run([{ sessionId: 's1', calls: mixed }])).toBeNull();
  });

  it('suppresses when the evidence has aged out of the recent window', () => {
    const old = calls(20, { timestamp: ANCIENT });
    expect(run([{ sessionId: 's1', calls: old }])).toBeNull();
    const undated = calls(20, { timestamp: 'not-a-date' });
    expect(run([{ sessionId: 's1', calls: undated }])).toBeNull();
  });

  it('self-suppresses once the CLAUDE.md fix is applied', () => {
    const liveConfig = {
      settings: {},
      claudeMd: {
        global:
          '## Formatting discipline\n\n- Keep diffs semantic-minimal: do not reformat code you are not otherwise changing.',
        perProject: {},
      },
      plugins: [],
      mcpServers: [],
      skills: [],
      subagents: [],
      commands: [],
    } as unknown as RecommendationInput['liveConfig'];
    expect(run([{ sessionId: 's1', calls: calls(12) }], { liveConfig })).toBeNull();
  });

  it('emits compliant provenance with an asOf date from the evidence', () => {
    const rec = run([{ sessionId: 's1', calls: calls(12) }]);
    expect(validateRecommendationProvenance(rec!)).toEqual([]);
    expect(rec!.provenance?.asOf).toBe('2026-01-09');
    expect(rec!.provenance?.observations[0].field).toContain('editFormatChurn');
  });

  it('ships a validated, copy-paste-safe CLAUDE.md fix snippet', () => {
    const rec = run([{ sessionId: 's1', calls: calls(12) }]);
    expect(rec!.fix).toBeDefined();
    expect(rec!.fix!.fixKind ?? 'validated').toBe('validated');
    expect(validateFixSnippet(rec!.fix!)).toEqual([]);
    // The snippet must contain the marker body phrase so applying it suppresses.
    expect(rec!.fix!.snippet).toContain('do not reformat code you are not otherwise changing');
  });

  it('keeps the hunk-denominator scope and the affected scope reconcilable', () => {
    // s1 contributes the formatting-only churn; s2 only eligible non-formatting
    // hunks. The percentage denominator spans both, `affected` names only s1.
    // The formatting churn is 10 days old; the newer semantic edits are in the
    // denominator, so asOf must reflect THEM, not just the formatting hunks.
    const older = new Date(NOW - 10 * 24 * 60 * 60 * 1000).toISOString();
    const rec = run([
      { sessionId: 's1', calls: calls(12, { timestamp: older }) },
      {
        sessionId: 's2',
        calls: calls(12, {
          editFormatChurn: churn({
            formattingOnlyHunks: 0,
            formattingOnlyLines: 0,
            formattingOnlyChars: 0,
          }),
        }),
      },
    ]);
    expect(rec).not.toBeNull();
    expect(rec!.affected).toBe(1);
    expect(rec!.detail).toContain('12 of 24');
    expect(rec!.detail).toContain('across 2 session(s) with recent edit activity');
    expect(rec!.detail).toContain('concentrated in 1 session(s)');
    expect(rec!.detail).toContain('As of 2026-01-09'); // the eligible semantic edits' date
    expect(rec!.provenance?.asOf).toBe('2026-01-09');
  });

  it('aggregates across sessions and cites the heaviest files', () => {
    const rec = run([
      { sessionId: 'aaaa1111-2222-3333', calls: calls(8) },
      {
        sessionId: 'bbbb4444-5555-6666',
        calls: calls(8, { input: { file_path: '/repo/src/other.ts' } }),
      },
    ]);
    expect(rec).not.toBeNull();
    expect(rec!.affected).toBe(2);
    expect(rec!.evidence!.some((e) => e.includes('/repo/src/reformatted.ts'))).toBe(true);
    expect(rec!.evidence!.some((e) => e.includes('/repo/src/other.ts'))).toBe(true);
    // Session-id-first rows: the project-scoped API resolves each evidence
    // row's first token against its 8-char short(sessionId) index, so the
    // rows must lead with the SHORT form of the full session id.
    expect(rec!.evidence!.some((e) => e.startsWith('aaaa1111 '))).toBe(true);
    expect(rec!.evidence!.some((e) => e.startsWith('bbbb4444 '))).toBe(true);
  });

  it('normalizes Windows separators so basename/extension exclusions still apply', () => {
    for (const file_path of ['C:\\repo\\package-lock.json', 'C:\\repo.v2\\app\\main.py']) {
      expect(
        run([{ sessionId: 's1', calls: calls(20, { input: { file_path } }) }]),
        `expected silence for ${file_path}`
      ).toBeNull();
    }
  });
});

describe('editFormatChurnCacheValidity', () => {
  const WINDOW_MS = 4 * 7 * 24 * 60 * 60 * 1000;

  it('bounds a fresh-evidence cache between the entry and exit crossings', () => {
    const validity = editFormatChurnCacheValidity(
      { toolData: [{ sessionId: 's1', calls: calls(2) }] },
      NOW
    );
    // The entry boundary is recorded as a lower bound too, so the body is
    // never reusable for instants before the call became eligible (e.g. after
    // a backward clock correction).
    expect(validity.after).toBe(Date.parse(RECENT) - 1);
    expect(validity.through).toBe(Date.parse(RECENT) + WINDOW_MS);
    expect(editFormatChurnCacheValidityContains(validity, NOW)).toBe(true);
    expect(
      editFormatChurnCacheValidityContains(validity, validity.through! + 1)
    ).toBe(false);
    expect(
      editFormatChurnCacheValidityContains(validity, Date.parse(RECENT) - 2)
    ).toBe(false);
  });

  it('a fully aged-out corpus is valid from its last (exit) crossing onward', () => {
    const validity = editFormatChurnCacheValidity(
      { toolData: [{ sessionId: 's1', calls: calls(2, { timestamp: ANCIENT }) }] },
      NOW
    );
    // Both crossings are in the past; the exit one is the later lower bound.
    expect(validity.after).toBe(Date.parse(ANCIENT) + WINDOW_MS);
    expect(validity.through).toBeNull();
    expect(editFormatChurnCacheValidityContains(validity, NOW)).toBe(true);
    expect(
      editFormatChurnCacheValidityContains(validity, validity.after! - 1)
    ).toBe(false);
  });

  it('a clock-skewed future call bounds validity strictly before its entry instant', () => {
    const future = new Date(NOW + 60 * 60 * 1000).toISOString();
    const validity = editFormatChurnCacheValidity(
      { toolData: [{ sessionId: 's1', calls: calls(1, { timestamp: future }) }] },
      NOW
    );
    // The call is eligible AT Date.parse(future) (`ts <= now`), so a cached
    // body must already be invalid by then — but it IS still valid at the
    // pre-entry instant itself (the last instant of the current segment).
    expect(validity.through).toBe(Date.parse(future) - 1);
    expect(
      editFormatChurnCacheValidityContains(validity, Date.parse(future))
    ).toBe(false);
    expect(
      editFormatChurnCacheValidityContains(validity, Date.parse(future) - 1)
    ).toBe(true);
  });

  it('ignores non-countable calls and empty corpora', () => {
    expect(editFormatChurnCacheValidity({ toolData: [] }, NOW)).toEqual({
      after: null,
      through: null,
    });
    const validity = editFormatChurnCacheValidity(
      {
        toolData: [
          { sessionId: 's1', calls: calls(3, { isError: null }) },
          { sessionId: 's2', calls: calls(3, { input: { file_path: '/repo/app.py' } }) },
        ],
      },
      NOW
    );
    expect(validity).toEqual({ after: null, through: null });
    expect(editFormatChurnCacheValidityContains(validity, NOW)).toBe(true);
  });
});
