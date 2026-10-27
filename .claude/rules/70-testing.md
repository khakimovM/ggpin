# Testing rules (always active)

- Unit: Jest (api, worker), Vitest (web, admin). E2E API: Jest + Supertest on real
  Postgres/Redis; DB name must end with `_test` (guarded in setup).
- External services are always faked in tests: payment providers (recorded fixtures),
  Fragment (fixtures of its JSON responses), TON (mock client), suppliers (nock).
- Required for any money feature: happy path, insufficient funds, idempotent replay,
  concurrent requests, failure + refund, ownership 404.
- Playwright for web/Mini App/admin journeys; Mini App tests inject a fake `Telegram.WebApp`
  and a valid test `initData` signed with a test bot token.
- No `.skip`/`.only` committed. A flaky test is a bug — fix or quarantine with an issue.
