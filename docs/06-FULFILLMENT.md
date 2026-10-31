# 06 — Yetkazish (fulfillment)

Barchasi `apps/worker`da. Pul tashqariga chiqadigan yagona joy — shuning uchun eng qat'iy qoidalar shu yerda.

## Yetkazish turlari

| Tur           | Foydalanuvchi kiritadi | Adapter                                        | Mahsulotlar                            |
| ------------- | ---------------------- | ---------------------------------------------- | -------------------------------------- |
| `TG_USERNAME` | @username              | `FRAGMENT` (asosiy), `RESELLER_STARS` (zaxira) | Stars, Premium                         |
| `GAME_ID`     | Player ID (+ Zone ID)  | ta'minotchi API                                | PUBG, MLBB, Free Fire, Standoff 2...   |
| `STEAM_LOGIN` | Steam login            | ta'minotchi API                                | Steam balans, CS2                      |
| `VOUCHER`     | —                      | ombor yoki ta'minotchi API                     | Roblox card, Steam card, Discord Nitro |
| `USERNAME`    | o‘yin username         | ta'minotchi API                                | Roblox Robux (to‘g‘ridan-to‘g‘ri)      |

## Adapter interfeysi

```ts
interface FulfillmentAdapter {
  readonly code: string;
  validateRecipient(product: ProductRef, input: Record<string, string>): Promise<RecipientResult>;
  quote(
    product: ProductRef,
    sku: SkuRef,
    qty: number,
  ): Promise<{ currency: 'TON' | 'USDT'; costMinor: bigint; validUntil: Date }>;
  fulfill(ctx: {
    orderId: string;
    attemptNo: number;
    sku: SkuRef;
    qty: number;
    recipient: Recipient;
    maxCostMinor: bigint;
  }): Promise<FulfillResult>;
  getStatus(externalRef: string): Promise<'PENDING' | 'DONE' | 'FAILED' | 'UNKNOWN'>;
  getBalance(): Promise<{ currency: string; amountMinor: bigint }>;
  health(): Promise<'OK' | 'DEGRADED' | 'DOWN'>;
}
```

`ProductRoute` jadvali mahsulot uchun adapterlar tartibini belgilaydi. Router birinchi `health=OK`
adapterni tanlaydi; buyurtma qaysi adapter bilan boshlangan bo‘lsa, noma'lum holatda boshqasiga
**o‘tkazilmaydi** (ikki marta yuborish xavfi).

## Holatlar oqimi

```
PAID → QUEUED → PROCESSING → DELIVERED → REFUNDED     (DELIVERED → REFUNDED: faqat admin, D-23)
                    ├→ FAILED → REFUNDED            (aniq "yuborilmadi")
                    ├→ HELD → QUEUED | FAILED | CANCELLED   (narx oshdi / limit; CANCELLED: faqat admin, D-23)
                    └→ NEEDS_REVIEW → DELIVERED | FAILED   (natija noma'lum, faqat reconcile yoki admin)
PAID/QUEUED/HELD → CANCELLED → REFUNDED             (faqat admin, PROCESSING'dan oldin)
```

Eslatma: `QUOTED` buyurtma holati emas — kotirovka alohida `Quote` modeli; `Order` to‘lov bilan birga `PAID` holatida yaratiladi. O‘tishlar va aktyor (`system` / `reconciler` / `admin`) cheklovlari yagona manbada: `packages/shared/src/order-state.ts`. `NEEDS_REVIEW`dan chiqishni faqat `reconciler` (zanjir yoki yetkazib beruvchi isboti bilan) yoki `admin` bajaradi; oddiy fulfillment processor (`system`) bajara olmaydi — aks holda to‘lovi chiqib ketgan bo‘lishi mumkin buyurtma avtomatik qaytarilib, pul yo‘qolardi. O‘tish jadvali ish vaqtida o‘zgartirib bo‘lmaydigan (deep-freeze) qilingan.

## 1-bosqich mahsulotlari: Telegram Stars va Premium (Fragment + TON)

### Kerakli narsalar

- Alohida Telegram "ish akkaunti" (Fragment'ga kirish uchun) va Fragment KYC.
- TON hamyon (W5) — "issiq" hamyon worker'da, "sovuq" zaxira serverdan tashqarida.
- Hamyonda: USDT (TON tarmog‘ida) va/yoki Toncoin + komissiya uchun Toncoin.

### Oqim (Stars; Premium — `months` bilan xuddi shunday)

1. `validate-recipient`: Fragment `searchStarsRecipient` (`searchPremiumGiftRecipient`) → ism, rasm.
   Premium'da foydalanuvchida allaqachon Premium bo‘lsa → ogohlantirish (`RECIPIENT_HAS_PREMIUM` yoki
   "muddat uzaytiriladi" — Fragment javobiga qarab).
2. `quote`: Fragment narxi (TON/USDT) + joriy kurs → tannarx; ustama bilan narx.
3. `fulfill`:
   - `lock:order:{id}`, urinishlar tekshiruvi (avvalgi `externalRef` bo‘lsa — faqat reconcile);
   - `initBuyStarsRequest` → `req_id`, summa; summa `maxCostMinor` dan oshsa → HELD;
   - limitlar (`TON_MAX_PER_ORDER_NANO`, `TON_MAX_DAILY_NANO`) → oshsa HELD;
   - `getBuyStarsLink` → manzil, summa, payload;
   - `FulfillmentAttempt(SENDING)` yoziladi (manzil, summa, payload hash);
   - `lock:ton-wallet` ostida seqno olinadi, tranzaksiya imzolanadi, external message hash saqlanadi, yuboriladi;
   - tasdiq: hamyon tranzaksiyalarida bizning xabar + Fragment holati → DELIVERED;
   - 3 daqiqada tasdiq yo‘q → NEEDS_REVIEW (reconcile har 10 daqiqada tekshiradi).
