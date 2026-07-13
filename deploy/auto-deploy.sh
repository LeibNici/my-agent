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
local_rev=$(git rev-parse HEAD)
remote_rev=$(git rev-parse origin/main)

if [ "$local_rev" = "$remote_rev" ]; then
  exit 0
fi

{
  echo "=== $(date -Iseconds) deploying ${local_rev:0:9} -> ${remote_rev:0:9} ==="
  bash deploy/deploy.sh
  echo "=== $(date -Iseconds) done ==="
} >> "$LOG_FILE" 2>&1

# Disk-constrained host (see deploy.sh) — keep the log from growing unbounded.
tail -n 2000 "$LOG_FILE" > "$LOG_FILE.tmp" && mv "$LOG_FILE.tmp" "$LOG_FILE"
