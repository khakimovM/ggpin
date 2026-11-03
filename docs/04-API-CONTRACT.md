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

| HTTP | Kod                                                                            | Qachon                                                                  |
| ---- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| 400  | `VALIDATION_ERROR`                                                             | Zod xatosi (`details.fields`)                                           |
| 401  | `UNAUTHORIZED`, `INITDATA_INVALID`, `INITDATA_EXPIRED`, `TOKEN_REUSE_DETECTED` | auth                                                                    |
| 403  | `USER_BLOCKED`, `PURCHASE_FROZEN`                                              | bloklangan / to‘lov qaytarilgan foydalanuvchi                           |
| 404  | `NOT_FOUND`                                                                    | resurs yo‘q yoki boshqa foydalanuvchiniki                               |
| 409  | `IDEMPOTENCY_CONFLICT`                                                         | bir xil kalit, boshqa body                                              |
| 410  | `QUOTE_EXPIRED`                                                                | kotirovka muddati tugagan                                               |
| 413  | `PAYLOAD_TOO_LARGE`                                                            | so‘rov tanasi ruxsat etilgan hajmdan katta                              |
| 422  | `INSUFFICIENT_BALANCE` (`details: {balance, required, shortfall}`)             | balans yetmaydi                                                         |
| 422  | `RECIPIENT_NOT_FOUND`, `RECIPIENT_INVALID`, `RECIPIENT_HAS_PREMIUM`            | qabul qiluvchi                                                          |
| 422  | `PRODUCT_UNAVAILABLE`, `OUT_OF_STOCK`, `QTY_OUT_OF_RANGE`                      | katalog                                                                 |
| 422  | `TOPUP_AMOUNT_OUT_OF_RANGE`                                                    | to‘ldirish chegaralari                                                  |
| 422  | `CODE_INVALID`, `CODE_EXPIRED`, `CODE_ALREADY_USED`, `NOT_ENOUGH_COINS`        | promo; `CODE_INVALID`/`CODE_EXPIRED` web kirish OTP’si uchun ham (D-26) |
| 429  | `RATE_LIMITED`                                                                 | throttler                                                               |
| 500  | `INTERNAL_ERROR`                                                               | kutilmagan server xatosi (stack trace hech qachon javobga chiqmaydi)    |
| 503  | `FULFILLMENT_UNAVAILABLE`, `RECIPIENT_CHECK_UNAVAILABLE`                       | Fragment/ta'minotchi ishlamayapti                                       |

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

2-fazada aniqlangan shakllar (D-26, D-27, D-29). `user` — quyidagi `GET /me` shakli.
`/auth/*` va `/me*` javoblari (xatolar ham) `Cache-Control: no-store` bilan qaytadi. IP
limitlarida IPv6 manzillar /64 tarmoq bo‘yicha sanaladi.

- **Kanallar.** Web — ikkita cookie: access (`path=/`, 15 daqiqa) va refresh
  (`path=/api/v1/auth`, 30 kun), ikkalasi host-only, `HttpOnly`, `SameSite=Lax`, `Secure`.
  Mini App — `Authorization: Bearer <token>` (cookie’siz).
- **CSRF.** Har bir yozuv so‘rovida (POST/PUT/PATCH/DELETE) `X-CSRF-Token` sarlavhasi va
  ruxsat etilgan `Origin` talab qilinadi, ochiq login yo‘llarida ham. Bearer token qabul
  qilingan so‘rov bundan ozod. Tekshiruv o‘tmasa — `404 NOT_FOUND`.
- `POST /auth/telegram/webapp` — `{ initData }` (≤ 4096 belgi) →
  `{ token, expiresIn: 3600, user }`. `initData` Telegram HMAC’i bilan tekshiriladi.
  Imzo to‘g‘ri, lekin `TG_INITDATA_MAX_AGE_SEC`dan (standart 24 soat) eski bo‘lsa —
  `401 INITDATA_EXPIRED`; boshqa har qanday nosozlik — `401 INITDATA_INVALID`. Bloklangan
  foydalanuvchi — `403 USER_BLOCKED`. Limit: bitta Telegram akkauntga 10/daqiqa (imzo
  tekshirilgandan keyin sanaladi) va IP’ga 120/daqiqa; oshsa — `429 RATE_LIMITED`
  (`Retry-After` sarlavhasi bilan, har ikkala limitda ham).
- `POST /auth/telegram/start` — `{}` → `{ nonce, botUrl }`. `nonce` 43 belgi (base64url),
  10 daqiqa yashaydi. Limit: 30/daqiqa/IP.
- `GET /auth/telegram/status/:nonce` → `{ status }`. Ishlatilgan so‘rov `EXPIRED` bo‘lib
  ko‘rinadi. Botda «Bu men emasman» bosilgan bo‘lsa — `DENIED`, kod allaqachon ishlatilgan
  bo‘lsa ham. Noma’lum yoki noto‘g‘ri shakldagi nonce — `404`. Limit: 300/daqiqa/IP.
- `POST /auth/telegram/verify` — `{ nonce, code }` (`code` — 6 raqam) → ikkala cookie +
  `{ user }`. Kod bot yuborganidan keyin 3 daqiqa amal qiladi, 5 urinish, bir martalik.
  Xatolar:
  - `422 CODE_INVALID` + `details.attemptsLeft`;
  - `422 CODE_EXPIRED` (muddati o‘tgan, ishlatilgan, rad etilgan yoki urinishlar tugagan);
  - `403 USER_BLOCKED`.

  Limit: 30/daqiqa/IP (har bir nonce’ga 5 urinish alohida). Muvaffaqiyatli kirishdan keyin
  bot foydalanuvchiga «yangi kirish» xabarini yuboradi (qurilma, yashirilgan IP, vaqt va
  sessiyani yopish tugmasi).

- `POST /auth/refresh` — refresh cookie → yangi cookie juftligi + `{ user }`. Refresh token
  har safar almashadi. Xatolarda cookie’lar ham tozalanadi:
  - `401 UNAUTHORIZED` — yo‘q, noma’lum yoki muddati o‘tgan token;
  - `401 TOKEN_REUSE_DETECTED` — eski token qayta ishlatildi, butun sessiya oilasi bekor
    qilinadi;
  - `403 USER_BLOCKED`.
- `POST /auth/logout` → `{}`. Har doim `200`, cookie’larni tozalaydi va refresh cookie
  bo‘lsa uning sessiyasini yopadi.
- `GET /auth/sessions` → `[{ id, userAgent, ipMasked, createdAt, lastUsedAt, current }]`.
  `ipMasked`: IPv4 `203.0.113.x`, IPv6 `2001:db8:85a3::x`. Eng ko‘pi 100 ta, oxirgi
  ishlatilgani birinchi.
- `DELETE /auth/sessions/:id` → `{}`. O‘zining joriy sessiyasi bo‘lsa cookie’lar ham
  tozalanadi; boshqa foydalanuvchiniki yoki noma’lum id — `404`.

## Telegram

| Metod | Yo‘l                | Tavsif                                                                                                                                                                                                            |
| ----- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST  | `/telegram/webhook` | Telegram update’lari (faqat `TELEGRAM_BOT_MODE=webhook`). `X-Telegram-Bot-Api-Secret-Token` mos kelmasa — `404`. Javob konvertsiz `{ ok: true }`, handler xatosida ham `200` (Telegram qayta yubormasligi uchun). |

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
