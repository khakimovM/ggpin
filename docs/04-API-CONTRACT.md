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
| 409  | `ORDER_STATE_CONFLICT`                                                         | faqat admin: buyurtma amal kutgan holatda emas (masalan worker uni allaqachon o‘tkazgan); hech narsa yozilmaydi (D-63 (2))                                                                           |
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
| 503  | `ADMIN_DEADLINE_EXCEEDED`                                                      | faqat admin yozuvi: server so‘rovni qabul qilganidan beri 45 s o‘tdi; hech narsa yozilmaydi, kalit bo‘sh qoladi (9-B)                                                                                |

Buzilgan percent-kodlashli URL (masalan `%ZZ`) marshrutlashdan oldin HTTP qatlamida standart shaklsiz xom `400` oladi (D-42 (3)); bizning havolalarimiz (id va token base64url) buni hech qachon keltirib chiqarmaydi.

Kodlar va HTTP holatlari ro‘yxati — `packages/shared/src/errors.ts` (`ERROR_CODES`, `ERROR_HTTP_STATUS`); bu jadval u bilan aynan mos turadi.

- `details.fields` — `[{ path, code }]`: faqat maydon yo‘li va Zod xato kodi; rad etilgan qiymatning o‘zi javobga chiqmaydi.
  Admin yo‘llarida `code` domen kodi ham bo‘lishi mumkin: `OTP_REQUIRED`, `AMOUNT_MISMATCH`, `OTP_LOCKED`,
  `OTP_UNAVAILABLE`, `OTP_NOT_REQUIRED`, `RATE_MISMATCH` (`ADMIN_FIELD_ERROR_CODES`) va servis sabab kodlari («Admin» →
  «Xatolar (admin)»).
- Kodsiz framework xatolari holat bo‘yicha xaritalanadi: `415` (qo‘llab-quvvatlanmaydigan `Content-Type`) — `400 VALIDATION_ERROR`;
  umumiy `403` (guard, rol yoki CSRF/Origin rad etgani) — `404 NOT_FOUND` (D-26); jadvalda kodi yo‘q boshqa holat — `500 INTERNAL_ERROR`.
  Biznes `403` lari (`USER_BLOCKED`, `PURCHASE_FROZEN`) o‘z kodini saqlaydi.
- `429 RATE_LIMITED` javobida `Retry-After` (soniya) sarlavhasi bor: throttler limitlarida ham, servis limitlarida ham (servisda ko‘pi
  bilan 86 400).

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
noma’lum kalit, `limit` 1..100 dan yoki `page` 1..10 000 dan tashqari — `400 VALIDATION_ERROR`. Faqat o‘zining yozuvlari
(`createdAt`, keyin `id` bo‘yicha kamayish tartibida).

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
  Havola faqat yozuv turi **va** manba turi (`refType` `ORDER` / `PAYMENT`) mos kelganda beriladi: masalan admin qisman
  qaytargan `REFUND` (`ADMIN_ACTION` manbali) da `orderId` ham `null`. `refType`/`refId` javobga chiqmaydi.

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
Sessiyali yo‘llarda (`/payments/intents/:id`, `…/cancel`, `…/pay-link`) noto‘g‘ri shakldagi `:id` (1–64 belgi `A–Z a–z 0–9 _ -` emas)
— `400 VALIDATION_ERROR`; sessiyasiz `GET /payments/pay/:intentId` da esa xuddi shu holat `404` (quyida, D-39, D-42 (2)).
Bloklangan foydalanuvchi har bir sessiyali yo‘lda `403 USER_BLOCKED` oladi.

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

- `minTiyin` 5 000 so‘m, `maxTiyin` 2 000 000 so‘m (bitta so‘rov), `stepTiyin` 1 000 so‘m — standart qiymatlar (`TOPUP_MIN_TIYIN`,
  `TOPUP_MAX_TIYIN`, `TOPUP_STEP_TIYIN` env’dan): klient chegaralarni qattiq yozmaydi, shu yerdan oladi.
- `available: false` — faol karta sig‘imi yo‘q yoki bank xabarlari tinglovchisi javob bermayapti; bank bo‘yicha alohida ko‘rsatiladi
  (`banks` da har doim ikkala bank: `HUMO`, `UZCARD`). Tinglovchi javob bermasa hammasi `false`. Yuqoridagi `available` — kamida bitta bank `true`.
- Javobda foydalanuvchi ma’lumoti yo‘q, shuning uchun server uni Redis’da 5 soniya keshlaydi: holat 5 soniyagacha eskirgan bo‘lishi mumkin;
  `POST /payments/intents` hammasini qayta tekshiradi.

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
- `expiresAt` — yaratilgandan 30 daqiqa (standart, `TOPUP_INTENT_TTL_SEC`). Muddat tugagach (`EXPIRED`) kelgan pul 24 soat ichida, bitta nomzod bo‘lsa, baribir avtomatik yoziladi
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
`details.intentId` faqat `WHERE userId = sessiya` bilan topiladi). Tezlik limiti validatsiyadan **oldin** sanaladi, shuning uchun noto‘g‘ri
body ham va idempotent takror ham 5 / 10 daqiqa limitiga kiradi. Redis ishlamasa limitni sanab bo‘lmaydi — `500 INTERNAL_ERROR`, so‘rov
yaratilmaydi (fail closed). Ikki parallel so‘rov INSERT poygasida ikki marta yutqazsa — `503 PAYMENT_METHOD_UNAVAILABLE` (xom `500` emas).

**Band so‘rovlar cheki.** Bir vaqtda ko‘pi bilan **3 ta TO‘LANMAGAN** band so‘rov: `PENDING` va `reservedUntil > now` bo‘lgan `EXPIRED`/`CANCELLED`.
`PAID` sanalmaydi: chek «yarat → bekor qil» orqali summalarni egallash fermasiga qarshi, to‘langan so‘rov esa haqiqiy pul. Oshsa
`429 RATE_LIMITED` va `Retry-After` = shu band so‘rovlarning eng yaqin `reservedUntil`i.

**Kunlik to‘ldirish cheklari** (`422 TOPUP_AMOUNT_OUT_OF_RANGE`, `details.reason`): **barcha** akkauntlarga 24 soatda 5 000 000 so‘m
(`TOPUP_DAILY_MAX_TIYIN`, `reason: "DAILY_LIMIT"`); 7 kundan (`TOPUP_NEW_ACCOUNT_AGE_SEC`) yosh akkauntga 500 000 so‘m
(`TOPUP_NEW_ACCOUNT_DAILY_MAX_TIYIN`, `reason: "NEW_ACCOUNT_DAILY_LIMIT"`). Avval bitta so‘rov chegarasi va qadami tekshiriladi
(`reason` yo‘q), keyin kunlik cheklar.

- _Nima sanaladi:_ **ASOS summa** (`baseAmountTiyin`), tasodifiy 1–999 so‘m qo‘shimcha emas: aks holda aynan 500 000 so‘m so‘rash chekdan oshib ketardi.
  Oxirgi 24 soatdagi `PAID` so‘rovlar (`paidAt` bo‘yicha) va `PENDING` so‘rovlar (`createdAt` bo‘yicha) asos summalari yig‘indisi + yangi so‘rov.
  `EXPIRED` va `CANCELLED` sanalmaydi (pul tushmagan). Aynan 500 000 so‘m — ruxsat; 501 000 so‘m — `422` (yangi akkaunt).
  **D-54:** egasi `review:credit --user` bilan so‘rovsiz yozgan pul ham sanaladi — `confirmedAt` bo‘yicha, to‘liq summasi bilan (asos summa yo‘q), keyin
  reversal bo‘lsa ham. `--intent` bilan yozilgan credit shu so‘rovning `PAID` asos summasi orqali sanaladi (ikki marta emas). `wallet:adjust` sanalmaydi
  (tuzatish, to‘ldirish emas). Bitta formula: `usedTopupBaseSince`; yaratishda, `review:credit` ko‘rinishida va pul yozishda bir xil.
- _Ikkala chek pul yozilayotganda ham qayta tekshiriladi_ (xuddi shu formula); oshsa pul avtomatik yozilmaydi: review `DAILY_LIMIT` (qaysi chek oshgani
  review ma’lumotida yoziladi).
- _`details.max` — bugun QOLGAN limit_ (`min`/`step` o‘zgarmaydi). Qolgan limit `min` dan kichik bo‘lsa ham kod shu (`TOPUP_AMOUNT_OUT_OF_RANGE`), `max < min`
  bo‘ladi (`0` ham mumkin): klient buni «bugungi limit tugadi» deb ko‘rsatadi, «summa juda katta» deb emas. Sxema va hisob: `checkDailyTopupLimit`, `dailyLimitDetails`.

`purchaseFrozen` foydalanuvchi to‘ldira oladi (qarzini yopish uchun); bloklangan — `403 USER_BLOCKED`.

### `GET /payments/intents/:id` va `GET /payments/intents?status=&limit=`

`status` (ixtiyoriy, bitta qiymat): `PENDING | PAID | CANCELLED | EXPIRED`; `limit` 1..100 (standart 20); noma’lum kalit yoki qiymat —
`400 VALIDATION_ERROR`. Ro‘yxat sahifalanmaydi (`meta` yo‘q), eng yangisi birinchi; `data` — quyidagi obyektlar massivi. Bitta so‘rov:
`data` — bitta obyekt. O‘qishdan oldin foydalanuvchining muddati o‘tgan `PENDING` so‘rovlari `EXPIRED` ga o‘tkaziladi (worker sweep’ini kutmasdan).

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

Body `{}` (`.strict()`). `200`: `{ "intentId": "…", "status": "CANCELLED" }`. Faqat o‘ziniki, `PENDING` va `now < expiresAt` bo‘lsa;
aks holda `404 NOT_FOUND` (muddati o‘tgan so‘rov avval `EXPIRED` bo‘ladi). Bekor qilinganda havola tokeni o‘chadi. Bekor qilingan so‘rovning summasi baribir 24 soat band turadi; shu vaqt ichida unga pul kelsa avtomatik yozilmaydi,
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
  `expiresAt` gacha `card: null` bilan o‘qiladi (sahifa «to‘landi» ko‘rsatadi). `expiresAt` dan keyin (holatidan qat’i nazar) — `404`,
  shuning uchun amalda `status` faqat `PENDING` yoki `PAID` bo‘ladi.
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
- **Har qanday xato bir xil `404 NOT_FOUND`** (javob tanasi va vaqti bir xil): noma’lum yoki **noto‘g‘ri shakldagi `intentId`** (Fastify `maxParamLength` 16 384: uzun
  parametr ham odatdagi yo‘ldan o‘tadi va shakl tekshiruvi uni xuddi shu 404 ga aylantiradi), token yo‘q
  yoki noto‘g‘ri shaklda, boshqa so‘rovniki, muddati o‘tgan, **bekor qilingan**, so‘rov egasi bloklangan. Sahifa shunda «havola eskirgan yoki bekor qilingan» deydi.
  Token mavjudligini aniqlab bo‘lmaydi; `intentId` shakli ham `400` bermaydi.
- `@Public` (sessiya shart emas), `Cache-Control: no-store`, `Referrer-Policy: no-referrer`. CORS — faqat `WEB_URL`, credentials’siz,
  `GET`, ruxsat etilgan sarlavha faqat `X-Pay-Token`; javobdan `Retry-After` va `X-Request-Id` o‘qiladi. Boshqa yo‘llarning CORS siyosati
  `X-Pay-Token` sarlavhasiga ruxsat bermaydi.
  Limit: IP’ga 300/daqiqa (IPv6 /64) va so‘rovga 30/daqiqa (so‘rov limiti faqat token to‘g‘ri chiqqandan keyin sanaladi); oshsa `429 RATE_LIMITED` + `Retry-After`.

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
   Mini App’da ikkinchi, alohida allowlist bor (`openSitePage`, 8-bosqich S4 — D-57 dagi tasdiqlangan reja, S4 xavfsizlik auditi L-1): faqat to‘rtta aniq yo‘l — `/terms`, `/ru/terms`, `/privacy`,
   `/ru/privacy` (yalang yo‘l yoki `${WEB_URL}` + yo‘l). Prefiks, regex yoki normallashtirish yo‘q: `/terms/`, `/x/../terms`, so‘rov, fragment, boshqa host
   yoki sxema, credentials ro‘yxatda yo‘q, demak rad etiladi. Ro‘yxatni kengaytirish — faqat aniq yo‘l qo‘shib.
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

