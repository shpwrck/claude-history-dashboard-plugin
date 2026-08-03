---
leave-behind: v1
state-scope: chd-deploy-master
status: current
---

# Standing `chd-deploy-master` dashboard instance leave-behind

The single long-running local dashboard deployment on this dev box: podman
container `chd-deploy-master_app_1` (compose project `chd-deploy-master`),
serving the dashboard on host port 5173 while reading `~/.claude` live. It is
the dogfooding target the `recs` SessionStart hook reads
(`http://127.0.0.1:5173/api/recommendations.json`), so keeping it current and
healthy is what makes the injected `[recs]` findings reflect the latest engine.

## Operability

### State and access

- **Running unit:** container `chd-deploy-master_app_1`, podman compose project
  `chd-deploy-master`, host port `5173`. Not managed by systemd (any
  `PODMAN_SYSTEMD_UNIT` label on the container is vestigial — `systemctl --user`
  reports the unit `not-found`).
- **Image currently live (2026-07-31):** `localhost/claude-history-dashboard:local`,
  built by `npm run deploy` from commit `219177a0` (the #3527/#3528/#3529/#3532
  merge set). This is **ahead of the Compose digest pin**, which still points at
  the July-27 published image (`ghcr.io/…@sha256:566ea25b…`). Consequence: any
  pull-path refresh (`chdref`) or bare `up -d --force-recreate` WITHOUT
  `CHD_APP_IMAGE` set will ROLL THE CONTAINER BACK to that older pin until a
  reviewed pin update lands (see Verify and recover, and How to drive it).
- **Deploy origin:** the dedicated master checkout `~/project/chd-deploy-master`
  (kept on `master`, fast-forwarded before deploying; this is what
  `npm run deploy` ran from on 2026-07-31). The main checkout
  `~/project/claude-history-dashboard` is a shared working dir that may sit on a
  detached/stale HEAD — do not deploy from it. (An older
  `~/project/deploy-staging/chd-deploy-master` path in old container labels is
  historical, not a source of truth.)
- **Live data:** host `~/.claude` is bind-mounted in and read live. Before a
  manual compose command, derive the login home with
  `CHD_HOST_HOME="$(getent passwd "$(id -u)" | cut -d: -f6)"` and refuse an
  empty result. The deploy MUST run with `HOME="$CHD_HOST_HOME"` so the bind
  path does not nest to `${HOME}/.claude` (a stray HOME yields a 0-session
  dashboard).
