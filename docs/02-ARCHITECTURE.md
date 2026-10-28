# 02 — Arxitektura

## Umumiy ko‘rinish

```
                ┌──────────── Telegram ────────────┐
                │  Bot (grammY)     Mini App (/tg) │
                └──────┬──────────────────┬────────┘
                       │ webhook          │ HTTPS (initData → token)
 Brauzer ──HTTPS──► apps/web (Next.js) ───┤
                       │                  ▼
 Admin ───HTTPS──► apps/admin ──────► apps/api (NestJS) ◄── Click / Payme / Uzum / Rahmat (callback)
                                          │   │
                                Postgres ◄┘   └► Redis (kesh, BullMQ, lock'lar)
                                          ▲          │ navbatlar
                                          │          ▼
                                     apps/worker (NestJS, public port yo‘q)
                                          │
              ┌───────────────────────────┼────────────────────────────┐
              ▼                           ▼                            ▼
   fragment.com (Stars/Premium)    TON tarmog‘i (hamyon)     Ta'minotchi API'lari (o‘yinlar)
```

## Monorepo

```
apps/
  api/      REST API, to‘lov callback'lari, bot, admin API
  worker/   yetkazish (Fragment/TON, ta'minotchilar), narx sinxronlash, solishtirish (reconcile)
  web/      landing, web do‘kon, Mini App
  admin/    admin panel
packages/
  shared/   Zod sxemalar, tiplar, money.ts, order-state.ts, brand.ts
  i18n/     uz.json, ru.json
  ui/       dizayn token'lari va komponentlar
```

Prisma sxemasi `apps/api/prisma`da; worker ham shu generatsiya qilingan klientni ishlatadi
(0-bosqichda `packages/db` sifatida ajratish mumkin).

## Nega worker alohida?

- **Kalitlarni izolyatsiya qilish:** TON mnemonic, Fragment cookie'lari va ta'minotchi kalitlari
  faqat worker'da. API buzilsa ham hamyonga yetib bo‘lmaydi.
- Worker'da tashqi port yo‘q; faqat Redis navbati va Postgres orqali gaplashadi.
- Yetkazish sekin va qayta urinishli ish — API so‘rovlarini bloklamasligi kerak.

## API modullari (`apps/api/src/modules`)

| Modul | Vazifa |
|---|---|
| `auth` | Mini App initData, web OTP (bot orqali), refresh, sessiyalar |
| `users` | profil, til, telefon |
| `catalog` | kategoriyalar, mahsulotlar, SKU, input sxemalari, stok |
| `pricing` | kotirovka (quote), FX kurslari, ustama qoidalari |
| `wallet` | ledger, balans, keshbek tangalari |
| `orders` | buyurtma yaratish (balansdan), ro‘yxat, tafsilot, holat oqimi (SSE yoki polling) |
| `recipients` | qabul qiluvchini tekshirish (worker'ga RPC navbati orqali) |
| `payments` | intent, provayder adapterlari, callback'lar, solishtirish |
| `referrals` | havolalar, bog‘lanish, bonus hisoblash |
| `promo` | bonus kodlar, chegirma kodlari |
| `notifications` | bot orqali xabarlar (outbox) |
| `telegram` | bot handlerlari, webhook |
| `admin` | admin auth, rollar, audit, barcha boshqaruv endpointlari |
| `health` | ready/live |

## Worker modullari (`apps/worker/src`)

| Modul | Vazifa |
|---|---|
| `fulfillment` | `fulfill-order` navbati, holat oqimi, adapter router (asosiy + zaxira) |
| `adapters/fragment` | Stars, Premium; sessiya (cookie jar, keep-alive) |
| `adapters/<supplier>` | o‘yin ta'minotchilari (keyingi bosqichlarda) |
| `ton` | hamyon, seqno lock, yuborish, tasdiqlash, balans |
| `recipients` | `validate-recipient` navbati (username/ID tekshiruvi) |
| `pricing-sync` | Fragment narxi, TON/USDT kursi, ta'minotchi narxlari (cron) |
| `reconcile` | NEEDS_REVIEW buyurtmalarni zanjirdan/ta'minotchidan tekshirish, hisobot |
| `alerts` | egaga Telegram ogohlantirishlari (hamyon kam, sessiya o‘ldi, navbat tiqildi) |

## Navbatlar (BullMQ)

| Navbat | jobId | Ishlovchi | Qayta urinish |
|---|---|---|---|
| `fulfill-order` | `orderId` | worker | 5 marta, eksponensial; noma'lum natija → NEEDS_REVIEW |
| `validate-recipient` | `hash(product+input)` | worker | 2 marta, 10 s timeout |
| `price-sync` | cron | worker | — |
| `fragment-keepalive` | cron 20 daq | worker | — |
| `reconcile` | cron 10 daq | worker | — |
| `tg-outbox` | `messageId` | api | 429 → `retry_after` |
| `payment-reconcile` | cron kunlik | api | — |

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

| Kanal | Usul | Sessiya |
|---|---|---|
| Mini App | `initData` HMAC (server) | Bearer token (1 soat), xotirada; muddati tugasa initData qayta yuboriladi |
| Web | bot orqali OTP (6 xona) | httpOnly cookie: access 15 daq + refresh 30 kun (rotatsiya) |
| Admin | alohida OTP (`admin_` deep link) + allowlist + rol | `adm_session` cookie, 8 soat / 1 soat harakatsizlik |

## Deploy (VPS, D-20)

- O‘z VPS'imizda Docker Compose. Konteynerlar: `api` (public), `worker` (public port yo‘q),
  `web` (public), `admin` (alohida subdomen), `postgres`, `redis`.
- Tashqariga faqat reverse proxy (TLS) ochiq; Postgres va Redis faqat ichki tarmoqda.
- Ta'minotchilar IP whitelist so‘rasa, VPS'ning statik IP'si beriladi.
- Domenlar: `ggpin.uz` (landing, web do‘kon, Mini App `/tg`), `api.ggpin.uz`, `admin.ggpin.uz`.
- Har servisning o‘z env'i; worker sirlari faqat worker'da.
- Migratsiya: deploy oldidan `prisma migrate deploy`.
- Monitoring: health endpointlar, worker heartbeat, Telegram ogohlantirishlar, kunlik DB backup.