| HTTP | Kod                          | `details`                     | Qachon                                                                                                                                                 |
| ---- | ---------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 400  | `VALIDATION_ERROR`           | `fields`                      | shakl noto‘g‘ri; `purpose: "TOPUP_AND_BUY"`; `Idempotency-Key` yo‘q yoki noto‘g‘ri; sessiyali yo‘lda noto‘g‘ri `:id`                                   |
| 403  | `USER_BLOCKED`               | —                             | bloklangan foydalanuvchi (sessiyali yo‘llar; `purchaseFrozen` to‘ldirishga to‘sqinlik qilmaydi)                                                        |
| 404  | `NOT_FOUND`                  | —                             | boshqa foydalanuvchining yoki noma’lum so‘rov; `cancel`/`pay-link` da `PENDING` va muddatli emas; `GET /payments/pay/:intentId` ning har qanday xatosi |
| 409  | `TOPUP_ALREADY_PENDING`      | `{ intentId }`                | foydalanuvchida kutilayotgan so‘rov bor                                                                                                                |
| 409  | `IDEMPOTENCY_CONFLICT`       | `{ intentId }`                | bir xil kalit, boshqa body; yoki bir xil body, lekin so‘rov endi `PENDING`/muddatli emas                                                               |
| 422  | `TOPUP_AMOUNT_OUT_OF_RANGE`  | `{ min, max, step, reason? }` | chegaradan tashqari yoki qadamga karrali emas; `reason`: `DAILY_LIMIT` (barcha), `NEW_ACCOUNT_DAILY_LIMIT`; kunlik limitda `max` = bugun QOLGAN limit  |
| 429  | `RATE_LIMITED`               | —                             | 5 so‘rov / 10 daqiqa, 10 so‘rov / 24 soat, bir vaqtda 3 TO‘LANMAGAN band so‘rov; pay endpoint limitlari (`Retry-After`)                                |
| 503  | `PAYMENT_METHOD_UNAVAILABLE` | —                             | sig‘imli faol karta yo‘q yoki bank xabarlari tinglovchisi javob bermayapti; INSERT poygasi ikki marta yutqazilganda                                    |

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

## Admin (`/api/v1/admin/*`)

> **LOYIHA (DRAFT) — 9-bosqich S1 (D-63 (2), D-65, D-66).** Admin panel shartnomasi SPA va API parallel qurilishi uchun
> oldindan yozildi; S13 da haqiqiy javoblardan yakunlanadi. Zod sxemalari — `packages/shared/src/admin/` (shu bo‘lim bilan
> 1:1), rol matritsasi — `packages/shared/src/admin/admin-permissions.ts`. **5-bosqichga tayanuvchi shakllar** (buyurtmalar,
> urinishlar, TON transferlari, Fragment sessiyasi, qo‘lda kurs) `feat/p5-stars-order` kodidan olingan va 9-B to‘lqinida
> (5-bosqich `main` ga tushgach) tekshiriladi. Foydalanuvchi yo‘llarining birortasi o‘zgarmaydi. Bo‘lim mazmuni — `docs/09`,
> qarorlar — D-63, D-65, D-66.
>
> **9-B ro‘yxati (5-bosqich nusxalari).** `ADMIN_MANUAL_FX_PAIRS`, `ADMIN_TON_TRANSFER_STATUSES`, `ADMIN_ATTEMPT_STATUSES`,
> `ADMIN_RESOLVE_PROOF_KINDS`, `AdminResolveProofSchema` (p5 `NeedsReviewProofSchema` dan `reason` va
> `TON_UNMATCHED_RESOLVED` siz), `PAYMENT_STATUSES` / `PAYMENT_PROVIDERS` va `AdminAttemptFactsSchema` manba yo‘llari 9-B da
> 5-bosqich eksportlariga almashtiriladi, har biriga tenglik testi yoziladi. Istisno — `AdminResolveProofSchema` matn
> maydonlari (`evidence`, `requestRef`) 5-bosqichdan qattiqroq (bitta ko‘rinadigan qator), shuning uchun u uchun test
> tenglik emas, **«panel ⊂ p5»**: panel qabul qilgan har isbotni 5-bosqich sxemasi ham qabul qiladi.

### Umumiy qoidalar

- **Konvert, xatolar, sahifalash** — fayl boshidagi qoidalar: `?page=1&limit=20` (`limit` 1..100, `page` 1..10 000),
  `meta: { page, limit, total }`. Pul — tiyin string (`TiyinString`; ishorali joylar alohida aytilgan), boshqa minimal
  birliklar (`…NanoTon`, `…MicroUsdt`, `costMinor`) ham string. Vaqt — ISO 8601 UTC. Har javob `Cache-Control: no-store`.
- **Sessiya.** Login (`/admin/auth/*`) dan keyin bitta cookie: production’da `__Host-adm_session`, development/test’da
  `adm_session` (`adminSessionCookieName`); `HttpOnly`, `Secure` (development’dan tashqari), `SameSite=Strict`, `Path=/`,
  `Domain` yo‘q. Qiymati 256 bit tasodifiy token, DB’da faqat `sha256` (`AdminSession.tokenHash`). Muddat: 8 soat mutlaq,
  1 soat harakatsizlik (`ADMIN_SESSION_TTL_SEC`, `ADMIN_SESSION_IDLE_SEC`; env emas). Foydalanuvchi cookie’lari va Mini App
  Bearer token admin yo‘lida hech narsa bermaydi; admin cookie foydalanuvchi yo‘lida — `401 UNAUTHORIZED`.
- **Tekshiruv tartibi** (login yo‘llaridan tashqari har so‘rovda): (1) CORS/Origin, (2) **AdminGuard** — sessiya (bekor
  qilinmagan, muddati va harakatsizlik) → `AdminUser.isActive` → `telegramId ∈ ADMIN_TELEGRAM_IDS` (config’dan, har safar)
  → rol (DB’dan) → yozuvda CSRF, (3) shundan keyingina `Idempotency-Key` va Zod tekshiruvi. Sessiyasiz so‘rov hech qachon
  `400` yoki `409` olmaydi — doim `404` (SA-L5). Istisnolar: body’ni umuman o‘qib bo‘lmasa (buzuq JSON, noto‘g‘ri
  `Content-Type`) yoki u juda katta bo‘lsa (`400 VALIDATION_ERROR` / `413`), yoki URL’da buzuq `%` bo‘lsa (`400`) — Fastify
  bularni guard’lardan oldin beradi; mavjud va noma’lum yo‘lda bir xil, shuning uchun yo‘l borligini bildirmaydi (S2R-6).
  Pul tranzaksiyasi ichida rol `AdminUser` `FOR SHARE` bilan yana o‘qiladi.
- **Ruxsatsiz → `404 NOT_FOUND`.** Sessiya yo‘q yoki o‘lik, allowlist’da yo‘q, nofaol, rol yetmaydi, OPERATOR limitdan
  oshdi, CSRF/Origin xato, noma’lum `/admin/*` yo‘l — hammasi bir xil `404` (tana va sarlavhalar bir xil, D-26). SPA `404`
  ni `GET /admin/auth/me` da «kirilmagan» deb tushunadi.
- **CORS va Origin (SA-H2).** `/api/v1/admin/*` uchun CORS ruxsat etilgan origin’lari faqat `[ADMIN_URL]`; foydalanuvchi
  yo‘llarining CORS ro‘yxatidan `ADMIN_URL` olib tashlanadi (S2, `cors-origins.ts`). Har admin so‘rovida (GET ham) `Origin`
  sarlavhasi kelsa va `ADMIN_URL` ga teng bo‘lmasa — `404`; `Sec-Fetch-Site: cross-site` — `404`;
  `Sec-Fetch-Mode: no-cors` yoki `navigate` — `404` (N5: boshqa sayt `<img>`/`<script>`/havola bilan Origin’siz GET yubora
  olmaydi; SPA har doim `fetch` — `cors` rejimi). So‘rovda `Sec-Fetch-Site` bo‘lsa (ya’ni brauzer), `Origin` ham majburiy
  va `ADMIN_URL` ga teng bo‘lishi shart — aks holda `404` (S2-5); ikkala sarlavha ham yo‘q bo‘lsa (CLI, curl) bu qoida
  qo‘llanmaydi. Production’da `ADMIN_URL` origin’i `WEB_URL`, `MINI_APP_URL` va API’ning ommaviy origin’idan
  (`TELEGRAM_WEBHOOK_URL` origin’i) farq qilishi va host
  `BRAND.domain` ning subdomeni bo‘lishi shart, aks holda API ishga tushmaydi (S2-2). Audit CSV ham SPA’dan `fetch` + `Blob` bilan yuklanadi, to‘g‘ridan-to‘g‘ri
  havola emas. S2 e2e talablari: `Origin: WEB_URL` bilan admin GET → javobda `Access-Control-Allow-Origin` yo‘q va `404`;
  `Sec-Fetch-Mode: navigate` va `no-cors` bilan (to‘g‘ri sessiya cookie’si bilan ham) admin GET → `404`.
- **CSRF.** Har yozuv so‘rovida (POST/PATCH) `X-CSRF-Token` sarlavhasi va `Origin` aynan `ADMIN_URL` ga teng bo‘lishi
  shart (ochiq login yo‘llarida ham); `WEB_URL` admin yo‘lida qabul qilinmaydi. Aks holda `404`.
- **`Idempotency-Key`** — barcha admin yozuv yo‘llarida majburiy (`/admin/auth/*`, `POST /admin/confirmations` va
  `POST /admin/write-keys/void` dan tashqari). Format fayldagi bilan bir xil: 8–128 belgi, `A–Z a–z 0–9 _ -`; yo‘q yoki noto‘g‘ri — `400 VALIDATION_ERROR`.
  Kalit `(adminId, kalit)` bo‘yicha amalning audit qatoriga bog‘lanadi: takror (o‘sha body) — birinchi natija
  `applied: false` bilan, ikkinchi yozuvsiz; takror **holat tekshiruvlaridan va kod tekshiruvidan OLDIN** aniqlanadi (D-49
  naqshi; ishlatilgan kod takrorni buzmaydi). O‘sha kalit, boshqa body — `409 IDEMPOTENCY_CONFLICT`. SPA kalitni dialog
  ochilganda bir marta yaratadi. Nozik qoidalar (SA-S6-14): (a) body hash’i `otp` va `challengeId` ni hisobga olmaydi —
  yangi kod bilan qayta yuborish o‘sha body; (b) `4xx` dan keyin hech narsa yozilmaydi, kalit bo‘sh qoladi — o‘sha kalit
  bilan boshqa body ham `409` emas; (c) commit’dan keyingi qadam (javob uchun qayta o‘qish) yiqilsa — o‘z audit qatorining
  replay’i qaytadi: `2xx`, `applied: false` va shu `auditId`, garchi amal aynan shu chaqiruvda bajarilgan bo‘lsa ham.
  Bir xil kalit, body va kod bilan ikki parallel so‘rovda ikkinchisi `422 CODE_EXPIRED` olishi mumkin (birinchisi hali
  commit qilmagan, kod esa ishlatilgan): SPA submit’dan keyingi `CODE_EXPIRED` ni «natija noma’lum» deb biladi va o‘sha
  kalit bilan qayta so‘raydi (replay) yoki audit’ni ko‘rsatadi — yangi kalit bilan qayta yubormaydi (SA-S6-7).
  Audit qatorining id’si kalitdan aniqlanadi (sir emas): `a` + sha256(`<adminId>|<Idempotency-Key>`) hex’ining birinchi
  31 belgisi. (d) Bekor qilingan kalit (`POST /admin/write-keys/void`) bilan kelgan har so‘rov — `409
IDEMPOTENCY_CONFLICT`, hech narsa yozilmaydi. (e) Void va o‘sha kalitli eski so‘rov poygasini shu id (PK) hal qiladi:
  natija yo `VOIDED` (eski so‘rov endi hech qachon commit qilmaydi), yo `APPLIED` (amal bajarilgan) — uchinchisi yo‘q.
  Natija noma’lum bo‘lsa (tarmoq xatosi, timeout, `CODE_EXPIRED`) SPA «Natijani aniqlash» da o‘sha kalit bilan void’ni
  chaqiradi: `APPLIED` — amal bajarilgan (audit qatori ko‘rsatiladi), `VOIDED` — eski kalit o‘ldi, «Yangi amal sifatida
  boshlash» darhol yangi kalit beradi; void’ning o‘zi noma’lum bo‘lsa — kalit qoladi, qayta so‘raladi. Kutish va audit
  qidiruvi yo‘q (SA-1; ega qarori 2026-11-23, 9-B Q2 = A; 9B-1 server + 9B-3 SPA bitta release’da). Kalitli yozish
  so‘roviga SPA 30 s timeout qo‘yadi (timeout — natija noma’lum).
- **So‘rov deadline’i (9-B, M-1; ega qarori 2026-11-23 Q3).** Server admin yozuvini qabul qilgan paytni monoton soat
  bilan yozadi. Replay tekshiruvidan keyin, tranzaksiya boshida va commit oldidan qabul qilinganidan beri 45 s
  (`ADMIN_WRITE_DEADLINE_MS`, server konstantasi) o‘tgan bo‘lsa — `503 ADMIN_DEADLINE_EXCEEDED`: audit qatori va hech
  qanday yozuv yo‘q (tranzaksiya rollback), kalit bo‘sh qoladi (qoida (b)) — o‘sha kalit bilan qayta yuborish xavfsiz.
  O‘sha kalitning bajarilgan amali (replay) deadline’dan qat’i nazar javob oladi. Void yo‘li ham shu qoidadan o‘tadi
  (tombstone yozilgach deadline o‘tsa — rollback va `503`, void’ni qayta so‘rash xavfsiz). Kod talab qiladigan yo‘llarda
  kod tranzaksiyadan oldin sarflanadi va server uni sarflashdan oldin ham deadline’ni tekshiradi: shu paytgacha bo‘lgan
  `503` da kod sarflanmaydi; tranzaksiya boshida yoki commit oldidan `503` bo‘lsa, qayta yuborish yangi kod bilan bo‘ladi
  (kalit o‘sha qoladi). `503` da faqat amal holatiga kirmaydigan hisoblagichlar o‘zgaradi (sessiya faolligi, limit
  hisoblagichlari, kod urinishlari). Deadline faqat kalitli admin yozuvlari va void uchun: `POST /admin/confirmations` va
  `/admin/auth/*` unga kirmaydi (kodning o‘z muddati va bog‘lanishi bor). Ega CLI’sida deadline yo‘q.
