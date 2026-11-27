#
# ggpin API image (apps/api: REST API, payment webhooks, Telegram bot, admin API, owner ops CLI).
# Build context = repo root:
#   docker build -f apps/api/Dockerfile -t ggpin-api .
#
# Same pattern as apps/worker/Dockerfile (read its header for the reasoning): pinned Node digest,
# `npm ci --ignore-scripts`, no compiler, no prisma CLI, no typescript and no `effect` at run time,
# non-root, tini as PID 1, build-failing checks for forbidden files.
#
# The API never holds worker secrets (CLAUDE.md invariant 7): the image contains none, and the
# process refuses to boot when one appears in its environment (packages/shared env-secrets.ts).
# Worker-only packages (TON, MTProto, sqlite) must never be installed here; the build fails if one
# shows up (e.g. after a lockfile or workspace change). Migrations are NOT run by this image:
# `prisma migrate deploy` is the separate `migrate` target of apps/worker/Dockerfile.
#
# Owner CLI over SSH (docs/10; deploy/vps/README-2.md shows how SSH_CONNECTION/SUDO_USER get in):
#   docker compose exec api node dist/cli/ops-cli.js <command>

ARG NODE_IMAGE=node:24.22.2-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9

# ---------------------------------------------------------------------------------------------
# manifests: every workspace manifest, so `npm ci` can validate the lockfile while installing only
# the workspaces a stage asks for. (A new workspace folder must be added here and in the other
# Dockerfiles, or `npm ci` refuses the lockfile.)
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
# deps-prod: production dependencies of api + db + shared + i18n. npm also installs the OPTIONAL
# peers the lockfile resolved: `prisma` (the CLI, an optional peer of @prisma/client) and its whole
# tree (typescript, effect, better-sqlite3, mysql2, react for Prisma Studio, ...). `--omit=peer` does
# not remove them (they are not flagged as peers in the lockfile: other workspaces use them
# directly), so docker/prune-deps.mjs walks the lockfile from these workspaces along real runtime
# edges only and deletes everything else. The forbidden list below fails the build if any of it (or
# a worker-only package) remains at any node_modules depth. The smoke test (ready -> db: ok) proves
# the Prisma client still works.
# ---------------------------------------------------------------------------------------------
FROM manifests AS deps-prod
COPY apps/api/docker/prune-deps.mjs /tmp/prune-deps.mjs
RUN npm ci --omit=dev --ignore-scripts -w api -w @repo/db -w @repo/shared -w @repo/i18n \
      --include-workspace-root --no-audit --no-fund \
 && npm cache clean --force \
 && node /tmp/prune-deps.mjs /app apps/api packages/db packages/shared packages/i18n \
 && rm /tmp/prune-deps.mjs \
 && for p in @ton @mtcute better-sqlite3 typescript prisma effect valibot @electric-sql mysql2 \
      prebuild-install giget react @prisma/dev @prisma/studio-core @prisma/engines @prisma/fetch-engine \
      @prisma/config; do \
      if find . -path "*/node_modules/$p" -print | grep -q . ; then \
        echo "forbidden package in api deps: $p" >&2; exit 1; fi; \
    done \
 && test ! -e node_modules/.bin/prisma && test ! -e node_modules/.bin/tsc

# ---------------------------------------------------------------------------------------------
# build: full install, then shared -> prisma generate -> db -> nest build.
# ---------------------------------------------------------------------------------------------
FROM manifests AS build
# Scripts stay off; only the Prisma packages need theirs (engine download for `prisma generate`).
RUN npm ci --ignore-scripts -w api -w @repo/db -w @repo/shared -w @repo/i18n --include-workspace-root \
      --no-audit --no-fund \
 && npm rebuild @prisma/engines prisma --foreground-scripts \
 && npm cache clean --force
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/db packages/db
COPY packages/i18n packages/i18n
COPY apps/api apps/api
RUN npm run build -w @repo/shared \
 && CHECKPOINT_DISABLE=1 npm run db:generate -w @repo/db \
 && npm run build -w @repo/db \
 && npm run build -w api
