---
name: prisma-migration
description: Safely change the Prisma schema and create migrations for ggpin (money columns as BigInt, idempotency unique keys, indexes, expand/contract for destructive changes). Use whenever schema.prisma changes.
---

# Prisma migration

1. Edit `packages/db/prisma/schema.prisma`. Money → `BigInt` with unit suffix (`amountTiyin`).
2. Add unique constraints that enforce idempotency and indexes for every FK and filter column.
3. `npx prisma format && npx prisma validate`.
4. `npm run db:migrate -- --name <verb_noun>` (dev only). Read the generated SQL.
5. Destructive change? STOP and ask. Plan expand → backfill → contract across releases.
6. Update `docs/03-DATA-MODEL.md` in the same change.
7. Regenerate client; run `npm run typecheck` (api + worker share the client).
8. Seed updates in `packages/db/prisma/seed.ts` if new reference data (products, providers).

Never edit an applied migration. Never `migrate reset` outside a local scratch DB.
