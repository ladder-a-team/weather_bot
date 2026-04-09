# AGENTS.md

Instructions for AI coding agents (Claude, Cursor, Codex, etc.) working on
this repository.

---

## Repositories

- **This fork:** <https://github.com/ladder-a-team/weather_bot>
  This is the deployed fork. All changes committed by agents go here.
- **Upstream / source:** <https://github.com/alteregoeth-ai/weatherbot>
  The original project. Agents should treat it as an inspiration source,
  not a direct merge target.

---

## Environments

There are **two** running instances of this bot, both identical in code and
config — only the host filesystem (and therefore `./data/`) differs.

| Env | Where | Data volume | Purpose |
|---|---|---|---|
| **Staging** | User's Mac, `docker compose` in the repo working tree. Dashboard at `http://localhost:8050`. | `./data/` on the Mac | The environment an agent is interacting with by default. Safe to reset, rescan, break, rebuild. |
| **Production** | A separate VPS (hostname intentionally NOT stored in this repo). | `./data/` on the VPS (own markets / state / calibration, never touched from staging) | Live paper-trading against real Polymarket markets. Do not touch without an explicit instruction from the user. |

### Important consequences

- **Same code path runs in both envs.** There is no `if ENV == "prod"`
  branch, no feature flag, no staging-only config. Both containers ship
  from the same git commit. If a change is merged to `main`, it is ready
  for prod on the next manual deploy.
- **Data is never shared.** The two `./data/` directories are separate
  filesystems. Resetting staging via the dashboard RESET button has zero
  effect on production.
- **Do not assume the VPS host.** The hostname, IP, SSH user, and any
  credentials are intentionally kept out of the repo. If an agent needs
  to refer to the VPS in a discussion with the user, it should say
  "the production VPS" and let the user fill in specifics if they want.
  Never `curl` or `ssh` anywhere that looks like it might be production
  without an explicit user instruction naming that host in the current
  conversation.

### Promoting staging → production

Deploys are entirely manual. There is no CI, no auto-pull, no webhook.
When the user says "deploy to prod" or equivalent, the agent should
walk through this checklist **with the user**, not execute it
unilaterally:

1. Confirm the commit currently on `ladder/main` is the one the user
   wants to ship. `git log --oneline -10` is enough for context.
2. Remind the user that the prod data volume is separate — whatever
   markets/state are on the VPS stay as they are unless explicitly
   reset there.
3. The user SSHes into the VPS and runs, from the repo directory:
   ```bash
   git pull
   docker compose build
   docker compose up -d
   ```
   (A plain `docker compose up -d --build` works too.)
4. After the restart, check the prod dashboard (user knows the URL).
   Verify `data.version` matches the commit just deployed and that
   `bot_status.running` is `true` with a recent `heartbeat_age`.
5. If anything goes wrong, the user can roll back with
   `git checkout <previous-sha>` + `docker compose up -d --build` on
   the VPS. Do **not** suggest rolling back via `git push --force` on
   the repo — that would also rewrite staging's history.

### Things an agent must NOT do to production

- Never trigger `/api/admin/reset` against production. That endpoint
  is unauthenticated; if the agent somehow has network access to a
  prod URL, it is still off-limits without an explicit, in-conversation
  instruction naming the host.
- Never run `docker compose down -v`, `git clean`, `rm -rf data/`, or
  any other destructive command on the VPS. Same rule: only with an
  explicit, named instruction.
- Never edit config.json on the VPS without the user reviewing the
  diff first. The Visual Crossing key lives there.

---

## Upstream check — what to do, what NOT to do

When a user asks an agent to "look for updates", "check upstream", "sync from
source", or otherwise implies they want to know what's new in the source
project, the agent should:

1. Fetch the upstream commit log since our last check, e.g.
   ```bash
   git ls-remote https://github.com/alteregoeth-ai/weatherbot.git HEAD
   git fetch https://github.com/alteregoeth-ai/weatherbot.git main:upstream-main
   git log --oneline ladder/main..upstream-main
   ```
   or, if `git fetch` is not convenient:
   ```bash
   curl -s https://api.github.com/repos/alteregoeth-ai/weatherbot/commits?per_page=20
   ```
2. **Summarise** what's new — new features, bug fixes, refactors, new files
   or renamed files, changes to the public data schema (market JSON shape,
   state.json, heartbeat fields), changes to the Open-Meteo model list or
   any API contracts.
3. **Show the summary to the user and wait for instructions.** Do NOT start
   cherry-picking, merging, or rewriting code automatically. The user
   decides what, if anything, gets ported over.
4. When the user picks features to port:
   - Re-implement them in the style of this fork (atomic writes, local-time
     dates, ensemble-aware `bucket_prob`, Docker setup, etc. — see the
     commit history for our conventions).
   - Never wholesale replace files from upstream without review — the two
     trees have diverged significantly (ensemble σ, heartbeat, admin
     endpoints, version badge, sortable tables, collapsible chart).
   - Preserve our `version.py` bump rhythm and the commit message style
     described below.

### Explicit non-goals for the upstream check

- Do **not** set up any automation that runs this check on a schedule. If
  the user wants a recurring reminder, they can schedule it themselves
  with `cron`, a scheduled task, or a hook — the agent should never
  introduce background polling of a remote repo on its own.
