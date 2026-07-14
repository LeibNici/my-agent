#!/usr/bin/env bash
# Docker-based redeploy for the 244 host — disk there is shared with other
# projects (natfrp/kkfileview/xinchuan-dev), so every rebuild's dangling
# image + build cache must be reclaimed immediately after, not left to pile
# up. Run this FROM the deploy checkout (e.g. /opt/my-agent), not the repo
# root you develop in.
set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "==> git pull (fast-forward only)"
before_sha="$(git rev-parse HEAD)"
git pull --ff-only
after_sha="$(git rev-parse HEAD)"

# Self-modification race: this script IS one of the files `git pull` just
# rewrote on disk, but the bash process already executing it had buffered
# earlier content into memory — bash doesn't necessarily re-read a script
# file line-by-line as it runs, so lines added below THIS point by the
# pull just now can silently never execute during this exact invocation
# (confirmed: engine/.git-sha never got written on the deploy that first
# added the next line, even though the pull itself succeeded and the build
# went on to complete normally). Re-exec once with the freshly-pulled
# content so every line after this point is guaranteed to be the new
# version — the DEPLOY_SH_REEXECED guard stops this from looping forever
# (the second run's pull is a no-op, so before_sha==after_sha and it falls
# through instead of re-execing again).
if [ "$before_sha" != "$after_sha" ] && [ -z "${DEPLOY_SH_REEXECED:-}" ]; then
  echo "==> deploy.sh changed — re-executing the freshly-pulled script"
  export DEPLOY_SH_REEXECED=1
  exec bash "${BASH_SOURCE[0]}"
fi

# So the running site can show which commit it's actually serving (see
# app.ts's readGitSha comment) — the container has no .git of its own
# (Dockerfile only COPYs engine/ and web/, not the whole repo), so this
# file is the only way it finds out. Written into engine/ so the existing
# `COPY engine/ ./` picks it up with no Dockerfile change; gitignored so
# it never becomes a tracked/committed file.
git rev-parse HEAD > engine/.git-sha

# Codex full-repo review (2026-07-14, Warning): docker-compose.yml's
# ./data/agent_data.db and ./data/jwt_secret are FILE bind-mounts — Docker
# only bind-mounts an existing host path; if the source doesn't exist yet
# (true on a genuinely first-ever deploy, since data/ is gitignored and so
# never present in a fresh checkout) it silently creates a DIRECTORY at
# that path instead of erroring, which then breaks both better-sqlite3
# (can't open a directory as a db file) and jwt-secret loading. touch is
# safe to run unconditionally on every deploy, not just the first — it
# never truncates an already-existing file, only creates what's missing.
echo "==> ensuring data/ bind-mount targets exist (first-deploy safety)"
mkdir -p data/repos
touch data/agent_data.db data/jwt_secret

echo "==> docker compose build"
docker compose build

echo "==> docker compose up -d"
docker compose up -d

echo "==> waiting for the service to come up"
ok=false
for _ in $(seq 1 30); do
  if docker compose logs --tail 50 2>&1 | grep -q "listening on"; then
    ok=true
    break
  fi
  sleep 5
done
if [ "$ok" != true ]; then
  echo "!! service did not report 'listening on' within 150s — check: docker compose logs --tail 100" >&2
  exit 1
fi
echo "service is up"

# Codex full-repo review (2026-07-14, Warning): auto-deploy.sh used to
# compare `git rev-parse HEAD` against origin/main to decide whether
# there's anything new to deploy — but the `git pull` above already moves
# HEAD forward unconditionally, before the build/health-check that follows
# it is known to succeed. If THIS run fails anywhere below that pull (a
# build failure, or the health-check timeout above), HEAD is already at
# the new commit even though it was never actually served successfully —
# so the next auto-deploy.sh cron tick sees local HEAD == origin/main,
# concludes "nothing new", and silently never retries, forever, until a
# DIFFERENT new commit happens to be pushed. Writing this marker only here
# — after the health check has actually passed — gives auto-deploy.sh a
# "last known-good deploy" signal that's independent of git HEAD, so a
# failed attempt keeps getting retried every 5 minutes as intended instead
# of going silent.
git rev-parse HEAD > deploy/.last-deployed-sha

# Reclaim disk from old builds: dangling images are always safe to drop
# (nothing references them, whether ours or another project's). Build
# cache is time-filtered (keep the last 24h) rather than wiped entirely —
# a full wipe was tried first and bit us: it also evicts the `npm ci`
# layer that JUST got built, so the very next deploy is forced into a
# fully cold rebuild of better-sqlite3's native module, which depends on
# downloading a prebuilt binary over a flaky network path (this host is
# behind a CN proxy for anything GitHub-adjacent) — that cold rebuild
# failed outright once already (no Python for node-gyp's source-compile
# fallback). Keeping a 24h window still bounds growth (nothing lives
# forever) without punishing the immediately-next build. Neither this nor
# image prune is a blanket `docker system prune -a`, which would also nuke
# other projects' (natfrp/kkfileview/xinchuan-dev) still-useful cache on
# this shared host.
echo "==> reclaiming dangling images + build cache older than 24h"
docker image prune -f
docker builder prune -f --filter "until=24h"

echo "==> disk after cleanup"
docker system df
