#!/usr/bin/env bash
# Cron entry point (every 5 min) — polls origin/main, runs deploy.sh only
# when there's actually something new. flock guards against a slow build
# still running when the next tick fires; silent when there's nothing to
# do so the log doesn't fill up with "nothing changed" noise every 5 min.
set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCK_FILE="/tmp/my-agent-auto-deploy.lock"
LOG_FILE="deploy/auto-deploy.log"

exec 200>"$LOCK_FILE"
if ! flock -n 200; then
  echo "$(date -Iseconds) skip: previous run still in progress" >> "$LOG_FILE"
  exit 0
fi

git fetch origin main --quiet
remote_rev=$(git rev-parse origin/main)

# Codex full-repo review (2026-07-14, Warning): comparing against local
# `git rev-parse HEAD` used to mean a FAILED deploy (build error, or the
# health-check timing out) never got retried — deploy.sh's own `git pull`
# already advances HEAD to remote_rev before the build/health-check that
# can still fail, so on the next tick local HEAD looked identical to
# remote_rev regardless of whether the deploy actually succeeded. Compare
# against deploy.sh's own success marker (written only after its
# health-check passes) instead — a failed attempt leaves the marker
# unchanged, so it keeps not matching remote_rev and gets retried every 5
# minutes until it either succeeds or a human intervenes. Missing marker
# (no successful deploy has EVER completed on this host) reads as "always
# behind", so the very first run attempts a deploy too.
last_deployed_rev=""
[ -f deploy/.last-deployed-sha ] && last_deployed_rev=$(cat deploy/.last-deployed-sha)

if [ "$last_deployed_rev" = "$remote_rev" ]; then
  exit 0
fi

{
  echo "=== $(date -Iseconds) deploying ${last_deployed_rev:0:9} -> ${remote_rev:0:9} ==="
  bash deploy/deploy.sh
  echo "=== $(date -Iseconds) done ==="
} >> "$LOG_FILE" 2>&1

# Disk-constrained host (see deploy.sh) — keep the log from growing unbounded.
tail -n 2000 "$LOG_FILE" > "$LOG_FILE.tmp" && mv "$LOG_FILE.tmp" "$LOG_FILE"
