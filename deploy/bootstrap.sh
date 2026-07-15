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

REPO_URL="https://v4.gh-proxy.org/https://github.com/LeibNici/my-agent.git"
BUILD_DIR="$(mktemp -d /tmp/my-agent-build.XXXXXX)"

echo "==> cloning into ephemeral $BUILD_DIR"
git clone --depth 1 "$REPO_URL" "$BUILD_DIR"

bash "$BUILD_DIR/deploy/deploy.sh"
