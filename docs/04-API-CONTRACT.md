# 04 — API shartnomasi

Barcha yo‘llar: `/api/v1/...`. Javob konverti:

```json
{ "success": true, "data": { }, "meta": { } }
{ "success": false, "error": { "code": "INSUFFICIENT_BALANCE", "message": "errors.INSUFFICIENT_BALANCE", "details": { } } }
```

- Pul — string, minimal birlikda (`"1255000"` = 12 550 so‘m). `currency` ko‘rsatiladi.
- Vaqt — ISO 8601 UTC.
- `message` — i18n kaliti; klient uni foydalanuvchi tilida ko‘rsatadi.
- Sahifalash: `?page=1&limit=20` (limit ≤ 100), `meta: { page, limit, total }`.
- Yozuvchi so‘rovlar: `Idempotency-Key` header (buyurtma va to‘lov intentlari uchun majburiy).

Bu fayl 1–5-bosqichlarda kengaytiriladi: har bir endpoint uchun to‘liq so‘rov/javob namunasi
implementatsiya bilan birga shu yerga yoziladi. Shakl o‘zgarishi — egadan so‘raladi.

## Xato kodlari

| HTTP | Kod                                                                            | Qachon                                                               |
| ---- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| 400  | `VALIDATION_ERROR`                                                             | Zod xatosi (`details.fields`)                                        |
| 401  | `UNAUTHORIZED`, `INITDATA_INVALID`, `INITDATA_EXPIRED`, `TOKEN_REUSE_DETECTED` | auth                                                                 |
| 403  | `USER_BLOCKED`, `PURCHASE_FROZEN`                                              | bloklangan / to‘lov qaytarilgan foydalanuvchi                        |
| 404  | `NOT_FOUND`                                                                    | resurs yo‘q yoki boshqa foydalanuvchiniki                            |
| 409  | `IDEMPOTENCY_CONFLICT`                                                         | bir xil kalit, boshqa body                                           |
| 410  | `QUOTE_EXPIRED`                                                                | kotirovka muddati tugagan                                            |
| 413  | `PAYLOAD_TOO_LARGE`                                                            | so‘rov tanasi ruxsat etilgan hajmdan katta                           |
| 422  | `INSUFFICIENT_BALANCE` (`details: {balance, required, shortfall}`)             | balans yetmaydi                                                      |
| 422  | `RECIPIENT_NOT_FOUND`, `RECIPIENT_INVALID`, `RECIPIENT_HAS_PREMIUM`            | qabul qiluvchi                                                       |
| 422  | `PRODUCT_UNAVAILABLE`, `OUT_OF_STOCK`, `QTY_OUT_OF_RANGE`                      | katalog                                                              |
| 422  | `TOPUP_AMOUNT_OUT_OF_RANGE`                                                    | to‘ldirish chegaralari                                               |
| 422  | `CODE_INVALID`, `CODE_EXPIRED`, `CODE_ALREADY_USED`, `NOT_ENOUGH_COINS`        | promo                                                                |
| 429  | `RATE_LIMITED`                                                                 | throttler                                                            |
| 500  | `INTERNAL_ERROR`                                                               | kutilmagan server xatosi (stack trace hech qachon javobga chiqmaydi) |
| 503  | `FULFILLMENT_UNAVAILABLE`, `RECIPIENT_CHECK_UNAVAILABLE`                       | Fragment/ta'minotchi ishlamayapti                                    |

## Auth

| Metod | Yo‘l                                           | Tavsif                                                                     |
| ----- | ---------------------------------------------- | -------------------------------------------------------------------------- |
| POST  | `/auth/telegram/webapp`                        | body `{ initData }` → `{ token, expiresIn, user }` (Mini App)              |
| POST  | `/auth/telegram/start`                         | web: `{ }` → `{ nonce, botUrl: "https://t.me/<bot>?start=login_<nonce>" }` |
| GET   | `/auth/telegram/status/:nonce`                 | `PENDING \| CODE_SENT \| DENIED \| EXPIRED`                                |
| POST  | `/auth/telegram/verify`                        | `{ nonce, code }` → cookie'lar + `{ user }`                                |
| POST  | `/auth/refresh`                                | cookie rotatsiyasi                                                         |
| POST  | `/auth/logout`                                 | joriy sessiya                                                              |
| GET   | `/auth/sessions` · DELETE `/auth/sessions/:id` | faol sessiyalar                                                            |

## Profil

| GET   | `/me`        | `{ id, telegramId, username, firstName, photoUrl, locale, referralCode, phoneLinked }` |
| ----- | ------------ | -------------------------------------------------------------------------------------- |
| PATCH | `/me`        | `{ locale }`                                                                           |
| GET   | `/me/wallet` | `{ balanceTiyin, coins, currency: "UZS" }`                                             |
| GET   | `/me/ledger` | moliya tarixi (kind filtri)                                                            |

## Katalog

| GET | `/catalog/categories`            | kategoriyalar + mahsulotlar soni                   |
| --- | -------------------------------- | -------------------------------------------------- |
| GET | `/catalog/products?category=&q=` | ro‘yxat (lokalga mos nomlar)                       |
| GET | `/catalog/products/:slug`        | mahsulot + SKU'lar + `inputSchema` + `help` + stok |

