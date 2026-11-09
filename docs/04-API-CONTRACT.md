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

| HTTP | Kod                                                                            | Qachon                                                                                                                                                                                               |
| ---- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400  | `VALIDATION_ERROR`                                                             | Zod xatosi (`details.fields`)                                                                                                                                                                        |
| 401  | `UNAUTHORIZED`, `INITDATA_INVALID`, `INITDATA_EXPIRED`, `TOKEN_REUSE_DETECTED` | auth                                                                                                                                                                                                 |
| 403  | `USER_BLOCKED`, `PURCHASE_FROZEN`                                              | bloklangan / to‘lov qaytarilgan foydalanuvchi                                                                                                                                                        |
| 404  | `NOT_FOUND`                                                                    | resurs yo‘q yoki boshqa foydalanuvchiniki                                                                                                                                                            |
| 409  | `IDEMPOTENCY_CONFLICT` (to‘lov so‘rovida `details: {intentId}`)                | bir xil kalit, boshqa body; to‘lov so‘rovida yana: bir xil body, lekin so‘rov endi `PENDING`/muddatli emas                                                                                           |
| 409  | `TOPUP_ALREADY_PENDING` (`details: {intentId}`)                                | foydalanuvchida kutilayotgan to‘ldirish so‘rovi bor                                                                                                                                                  |
| 410  | `QUOTE_EXPIRED`                                                                | kotirovka muddati tugagan                                                                                                                                                                            |
| 413  | `PAYLOAD_TOO_LARGE`                                                            | so‘rov tanasi ruxsat etilgan hajmdan katta                                                                                                                                                           |
| 422  | `INSUFFICIENT_BALANCE` (`details: {balance, required, shortfall}`)             | balans yetmaydi                                                                                                                                                                                      |
| 422  | `RECIPIENT_NOT_FOUND`, `RECIPIENT_INVALID`, `RECIPIENT_HAS_PREMIUM`            | qabul qiluvchi                                                                                                                                                                                       |
| 422  | `PRODUCT_UNAVAILABLE`, `OUT_OF_STOCK`, `QTY_OUT_OF_RANGE`                      | katalog                                                                                                                                                                                              |
| 422  | `TOPUP_AMOUNT_OUT_OF_RANGE` (`details: {min, max, step, reason?}`)             | to‘ldirish chegaralari; `reason`: `DAILY_LIMIT` (barcha akkaunt, 24 soat), `NEW_ACCOUNT_DAILY_LIMIT` (7 kundan yosh akkaunt); kunlik limitda `max` = bugun QOLGAN limit (`max < min` — limit tugadi) |
| 422  | `CODE_INVALID`, `CODE_EXPIRED`, `CODE_ALREADY_USED`, `NOT_ENOUGH_COINS`        | promo; `CODE_INVALID`/`CODE_EXPIRED` web kirish OTP’si uchun ham (D-26)                                                                                                                              |
| 429  | `RATE_LIMITED`                                                                 | throttler; to‘ldirish: 5 so‘rov / 10 daqiqa, 10 so‘rov / 24 soat, bir vaqtda 3 TO‘LANMAGAN band so‘rov (`Retry-After`)                                                                               |
| 500  | `INTERNAL_ERROR`                                                               | kutilmagan server xatosi (stack trace hech qachon javobga chiqmaydi)                                                                                                                                 |
| 503  | `FULFILLMENT_UNAVAILABLE`, `RECIPIENT_CHECK_UNAVAILABLE`                       | Fragment/ta'minotchi ishlamayapti                                                                                                                                                                    |
| 503  | `PRICE_UNAVAILABLE`                                                            | narx kursi/tannarxi yo‘q yoki 30 daqiqadan eski                                                                                                                                                      |
| 503  | `PAYMENT_METHOD_UNAVAILABLE`                                                   | to‘ldirish usuli hozir yo‘q (sig‘imli karta yo‘q yoki bank xabarlari tinglovchisi javob bermayapti)                                                                                                  |

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

- **Kanallar.** Web — ikkita cookie: access (`path=/`, 15 daqiqa) va refresh (`path=/`, 30 kun),
  ikkalasi API hostining o‘ziga (host-only), `HttpOnly`, `SameSite=Lax`, `Secure`. Production’da
  nomlari `__Host-access_token` va `__Host-refresh_token`: brauzer bunday cookie’ni faqat
  `Secure`, `Path=/` va `Domain`siz qabul qiladi, shuning uchun qo‘shni subdomen o‘z sessiya
  cookie’sini qo‘ya olmaydi (egasi qarori 2026-11-08; Q13 dagi `__Secure-refresh_token` o‘rniga).
  Boshqa muhitlarda (development, test) `access_token` va `refresh_token` (`Secure` development’da
  yo‘q). Eski nomlar production’da qabul qilinmaydi. Klient nomlarni bilmaydi (`HttpOnly`).
  Bir nom so‘rovda bir necha marta kelsa, so‘rov foydalanuvchiga bog‘lanmaydi: access takrorlansa
  `401 UNAUTHORIZED`; `POST /auth/refresh` da refresh takrorlansa `401 UNAUTHORIZED`, cookie’lar
  tozalanadi, hech bir sessiya aylantirilmaydi va bekor qilinmaydi; `POST /auth/logout` esa `200`
  qaytaradi va kelgan turli refresh qiymatlarining ko‘pi bilan 5 tasini bekor qiladi.
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
| GET   | `/me/ledger` | moliya tarixi (kind filtri; «Hamyon» bo‘limiga qarang)                                 |

## Hamyon

Balans saqlanmaydi: u `LedgerEntry` yig‘indisi (Redis keshi `wallet:{userId}`, har ledger yozuvidan keyin o‘chiriladi).
Ikkala yo‘l ham sessiya talab qiladi, javoblari `Cache-Control: no-store`. Pul — string, tiyinda.

**`GET /me/wallet`**

```json
{
  "success": true,
  "data": { "balanceTiyin": "2034100", "coins": "0", "currency": "UZS" }
}
```

- `balanceTiyin` ishorali: to‘ldirish bekor qilinib (`TOPUP_REVERSAL`) pul allaqachon sarflangan bo‘lsa manfiy bo‘lishi mumkin
  (`"-550000"`); shunda hisob xaridlar uchun muzlatiladi (`403 PURCHASE_FROZEN`), to‘ldirish esa ochiq qoladi.
- `coins` — keshbek tangalari soni, string; 10-bosqichgacha doim `"0"`.

**`GET /me/ledger?kind=&page=1&limit=20`** — moliya tarixi, eng yangisi birinchi. `kind` ixtiyoriy
(`TOPUP`, `TOPUP_REVERSAL`, `PURCHASE`, `REFUND`, `REFERRAL_BONUS`, `REFERRAL_BONUS_REVERSAL`, `ADJUSTMENT`); noma’lum qiymat,
noma’lum kalit yoki `limit` > 100 — `400 VALIDATION_ERROR`. Faqat o‘zining yozuvlari.

