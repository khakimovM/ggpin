---
name: e2e-test
description: Write API e2e tests (Jest + Supertest, real Postgres/Redis, faked providers) and Playwright browser tests (web, Mini App with fake Telegram.WebApp, admin). Use when a feature needs end-to-end proof, especially money flows.
---

# E2E tests

## API
- `test/setup.ts` refuses to run unless `DATABASE_URL` db name ends with `_test`; truncates tables.
- Factories: `createUser()`, `fundWallet(user, tiyin)` (via a TOPUP entry), `createQuote()`.
- Fakes: payment callbacks from fixtures (signed with test secrets), worker in DRY_RUN.
- Concurrency test pattern: `await Promise.all([buy(), buy()])` → exactly one 201, one 422.

## Playwright
- Mini App: `page.addInitScript` defines `window.Telegram.WebApp` with test `initData`
  signed by `TEST_BOT_TOKEN`, theme params, and no-op MainButton/BackButton recorders.
- Run against built apps; screenshots for 375/768/1440 × light/dark × uz/ru in `e2e/__screens__`.
- Never hit real payment providers, Fragment, TON or suppliers.