- **Status kodlari.** Admin amal yo‘llari (POST) muvaffaqiyatda `200`; `POST /admin/confirmations` — `201`.
- **`reason`** (`AdminReasonSchema`): trim’dan keyin 10–500 belgi, ko‘rinmas/boshqaruv belgisiz, kamida bitta harf yoki
  raqam. Pul, holat, admin boshqaruvi va navbat retry amallarida majburiy; katalog yozuvlarida ixtiyoriy (berilsa — shu
  qoida).
- **Matn maydonlari.** Admin kiritadigan bir qatorli matn (katalog nomi, label, tab, `supplierSku`, `regionBadge`, admin
  ismi, `MANUAL` isbotining `evidence` i va `FRAGMENT_STATUS` ning `requestRef` i) boshqaruv/format belgisi (NUL, bidi,
  zero-width) va qator ajratgichlarisiz (`\p{Cc}\p{Cf}\p{Zl}\p{Zp}`, `\n` ham); tavsif va yordam matnida faqat `\n` ruxsat.
  Admin ismida `<` va `>` ham yo‘q, kamida bitta harf yoki raqam (`\p{L}`/`\p{N}`) bo‘lishi shart va bo‘sh ko‘rinadigan
  belgilar (U+115F, U+1160, U+3164, U+FFA0, U+2800) taqiqlangan (N9).
- **Javob.** Har yozuv javobida `auditId` (yozilgan `AuditLog` qatori) va `applied` bor. Holat amali yoki katalog yozuvi
  hech narsani o‘zgartirmasa (narsa allaqachon so‘ralgan holatda) — hech narsa yozilmaydi: `applied: false`,
  `auditId: null` (CLI qoidasi). Har yozuv `AuditLog` (`actorType = "ADMIN"`, `actorId = AdminUser.id`, `action`,
  `before`/`after`, `reason`, `ip`) bilan bitta tranzaksiyada; amal nomlari — `ADMIN_AUDIT_ACTIONS` (ega CLI’si yozadigan
  nomlar bilan bir xil). `after.sessionId` — amalni bajargan admin sessiyasining id’si (forenzika; SA-S6-12).
- **Limitlar.** Sessiya bo‘yicha 120 so‘rov/daqiqa, yozuv yo‘llari 30/daqiqa, audit CSV 5/daqiqa; sessiyasiz `/admin/*`
  so‘rovlariga IP bo‘yicha alohida limit — 60/daqiqa/IP (IPv6 /64; SA-L6). Login yo‘llarining (`/admin/auth/*`) o‘z
  limitlari bor («Auth» bandida) va bu 60 ga qo‘shilmaydi. Oshsa — `429 RATE_LIMITED` +
  `Retry-After` (sessiyasiz so‘rovda ham bir xil shakl). Noma’lum `/admin/*` yo‘llar ham shu 60 ga sanaladi: mavjud va
  mavjud bo‘lmagan yo‘l bir xil `404`, keyin bir xil `429` oladi (yo‘l borligini limit orqali bilib bo‘lmaydi; S2-1).
  Router yo‘naltirmaydigan admin yo‘llar ham — bo‘sh parametr (`/admin/orders//refund`, `/admin/auth/status/`),
  percent-kodlangan shakllar (router ularni qaysi yo‘lga yuborsa ham), hech bir admin route’da bo‘lmagan metod yoki `HEAD`
  — xuddi shu `404`/`429` ni oladi:
  sessiyasiz bo‘lsa anonim 60 ga, tirik sessiya bilan sessiya limitiga sanaladi (S2R-1). Admin’ga faqat o‘xshagan yo‘llar
  (`/api/v1/adminx`, `/api/v1/administrator`) oddiy global `404` oladi va sanalmaydi.
- **Hech qachon javobda emas:** TON mnemonic va kalitlar, Fragment cookie’lari, bank-feed sessiyasi, ta’minotchi kalitlari,
  to‘liq karta raqami (`pan`), pay token va uning hash’i, `providerRef`, `providerTxnId`, provayder `raw`, idempotentlik
  kaliti va `requestHash`, OTP kodi, imzolangan BOC. **Maydon darajasidagi qoidalar:** bank xabarining `text`,
  `balanceAfterTiyin` va `channel` — faqat OWNER’ga, boshqalarga `null` (`payments.bankMessageRaw`); telefon — OWNER va
  OPERATOR’ga (`users.phoneFull`); audit `ip` — OWNER’ga to‘liq, boshqalarga maskalangan (`audit.ipFull`). Urinishning
  saqlangan JSON’i hech qachon o‘zi chiqmaydi — faqat `facts` proyeksiyasi («Buyurtmalar»); audit `before`/`after` —
  `redactAuditJson` orqali (allowlist + butun kalit deny-list + so‘z qoidasi, «Audit log»). Javob sxemalari ham shu
  tasnifdan (`isAuditSecretKey`) o‘tadi; uchta atayin istisno: `auth/me` dagi `session` (sessiya metama’lumoti),
  confirmation `challengeId`, foydalanuvchi `referralCode`.

**Rol matritsasi** (`ADMIN_PERMISSIONS`; SPA tugmalarini `GET /admin/auth/me` `permissions` bo‘yicha yashiradi — bu himoya
emas, faqat UX):

| Amal                                                                     | SUPPORT                  | OPERATOR                                     | OWNER            | Kod (OTP)                                                             |
| ------------------------------------------------------------------------ | ------------------------ | -------------------------------------------- | ---------------- | --------------------------------------------------------------------- |
| Buyurtmalar, foydalanuvchilar, to‘lovlar — o‘qish                        | ha (telefon maskalangan) | ha                                           | ha               | —                                                                     |
| Dashboard, katalog (price-preview bilan), sozlamalar — o‘qish (D-65 D4)  | yo‘q                     | ha                                           | ha               | —                                                                     |
| Audit log, infra — o‘qish                                                | yo‘q                     | ha (audit `ip` maskalangan)                  | ha               | —                                                                     |
| Adminlar ro‘yxati, audit CSV, bank xabari xom maydonlari, review preview | yo‘q                     | yo‘q                                         | ha               | —                                                                     |
| Izoh (buyurtma, foydalanuvchi)                                           | ha                       | ha                                           | ha               | —                                                                     |
| Buyurtma retry (HELD→QUEUED)                                             | yo‘q                     | attempt-cap va NO_PURCHASE’dan tashqari HELD | ha               | —                                                                     |
| Buyurtma cancel, HELD→FAILED + refund                                    | yo‘q                     | to‘liq summa ≤ limit, NO_PURCHASE emas       | ha               | chegaradan katta                                                      |
| NEEDS_REVIEW resolve                                                     | yo‘q                     | yo‘q                                         | ha               | isbot turi talab qilsa yoki chegaradan katta                          |
| DELIVERED→REFUNDED (to‘liq/qisman)                                       | yo‘q                     | yo‘q                                         | ha               | **har doim** (D-65 D1)                                                |
| Bloklash, xaridni muzlatish, sessiyalarni tugatish                       | yo‘q                     | ha                                           | ha               | —                                                                     |
| Blokni ochish (D-65 D2), muzlatishni ochish                              | yo‘q                     | yo‘q                                         | ha               | —                                                                     |
| Balans tuzatish                                                          | yo‘q                     | yo‘q                                         | ha               | kirim — har doim; chiqim — chegaradan katta yoki kodsiz budjet tugasa |
| P2P review credit                                                        | yo‘q                     | yo‘q                                         | ha               | **har doim** (D-66)                                                   |
| To‘ldirishni qaytarish (reverse)                                         | yo‘q                     | yo‘q                                         | ha               | chegaradan katta yoki kodsiz budjet tugasa                            |
| Karta: pauza, limitni oshirish                                           | yo‘q                     | yo‘q                                         | ha               | —                                                                     |
| Karta: limitni pasaytirish                                               | yo‘q                     | yo‘q                                         | ha               | **har doim** (2026-11-18)                                             |
| Karta: retire (oddiy va favqulodda)                                      | yo‘q                     | yo‘q                                         | ha               | **har doim** (2026-11-18)                                             |
| Karta: davom (resume)                                                    | yo‘q                     | yo‘q                                         | ha               | SECURITY pauzani ochishda (D-65 D3)                                   |
| Katalog yozuvi                                                           | yo‘q                     | yo‘q                                         | ha               | —                                                                     |
| Qo‘lda kurs                                                              | yo‘q                     | yo‘q                                         | ha               | sakrash qoidasi (D-56 (3))                                            |
| Adminlar (qo‘shish, o‘zgartirish, sessiyalar)                            | yo‘q                     | yo‘q                                         | ha               | har doim                                                              |
| Navbat job retry (`notify`, `tg-outbox`)                                 | yo‘q                     | yo‘q                                         | ha               | —                                                                     |
| Karta qo‘shish (to‘liq raqam), OWNER yaratish, `TON_UNMATCHED_RESOLVED`  | —                        | —                                            | faqat ega CLI’si | —                                                                     |

«Chegara» — `ADMIN_CONFIRM_THRESHOLD_TIYIN` (summa moduli bo‘yicha; chegaraning o‘zida kod so‘ralmaydi); «limit» —
`ADMIN_OPERATOR_REFUND_MAX_TIYIN`. OPERATOR limitdan oshsa yoki rol yetmasa — `404`, hech narsa yozilmaydi.

**Kodsiz budjet (SA-S6-3, ega qarori 2026-11-18).** O‘g‘irlangan panel sessiyasi kodsiz amallarni cheksiz takrorlay
olmasligi uchun: bir admin, bir Toshkent kuni ichida kodsiz bajarilgan chiqim (manfiy balans tuzatish) va reverse’lar
bitta budjetga sanaladi — ko‘pi bilan `ADMIN_CODELESS_DAILY_MAX_COUNT` (10) ta amal va ularning summalari moduli
yig‘indisi (shu amal bilan birga) ko‘pi bilan `ADMIN_CODELESS_DAILY_MAX_TIYIN` (2 000 000 so‘m). 11-amal yoki yig‘indini
oshiradigan amal summasidan qat’i nazar kod so‘raydi (`400 OTP_REQUIRED`; kod chiqarishda binding flagi
`otpRequired: daily-limit`). Konstantalar `packages/shared` da (env emas). Budjet tranzaksiya ichida, admin bo‘yicha
advisory qulf ostida, adminning o‘sha kungi kodsiz `AuditLog` qatorlari va ular yozgan ledger yozuvlaridan hisoblanadi;
rollback bo‘lgan amal va ega CLI’si amallari sanalmaydi. Budjetni o‘qib bo‘lmasa — amal bajarilmaydi (tranzaksiya qaytariladi, 5xx; fail-closed).
Budjet Toshkent yarim tunida yangilanadi: kunlik limit sababi bilan 23:59 da olingan kod 00:00 dan keyin
bog‘lanishga mos kelmaydi (`CODE_INVALID`), o‘sha amal kodsiz qayta yuborilsa o‘tadi.

**Admin akkauntlari himoyasi (SA-S6-1, SA-S6-9).**

- `users.block` va `users.freeze`: nishon foydalanuvchining `telegramId` i biror `AdminUser` ga tegishli bo‘lsa (faol yoki
  nofaol) — `400 fields[{ path: "userId", code: "ADMIN_ACCOUNT" }]`. Bot bloklangan akkaunt uchun ham admin login
  (`/start admin_<nonce>`), «Bu men emasman» va sessiyani yopish tugmalarini `isBlocked` tekshiruvidan oldin qayta
  ishlaydi; kimga ruxsat borligini admin servislari hal qiladi.
- Balans tuzatish va P2P review credit (kod chiqarish ham): ADMIN aktor o‘z mijoz akkauntiga (`User.telegramId ==
AdminUser.telegramId`) pul yoza olmaydi — `400 fields[{ path: "userId", code: "SELF_TARGET" }]`. Bunday amal faqat ega
  CLI’si orqali.
- Balans tuzatish summasi moduli ≤ `ADMIN_ADJUST_MAX_TIYIN` (1 000 000 000 so‘m; shared sxema va servis).

**Faqat OWNER’ning HELD buyurtmalari (M-1, D-64 (6), p5 S9a).** Server buyurtma qulfi ostida ikki belgini hisoblaydi va
`adminMayPerform` ga beradi (`AdminOrderContext`): `attemptCapHold` — HELD urinishlar chegarasida (p5
`attemptLimitReached`, `attemptNo` bo‘yicha sanaladi) va `noPurchaseHold` — HELD sababi NO_PURCHASE (PURCHASE yozuvisiz
buyurtma). OPERATOR uchun: `attemptCapHold` — `retry` `404`; `noPurchaseHold` — `retry`, `cancel`, `fail-and-refund`
`404` (bu buyurtma faqat egada). Kontekstsiz OPERATOR so‘rovi rad etiladi (fail-closed). Kod chiqarish
(`POST /admin/confirmations`) ham shu tekshiruvdan o‘tadi. To‘liq jadval (rol × ruxsat × kod × limit × hold) —
`admin-matrix.test.ts`.

