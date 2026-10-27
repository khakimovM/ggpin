---
name: supplier-adapter
description: Add a new game/product supplier or a new game product (PUBG UC, Mobile Legends diamonds, Steam wallet, CS2, Roblox codes/Robux, etc.) behind the FulfillmentAdapter interface, including recipient validation, SKU mapping, price sync, voucher inventory and tests. Use when the roadmap adds a game.
---

# Supplier adapter / new game

## Delivery types (Product.deliveryType)
| type | user inputs | example |
|---|---|---|
| `TG_USERNAME` | @username | Stars, Premium (fragment adapter) |
| `GAME_ID` | player id (+ zone/server id) | PUBG, MLBB |
| `STEAM_LOGIN` | Steam login | Steam wallet, CS2 |
| `VOUCHER` | nothing — code delivered | Roblox card, Steam card |
| `USERNAME` | game username | Roblox direct Robux |
Input fields are data (`Product.inputSchema` JSON) so the UI renders forms without code changes.

## Adding a supplier
1. `docs/suppliers/<code>.md`: API docs link, auth, endpoints, status codes, regions, test mode.
2. `apps/worker/src/adapters/<code>/` implementing `FulfillmentAdapter`
   (`validateRecipient`, `quote`, `fulfill(orderId, sku, target)`, `getStatus`, `getBalance`).
3. Use `orderId` as the supplier idempotency key / external reference.
4. Map supplier SKUs ↔ our `Sku.supplierSku` in seed or admin.
5. Price sync job: refresh `SupplierPrice` hourly; stale price (> 2h) blocks quoting.
6. Balance check + low-balance alert.
7. Fixtures + tests: valid id, invalid id, region mismatch, out of stock, timeout → NEEDS_REVIEW.

## Adding a game product (after the adapter exists)
Seed/admin: Product (names uz/ru, slug, image, region badge, deliveryType, inputSchema,
help text uz/ru for "how to find your ID"), SKUs (amount label, supplier SKU, markup),
adapter priority list. Then e2e: quote → buy → delivered (dry run).

## Voucher inventory
`Voucher(code encrypted, skuId, status AVAILABLE|RESERVED|SOLD|INVALID)`; reserve with
`FOR UPDATE SKIP LOCKED`; deliver code only after DELIVERED; show stock count in catalog.
