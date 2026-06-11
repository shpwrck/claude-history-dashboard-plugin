import { describe, it, expect } from 'vitest';
import type { Session } from '../types';
import {
  classifySessionType,
  buildSessionTypeClassifier,
} from './session-type-classifier';

function entry(display: string) {
  return {
    display,
    pastedContents: {},
    timestamp: 0,
    project: 'p',
    sessionId: 's',
  };
}

function session(prompts: string[], durationMs: number, id = 's'): Session {
  return {
    sessionId: id,
    project: 'p',
    projectShort: 'p',
    entries: prompts.map(entry),
    startTime: 1_000,
    endTime: 1_000 + durationMs,
    duration: durationMs,
    messageCount: prompts.length,
  };
}

const MIN = 60_000;

describe('classifySessionType', () => {
  it('classifies a single short prompt as a quick question', () => {
    expect(classifySessionType(session(['What does this flag do?'], 30_000))).toBe(
      'quick_question'
    );
  });

  it('classifies many-turn sessions as multi_task', () => {
    const prompts = Array.from({ length: 8 }, (_, i) => `do thing ${i}`);
    expect(classifySessionType(session(prompts, 10 * MIN))).toBe('multi_task');
  });

  it('classifies long-duration sessions as multi_task', () => {
    expect(classifySessionType(session(['build the feature'], 50 * MIN))).toBe(
      'multi_task'
    );
  });

  it('classifies investigation-leaning middle sessions as exploration', () => {
    const s = session(
      ['why is this failing', 'explain the cache flow', 'find where it breaks'],
      20 * MIN
    );
    expect(classifySessionType(s)).toBe('exploration');
  });

  it('classifies change-leaning middle sessions as single_task', () => {
    const s = session(
      ['implement the parser', 'add a test for it'],
      20 * MIN
    );
    expect(classifySessionType(s)).toBe('single_task');
  });

  it('ignores init/exit synthetic markers when counting turns', () => {
    // Only one real prompt (init/exit dropped) + short -> quick question.
    const s = session(['init', 'just one question?', 'exit'], 30_000);
    expect(classifySessionType(s)).toBe('quick_question');
  });

  it('builds a sessionId -> type lookup', () => {
    const classify = buildSessionTypeClassifier([
      session(['quick?'], 10_000, 'a'),
      session(Array.from({ length: 9 }, () => 'go'), 5 * MIN, 'b'),
    ]);
    expect(classify('a')).toBe('quick_question');
    expect(classify('b')).toBe('multi_task');
    expect(classify('missing')).toBeUndefined();
  });
});
