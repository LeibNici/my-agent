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

# Reclaim disk from THIS build only: dangling images are always safe to
# drop (nothing references them, whether ours or another project's) and
# builder prune only evicts unused cache layers — neither touches another
# project's running containers or tagged images on this shared host. Not
# a blanket `docker system prune -a`, which would also nuke other
# projects' still-useful cache.
echo "==> reclaiming build cache + dangling images"
docker image prune -f
docker builder prune -f

echo "==> disk after cleanup"
docker system df
