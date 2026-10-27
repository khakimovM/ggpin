---
name: fragment-ton
description: Work on the Fragment (Telegram Stars / Premium) adapter and TON wallet in apps/worker — recipient search, init request, payment link payload, TON transfer signing, confirmation, cookie/session keep-alive, dry-run simulator, and failover. Use for any change to Stars/Premium fulfillment.
---

# Fragment + TON

Fragment has **no official public API**. The adapter calls the same JSON endpoints the
fragment.com web page uses, with a logged-in session. Treat the response shapes as
unstable: validate every response with Zod and fail closed.

## Flow (Stars; Premium is analogous with `months`)
1. `searchStarsRecipient(username, quantity)` → recipient id + display name/photo (used for
   recipient confirmation in the UI, via API → worker RPC/queue).
2. `initBuyStarsRequest(recipient, quantity)` → `req_id`, amount in TON.
3. `getBuyStarsLink(req_id)` → transaction: destination address, amount (nano), payload (BOC).
4. Compare amount with `order.maxCost`; violate → HELD.
5. Persist `FulfillmentAttempt{status:SENDING, toAddress, amountNano, payloadHash}`.
6. Sign and send with `@ton/ton` WalletContractV5R1 (or V4) under `lock:ton-wallet`
   (seqno); store the external message hash.
7. Confirm: poll the wallet transactions (toncenter/tonapi) for our message hash and
   Fragment's order status; success → DELIVERED.
8. Unknown after timeout → NEEDS_REVIEW (never resend).

## Session
- Cookies `stel_ssid`, `stel_dt`, `stel_token`, `stel_ton_token` + page `hash` stored
  encrypted in DB (`FragmentSession`), updated from every `Set-Cookie`.
- Keep-alive job every 20 min; health check marks session DEAD → router fails over to the
  backup Stars/Premium provider (e.g. a reseller API) and alerts the owner.
- Re-login is semi-automatic: owner confirms the Telegram login prompt; TON proof can be
  signed by the worker.

## Dev
`FULFILLMENT_DRY_RUN=true` → `FragmentSimulator` returns fixture responses; testnet wallet
only if explicitly configured. Tests use recorded fixtures in `__fixtures__/fragment/`.
