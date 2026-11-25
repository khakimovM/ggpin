#
# ggpin admin image (apps/admin: React + Vite SPA) — static files behind a minimal Caddy server.
# Build context = repo root. VITE_* values are inlined into the bundle at BUILD time, so staging and
# production are separate builds:
#   docker build -f apps/admin/Dockerfile -t ggpin-admin \
#     --build-arg VITE_API_URL=https://api.ggpin.uz/api/v1 --build-arg VITE_ENV_LABEL=PRODUCTION .
# No VITE_* value is a secret (every value reaches the browser).
#
# Build stage: pinned Node digest + `npm ci --ignore-scripts` (worker Dockerfile pattern).
# Runtime: pinned Caddy digest (the same server family as the reverse proxy, D-73 (4)), no Node,
# no node_modules, non-root, no file capabilities, HEALTHCHECK.

ARG NODE_IMAGE=node:24.22.2-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9
ARG CADDY_IMAGE=caddy:2.10.2-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d

# ---------------------------------------------------------------------------------------------
# manifests: every workspace manifest (lockfile validation), see apps/api/Dockerfile.
# ---------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS manifests
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/worker/package.json apps/worker/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/admin/package.json apps/admin/
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/
COPY packages/i18n/package.json packages/i18n/
COPY packages/ui/package.json packages/ui/
COPY e2e/flow/package.json e2e/flow/

# ---------------------------------------------------------------------------------------------
# build: admin + shared + i18n + ui (ui and i18n are admin dependencies from phase 9 on).
# ---------------------------------------------------------------------------------------------
FROM manifests AS build
RUN npm ci --ignore-scripts -w admin -w @repo/shared -w @repo/i18n -w @repo/ui --include-workspace-root \
      --no-audit --no-fund \
 && npm cache clean --force
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/i18n packages/i18n
COPY packages/ui packages/ui
COPY apps/admin apps/admin
ARG VITE_API_URL
ARG VITE_ENV_LABEL=PRODUCTION
# VITE_API_MOCKS is fixed empty (not a build arg): an admin bundle with mocks cannot be built.
ENV NODE_ENV=production \
    VITE_API_MOCKS= \
    VITE_API_URL=${VITE_API_URL} \
    VITE_ENV_LABEL=${VITE_ENV_LABEL}
RUN npm run build -w @repo/shared \
 && npm run build -w admin \
 && test -f apps/admin/dist/index.html
# Only the built bundle leaves this stage; it must hold no env file, no source map, no source.
RUN cd apps/admin/dist \
 && if find . \( -name '.env' -o -name '.env.*' -o -name '*.map' -o -name '*.ts' -o -name '*.tsx' \
      -o -name '*.pem' -o -name '*.key' \) -print | grep . ; then \
      echo 'forbidden file in admin bundle' >&2; exit 1; fi

# ---------------------------------------------------------------------------------------------
# runtime (default target)
# ---------------------------------------------------------------------------------------------
FROM ${CADDY_IMAGE} AS runtime
# The upstream binary carries cap_net_bind_service as a file capability (to bind :80 as non-root).
# This server listens on :8080 and runs with every capability dropped (compose cap_drop: ALL), so
# the file capability is removed: a binary that asks for a capability it cannot get fails to exec.
# Caddy's config/data dirs point at the /tmp tmpfs (the root filesystem is read-only).
RUN setcap -r /usr/bin/caddy \
 && rm -rf /srv/* /usr/share/caddy
ENV XDG_CONFIG_HOME=/tmp/caddy-config \
    XDG_DATA_HOME=/tmp/caddy-data
COPY --chown=root:root apps/admin/docker/Caddyfile /etc/caddy/Caddyfile
COPY --chown=root:root --chmod=0755 apps/admin/docker/entrypoint.sh /usr/local/bin/admin-entrypoint
COPY --from=build --chown=root:root /app/apps/admin/dist /srv/admin
# The config is validated with a sample origin; the real one comes from ADMIN_API_ORIGIN at start.
RUN ADMIN_API_ORIGIN=https://api.example.test caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile \
 && test -f /srv/admin/index.html \
 && if find /srv /etc/caddy \( -name '.env' -o -name '.env.*' -o -name '*.map' -o -name '*.pem' \
      -o -name '*.key' \) -print | grep . ; then echo 'forbidden file in admin image' >&2; exit 1; fi \
 && test ! -e /usr/local/bin/node && test ! -e /usr/bin/node
# Unprivileged uid/gid (no shell account needed); files stay root-owned and read-only to it.
USER 65532:65532
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/healthz"]
# Run time: ADMIN_API_ORIGIN=https://api.ggpin.uz (CSP connect-src); missing or invalid = no start.
ENTRYPOINT ["/usr/local/bin/admin-entrypoint"]
