# node:24-slim (Debian/glibc), not alpine — better-sqlite3 is a native
# module; prebuild-install needs a glibc-linux-x64 prebuilt binary, alpine's
# musl libc would force a from-source node-gyp compile.
FROM node:24-slim

# Deploy target is mainland China (host name is behind a CN-hosted frp
# tunnel) — deb.debian.org/registry.npmjs.org are slow from there, swap to
# Aliyun's mirrors for this build only (doesn't affect the app at runtime).
RUN sed -i 's|deb.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources

# git/universal-ctags/ripgrep are shelled out to directly (repo-sync.ts,
# symbol-index.ts, code-search.ts) — not npm dependencies.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git universal-ctags ripgrep ca-certificates \
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

EXPOSE 8000
CMD ["npm", "start"]
