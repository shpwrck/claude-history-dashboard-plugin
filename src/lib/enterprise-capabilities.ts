import type { EnterpriseSession } from '@api-client';

export function enterpriseCapabilityAllowed(
  session: Pick<
    EnterpriseSession,
    | 'mode'
    | 'authRequired'
    | 'authenticated'
    | 'configured'
    | 'capabilities'
    | 'error'
  > | null,
  capability: string
): boolean {
  if (
    !session ||
    session.error ||
    session.authenticated !== true ||
    session.configured !== true ||
    !session.capabilities ||
    typeof session.capabilities !== 'object' ||
    Array.isArray(session.capabilities)
  ) {
    return false;
  }
  if (session.mode === 'single-user' && session.authRequired === false) {
    return true;
  }
  return (
    session.mode === 'enterprise' &&
    session.authRequired === true &&
    session.capabilities[capability] === true
  );
}
