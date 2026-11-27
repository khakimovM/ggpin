#
# ggpin web image (apps/web: landing, web store, Telegram Mini App /tg) — Next.js standalone server.
# Build context = repo root. NEXT_PUBLIC_* values are inlined into the browser bundle at BUILD time,
# so staging and production are separate builds:
#   docker build -f apps/web/Dockerfile -t ggpin-web \
#     --build-arg NEXT_PUBLIC_API_URL=https://api.ggpin.uz/api/v1 \
#     --build-arg NEXT_PUBLIC_SITE_URL=https://ggpin.uz \
#     --build-arg NEXT_PUBLIC_BOT_USERNAME=ggpin_bot \
#     --build-arg NEXT_PUBLIC_SUPPORT_URL=https://t.me/<support> \
#     --build-arg NEXT_PUBLIC_TELEGRAM_CHANNEL_URL=https://t.me/<channel> \
#     --build-arg NEXT_PUBLIC_ANALYTICS_SITE_ID=<umami uuid or empty> .
# Run time: API_INTERNAL_URL=http://api:5000/api/v1 (server-only, never in the bundle; required,
# checked at start by docker/start.mjs). Writable: /tmp only (tmpfs; .next/cache points there).
# No NEXT_PUBLIC_* value is a secret: they are public by definition (they reach every browser).
#
# Same pattern as apps/worker/Dockerfile: pinned Node digest, `npm ci --ignore-scripts`, no
# compiler/prisma/typescript/effect at run time, non-root, tini, build-failing forbidden-file checks.

ARG NODE_IMAGE=node:24.22.2-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9

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
# build: web + shared + i18n + ui with dev dependencies (Next, Tailwind), scripts off. Native
# parts (SWC, lightningcss, Tailwind oxide) come as prebuilt optional packages pinned by the
# lockfile, so no install script is needed.
# ---------------------------------------------------------------------------------------------
FROM manifests AS build
RUN npm ci --ignore-scripts -w web -w @repo/shared -w @repo/i18n -w @repo/ui --include-workspace-root \
      --no-audit --no-fund \
 && npm cache clean --force
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/i18n packages/i18n
COPY packages/ui packages/ui
COPY apps/web apps/web
# Test-only code is not part of a production build: `next build` type-checks everything the web
# tsconfig includes, and the e2e support code imports packages that are not web dependencies.
RUN rm -r apps/web/e2e apps/web/playwright.config.ts apps/web/playwright.qa.config.ts \
 && find apps/web/src packages/ui -name '*.test.ts' -o -name '*.test.tsx' | xargs -r rm
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_SITE_URL
ARG NEXT_PUBLIC_BOT_USERNAME
ARG NEXT_PUBLIC_SUPPORT_URL=
ARG NEXT_PUBLIC_TELEGRAM_CHANNEL_URL=
ARG NEXT_PUBLIC_ANALYTICS_SITE_ID=
# NEXT_PUBLIC_API_MOCKS is fixed empty (not a build arg): an image with the mock API cannot be
# built. NODE_ENV=production makes src/env.ts demand every value and https. NEXT_OUTPUT makes
# next.config.ts emit the standalone server (only here: local builds stay non-standalone).
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    NEXT_OUTPUT=standalone \
    NEXT_PUBLIC_API_MOCKS= \
    NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL} \
    NEXT_PUBLIC_SITE_URL=${NEXT_PUBLIC_SITE_URL} \
    NEXT_PUBLIC_BOT_USERNAME=${NEXT_PUBLIC_BOT_USERNAME} \
    NEXT_PUBLIC_SUPPORT_URL=${NEXT_PUBLIC_SUPPORT_URL} \
    NEXT_PUBLIC_TELEGRAM_CHANNEL_URL=${NEXT_PUBLIC_TELEGRAM_CHANNEL_URL} \
    NEXT_PUBLIC_ANALYTICS_SITE_ID=${NEXT_PUBLIC_ANALYTICS_SITE_ID}
RUN npm run build -w @repo/shared \
 && npm run build -w web \
 && test -f apps/web/.next/standalone/apps/web/server.js \
 && test -d apps/web/.next/static
# Mock code must not reach the production bundle (the same identifiers as
# apps/web/scripts/prod-build-check.mjs, which also proves the search works on a control literal).
RUN if grep -rIl -e 'mockTransport' -e 'createMockTransport' -e 'MOCK_PAY_TOKEN' -e 'mockrecipienttoken' \
      -e 'mockpaytoken' -e 'walletRoutes' -e 'paymentsRoutes' -e 'MOCK_WALLET' -e 'MOCK_PAYMENT_METHODS' \
      -e 'ledger_mock' -e 'intent_mock' -e 'mock/handlers/wallet' -e 'mock/handlers/payments' \
      -e 'order_mock_' -e 'quote_mock_' apps/web/.next/static apps/web/.next/standalone/apps/web/.next/server ; then \
      echo 'mock code in the production build' >&2; exit 1; fi \
 && grep -rIlq 'does not exist in production builds' apps/web/.next/static apps/web/.next/standalone/apps/web/.next/server