4. Fragment API rasmiy emas: har bir javob Zod bilan tekshiriladi; kutilmagan shakl → adapter `DOWN`,
   buyurtmalar zaxira adapterga yo‘naltiriladi (faqat hali yuborilmaganlari), egaga xabar.

### Fragment sessiyasi

- Cookie'lar (`stel_ssid`, `stel_dt`, `stel_token`, `stel_ton_token`) va sahifa `hash` — shifrlangan holda
  `FragmentSession`da; har javobdagi `Set-Cookie` bilan yangilanadi.
- `fragment-keepalive` har 20 daqiqada: sahifa + "login holatidamanmi" tekshiruvi.
- Sessiya o‘lsa: status `DEAD` → Stars/Premium zaxira adapterga o‘tadi → egaga bot orqali
  "Fragment sessiyasi tugadi" + admin paneldagi "Sessiyani yangilash" oqimi.
- Qayta kirish yarim avtomatik: Telegram login tasdig‘ini ega telefonda bosadi; TON proof'ni worker imzolaydi.
- Sessiya qancha yashashi loglanadi (2–3 haftada aniq ma'lumot yig‘iladi).

### Zaxira provayder

`RESELLER_STARS` — Fragment narxi + ~5% bilan ishlaydigan API (masalan, USDT balansli reseller).
Yoqilishi admin sozlamasida; narx ustamasi avtomatik moslanadi (marja pastga tushmasligi uchun).

## Keyingi bosqichlar: o‘yinlar

| Tartib | Mahsulot                                                | Tur                | Ta'minotchi (nomzodlar)               | Eslatma                                       |
| ------ | ------------------------------------------------------- | ------------------ | ------------------------------------- | --------------------------------------------- |
| G1     | PUBG Mobile UC                                          | GAME_ID            | B2B API (FazerCards, WDGZone va h.k.) | Player ID → nik tekshiruvi                    |
| G2     | Mobile Legends                                          | GAME_ID (+zone)    | FazerCards, MooGold, Smile.one        | Region muhim (Global/SNG/RU)                  |
| G3     | Steam balans, CS2                                       | STEAM_LOGIN        | login orqali to‘ldirish API           | Login → profil ko‘rsatiladi; ustama komissiya |
| G4     | Roblox                                                  | VOUCHER / USERNAME | gift card API yoki ombor              | "Gamepass usuli" ishlatilmaydi                |
| G5+    | Free Fire, Standoff 2, Discord Nitro, Honor of Kings... | turlicha           | —                                     | `/add-game` buyrug‘i bilan                    |

Har bir ta'minotchi uchun avval `docs/suppliers/<code>.md` yoziladi (API hujjati, auth, regionlar,
test rejimi, xato kodlari), keyin adapter. Ta'minotchilar egasi tomonidan kichik test buyurtmalar bilan
sinalgandan keyingina yoqiladi.

### Voucher ombori

Kodlar shifrlangan; `FOR UPDATE SKIP LOCKED` bilan band qilinadi; kod faqat DELIVERED'dan keyin ko‘rsatiladi;
katalogda qoldiq soni ("69 ta" / "Tugagan"); kam qolganda egaga xabar.

## Narx sinxronlash

- Fragment narxi: har 5 daqiqada (Stars 1 dona, Premium 3/6/12 oy).
- TON/USDT va USDT/UZS kurslari: har 5 daqiqada (manba admin sozlamasida); kurs > 30 daqiqa eski
  bo‘lsa kotirovka berilmaydi.
- Ta'minotchi narxlari: har soat.

## Limitlar va ogohlantirishlar

| Sozlama                             | Ma'nosi                                                        |
| ----------------------------------- | -------------------------------------------------------------- |
| `TON_MAX_PER_ORDER_NANO`            | bitta buyurtma uchun maksimal                                  |
| `TON_MAX_DAILY_NANO`                | kunlik maksimal                                                |
| `TON_MIN_BALANCE_ALERT_NANO`        | shu chegaradan pastda — ogohlantirish                          |
| `SUPPLIER_MAX_PER_ORDER_MICRO_USDT` | ta'minotchi buyurtmasi maksimal                                |
| `PRICE_TOLERANCE_BPS`               | kotirovkadan keyin tannarx oshishiga ruxsat (masalan 300 = 3%) |

Ogohlantirishlar egaga Telegram orqali: hamyon kam, sessiya o‘ldi, NEEDS_REVIEW paydo bo‘ldi,
navbat 5 daqiqadan ko‘p turib qoldi, ta'minotchi balansi kam.

## Dev va test

- `FULFILLMENT_DRY_RUN=true` (standart): barcha adapterlar simulyator bilan almashadi.
- `TON_NETWORK=testnet` — faqat aniq sozlansa.
- Haqiqiy pul bilan birinchi sinov: ega ruxsati bilan, kichik summa (50 Stars), egasining o‘z akkauntiga.
