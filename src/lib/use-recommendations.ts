import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { fetchRecommendationSurface, SERVER_AVAILABLE } from '@api-client';
import {
  recommendationSurfaceQuery,
  type Recommendation,
  type DomainCoverage,
  type RecommendationSurfaceRequest,
} from './recommendation-surface';

/**
 * Viewer-only recommendation loader (#2719, epic #2443).
 *
 * The browser no longer runs the detector catalog. This hook fetches the
 * server-computed `{ recommendations, domainCoverage }` envelope for a scoped
 * surface (via the `@api-client` reader, which the sample build aliases to a
 * network-free `unavailable` twin) and exposes a discriminated async state:
 *
 *   loading | ready | error | unavailable
 *
 * Trust contract: ONLY a successful `ready` response may render "no findings"
 * (its `recommendations` empty). `loading`/`error`/`unavailable` never carry a
 * findings list, so a not-yet-loaded or failed analysis can never masquerade as
 * a clean result. There is no application-level stale fallback: when the scope
 * changes the prior result is dropped and the state returns to `loading`. A
 * same-scope `retry()` (e.g. the refetch after a reject write) keeps the prior
 * findings on screen until the server-confirmed result lands. Obsolete in-flight
 * requests are aborted/ignored.
 */
export type RecommendationSurfaceStatus =
  | 'loading'
  | 'ready'
  | 'error'
  | 'unavailable';

export type RecommendationSurfaceRefreshResult =
  | {
      ok: true;
      recommendations: Recommendation[];
      domainCoverage: DomainCoverage[];
    }
  | { ok: false; error: string };

export interface RecommendationSurfaceState {
  status: RecommendationSurfaceStatus;
  /** Non-null ONLY when `status === 'ready'`. */
  recommendations: Recommendation[] | null;
  /** Non-null ONLY when `status === 'ready'`. */
  domainCoverage: DomainCoverage[] | null;
  /** Non-null ONLY when `status === 'error'`. */
  error: string | null;
  /** Re-request the current scope and report the server-confirmed outcome. */
  retry: () => Promise<RecommendationSurfaceRefreshResult>;
}

type RecommendationSurfaceSnapshot = Omit<RecommendationSurfaceState, 'retry'> & {
  scopeKey: string | null;
  /** Logical surface/filter key, excluding the dataset refresh generation. */
  trustScopeKey: string | null;
  /** Inclusive epoch boundary for snapshot-backed analysis; null is unbounded. */
  validThroughMs: number | null;
  /** Boundary a render-time retirement must publish before async work resumes. */
  retirementToRecord: {
    trustScopeKey: string;
    boundary: number;
  } | null;
};

function baseState(
  status: RecommendationSurfaceStatus,
  scopeKey: string | null,
  trustScopeKey: string | null,
  retirementToRecord: RecommendationSurfaceSnapshot['retirementToRecord'] = null
): RecommendationSurfaceSnapshot {
  return {
    scopeKey,
    trustScopeKey,
    status,
    recommendations: null,
    domainCoverage: null,
    error: null,
    validThroughMs: null,
    retirementToRecord,
  };
}

function canRetainReadySnapshot(
  snapshot: RecommendationSurfaceSnapshot,
  nowMs = Date.now()
): boolean {
  return (
    snapshot.status === 'ready' &&
    (snapshot.validThroughMs === null || nowMs <= snapshot.validThroughMs)
  );
}

export interface RecommendationSurfaceLoadOptions {
  /** False until the authenticated local-server dataset is the active source. */
  enabled?: boolean;
  /**
   * Changes when the backing local dataset is replaced without changing URL
   * filters (for example, Reload from disk). Unlike retry(), a new dataset must
   * clear the prior findings immediately because they describe different data.
   */
  refreshKey?: string | number;
}

