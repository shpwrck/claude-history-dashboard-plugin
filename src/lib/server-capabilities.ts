import type { ServerSession } from '@api-client';

/**
 * Whether the resolved `/api/auth/session` response allows `capability`
 * (#3832, epic #3743). Fails closed until the probe resolves and whenever it
 * errored, is unauthenticated, or is misconfigured. A single-user (local or
 * HTTP Basic) server allows every local capability; a server that requires
 * bearer auth allows only the capabilities its response lists.
 */
export function serverCapabilityAllowed(
  session: Pick<
    ServerSession,
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
