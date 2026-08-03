---
leave-behind: v1
state-scope: chd-deploy-master
status: current
---

# Standing `chd-deploy-master` dashboard instance leave-behind

The single long-running local dashboard deployment on this dev box: podman
container `claude-history-dashboard_app_1` (compose project
`claude-history-dashboard`), serving the dashboard on host port 5173 while
reading `~/.claude` live. It is the dogfooding target the `recs` SessionStart
hook reads (`http://127.0.0.1:5173/api/recommendations.json`), so keeping it
current and healthy is what makes the injected `[recs]` findings reflect the
latest engine.

> **Box migration (2026-08-03).** The instance moved to a new machine: the
> current host account uses `$HOME`, host uid **104177** (not 1000), SELinux
> **Enforcing**, checkout at `~/workdir/claude-history-dashboard`,
> podman-compose 1.5.0. Container and compose-project names changed to the
> defaults derived from that checkout dir (`claude-history-dashboard[_app_1]`);
> the old box's `chd-deploy-master` project name, `~/project/*` checkouts, and
> `chdref` alias are retired. Earlier revisions of this file describe the old
> box — treat them as historical. The state-scope name stays
> `chd-deploy-master` (artifact identity, not the compose project name).

## Operability

### State and access

- **Running unit:** container `claude-history-dashboard_app_1`, podman compose
  project `claude-history-dashboard` (default from the checkout dir — do NOT
  pass `-p chd-deploy-master` on this box; that would spin a second stack that
  collides on port 5173). Not managed by systemd; `restart: unless-stopped`
  only, so after a reboot the container stays down until re-run.
- **Image currently live (2026-08-03, later same day):**
  `ghcr.io/shpwrck/claude-history-dashboard@sha256:8bf60c662e30f43d4cd10db66effd6af4714c688d7c11d8e1d9ce87c31119bea`
  — the published `:latest` for master `08c8dbbe` (baked `GIT_SHA` confirms it),
  selected explicitly via `CHD_APP_IMAGE`. Replaces the earlier same-day
  `…@sha256:e4b7e3b7…` (master `7ae189e8`); re-pulled so the box would run the
  #3588 recommendation-surface fix. This is **ahead of the committed Compose
  digest pin**
  (July-27 `…@sha256:566ea25b…`), so any recreate WITHOUT `CHD_APP_IMAGE` set
  ROLLS BACK to the pin until a reviewed pin update lands (same ahead-of-pin
  condition as 2026-07-31, now via pull instead of local build).
