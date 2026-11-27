#
# ggpin worker image (apps/worker). Build context = repo root:
#   docker build -f apps/worker/Dockerfile -t ggpin-worker .                    # runtime image (default)
#   docker build -f apps/worker/Dockerfile --target migrate -t ggpin-migrate .  # `prisma migrate deploy` job
#
# No `# syntax=` directive on purpose: the Dockerfile frontend built into BuildKit is used, so
# nothing is pulled by a floating tag at build time (this file needs no newer frontend feature).
#
# The worker is the only process that holds wallet keys, supplier secrets and the bank-feed
# Telegram session (CLAUDE.md invariant 7). Nothing secret is baked in: every value arrives as an
# environment variable or a Docker secret file at run time (BANK_FEED_ENC_KEY_FILE).

ARG NODE_IMAGE=node:24.22.2-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9

# ---------------------------------------------------------------------------------------------
# manifests: base of every builder. openssl (Prisma) + every workspace manifest, so `npm ci` can
# validate the lockfile while installing only the workspaces a stage asks for.
# ---------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS manifests
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && apt-get clean \
 && find /var/lib/apt/lists -type f -delete
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
# toolchain: manifests + compiler and python for node-gyp. Only the stages that compile
# better-sqlite3 derive from it; the runtime and migrate images never see a compiler.
#
# better-sqlite3 (always loaded by @mtcute/node) is compiled from source against the headers that
# ship inside this image. Its own install script would download an unverified prebuilt binary
# from GitHub (prebuild-install), and that binary would run inside the process holding the
# session key. So `npm ci` runs with --ignore-scripts and node-gyp builds the module directly:
# no npm "build-from-source" config is involved (npm 12 warns that it is unknown), and the
# binary's inputs are the lockfile (integrity-checked npm tarballs) and the base image only.
# ---------------------------------------------------------------------------------------------
FROM manifests AS toolchain
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential python3 \
 && apt-get clean \
 && find /var/lib/apt/lists -type f -delete

# ---------------------------------------------------------------------------------------------
# deps-prod: production dependencies only (no typescript, no prisma CLI, no nest CLI).
# npm installs `prisma` and `typescript` here anyway because they are optional peers of
# @prisma/client that the lockfile resolves; the generated client (adapter-pg) does not use them
# at run time, so they and their exclusive dependency tree are deleted explicitly (the smoke test
# proves the client still loads).
# ---------------------------------------------------------------------------------------------
FROM toolchain AS deps-prod
RUN npm ci --omit=dev --ignore-scripts -w worker -w @repo/db -w @repo/shared \
      --include-workspace-root --no-audit --no-fund \
 && npm cache clean --force \
 && (cd node_modules/better-sqlite3 \
      && node "$(npm root -g)/npm/node_modules/node-gyp/bin/node-gyp.js" rebuild --release \
           --nodedir=/usr/local) \
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
FROM manifests AS build
# Scripts stay off; only the Prisma packages need theirs (engine download for `prisma generate`).
RUN npm ci --ignore-scripts -w worker -w @repo/db -w @repo/shared --include-workspace-root \
      --no-audit --no-fund \
 && npm rebuild @prisma/engines prisma --foreground-scripts \
 && npm cache clean --force
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/db packages/db
COPY apps/worker apps/worker
RUN npm run build -w @repo/shared \
 && CHECKPOINT_DISABLE=1 npm run db:generate -w @repo/db \
 && npm run build -w @repo/db \
 && npm run build -w worker
# The inject CLI writes synthetic bank notifications as if the bank bot sent them (D-52): it must
# not exist in a production image. Drop its compiled files, then fail the build if any trace stays
# (a file name, or any remaining module that still requires one of them).
# The same for the owner-only Fragment recorder (plan S0b, S-9): cli/fragment-record* and its env
# guard config/fragment-record-env.*. adapters/fragment/* stays (the S8 adapter needs it).
RUN cd apps/worker/dist \
 && find . \( -name 'bank-feed-inject.*' -o -name 'inject-args.*' -o -name 'inject-text.*' \
      -o -name 'inject-guard.*' -o -path './cli/fragment-record*' \
      -o -path './config/fragment-record-env.*' \) -type f -delete \
 && if [ -n "$(find . -name '*inject*' -type f)" ]; then echo 'inject files left in dist' >&2; exit 1; fi \
 && if [ -n "$(find . -name '*fragment-record*' -type f)" ]; then \
      echo 'fragment-record files left in dist' >&2; exit 1; fi \
 && if grep -rIl -e 'bank-feed-inject' -e 'inject-args' -e 'inject-text' -e 'inject-guard' . ; then \
      echo 'dist still references the inject CLI' >&2; exit 1; fi \
 && if grep -rIl -e 'fragment-record' . ; then \
      echo 'dist still references the fragment recorder' >&2; exit 1; fi \
 && test -f main.js && test -f cli/bank-feed-login.js && test -f healthcheck/healthcheck.js