export function useRecommendationSurface(
  request: RecommendationSurfaceRequest | null,
  options: RecommendationSurfaceLoadOptions = {}
): RecommendationSurfaceState {
  // Deterministic analysis key: URL scope plus the identity of the local
  // dataset behind it. A filter OR dataset change clears stale findings and
  // refetches; a same-dataset retry intentionally keeps the
  // prior findings visible. Disabled/auth-pending/upload/SPA states fold to the
  // stable `unavailable` sentinel and never fetch.
  const requestScopeKey =
    SERVER_AVAILABLE && request && (options.enabled ?? true)
      ? recommendationSurfaceQuery(request)
      : null;
  const scopeKey = requestScopeKey === null
    ? null
    : `${requestScopeKey}\nrefresh=${String(options.refreshKey ?? '')}`;

  const [state, setState] = useState<RecommendationSurfaceSnapshot>(() =>
    baseState(
      scopeKey ? 'loading' : 'unavailable',
      scopeKey,
      requestScopeKey
    )
  );
  const [expiryRefreshRequest, setExpiryRefreshRequest] = useState<{
    generation: number;
    scopeKey: string | null;
  }>({ generation: 0, scopeKey: null });
  const handledExpiryRefreshGeneration = useRef(0);
  // Per-scope monotonic trust floor. Once this browser has observed a response
  // beyond its inclusive boundary, a wall-clock rollback and late/refetched
  // copy with that boundary (or an older one) must not revive its claims.
  const retiredValidThroughByScope = useRef(new Map<string, number>());
  const retireValidThrough = useCallback(
    (retiredScopeKey: string, boundary: number) => {
      const previous = retiredValidThroughByScope.current.get(retiredScopeKey);
      if (previous === undefined || boundary > previous) {
        retiredValidThroughByScope.current.set(retiredScopeKey, boundary);
      }
    },
    []
  );
  // The scope the current `state` belongs to. When it drifts from `scopeKey` we
  // reset DURING RENDER (React's documented "adjust state on prop change"
  // pattern) rather than in an effect — a same-scope retry does NOT
  // change `scopeKey`, so it keeps the prior findings visible; a real scope
  // change clears to `loading` (no stale cross-scope leak).
  const retainedReadyExpiredAtRender =
    state.status === 'ready' &&
    state.validThroughMs !== null &&
    !canRetainReadySnapshot(state);
  const retirementToCarry =
    state.retirementToRecord ??
    (retainedReadyExpiredAtRender && state.trustScopeKey
      ? {
          trustScopeKey: state.trustScopeKey,
          boundary: state.validThroughMs!,
        }
      : null);
  if (state.scopeKey !== scopeKey) {
    setState(
      baseState(
        scopeKey ? 'loading' : 'unavailable',
        scopeKey,
        requestScopeKey,
        retirementToCarry
      )
    );
  }

  const readyExpiredAtRender =
    state.scopeKey === scopeKey && retainedReadyExpiredAtRender;
  if (readyExpiredAtRender) {
    // Keep the crossed boundary in the replacement state. The layout phase
    // publishes it to the monotonic ledger before any async continuation can
    // resolve; `exposedState` hides the cards for this render.
    setState(
      baseState('loading', scopeKey, requestScopeKey, retirementToCarry)
    );
    setExpiryRefreshRequest((prior) => ({
      generation: prior.generation + 1,
      scopeKey,
    }));
  }
  // Publish the committed scope before passive effects or promise continuations
  // run. Combined with the scope carried by `state`, this closes the window
  // where an obsolete local request could overwrite a newly committed source.
  const scopeKeyRef = useRef(scopeKey);
  const requestRef = useRef(request);
  useLayoutEffect(() => {
    scopeKeyRef.current = scopeKey;
    requestRef.current = request;
  }, [scopeKey, request]);
  useLayoutEffect(() => {
    if (
      state.scopeKey !== scopeKey ||
      state.retirementToRecord === null
    ) {
      return;
    }
    retireValidThrough(
      state.retirementToRecord.trustScopeKey,
      state.retirementToRecord.boundary
    );
  }, [
    retireValidThrough,
    scopeKey,
    state.retirementToRecord,
    state.scopeKey,
  ]);
  const activeRequestRef = useRef<{
    controller: AbortController;
    scopeKey: string;
  } | null>(null);

  const runFetch = useCallback(
    async (preserveReady: boolean): Promise<RecommendationSurfaceRefreshResult> => {
      const requestedScope = scopeKeyRef.current;
      const requestedSurface = requestRef.current;
      if (!requestedScope || !requestedSurface) {
        return { ok: false, error: 'Recommendation analysis is unavailable' };
      }
      const requestedTrustScope = recommendationSurfaceQuery(requestedSurface);

      activeRequestRef.current?.controller.abort();
      const controller = new AbortController();
      const activeRequest = { controller, scopeKey: requestedScope };
      activeRequestRef.current = activeRequest;

      try {
        const response = await fetchRecommendationSurface(
          requestedSurface,
          controller.signal
        );
        if (
          controller.signal.aborted ||
          activeRequestRef.current !== activeRequest ||
          scopeKeyRef.current !== requestedScope
        ) {
          return { ok: false, error: 'Recommendation analysis request was superseded' };
        }
        if (response.kind === 'unavailable') {
          setState((prior) => {
            if (prior.scopeKey !== requestedScope) return prior;
            return preserveReady && canRetainReadySnapshot(prior)
              ? prior
              : baseState(
                  'unavailable',
                  requestedScope,
                  requestedTrustScope
                );
          });
          return { ok: false, error: 'Recommendation analysis is unavailable' };
        }
        const validThroughMs = response.result.validThrough === undefined
          ? null
          : Date.parse(response.result.validThrough);
        const retiredValidThrough = retiredValidThroughByScope.current.get(
          requestedTrustScope
        );
        const responseNowMs = Date.now();
        if (
          validThroughMs !== null &&
          (!Number.isFinite(validThroughMs) ||
            responseNowMs > validThroughMs ||
            (retiredValidThrough !== undefined &&
              validThroughMs <= retiredValidThrough))
        ) {
          if (
            Number.isFinite(validThroughMs) &&
            responseNowMs > validThroughMs
          ) {
            retireValidThrough(requestedTrustScope, validThroughMs);
          }
          throw new Error('Recommendation analysis response has expired');
        }
        const next = {
          scopeKey: requestedScope,
          trustScopeKey: requestedTrustScope,
          status: 'ready' as const,
          recommendations: response.result.recommendations,
          domainCoverage: response.result.domainCoverage,
          error: null,
          validThroughMs,
          retirementToRecord: null,
        };
        setState((prior) =>
          prior.scopeKey === requestedScope ? next : prior
        );
        return {
          ok: true,
          recommendations: next.recommendations,
          domainCoverage: next.domainCoverage,
        };
      } catch (err: unknown) {
        if (
          controller.signal.aborted ||
          activeRequestRef.current !== activeRequest ||
          scopeKeyRef.current !== requestedScope ||
          (err instanceof DOMException && err.name === 'AbortError')
        ) {
          return { ok: false, error: 'Recommendation analysis request was superseded' };
        }
        const error =
          err instanceof Error ? err.message : 'Analysis request failed';
        setState((prior) => {
          if (prior.scopeKey !== requestedScope) return prior;
          return preserveReady && canRetainReadySnapshot(prior)
            ? prior
            : {
                scopeKey: requestedScope,
                trustScopeKey: requestedTrustScope,
                status: 'error',
                recommendations: null,
                domainCoverage: null,
                error,
                validThroughMs: null,
                retirementToRecord: null,
              };
        });
        return { ok: false, error };
      } finally {
        if (activeRequestRef.current === activeRequest) {
          activeRequestRef.current = null;
        }
      }
    },
    [retireValidThrough]
  );

  const retry = useCallback(() => runFetch(true), [runFetch]);

  useEffect(() => {
    if (
      expiryRefreshRequest.generation ===
      handledExpiryRefreshGeneration.current
    ) {
      return;
    }
    handledExpiryRefreshGeneration.current = expiryRefreshRequest.generation;
    if (!scopeKey || expiryRefreshRequest.scopeKey !== scopeKey) return;
    void runFetch(false);
  }, [scopeKey, expiryRefreshRequest, runFetch]);

  useEffect(() => {
    if (
      !scopeKey ||
      state.scopeKey !== scopeKey ||
      state.status !== 'ready' ||
      state.validThroughMs === null
    ) {
      return;
    }

    const boundary = state.validThroughMs;
    // `validThrough` names the final valid millisecond. Schedule for +1 so an
    // exact-boundary render remains trustworthy, then drop the old cards before
    // beginning a non-preserving refresh.
    const delayMs = Math.max(0, boundary - Date.now() + 1);
    const timer = setTimeout(() => {
      if (scopeKeyRef.current !== scopeKey) return;
      if (requestScopeKey) retireValidThrough(requestScopeKey, boundary);
      setState((prior) =>
        prior.scopeKey === scopeKey &&
        prior.status === 'ready' &&
        prior.validThroughMs === boundary
          ? baseState('loading', scopeKey, requestScopeKey)
          : prior
      );
      void runFetch(false);
    }, delayMs);

    return () => clearTimeout(timer);
  }, [
    scopeKey,
    requestScopeKey,
    state.scopeKey,
    state.status,
    state.validThroughMs,
    retireValidThrough,
    runFetch,
  ]);

  useEffect(() => {
    // No server (SPA) or no scope: steady `unavailable` state handled in render.
    if (!scopeKey) return;
    // The fetch only commits after its awaited server response; this is the
    // effect's external-system synchronization, not a synchronous state reset.
    void runFetch(false);

    return () => {
      const active = activeRequestRef.current;
      if (active?.scopeKey === scopeKey) active.controller.abort();
    };
  }, [scopeKey, runFetch]);

  const exposedState = readyExpiredAtRender
    ? baseState('loading', scopeKey, requestScopeKey)
    : state;
  return {
    status: exposedState.status,
    recommendations: exposedState.recommendations,
    domainCoverage: exposedState.domainCoverage,
    error: exposedState.error,
    retry,
  };
}
