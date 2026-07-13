#!/usr/bin/env bash
# Docker-based redeploy for the 244 host — disk there is shared with other
# projects (natfrp/kkfileview/xinchuan-dev), so every rebuild's dangling
# image + build cache must be reclaimed immediately after, not left to pile
# up. Run this FROM the deploy checkout (e.g. /opt/my-agent), not the repo
# root you develop in.
set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "==> git pull (fast-forward only)"
git pull --ff-only

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
  exit 1
fi
echo "service is up"

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