- **Adoption-spool coordination state (new since #3529):** the server's receipt
  drain and the recs SessionStart hook (producer, `~/.agents`
  `skills/recs/scripts/session-start-hook.mjs`, updated by agent-skills#25)
  coordinate through a transient sibling lock file
  `~/.claude/.cache/chd/adoption-spool.jsonl.rotation-lock` (protocol v1,
  contract in `docs/recs-adoption-receipts.md`). Seeing it appear/disappear is
  normal; a file older than ~10 s is stale and is reclaimed automatically.
- **Bind posture (env-controlled):** `BIND_HOST` selects the host interface
  (`127.0.0.1` loopback default, `0.0.0.0` for LAN). The #2064 guard in
  `scripts/server.mjs` refuses to start on an unauthenticated beyond-loopback
  bind, and since #3295 there is **no override** — a LAN bind must configure auth
  (see Credentials/access). Canonical posture is **loopback**; the instance is on
  loopback as of this writing.
- **Credentials/access:** the loopback run needs **no secrets** — reach it at
  `http://127.0.0.1:5173`. LAN exposure REQUIRES HTTP Basic auth via
  `DASHBOARD_USER`/`DASHBOARD_PASS` (locations: shell env / `~/.bashrc`) plus TLS
  terminated at a trusted reverse proxy, so the documented LAN URL is `https://…`;
  without the credentials the server fails closed at boot. Never copy any of these
  values into this file. The `chdref` alias definition lives in `~/.bashrc`.

### Template map

- docker-compose.yml + docker-compose.local.yml (deploy checkout) -> running container `chd-deploy-master_app_1` (compose project `chd-deploy-master`)
- scripts/deploy.sh via `npm run deploy` (deploy checkout at origin/master) -> locally-built `localhost/claude-history-dashboard:local` image + recreated container (includes the host-side repo-map artifact refresh)
- docker-compose.yml's reviewed `ghcr.io/shpwrck/claude-history-dashboard:latest@sha256:...` default -> the immutable published artifact any pull-path or CHD_APP_IMAGE-less recreate selects
- .github/workflows/docker-publish.yml's `:latest` / `:sha-<short>` outputs -> discovery candidates whose resolved digest must land through a reviewed pin update before pull-path deployment
- ~/.bashrc `chdref` alias + `BIND_HOST` (+ `DASHBOARD_USER`/`DASHBOARD_PASS` for a LAN bind) exports -> the refresh command and the container's bind posture
- host ~/.claude -> bind-mounted into the container as the live data source

### Re-run

**Local-build path (what put the current state live — post-merge deploy per
AGENTS.md):**

```bash
( cd ~/project/chd-deploy-master \
  && git pull --ff-only origin master \
  && npm run deploy )
```

`scripts/deploy.sh` already force-recreates; do **NOT** chase it with a bare
`up -d --force-recreate` — without `CHD_APP_IMAGE` that rolls the container back
to the digest pin (this exact mistake happened and was recovered on 2026-07-31).
If a manual recreate is genuinely needed after a local build:

```bash
( cd ~/project/chd-deploy-master \
  && CHD_APP_IMAGE=localhost/claude-history-dashboard:local \
     podman compose -f docker-compose.yml -f docker-compose.local.yml up -d --force-recreate )
```

**Published-image pull path (user-run `chdref`, carries the LAN authorization):**

```bash
( CHD_HOST_HOME="$(getent passwd "$(id -u)" | cut -d: -f6)" \
  && test -n "$CHD_HOST_HOME" \
  && cd ~/project/claude-history-dashboard \
  && HOME="$CHD_HOST_HOME" podman compose -p chd-deploy-master -f docker-compose.yml -f docker-compose.local.yml pull \
  && HOME="$CHD_HOST_HOME" podman compose -p chd-deploy-master -f docker-compose.yml -f docker-compose.local.yml up -d --force-recreate )
```

This tracks the reviewed digest committed in the checkout — it deliberately does
**not** follow later `:latest` retags, and while the local build is ahead of the
pin it is a ROLLBACK. To advance it, wait for `docker-publish.yml`, verify the
candidate image's revision label and registry digest, land the pin update, then
refresh. Prereq for LAN: `BIND_HOST=0.0.0.0` **and** `DASHBOARD_USER`/
`DASHBOARD_PASS` set (exported from `~/.bashrc`), fronted by the TLS reverse
proxy in `docker-compose.tls.yml`; loopback needs none of these.

**Agent-safe loopback recreate** (no guard-disarming flag — see Decisions):

```bash
CHD_HOST_HOME="$(getent passwd "$(id -u)" | cut -d: -f6)" && \
test -n "$CHD_HOST_HOME" && cd ~/project/chd-deploy-master && \
HOME="$CHD_HOST_HOME" BIND_HOST=127.0.0.1 CHD_APP_IMAGE=localhost/claude-history-dashboard:local \
podman compose -p chd-deploy-master -f docker-compose.yml -f docker-compose.local.yml up -d --force-recreate
```

### Verify and recover

- **Health:** `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:5173/api/dashboard-status` → `200`;
  `/api/recommendations.json` should return substantial JSON (~200 KB).
- **Confirm WHICH image is live (the load-bearing check after any recreate):**
  `podman inspect chd-deploy-master_app_1 --format '{{.ImageName}}'` — after a
  local-build deploy it must print `localhost/claude-history-dashboard:local`;
  if it prints the `ghcr.io/…@sha256:…` digest instead, the recreate fell back
  to the pin (stale). Cross-check freshness with
  `podman image inspect localhost/claude-history-dashboard:local --format '{{.Created}}'`.
- **Rolled back to the pin by accident:** re-run the `CHD_APP_IMAGE=localhost/…:local`
  recreate under Re-run; verify `ImageName` again.
- **Crash-loop `Refusing to start … reachable UNAUTHENTICATED`:** bound `0.0.0.0`
  with no `DASHBOARD_USER`/`DASHBOARD_PASS` — the #2064 guard is fail-closed with
  no override (#3295). Recreate on loopback (agent-safe command above) or set the
  credentials behind TLS and re-run `chdref`. Logs:
  `podman logs --tail 25 chd-deploy-master_app_1`.
- **`Address already in use` on 5173:** compose ran under the wrong project name
  and spun a second stack. Always pass `-p chd-deploy-master` (note:
  `npm run deploy` from the `chd-deploy-master` checkout derives that project
  name from the directory automatically).
- **Rollback to a known-good published build:** resolve a `:sha-<short>`
  candidate to its reviewed digest, set
  `CHD_APP_IMAGE=ghcr.io/shpwrck/claude-history-dashboard@sha256:<digest>` for
  `pull` + `up -d --force-recreate`, and verify the baked `GIT_SHA`
  (`podman inspect … | grep '^GIT_SHA='`).
- **Drain health after deploys touching the spool path:**
  `podman logs chd-deploy-master_app_1 | grep -i 'adoption\|spool'` should show
  nothing (silent success); a lingering
  `~/.claude/.cache/chd/adoption-spool.jsonl.rotation-lock` older than ~10 s is
  stale and will be reclaimed by the next drain or hook. A sibling
  `.rotation-lock.reclaim-<dev>-<ino>` should exist only during that removal;
  if it persists, acquisition fails closed pending the orphan-recovery work in
  #3557 rather than risking deletion of a fresh lock.

## Decision log

### Decisions

- **2026-07-31: local build deployed AHEAD of the digest pin.** The four merges
  #3527 (CopyButton flake), #3528 (render-churn verified-port refusal), #3529
  (adoption-spool rotation lock, drain half), #3532 (gate discrimination
  ratchet) were deployed via `npm run deploy` per the AGENTS.md post-merge
  contract; the compose pin still references the July-27 published image. The
  instance intentionally runs the newer local build; converge by landing a
  reviewed pin update for a post-`219177a0` published digest, after which the
  pull path is canonical again.
- **Do not chase `deploy.sh` with a bare force-recreate.** deploy.sh
  force-recreates internally; a follow-up `up -d --force-recreate` without
  `CHD_APP_IMAGE` re-resolves the service to the compose digest pin and rolls
  the deploy back (observed and recovered 2026-07-31; also recorded in project
  memory `deploy-build-needs-force-recreate`).
- **Cross-process spool rotation lock is live on both sides (protocol v1).**
  Server drain (#3529) and the `~/.agents` recs hook (agent-skills#25) now
  coordinate rotation/append through the sibling lock file; constants are a
  cross-repo contract documented in `docs/recs-adoption-receipts.md` — never
  change one side alone. Read-side residual tracked as agent-skills#26.
- **Digest-pinned published-image pull path remains the steady-state.** The
  standing instance normally runs the reviewed CI artifact committed in
  Compose; refresh is a fast pull + recreate without trusting later tag
  movement. `npm run deploy`/`--build` covers post-merge deploys and verifying
  local changes, and creates the ahead-of-pin condition above until the pin
  advances.
- **`HOME="$CHD_HOST_HOME"` is load-bearing** — derive `CHD_HOST_HOME` from the
  login account as shown above; omitting it nests the `~/.claude` bind mount and
  the dashboard reads 0 sessions (looks like missing data, not an error).
- **`-p chd-deploy-master` is load-bearing on manual compose calls** — the
  default project name derived from a different checkout directory spins a
  second stack that collides on port 5173 instead of recreating this one.
- **LAN exposure requires auth; the insecure override is removed (#3295).** A
  beyond-loopback bind MUST set `DASHBOARD_USER`/`DASHBOARD_PASS` behind a
  TLS-terminating reverse proxy; the #2064 guard fails the boot closed
  otherwise. The former `DASHBOARD_ALLOW_INSECURE_BIND=1` mode is prohibited
  legacy and inert.
- **The agent-safe posture is loopback.** Restoring LAN reachability is the
  user's `chdref` call with credentials configured; an agent binding `0.0.0.0`
  inline is denied by the auto-mode safety classifier, and an unauthenticated
  LAN bind cannot start regardless.

### How to drive it

Routine refresh after dashboard code lands on master — two modes:

1. **Immediate (local build, what agents do post-merge):** fast-forward
   `~/project/chd-deploy-master`, run `npm run deploy`, then ALWAYS verify
   `podman inspect … --format '{{.ImageName}}'` prints
   `localhost/claude-history-dashboard:local` and `/api/dashboard-status`
   returns 200. Do not add a manual force-recreate afterward.
2. **Converge to the reviewed pin (user-driven):** wait for
   `docker-publish.yml` to publish the merge commit
   (`gh run list --workflow=docker-publish.yml --branch master`), verify the
   candidate's revision label + registry digest, land the digest in the Compose
   pin, then run `chdref` (pull + recreate) and confirm the baked `GIT_SHA`
   matches the pin's commit.

While mode 1's build is ahead of the pin, treat any pull-path refresh as a
rollback. To change exposure posture, edit the `~/.bashrc` exports (including
`DASHBOARD_USER`/`DASHBOARD_PASS` for LAN) and re-run `chdref` once — never
hand-edit the container. Record notable deploy events by updating this file in
a docs PR, not by leaving them in session transcripts.
