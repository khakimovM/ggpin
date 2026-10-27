---
name: react-query-hook
description: Create typed TanStack Query hooks and API client functions for web/admin using shared Zod schemas, a central query-key registry and explicit invalidations. Use when a screen needs server data or a mutation.
---

# Query hook

- API client: `src/lib/api/<feature>.ts`, fetch wrapper adds auth (cookie for web, Bearer for /tg),
  parses `{success,data}` envelope, validates `data` with the shared Zod schema, maps
  `error.code` → i18n key.
- Keys: `src/lib/query-keys.ts` — `qk.wallet.balance()`, `qk.orders.list(filters)`, `qk.orders.detail(id)`, ...
- Queries: `useQuery({ queryKey, queryFn, staleTime })`; order detail polls every 2s while
  status is PAID/QUEUED/PROCESSING, stops on terminal states.
- Mutations: declare `onSuccess` invalidations (purchase → wallet + orders; top-up result → wallet).
  Send `Idempotency-Key` (uuid generated once per checkout attempt).
- Never compute money client-side; display server values.
