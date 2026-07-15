#!/usr/bin/env bash
# The ONE thing that lives permanently on the 244 host's disk to drive
# deploys, besides docker images and MY_AGENT_DATA_DIR (real data +
# secrets). Everything else — the actual application source, `.git`
# history included — is cloned fresh into a throwaway directory here and
# deleted by deploy.sh right after the new container is confirmed healthy,
# so a host compromise (or just anyone with shell access on a box shared
# with other projects) doesn't hand over a standing, readable checkout of
# the app's source tree. See deploy/deploy.sh's 2026-07-15 rewrite comment
# for the full rationale.
#
# Installed once at /opt/my-agent-deploy/bootstrap.sh (not auto-updated —
# it changes rarely, and re-fetching the thing that fetches everything else
# on every run buys nothing). deploy/auto-deploy.sh (cron, */5 min) and any
# manual redeploy both go through this, never deploy.sh directly.
set -euo pipefail

# 2026-07-15, Codex review (Critical): bootstrap.sh is the ONE thing both
# auto-deploy.sh (cron, */5 min) and any manual redeploy go through (see
# this file's own header comment above) — so the lock belongs here, not in
# auto-deploy.sh, otherwise a manually-run bootstrap.sh races a concurrent
# cron tick on the same Compose project / .last-deployed-sha. Non-blocking:
# a losing side just skips this run rather than queuing — cron retries in
# 5 min anyway, and a human re-running manually can just try again.
exec 200>/tmp/my-agent-deploy.lock
if ! flock -n 200; then
  echo "==> another deploy is already in progress — skipping this run" >&2
  exit 0
fi

# 2026-07-15, Codex review (Critical): a failed health check further down
# deliberately leaves $BUILD_DIR in place for inspection instead of
# deleting it — but with no cap, a stuck deploy failing every cron tick
# (every 5 min) accumulates one full checkout + built layers per attempt
# and can exhaust this shared host's disk. Sweep anything older than 2h
# (generous enough that a failure someone's actively looking at survives
# the next few ticks, bounded enough that it can't grow unboundedly) before
# starting a fresh attempt.
find /tmp -maxdepth 1 -name 'my-agent-build.*' -mmin +120 -exec rm -rf {} + 2>/dev/null || true

GITHUB_REPO="LeibNici/my-agent"
REPO_URL="https://v4.gh-proxy.org/https://github.com/${GITHUB_REPO}.git"
BUILD_DIR="$(mktemp -d /tmp/my-agent-build.XXXXXX)"

# 2026-07-15, Codex review (Critical): this host can't reach github.com
# directly (mainland China), so the code that ends up running as root on
# this host comes entirely through v4.gh-proxy.org, a third-party proxy we
# don't control — a compromised/malicious proxy could serve tampered code
# under a SHA it also lies about, and nothing here would notice. Neither
# "stop trusting the proxy" nor "don't use a proxy" is actually available
# (there's no other path to GitHub from this host) — but api.github.com IS
# reachable directly (confirmed: github.com times out, api.github.com
# returns 200), a different, independently-operated GitHub service. Asking
# it for the expected SHA and checking the proxy-served clone's actual HEAD
# against it means a malicious proxy has to also compromise api.github.com
# to fool this — meaningfully raises the bar without needing a signing/PKI
# setup this project has no other use for.
expected_sha="$(curl -fsS --max-time 10 -H "Accept: application/vnd.github.sha" \
  "https://api.github.com/repos/${GITHUB_REPO}/commits/main")"
if [ -z "$expected_sha" ]; then
  echo "!! could not get the expected SHA from api.github.com — refusing to deploy blind" >&2
  rmdir "$BUILD_DIR" 2>/dev/null || true
  exit 1
fi

echo "==> cloning into ephemeral $BUILD_DIR (expecting $expected_sha)"
git clone --depth 1 "$REPO_URL" "$BUILD_DIR"

actual_sha="$(git -C "$BUILD_DIR" rev-parse HEAD)"
if [ "$actual_sha" != "$expected_sha" ]; then
  echo "!! SHA mismatch: proxy clone is $actual_sha, api.github.com says main is $expected_sha" >&2
  echo "!! refusing to build/deploy a checkout that doesn't match the independently-verified SHA" >&2
  rm -rf "$BUILD_DIR"
  exit 1
fi

bash "$BUILD_DIR/deploy/deploy.sh"