**Qo‘lda yaratiladigan pul cheki (D-63 (5), D-65 D1).** Musbat balans tuzatish, P2P review credit va DELIVERED buyurtma
refund’i (to‘liq va qisman) Toshkent kunida `ADMIN_MANUAL_CREDIT_DAILY_CAP_TIYIN` (standart 5 000 000 so‘m, CLI va panel
uchun umumiy) chekiga qo‘shiladi; oshsa — rad (`400`, `fields[].code` — servis sabab kodi). HELD/FAILED refund va cancel
chekka kirmaydi (mahsulot yetkazilmagan).

**Tasdiq kodi (step-up, D-63 (4)).** Kod kerak bo‘lgan amalda klient avval `POST /admin/confirmations` chaqiradi, kod
amalni bajarayotgan adminning o‘z Telegram’iga keladi (`OWNER_ALERT_CHAT_ID` ga emas, D-53 (5)), keyin amal so‘rovi
tanasida:

```json
{
  "reason": "…",
  "confirmAmountTiyin": "150000000",
  "otp": { "challengeId": "<32 hex>", "code": "123456" }
}
```

- **Binding (SA-M2, m-4).** Kod confirmation tanasining HAR maydoniga (parse qilingan, standart qiymatlar to‘ldirilgan,
  kalitlari tartiblangan kanonik JSON — `adminConfirmationCanonical`), server flaglariga, `adminId` va `sessionId` ga
  bog‘lanadi. Hisob yagona funksiyada — `adminConfirmationBinding({ body, serverFlags, adminId, sessionId })` =
  `sha256(JSON.stringify([canonical(body), sorted(serverFlags), adminId, sessionId]))` (hex); kod chiqarish ham, amal ham
  aynan shu funksiyani chaqiradi. Amal o‘z so‘rovidan xuddi shu tanani quradi va solishtiradi: bitta maydon yoki flag farq
  qilsa — `422 CODE_INVALID`. Flaglar klientdan olinmaydi: server ularni qulf ostida hisoblaydi (tartibi ahamiyatsiz).
- **Kod kerakmi (SA-M3)** — `adminOtpRequired` **qulf ostidagi haqiqiy server summasidan** hisoblanadi (buyurtma jami,
  review summasi, to‘lov summasi), klientning `confirmAmountTiyin` yoki confirmation `amountTiyin` qiymatidan emas.
  Tranzaksiya ichida `true` chiqsa va tasdiqlangan kod bo‘lmasa — `400`, `fields[{ path: "otp", code: "OTP_REQUIRED" }]`,
  rollback. Summasi yo‘q amallarda HTTP qatlami summa uzatmaydi: adminlar boshqaruvi — `ALWAYS`; `fx.set` — server
  hisoblagan sakrash flagi (`ruleRequiresCode`); `cards.resume` — kartaning joriy pauza sababi SECURITY ekanligi;
  `orders.resolve` — isbot turi (`MANUAL`, `TON_NOT_DEBITED`, `TON_BOUNCED`) yoki buyurtma jami chegaradan katta;
  `cards.retire` — har doim; `cards.limit` — yangi limit joriydan past bo‘lsa (`receiveLimitTiyin` yoki
  `monthlyLimitTiyin`); balans chiqimi va reverse — chegara yoki kodsiz budjet. Karta retire va limit so‘rov tanasida
  ixtiyoriy `otp` maydoni bor (yuqoridagi shakl).
- **Kod xabari (SA-S6-2).** Bot kod bilan birga amalning uz/ru nomini, server o‘qigan ishorali summani (limitda — yangi
  limit), nishonni (`@username · maskalangan tg id`, karta uchun `BANK ·last4`, review uchun pul oluvchi) va server
  flaglarini ko‘rsatadi; admin panelda kiritganidan farq qilsa kodni kiritmaydi. Summa klientdan olinmaydi.
- `confirmAmountTiyin` — admin qayta kiritgan summa (balans tuzatishda ishorali). Kod tranzaksiyadan oldin tekshiriladi
  (urinish solishtirishdan oldin sanaladi, 4-bosqich qoidasi), summa tranzaksiya ichida qayta solishtiriladi (D-46).
  Kod kerak bo‘lmagan amalda ikkalasi shart emas; kod berilsa — baribir tekshiriladi.
- Kod 3 daqiqa, bir martalik, 5 urinish; har admin uchun kuniga ko‘pi bilan `ADMIN_OTP_DAILY_MAX` (standart 30, Toshkent
  kuni) kod. Kvota tugasa — amal ega CLI’si orqali bajariladi (D-46 zaxira yo‘li; runbook: `docs/05` 7- va 9-bo‘limlar).

### Xatolar (admin)

| Status | Kod                                                                                    | Qachon                                                                                                                             |
| ------ | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 400    | `VALIDATION_ERROR` + `details.fields: [{ path, code }]`                                | Zod xatosi (`code` — Zod kodi) yoki quyidagi domen kodlari (`ADMIN_FIELD_ERROR_CODES`)                                             |
| 400    | `VALIDATION_ERROR`, `fields[{ path: "otp", code: "OTP_REQUIRED" }]`                    | kod kerak, lekin `otp` berilmagan yoki tasdiqlanmagan (tranzaksiya ichida ham)                                                     |
| 400    | `VALIDATION_ERROR`, `fields[{ path: "confirmAmountTiyin", code: "AMOUNT_MISMATCH" }]`  | faqat pul amallarida: kod kerak, qayta kiritilgan summa yo‘q yoki haqiqiy summaga teng emas (tranzaksiyada ham)                    |
| 400    | `VALIDATION_ERROR`, `fields[{ path: "confirmRate", code: "RATE_MISMATCH" }]`           | `POST /admin/fx`: sakrash qoidasi `confirmRate` talab qiladi, u yo‘q yoki `rate` ga teng emas                                      |
| 400    | `VALIDATION_ERROR`, `fields[{ path: "action", code: "OTP_NOT_REQUIRED" }]`             | `POST /admin/confirmations`: amal hozir kod talab qilmaydi — kod chiqarilmaydi va yuborilmaydi                                     |
| 400    | `VALIDATION_ERROR`, `fields[{ path: "otp", code: "OTP_LOCKED" }]`                      | shu challenge’ga 5 urinish tugagan                                                                                                 |
| 400    | `VALIDATION_ERROR`, `fields[{ path: "otp", code: "OTP_UNAVAILABLE" }]`                 | kodni yuborib bo‘lmadi (bot adminga yoza olmaydi) — `POST /admin/confirmations`                                                    |
| 400    | `VALIDATION_ERROR`, `fields[{ path: "amountTiyin", code: "MANUAL_CREDIT_DAILY_CAP" }]` | qo‘lda yaratiladigan pulning Toshkent kunlik cheki oshadi (CLI va panel uchun umumiy)                                              |
| 400    | `VALIDATION_ERROR`, `fields[{ path: "userId", code: "SELF_TARGET" }]`                  | admin o‘z mijoz akkauntiga balans tuzatish yoki review credit (kod chiqarishda ham)                                                |
| 400    | `VALIDATION_ERROR`, `fields[{ path: "userId", code: "ADMIN_ACCOUNT" }]`                | admin akkauntiga tegishli foydalanuvchini bloklash yoki muzlatish                                                                  |
| 400    | `VALIDATION_ERROR`, `fields[{ path: "paymentStatus", code: "ALREADY_REVERSED" }]`      | panel: to‘lov allaqachon qaytarilgan (boshqa kalit yoki boshqa admin); o‘sha kalit — replay                                        |
| 400    | `VALIDATION_ERROR`, `fields[{ path: "user", code: "OPEN_ORDERS" }]`                    | musbat balans tuzatish: ochiq buyurtmalar to‘plami tasdiqlanmagan yoki eskirgan (I-5)                                              |
| 400    | `VALIDATION_ERROR`, `fields[{ path: "quantity", code: "DUPLICATE_PACKAGE" }]`          | erkin miqdorli mahsulotda shu miqdorli ikkinchi faol paket                                                                         |
| 400    | `VALIDATION_ERROR`, `fields[{ path: "quantity", code: "PREMIUM_MONTHS" }]`             | Telegram Premium paketida oy 3, 6 yoki 12 emas                                                                                     |
| 400    | `VALIDATION_ERROR`, `fields[{ path: "quantity", code: "QUANTITY_RANGE" }]`             | erkin miqdorli mahsulot paketi mahsulotning `minQty..maxQty` oralig‘idan tashqarida                                                |
| 400    | `VALIDATION_ERROR`, `fields[{ path: "productIds", code: "PRODUCT_SET_MISMATCH" }]`     | reorder ro‘yxati barcha mahsulotlarning to‘liq to‘plami emas (yetishmaydi, ortiqcha yoki takror)                                   |
| 400    | `VALIDATION_ERROR`, `fields[{ path: "telegramId", code: "ADMIN_EXISTS" }]`             | shu Telegram id bilan admin allaqachon bor                                                                                         |
| 400    | `VALIDATION_ERROR`, `fields[{ path: "id", code: "OWNER_ROW" }]`                        | panel OWNER qatorining ismi, roli yoki faolligini o‘zgartirmoqchi (faqat CLI)                                                      |
| 404    | `NOT_FOUND`                                                                            | ruxsatsiz (yuqoridagi barcha holatlar) yoki resurs yo‘q                                                                            |
| 409    | `IDEMPOTENCY_CONFLICT`                                                                 | o‘sha `Idempotency-Key`, boshqa body; yoki kalit `POST /admin/write-keys/void` bilan bekor qilingan                                |
| 409    | `ORDER_STATE_CONFLICT`                                                                 | buyurtma amal kutgan holatda emas (masalan cancel paytida `PROCESSING` ga o‘tib bo‘lgan); hech narsa yozilmaydi                    |
| 422    | `CODE_INVALID` + `details.attemptsLeft`                                                | kod noto‘g‘ri yoki boshqa binding uchun chiqarilgan (ikkalasi bir xil javob — oracle yo‘q)                                         |
| 422    | `CODE_EXPIRED`                                                                         | challenge noma’lum, muddati o‘tgan yoki ishlatilgan; login’da — fayldagi «Auth» qoidasi                                            |
| 429    | `RATE_LIMITED` + `Retry-After`                                                         | throttler; kunlik kod limiti                                                                                                       |
| 503    | `ADMIN_DEADLINE_EXCEEDED`                                                              | qabul qilinganidan beri 45 s o‘tdi (replay’dan keyin, tranzaksiya boshida yoki commit oldidan); hech narsa yozilmaydi, kalit bo‘sh |

**Bitta lug‘at (D-65 D5).** OTP servisi (ega CLI’si va panel uchun umumiy) `VALIDATION_ERROR {field, reason}` bilan rad
etadi; admin HTTP xaritalovchisi (`adminOtpHttpError`) uni shunday beradi: `OTP_REQUIRED`, `AMOUNT_MISMATCH` (umumiy
servisda, CLI ham oladi), `OTP_LOCKED`, `OTP_UNAVAILABLE` → `400`, `details.fields: [{ path, code }]`;
`OTP_INVALID`, `OTP_MISMATCH` → `422 CODE_INVALID` + `attemptsLeft`; `OTP_EXPIRED`, noma’lum va ishlatilgan kod →
`422 CODE_EXPIRED`. Admin yo‘lidan xom `OTP_EXPIRED`, `OTP_MISMATCH`, `OTP_INVALID` hech qachon chiqmaydi.

Amalning o‘z domen rad etishlari (masalan karta holati, review turi) ham `400 VALIDATION_ERROR` + `fields[{ path, code }]`
shaklida, `code` — ega CLI servislarining sabab kodi (`RECENT_AUTO_TOPUP`, `BANK_VERIFICATION_REQUIRED`, `ALREADY_CREDITED`
va h.k.). Admin yo‘llarida `403` yo‘q.

### Auth (`/admin/auth/*`)

| Metod | Yo‘l                        | Kim       | So‘rov → javob                                                       |
| ----- | --------------------------- | --------- | -------------------------------------------------------------------- |
| POST  | `/admin/auth/start`         | ochiq     | `{}` → `{ nonce, botUrl: "https://t.me/<bot>?start=admin_<nonce>" }` |
| GET   | `/admin/auth/status/:nonce` | ochiq     | → `{ status: "PENDING" \| "CODE_SENT" \| "DENIED" \| "EXPIRED" }`    |
| POST  | `/admin/auth/verify`        | ochiq     | `{ nonce, code }` → cookie + `{ admin }`                             |
| POST  | `/admin/auth/logout`        | har admin | `{}` → `{}`; cookie tozalanadi, sessiya bekor                        |
| GET   | `/admin/auth/me`            | har admin | → `{ admin, permissions, limits, session }`                          |

- Oqim web login’ning naqshi (D-27): `LoginRequest(kind ADMIN)`, nonce 43 belgi, 10 daqiqa; kod 6 raqam, 3 daqiqa, 5 urinish,
  bir martalik. Bot kodni faqat `from.id ∈ ADMIN_TELEGRAM_IDS` va `AdminUser.isActive` bo‘lsa yuboradi; boshqalarga
  «havola eskirgan», status `PENDING` qoladi (oracle yo‘q). «Bu men emasman» → `DENIED`. Telefon so‘ralmaydi.
