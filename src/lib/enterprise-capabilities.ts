import type { EnterpriseSession } from '@api-client';

export function enterpriseCapabilityAllowed(
  session: Pick<EnterpriseSession, 'authRequired' | 'capabilities'> | null,
  capability: string
): boolean {
  return !session?.authRequired || Boolean(session.capabilities?.[capability]);
}

