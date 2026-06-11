import { describe, expect, it } from 'vitest';
import { enterpriseCapabilityAllowed } from './enterprise-capabilities';

describe('enterpriseCapabilityAllowed', () => {
  it('allows single-user mode without an explicit capability', () => {
    expect(enterpriseCapabilityAllowed(null, 'canUseBrowserLlmEgress')).toBe(
      true
    );
    expect(
      enterpriseCapabilityAllowed(
        { authRequired: false, capabilities: {} },
        'canUseBrowserLlmEgress'
      )
    ).toBe(true);
  });

  it('requires an explicit enterprise capability', () => {
    expect(
      enterpriseCapabilityAllowed(
        { authRequired: true, capabilities: {} },
        'canUseBrowserLlmEgress'
      )
    ).toBe(false);
    expect(
      enterpriseCapabilityAllowed(
        {
          authRequired: true,
          capabilities: { canUseBrowserLlmEgress: true },
        },
        'canUseBrowserLlmEgress'
      )
    ).toBe(true);
  });
});

