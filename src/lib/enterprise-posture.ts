import type {
  EnterpriseSecurityControl,
  EnterpriseSecurityControlState,
} from './api-client';

export interface EnterprisePostureCounts {
  total: number;
  actionRequired: number;
  disabled: number;
  enabled: number;
}

const POSTURE_STATE_ORDER: Record<EnterpriseSecurityControlState, number> = {
  'action-required': 0,
  disabled: 1,
  enabled: 2,
};

export function summarizeEnterprisePosture(
  controls: EnterpriseSecurityControl[]
): EnterprisePostureCounts {
  return controls.reduce<EnterprisePostureCounts>(
    (counts, control) => {
      counts.total += 1;
      if (control.state === 'action-required') counts.actionRequired += 1;
      else if (control.state === 'disabled') counts.disabled += 1;
      else counts.enabled += 1;
      return counts;
    },
    { total: 0, actionRequired: 0, disabled: 0, enabled: 0 }
  );
}

export function orderEnterprisePostureControls(
  controls: EnterpriseSecurityControl[]
): EnterpriseSecurityControl[] {
  return controls
    .map((control, index) => ({ control, index }))
    .sort((a, b) => {
      const stateDiff =
        POSTURE_STATE_ORDER[a.control.state] -
        POSTURE_STATE_ORDER[b.control.state];
      return stateDiff || a.index - b.index;
    })
    .map(({ control }) => control);
}
