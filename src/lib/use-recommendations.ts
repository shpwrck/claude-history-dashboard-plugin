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
 * surface (via the `@api-client` reader, which the SPA build aliases to a
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
};

function baseState(
  status: RecommendationSurfaceStatus,
  scopeKey: string | null
): RecommendationSurfaceSnapshot {
  return {
    scopeKey,
    status,
    recommendations: null,
    domainCoverage: null,
    error: null,
  };
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
    baseState(scopeKey ? 'loading' : 'unavailable', scopeKey)
  );
  // The scope the current `state` belongs to. When it drifts from `scopeKey` we
  // reset DURING RENDER (React's documented "adjust state on prop change"
  // pattern) rather than in an effect — a same-scope retry does NOT
  // change `scopeKey`, so it keeps the prior findings visible; a real scope
  // change clears to `loading` (no stale cross-scope leak).
  if (state.scopeKey !== scopeKey) {
    setState(baseState(scopeKey ? 'loading' : 'unavailable', scopeKey));
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
            return preserveReady && prior.status === 'ready'
              ? prior
              : baseState('unavailable', requestedScope);
          });
          return { ok: false, error: 'Recommendation analysis is unavailable' };
        }
        const next = {
          scopeKey: requestedScope,
          status: 'ready' as const,
          recommendations: response.result.recommendations,
          domainCoverage: response.result.domainCoverage,
          error: null,
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
          return preserveReady && prior.status === 'ready'
            ? prior
            : {
                scopeKey: requestedScope,
                status: 'error',
                recommendations: null,
                domainCoverage: null,
                error,
              };
        });
        return { ok: false, error };
      } finally {
        if (activeRequestRef.current === activeRequest) {
          activeRequestRef.current = null;
        }
      }
    },
    []
  );

  const retry = useCallback(() => runFetch(true), [runFetch]);

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

  return {
    status: state.status,
    recommendations: state.recommendations,
    domainCoverage: state.domainCoverage,
    error: state.error,
    retry,
  };
}
