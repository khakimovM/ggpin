---
name: nestjs-module
description: Scaffold or extend a NestJS feature module in apps/api with controller, service, repository, Zod DTOs, Swagger, i18n error codes and tests, following ggpin layering and ownership rules. Use when adding any backend resource or endpoint group.
---

# NestJS module (ggpin)

## Files
```
apps/api/src/modules/<feature>/
  <feature>.module.ts
  <feature>.controller.ts      # HTTP only
  <feature>.service.ts         # rules, $transaction, events
  <feature>.repository.ts      # all Prisma
  dto/<feature>.dto.ts         # createZodDto(schema from packages/shared)
  entities/<feature>.entity.ts # toDto(): BigInt -> string
  __tests__/<feature>.service.spec.ts
  __tests__/<feature>.e2e-spec.ts
```

## Order of work
1. Zod schemas in `packages/shared/src/schemas/<feature>.ts` (create/update/query/response), export inferred types.
2. Repository: `userId` first param; every `where` scoped; return Prisma models.
3. Service: rules, `prisma.$transaction` for multi-writes, domain exceptions from
   `src/common/exceptions` with codes from `docs/04-API-CONTRACT.md`.
4. Controller: `@CurrentUser('id') userId`, one service call, Swagger decorators, throttle if needed.
5. Mapper: BigInt → string; no formatting server-side.
6. Error messages: i18n keys `errors.<CODE>` added to uz.json + ru.json.
7. Tests: service unit (mocked repository) + e2e ownership (user A → 404 on B's resource).

## Checklist
- [ ] No Prisma outside repository; no logic in controller
- [ ] Paginated lists, `limit` ≤ 100
- [ ] Shape matches the contract exactly
- [ ] Money writes in `$transaction` + cache invalidation after commit
