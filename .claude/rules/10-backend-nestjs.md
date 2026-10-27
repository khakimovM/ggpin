---
paths:
  - "apps/api/**"
  - "apps/worker/**"
---
# Backend rules — NestJS

## Module layout
`apps/api/src/modules/<feature>/` → `*.module.ts`, `*.controller.ts` (HTTP only),
`*.service.ts` (business rules, transactions), `*.repository.ts` (all Prisma),
`dto/`, `entities/` (toDto mappers: BigInt → string), `__tests__/`.

| Layer | May | Must never |
|---|---|---|
| Controller | read `@CurrentUser()`, params, body; call one service method | business logic, Prisma |
| Service | rules, `$transaction`, cache invalidation, emit events/jobs | touch req/res, raw SQL |
| Repository | Prisma, parameterised `$queryRaw` | business rules, HTTP exceptions |

## Conventions
- Global prefix `api`, URI versioning → `/api/v1/...`.
- `nestjs-zod` validation; DTOs from shared Zod schemas; write schemas `.strict()`.
- Response envelope `{ success, data, meta? }` via global interceptor; errors via
  `AllExceptionsFilter` → `{ success:false, error:{ code, message, details? } }`. Codes are
  listed in `docs/04-API-CONTRACT.md`. Error messages are i18n keys, not prose.
- Auth guards: `UserAuthGuard` (web cookie or Mini App token) global; `@Public()` opt-out;
  `AdminGuard` + `@AdminRole()` for `/api/v1/admin/*`.
- `userId` only from the session (`@CurrentUser('id')`), never from body/query.
- Throttling: `@nestjs/throttler` — auth 5/min, order create 10/min/user, default 120/min.
- Logging: Pino with request id; redact `authorization`, cookies, `initData`, `hash`,
  signatures, `mnemonic`, `apiKey`, phone numbers.
- Config only through a Zod-validated `ConfigService`; never `process.env` elsewhere.
- Lists are paginated, `limit` ≤ 100.
- Worker: `NestFactory.createApplicationContext`, BullMQ processors, no HTTP server.
  Jobs are idempotent and carry `orderId`; `attempts` + exponential backoff configured per queue.
