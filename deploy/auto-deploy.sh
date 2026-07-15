#!/usr/bin/env bash
# Cron entry point (every 5 min) — polls origin/main, runs bootstrap.sh only
# when there's actually something new. Silent when there's nothing to do so
# the log doesn't fill up with "nothing changed" noise every 5 min.
#
# 2026-07-15, Codex review (Critical): the run-serialization lock used to
# live here, guarding only the cron path — a manually-run bootstrap.sh was
# never covered, so it could race a concurrent cron tick. Moved into
# bootstrap.sh itself (the one entry point both paths actually go through)
# instead of also flock-ing here: bootstrap.sh runs as a CHILD process of
# this script, inheriting this script's open file descriptors — a second
# flock attempt on the same lock file from the child would compete with
# fd 200 held by THIS process for the same run, not with some other
# concurrent invocation, so locking twice here would just make bootstrap.sh
# permanently fail to acquire its own lock during a normal cron-triggered
# deploy.
#
# 2026-07-15 rewrite: this used to `git fetch`/`git rev-parse` against a
# permanent local checkout at /opt/my-agent — but that checkout no longer
# exists between deploys (see deploy/deploy.sh's rewrite comment), so
# there's nothing local left to fetch into.
#
# What answers "what's the latest commit on origin/main" changed again the
# same day (Codex review, Critical): `git ls-remote` through
# v4.gh-proxy.org is the SAME untrusted proxy that also serves the code
# bootstrap.sh clones — a compromised proxy could tell this check "nothing's
# new" to suppress a real deploy (e.g. a security fix) indefinitely, with
# nothing here able to tell. api.github.com is reachable directly from this
# host (confirmed: github.com times out, api.github.com doesn't) — asking
# it instead means the polling decision itself no longer depends on the
# proxy at all; bootstrap.sh's own SHA check (same api.github.com call)
# catches it independently even if this one were somehow bypassed.
set -euo pipefail

GITHUB_REPO="LeibNici/my-agent"
DATA_DIR="/opt/my-agent-data"
BOOTSTRAP="/opt/my-agent-deploy/bootstrap.sh"
LOG_FILE="$DATA_DIR/auto-deploy.log"

mkdir -p "$DATA_DIR"

remote_rev="$(curl -fsS --max-time 10 -H "Accept: application/vnd.github.sha" \
  "https://api.github.com/repos/${GITHUB_REPO}/commits/main")"
if [ -z "$remote_rev" ]; then
  echo "$(date -Iseconds) skip: could not reach api.github.com for the latest SHA" >> "$LOG_FILE"
  exit 0
fi

# Codex full-repo review (2026-07-14, Warning): comparing against local
# `git rev-parse HEAD` used to mean a FAILED deploy (build error, or the
# health-check timing out) never got retried — deploy.sh's own success path
# is the only thing that writes this marker, and only after its
# health-check has actually passed. A failed attempt leaves the marker
# unchanged, so it keeps not matching remote_rev and gets retried every 5
# minutes until it either succeeds or a human intervenes. Missing marker
# (no successful deploy has EVER completed on this host) reads as "always
# behind", so the very first run attempts a deploy too.
last_deployed_rev=""
[ -f "$DATA_DIR/.last-deployed-sha" ] && last_deployed_rev=$(cat "$DATA_DIR/.last-deployed-sha")

if [ "$last_deployed_rev" = "$remote_rev" ]; then
  exit 0
fi

{
  echo "=== $(date -Iseconds) deploying ${last_deployed_rev:0:9} -> ${remote_rev:0:9} ==="
  bash "$BOOTSTRAP"
  echo "=== $(date -Iseconds) done ==="
} >> "$LOG_FILE" 2>&1

# Disk-constrained host (see deploy.sh) — keep the log from growing unbounded.
tail -n 2000 "$LOG_FILE" > "$LOG_FILE.tmp" && mv "$LOG_FILE.tmp" "$LOG_FILE"
