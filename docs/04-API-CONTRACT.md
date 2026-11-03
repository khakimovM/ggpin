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
| 503  | `PRICE_UNAVAILABLE`                                                            | narx kursi/tannarxi yo‘q yoki 30 daqiqadan eski                         |

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
Kesh siyosati: har bir javob (xatolar ham) odatda `Cache-Control: no-store` bilan qaytadi.
Faqat `@PublicCache(N)` bilan belgilangan yo‘l — hozir uchta `GET /catalog/*` — muvaffaqiyatli
(200) javobda `public, max-age=60` beradi; shu yo‘llarning 400/404/5xx javoblari ham
`no-store`. IP limitlarida IPv6 manzillar /64 tarmoq bo‘yicha sanaladi.

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

Uchala yo‘l ochiq (sessiyasiz), javob hamma uchun bir xil, shuning uchun `200` javobda
`Cache-Control: public, max-age=60`; xatolar `no-store`. Har bir IP uchun 600 so‘rov/daqiqa
(`RATE_LIMITED`). Faqat faol (`isActive`) mahsulotlar ko‘rinadi; faol bo‘lmagan mahsulot
ro‘yxatda yo‘q, tafsilotda `404 NOT_FOUND`. Hamma so‘rovlarda `?locale=uz|ru` (standart `uz`);
boshqa qiymat yoki noma’lum kalit — `400 VALIDATION_ERROR`. Mahsulot brend nomlari (Telegram
Stars, PUBG Mobile) ikkala tilda bir xil.

| GET | `/catalog/categories?locale=`                            | kategoriyalar (`sort` tartibida), faqat kamida 1 faol mahsuloti borlari |
| --- | -------------------------------------------------------- | ----------------------------------------------------------------------- |
| GET | `/catalog/products?category=&q=&locale=&page=1&limit=20` | ro‘yxat; `limit` ≤ 100, `category` — slug, `q` ≤ 64 belgi               |
| GET | `/catalog/products/:slug?locale=`                        | mahsulot + SKU'lar + `inputSchema` + `help` + stok                      |

`q` — nomning (uz **yoki** ru) bir qismi, katta-kichik harfga e’tiborsiz; `%` va `_` oddiy
belgi sifatida qidiriladi. Bo‘sh `q` — filtrsiz.

**`GET /catalog/categories?locale=ru`** → `data` massiv (sahifalanmaydi, ko‘pi bilan 100):

```json
{
  "success": true,
  "data": [
    { "slug": "telegram", "name": "Сервисы Telegram", "productCount": 2 },
    { "slug": "games", "name": "Игры", "productCount": 4 }
  ]
}
```

**`GET /catalog/products?category=telegram&limit=2`**:

```json
{
  "success": true,
  "data": [
    {
      "id": "t8uqj5v97wzo7r850h24xis1",
      "slug": "telegram-stars",
      "categorySlug": "telegram",
      "name": "Telegram Stars",
      "imageUrl": "/images/stars.png",
      "regionBadge": "GLOBAL",
      "deliveryType": "TG_USERNAME",
      "isAuto": true,
      "isFeatured": false,
      "inStock": true,
      "fromPriceTiyin": "550000"
    }
  ],
  "meta": { "page": 1, "limit": 2, "total": 2 }
}
```

**`GET /catalog/products/telegram-stars?locale=ru`**:

```json
{
  "success": true,
  "data": {
    "id": "t8uqj5v97wzo7r850h24xis1",
    "slug": "telegram-stars",
    "name": "Telegram Stars",
    "description": "Звёзды доставляются на ваш @username",
    "help": "Введите имя пользователя без @",
    "imageUrl": "/images/stars.png",
    "deliveryType": "TG_USERNAME",
    "regionBadge": "GLOBAL",
    "isAuto": true,
    "allowCustomQty": true,
    "minQty": 50,
    "maxQty": 100000,
    "inputSchema": [{ "key": "username", "type": "tgUsername", "label": "fields.tgUsername" }],
    "skus": [
      {
        "id": "yjo81wz8x26v7v2m20s9imoh",
        "label": "50 ⭐",
        "quantity": 50,
        "tab": null,
        "fromPriceTiyin": "550000"
      },
      {
        "id": "xw3zlokwzc4mpkeemvefxduo",
        "label": "100 ⭐",
        "quantity": 100,
        "tab": null,
        "fromPriceTiyin": "1100000"
      }
    ],
    "unitPriceTiyin": "11000",
    "stock": null,
    "currency": "UZS"
  }
}
```

- `fromPriceTiyin` / `unitPriceTiyin` — faqat ko‘rsatish uchun taxminiy narx; haqiqiy narx faqat
  kotirovkada. Yangi (≤ 30 daqiqa) kurs yoki tannarx bo‘lmasa `null` — mijoz narxni ko‘rsatmaydi
  (xato emas, javob `200`). Ro‘yxatda `fromPriceTiyin` — eng arzon SKU narxi.
- `unitPriceTiyin` — eng kichik SKU narxining bir birlikka bo‘lingani (yuqoriga yaxlitlanadi).
- `skus` — faqat faol SKU'lar, miqdor bo‘yicha o‘sish tartibida. `tab` — guruh i18n kaliti
  yoki `null`.
- `stock` — `null` = cheksiz (voucher'siz mahsulotlar); voucher mahsulotlarda `AVAILABLE`
  kodlar soni. Ro‘yxatda `inStock = stock > 0` (cheksizda `true`).
- `description` / `help` tarjimasi bo‘lmasa `null` (boshqa tilga almashtirilmaydi).
- `inputSchema` maydon `label`i — `packages/i18n` kaliti; matn klientda tarjima qilinadi.

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
Ikkala yo‘l konvertsiz (D-24) va `no-store`. `/health/ready`: Postgres va Redis ishlasa `200`;
faqat worker yo‘q bo‘lsa ham `200`, lekin `status: "degraded"`, `worker: "down"` (D-30.1: worker
qayta ishga tushganda API balansirovshchikdan chiqarilmaydi). `503` — faqat Postgres yoki Redis
ishlamaganda, tana o‘sha shaklda.
