# 02 — Arxitektura

## Umumiy ko‘rinish

```
                ┌──────────── Telegram ────────────┐
                │  Bot (grammY)     Mini App (/tg) │
                └──────┬──────────────────┬────────┘
                       │ webhook          │ HTTPS (initData → token)
 Brauzer ──HTTPS──► apps/web (Next.js) ───┤
                       │                  ▼
 Admin ───HTTPS──► apps/admin ──────► apps/api (NestJS)
                                          │   │
                                Postgres ◄┘   └► Redis (kesh, BullMQ, lock'lar)
                                          ▲          │ navbatlar
                                          │          ▼
                                     apps/worker (NestJS, public port yo‘q)
                                          │
              ┌───────────────────────────┼────────────────────────────┐
              ▼                           ▼                            ▼
   fragment.com (Stars/Premium)    TON tarmog‘i (hamyon)     Ta'minotchi API'lari (o‘yinlar)
                                          │
                                          ▼
                      Telegram (MTProto): Humo / Uzcard bank botlari (bank-feed)
```

## Monorepo

```
apps/
  api/      REST API, to‘lov callback'lari, bot, admin API
  worker/   yetkazish (Fragment/TON, ta'minotchilar), bank-feed (P2P to‘lovlar), narx sinxronlash, solishtirish (reconcile)
  web/      landing, web do‘kon, Mini App
  admin/    admin panel
packages/
  shared/   Zod sxemalar, tiplar, money.ts, order-state.ts, brand.ts
  db/       Prisma sxemasi, migratsiyalar, generatsiya qilingan klient
  i18n/     uz.json, ru.json
  ui/       dizayn token'lari va komponentlar
```

Prisma sxemasi `packages/db/prisma/schema.prisma`da (D-22); api va worker bitta generatsiya
qilingan klientni `@repo/db` orqali ishlatadi.

## Nega worker alohida?

- **Kalitlarni izolyatsiya qilish:** TON mnemonic, Fragment cookie'lari va ta'minotchi kalitlari
  faqat worker'da. API buzilsa ham hamyonga yetib bo‘lmaydi. Xuddi shunday bank-feed Telegram foydalanuvchi sessiyasi (`BANK_FEED_*`) ham faqat worker image'ida — uning `bankfeed` rolida.
- **Ikki rol, bitta image (D-76).** Worker image ikki konteynerda ishlaydi, rolini `WORKER_ROLE` belgilaydi (production’da majburiy,
  `all` faqat dev/test): `worker` = `fulfillment` (chiquvchi qiymat: TON hamyon, Fragment, `fulfill-order`, `validate-recipient`,
  `price-sync`, `fragment-keepalive`, `reconcile:orders`) va `bankfeed` = `bankfeed` (kiruvchi qiymat: bank-feed tinglovchisi,
  `bank-message`, `card-limit`, `topup-expire`, `payment-reconcile`). Har rol faqat o‘z Nest modullarini quradi
  (`apps/worker/src/worker-role-modules.ts`), boshqa rolning sirlarini boot’da rad etadi va o‘z heartbeat kalitini yozadi
  (`worker:heartbeat` / `bankfeed:process-heartbeat`). Batafsil: `deploy/COMPOSE.md` «Roles».
- Worker'da tashqi port yo‘q; faqat Redis navbati va Postgres orqali gaplashadi.
- Yetkazish sekin va qayta urinishli ish — API so‘rovlarini bloklamasligi kerak.

## API modullari (`apps/api/src/modules`)