- Bot kod xabarida «kodni faqat admin.ggpin.uz ga kiriting» ogohlantirishi va `/admin/auth/start` chaqirilgan IP hamda
  User-Agent ko‘rsatiladi (S2, SA-L4); domen nomi brend konfiguratsiyasidan olinadi.
- `verify` xatolari: `422 CODE_INVALID` (+ `attemptsLeft`), `422 CODE_EXPIRED`. Muvaffaqiyatli kirish `ADMIN_LOGIN` audit
  qatori va xabar: adminning o‘ziga (sessiyani yopish tugmasi bilan) va barcha `OWNER_ALERT_CHAT_ID` ga. `logout` —
  `ADMIN_LOGOUT`.
- Limitlar: `start` 10/daqiqa/IP, `verify` 30/daqiqa/IP, `status` 300/daqiqa/IP; bot bitta akkauntga 10 daqiqada 5 kod.
- `admin` = `{ id, name, role: "OWNER" | "OPERATOR" | "SUPPORT", telegramIdMasked }`.

```json
{
  "success": true,
  "data": {
    "admin": {
      "id": "cm3admin000000000000001",
      "name": "Aziz",
      "role": "OPERATOR",
      "telegramIdMasked": "12******89"
    },
    "permissions": ["dashboard.read", "orders.read", "orders.retry", "orders.cancel", "…"],
    "limits": {
      "operatorRefundMaxTiyin": "50000000",
      "confirmThresholdTiyin": "100000000"
    },
    "session": {
      "expiresAt": "2026-11-15T18:00:00.000Z",
      "idleExpiresAt": "2026-11-15T11:00:00.000Z"
    }
  }
}
```

### Tasdiq kodi — `POST /admin/confirmations`

Kim: `confirmations.create` ruxsati bor rol (OWNER, OPERATOR), **va** shu paytda aynan shu amalni bajara oladigan admin
(`adminCodeIssueDecision`, SA-M1): rol, OPERATOR uchun buyurtma limiti va faqat-OWNER hold’lari — yo‘q bo‘lsa `404`
(amalning o‘zidagidek). Rol (`confirmations.create` va amalning ruxsati) nishonni o‘qishdan **oldin** tekshiriladi:
ruxsatsiz admin nishon holati haqida hech narsa bilmaydi (C-1). Nishon yo‘q bo‘lsa — `404`, kod chiqmaydi. Barcha rad
etishlar (domen kodlari ham) admin xato shaklida — `details.fields: [{ path, code }]`.
Amal kod talab qilmasa (`adminOtpRequired` server summasi bo‘yicha `false`) kod chiqarilmaydi va yuborilmaydi — `400`,
`fields[{ path: "action", code: "OTP_NOT_REQUIRED" }]`. Kod ishlatilganda amalning o‘z ruxsati yana tekshiriladi.
`users.adjustWallet` da so‘nggi avto to‘ldirishlar yoki ochiq buyurtmalar to‘plami tasdiqlanmagan yoki eskirgan bo‘lsa, kod
chiqarilmaydi — amalning o‘zi beradigan `400 fields[{ path: "user", code: "RECENT_AUTO_TOPUP" | "OPEN_ORDERS" }]` darhol
qaytadi (kunlik kod limiti behuda ketmaydi; ega qarori 2026-11-22). Amal qulf ostida baribir qayta tekshiradi.
`Idempotency-Key` kerak emas. Bu — `AuditLog` qatori yozmaydigan yagona admin yozuv yo‘li (N8): kod chiqarish hech
narsani o‘zgartirmaydi, tasdiqlangan amal esa o‘z audit qatorida `otpVerified` ni yozadi. Body — `action` bo‘yicha (`AdminConfirmationBodySchema`), amal o‘zi yuboradigan maydonlar
bilan; har maydon binding’ga kiradi:

| `action`                                                    | Maydonlar (hammasi binding’da)                                                                                                                               |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `orders.cancel`, `orders.failAndRefund`, `payments.reverse` | `targetId`, `amountTiyin` (musbat)                                                                                                                           |
| `orders.refund`                                             | `targetId`, `amountTiyin` (musbat; FULL — qolgan summa, PARTIAL — qisman summa), `mode` (`FULL` \| `PARTIAL`), `returnTxHash?` (N3)                          |
| `orders.resolve`                                            | `targetId`, `amountTiyin` (buyurtma jami), `outcome`, `proof`, `deliveredOutsideSystem`, `reason` (p5 `proofDigest` uni o‘z ichiga oladi)                    |
| `payments.reviewCredit`                                     | `targetId` (review), `amountTiyin`, `userId` yoki `intentId` (bittasi), `confirmOverride`, `bankVerified`                                                    |
| `users.adjustWallet`                                        | `targetId` (user), `amountTiyin` (ishorali, 0 emas), `confirmOverrideSet?`, `confirmOpenOrdersSet?`, `idempotencyKey` (= amal so‘rovidagi `Idempotency-Key`) |
| `cards.resume`                                              | `targetId` (karta), `confirmOverride`, `confirmSecurityPause`                                                                                                |
| `cards.retire`                                              | `targetId` (karta), `emergency`                                                                                                                              |
| `cards.limit`                                               | `targetId` (karta), `receiveLimitTiyin`, `monthlyLimitTiyin?`                                                                                                |
| `fx.set`                                                    | `pair` (`USDT_UZS` \| `TON_USDT`) va `rate` — ikkalasi bog‘lanadi                                                                                            |
| `admins.create`                                             | `telegramId`, `name`, `role` (`OPERATOR` \| `SUPPORT`)                                                                                                       |
| `admins.update`                                             | `targetId` va o‘zgaradigan har maydon (`name?`, `role?`, `isActive?`; kamida bittasi)                                                                        |
| `admins.sessionsRevoke`, `sessions.revoke`                  | `targetId`                                                                                                                                                   |

Javob: `{ challengeId, expiresInSec }` — `challengeId` 128 bit (32 hex) brauzerga qaytadi (D-46 dagi «faqat CLI
xotirasida» qoidasining HTTP varianti): yolg‘iz o‘zi yetmaydi, kod, o‘sha sessiya va o‘sha binding kerak. Xatolar: `404`,
`400` (shakl; `OTP_NOT_REQUIRED`; `OTP_UNAVAILABLE`; `RECENT_AUTO_TOPUP`, `OPEN_ORDERS`), `429` (kunlik limit).

### Kalitni bekor qilish — `POST /admin/write-keys/void` (9-B, SA-1)

Kim: har qanday faol admin (OWNER, OPERATOR, SUPPORT), faqat **o‘z** kalitini — audit id `adminId` dan hisoblanadi,
boshqa adminning kalitiga ta’sir qilib bo‘lmaydi. Sessiya, CSRF yoki `Origin` xato — `404`. Body’dagi `action` adminning
hozirgi roliga (tranzaksiya ichida qayta o‘qiladi) kirmasa ham `404`, tombstone yozilmaydi: admin faqat o‘zi bajara oladigan
amal kalitini bekor qiladi. `Idempotency-Key` sarlavhasi kerak emas (yo‘l tabiatan idempotent). Kod (OTP) va `reason`
so‘ralmaydi: void pul harakatlantirmaydi, faqat eski so‘rovning kelajakdagi commit’ini to‘xtatadi. Limit — admin yozuv
yo‘llarining umumiy limiti: bitta sessiyaga 30/daqiqa (void ham shu hisobga kiradi).

Body (`.strict()`): `{ idempotencyKey, action, targetId }` — `idempotencyKey` sarlavhadagi format (8–128,
`A–Z a–z 0–9 _ -`); `action` — kalitli admin yozuv ruxsati (`ADMIN_KEYED_WRITE_PERMISSIONS`; `confirmations.create`,
`writeKeys.void` va o‘qish ruxsatlari — `400`); `targetId` — eski so‘rov bog‘langan nishon: yo‘ldagi id, nishonsiz yo‘llarda
esa `catalog.productReorder` → `products`, `catalog.skuCreate` → yo‘ldagi mahsulot id, `admins.create` → yangi adminning
`telegramId`. `action` va `targetId` faqat tombstone’ning audit ko‘rinishi uchun; natijani faqat kalit hal qiladi.

Javob `200`:

- `{ status: "VOIDED", auditId, at }` — shu kalit bilan amal commit bo‘lmagan; tombstone hozir (yoki avvalroq) yozildi va
  shu kalitli har keyingi so‘rov `409 IDEMPOTENCY_CONFLICT` oladi;
- `{ status: "APPLIED", auditId, action, at }` — shu kalit bilan amal allaqachon commit bo‘lgan (`auditId` — o‘sha amal
  qatori; `action` — o‘sha qatorning `AuditLog.action` i, masalan `WALLET_ADJUST`, body’dagi ruxsat kaliti emas: haqiqatda
  bajarilgan amalni ko‘rsatadi, SPA uni `admin.enums.auditAction.*` bilan nomlaydi).

Tombstone — `AuditLog` qatori: `id = adminAuditIdFor(adminId, key)`, `actorType = "ADMIN"`, `action =
"IDEMPOTENCY_VOID"` (`ADMIN_AUDIT_ACTIONS` da), `targetType`/`targetId` — `action` nishoni, `after = { voidedAction,
adminRole, sessionId }`, `reason: null`; kalitning o‘zi va body hash’i yozilmaydi. Migratsiya yo‘q. Xatolar: `400
VALIDATION_ERROR`, `404`, `429 RATE_LIMITED`, `503 ADMIN_DEADLINE_EXCEEDED`.

### Dashboard — `GET /admin/dashboard?period=today|week|month|range&from=&to=`

OWNER va OPERATOR (D-65 D4). `range` da `from` va `to` majburiy (≤ 366 kun), boshqa davrlarda berilmaydi. Kunlar —
Toshkent kalendar kuni.

- `period: { from, to }`;
- `kpi`: `revenueTiyin`, `ordersCount`, `deliveredCount`, `deliveryRateBps|null`, `avgDeliverySec|null`,
  `grossProfitTiyin` (ishorali), `newUsersCount`, `topupsTiyin`, `topupsCount` — `revenueTiyin` = davrda `DELIVERED`
  bo‘lgan va keyin qaytarilmagan buyurtmalarning `priceTiyin − discountTiyin` yig‘indisi; foyda — tannarx buyurtmaning
  kurs snapshoti bo‘yicha so‘mda;
- `charts`: `revenue: [{ day, revenueTiyin, profitTiyin }]`, `productShare: [{ productId, productName, revenueTiyin,
ordersCount }]`, `topupBankShare: [{ bank: "HUMO" | "UZCARD", amountTiyin, count }]`;
- `alerts: [{ kind, severity: "warning" | "critical", count|null, since|null }]`, `kind` ∈ `ORDERS_NEEDS_REVIEW`, `ORDERS_HELD`,
  `PAYMENT_REVIEWS_OPEN`, `FRAGMENT_SESSION_DEAD`, `TON_BALANCE_LOW`, `TON_DAILY_LIMIT_HIGH`, `QUEUE_FAILED_JOBS`,
  `RECONCILE_MISMATCH`, `BANK_FEED_SILENT`. Bo‘sh ro‘yxat — «hammasi joyida».

### Buyurtmalar (LOYIHA — 5-bosqich shakllari, 9-B da tekshiriladi)

| Metod | Yo‘l                                | Rol                     | So‘rov → javob                                                                  |
| ----- | ----------------------------------- | ----------------------- | ------------------------------------------------------------------------------- |
| GET   | `/admin/orders`                     | hamma                   | filtrlar → `AdminOrderRow[]` + `meta`                                           |
| GET   | `/admin/orders/review-queue`        | hamma                   | `?status=NEEDS_REVIEW\|HELD` → qator + `{ enteredAt, ageSec }`, eskisi birinchi |
| GET   | `/admin/orders/:id`                 | hamma                   | → tafsilot                                                                      |
| POST  | `/admin/orders/:id/retry`           | OPERATOR (hold), OWNER  | `{ reason }` — HELD→QUEUED                                                      |
| POST  | `/admin/orders/:id/cancel`          | OPERATOR (limit), OWNER | `{ reason, confirmAmountTiyin?, otp? }` — PAID/QUEUED/HELD→CANCELLED→REFUNDED   |
| POST  | `/admin/orders/:id/fail-and-refund` | OPERATOR (limit), OWNER | `{ reason, confirmAmountTiyin?, otp? }` — HELD→FAILED→REFUNDED                  |
| POST  | `/admin/orders/:id/resolve`         | OWNER                   | `{ outcome, proof, deliveredOutsideSystem, reason, confirmAmountTiyin?, otp? }` |
| POST  | `/admin/orders/:id/refund`          | OWNER                   | `{ mode, amountTiyin?, returnTxHash?, reason, confirmAmountTiyin?, otp? }`      |
| POST  | `/admin/orders/:id/notes`           | hamma                   | `{ text }` (1–1000) → `{ note, auditId, applied }`                              |