# Start-up check for docker/start.mjs: src/server-env.ts (the very rule next.config.ts runs)
# compiled to CommonJS, with the zod the web app resolves placed next to it (the standalone bundle
# inlines zod, so it is not among the traced node_modules). Proven on a good and a bad value.
RUN cd apps/web \
 && ../../node_modules/.bin/tsc src/server-env.ts --outDir boot --rootDir src --module commonjs \
      --moduleResolution node10 --target es2022 --strict --esModuleInterop --skipLibCheck \
      --declaration false --sourceMap false \
 && zod_dir=$(node -p "require('path').dirname(require.resolve('zod/package.json'))") \
 && mkdir -p boot/node_modules && cp -r "$zod_dir" boot/node_modules/zod \
 && node -e "require('./boot/server-env.js').parseServerEnv({API_INTERNAL_URL:'http://api:5000/api/v1'})" \
 && if node -e "require('./boot/server-env.js').parseServerEnv({API_INTERNAL_URL:'htp:/typo'})" 2>/dev/null; then \
      echo 'boot check accepts a bad URL' >&2; exit 1; fi

# ---------------------------------------------------------------------------------------------
# runtime (default target): the standalone output (server.js + traced node_modules), the static
# assets and the start-up check. No source, no dev dependencies, no compiler, no package manager.
# ---------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000
# tini: PID 1. npm/npx/corepack/yarn are removed (nothing in the container installs packages) and
# setuid/setgid bits are cleared. uid/gid 10002 is the web container's own id, never a host login
# account (SA H-1; deploy/vps/preflight.sh checks it). Files stay root-owned and read-only.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && apt-get clean \
 && find /var/lib/apt/lists -type f -delete \
 && rm -r /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
 && rm -f /usr/local/bin/yarn /usr/local/bin/yarnpkg && find /opt -maxdepth 1 -name 'yarn-*' -exec rm -r {} + \
 && find / -xdev -type f -perm /6000 -exec chmod a-s {} + \
 && groupadd --system --gid 10002 ggpin-web \
 && useradd --system --uid 10002 --gid 10002 --no-create-home --home-dir /nonexistent \
      --shell /usr/sbin/nologin ggpin-web
WORKDIR /app
COPY --from=build --chown=root:root /app/apps/web/.next/standalone ./
COPY --from=build --chown=root:root /app/apps/web/.next/static apps/web/.next/static
COPY --from=build --chown=root:root /app/apps/web/boot apps/web/boot
COPY --chown=root:root apps/web/docker/start.mjs apps/web/start.mjs
# The Next cache (fetch data cache of the 60 s catalog, image optimizer) is written at run time to
# .next/cache. The root filesystem is read-only, so .next/cache points at /tmp, which always exists
# (a tmpfs in production); Next creates fetch-cache/ and images/ there on first use.
RUN test ! -e apps/web/.next/cache && ln -s /tmp apps/web/.next/cache
# Next's file tracing copies `typescript` (reachable from Next's config loader, which the
# standalone server does not run: server.js carries the evaluated config). It is deleted; `rm -r`
# without -f, so a change in what Next traces fails the build here. The smoke test proves nothing
# needs it.
RUN rm -r node_modules/typescript
# Defence in depth: no env file (Next copies .env* into standalone when it finds one), no secret-
# looking file, no source map, no build tooling at any node_modules depth; the build fails otherwise.
RUN if find /app \( -name '.env' -o -name '.env.*' -o -name '*.pem' -o -name '*.key' -o -name '*.session*' \
      -o -name '*.sqlite*' -o -name '*.blob' -o -name '*.tsbuildinfo' -o -name '*.map' \) -print | grep . ; then \
      echo 'forbidden file in web runtime image' >&2; exit 1; fi \
 && if find /app -path '*/node_modules' -prune -o \( -name '*.ts' ! -name '*.d.ts' -o -name '*.tsx' \) -print | grep . ; then \
      echo 'source files in web runtime image' >&2; exit 1; fi \
 && for p in typescript prisma @prisma effect @ton @mtcute better-sqlite3 eslint vitest @playwright/test lighthouse; do \
      if find /app -path "*/node_modules/$p" -print | grep -q . ; then echo "forbidden package in runtime: $p" >&2; exit 1; fi; \
    done \
 && test ! -e /app/apps/web/src \
 && test ! -e /usr/local/bin/npm && test ! -e /usr/local/bin/npx && test ! -e /usr/local/bin/corepack \
 && test ! -e /usr/local/bin/yarn \
 && if find / -xdev -type f -perm /6000 -print | grep . ; then echo 'setuid/setgid file left' >&2; exit 1; fi
WORKDIR /app/apps/web
USER 10002:10002
EXPOSE 3000
# robots.txt is a static metadata route: it answers without calling the API.
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/robots.txt',{signal:AbortSignal.timeout(5000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--"]
# start.mjs checks API_INTERNAL_URL with the same rule as next.config.ts, then loads server.js.
CMD ["node", "start.mjs"]