# The compiled API must be the server + the owner CLI and nothing else: no test code, no worker
# code path (a TON/MTProto import would mean a worker secret could be used here). Source maps
# (tsconfig sourceMap) are dropped: they would ship the TypeScript source in the image.
RUN cd apps/api/dist \
 && test -f main.js && test -f cli/ops-cli.js \
 && if [ -n "$(find . \( -name '*.spec.js' -o -name '*.test.js' -o -path '*__tests__*' \) -print)" ]; then \
      echo 'test files in api dist' >&2; exit 1; fi \
 && if grep -rIl --include='*.js' -e "require(\"@ton/" -e "require(\"@mtcute/" -e "require(\"better-sqlite3\")" . ; then \
      echo 'api dist requires a worker-only package' >&2; exit 1; fi \
 && find /app/apps/api/dist /app/packages/shared/dist /app/packages/db/dist -name '*.map' -type f -delete

# ---------------------------------------------------------------------------------------------
# runtime (default target): production node_modules + compiled output, no compiler, no CLIs.
# ---------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
# openssl: Prisma's libssl detection. tini: PID 1 that forwards SIGTERM to node (graceful
# shutdown: enableShutdownHooks closes the bot, queues and DB) and reaps zombies. npm, npx,
# corepack and yarn are removed (nothing here installs packages) and setuid/setgid bits cleared.
# uid/gid 10001 is the API container's own id, never a host login account (SA H-1; preflight.sh
# checks it); the passwd entry exists because the owner CLI reads os.userInfo() for the audit row.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl tini \
 && apt-get clean \
 && find /var/lib/apt/lists -type f -delete \
 && rm -r /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
 && rm -f /usr/local/bin/yarn /usr/local/bin/yarnpkg && find /opt -maxdepth 1 -name 'yarn-*' -exec rm -r {} + \
 && find / -xdev -type f -perm /6000 -exec chmod a-s {} + \
 && groupadd --system --gid 10001 ggpin-api \
 && useradd --system --uid 10001 --gid 10001 --no-create-home --home-dir /nonexistent \
      --shell /usr/sbin/nologin ggpin-api
WORKDIR /app
# Manifests + production node_modules (workspace symlinks kept); everything root-owned.
COPY --from=deps-prod --chown=root:root /app /app
COPY --from=build --chown=root:root /app/packages/shared/dist packages/shared/dist
COPY --from=build --chown=root:root /app/packages/db/dist packages/db/dist
# The API requires @repo/i18n/uz.json and ru.json at run time (API error texts, bot messages).
COPY --from=build --chown=root:root /app/packages/i18n/uz.json /app/packages/i18n/ru.json packages/i18n/
COPY --from=build --chown=root:root /app/apps/api/dist apps/api/dist
# Defence in depth: no secret-looking file or source (map) outside node_modules, none of the build
# tooling or worker-only packages at any node_modules depth, no package manager, no setuid file.
RUN if find /app -path '*/node_modules' -prune -o \( -name '.env' -o -name '.env.*' -o -name '*.pem' \
      -o -name '*.key' -o -name '*.session*' -o -name '*.sqlite*' -o -name '*.blob' -o -name '*.map' \
      -o -name 'mtcute-test.json' -o -name '*.tsbuildinfo' -o \( -name '*.ts' ! -name '*.d.ts' \) \) -print | grep . ; then \
      echo 'forbidden file in api runtime image' >&2; exit 1; fi \
 && for p in typescript prisma effect @ton @mtcute better-sqlite3 mysql2 prebuild-install giget react \
      @prisma/studio-core @prisma/engines @nestjs/cli jest ts-jest; do \
      if find /app -path "*/node_modules/$p" -print | grep -q . ; then echo "forbidden package in runtime: $p" >&2; exit 1; fi; \
    done \
 && test ! -e /app/node_modules/.bin/prisma \
 && test ! -e /app/node_modules/.bin/tsc \
 && test ! -e /app/apps/api/src \
 && test ! -e /usr/bin/gcc && test ! -e /usr/bin/make \
 && test ! -e /usr/local/bin/npm && test ! -e /usr/local/bin/npx && test ! -e /usr/local/bin/corepack \
 && test ! -e /usr/local/bin/yarn \
 && if find / -xdev -type f -perm /6000 -print | grep . ; then echo 'setuid/setgid file left' >&2; exit 1; fi
WORKDIR /app/apps/api
USER 10001:10001
EXPOSE 5000
# Liveness only (the process answers HTTP). Readiness (db, redis, worker heartbeat) stays on
# /api/v1/health/ready, which the reverse proxy keeps internal. No secret is read or printed.
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.API_PORT||5000)+'/api/v1/health/live',{signal:AbortSignal.timeout(5000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js"]