- **Ro‘yxat filtrlari:** `status` (bitta yoki vergulli bir nechta xom holat), `productId`, `adapter`, `userId`, `from`/`to`
  (`createdAt`), `minTiyin`/`maxTiyin` (`totalTiyin`, `min ≤ max`), `q` (`#1042`, `@username` yoki TON tx hash), `page`,
  `limit`.
- **`AdminOrderRow`:** `id`, `number`, `createdAt`, `user: { id, username }`, `product: { id, slug, name }`,
  `sku: { id, label } | null`, `quantity`, `recipient: { displayName, fields }`, `priceTiyin`, `discountTiyin`,
  `totalTiyin`, `costCurrency`, `costMinor`, `profitTiyin|null` (ishorali, DELIVERED gacha `null`), `status`,
  `statusReason|null`, `adapter|null`, `deliveredAt|null`.
- **Tafsilot** = qator + `events[{ from|null, to, actor, note|null, createdAt }]`,
  `attempts[{ id, attemptNo, adapter, status, externalRef, error, facts, createdAt }]`,
  `tonTransfers[{ id, attemptId, status, network, walletAddress, toAddress, amountNanoTon, feeNanoTon, seqno, validUntil,
extMsgHash, txHash, txLt, explorerUrl, confirmedAt, createdAt }]` (`explorerUrl` — server tarmoqqa qarab beradi),
  `ledger[{ id, kind, amountTiyin, refType, createdAt }]`, `refundedTiyin`,
  `quote{ id, priceTiyin, costMinor, maxCostMinor, costCurrency, createdAt, expiresAt }`,
  `fxRate{ id, pair, rate, source, createdAt }`, `notes[]`. Witness nizosi bo‘lgan transfer «yuborilmagan» deb
  ko‘rsatilmaydi (5-bosqich S5 sharhi) — aniq shakli 9-B da.
- **Urinish `facts` (SA-M4)** — saqlangan JSON emas, server quradigan qat’iy proyeksiya (`AdminAttemptFactsSchema`):
  `{ ton: { toAddress|null, amountNanoTon|null, bounce: { txHash, txLt, returnTxHash, returnLt, returnedNanoTon } | null,
expiry: { seqno, observedAt } | null, witnessConflict } | null }`. Urinishning `request` i (unda `recheckedProviderRef`
  va payload BOC bor) javobga umuman chiqmaydi; `response` dan faqat shu faktlar olinadi. Manba yo‘llari
  (`response.ton.*`) 9-B da tekshiriladi.
- **Amallar** holat mashinasi orqali (`order-state.ts`); pul qaytsa `REFUND` ledger yozuvi va holat o‘zgarishi bitta
  tranzaksiyada hamyon qulfi bilan. Javob: `{ order: AdminOrderRow, refundTiyin|null, auditId, applied }`. Buyurtma
  kutilgan holatda emas — `409 ORDER_STATE_CONFLICT` (worker bilan poyga — CAS).
- **No-op va takror (CR-L8).** Takror so‘rov (o‘sha `Idempotency-Key`) — birinchi javob, `applied: false`. Kalitsiz
  «allaqachon bajarilgan» holat faqat o‘z amalimiz natijasi bo‘lsa no-op bo‘ladi: QUEUED buyurtmaga `retry` — oxirgi
  HELD→QUEUED o‘tishi shu admin amalining `ORDER_RETRY` audit qatori bo‘lsa `applied: false` (`auditId` — o‘sha qator),
  aks holda (worker yoki boshqa admin o‘tkazgan) `409 ORDER_STATE_CONFLICT` (p5 `order-retry.service` naqshi). `cancel`,
  `fail-and-refund`, `resolve`, `refund` da no-op yo‘q: kutilgan holat bo‘lmasa — `409`.
- `retry` (M-1, p5 S9a): OPERATOR har HELD buyurtmani qayta navbatga qo‘ya oladi, attempt-cap (`attemptCapHold`) va
  NO_PURCHASE (`noPurchaseHold`) hold’laridan tashqari — ular faqat OWNER’niki, OPERATOR’ga `404`. Release audit qatori
  (`ORDER_RETRY`) `before.maxAttemptNo` (shu paytgacha eng katta `attemptNo`) va `after.actor.role` ni yozadi. Urinishlar
  hisobini faqat **OWNER** release’i nollaydi (worker keyingi urinishlarni o‘sha OWNER qatoridagi `maxAttemptNo` dan
  keyin sanaydi); OPERATOR retry’i va tizim retry’i nollamaydi.
- `cancel`/`fail-and-refund` doim **to‘liq** summa; OPERATOR faqat `totalTiyin ≤ ADMIN_OPERATOR_REFUND_MAX_TIYIN` da va
  NO_PURCHASE hold bo‘lmasa (aks holda `404`), qisman refund OPERATOR’da yo‘q. Bu refundlar qo‘lda yaratiladigan pul
  chekiga kirmaydi.
- `resolve`: `outcome` `DELIVERED` yoki `FAILED` (+ refund); `proof` — `AdminResolveProofSchema`, `kind` bo‘yicha qat’iy
  (`TON_TX`, `TON_NOT_SENT`, `TON_NOT_DEBITED`, `TON_BOUNCED`, `FRAGMENT_STATUS`, `MANUAL`), maydonlari 5-bosqich
  `NeedsReviewProofSchema` bilan bir xil, `reason` siz (body `reason` i server tomonida ko‘chiriladi; `proof.reason` —
  `400`), satrlar uzunligi chegaralangan. `TON_UNMATCHED_RESOLVED` — faqat ega CLI’si (D-59 (3)). Kod: `MANUAL`,
  `TON_NOT_DEBITED`, `TON_BOUNCED` va chegaradan katta summada. `deliveredOutsideSystem` — I-8 tasdig‘i. HTTP tanasidagi
  `type: "CLI"` resolver rad etiladi (I-4).
- `refund` (OWNER, kod **har doim**, D-65 D1): `mode` majburiy (N3). `mode: "FULL"` — `amountTiyin` yo‘q (berilsa `400`),
  qolgan to‘liq summa, DELIVERED→REFUNDED (`REFUND`, `ORDER/<orderId>`); `mode: "PARTIAL"` — `amountTiyin` majburiy,
  holat DELIVERED qoladi (`REFUND`, `ADMIN_ACTION/<auditId>`). `mode` va `returnTxHash` kod binding’ida: qolgan summaga
  teng qisman refund kodi to‘liq refundni tasdiqlamaydi. Summa qo‘lda
  yaratiladigan pul chekiga qo‘shiladi. Jonli urinish yoki `SIGNED`/`BROADCAST`/`CONSUMED_UNMATCHED`/`BOUNCED` transfer
  bo‘lsa DB rad etadi. `returnTxHash` (64 hex) audit isbotiga yoziladi, qayta ishlatilmaydi (I-7).

### Foydalanuvchilar

| Metod | Yo‘l                               | Rol       | So‘rov → javob                                                                                    |
| ----- | ---------------------------------- | --------- | ------------------------------------------------------------------------------------------------- |
| GET   | `/admin/users`                     | hamma     | `?q&status&from&to&page&limit` → `AdminUserRow[]` + `meta`                                        |
| GET   | `/admin/users/:id`                 | hamma     | → qator + `{ lastName, photoUrl, phone, referralCode, referredBy, activeSessionsCount, notes[] }` |
| GET   | `/admin/users/:id/orders`          | hamma     | `?page&limit` → `AdminOrderRow[]`                                                                 |
| GET   | `/admin/users/:id/ledger`          | hamma     | `?page&limit` → `[{ id, kind, amountTiyin, refType, refId, createdAt }]`                          |
| GET   | `/admin/users/:id/payments`        | hamma     | `?page&limit` → `AdminPaymentRow[]`                                                               |
| GET   | `/admin/users/:id/referrals`       | hamma     | `?page&limit` → `[{ id, username, createdAt }]`                                                   |
| GET   | `/admin/users/:id/sessions`        | hamma     | `?page&limit` → `[{ id, userAgent, ipMasked, createdAt, expiresAt, revokedAt }]`                  |
| POST  | `/admin/users/:id/block`           | OPERATOR+ | `{ reason }` → `AdminUserState`                                                                   |
| POST  | `/admin/users/:id/unblock`         | OWNER     | `{ reason }` → `AdminUserState` (D-65 D2)                                                         |
| POST  | `/admin/users/:id/freeze`          | OPERATOR+ | `{ reason }` → `AdminUserState`                                                                   |
| POST  | `/admin/users/:id/unfreeze`        | OWNER     | `{ reason }` → `AdminUserState`                                                                   |
| POST  | `/admin/users/:id/sessions/revoke` | OPERATOR+ | `{ reason }` → `{ userId, revokedSessions, auditId, applied }`                                    |
| GET   | `/admin/users/:id/adjust-preview`  | OWNER     | `?amountTiyin` → `AdminAdjustPreview`                                                             |
| POST  | `/admin/users/:id/adjust-wallet`   | OWNER     | `{ amountTiyin, reason, confirmOverrideSet?, confirmOpenOrdersSet?, confirmAmountTiyin?, otp? }`  |
| POST  | `/admin/users/:id/notes`           | hamma     | `{ text }` → `{ note, auditId, applied }`                                                         |

- `q`: `@username`, Telegram id yoki user id; `status`: `ACTIVE`, `BLOCKED`, `FROZEN`, `BOT_BLOCKED`; `from`/`to` — `createdAt`.
- **`AdminUserRow`:** `{ id, telegramId (string), username, firstName, locale, createdAt, lastSeenAt, balanceTiyin (ishorali),
ordersCount, ordersTotalTiyin, referralsCount, isBlocked, purchaseFrozen, botBlocked }`. `phone` — OWNER/OPERATOR’ga to‘liq,
  SUPPORT’ga maskalangan, ulashilmagan bo‘lsa `null`. `notes` — oxirgi 20 ta (`{ id, text, createdAt, author: { id, name } }`).
- **`AdminUserState`:** `{ userId, isBlocked, purchaseFrozen, revokedSessions, auditId|null, applied }`. Bloklash hamyon qulfi
  ostida va foydalanuvchining barcha web sessiyalarini shu tranzaksiyada yopadi (D-63 (9)).
- `adjust-wallet` (`WALLET_ADJUST`, mavjud servis): `amountTiyin` ishorali, 0 emas (+ kirim, − chiqim); `confirmOverrideSet` —
  oxirgi avtomatik to‘ldirishlar to‘plamining 12 hex id’si (CLI `--confirm-override=<set>`); `confirmAmountTiyin` ishorali.
  Kod: kirimda (musbat) **har doim**, chiqimda chegaradan katta bo‘lsa (D-65 D1); confirmation’dagi `idempotencyKey` amal
  so‘rovidagi `Idempotency-Key` sarlavhasiga teng bo‘lishi shart (bitta kod — bitta pul harakati). Javob:
  `{ ledgerEntryId, balanceTiyin, frozen, auditId, applied }`. Musbat tuzatish qo‘lda yaratiladigan pul chekiga qo‘shiladi
  («Rol matritsasi» ostidagi band).
- **Ochiq buyurtmalar (I-5, ega qarori 2026-11-22).** Musbat tuzatishda foydalanuvchining ochiq buyurtmasi (`PAID`, `QUEUED`,
  `PROCESSING`, `HELD`, `NEEDS_REVIEW`) bo‘lsa, `confirmOpenOrdersSet` — shu buyurtmalar to‘plamining 12 hex id’si — majburiy
  (CLI `--confirm-open-orders=<set>`). U kod binding’ida; berilmasa yoki eskirgan bo‘lsa (hamyon qulfi ostida qayta
  hisoblanadi) — `400 fields[{ path: "user", code: "OPEN_ORDERS" }]`, hech narsa yozilmaydi. To‘plam berilgan bo‘lsa, u
  ochiq buyurtma qolmagan holatda ham joriy to‘plamga teng bo‘lishi shart (masalan, tasdiqlangan HELD buyurtma oraliqda
  avto-refund bo‘lsa — rad). Audit `after.openOrders` ni
  yozadi. Manfiy tuzatishga ta’sir qilmaydi. Sabab: HELD buyurtma keyin avto-refund bo‘lsa, kompensatsiya ikki marta to‘lanadi.
- **`adjust-preview`** (`users.adjustPreview`, faqat OWNER; o‘z mijoz akkaunti — `400 SELF_TARGET`): `amountTiyin` — ishorali
  butun son, 0 emas, `|x| ≤ ADMIN_ADJUST_MAX_TIYIN`. Hech narsa yozmaydi. `AdminAdjustPreview`: `{ balanceTiyin,
newBalanceTiyin, otpRequired, otpReason: "CREDIT" | "ABOVE_THRESHOLD" | "DAILY_BUDGET" | null, recentAutoTopups:
[{ paymentId, amountTiyin, confirmedAt }], confirmOverrideSet | null, openOrders: [{ id, number, status, priceTiyin,
createdAt }], confirmOpenOrdersSet | null, manualCreditToday: { usedTiyin, capTiyin } }` (pul — string). Qiymatlar amalning
  o‘zi ishlatadigan funksiyalar bilan hisoblanadi, shuning uchun preview’dagi to‘plamlar bilan yuborilgan amal
  `RECENT_AUTO_TOPUP` / `OPEN_ORDERS` siz o‘tadi (oraliqda yangi to‘ldirish yoki buyurtma bo‘lmasa).

