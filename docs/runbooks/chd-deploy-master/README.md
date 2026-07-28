---
leave-behind: v1
state-scope: chd-deploy-master
status: current
---

# Standing `chd-deploy-master` dashboard instance leave-behind

The single long-running local dashboard deployment on this dev box: podman
container `chd-deploy-master_app_1` (compose project `chd-deploy-master`),
serving the dashboard on host port 5173 from the published image while reading
`~/.claude` live. It is the dogfooding target the `recs` SessionStart hook reads
(`http://127.0.0.1:5173/api/recommendations.json`), so keeping it current and
healthy is what makes the injected `[recs]` findings reflect the latest engine.

## Operability

### State and access

- **Running unit:** container `chd-deploy-master_app_1`, podman compose project
  `chd-deploy-master`, currently named
  `ghcr.io/shpwrck/claude-history-dashboard:latest`, host port `5173`. The next
  recreate from a checkout containing #3066 selects the reviewed digest committed
  in `docker-compose.yml` instead of resolving that tag again. Not managed by
  systemd (any `PODMAN_SYSTEMD_UNIT` label on the container is vestigial —
  `systemctl --user` reports the unit `not-found`).
- **Deploy origin:** driven from the main checkout `~/project/claude-history-dashboard`
  with the repo's committed `docker-compose.yml` + `docker-compose.local.yml`.
  (An older sibling checkout `~/project/deploy-staging/chd-deploy-master` still
  shows in the container's compose-config-files label from a past refresh; the
  live `chdref` path uses the main checkout — treat deploy-staging as historical,
  not the source of truth.)
- **Live data:** host `~/.claude` is bind-mounted in and read live. The deploy
  MUST run with `HOME=/home/jskrzypek` so the bind path does not nest to
  `${HOME}/.claude` (a stray HOME yields a 0-session dashboard).
- **Bind posture (env-controlled):** `BIND_HOST` selects the host interface
  (`127.0.0.1` loopback default, `0.0.0.0` for LAN); `DASHBOARD_ALLOW_INSECURE_BIND`
  is the override for the #2064 guard that otherwise refuses an unauthenticated
  beyond-loopback bind. Both are exported in `~/.bashrc` for a deliberate
  trusted-network LAN demo. As of this writing the instance is on **loopback**.
- **Credentials/access:** the loopback run needs **no secrets** — reach it at
  `http://127.0.0.1:5173`. For LAN exposure the safer path is HTTP Basic auth via
  `DASHBOARD_USER`/`DASHBOARD_PASS` (locations: shell env / `~/.bashrc`; not
  currently set — the LAN demo instead uses `DASHBOARD_ALLOW_INSECURE_BIND=1`).
  Never copy any of these values into this file. The `chdref` alias definition
  itself lives in `~/.bashrc`.

### Template map

- docker-compose.yml + docker-compose.local.yml (main checkout) -> running container `chd-deploy-master_app_1` (compose project `chd-deploy-master`)
- ~/.bashrc `chdref` alias + `BIND_HOST` / `DASHBOARD_ALLOW_INSECURE_BIND` exports -> the refresh command and the container's bind posture
- docker-compose.yml's reviewed `ghcr.io/shpwrck/claude-history-dashboard:latest@sha256:...` default -> the immutable published artifact the next recreate selects
- .github/workflows/docker-publish.yml's `:latest` / `:sha-<short>` outputs -> discovery candidates whose resolved digest must land through a reviewed pin update before deployment
- host ~/.claude -> bind-mounted into the container as the live data source

### Re-run

**Canonical (user-run, carries the LAN authorization) — the `chdref` alias:**

```bash
( cd ~/project/claude-history-dashboard \
  && HOME=/home/jskrzypek podman compose -p chd-deploy-master -f docker-compose.yml -f docker-compose.local.yml pull \
  && HOME=/home/jskrzypek podman compose -p chd-deploy-master -f docker-compose.yml -f docker-compose.local.yml up -d --force-recreate )
```

Prereq for LAN: `BIND_HOST=0.0.0.0` and `DASHBOARD_ALLOW_INSECURE_BIND=1` present
in the shell env (they are exported from `~/.bashrc`). Loopback needs neither.
This is the published-image **pull** path (no `--build`), so the instance tracks
the reviewed digest committed in the checkout. It deliberately does **not**
follow later `:latest` retags. To advance it, wait for `docker-publish.yml`,
verify the candidate image's revision label and registry digest, land the pin
update, then refresh.

