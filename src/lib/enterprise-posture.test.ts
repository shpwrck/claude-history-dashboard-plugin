import { describe, expect, it } from 'vitest';
import type { EnterpriseSecurityControl } from './api-client';
import {
  orderEnterprisePostureControls,
  summarizeEnterprisePosture,
} from './enterprise-posture';

const control = (
  id: string,
  state: EnterpriseSecurityControl['state']
): EnterpriseSecurityControl => ({
  id,
  label: id,
  state,
  summary: `${id} summary`,
  detail: `${id} detail`,
});

describe('enterprise posture helpers', () => {
  it('counts action-required, disabled, and enabled controls', () => {
    const counts = summarizeEnterprisePosture([
      control('a', 'enabled'),
      control('b', 'action-required'),
      control('c', 'disabled'),
      control('d', 'action-required'),
    ]);

    expect(counts).toEqual({
      total: 4,
      actionRequired: 2,
      disabled: 1,
      enabled: 1,
    });
  });

  it('orders action-required controls first while preserving server order within each state', () => {
    const ordered = orderEnterprisePostureControls([
      control('enabled-1', 'enabled'),
      control('action-1', 'action-required'),
      control('disabled-1', 'disabled'),
      control('action-2', 'action-required'),
      control('enabled-2', 'enabled'),
    ]);

    expect(ordered.map((c) => c.id)).toEqual([
      'action-1',
      'action-2',
      'disabled-1',
      'enabled-1',
      'enabled-2',
    ]);
  });
});