```json
{
  "success": true,
  "data": [
    {
      "id": "cm3ledger0000000000000001",
      "kind": "PURCHASE",
      "amountTiyin": "-550000",
      "createdAt": "2026-11-04T10:12:00.000Z",
      "orderId": "cm3order00000000000000001",
      "paymentId": null
    },
    {
      "id": "cm3ledger0000000000000000",
      "kind": "TOPUP",
      "amountTiyin": "2034100",
      "createdAt": "2026-11-04T10:05:00.000Z",
      "orderId": null,
      "paymentId": "cm3payment00000000000001"
    }
  ],
  "meta": { "page": 1, "limit": 20, "total": 2 }
}
```

- `amountTiyin` ishorali: kirim musbat, chiqim manfiy.
- `orderId` faqat buyurtmadan kelgan yozuvda (`PURCHASE`, `REFUND`), `paymentId` faqat to‘lovdan kelganida (`TOPUP`,
  `TOPUP_REVERSAL`); qolganlarida (`REFERRAL_BONUS*`, `ADJUSTMENT`) ikkalasi `null` — ichki audit id ko‘rsatilmaydi.

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
- `allowCustomQty` / `minQty` / `maxQty` — **haqiqatan kotirovka qabul qiladigan** erkin miqdor oralig‘i,
  saqlangan ustunlar emas: `minQty` = max(saqlangan `minQty`, eng kichik **faol** paket miqdori), `maxQty` o‘zgarmaydi
  (eng kichik paketdan past miqdorda markup oladigan paket yo‘q, shuning uchun u kotirovkada rad etiladi). Erkin miqdor
  o‘chirilgan, oraliq berilmagan, faol paket yo‘q yoki eng kichik faol paket `maxQty` dan katta bo‘lsa —
  `allowCustomQty: false`, `minQty: null`, `maxQty: null`. Katalog va `POST /quotes` shu bitta qoidadan foydalanadi, shuning
  uchun katalog kotirovka rad etadigan miqdorni hech qachon ko‘rsatmaydi. Erkin miqdorli mahsulotda bir xil miqdorli ikki
  faol paket bo‘lsa, erkin miqdor yopiladi (`allowCustomQty: false`, `minQty: null`, `maxQty: null`; `POST /quotes` —
  `QTY_OUT_OF_RANGE` `{ min: null, max: null }`), chunki qaysi paket narx berishi noaniq bo‘ladi; paketlar baribir `skuId`
  bilan sotiladi. 9-bosqich admin paneli bunday juftlikni yaratishga yo‘l qo‘ymaydi.
- Narx manbai: `allowCustomQty` bo‘lmagan mahsulot (masalan Premium) faqat **paket darajasidagi** tannarxdan narxlanadi;
  mahsulot darajasidagi tannarx qatori unda hech qachon so‘ralmaydi va ishlatilmaydi. Paket qatori eskirgan bo‘lsa katalogda
  `fromPriceTiyin: null`, kotirovkada `503 PRICE_UNAVAILABLE`. Erkin miqdorli mahsulotda (Stars) yangi paket qatori
  ustun, aks holda mahsulot qatori ishlatiladi.