# ---------------------------------------------------------------------------------------------
# migrate: one-shot `prisma migrate deploy` (explicit deploy step, run BEFORE the new worker/api
# start):  docker compose run --rm migrate
# Deliberately NOT derived from `build`: it holds only the @repo/db workspace's dependencies
# (prisma CLI + schema-engine), `packages/db/prisma` (schema + migrations) and `prisma.config.ts`.
# No worker source, no inject CLI, no compiler. Needs DATABASE_URL only. Never `migrate reset`.
#
# Supply-chain note: the schema-engine binary is downloaded by @prisma/engines' postinstall from
# binaries.prisma.sh and verified only against the .sha256 file served next to it, i.e. outside
# the lockfile's integrity chain. It runs with the migration (DDL owner) database URL, so keep
# this container on the internal network and give it a migration role that is not the runtime one.
# The engines postinstall swallows download and checksum errors, so the build itself fails when no
# schema-engine binary came out of it (not the first deploy). Pinning the engine's sha256 here is
# an S11 item (S7d audit L-1).
# No --include-workspace-root: the root devDependencies (turbo, eslint, prettier, husky, ...)
# would land in the image that holds the DDL owner's URL (S7d audit L-2).
# CHECKPOINT_DISABLE: the Prisma CLI would otherwise report usage on every command.
# ---------------------------------------------------------------------------------------------
FROM manifests AS migrate-deps
RUN npm ci --ignore-scripts -w @repo/db --no-audit --no-fund \
 && npm rebuild @prisma/engines prisma --foreground-scripts \
 && npm cache clean --force \
 && test -n "$(find node_modules/@prisma/engines -maxdepth 1 -type f -name 'schema-engine-*')" \
 && test ! -e node_modules/.bin/turbo && test ! -e node_modules/.bin/eslint \
 && test ! -e node_modules/.bin/prettier && test ! -e node_modules/.bin/husky

FROM ${NODE_IMAGE} AS migrate
ENV NODE_ENV=production CHECKPOINT_DISABLE=1
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && apt-get clean \
 && find /var/lib/apt/lists -type f -delete
WORKDIR /app
COPY --from=migrate-deps /app/node_modules node_modules
COPY --from=migrate-deps /app/package.json ./
COPY --from=migrate-deps /app/packages/db/package.json packages/db/
COPY packages/db/prisma/schema.prisma packages/db/prisma/
COPY packages/db/prisma/migrations packages/db/prisma/migrations
COPY packages/db/prisma.config.ts packages/db/
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
# Defence in depth: the runtime image must not contain the inject CLI, the Fragment recorder, a
# secret-looking file outside node_modules, typescript or the prisma CLI; the build fails otherwise.
RUN if find /app -path '*/node_modules' -prune -o \( -name '*inject*' -o -name '*fragment-record*' \
      -o -name '.env' -o -name '.env.*' \
      -o -name '*.pem' -o -name '*.key' -o -name '*.session*' -o -name '*.sqlite*' -o -name '*.blob' \
      -o -name 'mtcute-test.json' \) -print | grep . ; then \
      echo 'forbidden file in runtime image' >&2; exit 1; fi \
 && test ! -e /app/node_modules/typescript \
 && test ! -e /app/node_modules/.bin/prisma \
 && test ! -e /app/node_modules/.bin/tsc
WORKDIR /app/apps/worker
USER node
# Healthy = the worker's own Redis heartbeat key exists (10 s beat, 30 s TTL); valid in every
# BANK_FEED_MODE. Needs only REDIS_URL and prints no secret.
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD ["node", "dist/healthcheck/healthcheck.js"]
# No EXPOSE: the worker has no HTTP surface and no public port.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js"]
