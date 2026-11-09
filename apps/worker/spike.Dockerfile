# Phase 4 S0 spike (branch spike/p4-mtcute, never merged): proves @mtcute/node@0.32.7 installs
# with `npm ci` on node:24 (better-sqlite3 native addon) and loads from the worker's CJS build.
# Build context = repo root:  docker build -f apps/worker/spike.Dockerfile -t ggpin-spike-mtcute .
# The slim base has no python/make/g++, so a successful install proves the prebuilt binary was used.

FROM node:24-bookworm-slim AS build
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
RUN npm ci -w worker -w @repo/db -w @repo/shared --include-workspace-root --foreground-scripts --no-audit --no-fund
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/db packages/db
COPY apps/worker apps/worker
RUN npm run build -w @repo/shared \
 && npm run db:generate -w @repo/db \
 && npm run build -w @repo/db \
 && npm run build -w worker

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/apps apps
COPY --from=build /app/packages packages
COPY --from=build /app/e2e/flow/package.json e2e/flow/
RUN npm ci --omit=dev -w worker -w @repo/db -w @repo/shared --foreground-scripts --no-audit --no-fund \
 && rm -rf /root/.npm
WORKDIR /app/apps/worker
USER node
# Offline smoke check: load mtcute through CJS, open an in-memory SQLite, construct (not connect) a
# test-mode client from the compiled spike module with dummy credentials.
RUN node -e "require('@mtcute/node'); const D=require('better-sqlite3'); const d=new D(':memory:'); d.close(); const l=require('./dist/spike/spike-login.js'); const tg=l.makeTestClient({apiId:1,apiHash:'0'.repeat(32)}); console.log('smoke ok', process.version, typeof tg.call)"
CMD ["node", "-e", "require('@mtcute/node'); console.log('mtcute loaded', process.version)"]
