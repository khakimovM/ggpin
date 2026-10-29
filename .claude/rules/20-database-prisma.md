---
paths:
  - 'packages/db/prisma/**'
  - '**/*.repository.ts'
---

# Database rules — Prisma / PostgreSQL

- Schema lives in `packages/db/prisma/schema.prisma` (Prisma 7, D-22); api and worker import the
  one generated client from `@repo/db`. Never instantiate `PrismaClient` outside that package.
- Money columns: `BigInt` (`amountTiyin`, `costMicroUsdt`, `costNanoTon`). Never Decimal/Float.
- Every table: `id` (`cuid(2)`) and `createdAt`; `updatedAt` only on mutable tables — append-only
  ledgers/logs and immutable snapshots have none (D-23). Soft delete only where docs say so.
- Unique constraints are the backbone of idempotency — declare them in the schema:
  `Payment(provider, providerTxnId)`, `Order(userId, idempotencyKey)`,
  `FulfillmentAttempt(orderId, attemptNo)`, `LedgerEntry(refType, refId, kind)`.
- Balance-sensitive writes: lock the user's wallet row (`SELECT ... FOR UPDATE` on
  `Wallet`) or use `Serializable` isolation with retry. Document which, in the service.
- Index every foreign key and every column used in admin filters (status, createdAt, provider).
- Migrations: never edit an applied migration; destructive changes need approval and a
  two-step (expand → migrate data → contract) plan.
- After editing the schema: `npx prisma validate` and `npx prisma format`.
