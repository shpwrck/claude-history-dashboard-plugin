import { describe, expect, it } from 'vitest';
import {
  classifyArm,
  ARM_BRANCH_PREFIXES,
  ARM_LABELS,
  type ArmId,
} from './experiment-arms';

describe('experiment-arms', () => {
  it('maps every branch prefix to its arm', () => {
    expect(classifyArm({ gitBranch: 'exp-c0/2096-thing' })).toBe('c0');
    expect(classifyArm({ gitBranch: 'exp-s/2096-thing' })).toBe('s');
    expect(classifyArm({ gitBranch: 'exp-o/2096-thing' })).toBe('o');
    expect(classifyArm({ gitBranch: 'exp-os/2096-thing' })).toBe('os');
  });

  it('disambiguates exp-os/ from exp-o/ (the shared-prefix trap)', () => {
    // `exp-os/x` starts with `exp-o` but NOT `exp-o/`, so it must be `os`.
    expect(classifyArm({ gitBranch: 'exp-os/x' })).toBe('os');
    expect(classifyArm({ gitBranch: 'exp-o/x' })).toBe('o');
  });

  it('reads the opener marker when no branch prefix matches', () => {
    expect(classifyArm({ opener: 'exp-arm: o' })).toBe('o');
    expect(classifyArm({ opener: 'kickoff\nexp-arm: os\ndo the thing' })).toBe('os');
    expect(classifyArm({ opener: 'EXP-ARM: C0' })).toBe('c0');
    expect(classifyArm({ opener: 'exp-arm:s' })).toBe('s');
  });

  it('does not enroll prose that merely mentions an arm marker', () => {
    expect(
      classifyArm({ opener: 'The convention uses exp-arm: o in kickoff prompts.' })
    ).toBeNull();
    expect(classifyArm({ opener: 'prefix exp-arm: s' })).toBeNull();
    expect(classifyArm({ opener: 'exp-arm: os trailing prose' })).toBeNull();
  });

  it('prefers the longer arm id in the marker (os before o)', () => {
    expect(classifyArm({ opener: 'exp-arm: os' })).toBe('os');
  });

  it('returns null for an unrelated branch or opener', () => {
    expect(classifyArm({ gitBranch: 'feature/2096-thing' })).toBeNull();
    expect(classifyArm({ opener: 'just a normal prompt, no marker' })).toBeNull();
    expect(classifyArm({})).toBeNull();
    expect(classifyArm({ gitBranch: null, opener: null })).toBeNull();
    // `exp-arm` without a valid id must not match.
    expect(classifyArm({ opener: 'exp-arm: x' })).toBeNull();
  });

  it('lets the branch prefix win over a conflicting opener marker', () => {
    expect(
      classifyArm({ gitBranch: 'exp-c0/thing', opener: 'exp-arm: os' })
    ).toBe('c0');
  });

  it('keeps ARM_LABELS and ARM_BRANCH_PREFIXES in sync with ArmId', () => {
    const arms: ArmId[] = ['c0', 's', 'o', 'os'];
    for (const arm of arms) expect(ARM_LABELS[arm]).toBeTruthy();
    expect(new Set(Object.values(ARM_BRANCH_PREFIXES))).toEqual(new Set(arms));
    for (const prefix of Object.keys(ARM_BRANCH_PREFIXES)) {
      expect(prefix.endsWith('/')).toBe(true);
    }
  });
});