- `stock` — `null` = cheksiz (voucher'siz mahsulotlar); voucher mahsulotlarda `AVAILABLE`
  kodlar soni. Ro‘yxatda `inStock = stock > 0` (cheksizda `true`).
- `description` / `help` tarjimasi bo‘lmasa `null` (boshqa tilga almashtirilmaydi).
- `inputSchema` maydon `label`i — `packages/i18n` kaliti; matn klientda tarjima qilinadi.

## Qabul qiluvchi va kotirovka

| POST | `/recipients/validate` | `{ productId, input: { username } }` → `{ recipientToken, displayName, photoUrl?, warnings[] }` (LOYIHA / DRAFT, 5-bosqich; shakli quyida) |
| ---- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| POST | `/quotes`              | `{ productId, skuId? , quantity?, recipientToken, discountCode? }` → `201` kotirovka                                                       |

`recipientToken` — 43 belgili base64url, 10 daqiqa amal qiladi, faqat shu foydalanuvchi +
shu mahsulot uchun va ishlatilganda o‘chmaydi: foydalanuvchi shu qabul qiluvchi
uchun muddat ichida boshqa paketga ham kotirovka olishi mumkin. Token Redis'da faqat SHA-256
xeshi bilan saqlanadi. `/recipients/validate` 5-bosqichda qo‘shiladi; shu paytgacha token
faqat testlarda beriladi.

**`POST /recipients/validate`** — **LOYIHA (DRAFT): 5-bosqich rejasida tasdiqlanadi.** Shakl frontend mock yozishi uchun oldindan yozilgan;
o‘zgarishi mumkin. Sessiya majburiy (cookie sessiyada `X-CSRF-Token` va `Origin`, Bearer’da kerak emas). Body `.strict()`:

```json
{ "productId": "t8uqj5v97wzo7r850h24xis1", "input": { "username": "aziz_k" } }
```

- `input` kalitlari — mahsulotning `inputSchema` maydonlari (`key`); qiymat maydon turiga qarab tekshiriladi (`tgUsername`:
  5–32 belgi, harf/raqam/`_`, harf bilan boshlanadi, `@` siz — katalogdagi `help` matni shuni aytadi). O‘yinlarda (G-bosqichlar) kalitlar
  `playerId`, `zone` kabi bo‘ladi. Ortiqcha kalit — `400`.
- Javob `200` (qabul qiluvchi topildi):

```json
{
  "success": true,
  "data": {
    "recipientToken": "<43 belgili token>",
    "displayName": "Aziz",
    "photoUrl": "https://cdn.example/avatars/aziz.jpg",
    "warnings": []
  }
}
```

- `photoUrl` ixtiyoriy (rasm bo‘lmasa kalit yo‘q). `recipientToken` — yuqoridagi qoidalar bilan (43 belgi, 10 daqiqa, shu foydalanuvchi va mahsulot).
- `warnings[]` — qabul qiluvchi to‘g‘ri, lekin foydalanuvchi bilishi kerak bo‘lgan **bloklamaydigan** holatlar. Element: `{ "code": "…",
"message": "warnings.…" }` (`message` — i18n kaliti). Hozircha hech qanday ogohlantirish yo‘q: doim `[]`. Qabul qiluvchi mahsulotni olmasa
  (masalan «Premium allaqachon bor») bu bloklovchi `422 RECIPIENT_HAS_PREMIUM` bo‘lib qoladi; Fragment’ning haqiqiy xatti-harakati 5-bosqich
  fixture’lari bilan tasdiqlanadi (`docs/06-FULFILLMENT.md`).
- Javob `Cache-Control: no-store`.

| Status | Kod                            | Qachon                                                                     |
| ------ | ------------------------------ | -------------------------------------------------------------------------- |
| 400    | `VALIDATION_ERROR`             | body shakli yoki `input` qiymati noto‘g‘ri; noma’lum kalit                 |
| 401    | `UNAUTHORIZED`                 | sessiya yo‘q yoki yaroqsiz                                                 |
| 404    | `NOT_FOUND`                    | `productId` mavjud emas; cookie sessiyada CSRF/`Origin` noto‘g‘ri          |
| 422    | `PRODUCT_UNAVAILABLE`          | mahsulot faol emas                                                         |
| 422    | `RECIPIENT_NOT_FOUND`          | format to‘g‘ri, lekin Fragment/ta’minotchi bunday qabul qiluvchini topmadi |
| 429    | `RATE_LIMITED` + `Retry-After` | tavsiya: 20 so‘rov / daqiqa / foydalanuvchi                                |
| 503    | `RECIPIENT_CHECK_UNAVAILABLE`  | tekshiruv ~10 soniyada tugamadi yoki ta’minotchi ishlamayapti              |

**`POST /quotes`** — sessiya majburiy (cookie sessiyada `X-CSRF-Token` + ruxsat etilgan
`Origin` ham kerak, aks holda `404 NOT_FOUND`, D-26; Mini App Bearer tokeni uchun CSRF kerak
emas). `skuId` va `quantity` dan **aynan bittasi** berilishi shart: `skuId` — tayyor paket,
`quantity` — erkin miqdor (faqat `allowCustomQty` mahsulotlarda, katalog ko‘rsatgan `minQty..maxQty` oralig‘ida).
Erkin miqdor faol paketning miqdoriga teng bo‘lsa, kotirovka shu paket bilan (`skuId` yuborilgandek) hisoblanadi: "100" yozish
va 100 paketini bosish bir xil narx.
Body `strict`: noma’lum kalit — `400`. `userId` hech qachon body'da emas, faqat sessiyadan.

```json
// so‘rov
{
  "productId": "t8uqj5v97wzo7r850h24xis1",
  "skuId": "yjo81wz8x26v7v2m20s9imoh",
  "recipientToken": "<43 belgili token: /recipients/validate javobidan>"
}
```

```json
// 201
{
  "success": true,
  "data": {
    "quoteId": "ghj3p0w7k1cz9r4t6u8v2xyb",
    "priceTiyin": "550000",
    "discountTiyin": "0",
    "totalTiyin": "550000",
    "expiresAt": "2026-11-03T10:10:00.000Z",
    "recipient": { "username": "aziz_k", "displayName": "Aziz" },
    "currency": "UZS"
  }
}
```

- Kotirovka **10 daqiqa** amal qiladi (`expiresAt`) va shu foydalanuvchiga bog‘langan: narx
  shu paytda qulflanadi. Javobda tannarx, kurs, ustama yoki ichki id'lar **yo‘q**.
- `totalTiyin = priceTiyin − discountTiyin`. Chegirma kodlari 10-bosqichda; hozir
  `discountCode` berilsa — `422 CODE_INVALID`.
- Javob har doim `Cache-Control: no-store` (muvaffaqiyatda ham, xatoda ham).
- Kotirovka pul harakatlantirmaydi, shuning uchun `Idempotency-Key` yo‘q; bir kotirovka ikki
  marta sarflanmasligini 5-bosqichda `Order.quoteId` (unique) va `usedAt` kafolatlaydi.
- Har `201` — YANGI kotirovka va to‘liq TTL (10 daqiqa): bir xil body bilan qayta so‘rov ham yangi
  `quoteId` va yangi `expiresAt` beradi (mijoz “narxni yangilash”da shunga tayanadi; eski kotirovka
  uzaytirilmaydi).

Xatolar:

| Status | Kod                                          | Qachon                                                                                                                                                                |
| ------ | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400    | `VALIDATION_ERROR`                           | `skuId` va `quantity` birga yoki ikkalasi ham yo‘q; noma’lum kalit; token formati noto‘g‘ri                                                                           |
| 401    | `UNAUTHORIZED`                               | sessiya yo‘q yoki yaroqsiz                                                                                                                                            |
| 404    | `NOT_FOUND`                                  | `productId` mavjud emas; cookie sessiyada CSRF sarlavhasi/`Origin` yo‘q yoki noto‘g‘ri (D-26)                                                                         |
| 422    | `PRODUCT_UNAVAILABLE`                        | mahsulot faol emas; `skuId` shu mahsulotning faol paketi emas (noma’lum, nofaol yoki boshqa mahsulotniki)                                                             |
| 422    | `QTY_OUT_OF_RANGE` + `details: { min, max }` | erkin miqdor katalogdagi `minQty..maxQty` oralig‘idan tashqarida (`details` — shu amaldagi oraliq). Erkin miqdori yo‘q mahsulotda `details: { min: null, max: null }` |
| 422    | `RECIPIENT_INVALID`                          | token noma’lum, muddati o‘tgan, boshqa foydalanuvchiniki yoki boshqa mahsulotniki (javob bir xil)                                                                     |
| 422    | `CODE_INVALID`                               | `discountCode` berilgan (10-bosqichgacha)                                                                                                                             |
| 429    | `RATE_LIMITED` + `Retry-After`               | foydalanuvchiga 30 kotirovka/daqiqa                                                                                                                                   |
| 503    | `PRICE_UNAVAILABLE`                          | kurs yoki tannarx yo‘q / 30 daqiqadan eski; hech narsa yozilmaydi                                                                                                     |

Tekshiruv tartibi: limit → mahsulot → paket/miqdor → token → chegirma kodi → narx.

## Buyurtmalar

| POST | `/orders`            | header `Idempotency-Key`; body `{ quoteId }` → `201 { order }` yoki `422 INSUFFICIENT_BALANCE` |
| ---- | -------------------- | ---------------------------------------------------------------------------------------------- |
| GET  | `/orders?status=`    | ro‘yxat                                                                                        |
| GET  | `/orders/:id`        | tafsilot + `timeline[]` (holatlar) + voucher kodi (DELIVERED bo‘lsa)                           |
| GET  | `/orders/:id/stream` | SSE: holat o‘zgarishlari (ixtiyoriy; polling ham ishlaydi)                                     |

Buyurtma holatlari klientda: `PAID, QUEUED → "Navbatda"`, `PROCESSING → "Bajarilmoqda"`,
`HELD, NEEDS_REVIEW → "Tekshirilmoqda"`, `DELIVERED → "Yetkazildi"`,
`FAILED, REFUNDED → "Bajarilmadi — pul qaytarildi"`, `CANCELLED → "Bekor qilindi"`.

> **LOYIHA (DRAFT) — 5-bosqich rejasida tasdiqlanadi.** Quyidagi buyurtma shakllari (`POST /orders`, `GET /orders`, `GET /orders/:id`) va
> `/recipients/validate` frontend mock yoza olishi uchun oldindan yozilgan (D-37 (17)); 5-bosqichda o‘zgarishi mumkin. Maydonlar `Order` va
> `Quote` modellaridan hamda `docs/04`, `docs/06` dagi mavjud jumlalardan olingan. Hujjatlar hal qilmagan joylar uchun tavsiyalar pastda.

Hamma javob `Cache-Control: no-store`; hamma yo‘l sessiya talab qiladi; boshqa foydalanuvchining buyurtmasi — `404 NOT_FOUND`. Javoblarda
tannarx, kurs, ustama, urinishlar, ichki sabab matni va ichki id’lar **yo‘q**.

**Buyurtma (`order`)** — ro‘yxat elementi va `POST /orders` javobi shu shaklda:

```json
{
  "id": "cm3order00000000000000001",
  "number": 1042,
  "status": "PAID",
  "productId": "t8uqj5v97wzo7r850h24xis1",
  "productSlug": "telegram-stars",
  "productName": "Telegram Stars",
  "skuId": "yjo81wz8x26v7v2m20s9imoh",
  "quantity": 50,
  "recipient": { "displayName": "Aziz", "fields": { "username": "aziz_k" } },
  "priceTiyin": "550000",
  "discountTiyin": "0",
  "totalTiyin": "550000",
  "currency": "UZS",
  "createdAt": "2026-11-04T10:12:00.000Z",
  "deliveredAt": null
}
```

- `status` — xom holat (`PAID`, `QUEUED`, `PROCESSING`, `HELD`, `NEEDS_REVIEW`, `DELIVERED`, `FAILED`, `CANCELLED`, `REFUNDED`); yorliq
  klientda (yuqoridagi xarita). `number` — foydalanuvchiga ko‘rinadigan `#`.
- `recipient` har mahsulotga mos: `displayName` — ko‘rsatiladigan nom, `fields` — mahsulot formasi kalitlari (`{ username }` Telegram uchun,
  `{ playerId, zone }` o‘yin uchun); Telegram username’ga bog‘lanmagan.
- `totalTiyin = priceTiyin − discountTiyin` (kotirovkadagidek); hamyondan aynan `totalTiyin` yechiladi.
- `skuId` erkin miqdorli buyurtmada `null` bo‘lishi mumkin; `quantity` har doim bor.
- `productName` — katalogdagidek `?locale=uz|ru` bo‘yicha (standart `uz`); `GET /orders` va `GET /orders/:id` shu parametrni qabul qiladi.

**`POST /orders`** — `Idempotency-Key` majburiy; sessiya (cookie sessiyada `X-CSRF-Token` + `Origin`). Body `.strict()`:

```json
{ "quoteId": "ghj3p0w7k1cz9r4t6u8v2xyb" }
```

`201`: `data` — `{ "order": { … } }` (yuqoridagi shakl, `status: "PAID"`). Bitta tranzaksiyada hamyon qulflanadi, balans tekshiriladi,
`Order(PAID)` va `LedgerEntry(PURCHASE)` yoziladi; commit’dan keyin yetkazish navbatga qo‘yiladi. Idempotent takror (bir xil kalit va
body) — o‘sha buyurtma yana `201` bilan qaytadi, ikkinchi yechilish bo‘lmaydi.

Mijoz javobi yo‘qolgan (tarmoq uzilishi, timeout, `5xx`) so‘rovni o‘sha kalit va o‘sha `quoteId` bilan qayta yuboradi,
shuning uchun server tomonida (5-bosqich, D-49):

1. Takror so‘rov (bir xil `userId`, `Idempotency-Key`, body) kotirovka muddati (`410`) va “ishlatilgan” (`409 QUOTE_ALREADY_USED`)
   tekshiruvlaridan OLDIN hal qilinadi: saqlangan `201` qaytadi, kotirovka muddati o‘tgan bo‘lsa ham. `(userId, Idempotency-Key)`
   bo‘yicha replay qidiruvi hamyon qulfi olingandan KEYIN (qayta) bajariladi; `404` (kotirovka topilmadi), `409`/`410`/`422` faqat
   shundan keyin.
2. O‘sha kalitli parallel so‘rov birinchisining `201` javobini yoki `5xx` oladi, hech qachon `404`/`410`/`422` emas.
3. Replay yozuvi `Order` qatorining o‘zi (`@@unique([userId, idempotencyKey])`), muddatsiz.
4. Kotirovka qatori kamida 24 soat saqlanadi (klient noaniq urinish yozuvining TTL i); tozalash faqat shundan keyin, aks holda
   replay’dan keyingi `404` “kotirovka yo‘q” emas, “buyurtma yo‘q” deb o‘qiladi.

Klient shunga tayanadi: noaniq urinishni hal qiluvchi javoblar — `201`; `409 QUOTE_ALREADY_USED` + `orderId`; `410 QUOTE_EXPIRED`;
`422 INSUFFICIENT_BALANCE`; Mini App’da `404` — hammasi FAQAT bizning javob konvertida (`success:false`). Konvertsiz javob
(proksining HTML sahifasi, `502`) hech narsani hal qilmaydi. Webda konvertli `404` CSRF qo‘riqchisi ham bo‘lishi mumkin (D-26),
shuning uchun klient uni hal qiluvchi deb olmaydi. Kod va status juftligi ham tekshiriladi (`410`+`QUOTE_EXPIRED`, `422`+`INSUFFICIENT_BALANCE`,
`409`+`QUOTE_ALREADY_USED`, `404`+`NOT_FOUND`); mos kelmasa javob hal qilmaydi. Proksi/WAF ning o‘z xato javoblari hech qachon bizning
konvert shaklida (`success:false`) bo‘lmasin (devops). Javob shakli o‘zgarmaydi.

| Status | Kod                                                       | Qachon                                                    |
| ------ | --------------------------------------------------------- | --------------------------------------------------------- |
| 400    | `VALIDATION_ERROR`                                        | body shakli; `Idempotency-Key` yo‘q yoki shakli noto‘g‘ri |
| 401    | `UNAUTHORIZED`                                            | sessiya yo‘q                                              |
| 403    | `USER_BLOCKED`, `PURCHASE_FROZEN`                         | bloklangan; to‘lovi qaytarilgan (xarid cheklangan)        |
| 404    | `NOT_FOUND`                                               | kotirovka yo‘q yoki boshqa foydalanuvchiniki              |
| 409    | `IDEMPOTENCY_CONFLICT`                                    | bir xil kalit, boshqa body                                |
| 409    | `QUOTE_ALREADY_USED` + `{ orderId }` (tavsiya)            | kotirovka boshqa kalit bilan allaqachon ishlatilgan       |
| 410    | `QUOTE_EXPIRED`                                           | kotirovka muddati tugagan                                 |
| 422    | `INSUFFICIENT_BALANCE` + `{balance, required, shortfall}` | balans yetmaydi; hech narsa yozilmaydi                    |
| 429    | `RATE_LIMITED` + `Retry-After`                            | foydalanuvchiga 10 buyurtma/daqiqa                        |

«10 buyurtma/daqiqa» — o‘ylab topilmagan: manba `.claude/rules/10-backend-nestjs.md` («order create 10/min/user»).

**`GET /orders?status=&locale=&page=1&limit=20`** — faqat o‘zining buyurtmalari, eng yangisi birinchi. `status` ixtiyoriy: bitta xom holat yoki
vergul bilan ajratilgan bir nechtasi (`status=PAID,QUEUED`, klient yorliq guruhi uchun bitta so‘rov); noma’lum qiymat/kalit yoki `limit` > 100 — `400`.

```json
{
  "success": true,
  "data": [
    {
      "id": "cm3order00000000000000001",
      "number": 1042,
      "status": "DELIVERED",
      "…": "…"
    }
  ],
  "meta": { "page": 1, "limit": 20, "total": 1 }
}
```

**`GET /orders/:id?locale=`** — ro‘yxat shakli + `timeline[]` va `voucher`:

```json
{
  "success": true,
  "data": {
    "id": "cm3order00000000000000001",
    "number": 1042,
    "status": "DELIVERED",
    "…": "…",
    "deliveredAt": "2026-11-04T10:13:10.000Z",
    "timeline": [
      { "status": "PAID", "at": "2026-11-04T10:12:00.000Z" },
      { "status": "QUEUED", "at": "2026-11-04T10:12:01.000Z" },
      { "status": "PROCESSING", "at": "2026-11-04T10:12:05.000Z" },
      { "status": "DELIVERED", "at": "2026-11-04T10:13:10.000Z" }
    ],
    "voucher": null
  }
}
```

- `timeline` — holatga kirish vaqtlari, eskisi birinchi (kamida bitta); kim o‘zgartirgani va izoh ko‘rsatilmaydi.
- `voucher` — `{ "code": "…" }` faqat `DELIVERED` voucher mahsulotda (G4); Stars va Premium uchun doim `null`.
- Polling: terminal holatgacha har ~2 soniyada (`GET /orders/:id/stream` SSE — ixtiyoriy).

**5-bosqich shakllari: tavsiyalar** (hujjatlar hal qilmagan savollar; ega tasdig‘i 5-bosqich rejasida):

| #   | Savol                                    | Tavsiya                                                                                                                                       |
| --- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Q-A | «Premium allaqachon bor»                 | mavjud bloklovchi `422 RECIPIENT_HAS_PREMIUM` qoladi; `warnings[]` faqat bloklamaydigan holatlar uchun; haqiqiy Fragment javobi fixture bilan |
| Q-B | buyurtma javobida `productName` tili     | katalogdagidek `?locale=` (`uz` yoki `ru`) (standart `uz`)                                                                                    |
| Q-C | `GET /orders?status=`                    | vergul bilan ajratilgan bir nechta holat                                                                                                      |
| Q-D | boshqa kalit bilan ishlatilgan kotirovka | `409 QUOTE_ALREADY_USED` + `details.orderId` (faqat o‘zining buyurtmasi)                                                                      |
| Q-E | `/recipients/validate` limiti            | 20 so‘rov / daqiqa / foydalanuvchi                                                                                                            |
| Q-F | `POST /orders` javobi                    | hujjatdagi `{ order }` o‘rami saqlanadi                                                                                                       |
| —   | `Idempotency-Key` formati                | 8–128 belgi, `[A-Za-z0-9_-]`                                                                                                                  |

## To‘lovlar (P2P karta, D-31, D-37)

Hamyon foydalanuvchining o‘z kartasidan **bizning Humo yoki Uzcard kartamizga P2P o‘tkazma** bilan to‘ldiriladi. Har so‘rovga
noyob summa beriladi (asos summa 1 000 so‘mga karrali + 1–999 so‘m qo‘shimcha); to‘lov bank botlarining xabaridan shu summa
bo‘yicha topiladi (`docs/05-PAYMENTS.md`). Click, Payme, Uzum va Rahmat — keyinroq (D-04), ularning yo‘llari quyida «Keyinroq» bandida.

| Metod | Yo‘l                               | Kim                    | Tavsif                                                                    |
| ----- | ---------------------------------- | ---------------------- | ------------------------------------------------------------------------- |
| GET   | `/payments/methods`                | sessiya                | usullar, bank bo‘yicha mavjudlik, min/max/qadam                           |
| POST  | `/payments/intents`                | sessiya                | `Idempotency-Key`; yangi to‘ldirish so‘rovi → `201`                       |
| GET   | `/payments/intents?status=&limit=` | sessiya                | o‘z so‘rovlari, eng yangisi birinchi                                      |
| GET   | `/payments/intents/:id`            | sessiya                | bitta so‘rov holati (polling uchun)                                       |
| POST  | `/payments/intents/:id/cancel`     | sessiya                | kutilayotgan so‘rovni bekor qilish                                        |
| POST  | `/payments/intents/:id/pay-link`   | sessiya                | yangi to‘lov havolasi (eskisi o‘ladi)                                     |
| GET   | `/payments/pay/:intentId`          | `X-Pay-Token` sarlavha | `@Public`; to‘lov sahifasi uchun faqat shu so‘rovning ko‘rsatma ma’lumoti |

Cookie sessiyali yozuv so‘rovlarida (`POST`) `X-CSRF-Token` va ruxsat etilgan `Origin` kerak (D-26); Bearer tokenli Mini App
so‘rovida kerak emas. Hamma javoblar `Cache-Control: no-store`. Boshqa foydalanuvchining so‘rovi — `404 NOT_FOUND`.

**`Idempotency-Key`** (buyurtma va to‘lov so‘rovi yaratishda majburiy): 8–128 belgi, faqat `A–Z a–z 0–9 _ -` (UUID mos keladi);
foydalanuvchi bo‘yicha noyob. Yo‘q yoki shakli noto‘g‘ri — `400 VALIDATION_ERROR`.

### `GET /payments/methods`

```json
{
  "success": true,
  "data": [
    {
      "code": "P2P_CARD",
      "available": true,
      "banks": [
        { "bank": "HUMO", "available": true },
        { "bank": "UZCARD", "available": false }
      ],
      "minTiyin": "500000",
      "maxTiyin": "200000000",
      "stepTiyin": "100000"
    }
  ]
}
```

- `minTiyin` 5 000 so‘m, `maxTiyin` 2 000 000 so‘m (bitta so‘rov), `stepTiyin` 1 000 so‘m: klient chegaralarni qattiq yozmaydi, shu yerdan oladi.
- `available: false` — faol karta sig‘imi yo‘q yoki bank xabarlari tinglovchisi javob bermayapti; bank bo‘yicha alohida ko‘rsatiladi.

### `POST /payments/intents`

So‘rov (`.strict()`; noma’lum kalit, jumladan `quoteId` — `400`):

```json
{
  "provider": "P2P_CARD",
  "amountTiyin": "2000000",
  "purpose": "TOPUP",
  "bank": "HUMO"
}
```

- `amountTiyin` — **asos** summa (20 000 so‘m), 1 000 so‘mga karrali, `minTiyin..maxTiyin` ichida. `bank` ixtiyoriy: berilmasa
  avtomatik (bo‘sh sig‘imi eng ko‘p karta); bank ichida karta avtomatik tanlanadi.
- `purpose: "TOPUP_AND_BUY"` hozircha **`400 VALIDATION_ERROR`** (avtomatik xarid 5-bosqichda); `provider` faqat `P2P_CARD`.

`201`:

```json
{
  "success": true,
  "data": {
    "intentId": "cm3intent00000000000000001",
    "status": "PENDING",
    "baseAmountTiyin": "2000000",
    "payAmountTiyin": "2034100",
    "card": {
      "bank": "HUMO",
      "number": "9999000000000001",
      "holderName": "TEST H."
    },
    "expiresAt": "2026-11-04T10:30:00.000Z",
    "redirectUrl": "https://ggpin.uz/pay/cm3intent00000000000000001?locale=uz#t=<43 belgili token>",
    "currency": "UZS"
  }
}
```

- `payAmountTiyin` — foydalanuvchi **aynan shu** summani o‘tkazadi: `baseAmountTiyin` + 1–999 so‘m (`34100` tiyin = 341 so‘m).
  Summa kartaning boshqa so‘rovlaridan farq qiladi (D-37 (2)).
- **Band muddati.** Har summa `reservedUntil` gacha band: yaratilganda `expiresAt + 24 soat`; so‘rov `PAID` bo‘lsa `paidAt + 24 soat`
  (shunda to‘langandan keyin yana shu summa kelsa u begona pul emas, `DUPLICATE` deb taniladi). DB’da exclusion constraint bilan
  himoyalangan.
- Hisobga xabardagi **to‘liq tushgan summa** (`payAmountTiyin`) yoziladi, asos summa emas.
- `expiresAt` — yaratilgandan 30 daqiqa. Muddat tugagach (`EXPIRED`) kelgan pul 24 soat ichida, bitta nomzod bo‘lsa, baribir avtomatik yoziladi
  va foydalanuvchiga «kech tushdi» xabari boradi. **Bekor qilingan** (`CANCELLED`) so‘rovga kelgan pul avtomatik yozilmaydi: egaga
  ko‘rib chiqishga tushadi (`CANCELLED_LATE`). Grace’dan keyingi pul ham ko‘rib chiqishga tushadi.
- `card.number` — 16 raqam, ajratgichsiz (klient formatlaydi). Bu **bizning** qabul qiluvchi kartamiz; u faqat shu so‘rov egasiga
  va faqat `PENDING` holatda qaytadi. `card.holderName` — **qisqa shakl** (`ALISHER KARIMOV` → `ALISHER K.`); to‘liq ism API’dan chiqmaydi.
- **Yopishqoq karta.** Foydalanuvchiga imkon qadar oldingi kartasi beriladi; baribir karta raqami har safar boshqacha bo‘lishi mumkin
  (to‘lgan, bloklangan yoki bank o‘zgargan bo‘lsa). Shuning uchun Mini App va to‘lov sahifasi har safar «karta raqami har safar boshqacha
  bo‘lishi mumkin: eski kartaga o‘tkazmang» deb ogohlantiradi.
- `redirectUrl` — `null` emas: `${WEB_URL}/pay/<intentId>?locale=<uz|ru>#t=<token>`. Token URL **fragmentida** (`#t=`), so‘rov qatorida emas
  (D-37 (15), D-39). Sahifa tili — `?locale=` (foydalanuvchining tili, API qo‘yadi; D-38 Q21). Mini App uni `openLink` bilan ochadi.
- **Idempotent takror** (bir xil kalit va body): so‘rov hali `PENDING` va `now < expiresAt` bo‘lsa — o‘sha so‘rov yana `201` bilan, **yangi** token
  bilan qaytadi (eski havola o‘ladi). Aks holda (so‘rov `PAID`, `EXPIRED`, `CANCELLED`) yangi havola berilmaydi: `409 IDEMPOTENCY_CONFLICT` +
  `details: { intentId }`. Boshqa body — ham `409 IDEMPOTENCY_CONFLICT` (+ `details.intentId`).

Tekshiruv tartibi: tezlik limiti (5 so‘rov / 10 daqiqa va 10 so‘rov / 24 soat / foydalanuvchi; oshsa `429 RATE_LIMITED` + `Retry-After`; «10 / 24 soat» — **yaratilgan `PaymentIntent` lar soni**: rad etilgan urinishlar (`409`, `422`, `429`, `503`) intent yaratmaydi va sanalmaydi, ularni 5 / 10 daqiqa limiti qoplaydi) →
validatsiya (`400`) → idempotentlik → kutilayotgan so‘rov (`409 TOPUP_ALREADY_PENDING`) → band so‘rovlar soni (quyida; `429 RATE_LIMITED`) → summa
chegaralari va kunlik cheklar (`422`) → tinglovchi holati va karta sig‘imi (`503 PAYMENT_METHOD_UNAVAILABLE`). Foydalanuvchida bir vaqtda faqat
**bitta** `PENDING` so‘rov bo‘ladi (DB’da `UNIQUE (userId) WHERE status = 'PENDING'`; poygada buzilsa ham `409 TOPUP_ALREADY_PENDING`,
`details.intentId` faqat `WHERE userId = sessiya` bilan topiladi).

**Band so‘rovlar cheki.** Bir vaqtda ko‘pi bilan **3 ta TO‘LANMAGAN** band so‘rov: `PENDING` va `reservedUntil > now` bo‘lgan `EXPIRED`/`CANCELLED`.
`PAID` sanalmaydi: chek «yarat → bekor qil» orqali summalarni egallash fermasiga qarshi, to‘langan so‘rov esa haqiqiy pul. Oshsa
`429 RATE_LIMITED` va `Retry-After` = shu band so‘rovlarning eng yaqin `reservedUntil`i.

**Kunlik to‘ldirish cheklari** (`422 TOPUP_AMOUNT_OUT_OF_RANGE`, `details.reason`): **barcha** akkauntlarga 24 soatda 5 000 000 so‘m
(`TOPUP_DAILY_MAX_TIYIN`, `reason: "DAILY_LIMIT"`); 7 kundan yosh akkauntga 500 000 so‘m (`reason: "NEW_ACCOUNT_DAILY_LIMIT"`).

- _Nima sanaladi:_ **ASOS summa** (`baseAmountTiyin`), tasodifiy 1–999 so‘m qo‘shimcha emas: aks holda aynan 500 000 so‘m so‘rash chekdan oshib ketardi.
  Oxirgi 24 soatdagi `PAID` so‘rovlar (`paidAt` bo‘yicha) va `PENDING` so‘rovlar (`createdAt` bo‘yicha) asos summalari yig‘indisi + yangi so‘rov.
  `EXPIRED` va `CANCELLED` sanalmaydi (pul tushmagan). Aynan 500 000 so‘m — ruxsat; 501 000 so‘m — `422` (yangi akkaunt).
- _Ikkala chek pul yozilayotganda ham qayta tekshiriladi_ (xuddi shu formula); oshsa pul avtomatik yozilmaydi: review `DAILY_LIMIT` (qaysi chek oshgani
  review ma’lumotida yoziladi).
- _`details.max` — bugun QOLGAN limit_ (`min`/`step` o‘zgarmaydi). Qolgan limit `min` dan kichik bo‘lsa ham kod shu (`TOPUP_AMOUNT_OUT_OF_RANGE`), `max < min`
  bo‘ladi (`0` ham mumkin): klient buni «bugungi limit tugadi» deb ko‘rsatadi, «summa juda katta» deb emas. Sxema va hisob: `checkDailyTopupLimit`, `dailyLimitDetails`.

`purchaseFrozen` foydalanuvchi to‘ldira oladi (qarzini yopish uchun); bloklangan — `403 USER_BLOCKED`.

### `GET /payments/intents/:id` va `GET /payments/intents?status=&limit=`

`status`: `PENDING | PAID | CANCELLED | EXPIRED`; `limit` ≤ 100 (standart 20); ro‘yxat sahifalanmaydi (`meta` yo‘q), eng yangisi birinchi.

```json
{
  "success": true,
  "data": {
    "intentId": "cm3intent00000000000000001",
    "status": "PAID",
    "baseAmountTiyin": "2000000",
    "payAmountTiyin": "2034100",
    "card": null,
    "expiresAt": "2026-11-04T10:30:00.000Z",
    "paidAt": "2026-11-04T10:05:00.000Z",
    "creditedTiyin": "2034100",
    "currency": "UZS"
  }
}
```

- `card` faqat `PENDING` da bor, aks holda `null`. `paidAt` va `creditedTiyin` **aynan** `PAID` da to‘ldirilgan, aks holda `null`.
- Holatlar: `PENDING` (kutilmoqda) → `PAID` | `EXPIRED` | `CANCELLED`. `EXPIRED` so‘rov 24 soat ichida kech to‘lov kelsa `PAID` ga o‘tishi
  mumkin — klient `EXPIRED` ni qat’iy yakun deb hisoblamasligi va `/me/wallet` ni ham yangilashi kerak. `CANCELLED` esa avtomatik `PAID`
  bo‘lmaydi (faqat ega qo‘lda ko‘rib chiqsa).
- Mini App tashqi sahifadan qaytganda (`visibilitychange`) `/me/wallet` va shu so‘rovni qayta so‘raydi. Polling oralig‘i **kamida 5 soniya**.

### `POST /payments/intents/:id/cancel`

Body `{}` (`.strict()`). `200`: `{ "intentId": "…", "status": "CANCELLED" }`. Faqat o‘ziniki va faqat `PENDING` bo‘lsa; aks holda
`404 NOT_FOUND`. Bekor qilingan so‘rovning summasi baribir 24 soat band turadi; shu vaqt ichida unga pul kelsa avtomatik yozilmaydi,
egaga ko‘rib chiqishga tushadi (`CANCELLED_LATE`), shuning uchun foydalanuvchi bekor qilingan so‘rovga o‘tkazma qilmasligi kerak.

### `POST /payments/intents/:id/pay-link`

Body `{}` (`.strict()`). `200`: `{ "redirectUrl": "https://ggpin.uz/pay/<intentId>?locale=<uz|ru>#t=<yangi token>", "expiresAt": "…" }`. Faqat o‘ziniki,
`PENDING` va `now < expiresAt` bo‘lsa; aks holda `404` (muddati o‘tgan yoki bekor qilingan so‘rovga havola berilmaydi). Yangi token berilganda
eskisi darhol o‘ladi.

### Havola tokeni va `GET /payments/pay/:intentId` (D-39)

Mini App to‘lov sahifasini `openLink` bilan sessiyasiz ochadi, shuning uchun sahifa faqat bitta so‘rovga bog‘langan **capability token**
bilan ishlaydi. Token havolaning **fragmentida** (`#t=`) turadi: fragment hech qaysi serverga (bizniki ham, proksi ham) va `Referer` ga
yuborilmaydi. Sahifa uni `location.hash` dan o‘qiydi va API’ga `X-Pay-Token` sarlavhasida yuboradi.

**Sahifa tili (D-38 Q21).** Havolada til so‘rov qatorida: `?locale=uz` yoki `?locale=ru` (so‘rovni yaratgan foydalanuvchining tili; `buildPayLink(…, locale)`).
Sahifa tilni `readPayLocaleFromQuery` bilan oladi: `locale` yo‘q yoki noma’lum bo‘lsa — `uz` (standart); faqat `uz` va `ru` qabul qilinadi; sahifada til almashtirgich
bor. Havolada **boshqa hech qanday** so‘rov parametri bo‘lmaydi (`PayLinkUrlSchema` ularni rad etadi): maxfiy narsa faqat fragmentda.

```
GET /api/v1/payments/pay/cm3intent00000000000000001
X-Pay-Token: <43 belgili token>
```

`200`:

```json
{
  "success": true,
  "data": {
    "intentId": "cm3intent00000000000000001",
    "status": "PENDING",
    "baseAmountTiyin": "2000000",
    "payAmountTiyin": "2034100",
    "card": {
      "bank": "HUMO",
      "number": "9999000000000001",
      "holderName": "TEST H."
    },
    "expiresAt": "2026-11-04T10:30:00.000Z",
    "ownerHint": "S***r",
    "currency": "UZS"
  }
}
```

- Javobda foydalanuvchi id’si, username, balans, ledger va boshqa so‘rovlar **yo‘q**. `card` faqat `PENDING` da; `PAID` bo‘lgach
  `expiresAt` gacha `card: null` bilan o‘qiladi (sahifa «to‘landi» ko‘rsatadi).
- **`ownerHint`** — havola kimning hisobini to‘ldirishini ko‘rsatuvchi yashirilgan belgi: begona odam yuborgan havolani to‘lovchi
  darhol payqashi uchun. Qoida (`maskOwnerHint(firstName, username)`): faqat **harf va raqamlar** qoladi (bo‘shliq, boshqaruv, bidi va nol kenglikli belgilar,
  combining belgilar, «ko‘rinmas ism» belgilari U+3164, U+115F, U+2800 va shunga o‘xshashlar olib tashlanadi); birinchi va oxirgi belgi, o‘rtasida `***`
  (`Sardor` → `S***r`); ikki yoki undan kam belgili nom — faqat birinchi belgi (`Al` → `A***`, `S` → `S***`), chunki ikki harfli ism to‘liq ko‘rinib qolardi. `firstName` dan hech narsa qolmasa `username` (`@` siz) ishlatiladi, u ham bo‘sh bo‘lsa `null`.
  Belgilar kod nuqtasi bo‘yicha sanaladi (kirill, astral harflar); emoji harf emas. Sxema: `OwnerHintSchema`.
- Token: 32 tasodifiy bayt, base64url, 43 belgi. DB’da faqat HMAC xeshi saqlanadi; ochiq token faqat `POST /payments/intents` va
  `…/pay-link` javobida bor, hech qayerda loglanmaydi.
- Token faqat **o‘qish** huquqi beradi, bitta so‘rovga bog‘langan va `expiresAt` gacha amal qiladi; shu vaqt ichida ko‘p marta
  o‘qiladi (sahifa polling qiladi, kamida 5 s). «Bir martalik» — qayta berilganda eskisi o‘lishi va bekor qilinganda
  (`CANCELLED`) token o‘chishi ma’nosida.
- **Har qanday xato bir xil `404 NOT_FOUND`** (javob tanasi va vaqti bir xil): noma’lum yoki **noto‘g‘ri shakldagi `intentId`** (Fastify `maxParamLength` 100: undan uzun
  parametrni router o‘zi 404 qiladi, javob konverti bir xil; sxemadagi `.max(128)` faqat zaxira), token yo‘q
  yoki noto‘g‘ri shaklda, boshqa so‘rovniki, muddati o‘tgan, **bekor qilingan**. Sahifa shunda «havola eskirgan yoki bekor qilingan» deydi.
  Token mavjudligini aniqlab bo‘lmaydi; `intentId` shakli ham `400` bermaydi.
- `@Public` (sessiya shart emas), `Cache-Control: no-store`, `Referrer-Policy: no-referrer`. CORS — faqat `WEB_URL`.
  Limit: IP’ga 300/daqiqa (IPv6 /64) va so‘rovga 30/daqiqa; oshsa `429 RATE_LIMITED` + `Retry-After`.

**Frontend talablari (`/pay/[intentId]`, `/topup`, Mini App; 7-bosqich):**

1. _Token_ (D-50). `location.hash` dan o‘qiladi (`readPayTokenFromHash`; sahifa yuklanishidan oldin, `hashchange` ham tinglanadi) va `router.replace` bilan URL’dan
   olib tashlanadi (`?locale=` qoladi). Token faqat shu tabning `sessionStorage`ida (`ggpin:pay:<intentId>` = `{intentId, token, expiresAt}`) va
   xotirada saqlanadi, shuning uchun sahifani qayta yuklash ishlayveradi; bitta tabda BITTA token (yangisini saqlash boshqalarini va muddati o‘tganlarini o‘chiradi);
   hech qachon `localStorage`da yoki cookie’da emas. To‘lov yakunlanganda (`PAID`, `CANCELLED`, `EXPIRED`), token `404` bersa (shu tokenga javob bo‘lsa;
   eski tokenning kech javobi yangisini o‘chirmaydi) yoki `expiresAt` o‘tganda token hamma joydan (storage, xotira) darhol o‘chiriladi; o‘rniga tokensiz belgi
   (`ggpin:pay-done:<intentId>` = `{intentId, status}`) qoladi: qayta yuklashda summa, karta va natija ko‘rsatilmaydi, faqat «bu so‘rov yakunlangan, natijani
   Mini App yoki botda ko‘ring» va «Botga qaytish». Token yo‘q yoki yaroqsiz bo‘lsa va belgi ham yo‘q bo‘lsa sahifa HECH QACHON boshqa yo‘l bilan (cookie, web sessiya,
   sessiyali `GET /payments/intents/:id`) ma’lumot so‘ramaydi: «havola eskirgan yoki noto‘g‘ri» ekrani va Mini App’da «Sahifani qayta ochish»ni bosish maslahati chiqadi.
2. _So‘rovlar._ `fetch(..., { credentials: 'omit' })` va `X-Pay-Token` sarlavhasi; sahifa cookie’siz ishlaydi. Polling oralig‘i ≥ 5 s, terminal
   holatda to‘xtaydi.
3. _`POST /payments/intents` avtomatik qayta yuborilmaydi_ (tarmoq xatosida ham, TanStack Query `retry: false`): foydalanuvchi o‘zi qayta bosadi.
4. _`openLink`_ faqat `${WEB_URL}/pay/` bilan boshlanadigan URL’ni ochadi (allowlist), boshqasini rad etadi.
5. _/pay HTML javobi sarlavhalari:_ `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, `X-Robots-Tag: noindex`, `Cross-Origin-Opener-Policy: same-origin`, `X-Frame-Options: DENY`, `Content-Security-Policy` (bitta; `frame-ancestors 'none'`, `base-uri 'none'`, `img-src 'self' data:`).
6. _Uchinchi tomon resursi yo‘q_ `/pay` va `/topup` da: shrift `next/font` bilan o‘zimizdan, ikonkalar bundle ichida, tashqi CSS/CDN/analytics/widget yo‘q.
   (`/tg/topup` Mini App ichida ishlaydi, shuning uchun u yerda `telegram.org` SDK va Telegram rasm hostlari D-38 Q16 bo‘yicha ruxsat etilgan; bu cheklov faqat `/pay` uchun.)
7. _Ogohlantirishlar_ (matn `pay.*` va `tg.*` i18n kalitlarida, uz va ru): «Bu havola faqat o‘z ggpin hisobingizni to‘ldirish uchun. Boshqa odam
   yuborgan bo‘lsa, to‘lamang»; `ownerHint` ko‘rsatiladi («Hisob: S***r»); «Karta raqami har safar boshqacha bo‘lishi mumkin: eski kartaga
   o‘tkazmang»; summa aynan `payAmountTiyin` bo‘lishi kerak, farqli summa o‘tkazilsa avtomatik topilmasligi; bekor qilingan so‘rovga o‘tkazma qilinmasligi.
8. Hamyon yoki profil ma’lumoti ko‘rsatilmaydi; `Referrer-Policy: no-referrer`.
9. _Karta raqami boshida yashirin_ (D-51): faqat birinchi va oxirgi 4 raqam ko‘rinadi, o‘rtadagilar o‘rnida xira `••••` chiziladi
   (yashirin holatda haqiqiy raqamlar DOM’da yo‘q); «ko‘z» tugmasi to‘liq ko‘rsatadi va yana yashiradi. «Nusxalash» har doim to‘liq
   raqamni oladi. Bu yelka orqali qarash va skrinshotdan himoya, maxfiylik chegarasi emas: to‘liq raqam API javobida bor.

### Xatolar (to‘ldirish)

| HTTP | Kod                          | `details`                     | Qachon                                                                                                                                                |
| ---- | ---------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400  | `VALIDATION_ERROR`           | `fields`                      | shakl noto‘g‘ri; `purpose: "TOPUP_AND_BUY"`; `Idempotency-Key` yo‘q                                                                                   |
| 409  | `TOPUP_ALREADY_PENDING`      | `{ intentId }`                | foydalanuvchida kutilayotgan so‘rov bor                                                                                                               |
| 409  | `IDEMPOTENCY_CONFLICT`       | `{ intentId }`                | bir xil kalit, boshqa body; yoki bir xil body, lekin so‘rov endi `PENDING`/muddatli emas                                                              |
| 422  | `TOPUP_AMOUNT_OUT_OF_RANGE`  | `{ min, max, step, reason? }` | chegaradan tashqari yoki qadamga karrali emas; `reason`: `DAILY_LIMIT` (barcha), `NEW_ACCOUNT_DAILY_LIMIT`; kunlik limitda `max` = bugun QOLGAN limit |
| 429  | `RATE_LIMITED`               | —                             | 5 so‘rov / 10 daqiqa, 10 so‘rov / 24 soat, bir vaqtda 3 TO‘LANMAGAN band so‘rov; pay endpoint limitlari (`Retry-After`)                               |
| 503  | `PAYMENT_METHOD_UNAVAILABLE` | —                             | sig‘imli faol karta yo‘q yoki bank xabarlari tinglovchisi javob bermayapti                                                                            |

`409 TOPUP_ALREADY_PENDING`:

```json
{
  "success": false,
  "error": {
    "code": "TOPUP_ALREADY_PENDING",
    "message": "errors.TOPUP_ALREADY_PENDING",
    "details": { "intentId": "cm3intent00000000000000001" }
  }
}
```

`422 TOPUP_AMOUNT_OUT_OF_RANGE` (`min`, `max`, `step` — tiyinda, string; kunlik limitda ham xuddi shu uchta maydon va `reason`):

```json
{
  "success": false,
  "error": {
    "code": "TOPUP_AMOUNT_OUT_OF_RANGE",
    "message": "errors.TOPUP_AMOUNT_OUT_OF_RANGE",
    "details": { "min": "500000", "max": "200000000", "step": "100000" }
  }
}
```

### Keyinroq (D-04)

Quyidagi yo‘llar hozir **mavjud emas**; provayderlar D-04 qayta ko‘rilganda ulanadi va `docs/providers/<code>.md` ga ko‘ra yoziladi.

| Metod | Yo‘l                                                  | Holat                                      |
| ----- | ----------------------------------------------------- | ------------------------------------------ |
| POST  | `/payments/click/prepare`, `/payments/click/complete` | keyinroq (D-04): Click callback            |
| POST  | `/payments/payme`                                     | keyinroq (D-04): Payme JSON-RPC            |
| POST  | `/payments/uzum/*`, `/payments/rahmat/*`              | keyinroq (D-04): shartnoma hujjatiga ko‘ra |

`TOPUP_AND_BUY` (yetishmagan summani to‘lab, kotirovka amal qilsa avtomatik xarid qilish) — 5-bosqichda; shunda so‘rovga `quoteId`
qo‘shiladi va to‘lov tasdiqlanganda shu tranzaksiyada TOPUP yoziladi, kotirovka amal qilmasa pul balansda qoladi.

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