- Do **not** `git pull --rebase` or `git merge` from upstream without
  explicit user approval of each commit. The histories are unrelated
  (different authors, different directory structure assumptions).
- Do **not** blindly copy upstream's `config.json`, `requirements.txt`,
  or `Dockerfile` — ours have fork-specific pins and paths.
- Do **not** run upstream's tests or scripts without sandboxing; we cannot
  assume upstream is safe to execute.

---

## Conventions for agents editing this repo

### Code style and structure

- Python source lives at the top level: `bot_v2.py` (main bot),
  `dashboard.py` (FastAPI dashboard), `version.py` (single source of
  truth for `__version__`).
- Frontend: `templates/index.html`, `static/style.css`, `static/dashboard.js`.
  Vanilla HTML/CSS/JS, no build step.
- Keep `bot_v2.py` and `dashboard.py` aligned on:
  - `__version__` from `version.py`
  - `LOCATIONS` dict (mirrored for now — keep them in sync if adding cities)
  - forecast snapshot field names (`ecmwf`, `graphcast`, `hrrr`, `ens_mean`,
    `ens_std`, `ens_n`, `metar`, `best`, `best_source`)
- Every write to `data/*.json` must go through `_atomic_write_json()` or an
  equivalent temp+rename pattern. Never `path.write_text()` directly on
  files the dashboard watcher is monitoring.

### bucket_prob and probability

- `bucket_prob()` accepts either a static `sigma` OR an `ens={mean, std}`
  dict. **Always** prefer ensemble mode when `snap["ens_mean"]` and
  `snap["ens_std"]` are available. The MAE-calibrated sigma path is a
  cold-start fallback.
- The ensemble std is floored at 0.8 °F / 0.5 °C — do not remove that
  floor without running a backtest; it prevents over-confidence when the
  ensemble clusters unrealistically tight.

### Version bumps

- Bump `version.py` whenever you land a user-visible change (new endpoint,
  new UI element, changed data schema, new forecast source).
  - Patch (0.x.Y → 0.x.Y+1): pure bug fix, no schema change.
  - Minor (0.X.y → 0.X+1.0): new feature or new endpoint.
  - Major: reserved; don't bump without asking the user.
- The startup banner, heartbeat, and dashboard status bar all read from
  `version.py`. No separate strings to update.

### Commit messages

Follow the existing style (see `git log --oneline`):

- `feat:` new user-visible functionality
- `fix:` bug fix
- `chore:` non-code housekeeping (gitignore, CI, docs)
- `docs:` README / AGENTS changes only
- Body should explain **why**, not just what. Multi-paragraph is fine.
- Never skip hooks or bypass signing. Never force-push to `main`.

### Data / runtime state

- `data/` is bind-mounted into both bot and dashboard containers. Writes
  from the bot are visible to the dashboard via `watchfiles` (and the
  dashboard ignores `*.tmp` files to dodge double events from atomic
  writes).
- `data/heartbeat.json` is the bot's liveness signal. The dashboard reads
  its mtime and the fields inside to tell if the bot is alive across
  PID namespaces. Do not touch its schema lightly.
- `data/rescan.request` is a one-shot trigger file the dashboard drops
  when the user clicks RESCAN. The bot *peeks* for it inside its sleep
  loop and *consumes* it at the top of the main loop. Preserve this
  split or the "manual rescan requested via dashboard" log line will
  stop firing.

### Docker

- `bot` and `dashboard` share the same `weatherbet:latest` image. Only the
  `bot` service carries `build: .`; the `dashboard` reuses the tag. Adding
  `build:` to both causes a tag race on `docker compose build`.
- `config.json` is COPY'd as the **last** image layer so editing it does
  not bust the cache for source layers above. It is also bind-mounted at
  runtime so `docker compose restart bot` is enough for config changes.
- `HEALTHCHECK` lives in `docker-compose.yml` on the `dashboard` service
  only (using `python -c urllib.request ... /api/state`). Don't move it
  into the Dockerfile — it would then run in the bot container too and
  always fail.

### Security notes for agents

- Admin endpoints (`/api/admin/rescan`, `/api/admin/reset`) are
  **intentionally unauthenticated** for local / trusted-network use. If
  a user asks you to expose the dashboard publicly, you must add a
  shared-secret header check on those two endpoints before doing so.
- `config.json` holds a Visual Crossing API key. Do not paste its
  contents into commit messages, PR bodies, or log output.

---

## What to remember across sessions

- **You are in staging by default.** The bot + dashboard the agent
  interacts with are the Docker containers on the user's Mac,
  dashboard at `http://localhost:8050`. Safe to break.
- **Production exists on a separate VPS.** Same code, same config,
  separate `data/`. Never deploy to it, reset it, or run commands
  against it without an explicit, named instruction from the user in
  the current conversation. See the Environments section above.
- **One branch: `main`.** There is no `staging` branch — environment
  separation is by host, not by git ref. A merge to `main` is
  immediately available for manual deploy to prod.
- The user prefers concise summaries over verbose step-by-step narration.
  Lead with what changed and what to look at; put the "why" second.
