---
paths:
  - "apps/worker/**"
  - "packages/shared/src/order-state.ts"
---
# Fulfillment rules (worker)

## Order state machine (only `order-state.ts` may change `Order.status`)
```
QUOTED ─(pay)→ PAID → QUEUED → PROCESSING → DELIVERED
                          │          ├→ FAILED → REFUNDED
                          │          ├→ HELD (cost above floor / limits) → QUEUED | FAILED
                          │          └→ NEEDS_REVIEW (outcome unknown) → DELIVERED | FAILED
                          └→ CANCELLED (admin, before PROCESSING) → REFUNDED
```

## Every attempt
1. Acquire `lock:order:{id}`. Re-read order; continue only if `QUEUED`/`PROCESSING`.
2. Look for an existing `FulfillmentAttempt` with an external reference (tx hash, supplier
   order id). If present → reconcile that reference; NEVER create a new payment.
3. Re-quote real cost; if above `order.maxCost` → `HELD` + admin alert.
4. Check hot-wallet/supplier limits; if breached → `HELD`.
5. Create the attempt row with status `SENDING` and the precomputed reference, commit.
6. Send. Persist result. Confirm (on-chain lookup / supplier status poll).
7. Timeout or ambiguous response → `NEEDS_REVIEW`. Only a provable "not sent" may retry.

## Adapters
All fulfillment goes through `FulfillmentAdapter` (`validateRecipient`, `quote`,
`fulfill`, `getStatus`, `getBalance`). Product → adapter mapping is data (DB), with an
ordered fallback list. `FULFILLMENT_DRY_RUN=true` swaps every adapter for a simulator.

## Limits (env, enforced in code, visible in admin)
`TON_MAX_PER_ORDER_NANO`, `TON_MAX_DAILY_NANO`, `TON_MIN_BALANCE_ALERT_NANO`,
`SUPPLIER_MAX_PER_ORDER_MICRO_USDT`. Breach → HELD + alert, never silent.
