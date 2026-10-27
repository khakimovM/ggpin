---
name: payment-provider
description: Add or modify a payment provider (Click, Payme, Uzum, Rahmat, Telegram Stars top-up) behind the PaymentProvider interface — intents, callbacks, signature verification, idempotency, cancellation, reconciliation and tests with recorded fixtures.
---

# Payment provider adapter

## Interface (apps/api/src/modules/payments/providers/provider.interface.ts)
```ts
interface PaymentProvider {
  readonly code: 'CLICK' | 'PAYME' | 'UZUM' | 'RAHMAT' | 'TG_STARS';
  createCheckout(intent: PaymentIntent): Promise<{ redirectUrl: string }>;
  handleCallback(req: RawProviderRequest): Promise<ProviderResponse>; // verifies + confirms/cancels
  reconcile(day: Date): Promise<ReconcileReport>;
}
```

## Steps
1. Put the provider's official spec PDF/link in `docs/providers/<code>.md` (method names,
   fields, error codes, signature algorithm). Do not write code from memory.
2. Controller route `/api/v1/payments/<code>/callback` — `@Public()`, raw body available,
   IP allowlist if the provider publishes one.
3. Verify signature/auth FIRST; on failure return the provider's auth error + security log.
4. Look up intent; check amount (tiyin) and state; idempotency by `(provider, providerTxnId)`.
5. Confirm inside one `$transaction`: Payment row → CONFIRMED, intent → PAID, ledger TOPUP.
6. Cancellation after confirm → TOPUP_REVERSAL; if the balance would go negative, flag
   `NEEDS_REVIEW` for admin and freeze purchases for that user.
7. Fixtures: record sandbox request/response pairs in `__fixtures__/<code>/`.
8. Tests: valid flow, bad signature, wrong amount, replay ×3, cancel before/after confirm, expired intent.
9. Admin: provider appears in payments filters; reconciliation report visible.