**Agent-safe loopback recreate** (no guard-disarming flag — see Decisions):

```bash
cd ~/project/claude-history-dashboard && \
HOME=/home/jskrzypek BIND_HOST=127.0.0.1 podman compose -p chd-deploy-master -f docker-compose.yml -f docker-compose.local.yml up -d --force-recreate
```

### Verify and recover

- **Health:** `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:5173/api/dashboard-status` → `200`.
- **Confirm the intended build is live:** `podman inspect chd-deploy-master_app_1 --format '{{range .Config.Env}}{{println .}}{{end}}' | grep '^GIT_SHA='` should equal the reviewed commit recorded next to the Compose digest pin; `/api/recommendations.json` should return a JSON array.
- **Crash-loop `Refusing to start … reachable UNAUTHENTICATED`:** the container is bound `0.0.0.0` but `DASHBOARD_ALLOW_INSECURE_BIND=1` did not reach compose interpolation. Fix: recreate on loopback (agent-safe command above), or re-run `chdref` in a shell that has the `~/.bashrc` exports. Read logs with `podman logs --tail 25 chd-deploy-master_app_1`.
- **`Address already in use` for host TCP 5173:** the compose ran under the wrong project name (e.g. the default `claude-history-dashboard` from the checkout dir), so it tried a second stack while the standing container still held the port. Always pass `-p chd-deploy-master`, which recreates in place.
- **Rollback:** resolve a known-good `:sha-<short>` candidate to its reviewed
  digest, set `CHD_APP_IMAGE=ghcr.io/shpwrck/claude-history-dashboard@sha256:<digest>`
  for both the `pull` and `up -d` commands, and verify the baked `GIT_SHA`.

## Decision log

### Decisions

- **Digest-pinned published-image pull path, not `--build`.** The standing
  instance runs the reviewed CI artifact committed in Compose; refresh is a
  fast pull + recreate without trusting later tag movement. `npm run
  deploy`/`--build` is for verifying uncommitted local frontend changes, not
  this instance.
- **`HOME=/home/jskrzypek` is load-bearing** — omitting it nests the `~/.claude`
  bind mount and the dashboard reads 0 sessions (looks like missing data, not an
  error).
- **`-p chd-deploy-master` is load-bearing** — the default compose project name
  derived from the checkout directory is different, so an unprefixed `up` spins a
  second stack that collides on port 5173 instead of recreating this one.
- **LAN exposure is deliberate but guard-gated.** `0.0.0.0` +
  `DASHBOARD_ALLOW_INSECURE_BIND=1` (both exported in `~/.bashrc`) is an opt-in
  trusted-network demo; the #2064 guard in `scripts/server.mjs` refuses an
  unauthenticated beyond-loopback bind otherwise. Rejected safer alternative kept
  on the table: Basic auth via `DASHBOARD_USER`/`DASHBOARD_PASS`.
- **Agents must not disarm the guard.** Passing `DASHBOARD_ALLOW_INSECURE_BIND=1`
  + `0.0.0.0` inline from an agent is denied by the Claude Code auto-mode safety
  classifier (guard-disarming / expose-local-services) unless the user named the
  flag in-task — the `~/.bashrc` export does not count as in-task consent. The
  agent-safe posture is loopback; restoring LAN reachability is the user's
  `chdref` call.

### How to drive it

Routine refresh after dashboard code lands on master: (1) wait for
`docker-publish.yml` to publish the candidate for the merge commit
(`gh run list --workflow=docker-publish.yml --branch master`); (2) verify its
baked revision and registry digest, then land that digest in the Compose pin;
(3) **as the user**, run `chdref` to pull + recreate with the LAN posture, or
run the agent-safe loopback command above if you are an agent; (4) verify `200`
on `/api/dashboard-status` and that `GIT_SHA` matches the pin's reviewed
commit; (5) if it crash-loops, check `BIND_HOST` / insecure-flag propagation
per Verify and recover. To change the exposure posture, edit the `~/.bashrc`
exports (or add `DASHBOARD_USER`/`DASHBOARD_PASS`) and re-run `chdref` once —
do not hand-edit the container.
