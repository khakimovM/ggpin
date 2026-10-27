# Domain rules — money, wallet, ledger (always active)

## Units
| Currency | Unit | Column suffix |
|---|---|---|
| UZS | tiyin (1 so'm = 100) | `Tiyin` |
| USDT | micro (1e-6) | `MicroUsdt` |
| TON | nano (1e-9) | `NanoTon` |
| Telegram Stars | integer stars | `Stars` |
`packages/shared/src/money.ts` owns all conversion and formatting. Nothing else does money math.
FX conversions use a stored `FxRate` snapshot (id saved on the order) and round **up** for
cost, **down** for amounts credited to users. Rounding direction is tested.

## Ledgers
`LedgerEntry` (so'm wallet) — append-only, never updated or deleted:
| kind | sign | caused by |
|---|---|---|
| TOPUP | + | Payment confirmed |
| TOPUP_REVERSAL | − | Provider cancelled a confirmed payment |
| PURCHASE | − | Order paid from wallet |
| REFUND | + | Order failed/cancelled |
| REFERRAL_BONUS | + | Referred user's purchase delivered (1%) |
| ADJUSTMENT | ± | Admin, with reason + audit log |

`CoinEntry` (cashback coins) — EARN on delivered order, SPEND on discount-code purchase,
EXPIRE if configured. Coins are not money and never convert to so'm directly.

Balance = SUM(entries). Cached in Redis `wallet:{userId}`; invalidated in the same code path
that writes the entry (after commit).

## Purchase (the critical path)
In ONE transaction with the user's wallet row locked:
1. Load the quote; reject if expired or not owned by the user.
2. Compute balance; if insufficient → `422 INSUFFICIENT_BALANCE` (nothing written).
3. Create `Order` (state `PAID`) + `LedgerEntry(PURCHASE)` + apply discount code (mark used).
4. After commit: enqueue `fulfill-order` job with `jobId = orderId`.

## Refund
`FAILED` → `REFUND` entry + state `REFUNDED` in one transaction. Partial refunds only by admin.
Referral bonus and cashback are granted only on `DELIVERED`, and reversed if a delivered
order is later refunded by admin.
