#!/bin/sh
# Codex full-repo review (2026-07-14, Warning): the container ran the app as
# root the whole time — a code-execution bug anywhere in the request path
# (this app shells out to git/rg/ctags on attacker-influenced input) would
# hand an attacker root inside the container for free, needlessly widening
# what a single vulnerability can do.
#
# Runs as root ONLY long enough to fix ownership of the bind-mounted host
# paths (docker-compose.yml's ./data/* volumes — these are host directories
# whose ownership predates this change and may still be root:root), then
# execve-replaces itself as the unprivileged `node` user via setpriv (part
# of util-linux, already present in the node:24-slim base — no extra
# package, no GitHub-adjacent download to add another flaky point to the
# image build, see the Dockerfile's existing comment on that failure mode).
# setpriv over runuser/su specifically: those fork a child and stay
# running as root themselves (PAM session bookkeeping), leaving PID 1 root
# even though the app itself isn't — setpriv is a direct
# setuid+setgid+execve wrapper with no such session, so this process IS
# npm start after the exec, not a root supervisor sitting in front of it.
# `chown` here is idempotent/cheap on an already-correctly-owned tree, so
# this is safe to run on every start, not just the first one after
# upgrading.
set -eu

for path in /app/agent_data.db /app/.jwt_secret; do
  [ -e "$path" ] && chown node:node "$path"
done
mkdir -p /data/repos
chown -R node:node /data/repos

exec setpriv --reuid=node --regid=node --init-groups -- npm start
