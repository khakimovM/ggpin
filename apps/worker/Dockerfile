# syntax=docker/dockerfile:1
#
# ggpin worker image (apps/worker). Build context = repo root:
#   docker build -f apps/worker/Dockerfile -t ggpin-worker .                    # runtime image (default)
#   docker build -f apps/worker/Dockerfile --target migrate -t ggpin-migrate .  # `prisma migrate deploy` job
#
# The worker is the only process that holds wallet keys, supplier secrets and the bank-feed
# Telegram session (CLAUDE.md invariant 7). Nothing secret is baked in: every value arrives as an
# environment variable or a Docker secret file at run time (BANK_FEED_ENC_KEY_FILE).

ARG NODE_IMAGE=node:24.22.2-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9

# ---------------------------------------------------------------------------------------------
# toolchain: compiler + python for node-gyp, and openssl for the Prisma schema engine.
# Only the builder stages derive from it; the runtime image never sees a compiler.
# ---------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS toolchain
# better-sqlite3 (always loaded by @mtcute/node) is compiled from source against the headers that
# ship inside this image. The default install path downloads an unverified prebuilt binary from
# GitHub (prebuild-install), which would then run inside the process holding the session key.
# Forcing the source build trades about a minute of build time for a binary whose inputs are the
# lockfile (integrity-checked npm tarballs) and the base image only.
ENV npm_config_build_from_source=true \
    npm_config_nodedir=/usr/local
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential python3 openssl ca-certificates \
 && apt-get clean \
 && find /var/lib/apt/lists -type f -delete
WORKDIR /app
# Every workspace manifest, so `npm ci` can validate the lockfile; only worker deps are installed.
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
# deps-prod: production dependencies only (no typescript, no prisma CLI, no nest CLI).
# npm installs `prisma` and `typescript` here anyway because they are optional peers of
# @prisma/client that the lockfile resolves; the generated client (adapter-pg) does not use them
# at run time, so they and their exclusive dependency tree are deleted explicitly (the smoke test
# proves the client still loads).
# ---------------------------------------------------------------------------------------------
FROM toolchain AS deps-prod
RUN npm ci --omit=dev -w worker -w @repo/db -w @repo/shared --include-workspace-root \
      --foreground-scripts --no-audit --no-fund \
 && npm cache clean --force \
 && cd node_modules \
 && rm -r prisma typescript effect valibot @electric-sql \
      @prisma/dev @prisma/studio-core @prisma/engines @prisma/fetch-engine @prisma/config \
      @prisma/query-plan-executor @prisma/streams-local \
      .bin/prisma .bin/tsc .bin/tsserver \
 && cd .. \
 && node -e "require('better-sqlite3')(':memory:').close()" \
 && find node_modules/better-sqlite3/deps node_modules/better-sqlite3/src \
      node_modules/better-sqlite3/build/Release/obj* node_modules/better-sqlite3/build/Release/.deps \
      -prune -exec rm -r {} + \
 && node -e "require('better-sqlite3')(':memory:').close()"

# ---------------------------------------------------------------------------------------------
# build: full install, then shared -> prisma generate -> db -> nest build.
# ---------------------------------------------------------------------------------------------
FROM toolchain AS build
RUN npm ci -w worker -w @repo/db -w @repo/shared --include-workspace-root \
      --foreground-scripts --no-audit --no-fund \
 && npm cache clean --force
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/db packages/db
COPY apps/worker apps/worker
RUN npm run build -w @repo/shared \
 && npm run db:generate -w @repo/db \
 && npm run build -w @repo/db \
 && npm run build -w worker
# The inject CLI writes synthetic bank notifications as if the bank bot sent them (D-52): it must
# not exist in a production image. Drop its compiled files, then fail the build if any trace stays
# (a file name, or any remaining module that still requires one of them).
RUN cd apps/worker/dist \
 && find . \( -name 'bank-feed-inject.*' -o -name 'inject-args.*' -o -name 'inject-text.*' \
      -o -name 'inject-guard.*' \) -type f -delete \
 && if [ -n "$(find . -name '*inject*' -type f)" ]; then echo 'inject files left in dist' >&2; exit 1; fi \
 && if grep -rIl -e 'bank-feed-inject' -e 'inject-args' -e 'inject-text' -e 'inject-guard' . ; then \
      echo 'dist still references the inject CLI' >&2; exit 1; fi \
 && test -f main.js && test -f cli/bank-feed-login.js

# ---------------------------------------------------------------------------------------------
# migrate: one-shot `prisma migrate deploy` (explicit deploy step, run BEFORE the new worker/api
# start). It needs the prisma CLI, which is why it is a separate target and not part of runtime.
#   docker compose run --rm migrate
# Needs DATABASE_URL only. Never run `migrate reset` from here.
# ---------------------------------------------------------------------------------------------
FROM build AS migrate
ENV NODE_ENV=production
WORKDIR /app/packages/db
USER node
CMD ["/app/node_modules/.bin/prisma", "migrate", "deploy"]

# ---------------------------------------------------------------------------------------------
# runtime (default target): production node_modules + compiled output, no compiler, no CLIs.
# ---------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
# openssl: Prisma needs libssl detection. tini: PID 1 that forwards SIGTERM/SIGINT to node
# (graceful shutdown) and reaps zombies.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl tini \
 && apt-get clean \
 && find /var/lib/apt/lists -type f -delete
WORKDIR /app
# Manifests + production node_modules (root and per-workspace ones, workspace symlinks kept).
COPY --from=deps-prod /app /app
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/db/dist packages/db/dist
COPY --from=build /app/apps/worker/dist apps/worker/dist
# Defence in depth: the runtime image must not contain the inject CLI, a secret-looking file
# outside node_modules, typescript or the prisma CLI; the build fails otherwise.
RUN if find /app -path '*/node_modules' -prune -o \( -name '*inject*' -o -name '.env' -o -name '.env.*' \
      -o -name '*.pem' -o -name '*.key' -o -name '*.session*' -o -name '*.sqlite*' -o -name '*.blob' \
      -o -name 'mtcute-test.json' \) -print | grep . ; then \
      echo 'forbidden file in runtime image' >&2; exit 1; fi \
 && test ! -e /app/node_modules/typescript \
 && test ! -e /app/node_modules/.bin/prisma \
 && test ! -e /app/node_modules/.bin/tsc
WORKDIR /app/apps/worker
USER node
# No EXPOSE: the worker has no HTTP surface and no public port.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js"]
