# Centralized auth — design + decisions needed

Written overnight 2026-06-15 while the user slept. The MVP goal named two pillars: **warm sessions**
(delivered + proven live — refill-on-claim) and **centralized auth**. "Centralized auth" is
under-specified and I did NOT want to build the wrong thing unattended, so this captures the
interpretations, what's unambiguous (and built/plumbable), and the genuine forks the user must pick.

## What "centralized auth" could mean (pick on wake)

1. **Centralized credential management, per-member accounts** (most likely, given the original
   vision "each on their own Claude account"): the central dashboard is where each org member
   onboards/manages THEIR OWN claude.ai credential, and the operator binds the right per-member
   credential to that member's sessions. Today auth is a SINGLE operator-bound `claude-oauth` secret
   — centralized, but shared, not per-member.
2. **Centralized authentication / SSO to the dashboard**: members log into the central dashboard
   with an org identity (the existing `DASHBOARD_AUTH_MODE=enterprise` + per-principal `dataRoot`
   scoping is the seam) so each sees only their own sessions; the aggregate is admin-only.
3. **"Centralized" = the data centralization** already being built (epic #1563): all members' session
   history flowing to the one central dashboard. This is largely DONE (shipper + ingest + shared-tree
   aggregation, deployed tonight). If this is what was meant, the pillar is essentially complete.

## Unambiguous + already plumbable (safe to build)

- **`RemoteSession.spec.credentialRef`** (ADR 0009 §4): an OPTIONAL per-session credential reference
  so a session can name a per-member oauth secret (`claude-oauth-<member>`), defaulting to the shared
  `claude-oauth`. The **operator binds it** (never the CR-spec → arbitrary-secret path; the security
  invariant). This is the foundation for interpretation (1) and is a small, safe addition:
  - `remotesession_types.go`: `CredentialRef *CredentialRef` ({ Name, Kind: personal-oauth|enterprise-api }).
  - `pod.go`: mount `credentialRef.Name` (allowlisted to a `claude-oauth-*` prefix or an operator
    allowlist) instead of the fixed `CredSecretName` when set.
  - The dashboard provisioning card passes the member → the dispatch builds `credentialRef`.
- **Per-member attribution in the aggregate** (#1563 Slice 4): the shipper already stamps
  `_source.json` with the member; teach the dashboard to group/filter aggregated sessions by member.

## The genuine forks (need the user)

- **Member onboarding UX** (interpretation 1): how does a member register their claude.ai credential
  centrally? Options: (a) a dashboard "connect your Claude account" flow that runs the OAuth login
  server-side and stores `claude-oauth-<member>` (real work, touches the OAuth flow); (b) an admin
  pre-seeds per-member secrets out of band (MVP-simple, no UX). The #1558-deferred "self-service
  credential onboarding" is exactly (a).
- **Authentication model** (interpretation 2): turn on `DASHBOARD_AUTH_MODE=enterprise` for the
  hub dashboard? That gates the card + scopes data per principal. It's built but opt-in; enabling it
  is a posture decision (who are the principals, how do they log in — the existing enterprise auth
  uses bearer/JWT + HttpOnly session cookies).

## Recommendation

If (3) — done. If (1) — I can ship `credentialRef` + per-member attribution now (safe, no UX fork),
then we decide onboarding UX (a vs b) together. If (2) — flip on enterprise auth + decide the login
posture. I did NOT pick between these unattended; the credentialRef plumbing is the no-regret first
step for (1)/(2) and I can start it on your word.

See also: `docs/plans/overnight-mvp-status.md` (full run log), ADR 0009 §4 (credentialRef kinds),
epic #1563 (aggregation), #1558 (deferred per-member onboarding).