- **Deploy origin:** the checkout `~/workdir/claude-history-dashboard`
  (fast-forwarded to `origin/master` before deploying), with the repo's
  committed `docker-compose.yml` + `docker-compose.local.yml` **plus two
  box-local artifacts** (both outside the repo, both load-bearing):
  - `~/.local/share/chd/compose.box-override.yml` — third compose file setting
    `userns_mode: "keep-id:uid=1000,gid=1000"` (host uid 104177 ≠ the image's
    `node`/1000, so plain `keep-id` leaves `~/.claude` unreadable in the
    container) and `security_opt: label=disable` (SELinux Enforcing denies the
    unlabeled bind mount even where DAC allows; a per-container exemption
    beats `:z`-relabeling the user's real `~/.claude`).
  - `~/.local/share/chd/claude-dir-shim/` — one symlink literally named
    `.claude}` pointing at `~/.claude`. Works around podman-compose 1.5.0
    mis-parsing the volume `${CLAUDE_DIR:-${HOME}/.claude}` into
    `<CLAUDE_DIR value>/.claude}` (issue #3580; unset CLAUDE_DIR hard-errors
    instead). With `CLAUDE_DIR=~/.local/share/chd/claude-dir-shim` the mangled
    path resolves through the symlink to the real `~/.claude`. Without it the
    container mounts a nonexistent path and serves an **empty-but-healthy**
    dashboard.
- **Registry access:** the GHCR package is private; pulls require a
  `read:packages`-scoped token (granted 2026-08-03 via user-run
  `gh auth refresh -h github.com -s read:packages`; credential lives in the
  `gh` keyring). Login: `gh auth token | podman login ghcr.io -u shpwrck
  --password-stdin`. Under-scoped tokens fail MISLEADINGLY — `manifest
  unknown` on digest pulls, `denied` on tag pulls — which looks like a dead
  pin, not a scope problem (#3581, retraction in #3579).
- **Live data:** host `~/.claude` bind-mounted read-only at
  `/home/node/.claude` (via the shim), `~/.claude.json` read-only,
  `~/.claude/.cache/chd` read-write as the adoption store. The SQLite ingest
  cache is the named volume `claude-history-dashboard_cache` — **regenerable
  by design**; after any uid-mapping change delete it, or the server
  crash-loops on `unable to open database file`.
- **Adoption-spool coordination state (#3529):** the server's receipt drain
  and the recs SessionStart hook coordinate through a transient lock
  `~/.claude/.cache/chd/adoption-spool.jsonl.rotation-lock` (protocol v1,
  contract in `docs/recs-adoption-receipts.md`). Appearing/disappearing is
  normal; >~10 s old is stale and auto-reclaimed.
- **Bind posture:** loopback (`127.0.0.1:5173`), no secrets needed. The #2064
  guard refuses an unauthenticated beyond-loopback bind and since #3295 there
  is **no insecure override**; LAN exposure requires `DASHBOARD_USER`/
  `DASHBOARD_PASS` (locations: shell env; not set on this box) behind a
  TLS-terminating proxy. No `BIND_HOST` exports exist in `~/.bashrc` here; the
  old box's LAN posture was not migrated.
- **Port conflict to know about:** the Claude Code plugin's node server
  (`~/.claude/plugins/marketplaces/claude-history-dashboard/scripts/plugin-ctl.mjs
  start`, also reachable via the `/claude-history-dashboard:dashboard` slash
  command) serves the same port 5173 from the plugin's static `dist`. Stop it
  (`… plugin-ctl.mjs stop`) before `compose up`; prefer the container as the
  standing instance.

### Template map

- docker-compose.yml + docker-compose.local.yml (checkout) + ~/.local/share/chd/compose.box-override.yml -> running container `claude-history-dashboard_app_1` (compose project `claude-history-dashboard`)
- ~/.local/share/chd/claude-dir-shim/.claude} symlink + CLAUDE_DIR env in the re-run command -> the container's /home/node/.claude mount resolving to the real ~/.claude
- CHD_APP_IMAGE env (explicit `ghcr.io/…@sha256:<digest>` of the verified published build, or `localhost/claude-history-dashboard:local` after `npm run deploy`) -> the image the container actually runs, ahead of the committed pin
- docker-compose.yml's reviewed `ghcr.io/…:latest@sha256:…` default -> the artifact any CHD_APP_IMAGE-less recreate silently rolls back to
- .github/workflows/docker-publish.yml `:latest` / `:sha-<short>` outputs -> discovery candidates; land a reviewed pin update before making the pull path CHD_APP_IMAGE-less
- host ~/.claude -> bind-mounted into the container as the live data source

### Re-run

**Published-image path (what put the current state live, 2026-08-03):**

```bash
cd ~/workdir/claude-history-dashboard \
  && git -C ~/workdir/claude-history-dashboard fetch origin \
  && git -C ~/workdir/claude-history-dashboard merge --ff-only origin/master \
  && gh auth token | podman login ghcr.io -u shpwrck --password-stdin \
  && podman pull ghcr.io/shpwrck/claude-history-dashboard:latest \
  && DIGEST=$(podman image inspect ghcr.io/shpwrck/claude-history-dashboard:latest --format '{{.Digest}}') \
  && CLAUDE_DIR=$HOME/.local/share/chd/claude-dir-shim \
     CHD_APP_IMAGE=ghcr.io/shpwrck/claude-history-dashboard@$DIGEST \
     podman-compose -f docker-compose.yml -f docker-compose.local.yml \
       -f ~/.local/share/chd/compose.box-override.yml up -d --force-recreate
```

**Local-build path (post-merge deploys / verifying local changes):** run
`npm ci` then `scripts/deploy.sh` from the checkout with
`CLAUDE_DIR=$HOME/.local/share/chd/claude-dir-shim
CHD_APP_IMAGE=localhost/claude-history-dashboard:local` — **then ALWAYS chase
it** with the same three-file `up -d --force-recreate` above (keeping
`CHD_APP_IMAGE=localhost/claude-history-dashboard:local`): `deploy.sh` only
knows the two repo compose files, so its own recreate lacks the box override
and comes up unable to read `~/.claude`. (This inverts the old box's "do not
chase deploy.sh" rule — here the chase IS the fix, because it must re-apply
the override. Keep `CHD_APP_IMAGE` set in both steps or the chase rolls back
to the pin.)

### Verify and recover

- **Health:** `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:5173/healthz`
  → `200`. Do NOT use `/api/dashboard-status` — that route no longer exists
  and falls through to the SPA HTML with a 200, so it false-passes.
- **Confirm real data is being read (the load-bearing check):**
  `curl -s http://127.0.0.1:5173/api/dataset.json | python3 -c "import json,sys; print(len(json.load(sys.stdin)['entries']))"`
  must be **> 0** (1905, then 1913 later the same day, on 2026-08-03). This
  deployment's signature failure
  mode is *empty-but-healthy* — healthz 200, SPA loads, zero sessions — caused
  by a missing shim, a recreate without the box override, or (pre-migration)
  a nested `${HOME}` bind path.
- **Confirm WHICH image is live:** `podman inspect claude-history-dashboard_app_1
  --format '{{.ImageName}}'` must print the explicit `CHD_APP_IMAGE` value
  (currently the `…@sha256:8bf60c66…` digest); the committed-pin digest
  instead means an accidental rollback — re-run with `CHD_APP_IMAGE` set.
  Cross-check the baked commit:
  `podman inspect claude-history-dashboard_app_1 --format '{{range .Config.Env}}{{println .}}{{end}}' | grep '^GIT_SHA='`.
- **Crash-loop `unable to open database file`:** stale ingest-cache volume
  from a previous uid mapping. `podman rm -f claude-history-dashboard_app_1 &&
  podman volume rm claude-history-dashboard_cache`, then re-run. The volume is
  regenerable; adoption receipts live on the host bind mount, not in it.
- **`Permission denied` on /home/node/.claude inside the container:** the
  recreate ran without the box override — re-run with all three `-f` files.
- **Mount source ends in `.claude}`:** expected (the shim). Verify
  `readlink ~/.local/share/chd/claude-dir-shim/.claude}` →
  `$HOME/.claude`.
- **`manifest unknown` / `denied` from ghcr.io:** almost certainly token
  scope, not a dead pin — re-run the login above; the user grants
  `read:packages` via `gh auth refresh` if missing (#3581).
- **`Address already in use` on 5173:** either the plugin-ctl node server is
  running (`… plugin-ctl.mjs stop`) or a second compose stack was created
  under a different `-p` name (`podman ps -a`, remove the stray stack).
- **Rollback:** resolve a `:sha-<short>` tag to its digest, set it as
  `CHD_APP_IMAGE`, and re-run; or re-tag a previous local image ID.

## Decision log

### Decisions

- **2026-08-03: box migration fixed with box-local artifacts, not repo
  edits.** Three independent breakages left the migrated container
  empty-but-healthy or unrunnable: (1) podman-compose 1.5.0 mangles the
  `${CLAUDE_DIR:-${HOME}/.claude}` volume (#3580) → the `claude-dir-shim`
  symlink; (2) host uid 104177 breaks plain `keep-id` → `keep-id:uid=1000`;
  (3) SELinux Enforcing denies the unlabeled mount → `label=disable`, chosen
  over `:z` because relabeling the real `~/.claude` drifts as host processes
  create new files. All three live under `~/.local/share/chd/`; the repo
  compose files stay clean and the upstream bugs are filed (#3580).
- **2026-08-03: published-pull path restored; runs `:latest` by explicit
  digest, ahead of the pin.** The pull path was blocked by a missing
  `read:packages` scope whose GHCR errors masqueraded as a dead digest pin —
  #3579 filed on that misdiagnosis and closed with a retraction; the docs
  footgun is #3581. With the scope granted the instance runs the verified
  published build for master HEAD via `CHD_APP_IMAGE`, keeping the committed
  pin as the reviewed rollback target until a pin update lands.
- **2026-08-03: read this runbook BEFORE hand-patching compose — the three
  host facts reproduce in order.** Verifying the #3588 fix, a session skipped
  the documented three-file `up` and instead deployed hand-patched copies of
  the repo compose files. That re-derived all three migration breakages the
  hard way, in sequence: the #3580 mis-parse (`volume [${HOME/.claude}] not
  defined in top level`), then the uid mismatch (crash-loop `unable to open
  database file`), then the SELinux denial (`Permission denied` on
  `/home/node/.claude`, visible as AVC `container_t` → `user_home_t` and as an
  *empty-but-healthy* dashboard reporting 1 recommendation instead of 39).
  Each has a documented one-line remedy above. Re-running the documented
  local-build path plus its chase restored the instance; the box-override and
  shim were never at fault. The cost is entirely avoidable: the Re-run section
  is the entry point, not a fallback.
- **Cache volume is disposable.** `claude-history-dashboard_cache` holds only
  the regenerable SQLite ingest cache; deleting it is the sanctioned fix for
  uid-mapping changes (crash-loop `unable to open database file`, hit and
  fixed 2026-08-03).
- **Cross-process spool rotation lock is live on both sides (protocol v1,
  #3529).** Server drain and the `~/.agents` recs hook coordinate through the
  sibling lock file; constants are a cross-repo contract in
  `docs/recs-adoption-receipts.md` — never change one side alone.
- **LAN exposure requires auth; the insecure override is removed (#3295).**
  A beyond-loopback bind MUST set `DASHBOARD_USER`/`DASHBOARD_PASS` behind
  TLS; the guard fails closed otherwise. The agent-safe posture is loopback;
  restoring LAN reachability is the user's call with credentials configured.
- **Historical (old box, superseded):** dedicated `~/project/chd-deploy-master`
  checkout, `-p chd-deploy-master` project pinning, `chdref` alias,
  `CHD_HOST_HOME` HOME-derivation, and the 2026-07-31 "do not chase deploy.sh"
  rule — all replaced by the current box's checkout/default-project/box-override
  discipline above. The HOME nesting hazard is moot here only because the
  shim supplies an absolute `CLAUDE_DIR`.

### How to drive it

Routine refresh after dashboard code lands on master: (1) wait for
`docker-publish.yml` on the merge commit
(`gh -R shpwrck/claude-history-dashboard run list --workflow=docker-publish.yml --branch master`);
(2) run the published-image Re-run block above (fast-forward, login, pull,
three-file recreate with the pulled digest as `CHD_APP_IMAGE`); (3) verify
`/healthz` 200, `entries > 0`, and `GIT_SHA` == the merge commit; (4) walk
Verify and recover on any miss — the causes are enumerated there. Converge to
the committed pin only through a reviewed pin-update PR, after which a
CHD_APP_IMAGE-less recreate is safe again. Record notable deploy events by
updating this file in a docs PR, not by leaving them in session transcripts.