### To‘lovlar (P2P)

| Metod | Yo‘l                                         | Rol   | So‘rov → javob                                                                                                                                                         |
| ----- | -------------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET   | `/admin/payments/intents`                    | hamma | `?status&userId&cardId&from&to&page&limit` → `[{ id, userId, status, amountTiyin, baseAmountTiyin, card: { id, bank, last4 } \| null, createdAt, expiresAt, paidAt }]` |
| GET   | `/admin/payments`                            | hamma | `?status&userId&from&to&page&limit` → `AdminPaymentRow[]`                                                                                                              |
| GET   | `/admin/payments/reviews`                    | hamma | `?status=OPEN\|RESOLVED&kind&cardId&from&to&page&limit` → `AdminReviewRow[]` (`status` standarti `OPEN`)                                                               |
| GET   | `/admin/payments/reviews/:id`                | hamma | → `AdminReviewRow` + `{ bankMessage, payment, note, resolvedAuditId }`                                                                                                 |
| GET   | `/admin/payments/reviews/:id/credit-preview` | OWNER | `?userId` yoki `?intentId` → credit oldidan ko‘rinish                                                                                                                  |
| GET   | `/admin/payments/bank-messages/:id`          | hamma | → `AdminBankMessage` (`text`, `balanceAfterTiyin`, `channel` faqat OWNER’ga)                                                                                           |
| GET   | `/admin/payments/cards`                      | hamma | → `AdminCard[]`                                                                                                                                                        |
| GET   | `/admin/payments/reconcile`                  | hamma | `?from&to&page&limit` → kunlik hisobotlar                                                                                                                              |
| POST  | `/admin/payments/reviews/:id/credit`         | OWNER | `{ userId \| intentId, reason, confirmOverride, bankVerified, confirmAmountTiyin?, otp? }` — kod **har doim** (D-66), summadan qat’i nazar                             |
| POST  | `/admin/payments/:id/reverse`                | OWNER | `{ reason, confirmAmountTiyin?, otp? }`                                                                                                                                |
| POST  | `/admin/payments/cards/:id/pause`            | OWNER | `{ reason }`                                                                                                                                                           |
| POST  | `/admin/payments/cards/:id/resume`           | OWNER | `{ reason, confirmOverride, confirmSecurityPause, otp? }` — SECURITY pauzani ochishda kod (D-65 D3)                                                                    |
| POST  | `/admin/payments/cards/:id/limit`            | OWNER | `{ receiveLimitTiyin, monthlyLimitTiyin?, reason }` (`null` — oylik chek olib tashlanadi)                                                                              |
| POST  | `/admin/payments/cards/:id/retire`           | OWNER | `{ reason, emergency }`                                                                                                                                                |

- **`AdminPaymentRow`:** `{ id, userId, intentId, provider, amountTiyin, status: "CREATED" | "CONFIRMED" | "CANCELLED", bankMessageId,
reviewId, createdAt, confirmedAt, cancelledAt }` — `providerTxnId` va `raw` yo‘q.
- **`AdminReviewRow`:** `{ id, kind, status, resolution|null, card|null, intentId, bankMessageId, amountTiyin|null, direction|null,
bankTxnAt|null, createdAt, resolvedAt|null }`.
- **`AdminBankMessage`:** `{ id, source, parseStatus, rejectReason, direction, amountTiyin, balanceAfterTiyin, last4, cardId, channel,
tgDate, bankTxnAt, createdAt, text|null }`. `text`, `balanceAfterTiyin` va `channel` — faqat OWNER’ga, boshqalarga
  `null` (`payments.bankMessageRaw`, SA-M5).
- **credit-preview** (CLI `review:credit` chiqaradigan ma’lumot): `{ amountTiyin, userId, blocked, purchaseFrozen, accountAgeDays,
overLimit, overrideNeeded|null, needsBankVerification, manualCreditsSinceRequest: { adjust: { count, sumTiyin }, reviewCredit:
{ count, sumTiyin }, since } }`.
- **`AdminCard`:** `{ id, bank, last4, holderName, status, receiveLimitTiyin, monthlyLimitTiyin|null, receivedTiyin,
receivedMonthTiyin, reservedTiyin, usagePercent, autoCreditPaused, verifiedAt, retiredAt, createdAt }` — to‘liq raqam yo‘q.
- **Reconcile kuni:** `{ day, auditId, createdAt, ok, checkedMessages, debits, openReviews, historyScan, mismatches: { <kod>: son },
examples: { <kod>: id[] } }` — worker’ning `PAYMENT_RECONCILE` audit qatori; kodlar `RECONCILE_MISMATCH_CODES`.
- Javoblar: credit → `{ reviewId, paymentId, userId, intentId, amountTiyin, auditId, applied }`; reverse → `{ paymentId, userId,
ledgerEntryId, balanceTiyin (ishorali), frozen, auditId, applied }`; karta amallari → `{ card: AdminCard, cancelledIntents,
auditId|null, applied }`. Servislar ega CLI’siniki (D-46), amal nomlari bir xil (`REVIEW_CREDIT`, `PAYMENT_REVERSE`,
  `CARD_PAUSE`, `CARD_RESUME`, `CARD_LIMIT`, `CARD_RETIRE`, `CARD_RETIRE_EMERGENCY`).
- **Faqat CLI:** `card:add` (to‘liq karta raqami, D-63 (6)) va review yopish (`review:ignore`, `review:returned-offline`,
  `review:accept-chain`) — bu loyihada panel yo‘li yo‘q.

### Katalog

| Metod | Yo‘l                                | Rol       | So‘rov → javob                                                                                                                                                                      |
| ----- | ----------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET   | `/admin/categories`                 | OPERATOR+ | → `[{ id, slug, nameUz, nameRu, sort, productsCount }]`                                                                                                                             |
| GET   | `/admin/products`                   | OPERATOR+ | → `[{ id, slug, categoryId, nameUz, nameRu, imageUrl, deliveryType, isActive, isFeatured, sort, activeSkusCount, routesEnabledCount }]`                                             |
| GET   | `/admin/products/:id`               | OPERATOR+ | → qator + uz/ru tavsif va yordam, `regionBadge`, `isAuto`, `allowCustomQty`, `minQty`, `maxQty`, `skus[]`, `routes[]`, `updatedAt`                                                  |
| GET   | `/admin/products/:id/price-preview` | OPERATOR+ | `?skuId` yoki `?quantity` (+ `markupBps?`, `minMarginTiyin?`) → `{ costCurrency, costMinor, fxRate, markupBps, minMarginTiyin, priceTiyin, marginTiyin, belowMinMargin }`           |
| PATCH | `/admin/categories/:id`             | OWNER     | `{ nameUz?, nameRu?, sort?, reason? }` → `{ category, auditId \| null, applied }`                                                                                                   |
| PATCH | `/admin/products/:id`               | OWNER     | `{ nameUz?, nameRu?, descriptionUz?, descriptionRu?, helpUz?, helpRu?, regionBadge?, imageUrl?, isActive?, isFeatured?, sort?, reason? }` → `{ product, auditId \| null, applied }` |
| POST  | `/admin/products/reorder`           | OWNER     | `{ productIds: [...] }` (har biri bir marta, tartib = indeks) → `{ products: [{ id, sort }], auditId \| null, applied }`                                                            |
| POST  | `/admin/products/:id/skus`          | OWNER     | `{ tab?, labelUz, labelRu, quantity, supplierSku?, markupBps, minMarginTiyin, isActive, sort, reason? }` → `{ sku, auditId \| null, applied }`                                      |
| PATCH | `/admin/skus/:id`                   | OWNER     | yuqoridagilarning ixtiyoriy qismi → `{ sku, auditId \| null, applied }`                                                                                                             |
| PATCH | `/admin/routes/:id`                 | OWNER     | `{ priority?, isEnabled?, reason? }` → `{ route, auditId \| null, applied }`                                                                                                        |

- SKU: `{ id, tab, labelUz, labelRu, quantity, supplierSku, markupBps, minMarginTiyin, isActive, sort }`; route: `{ id, adapter,
priority, isEnabled, health: "OK" | "DEGRADED" | "DOWN" | "UNKNOWN", healthCheckedAt }`.
- GET’lar OWNER va OPERATOR uchun (D-65 D4). Yozuv hech narsani o‘zgartirmasa (har maydon allaqachon so‘ralgan qiymatda) —
  audit qatori yozilmaydi: `auditId: null`, `applied: false` (CR-M2). Nom, label, tab, `supplierSku`, `regionBadge` — bir
  qatorli ko‘rinadigan matn; tavsif va yordamda faqat `\n` ruxsat («Umumiy qoidalar» → «Matn maydonlari»).
- `price-preview` so‘rovidagi `quantity` (1..1 000 000) va `markupBps` (0..10 000) — faqat oddiy o‘nlik raqam (`0x10`, `1e3`,
  `+5`, `05` — `400`). Javobdagi `fxRate` — `null` bo‘lishi mumkin (tannarx so‘mda bo‘lsa).
- PATCH’da kamida bitta maydon o‘zgarishi shart. `markupBps` 0–10 000, `minMarginTiyin` 0–10 000 000 000 (100 mln so‘m;
  D-63 (8), yuqori chegara — ega qarori 2026-11-22). `imageUrl` — faqat
  `/assets/…` ichidagi yo‘l (rasm yuklash yo‘q). Erkin miqdorli mahsulotda bir xil miqdorli ikkinchi faol paket — rad
  (`DUPLICATE_PACKAGE`; tekshiruv `Product` qatori qulfi ostida). Telegram Premium paketida `quantity` (oy) faqat 3, 6 yoki 12
  (`PREMIUM_MONTHS`). Erkin miqdorli mahsulotda paket `quantity` si mahsulotning `minQty..maxQty` oralig‘ida (`QUANTITY_RANGE`).
  `reorder` — barcha mahsulotlarning to‘liq to‘plami, har biri bir marta, takror ham shu kod (`PRODUCT_SET_MISMATCH`).
  Narx (`markupBps`, `minMarginTiyin`) yoki mavjudlik (`isActive`, `isEnabled`) o‘zgarsa yoki yangi paket qo‘shilsa,
  commit’dan keyin egalarga `adminAction` alerti ketadi; matn tahrirlarida alert yo‘q. `supplierSku` o‘zgarsa, yangi tannarx kelguncha narx yo‘q
  (`503 PRICE_UNAVAILABLE`, `quantity` dagi kabi) — 9-B da (narx kodi 5-bosqich bilan birlashgach).
  O‘zgarish mavjud kotirovkalarga ta’sir qilmaydi (narx kotirovkada qulflangan). Preview hisobi faqat `money-pricing.ts`.
- Yo‘q: yangi mahsulot, `inputSchema`, `deliveryType`, voucherlar (G-bosqichlar).

### Sozlamalar va kurs

| Metod | Yo‘l                | Rol       | So‘rov → javob                                                                                                      |
| ----- | ------------------- | --------- | ------------------------------------------------------------------------------------------------------------------- |
| GET   | `/admin/settings`   | OPERATOR+ | → `{ items: [{ key, value, unit: "TIYIN" \| "BPS" \| "MS" \| "COUNT", source: "env" \| "constant" }] }`             |
| GET   | `/admin/fx/history` | OPERATOR+ | `?pair&page&limit` → `[{ id, pair, rate, source, createdAt }]`                                                      |
| POST  | `/admin/fx`         | OWNER     | `{ pair, rate, reason, confirmRate?, otp? }` → `{ fxRate, derived, auditId, applied }` (LOYIHA, 5-bosqich `fx:set`) |

- Ikkala GET OWNER va OPERATOR uchun (D-65 D4). `key` — oq ro‘yxat (`ADMIN_SETTING_KEYS`): to‘ldirish chegaralari, narx toleransi, kotirovka va kurs muddatlari, admin chegaralari
  va limitlari; `value` — o‘nlik string. Sozlamalar faqat o‘qish uchun (D-63 (8)); TON limitlari — `GET /admin/infra/wallet`.
- `POST /admin/fx`: `pair` faqat `USDT_UZS` yoki `TON_USDT` (`TON_UZS` hosila, `derived`); `rate` — musbat o‘nlik (≤ 18 kasr).
  Sakrash qoidasi (24 soatdagi qo‘lda kurslarga nisbatan > 10 %, D-56 (3)) belgilasa — `confirmRate` (qayta kiritilgan kurs) va
  kod. `confirmRate` yo‘q yoki `rate` ga teng emas — `400`, `fields[{ path: "confirmRate", code: "RATE_MISMATCH" }]`
  (`ADMIN_RATE_MISMATCH_ERROR`; kurs pul emas, shuning uchun `AMOUNT_MISMATCH` emas, m-5). `FX_SET`.

### Infra (OWNER, OPERATOR o‘qiydi; LOYIHA — 5-bosqich ma’lumoti)

