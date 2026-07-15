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
