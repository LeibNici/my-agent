# node:24-slim (Debian/glibc), not alpine — better-sqlite3 is a native
# module; prebuild-install needs a glibc-linux-x64 prebuilt binary, alpine's
# musl libc would force a from-source node-gyp compile.
FROM node:24-slim

# Deploy target is mainland China (host name is behind a CN-hosted frp
# tunnel) — deb.debian.org/registry.npmjs.org are slow from there, swap to
# Aliyun's mirrors for this build only (doesn't affect the app at runtime).
RUN sed -i 's|deb.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources

# git/universal-ctags/ripgrep are shelled out to directly (repo-sync.ts,
# symbol-index.ts, code-search.ts) — not npm dependencies. python3/make/g++
# are a node-gyp fallback, not a direct dependency of anything above: if
# better-sqlite3's prebuilt-binary download ever fails (this host's network
# path to anything GitHub-adjacent is a CN proxy, and is a known flaky
# point — see deploy/deploy.sh's build-cache comment for the outage this
# caused once already), npm falls back to compiling it from source instead
# of the whole build hard-failing. Costs ~150-300MB of image size for a
# path that's rarely exercised — the prebuilt binary is still the
# expected common case, this is only insurance against its download flaking.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git universal-ctags ripgrep ca-certificates python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# Build context is the REPO ROOT (see docker-compose.yml), not engine/ —
# main.ts/app.ts compute REPO_ROOT/WEB_ROOT by walking up from their own
# file location (import.meta.url), expecting web/ as a sibling of engine/,
# not cwd-relative. /app here mirrors that exact host layout so the app
# code needs zero changes to run containerized.
WORKDIR /app/engine
COPY engine/package*.json ./
RUN npm ci --registry=https://registry.npmmirror.com
COPY engine/ ./
COPY web/ /app/web/

# Codex full-repo review (2026-07-14, Warning): container previously ran
# as root with no USER directive — see docker-entrypoint.sh for the full
# rationale and how bind-mounted host paths (docker-compose.yml's
# ./data/*) get their ownership fixed before the app ever runs as this
# user. Reuses node:24-slim's built-in `node` user (uid/gid 1000, already
# present in the base image) rather than creating a new one — stable
# across rebuilds and matches what a one-time `chown -R 1000:1000 data/`
# on the host would target.
RUN chown -R node:node /app
RUN chmod +x docker-entrypoint.sh

EXPOSE 8000
ENTRYPOINT ["./docker-entrypoint.sh"]