| Metod | Yo‘l                                       | Rol       | Javob                                                                                                                                                                                                                                                         |
| ----- | ------------------------------------------ | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET   | `/admin/infra/wallet`                      | OPERATOR+ | `{ network, address, balance: { nanoTon, microUsdt, snapshotAt } \| null, used24hNanoTon, limits: { perOrderMaxNanoTon, dailyMaxNanoTon, minBalanceAlertNanoTon }, recentTransfers[{ id, orderId, status, amountNanoTon, txHash, explorerUrl, createdAt }] }` |
| GET   | `/admin/infra/fragment`                    | OPERATOR+ | `{ status: "ACTIVE" \| "DEAD" \| "NONE", lastOkAt, deadAt, updatedAt }`                                                                                                                                                                                       |
| GET   | `/admin/infra/adapters`                    | OPERATOR+ | `[{ adapter, health, checkedAt }]`                                                                                                                                                                                                                            |
| GET   | `/admin/infra/queues`                      | OPERATOR+ | `[{ name, waiting, active, delayed, failed, paused, retryable }]`                                                                                                                                                                                             |
| POST  | `/admin/infra/queues/:name/jobs/:id/retry` | OWNER     | `{ reason }` → `{ queue, jobId, auditId, applied }`                                                                                                                                                                                                           |

- `used24hNanoTon` — 24 soatlik oynadagi chiqib ketishi mumkin bo‘lgan har transfer, `EXPIRED` ham (D-60 (2)); limitlar worker
  env’idan, faqat o‘qish. Fragment sessiyasini yangilash — panelda runbook matni (CLI `fragment:session-import`).
- `recentTransfers[].orderId` — `null` bo‘lishi mumkin (buyurtmaga bog‘lanmagan transfer).
- Retry (`reason` majburiy — mijozga xabar qayta yuboriladi) faqat `notify` va `tg-outbox` navbatlarining failed job’lari uchun (`:name` boshqa — `400`); `fulfill-order`,
  `validate-recipient`, `bank-message` — hech qachon (buyurtma uchun «retry» amali bor). `QUEUE_JOB_RETRY`.

### Audit log

| Metod | Yo‘l                          | Rol       | So‘rov → javob                                                                         |
| ----- | ----------------------------- | --------- | -------------------------------------------------------------------------------------- |
| GET   | `/admin/audit-log`            | OPERATOR+ | `?actorType&actorId&action&targetType&targetId&from&to&page&limit` → `AdminAuditRow[]` |
| GET   | `/admin/audit-log/export.csv` | OWNER     | xuddi shu filtrlar + `limit` (≤ 10 000, sahifasiz) → `text/csv`                        |

- **`AdminAuditRow`:** `{ id, createdAt, actor: { type: "ADMIN" | "CLI" | "SYSTEM", id|null, name|null }, action, targetType,
targetId, before|null, after|null, reason|null, ip|null }`. `action` filtri — istalgan katta harfli nom (CLI va worker
  yozganlari ham).
- `before`/`after` — server tomonida `redactAuditJson(json, view)` dan o‘tadi (SA-M4, M-2/N2; tasnif —
  `admin-audit-keys.ts`, javob sxemalari testi ham shu `isAuditSecretKey` ni ishlatadi). Kalit normallashtiriladi (katta-kichik
  harf farqsiz, `_` va `-` olib tashlanadi, camelCase so‘zlarga bo‘linadi) va istalgan chuqurlikda uch qatlamdan o‘tadi:
  1. **Allowlist (doim ko‘rinadi, deny’dan ustun):** `otpVerified`, `otpRequired`, `txHash`, `txLt`, `lt`, `returnTxHash`,
     `returnLt`, `extMsgHash`, `consumingTxHash`, `proofDigest`, `recentAutoTopups`, `statusReason`, `rejectReason`,
     `errorCode`, `reasonCode`, `statusCode`, `countryCode` (`AUDIT_VISIBLE_KEYS`).
  2. **Butun kalit deny-list (`AUDIT_SECRET_KEYS`):** karta (`pan`, `fullPan`, `cardPan`, `cardNumber`), kodlar (`code`,
     `otp`, `otpCode`, `codeHash`, `challengeId`, `bonusCode`, `promoCode`, `discountCode`), kalit va sirlar (`mnemonic`,
     `seed`, `privateKey`, `secretKey`, `apiKey`, `apiHash`, `password`, `passphrase`), sessiya (`cookie`, `cookies`,
     `session`, `sessionString`, `bankFeedSession`, `authKey`, `initData`), token va hash’lar (`token`, `accessToken`,
     `refreshToken`, `payToken`, `tokenHash`, `payTokenHash`, `refreshHash`, `requestHash`, `textSha256`,
     `idempotencyKey`), provayder (`providerRef`, `recheckedProviderRef`, `providerTxnId`, `raw`), imzolar (`signature`,
     `boc`, `signedBoc`, `payloadBoc`) va `verifyAmountTiyin`.
  3. **So‘z qoidasi (yangi kalitlar uchun fail-closed, `AUDIT_SECRET_TOKENS`):** kalit so‘zlaridan biri (yoki qo‘shni
     so‘zlar birikmasi, ko‘plik `-s`/`-es` bilan) `secret`, `password`, `mnemonic`, `cookie`, `token`, `boc`, `apikey`,
     `privatekey`, `verifyamount`, `providerref`, `providertxn`, `otp`, `code` yoki `hash` bo‘lsa — yashiriladi
     (`fooSecret`, `newMnemonic`, `xCookie`, `walletHash`). Bu substring emas: `codex`, `hashtag` ko‘rinadi; `session` so‘z
     qoidasida yo‘q (`revokedSessions` — son, ko‘rinadi).

  Yashirilgan qiymat — `"[redacted]"`, hamma rol uchun. Rolga bog‘liq maydonlar (istalgan chuqurlikda): `ip`, `sshClient`,
  `remoteAddr` — OWNER’ga to‘liq, boshqalarga API’ning `maskIp` i bilan (IPv4 /24, IPv6 /48; manzil bo‘lmasa `null`,
  `audit.ipFull`); `text`, `rawText`, `balanceAfterTiyin`, `channel` — OWNER’ga, boshqalarga `null`
  (`payments.bankMessageRaw`). Qatorning o‘z `ip` ustuni ham `audit.ipFull` bo‘yicha. Xom qator faqat ega CLI’sida. Haqiqiy
  `before`/`after` shakllari (WALLET_ADJUST, PAYMENT_REVERSE, REVIEW_CREDIT, FX_SET, ORDER_REVIEW_RESOLVE, ORDER_RETRY,
  CARD\_\*, SECURITY_PAUSE) — `admin-audit-golden.test.ts` da «ko‘rinadi / yashirin» ro‘yxatlari bilan.

- CSV (SA-M8): konvertsiz, `Content-Type: text/csv; charset=utf-8`, `Content-Disposition: attachment`, oqim (streaming)
  bilan; limit 5 eksport/daqiqa. Ustunlar `AUDIT_EXPORT_COLUMNS` tartibida, eng yangisi birinchi; qatorlar CRLF bilan.
  SPA faylni `fetch` + `Blob` bilan oladi (to‘g‘ridan-to‘g‘ri havola emas: `Sec-Fetch-Mode: navigate` — `404`, N5).
  `limit` — faqat o‘nlik raqamlar (`1e3`, `0x10`, ` 5` — `400`, N6). Har katak RFC 4180 bo‘yicha `"…"` ichida, ichki
  `"` → `""` (`csvCell`; JSON ichidagi `bigint` string bo‘ladi, m-7). Formula himoyasi `JSON.stringify` dan KEYINGI
  matnga qo‘llanadi: boshidagi bo‘shliqdan keyin `=`, `+`, `-`, `@` yoki to‘liq kenglikdagi `＝ ＋ － ＠` bilan, yoki tab/CR
  bilan boshlangan katak oldiga `'` qo‘shiladi. Har eksport `AUDIT_EXPORT` sifatida audit qilinadi (filtrlar `after` da).
  Xato bo‘lsa — oddiy JSON konverti.

### Adminlar (OWNER)

| Metod | Yo‘l                                | So‘rov → javob                                                                                         |
| ----- | ----------------------------------- | ------------------------------------------------------------------------------------------------------ |
| GET   | `/admin/admins`                     | → `AdminAccount[]`                                                                                     |
| GET   | `/admin/admins/:id/sessions`        | → `[{ id, createdAt, lastUsedAt, expiresAt, idleExpiresAt, revokedAt, ipMasked, userAgent, current }]` |
| POST  | `/admin/admins`                     | `{ telegramId, name, role: "OPERATOR" \| "SUPPORT", reason, otp }` → `{ admin, auditId, applied }`     |
| PATCH | `/admin/admins/:id`                 | `{ name?, role?, isActive?, reason, otp }` → `{ admin, auditId, applied }`                             |
| POST  | `/admin/admins/:id/sessions/revoke` | `{ reason, otp }` → `{ revokedSessions, currentRevoked, auditId, applied }`                            |
| POST  | `/admin/sessions/:id/revoke`        | `{ reason, otp }` → `{ revokedSessions, currentRevoked, auditId, applied }`                            |

- **`AdminAccount`:** `{ id, telegramId (string), name, role, isActive, allowlisted, lastLoginAt, activeSessions, createdAt }`.
  `allowlisted: false` — id `ADMIN_TELEGRAM_IDS` da yo‘q: devops qo‘shmaguncha kira olmaydi (ikki kalit).
- Har yozuvda kod majburiy (D-63 (4)). Panel faqat OPERATOR va SUPPORT beradi; OWNER — faqat CLI (`admin:add`,
  `admin:set-role`), OWNER qatorini panel o‘zgartira olmaydi. CLI’da oxirgi faol OWNER’ni o‘chirish (`admin:deactivate`)
  yoki rolini pasaytirish (`admin:set-role`) faqat `--confirm-last-owner` bayrog‘i bilan bajariladi (ogohlantirish bilan;
  o‘g‘irlangan OWNER’ni tez o‘chirish uchun); «oxirgi» deganda faol va `ADMIN_TELEGRAM_IDS` dagi OWNER’lar sanaladi.
  Tiklash — `admin:reactivate`: o‘sha tranzaksiyada qolgan barcha sessiyalari bekor qilinadi, yangi login kerak. Rol har
  qanday o‘zgarsa (pasaysa ham, ko‘tarilsa ham) sessiyalari shu tranzaksiyada bekor qilinadi. Login tasdig‘i sessiyani
  ochishdan oldin `AdminUser` qatorini tranzaksiya ichida `FOR SHARE` bilan qayta o‘qiydi: davom etayotgan o‘chirish yoki
  rol o‘zgarishi tugashini kutadi, admin endi kira olmasa `422 CODE_EXPIRED` beradi va sessiya ochilmaydi. Hammasi
  `ADMIN_UPDATE` audit bilan. `isActive: false` uning sessiyalarini va shu Telegram id’ning ochiq admin login kodlarini
  (`EXPIRED`, soni auditda) shu tranzaksiyada bekor qiladi — reactivate’dan keyin eski kod ishlamaydi; kod berish ham
  `AdminUser` qatorini qulf ostida qayta tekshiradi, o‘chirish bilan poyga bo‘lmaydi. O‘z joriy
  sessiyasini yopsa cookie ham tozalanadi (`currentRevoked: true`). `userAgent` 9-B migratsiyasigacha `null`.
- Panelda OWNER qatoriga `PATCH` → `400 OWNER_ROW`; `POST /admin/admins` dagi band Telegram id → `400 ADMIN_EXISTS`.
  OWNER’ning sessiyalarini panelda yopish mumkin (o‘g‘irlangan sessiyani tez kesish uchun): kod bilan va alert bilan.
  Har admin boshqaruvi amali egalarga `adminAction` alertini yuboradi (ega qarori 2026-11-22).

**Ega CLI’si (D-46) saqlanadi.** 4-bosqichda hamyon va to‘ldirish bo‘yicha ega amallari (`review:credit`, `wallet:adjust`,
`payment:reverse`, kartalar) faqat VPS’dagi CLI orqali edi (`docs/05-PAYMENTS.md` 7- va 9-bo‘limlar). 9-bosqichda yuqoridagi
`users` va `payments` yo‘llari o‘sha servislar ustiga quriladi (9-A, S6), buyurtma va kurs yo‘llari 5-bosqich servislari ustiga
(9-B). CLI va panel bir xil servis, bir xil audit amal nomi va bir xil kunlik limitlarni ishlatadi; `card:add`, review yopish va
`TON_UNMATCHED_RESOLVED` faqat CLI’da qoladi.

**9-bosqichda yo‘q (D-63 (8)):** `mark-delivered` (OPERATOR uchun olib tashlangan; yetkazilganlik faqat OWNER `resolve` orqali),
ta’minotchilar va voucherlar (G-bosqichlar), bonus kodlar, chegirma darajalari va xabar tarqatish (10-bosqich), yangi mahsulot
va rasm yuklash, foydalanuvchiga erkin matnli xabar, Fragment’ga panel orqali qayta kirish.

## Health

`GET /health/live` → `{status:"ok"}` · `GET /health/ready` → `{status, db, redis, worker, fragment}`.
Ikkala yo‘l konvertsiz (D-24) va `no-store`. `/health/ready`: Postgres va Redis ishlasa `200`;
faqat worker yo‘q bo‘lsa ham `200`, lekin `status: "degraded"`, `worker: "down"` (D-30.1: worker
qayta ishga tushganda API balansirovshchikdan chiqarilmaydi). `503` — faqat Postgres yoki Redis
ishlamaganda, tana o‘sha shaklda.
