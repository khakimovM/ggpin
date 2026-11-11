---
paths:
  - 'apps/api/src/modules/payments/**'
  - 'apps/api/src/modules/wallet/**'
  - 'apps/worker/src/bank-feed/**'
  - 'apps/worker/src/reconcile/**'
---

# Payments rules — P2P card top-ups (D-31, D-37)

- Flow: `PaymentIntent` (P2P_CARD, base amount + unique suffix, card, 30 min TTL) → user transfers to our card →
  card bot notification → worker ingests `BankMessage` → parse → balance-chain check → match → one `$transaction`:
  `Payment(CONFIRMED)` + intent `PAID` + `LedgerEntry(TOPUP, PAYMENT/<paymentId>)` + `BankMessageOutcome`.
- Only the worker holds the bank-feed Telegram session. Accept a message only from the configured numeric bot id,
  in its private chat, not forwarded, not edited, not via a bot. Never read or log other chats.
- Parsing is language-independent (emoji markers, both amount and date formats). An unrecognised, rejected,
  unmatched, ambiguous, duplicate, chain-breaking, outgoing-direction or forwarded message, money for a
  CANCELLED intent (`CANCELLED_LATE`), a blocked user or a new account over its daily cap is NEVER credited
  automatically: it becomes a `PaymentReview` and an owner alert. Only an EXPIRED intent inside its grace window
  (and a PENDING one) is credited without a human.
- Exact amount match in tiyin. Every amount is reserved on its card until `reservedUntil` (`expiresAt + grace`, or
  `GREATEST(reservedUntil, paidAt + grace)` once PAID, never shorter; the DB refuses any other value), enforced by a DB exclusion constraint; take ONE per-card advisory lock at a time
  (never hold two). Per user: one PENDING, at most 3 UNPAID reserved (PENDING, or EXPIRED/CANCELLED with `reservedUntil > now`; PAID does
  not count), 5 requests / 10 min and 10 / 24 h.
- Idempotency: unique `(senderId, tgMessageId)`, `Payment.bankMessageId`, `BankMessageOutcome.bankMessageId`,
  ledger `(refType, refId, kind)`. A replay never credits twice.
- Intent status changes only through `assertIntentTransition` (`packages/shared/src/payments/intent-state.ts`);
  EXPIRED may become PAID only within the grace window, CANCELLED only by an audited admin (`actor: admin`), also only
  within the window; after it no intent changes state and money is credited through a review without an intent.
- Fraud limits are mandatory: one pending top-up per user, create rate limits, a daily cap for every account
  (`TOPUP_DAILY_MAX_TIYIN`) and a lower one for new accounts, both counted on BASE amounts (`checkDailyTopupLimit`) and
  checked at creation and again when crediting (review `DAILY_LIMIT`),
  `TOPUP_REVERSAL` + `purchaseFrozen`, `ownerHint` on the pay page. Every DEBIT on a receiving card alerts the owner;
  a new authorization of the working account pauses auto-credit on ALL cards.
- Pay-link token: 256-bit, stored as HMAC hash, read-only, bound to one intent, valid until `expiresAt`, carried in
  the URL FRAGMENT (`/pay/<id>?locale=<uz|ru>#t=<token>`; the only query is the page language, D-38 Q21), sent to the API in `X-Pay-Token`, every failure (including a malformed
  id) is the same 404, never logged (D-39).
- Admin money actions (review credit, adjustment, reversal) require a reason, write `AuditLog` in the same
  transaction, alert the owner, and amounts above `ADMIN_CONFIRM_THRESHOLD_TIYIN` need a re-typed amount plus a
  fresh bot OTP.
- Daily reconciliation re-scans bot history and compares messages, payments, card totals and chains; mismatches go to the owner.
- Card data: our own receiving card numbers may be stored and are shown only to the owner of a PENDING intent;
  a customer's card data (number, expiry, CVV) is never stored, logged or requested.
- Min/max top-up from config (`TOPUP_MIN_TIYIN`, `TOPUP_MAX_TIYIN`, `TOPUP_STEP_TIYIN`).

## Later: payment providers (D-04)

Click, Payme, Uzum and Rahmat are not connected yet. When they are, they follow `docs/providers/<code>.md` exactly:

- One `PaymentProvider` interface, one adapter per provider; no provider-specific logic outside its adapter.
- Verify every callback: Click `sign_string` (MD5 of the documented fields with the secret key, Prepare then Complete),
  Payme Merchant API JSON-RPC with Basic auth (`Paycom:<key>`) and the full method set, Uzum and Rahmat as their
  contract docs say. Unknown → ask, never guess. Return provider-specific error codes exactly as documented.
- Exact amount match; currency UZS; intent `PENDING` and unexpired; unique `(provider, providerTxnId)`, replays return
  the stored answer. Redirect/return URLs only show status; they never confirm a payment.
- Every signature failure → security log + counter + alert threshold.
- A provider-side cancel after confirmation becomes a `TOPUP_REVERSAL`, with the same negative-balance guard as above.
