#!/usr/bin/env bash
# Docker-based redeploy for the 244 host — disk there is shared with other
# projects (natfrp/kkfileview/xinchuan-dev), so every rebuild's dangling
# image + build cache must be reclaimed immediately after, not left to pile
# up.
#
# 2026-07-15 rewrite: this used to run from a permanent checkout at
# /opt/my-agent, updated in place via `git pull`. That left the full
# application source (a real `.git` history included) sitting readable on
# the host indefinitely — anyone with host access could read it, not just
# whoever's supposed to operate the container. Runs from an EPHEMERAL clone
# now instead: deploy/bootstrap.sh (the one thing that stays on the host)
# clones fresh into a throwaway directory, invokes this script, and this
# script deletes that directory itself once the new container is confirmed
# healthy. Nothing but docker images and MY_AGENT_DATA_DIR (real data +
# secrets, was ./data/+engine/.env under the old permanent-checkout layout)
# persists on the host between deploys.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# 2026-07-15, Codex review (Critical): the final `rm -rf "$REPO_ROOT"` below
# used to rely entirely on the comment "only ever invoked by bootstrap.sh"
# for safety — no code-level check that this is actually the ephemeral
# mktemp checkout bootstrap.sh created, not e.g. a permanent path someone
# invoked this script against directly. bootstrap.sh always creates
# $BUILD_DIR under /tmp/my-agent-build.*, so refuse to proceed at all
# (before touching anything, not just before the final rm -rf) if
# $REPO_ROOT doesn't match that shape.
case "$REPO_ROOT" in
  /tmp/my-agent-build.*) ;;
  *)
    echo "!! refusing to run: \$REPO_ROOT ($REPO_ROOT) is not an ephemeral /tmp/my-agent-build.* checkout" >&2
    echo "!! this script deletes \$REPO_ROOT when it finishes — only bootstrap.sh should invoke it" >&2
    exit 1
    ;;
esac

cd "$REPO_ROOT"

: "${MY_AGENT_DATA_DIR:=/opt/my-agent-data}"
export MY_AGENT_DATA_DIR
# Stable across every ephemeral clone — compose defaults the project name to
# the containing directory's basename, which would otherwise change (and
# rename/orphan the container) every single deploy since that directory is
# now a fresh mktemp path each time.
export COMPOSE_PROJECT_NAME=my-agent

# Codex full-repo review (2026-07-14, Warning): docker-compose.yml's
# .../agent_data.db and .../jwt_secret are FILE bind-mounts — Docker only
# bind-mounts an existing host path; if the source doesn't exist yet (true
# on a genuinely first-ever deploy) it silently creates a DIRECTORY at that
# path instead of erroring, which then breaks both better-sqlite3 (can't
# open a directory as a db file) and jwt-secret loading. touch is safe to
# run unconditionally on every deploy, not just the first — it never
# truncates an already-existing file, only creates what's missing.
echo "==> ensuring $MY_AGENT_DATA_DIR bind-mount targets exist (first-deploy safety)"
mkdir -p "$MY_AGENT_DATA_DIR/repos"
touch "$MY_AGENT_DATA_DIR/agent_data.db" "$MY_AGENT_DATA_DIR/jwt_secret"
# 2026-07-15: no engine/.env bind mount anymore. It used to hold
# ANTHROPIC_API_KEY/BASE_URL/MODEL/MAX_TOKENS, but main.ts overrides all
# four from db.getLlmConfig() (Admin → LLM 配置) whenever a row is present —
# on this production DB there always is one, so those four .env values were
# 100% dead weight, and every other Settings field either already has a
# correct hardcoded default or is DB-backed the same way (issueFixBotUsername,
# webhook secrets). Chasing the right host-side permissions for a :ro-mounted
# secrets file that a real deploy incident (2026-07-14) already broke once
# and this rewrite broke a second time (uid 1000 vs whatever chmod the file
# happened to get) wasn't worth continuing to carry for a file nothing reads
# a real value out of. A genuinely fresh deploy with no DB row yet boots on
# Settings' built-in defaults and main.ts's own loud "no LLM API key
# configured" warning — exactly the same as it already did the moment an
# admin hadn't visited that page yet, .env present or not — until an admin
# sets one via the UI. Local dev (`npm start` from engine/, cwd-relative
# dotenv.config()) is unaffected; this only removes the production bind mount.

# So the running site can show which commit it's actually serving (see
# app.ts's readGitSha comment) — the container has no .git of its own
# (Dockerfile only COPYs engine/ and web/, not the whole repo), so this
# file is the only way it finds out. Written into engine/ so the existing
# `COPY engine/ ./` picks it up with no Dockerfile change; gitignored so
# it never becomes a tracked/committed file.
git rev-parse HEAD > engine/.git-sha

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
  echo "!! leaving $REPO_ROOT in place for inspection instead of deleting it" >&2
  exit 1
fi
echo "service is up"

# Codex full-repo review (2026-07-14, Warning): auto-deploy.sh used to
# compare `git rev-parse HEAD` against origin/main to decide whether
# there's anything new to deploy — but a naive "already pulled" marker
# written before the build/health-check that follows it is known to
# succeed means a failed attempt (build error, or the health-check timeout
# above) would never get retried on the next cron tick. Writing this marker
# only here — after the health check has actually passed — gives
# auto-deploy.sh a "last known-good deploy" signal that's independent of
# git HEAD, so a failed attempt keeps getting retried every 5 minutes as
# intended instead of going silent. Lives in MY_AGENT_DATA_DIR now, not
# deploy/.last-deployed-sha inside the checkout — this checkout won't exist
# by the time the next cron tick reads it back.
git rev-parse HEAD > "$MY_AGENT_DATA_DIR/.last-deployed-sha"

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

# The whole point of the 2026-07-15 rewrite: don't leave a readable copy of
# the application source (a real .git history included) sitting on the host
# once the image that's actually running has been built from it. Last
# thing this script does — nothing below this line may reference $REPO_ROOT.
echo "==> deleting ephemeral checkout $REPO_ROOT"
cd /
rm -rf "$REPO_ROOT"