| Modul           | Vazifa                                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------- |
| `auth`          | Mini App initData, web OTP (bot orqali), refresh, sessiyalar                                                  |
| `users`         | profil, til, telefon                                                                                          |
| `catalog`       | kategoriyalar, mahsulotlar, SKU, input sxemalari, stok                                                        |
| `pricing`       | kotirovka (quote), FX kurslari, ustama qoidalari                                                              |
| `wallet`        | ledger, balans, keshbek tangalari                                                                             |
| `orders`        | buyurtma yaratish (balansdan), ro‘yxat, tafsilot, holat oqimi (SSE yoki polling)                              |
| `recipients`    | qabul qiluvchini tekshirish (worker'ga RPC navbati orqali)                                                    |
| `payments`      | P2P to‘ldirish so‘rovi, karta puli, havola tokeni, tekshiruv navbati (provayder adapterlari — keyinroq, D-04) |
| `referrals`     | havolalar, bog‘lanish, bonus hisoblash                                                                        |
| `promo`         | bonus kodlar, chegirma kodlari                                                                                |
| `notifications` | bot orqali xabarlar (outbox)                                                                                  |
| `telegram`      | bot handlerlari, webhook                                                                                      |
| `admin`         | admin auth, rollar, audit, barcha boshqaruv endpointlari                                                      |
| `health`        | ready/live                                                                                                    |

## Worker modullari (`apps/worker/src`)

| Modul                 | Vazifa                                                                                                                                                                                                            |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fulfillment`         | `fulfill-order` navbati, holat oqimi, adapter router (asosiy + zaxira)                                                                                                                                            |
| `adapters/fragment`   | Stars, Premium; sessiya (cookie jar, keep-alive)                                                                                                                                                                  |
| `adapters/<supplier>` | o‘yin ta'minotchilari (keyingi bosqichlarda)                                                                                                                                                                      |
| `ton`                 | hamyon, seqno lock, yuborish, tasdiqlash, balans                                                                                                                                                                  |
| `recipients`          | `validate-recipient` navbati (username/ID tekshiruvi)                                                                                                                                                             |
| `pricing-sync`        | Fragment narxi, TON/USDT kursi, ta'minotchi narxlari (cron)                                                                                                                                                       |
| `reconcile`           | buyurtma reconciler'i (`reconcile:orders`: TON transferlari, NEEDS_REVIEW, HELD, kech zanjir faktlari, yo‘qolgan effektlar; docs/06 «5-faza S9»); kunlik `payment-reconcile` (bank xabarlari tarixini qayta skan) |
| `bank-feed`           | MTProto tinglovchi (Humo/Uzcard botlari), parserlar, `bank-message` ishlovchisi (moslashtirish + TOPUP), `topup-expire`, `notify` job'lari                                                                        |
| `alerts`              | egaga Telegram ogohlantirishlari (hamyon kam, sessiya o‘ldi, navbat tiqildi)                                                                                                                                      |

## Navbatlar (BullMQ)

| Navbat               | jobId                                                                             | Ishlovchi | Qayta urinish                                                                    |
| -------------------- | --------------------------------------------------------------------------------- | --------- | -------------------------------------------------------------------------------- |
| `fulfill-order`      | `orderId`                                                                         | worker    | 5 marta, eksponensial; noma'lum natija → NEEDS_REVIEW                            |
| `validate-recipient` | `vr-sha256(product + normallashgan input + 60 s oyna)` (D-61)                     | worker    | 1 marta, API 10 s kutadi; limiter 1/s, concurrency 10 (D-61)                     |
| `price-sync`         | cron                                                                              | worker    | —                                                                                |
| `fragment-keepalive` | cron 20 daq                                                                       | worker    | —                                                                                |
| `reconcile`          | scheduler id `reconcile:orders` (har `ORDER_RECONCILE_EVERY_MS`, standart 10 daq) | worker    | —                                                                                |
| `bank-message`       | `bm-<BankMessage.id>`                                                             | bankfeed  | 5 marta, eksponensial 2 s; concurrency 1 (zanjir tartibi)                        |
| `card-limit`         | `cl-<BankMessage.id>`                                                             | bankfeed  | 8 marta, eksponensial 2 s; tugasa alert `limitCheckFailed`                       |
| `topup-expire`       | cron har 1 daq                                                                    | bankfeed  | —                                                                                |
| `notify`             | `topup-<paymentId>`, `alert-<kind>-<refId>`                                       | api       | 5 marta, eksponensial 2 s; payload faqat id'lar, matnni API render qiladi        |
| `tg-outbox`          | `messageId`                                                                       | api       | 429 → `retry_after`                                                              |
| `payment-reconcile`  | cron 03:00 Asia/Tashkent                                                          | bankfeed  | 3 marta, eksponensial 60 s, keyin alert `reconcileFailed`; MTProto → api'da emas |
| ↳ `bank-text-purge`  | cron 03:30 Asia/Tashkent (shu navbat)                                             | bankfeed  | 3 marta; xom matn `text = NULL` partiyalab, alert yo‘q (`purgeOverdue`)          |

## Asosiy oqim: Stars xaridi

1. Mini App → `POST /recipients/validate {productId, input}` → API navbatga qo‘yadi → worker
   Fragment'dan qidiradi → ism/rasm qaytadi (API kutadi, 10 s gacha).
2. Mini App → `POST /quotes {skuId | quantity, recipientToken}` → narx, 10 daqiqa.
3. Mini App → `POST /orders {quoteId}` + `Idempotency-Key` → bitta tranzaksiyada: hamyon qulfi,
   balans tekshiruvi, `Order(PAID)` + `LedgerEntry(PURCHASE)` → commit → `fulfill-order` navbati.
4. Worker: qulf → urinishlar tekshiruvi → narxni qayta tekshirish → limitlar → Fragment init →
   TON tranzaksiya imzosi va yuborish → tasdiq → `DELIVERED`.
5. API → bot orqali xabar; Mini App holatni polling/SSE bilan ko‘radi.

## Autentifikatsiya

| Kanal    | Usul                                               | Sessiya                                                                   |
| -------- | -------------------------------------------------- | ------------------------------------------------------------------------- |
| Mini App | `initData` HMAC (server)                           | Bearer token (1 soat), xotirada; muddati tugasa initData qayta yuboriladi |
| Web      | bot orqali OTP (6 xona)                            | httpOnly cookie: access 15 daq + refresh 30 kun (rotatsiya)               |
| Admin    | alohida OTP (`admin_` deep link) + allowlist + rol | `adm_session` cookie, 8 soat / 1 soat harakatsizlik                       |

## Deploy (VPS, D-20)

- O‘z VPS'imizda Docker Compose. Konteynerlar: `api` (public), `worker` va `bankfeed` (bitta worker image, ikki rol,
  public port yo‘q), `web` (public), `admin` (alohida subdomen), `postgres`, `redis`; `migrate` — bir martalik deploy qadami.
- Tashqariga faqat reverse proxy (TLS) ochiq; Postgres va Redis faqat ichki tarmoqda.
- Ta'minotchilar IP whitelist so‘rasa, VPS'ning statik IP'si beriladi.
- Domenlar: `ggpin.uz` (landing, web do‘kon, Mini App `/tg`), `api.ggpin.uz`, `admin.ggpin.uz`.
- Har servisning o‘z env'i; hamyon/Fragment sirlari faqat `worker`da, bank-feed sessiyasi va kaliti faqat `bankfeed`da.
- Migratsiya: deploy oldidan `prisma migrate deploy`.
- Monitoring: health endpointlar, worker heartbeat, Telegram ogohlantirishlar, kunlik DB backup.