Namuna (`GET /catalog/products/telegram-stars`):

```json
{
  "success": true,
  "data": {
    "slug": "telegram-stars",
    "name": "Telegram Stars",
    "deliveryType": "TG_USERNAME",
    "regionBadge": "GLOBAL",
    "isAuto": true,
    "allowCustomQty": true,
    "minQty": 50,
    "maxQty": 100000,
    "inputSchema": [{ "key": "username", "type": "tgUsername", "label": "fields.tgUsername" }],
    "skus": [
      { "id": "sku_50", "label": "50 ⭐", "quantity": 50, "fromPriceTiyin": "1100000" },
      { "id": "sku_100", "label": "100 ⭐", "quantity": 100, "fromPriceTiyin": "2200000" }
    ],
    "unitPriceTiyin": "22000"
  }
}
```

`fromPriceTiyin` — ko‘rsatish uchun taxminiy narx; haqiqiy narx faqat kotirovkada.

## Qabul qiluvchi va kotirovka

| POST | `/recipients/validate` | `{ productId, input: { username } }` → `{ recipientToken, displayName, photoUrl?, warnings[] }` |
| ---- | ---------------------- | ----------------------------------------------------------------------------------------------- |
| POST | `/quotes`              | `{ productId, skuId? , quantity?, recipientToken, discountCode? }` → kotirovka                  |

```json
{
  "success": true,
  "data": {
    "quoteId": "q_...",
    "priceTiyin": "2200000",
    "discountTiyin": "0",
    "totalTiyin": "2200000",
    "expiresAt": "2026-11-01T10:10:00Z",
    "recipient": { "username": "aziz_k", "displayName": "Aziz" }
  }
}
```

`recipientToken` 10 daqiqa amal qiladi va faqat shu foydalanuvchi + mahsulot uchun.

## Buyurtmalar

| POST | `/orders`            | header `Idempotency-Key`; body `{ quoteId }` → `201 { order }` yoki `422 INSUFFICIENT_BALANCE` |
| ---- | -------------------- | ---------------------------------------------------------------------------------------------- |
| GET  | `/orders?status=`    | ro‘yxat                                                                                        |
| GET  | `/orders/:id`        | tafsilot + `timeline[]` (holatlar) + voucher kodi (DELIVERED bo‘lsa)                           |
| GET  | `/orders/:id/stream` | SSE: holat o‘zgarishlari (ixtiyoriy; polling ham ishlaydi)                                     |

Buyurtma holatlari klientda: `PAID, QUEUED → "Navbatda"`, `PROCESSING → "Bajarilmoqda"`,
`HELD, NEEDS_REVIEW → "Tekshirilmoqda"`, `DELIVERED → "Yetkazildi"`,
`FAILED, REFUNDED → "Bajarilmadi — pul qaytarildi"`, `CANCELLED → "Bekor qilindi"`.

## To‘lovlar

| GET  | `/payments/methods`                                   | faol provayderlar, min/max, komissiya ma'lumoti                                                                                        |
| ---- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| POST | `/payments/intents`                                   | `Idempotency-Key`; `{ provider, amountTiyin, purpose: "TOPUP" \| "TOPUP_AND_BUY", quoteId? }` → `{ intentId, redirectUrl, expiresAt }` |
| GET  | `/payments/intents/:id`                               | holat (`PENDING \| PAID \| CANCELLED \| EXPIRED`), buyurtma (TOPUP_AND_BUY bo‘lsa)                                                     |
| POST | `/payments/click/prepare`, `/payments/click/complete` | Click callback (public, imzo)                                                                                                          |
| POST | `/payments/payme`                                     | Payme JSON-RPC (public, Basic auth)                                                                                                    |
| POST | `/payments/uzum/*`, `/payments/rahmat/*`              | shartnoma hujjatiga ko‘ra                                                                                                              |

`TOPUP_AND_BUY`: to‘lov tasdiqlanganda shu tranzaksiyada TOPUP yoziladi, keyin kotirovka hali
amal qilsa avtomatik xarid qilinadi; amal qilmasa pul balansda qoladi va foydalanuvchiga xabar boradi.

## Referal, keshbek, promo

| GET  | `/referrals`                                                                       | `{ link, miniAppLink, invitedCount, earnedTiyin, invited: [...] }` |
| ---- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| GET  | `/discounts/tiers` · POST `/discounts/codes` `{ tierId }` · GET `/discounts/codes` | chegirma kodlari                                                   |
| POST | `/bonus-codes/redeem`                                                              | `{ code }` → mukofot                                               |

## Admin (`/api/v1/admin/*`) — batafsil `docs/09-ADMIN-PANEL.md`

`auth/*`, `dashboard`, `orders` (+ `retry`, `mark-delivered`, `fail-and-refund`, `cancel`),
`users` (+ `block`, `adjust-wallet`), `products`, `skus`, `routes`, `pricing/settings`,
`payments` (+ reconcile hisobotlari), `suppliers` (balanslar, holat), `wallet` (TON balans, limitlar),
`fragment/session` (holat, yangilash), `bonus-codes`, `discount-tiers`, `broadcasts`, `audit-log`,
`settings`, `admins` (faqat OWNER).

## Health

`GET /health/live` → `{status:"ok"}` · `GET /health/ready` → `{status, db, redis, worker, fragment}`.
