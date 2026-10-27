---
paths:
  - "apps/api/src/modules/payments/**"
---
# Payments rules

- Flow: `PaymentIntent` (amount in tiyin, user, provider, expiresAt) → provider checkout →
  provider callback → verify → confirm → `TOPUP` ledger entry, all in one transaction.
- Verification per provider (details in `docs/05-PAYMENTS.md`): Click — `sign_string` MD5 of
  the documented fields with the secret key, Prepare then Complete; Payme — Merchant API
  JSON-RPC with Basic auth (`Paycom:<key>`), amounts in tiyin, full method set
  (CheckPerformTransaction, CreateTransaction, PerformTransaction, CancelTransaction,
  CheckTransaction, GetStatement); Uzum and Rahmat — exactly as their contract docs say
  (put their PDFs in `docs/providers/`). Unknown → ask, never guess.
- Exact amount match; currency UZS; intent must be `PENDING` and unexpired.
- Unique `(provider, providerTxnId)`; replays return the stored answer.
- Return provider-specific error codes exactly as their docs require.
- Redirect/return URLs only show status; they never confirm a payment.
- Min/max top-up from config (`TOPUP_MIN_TIYIN`, `TOPUP_MAX_TIYIN`).
- Every signature failure → security log + counter + alert threshold.
- Daily reconciliation job compares provider statements with our payments; mismatches go to admin.
