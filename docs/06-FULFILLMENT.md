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

- Fragment’ga kirish bank-feed ishchi akkaunti orqali (D-58): faqat brauzerda Telegram login; akkauntga yangi qurilma ulanmaydi, aks holda bank-feed `newAuthorization` himoyasi barcha kartalarda avtomatik yozishni to‘xtatadi. Fragment KYC.
- TON hamyon (W5) — "issiq" hamyon worker'da, "sovuq" zaxira serverdan tashqarida.
- Hamyonda: USDT (TON tarmog‘ida) va/yoki Toncoin + komissiya uchun Toncoin.

### Oqim (Stars; Premium — `months` bilan xuddi shunday)

1. `validate-recipient`: Fragment `searchStarsRecipient` (`searchPremiumGiftRecipient`) → ism, rasm.
   Premium'da foydalanuvchida allaqachon Premium bo‘lsa: adapter `REFUSED` (`HAS_PREMIUM`) → API `422 RECIPIENT_HAS_PREMIUM`, token yo‘q;
   yoki `FOUND` + `notices: ['PREMIUM_EXTENDS']` → API `warnings[]` da `PREMIUM_EXTENDS` ("muddat uzaytiriladi"), token beriladi.
   Qaysi biri chiqishi Fragment javobiga bog‘liq; haqiqiy javob hali yozib olinmagan (pastdagi «Premium»).
2. `quote`: Fragment narxi (TON/USDT) + joriy kurs → tannarx; ustama bilan narx.
3. `fulfill`:
   - `lock:order:{id}`, urinishlar tekshiruvi (avvalgi `externalRef` bo‘lsa — faqat reconcile);
   - `initBuyStarsRequest` → `req_id`, summa; summa `maxCostMinor` dan oshsa → HELD;
   - limitlar (`TON_MAX_PER_ORDER_NANO`, `TON_MAX_DAILY_NANO`) → oshsa HELD;
   - `getBuyStarsLink` → manzil, summa, payload;
   - `FulfillmentAttempt(SENDING)` yoziladi (manzil, summa, payload hash);
   - `lock:ton-wallet` ostida seqno olinadi, tranzaksiya imzolanadi, external message hash saqlanadi, yuboriladi;
   - tasdiq: hamyon tranzaksiyalarida bizning xabar + Fragment holati → DELIVERED;
   - `TON_CONFIRM_TIMEOUT_MS` (standart 5 daqiqa) ichida tasdiq yo‘q → NEEDS_REVIEW (reconcile har 10 daqiqada tekshiradi).
4. Fragment API rasmiy emas: har bir javob Zod bilan tekshiriladi; kutilmagan shakl → adapter `DOWN`,
   buyurtmalar zaxira adapterga yo‘naltiriladi (faqat hali yuborilmaganlari), egaga xabar.

### Premium (6-bosqich)

- **Mahsulot turi slug bo‘yicha:** `fragmentProductKind(slug)` (`packages/shared/src/fulfillment/fragment-product.ts`) faqat `telegram-stars`
  (`STARS`) va `telegram-premium` (`PREMIUM`) ni biladi, boshqa slug uchun `null`. Slug admin panelda o‘zgarmaydi, shuning uchun sxema
  o‘zgarmadi (ega qarori Q4).
- **Oylar:** Premium paketi — 3, 6 yoki 12 oy (`PREMIUM_MONTHS`); `order.quantity` = oylar. Boshqa uzunlikdagi Premium SKU narxlanmaydi
  va to‘lanmaydi (fail-closed).
- **Qabul qiluvchi Premium’ni oldin olgan** (`validate-recipient`): `REFUSED { reason: 'HAS_PREMIUM' }` (maydon `providerRef`/ism yo‘q,
  `strict`) → API `422 RECIPIENT_HAS_PREMIUM`; yoki `FOUND.notices = ['PREMIUM_EXTENDS']` (ko‘pi bilan 4 ta) → `warnings[]`.
  `REFUSED` javobi ham `FOUND`/`NOT_FOUND` kabi 60 soniyalik oyna ichida qayta ishlatiladi.
- **`RECIPIENT_REFUSED`** (`PrepareResult`): qabul qiluvchi tekshirilgan, lekin endi mahsulotni qabul qila olmaydi (kotirovkadan keyin
  Premium paydo bo‘ldi, Fragment sovg‘ani rad etadi). Bu `prepare` da ham, boshqa adapter qayta tekshiruvida (`REFUSED` javobi) ham
  bir xil ishlaydi: yangi urinish **SENDING dan oldin** → buyurtma `FAILED` + `REFUND`, sabab `RECIPIENT_GONE` (DB CHECK yangi sabab
  qo‘shishga migratsiyasiz ruxsat bermaydi, ega qarori Q2 = A), voqea izohida `failed: RECIPIENT_GONE (the recipient can no longer
receive the product, e.g. Telegram Premium appeared after the quote); nothing was sent`. Urinish yozilmaydi, zanjirga hech narsa
  chiqmaydi, `REFUND` — yagona yo‘l orqali (`ORDER/<orderId>`), qayta ishga tushirish hech narsani o‘zgartirmaydi. Logda qayd
  belgisi bor, qabul qiluvchi ma’lumoti yo‘q. Mijozga boshqa refundlardagidek «bajarilmadi, pul qaytarildi» xabari boradi.
- **Ikki xil «noma’lum» — farqlang:**
  - Fragment `prepare` da yetib bo‘lmasa (timeout, tarmoq xatosi; dry-run’da `UNKNOWN`/`TIMEOUT` ssenariysi) → job qayta uriniladi,
    oxirgi urinishda buyurtma `HELD` `ADAPTER_ERROR`. Hech narsa yuborilmagan, shuning uchun `NEEDS_REVIEW` emas;
  - **TON natijasi noma’lum** (to‘lov yuborilgan, tasdiq yo‘q) → `NEEDS_REVIEW` (`CONFIRM_TIMEOUT`), refund yo‘q, faqat reconcile yoki
    admin isboti bilan chiqadi (yuqoridagi 3-band va 4-invariant).
- **Taxminlar (fixture yo‘q, P6-S3):** `show_sender` qiymati va «Premium gift» xabarida yuboruvchi qanday ko‘rinishi; haqiqiy
  `searchPremiumGiftRecipient` / `initGiftPremiumRequest` / `getGiftPremiumLink` maydonlari; «Premium bor» javobi (rad yoki uzaytirish);
  Premium to‘lov manzili (reja bo‘yicha `FRAGMENT_PAY_ADDRESSES` da, Stars bilan bir ro‘yxatda). Hammasi `docs/suppliers/fragment.md` §6
  da `taxmin`. Haqiqiy adapter `fragmentProductKind(slug) === null` va oy ∉ {3, 6, 12} holatlarida `REFUSED` (HELD) qaytarishi shart;
  dry-run simulyatoridagi «noma’lum slug = Stars» xatti-harakati ko‘chirilmaydi.
- **Simulyator (faqat dry-run):** qarang «Simulyator username shakllari» va «Simulyator (dry-run)» bo‘limlari.

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

**Qayerda.** `apps/worker/src/pricing-sync/`. `price-sync` navbatida ikkita job: `fx` (kurslar) va
`cost` (tannarx). Ular BullMQ job scheduler orqali har `PRICE_SYNC_EVERY_MS` (5 daqiqa) ishlaydi;
scheduler idʼlari doimiy (`price-sync:fx`, `price-sync:cost`), shuning uchun worker necha marta qayta
ishga tushmasin, schedulerlar soni 2 ta qoladi. Worker ishga tushganda har bir job bir marta darhol
ishlaydi. Yozuvlar faqat qo‘shiladi: `FxRate` va `CostSnapshot` o‘zgartirilmaydi (UPDATE trigger
bilan taqiqlangan), har bir yangilanish — yangi qator.

**Kurslar (`fx`).** Manbadan faqat `USDT_UZS` va `TON_USDT` olinadi. Har bir kurs tekshiriladi
(musbat o‘nlik qator, ko‘pi bilan 18 xona; bir juftlik ikki marta kelsa — yozilmaydi). Keyin
**sakrash himoyasi**: yangi kurs shu juftlikning oxirgi saqlangan kursidan `FX_MAX_JUMP_BPS`
(1000 bps = 10%) dan ko‘proq farq qilsa (yuqoriga ham, pastga ham), u yozilmaydi va warn log
yoziladi (juftlik, oxirgi qator idʼsi, ikkala kurs — kurs maxfiy maʼlumot emas). Aynan 10% ruxsat
etiladi. Taqqoslash `packages/shared` pul funksiyalari bilan, BigIntʼda qilinadi (float yo‘q).
Taqqoslanadigan "oxirgi kurs" — sync soatidan ko‘pi bilan 1 daqiqa (`MAX_CLOCK_SKEW_MS`) kelajakdagi
qatorlar ichidan eng yangisi; undan uzoqroq kelajakdagi xato qator taqqoslash tayanchi bo‘lmaydi
va to‘g‘ri kursni to‘sa olmaydi — lekin faqat real vaqt uning `createdAt` iga yetguncha. `createdAt` ni
yozayotgan jarayonning soati qo‘yadi (Prisma `now()` = `new Date()`), DB uni tekshirmaydi: soati
oldinga ketgan server yozgan qator vaqti kelganda oddiy "oxirgi kurs" bo‘lib qoladi. Haqiqiy kurs
manbasidan oldin buni DB soati hal qilishi majburiy (D-35 (g)).
Sakrash odatda manba xatosi (raqam tushib qolgan, eski kesh, buzilgan manba) belgisidir: noto‘g‘ri
narxda sotgandan ko‘ra, 30 daqiqadan keyin kotirovkani to‘xtatgan yaxshi. Haqiqiy kurs 10% dan
ko‘p o‘zgargan bo‘lsa, bu holatdan chiqish uchun kursni qo‘lda kiritish kerak bo‘ladi (admin
panel — keyingi fazalar).

**Hosila kurs `TON_UZS`.** Manbadan olinmaydi: `TON_UZS = multiplyRates(TON_USDT, USDT_UZS, 'up')`
— 18-xonada yuqoriga yaxlitlanadi (tannarx uchun ishlatiladi, kam hisoblamaslik kerak).
`source = 'derived:<TON_USDT id>*<USDT_UZS id>'`. U faqat ikkala ota-kurs **shu ishga tushishda**
yozilgan bo‘lsagina yoziladi (bittasi sakrash himoyasida to‘xtasa — `TON_UZS` ham yozilmaydi), uchala
qator bitta tranzaksiyada saqlanadi. Shunday qilib yangi kurs eski kurs bilan aralashmaydi.

**Tannarx (`cost`).** Har bir **faol** mahsulot uchun yoqilgan (`isEnabled`) route’lardan
(`priority` bo‘yicha) adapteri **sog‘lom** bo‘lgan birinchisi olinadi (5-faza S7 M2, router’ning
5 s health keshi); sog‘lomi bo‘lmasa — avvalgidek birinchi yoqilgan route. O‘sha adapterning narx
manbasi bo‘lsa — `CostSnapshot` yoziladi (masalan `FRAGMENT` — TON; dry-run’da Fragment o‘lsa
`RESELLER_STARS` simulyatori — USDT, faqat erkin miqdorli mahsulot). Health tebranishi yangi
quote’lar valyutasini almashtirib turishi mumkin — qabul qilingan: har quote o‘z snapshot’ini
saqlaydi, buyurtma faqat o‘z valyutasidagi adapterga beriladi. Production’da registr bo‘sh
(haqiqiy adapterlar S8 da, zaxira yo‘q — Q20), shuning uchun u yerda hech narsa o‘zgarmadi.

Erkin miqdorli mahsulot (Stars, `allowCustomQty`): bitta mahsulot
darajasidagi qator (`skuId` NULL, `basisQuantity` 1, 1 dona narxi). Tayyor paketli mahsulot
(Premium): har bir faol SKU uchun bitta qator (`basisQuantity` = SKU miqdori, yaʼni oylar).
Nofaol mahsulot, nofaol SKU va tanlangan route’ining narx manbasi yo‘q mahsulot o‘tkazib yuboriladi.
Bu qoida har qanday manba uchun majburiy (`cost-sync.service.ts` `lineProblem`, warn log bilan):
erkin miqdorli mahsulotning paket darajasidagi qatori ham, tayyor paketli mahsulotning mahsulot
darajasidagi qatori ham yozilmaydi. Aks holda paket o‘lchamidagi miqdor paket tannarxida, bir dona
ko‘pi esa dona tannarxida narxlanib, ko‘proq miqdor arzonroq chiqishi mumkin edi.

**Simulyator.** 3-fazada haqiqiy kurs manbai ham, Fragment narxini olish ham yo‘q (ega javobi Q6):
faqat `FxSource` / `CostSource` interfeyslari va simulyatorlar. Simulyator qiymatlari soxta, doimiy
va hech qayerdan olinmaydi: `USDT_UZS = 12650`, `TON_USDT = 3.2` (demak `TON_UZS = 40480`);
1 Star = 0,0047 TON; Premium 3 oy = 3,75 TON, 6 oy = 5 TON, 12 oy = 9,1 TON
(`apps/worker/src/pricing-sync/fx-sources/simulated-fx.source.ts`,
`apps/worker/src/adapters/simulator/simulated-fragment-prices.ts`). Qatorlarda `source = 'simulator'`;
API `simulator` va undan hosil bo‘lgan kurslar bilan faqat `PRICING_ALLOW_SIMULATED=true` va
production bo‘lmagan muhitda narx beradi (Q15, 2026-11-04 da kuchaytirilgan — pastdagi "API
qatorlarni qanday tanlaydi").
Belgi manba nomidan emas, `simulated` bayrog‘idan olinadi: soxta (`simulated: true`) manba nomi
qanday bo‘lmasin, uning qatorlari doim `source = 'simulator'` (`packages/shared`dagi
`SIMULATOR_SOURCE`) bilan yoziladi. Haqiqiy manba `simulator` nomini, `derived:` bilan boshlanuvchi
yoki bo‘sh nomni ololmaydi — bunday manba rad etiladi (bitta error log, hech narsa yozilmaydi).

**Dry-run o‘chiq bo‘lsa — yopiq holatda to‘xtaydi.** Simulyator faqat `FULFILLMENT_DRY_RUN=true`
bo‘lganda ishlatiladi (tekshiruv sync servislarining ichida). `FULFILLMENT_DRY_RUN=false` bo‘lsa,
haqiqiy manba hali yo‘q: har bir ishga tushishda bitta error log yoziladi va hech narsa
yozilmaydi. Natijada oxirgi kurs/tannarx 30 daqiqa (`FX_MAX_AGE_MS`, `COST_MAX_AGE_MS`) eskirgach,
API kotirovka bermaydi (`503 PRICE_UNAVAILABLE`) — soxta narx bilan sotishdan ko‘ra sotmagan yaxshi.
Worker hech qanday tarmoq xizmatiga (birja, Fragment, TON) murojaat qilmaydi.

**API qatorlarni qanday tanlaydi** (`apps/api/src/modules/pricing/`). Katalog narxi ham, kotirovka
ham bir xil qoida bilan tanlanadi, shuning uchun mijoz ko‘rgan narx — to‘laydigan narx.
Erkin miqdorli mahsulot: paketning o‘z tannarxi (`skuId` bilan) yangi bo‘lsa — u; eskirgan bo‘lsa —
mahsulot darajasidagi yangi tannarx miqdorga ko‘paytiriladi; ikkalasi ham bo‘lmasa narx yo‘q.
Tayyor paketli mahsulot faqat paketning o‘z tannarxidan narxlanadi: mahsulot darajasidagi qator
so‘ralmaydi ham (worker uni yozmaydi; so‘rov esa butun tarixni o‘qir edi). Worker soati biroz oldinda
bo‘lishi mumkin, shuning uchun 1 daqiqagacha kelajakdagi qator qabul qilinadi (`MAX_CLOCK_SKEW_MS`);
undan uzoqroq kelajakdagi qator xato yozuv hisoblanadi va real vaqt uning `createdAt` iga yetguncha
o‘qilmaydi — shu vaqtgacha u "eng yangi" bo‘lib to‘g‘ri kursni yashira olmaydi (keyin — D-35 (g)). Simulyator qatorlari (`source = 'simulator'`, hamda ulardan hosil bo‘lgan `derived:`
TON_UZS) bilan API faqat ikki shart birga bajarilsa narx beradi: `PRICING_ALLOW_SIMULATED=true` **va**
`NODE_ENV` production emas. `PRICING_ALLOW_SIMULATED` standart `false`; production'da `true` bo‘lsa API ishga
tushmaydi. `derived:` TON_UZS faqat ikki **turli** ota qatordan iborat bo‘lsa haqiqiy hisoblanadi: birinchisi `TON_USDT`,
ikkinchisi `USDT_UZS`, ikkalasi ham `simulator` ham, `derived:` ham emas; aks holat (`derived:X*X`, almashgan tartib,
yo‘q ota qator) simulyator sifatida rad etiladi. Paket tannarxidan mahsulot tannarxiga o‘tish zarar keltirmaydi:
yetkazishda haqiqiy tannarx `maxCost` dan oshsa buyurtma `HELD` bo‘ladi.

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

Worker egaga bevosita yozmaydi: unda `TELEGRAM_BOT_TOKEN` yo‘q (u faqat api envʼda). Ogohlantirish
APIʼning `tg-outbox` navbatiga job sifatida qo‘yiladi va xabarni APIʼdagi bot yuboradi.

## Phase 5 majburiy talablari (fulfill-order va holat mashinasi)

Quyidagilar 1-fazada ataylab bajarilmagan; ularsiz `fulfill-order` processori tayyor hisoblanmaydi.

**Navbatga qo‘yishdagi poyga.** `FulfillOrderEnqueuer` (`jobId = orderId`) faqat tugagan
(completed/failed) jobni almashtiradi. `active` holat har doim ham haqiqiy dublikat emas: oldingi
run hali tugamayotgan paytda yangi enqueue kelishi mumkin (masalan, HELDʼni QUEUEDʼga qaytargan
job hali completed deb belgilanmagan). Bunday enqueue `keep` qilinadi (tashlanadi) va buyurtma
QUEUEDʼda qolib ketishi mumkin. Shuning uchun uchta himoya shart:

1. Processor har bir run oxirida buyurtma holatini qayta o‘qiydi; hamon `QUEUED` bo‘lsa — o‘zini
   qayta navbatga qo‘yadi (enqueuer orqali).
2. Reconcile sweep: `QUEUED` holatida N daqiqadan ortiq turgan va navbatda waiting/delayed/active
   jobi yo‘q buyurtmalarni qayta navbatga qo‘yadi.
3. Worker ham xuddi shu enqueuerʼdan foydalanadi (`packages/shared` mantig‘i); `fulfill-order`
   navbatiga oddiy `queue.add` hech qachon ishlatilmaydi.

**NEEDS_REVIEWʼdan chiqish isboti.** Holat mashinasi (`packages/shared/src/order-state.ts`)
`NEEDS_REVIEW` dan chiqishni faqat tegishli tranzitsiya orqali ruxsat etadi, lekin isbotni
tekshirmaydi. Phase 5ʼda chiqish "isbot obyekti" talab qilsin: TON tranzaksiya xeshi yoki
Fragment/taʼminotchi holati (to‘lov chiqmaganiga yoki chiqqaniga dalil), kim va nima uchun
tasdiqlagani; isbotsiz `NEEDS_REVIEW → DELIVERED` va `NEEDS_REVIEW → FAILED` o‘tishlari (FAILED pulni
qaytaradi) bajarilmaydi.

**Marshrut va tannarx chegarasi (3-faza review M4, I4; 5-faza S1).**

- Buyurtma qaysi adapter tannarxidan narxlanganini sxemadan biladi, yangi ustunsiz: `Order.quoteId` → `Quote.costSnapshotId` → `CostSnapshot.adapter`
  (`CostSnapshot` o‘zgarmas). `Order.costCurrency` va `maxCostMinor` shu adapter valyutasida. Router tanlagan adapterning valyutasi `Order.costCurrency` dan
  farq qilsa (masalan Fragment o‘lib USDT'li `RESELLER_STARS` tanlansa), adapter bu buyurtma uchun yaroqsiz: buyurtma HELD (`NO_ADAPTER`). 5-bosqichda
  valyutalararo solishtirish yo‘q: buyurtmada bitta `fxRateId` (bitta juftlik) bor, u boshqa valyutani halol konvertatsiya qila olmaydi. `exceedsCostCeiling`
  valyuta farq qilsa xato tashlaydi. **S4 shuni tekshiradi** (test: adapter farqi + valyuta farqi).
- Tannarx chegarasining yagona manbai — buyurtmada saqlangan `maxCostMinor` (`StoredCostCeiling`, `exceedsCostCeiling` — `packages/shared`). U kotirovka berilganda
  bir marta `maxCostFor` bilan hisoblanadi. Worker `PRICE_TOLERANCE_BPS` ni **o‘qimaydi** va chegarani qayta hisoblamaydi (S4: worker env’idan o‘chiriladi yoki
  ishlatilmaydi). Chegaraga teng to‘lov ruxsat, bir birlik ortiq — HELD (`PRICE_ABOVE_MAX`).
- Kotirovka yangiligi (FX/tannarx 30 daqiqagacha eski bo‘lishi mumkin) faqat kotirovka berilganda tekshiriladi; `POST /orders` uni qayta tekshirmaydi (N3).
  Eskirish xavfini `maxCostMinor` dagi tolerantlik cheklaydi.

**Qabul qiluvchi `providerRef`'i (audit L4).** Token yozuvida `providerRef` majburiy (yo‘q bo‘lsa token o‘qilmaydi). Yetkazishda `providerRef` bo‘lmagan
buyurtma tekshirib bo‘lmaydi: adapter `prepare` da `RECIPIENT_GONE` qaytaradi (`hasProviderRef`), buyurtma FAILED + REFUND bo‘ladi; tekshiruvsiz to‘lov hech qachon.
Saqlash joyi (ega qarori R3, 2026-11-12): `Quote.providerRef` va `Order.providerRef` (`String?`, ikkalasi o‘zgarmas: INSERT paytida yoziladi, keyin DB trigger'i NULL → qiymatni
ham, qiymat → boshqasini ham rad etadi). S2: kotirovka yaratilganda token yozuvidagi `providerRef` `Quote.providerRef` ga yoziladi (`Quote.recipient` — strict `RecipientSchema` — ichiga
**kirmaydi**); buyurtma yaratilganda quote'dan `Order.providerRef` ga ko‘chiriladi. DB INSERT qo‘riqchisi buni majburlaydi (Y6, Z4): buyurtmaning `userId`, `productId`, `skuId`, `quantity`, `recipient`, `providerRef`, `priceTiyin`, `costCurrency`, `costMinor`, `maxCostMinor`, `fxRateId` i kotirovkaniki bilan teng bo‘lmasa buyurtma yaratilmaydi (`GG001`): boshqa foydalanuvchi kotirovkasi bilan yoki boshqa narxda buyurtma ochib bo‘lmaydi, to‘lov mijoz tasdiqlagan odamdan boshqasiga ketmaydi. `Quote` da chegirma summasi ustuni yo‘q (faqat `discountCodeId`): kotirovkada chegirma kodi bo‘lmasa buyurtmaning `discountTiyin` i 0 bo‘lishi shart (`GG001`); kod bo‘lganda summa qanday bog‘lanishi chegirma kodlari bilan (10-bosqich) hal qilinadi. Muddati o‘tgan kotirovkadan (hatto ishlatilmagan bo‘lsa ham) buyurtma yaratilmaydi (`GG001`, R4-3): bu zaxira, xarid yo‘li muddatni o‘zi oldin tekshiradi va kotirovkani o‘sha tranzaksiyada ishlatilgan deb belgilaydi. **S2 mezoni:** `POST /orders` ikkalasini kotirovkadan ko‘chiradi, mijozdan olmaydi. Bu ichki maydon: hech qanday API javobiga va logga chiqmaydi (`quote.mapper.ts` uni tanlamaydi;
`docs/04` o‘zgarmaydi). `NULL` — shu maydon paydo bo‘lishidan oldingi yozuv: yetkazish uni `RECIPIENT_GONE` bilan rad etadi.

**Kuzatuv: `notify` va deploy tartibi (review F10, audit L2).** `ORDER_*` kindlari va fulfillment alertlari `notify` navbatiga tushganda API konsumeri hozircha
`UnrecoverableError` bilan rad etadi (jim «yuborildi» emas; `error` darajasida log). Shuning uchun deploy tartibi: **avval API (S6: konsumer va renderer'lar), keyin
worker producer'lari** (S4/S5/S7/S9). Teskari tartibda xabarlar `failed` to‘plamida 7 kun turadi va `notify` job id dedupe'i (30 kun) tufayli keyin qayta
qo‘shilmaydi. **Tiklash (L2):** teskari tartib bo‘lib qolsa (NEEDS_REVIEW va boshqa `ORDER_*` xabarlari `failed` to‘plamida qolsa), ularni tiklash — shu `failed`
to‘plamidan **retry** (BullMQ `retryJobs`), qayta `add` emas: bir xil `jobId` dedupe'i qayta qo‘shishni jim tashlaydi. Tiklash buyurtma holatini o‘zgartirmaydi, faqat xabarni yetkazadi.

## 5-faza S1: to‘lov yo‘li invariantlari (ikkinchi tuzatish raundi)

Bu bo‘lim DB qo‘riqchilari (migratsiya 10) va `@repo/db` yordamchilari bilan birga o‘qiladi (`docs/03`). Talablar S4/S5/S9/S10 uchun.

**Qulf tartibi (R8).** Hamma joyda bir xil: **(`AdminUser` → ) hamyon → buyurtma qatori → urinish → transfer.** `AdminUser` qatori faqat `resolveNeedsReview` da, `type: 'ADMIN'` resolver uchun, **birinchi** qulf sifatida `SELECT ... FOR SHARE` bilan olinadi (N3: parallel `UPDATE "AdminUser"` — rolni pasaytirish yoki o‘chirish — resolve commit bo‘lguncha kutadi, avval commit bo‘lgan pasaytirish esa `OWNER_REQUIRED` beradi); undan keyingi qulflar mavjud tartibda, shuning uchun yangi deadlock yo‘li yo‘q (`AdminUser` boshqa joyda payout qulflaridan keyin olinmaydi). Yordamchilar (`transitionOrder`, `refundFailedOrder`, `failAndRefundOrder`, `resolveNeedsReview`),
SQL qo‘riqchilari va worker. Hamyon qulfi faqat pul harakatlanganda (FAILED, CANCELLED, REFUNDED). Tartibni buzgan tranzaksiya deadlock berishi mumkin: Postgres birini to‘xtatadi
(xavfsiz, lekin qasddan chaqirilmaydi). **Istisno (R4-1):** BOUNCED qo‘riqchisi transfer qatorini yangilagandan keyin buyurtmani `FOR SHARE` bilan o‘qiydi, ya’ni teskari tartibda. Shuning uchun transferni `BOUNCED` ga o‘tkazadigan kod (S9 klassifikatori) undan oldin `lockOrderRow` oladi, 40P01 (deadlock) da butun tranzaksiyani qayta urinadi va 40P01 ni «noma’lum natija» deb hisoblamaydi: to‘xtatilgan tranzaksiya to‘liq rollback bo‘ladi, hech narsa yozilmaydi.

**Yuborishdan oldin worker nimani qayta tekshiradi (S5, reja 6.4/6.5; audit N1, review R1).** Worker to‘xtab, operator buyurtmani FAILED qilib REFUND bergandan keyin uyg‘onishi mumkin.
DB shunday to‘lovni to‘xtatadi (urinish faqat `PROCESSING` buyurtmaga `SENDING` bilan tug‘iladi; transfer faqat `SENDING` urinishga va `PROCESSING` buyurtmaga `SIGNED` bilan; `externalRef`
faqat urinish tirik bo‘lganda yoziladi), lekin worker o‘zi ham shuni qiladi:

1. imzolash va yuborishdan oldin `lockOrderRow` ostida buyurtma `PROCESSING` va urinish `SENDING` ekanini qayta tekshiradi; aks holda **hech narsa yubormaydi**, jobni tugatadi;
2. `externalRef` ni CAS bilan yozadi: `UPDATE ... WHERE "externalRef" IS NULL AND status IN ('SENDING','SENT','UNKNOWN')`; 0 qator → to‘xtaydi;
3. `TonTransfer(SIGNED)` ni xuddi shu tekshiruvdan keyin, hamyon qulfi bilan yozadi (DB trigger'i baribir rad etadi, GG001).

S5 testi shart: «operator FAILED qildi (REFUND berdi) → to‘xtab qolgan worker uyg‘ondi → hech narsa yuborilmaydi, TonTransfer yozilmaydi, `sendBoc` chaqirilmaydi».

**`validUntil` va «yuborilmadi» isboti (audit N2).** Transfer `EXPIRED` bo‘lishi uchun DB soati `validUntil + 60 s` dan o‘tgan bo‘lishi shart (`ggpin_ton_not_sent_margin_ms()`,
`TON_NOT_SENT_MARGIN_MS` bilan bir xil; test tengligini tekshiradi). `resolveNeedsReview` ham DB soatini ishlatadi (`now()`; chaqiruvchi soat bermaydi): `TON_NOT_SENT` uchun
`now >= validUntil + margin` va `checkedAt <= now` (skew yo‘q). **S9** reconciler `EXPIRED` ni **zanjir vaqti** (masterchain `utime`) bo‘yicha belgilaydi, devor soati bo‘yicha emas.
**S9:** buyurtma `REFUNDED` bo‘lsa-yu uning transferi keyin `CONFIRMED` bo‘lsa (kech topilgan tranzaksiya) — **kritik alert** (pul ikki marta chiqqan); alert kaliti `tonLateConfirmed` (kritik, refId = transfer; batafsil — «5-faza S9: reconcile», kech faktlar).

**Soat va UTC (audit L1, L8).** `readDatabaseNow` DB soatini **epoch** (`extract(epoch from now())`) sifatida o‘qiydi, `timestamptz` sifatida emas: haydovchi adapteri `timestamptz` offset'ini konvertatsiya qilmaydi, shuning uchun Asia/Tashkent sessiyasida soat 5 soatga siljib, yosh qoidasi va `checkedAt` tekshiruvi o‘chib qolardi. `createPrismaClient` har ulanishga `TimeZone=UTC` ni startup parametri bilan qotiradi (rol/DB sozlamasidan ustun); production boot'da `assertUtcTimeZone` (`current_setting('TimeZone')` UTC emasligi `DatabaseTimeZoneError` bilan to‘xtatadi) API `PrismaService.onModuleInit` da `assertProductionDatabase` dan keyin chaqiriladi. **S4 mezoni:** worker `PrismaService` ham xuddi shu `assertUtcTimeZone(this.client)` chaqiruvini qo‘shsin (worker S1 doirasida o‘zgartirilmadi; `assertProductionDatabase` ning bitta so‘rovli shartnomasi o‘zgarmadi, worker testi buni 1 so‘rov deb tekshiradi). Pin (`createPrismaClient`) ikkala jarayonga allaqachon ta’sir qiladi, `readDatabaseNow` esa sessiya zonasiga umuman bog‘liq emas. `Order`, `FulfillmentAttempt` va `TonTransfer` ning `createdAt` i INSERT'da DB soatidan (`timezone('UTC', now())`) qo‘yiladi (buyurtma `deliveredAt` siz yaratiladi) — mijoz yuborgan qiymat e’tiborsiz: orqaga sanab yosh qoidasini chetlab o‘tib bo‘lmaydi. Kotirovka `usedAt` qo‘riqchisi `clock_timestamp()` ishlatadi (yozuv paytidagi haqiqiy vaqt; `now()` — tranzaksiya boshi — uzoq tranzaksiyada muddati o‘tgan kotirovkani o‘tkazib yuborardi, Y5); `TonTransfer.EXPIRED` tekshiruvi `now()` da qoladi (tranzaksiya boshi — «kamida shuncha o‘tgan» uchun xavfsiz tomon).

**NEEDS_REVIEW'dan chiqish: isbot turlari.** Hammasi `resolveNeedsReview` orqali, qulf ostida buyurtmaning o‘z qatorlariga bog‘lanadi. Kim ko‘tara olishi (D-59):

- `reconciler` faqat zanjir o‘zi tasdiqlaydigan isbotlarni ko‘taradi: `TON_TX`, `TON_NOT_SENT`. Qolgani (`FRAGMENT_STATUS`, `MANUAL`, `TON_NOT_DEBITED`, `TON_BOUNCED`, `TON_UNMATCHED_RESOLVED`) faqat operator: aks holda `ACTOR_MISMATCH`.
- Operator hamisha **faol OWNER** bo‘lishi shart. `resolver` da `role` maydoni **yo‘q**: `type: 'ADMIN'` bo‘lsa helper `AdminUser` ni tranzaksiya ichida o‘zi qayta o‘qiydi (mavjud, `isActive`, `role = OWNER`; aks holda `OWNER_REQUIRED`); `type: 'CLI'` — eganing o‘z CLI'si, OWNER hisoblanadi, OTP'ni CLI oqimi tasdiqlaydi. Rol chaqiruvchidan olinmaydi (chaqiruvchi yozgan `role` e’tiborsiz qoldiriladi).
- `TON_NOT_DEBITED`, `TON_BOUNCED`, `TON_UNMATCHED_RESOLVED` va **`MANUAL` (ikkala chiqish: FAILED ham, DELIVERED ham)** OWNER + OTP talab qiladi (`rules/60`): `otpVerified` aynan `true` bo‘lishi shart (`"yes"`, `1` o‘tmaydi); resolver maydonlarining hammasi `typeof` bilan tekshiriladi (`OPERATOR_REQUIRED`); OTP yo‘q bo‘lsa `OWNER_REQUIRED`.

Isbot turlari:

- `TON_TX` → DELIVERED: transfer `CONFIRMED`, `txHash`/`lt` teng; bog‘langan urinish **tirik** (`SENDING`/`SENT`/`UNKNOWN`: NEEDS_REVIEW da `CONFIRMED` urinish bo‘lmaydi, pastdagi N1 invarianti) va buyurtmada boshqa hal bo‘lmagan urinish yo‘q (N3).
- `FRAGMENT_STATUS` → DELIVERED (faqat operator): `requestRef` urinish `externalRef`'iga teng; urinish **tirik**, boshqa hal bo‘lmagan urinish yo‘q (N3, R5); urinishning o‘z transferi `EXPIRED` yoki `ONCHAIN_FAILED` bo‘lsa `MISMATCH` (Z3) (yetib bormagan xabar Fragment'ga to‘lay olmagan, Y4).
  **Ochiq savol (S0b fixture'lariga bog‘liq):** `requestRef` aynan Fragment javobining qaysi maydoniga solishtiriladi (`req_id` yoki `extMsgHash`)? Reja 6.4 bo‘yicha `externalRef` = `extMsgHash`.
  Fixture'lar kelguncha shakl taxminiy. **Reconciler `FRAGMENT_STATUS` ni ishlatmaydi** (auditor tanlovi 5, Y4): faqat operator/CLI.
- `TON_NOT_SENT` → FAILED + REFUND: transfer `EXPIRED`, `seqno`/`validUntil` teng, soat sharti yuqoridagidek, boshqa transferlar `EXPIRED`, boshqa tirik/CONFIRMED urinish yo‘q.
- `TON_NOT_DEBITED` → FAILED + REFUND (**`ONCHAIN_FAILED` dan yagona chiqish**, A2): action fazasi xato bo‘lganda bizning tranzaksiya bajarilgan, lekin **chiquvchi xabar yo‘q**, pul hamyondan chiqmagan (qaytarish ham bo‘lmaydi). Isbot: `transferId`, `txHash` va `txLt` (bizning muvaffaqiyatsiz tx; transferdagilarga teng), `outMsgCount: 0` (literal), `reason`.
  Helper transfer shu buyurtmaniki, `ONCHAIN_FAILED`, hash va `lt` teng ekanini, boshqa transferlar `EXPIRED` va boshqa tirik/CONFIRMED urinish yo‘qligini tekshiradi. `ONCHAIN_FAILED` ga o‘tishda `txHash` va `txLt` majburiy (CHECK, I4).
  **Tranzaksiyada haqiqatan chiquvchi xabar yo‘qligini zanjirda tekshirish S9/S10 ishi** (Toncenter + Tonviewer); DB va helper buni tekshirmaydi.
- `TON_BOUNCED` → FAILED + REFUND (A1): **Fragment (manzil) bizning xabarni rad etdi va pul qaytish tranzaksiyasi bilan hamyonga qaytdi.** Bizning tx muvaffaqiyatli (chiquvchi xabar yuborilgan), transfer `BOUNCED` (`txHash`/`txLt` — bizning tx).
  Isbot: `transferId`, `txHash`/`txLt` (transferniki bilan teng), `returnTxHash`, `returnLt > txLt`, `returnedNanoTon` (`yuborilgan − TON_BOUNCE_FEE_MAX_NANO` dan yuborilganigacha), `reason`.
  `TON_BOUNCE_FEE_MAX_NANO` = 0,05 TON (50 000 000 nanoton, `@repo/shared`): bounce yo‘qotishi odatda TON ning mingdan bir necha ulushi; qiymat **konservativ taxmin, S9 fixture'si (haqiqiy bounce yozuvi) bilan aniqlanadi**. Kattaroq qiymat faqat qabul diapazonini kengaytiradi, mijozga zarar bermaydi (farq kompaniya zarari).
  `returnTxHash` qayta ishlatilmaydi: `AuditLog` da qisman unique indeks `AuditLog_review_return_tx_key` (`(after->'proof'->>'returnTxHash') WHERE action = 'ORDER_REVIEW_RESOLVE'`); helper avval tekshirib aniq xato beradi (`RETURN_TX_REUSED`), indeks — zaxira. Qaytish tx bizning chiquvchi tx hash'laridan biri bo‘la olmaydi (`MISMATCH`).
  Qaytish zanjirda borligini S9/S10 tekshiradi (ikki manba).
- `TON_UNMATCHED_RESOLVED` → FAILED + REFUND (A3): `CONSUMED_UNMATCHED` transfer, odam zanjirga qarab xulosa yozgan. Isbot: `transferId`, `finding` (`NOT_SENT` | `SENT_ELSEWHERE`), `consumingTxHash` (seqno'ni iste’mol qilgan **noma’lum** tx; 64 hex; bizning transferlardan biri bo‘la olmaydi va ikkinchi refundga ishlatilmaydi: `AuditLog_review_consuming_tx_key` qisman unique indeksi + helper'da `CONSUMING_TX_REUSED`, Z5), `reason` (kamida 20 belgi). Faqat OWNER + OTP va **faqat eganing CLI'si** (S10): `resolver.type !== 'CLI'` → `ACTOR_MISMATCH`, ADMIN OWNER bo‘lsa ham (Z2); deferred tekshiruv ham audit qatorida `after.operator.type = 'CLI'` ni talab qiladi; avtomatik yo‘l **yo‘q**.
  `SENT_ELSEWHERE` bo‘lsa natijada `securityAlert: 'tonWalletCompromised'` qaytadi: CLI commit'dan keyin shu **kritik** owner alert'ni (`fulfillment-alerts`, kalit `tonWalletCompromised`) chiqaradi — hamyon buzilgan, xavfsizlik hodisasi.
- `MANUAL` (faqat operator, OWNER + OTP): `DELIVERED` ga ham, `FAILED` ga ham. `FAILED` ga faqat barcha transferlar `EXPIRED`, `CONFIRMED` urinish yo‘q, va transfersiz `SENDING` urinish
  `FULFILL_ORDER_LOCK_DURATION_MS + TON_NOT_SENT_MARGIN_MS` (4 daq + 60 s) dan eski bo‘lsa. Bu yosh qoidasi **evristika**: BullMQ qulfni jonli worker uchun yangilab turadi, shuning uchun qulf «ushlab turilgani» ishlash vaqtining chegarasi emas. Asl to‘siq — DB INSERT qo‘riqchilari (buyurtma `PROCESSING` va urinish `SENDING` bo‘lmasa worker to‘lay olmaydi). Konstanta `packages/shared/src/fulfillment/fulfill-order-config.ts` da.

**`DELIVERED` — tasdiqlangan to‘lov (Y1, L5).** Buyurtma `DELIVERED` ga faqat quyidagilar bilan o‘tadi (DB qo‘riqchisi va `transitionOrder` ikkalasi): kamida bitta `CONFIRMED` urinish, hal bo‘lmagan (`SENDING`/`SENT`/`UNKNOWN`) urinish yo‘q, va har transfer `CONFIRMED`, `EXPIRED` yoki `ONCHAIN_FAILED` (jonli, `CONSUMED_UNMATCHED` yoki `BOUNCED` transfer yo‘q: **`BOUNCED` transferli buyurtma hech qachon DELIVERED bo‘lmaydi**). `resolveNeedsReview` (`DELIVERED` chiqishi) urinishni `CONFIRMED` qilib yopadi, aks holda rad etadi. `deliveredAt` DB soatidan (`timezone('UTC', now())`) faqat `→ DELIVERED` o‘tishida guard tomonidan qo‘yiladi (Y11) va **keyin o‘zgarmaydi** (Z1): `DELIVERED` buyurtmada qayta yozib, `DELIVERED` bo‘lmagan buyurtmaga yozib va `DELIVERED → REFUNDED` da o‘zgartirib/NULL qilib bo‘lmaydi (`GG001`); refunddan keyin ham yetkazish vaqti saqlanadi.
`DELIVERED → REFUNDED` (admin, S10) jonli urinish (`SENDING`/`SENT`/`UNKNOWN`) yoki `SIGNED`/`BROADCAST`/`CONSUMED_UNMATCHED`/`BOUNCED` transfer bo‘lsa DB tomonidan rad etiladi; `CONFIRMED`/`EXPIRED`/`ONCHAIN_FAILED` rad etmaydi.

**Urinish `CONFIRMED` = yetkazish tasdiqlangan (N1, D-59 qarori B).** Urinish `CONFIRMED` bo‘lishi mumkin **faqat buyurtma shu tranzaksiyada `DELIVERED` bo‘ladigan holatda**: deferred constraint trigger `FulfillmentAttempt_confirmed_check` (`COMMIT` da, faqat urinish `CONFIRMED` ga o‘tgan/shunday tug‘ilgan tranzaksiyada; `DELIVERED → REFUNDED` da urinish `CONFIRMED` qoladi va bu tekshiruvga tushmaydi). Sabab: aks holda kech bounce (`CONFIRMED → BOUNCED`) `CONFIRMED` urinish yonida `NEEDS_REVIEW`/`PROCESSING` buyurtmani tiqib qo‘yardi (`CONFIRMED` urinish oxirgi, `FAILED` uni rad etadi, `DELIVERED` bounced transferni rad etadi). Endi urinish `SENT`/`UNKNOWN` qoladi va kech bounce `TON_BOUNCED` bilan hal bo‘ladi (`PROCESSING` → bounce → `NEEDS_REVIEW` → refund). **Worker (S5) uchun:** transfer `CONFIRMED`, urinish `CONFIRMED` va buyurtma `DELIVERED` — bitta tranzaksiyada, tartibi ixtiyoriy (tekshiruv `COMMIT` da). Helper'lar shunga mos: `TON_TX` va `FRAGMENT_STATUS` faqat tirik urinishni qabul qiladi.
**Urinishning o‘z transferi (Z3).** Urinish `→ CONFIRMED` da: transferi yo‘q (kelajakdagi supplier urinishlari TON'siz) yoki `CONFIRMED` bo‘lsa — ruxsat; `EXPIRED` yoki `ONCHAIN_FAILED` bo‘lsa (pul chiqmagan) — **faqat MANUAL isboti bilan** (ega tizimdan tashqarida qo‘lda yetkazgan): buyurtmaning `ORDER_REVIEW_RESOLVE` audit qatori `after.proof.kind = 'MANUAL'`, `after.otpVerified = true`, `after.operator.role = 'OWNER'` bilan bo‘lishi shart (`resolveNeedsReview` uni shu tranzaksiyada yozadi; DB qatorning qaysi tranzaksiyada yozilganini tekshirmaydi — audit qatori iz, chegara emas, I1); `SIGNED`/`BROADCAST`/`CONSUMED_UNMATCHED`/`BOUNCED` bo‘lsa — hech qachon. Buyurtmaning **boshqa** (eski) urinishlari transferlari `EXPIRED`/`ONCHAIN_FAILED` bo‘lishi mumkin. Helper (`deliveryProblem`) DB bilan bir xil xulosa beradi. **S10 mezoni (I-8):** CLI bu holatda (`MANUAL` bilan yetkazish, urinishning o‘z transferi `EXPIRED`/`ONCHAIN_FAILED`) egaga «TON chiqmagan — siz tizimdan tashqarida yetkazdingizmi?» degan ogohlantirish ko‘rsatsin va tasdiq so‘rasin.

**`BOUNCED` va kech topilgan holatlar (A1).** `BROADCAST → BOUNCED` — S5/S9 klassifikatori (manzilning tx'i abort bo‘lgan va bounce qaytgan holat) **buni DELIVERED qilmaydi va `TON_TX` ga bog‘lamaydi**: transferni `BOUNCED` qiladi, buyurtmani `NEEDS_REVIEW` ga o‘tkazadi, `tonBounced` kritik alert chiqaradi. `CONFIRMED → BOUNCED` — bounce kech topilgan holat (transfer avval `CONFIRMED` yozilgan bo‘lsa). DB bunga faqat buyurtma hali `PROCESSING` yoki `NEEDS_REVIEW` bo‘lganda ruxsat beradi (buyurtma qatori `FOR SHARE`: parallel DELIVERED bilan poyga yo‘q). **Buyurtma allaqachon `DELIVERED` bo‘lsa**, transfer `CONFIRMED` qoladi (DB `BOUNCED` ni rad etadi, chunki `BOUNCED` transferli buyurtma DELIVERED bo‘la olmaydi), buyurtma holati o‘zgarmaydi, reconciler kritik alert (`tonBounced`) chiqaradi va egaga admin refund (S10: `DELIVERED → REFUNDED`, transfer `CONFIRMED` bo‘lgani uchun DB ruxsat beradi) qoladi. `BOUNCED` va `ONCHAIN_FAILED` oxirgi holatlar.

**DB istisnolarining umumiy shakli (A4, D-59).** `ONCHAIN_FAILED`, `BOUNCED`, `CONSUMED_UNMATCHED` transferlar uchun: (1) **buyurtma qo‘riqchisi** istisnosi faqat `NEEDS_REVIEW → FAILED` va `FAILED → REFUNDED` da (aynan shu resolve oqimi); `PROCESSING` dan to‘g‘ridan-to‘g‘ri, `HELD`, `CANCELLED` — hech qachon; (2) **urinish qo‘riqchisi**: bunday transferli urinishni `FAILED` qilish faqat buyurtma `NEEDS_REVIEW` bo‘lganda; (3) **deferred tekshiruv** (`COMMIT` da, `Order_special_transfer_check`): bunday transferli buyurtma `FAILED` (yoki `FAILED → REFUNDED`) bo‘lsa, shu transferga tegishli `ORDER_REVIEW_RESOLVE` audit qatori bo‘lishi shart: `after.proof.kind` transfer holatiga mos (`ONCHAIN_FAILED` → `TON_NOT_DEBITED`, `BOUNCED` → `TON_BOUNCED`, `CONSUMED_UNMATCHED` → `TON_UNMATCHED_RESOLVED`), `after.proof.transferId` = transfer id, `after.otpVerified = true`, `after.operator.role = 'OWNER'`; `BOUNCED` uchun `after.proof.returnTxHash` bo‘sh emas, `BOUNCED` va `ONCHAIN_FAILED` uchun `after.proof.txHash`/`txLt` transfer qatoridagilarga teng (I-1), `CONSUMED_UNMATCHED` uchun `after.operator.type = 'CLI'` va `consumingTxHash` bo‘sh emas (Z2) (audit qatori iz, chegara emas, I1: isbotni zanjir ma’lumotiga bog‘laydigan — helper); (4) shunday buyurtmaga yangi urinish yoki transfer qo‘shilmaydi (INSERT qo‘riqchilari buyurtma `PROCESSING` bo‘lishini talab qiladi, R2f).
`CONSUMED_UNMATCHED → ONCHAIN_FAILED` o‘tishi taqiqlangan (R2a2): uydirma muvaffaqiyatsiz tranzaksiya «pul qayerga ketgani noma’lum» holatini refund qilinadigan holatga aylantira olmaydi; `CONSUMED_UNMATCHED` faqat bizning tranzaksiyamiz topilsa `CONFIRMED` bo‘ladi.

**Reconciler va `GG001` (S9).** Reconciler transferni yoki buyurtmani yangilaganda `GG001` olsa (masalan buyurtma boshqa holatga o‘tib bo‘lgan, yoki `BOUNCED` DELIVERED buyurtmada), bu **kritik alert** `reconcileGuardRefused` — jim yutilmaydi, shu tik ichida qayta urinilmaydi; refId `<orderId>_<qadam>_<soat>` (har soatda bir marta), alert matniga buyurtma holati yoziladi (`alerts.fulfillment.reconcileGuardRefused`). Batafsil — «5-faza S9: reconcile».

**CONSUMED_UNMATCHED — tekshiruvdan keyin refund (A3, ertalabki «refund yo‘q» qarori o‘rniga).** Seqno o‘tib ketgan, lekin shu seqno'ni nima iste'mol qilgani noma'lum: hamyondan pul ketgan bo‘lishi mumkin. Avtomatik refund **yo‘q**; odam zanjirga qarab xulosa yozgach, eganing CLI'si `TON_UNMATCHED_RESOLVED` isboti bilan refund qiladi (yuqorida). Kritik alert kaliti `tonConsumedUnmatched` (`fulfillment-alerts`); alertni S9 reconciler chiqaradi va, buyurtma `NEEDS_REVIEW` da turguncha, har soatda eslatadi: refId `<transferId>_cu_<soat>` (`review-sweep.step.ts`, `episodeRef(…, 'cu', …)`).
**Qo‘lda tekshiruv runbook'i** (egaga, shu tartibda; DB'ga qo‘lda aralashuv **yo‘q**):

1. Hot wallet manzili va `seqno` ni `TonTransfer` qatoridan oling (`walletAddress`, `seqno`, `validUntil`, `extMsgHash`).
2. Ikki mustaqil explorer'da (Tonviewer va Toncenter) hamyonning shu `seqno` dagi chiquvchi tranzaksiyasini toping. Kim yuborgan va qaysi manzilga ekanini, tranzaksiya hash'ini yozib qo‘ying.
3. Tranzaksiya **Fragment allowlist manziliga, shu summada** ketgan bo‘lsa — bu bizning xabarimiz (D-59 (8)). **Odam faqat tranzaksiya hash'ini beradi, tasdiqni kod qiladi; `MANUAL` bilan DELIVERED qilinmaydi.** Ega CLI orqali shu hash'ni reconciler'ga «hint» sifatida beradi. Reconciler tranzaksiyani zanjirda **ikki mustaqil manbadan** (Toncenter va Tonviewer) o‘zi tekshiradi: (a) manzil — Fragment allowlist (`FRAGMENT_PAY_ADDRESSES`); (b) summa; (c) payload yoki xabar bizning transferga mos (`payloadHash`/`extMsgHash`); (d) `seqno` shu transferniki. Hammasi mos kelsa transfer `CONSUMED_UNMATCHED → CONFIRMED` bo‘ladi (bu qirra DB'da bor; `txHash`/`txLt` shu qirrada yoziladi) va urinishga `late` belgisi qo‘yiladi. Buyurtma `NEEDS_REVIEW` da **qoladi**: reconciler kech topilgan transferni hech qachon isbot sifatida olmaydi (u cashback va referal bonusini ham to‘lagan bo‘lardi), buyurtmani ega o‘zi `order:resolve --proof TON_TX` (Fragment yetkazgan bo‘lsa) bilan hal qiladi. Mos kelmasa — 4-qadam (`TON_UNMATCHED_RESOLVED` orqali refund). **Holat:** hint oqimi S9f da kodlangan (`ton:hint` — S10 CLI, tekshiruv — worker `ton-tx-hint.verifier.ts`); to‘liq tartib va rad kodlari — «5-faza S9: reconcile», Z6.
4. Pul ketmagan bo‘lsa (`NOT_SENT`) yoki boshqa manzilga ketgan bo‘lsa (`SENT_ELSEWHERE`) — **mijozga refund qilinadi, zarar kompaniyaniki** (mijoz aybdor emas): CLI `TON_UNMATCHED_RESOLVED` isboti (`finding`, `consumingTxHash`, sabab) bilan buyurtmani FAILED + REFUND qiladi. `SENT_ELSEWHERE` bo‘lsa hamyon buzilgan: **yangi yuborishlarni to‘xtating** (`TON_*` limitlarini 0 qiling), kalitlarni almashtirish rejasini boshlang; CLI `tonWalletCompromised` alert'ini chiqaradi.
5. Refund kod yo‘li bilan bajariladi (DB'ga qo‘lda yozuv kerak emas): bitta tranzaksiyada urinish yopiladi, buyurtma FAILED → REFUNDED, `REFUND` ledger yozuvi va `AuditLog` yoziladi.
6. Har qadam `AuditLog` ga sabab bilan yoziladi (CLI buni isbotdagi `reason` va audit qatori bilan o‘zi qiladi).

**Marshrut va yetkazish (R3, R6 bilan bog‘liq).** Qabul qiluvchi ismida faqat bidi/ko‘rinmas belgilar rad etiladi (U+061C, U+180E, U+200B, U+200E–200F, U+2028–2029, U+202A–202E, U+2060–2064, U+2066–2069, U+FEFF); ZWJ (U+200D) va ZWNJ (U+200C) ruxsat (ega qarori R6), shuning uchun qo‘shma emoji'li ismlar o‘tadi; tag belgilari (U+E0020–E007F) ham ruxsat (England/Scotland/Wales bayroq emoji'lari ularni ishlatadi). Ismda kamida bitta **ko‘rinadigan** belgi bo‘lishi shart: faqat bo‘shliq, to‘ldiruvchi belgilar (U+3164, U+115F, U+1160, U+FFA0), ruxsat etilgan ZW belgilari, yumshoq defis, variatsiya selektorlari yoki yalang‘och tag belgilaridan iborat ism rad etiladi (D-59 Y8).

## 5-faza S5: TON issiq hamyon (tuzatish raundi)

Kod: `apps/worker/src/ton/**`, env: `apps/worker/src/config/ton-env*.ts`. Bu bo‘lim S5 review va audit topilmalari bo‘yicha qabul qilingan qoidalarni yozadi; S9 (reconciler) va S10 (CLI) shularga tayanadi.

**Hamyon tranzaksiyalarini qidirish — vaqt bilan chegaralangan skan (audit H1).** Bizning chiquvchi tranzaksiyamiz «oxirgi 128 tadan» qidirilmaydi: hamyonga kelgan spam (masalan 1000 ta kichik kiruvchi o‘tkazma) uni oynadan itarib chiqarardi va to‘lov chiqqan bo‘lsa ham `EXPIRED`/refund xulosasiga olib kelardi. Skan sahifalab (`SCAN_PAGE_SIZE` = 100 — toncenter `getTransactions` ning hujjatlangan maksimumi, `limit` ≤ 100 (audit L-2); bir qarashda ko‘pi bilan `SCAN_PAGES_PER_LOOK` = 8 sahifa) eng yangidan transfer yaratilgan vaqtgacha (`createdAt − scanSlackSec`) yuradi va kursor qarashlar orasida saqlanadi. Natija: `FOUND` (topildi), `COMPLETE` (butun oyna ko‘rildi, yo‘q), `PARTIAL` (oyna oxirigacha yetilmadi — keyingi qarashda davom) yoki `STALE` (provayder eski holat berdi). **Faqat `COMPLETE` «tranzaksiya yo‘q» degani**; `PARTIAL`/`STALE` hamisha `WAIT` (hech qachon `EXPIRED` emas). Regress testlari: tranzaksiyadan keyin 128 va 1000 spam (unit), 128 va 600 spam (e2e, haqiqiy DB). **S9 reconciler 128 ta bilan cheklangan eski skanni qayta ishlatmaydi** — faqat shu chegaralangan skan (`advanceScan`) bilan ishlaydi.

**Skan eskirgan holatga tayanmaydi (audit M-1 (a)).** Yangi o‘tish (pass) faqat shu manbaning indeksi account state’dagi oxirgi tranzaksiyani **eng yangi** deb ko‘rsatsa boshlanadi. Node eski holat (eski seqno, eski `lastTx`) va hozirgi zanjir vaqtini bersa-yu, indeksda bizning tranzaksiya turgan bo‘lsa — `STALE` (`WAIT`), hech qachon `COMPLETE`/`EXPIRY` emas. Bu «bosh» ro‘yxati o‘tishning birinchi sahifasi, shuning uchun qo‘shimcha so‘rov faqat «qamrab olingandan beri yangi narsa yo‘q» qarashida: bitta `getTransactions(limit 1)`. **Progress yo‘qolmaydi (review m1, audit L-2):** sahifa xatosi (429, 503, tarmoq) qarashni `PARTIAL` bilan tugatadi va kursor saqlanadi; `STALE` avval qamrab olinganni (`covered`) va davom etayotgan o‘tish kursorini saqlaydi; faqat zanjirning o‘zi `covered` ga zid bo‘lsa, u tashlanadi. Kursorni restart’dan keyin saqlash va NEEDS_REVIEW transferlarni skanlashni davom ettirish S9 da bajarildi (kursor `response.ton.scan` da, ishonch qoidasi «Variant A»: «5-faza S9: reconcile», skan kursori).

**Manzil tekshiruvi «yopiq holatda yiqiladi» (review M1/M2, audit E6).** `findResultTx` faqat toncenter’ning tanilgan «topilmadi» javobini (`404` + `{ok:false}`) `null` deb qabul qiladi; bu shakl **taxmin** (haqiqiy javob yozuvi yo‘q, kodda belgilangan) va S9/S12 fixture’i bilan aniqlanadi. Boshqa har qanday xato (429, 503, tarmoq, noma’lum shakl) `TonGatewayError` → `WAIT`: xato hech qachon «topilmadi» deb sanalmaydi. Manzil kutish muddati (`DEFAULT_DEST_GRACE_SEC` = 20 s) faqat **muvaffaqiyatli** «topilmadi» javobidan sanaladi. Shuning uchun bounce bo‘lgan manzil lookup’i avval 429/503 bersa ham natija `BOUNCED` review, hech qachon `DELIVERED` emas; doim xato bersa — `CONFIRM_TIMEOUT` review. Live rejimda `TON_API_KEY` majburiy (kalitsiz rate-limit ko‘p 429 beradi).

**Bounce qaytishi chegarasi (review M2).** Qaytgan summa `[yuborilgan − TON_BOUNCE_FEE_MAX_NANO, yuborilgan]` oralig‘ida bo‘lsa — `BOUNCED`; yuborilgandan ko‘p (`RETURN_ABOVE_SENT`) yoki pastki chegaradan kam (`RETURN_BELOW_FLOOR`) — `SUSPECT` → review (aks holda `TON_BOUNCED` isboti hech qachon qabul qilinmaydigan `BOUNCED` transfer buyurtmani chiqishsiz qoldirardi). Chegaralar aniq tenglik bilan testlangan.

**`EXPIRED` — ikki kuzatuv (D-60 (2), audit E4).** Bitta «seqno o‘tdi, tranzaksiya yo‘q» javobi yetarli emas: provayder bir marta eski holat bersa, chiqib ketgan to‘lov refund qilinardi. Birinchi kuzatuv (`seqno`, zanjir vaqti, `lastTxLt`, DB soati) yangi ustunsiz `FulfillmentAttempt.response.ton.expiry.first` ga yoziladi; ikkinchisi uni tasdiqlaydi: shu `seqno`, DB soati bo‘yicha kamida `DEFAULT_EXPIRY_GAP_SEC` = 30 s keyin (bir necha masterchain bloki: bir martalik eski javob o‘tib ketadi, kutish uzoq emas), zanjir vaqti qat’iy kattaroq va `lastTxLt` kichik emas. Har bir kuzatuv **yangi ulanishda** qayta olinadi (audit M-1 (b)): keepAlive’siz, har so‘rovga yangi `https.Agent` (provayder balanseri ortidagi boshqa node’ga tushishi mumkin); shu ulanish o‘sha `lastTx` ni, indeksida undan yangi tranzaksiya yo‘qligini, seqno o‘zgarmaganini va zanjir vaqti hamda undan keyin o‘qilgan DB soati `validUntil + 60 s` dan o‘tganini ko‘rsa — kuzatuv shu holat va shu DB soati bilan yoziladi; aks holda `WAIT` (`FRESH_DISAGREES`). Narxi: ikki o‘qish, faqat skan EXPIRY’ga ishora qilgan qarashda. Kuzatuv o‘z transferiga bog‘langan (audit L-3): `transferId`, `extMsgHash`, `validUntilMs`, `seqno` bilan saqlanadi, sxema `.strict()`; mos kelmagan, `validUntil + 60 s` dan oldin olingan yoki keyingi kuzatuvdan keyingi DB vaqtidagi `first` yo‘q deb hisoblanadi (keyingi qarash birinchi bo‘ladi — xavfsiz yo‘nalish). `expiry.first` keyin transfer `CONFIRMED` bo‘lsa ham attempt’da qoladi (review n3): bu dalil, S10 uni hisobga oladi. Shu sababli `TON_CONFIRM_TIMEOUT_MS` > `TON_SEND_VALID_SEC + 60 s + 30 s + 90 s + 6 s` (review m2: imzolashdagi zanjir vaqti DB soatidan `signLagMaxSec` = 90 s gacha oldinda bo‘lishi mumkin; review RR2 #4: har kuzatuv bitta poll (`DEFAULT_POLL_MS` = 3 s) kechikishi mumkin, shuning uchun ikki poll zaxirasi; env tekshiradi), standart qiymat 3 daqiqadan **5 daqiqaga** (300 000 ms) ko‘tarildi va boshqa o‘zgarmaydi. Qarashning o‘z davomiyligi (har so‘rovga 15 s timeout, EXPIRY qarashida bir nechta so‘rov: holat, bosh sahifa, yangi ulanishda yana ikki o‘qish, guvohlar) tengsizlikka **kiritilmagan**: eng yomon holatda bitta EXPIRY qarashi 1 daqiqadan oshadi (kamida 4 so‘rov × 15 s, skan sahifalari va guvohlar bilan ko‘proq), uni ikki marta qo‘shsak standart 5 daqiqa yetmaydi. Bu faqat jonlilik (liveness) masalasi, xavfsizlik emas: provayder sekin bo‘lsa yo‘qolgan xabar `EXPIRED` o‘rniga `NEEDS_REVIEW` (`CONFIRM_TIMEOUT`) bilan tugaydi — xavfsiz yo‘nalish, keyin reconciler (S9) yoki ega hal qiladi. `FULFILL_ORDER_LOCK_DURATION_MS` (4 daq) tasdiq kutishiga bog‘liq emas (review RR2 #3): BullMQ jonli worker qulfini yangilab turadi; qulf faqat worker o‘lsa yoki event loop to‘xtasa tugaydi, qayta yetkazilgan job esa `findByAttempt` orqali mavjud transferni faqat kuzatadi, qayta imzolamaydi. Uning haqiqiy invarianti — TON hamyon lease’idan (`DEFAULT_LOCK_TTL_MS` = 120 s) uzunroq bo‘lish (qayta yetkazilgan job o‘lgan worker lease’i tufayli `WALLET_BUSY` olmasin); MANUAL yosh qoidasi faqat transfersiz `SENDING` bosqichini qamraydi, transfer `EXPIRED` bo‘lmaguncha MANUAL → `FAILED` istalgan yoshda rad etiladi (`LIVE_PAYOUT`). **Guvohlar (review m3).** Ikkinchi, mustaqil manba tor `TonChainWitness` interfeysi orqali ulanadi (faqat `getAccountState` va `getTransactions`; `sendBoc` yo‘q), hozircha ro‘yxat bo‘sh. Guvoh bizning xabarni topsa (`FOUND`) yoki seqno o‘tganini ko‘rsa (`SEQNO_MOVED`) — `EXPIRED` yo‘q: `WITNESS_CONFLICT` → buyurtma `NEEDS_REVIEW`, attempt `UNKNOWN` (`response.ton.witnessConflict`), egaga kritik `tonWitnessConflict` alert (refId = transfer). Guvoh hali aniq ayta olmasa — `WAIT`. **Nizo doimiy (review RR2-4):** guvoh bir marta nizo bildirgan transfer keyin guvoh «rozi» bo‘lsa ham hech qachon `EXPIRED` bo‘lmaydi. Yozish qatlami qat’iy: attempt’da `ton.witnessConflict` bo‘lsa (SELFTEST’da — CLI jarayoni xotirasida) `EXPIRY_SEEN` hech narsa yozmaydi, hatto birinchi kuzatuvni ham (restart va reconciler ham shu yo‘ldan o‘tadi); reader esa shu jarayonda o‘sha transfer uchun `WITNESS_CONFLICT` ni takrorlaydi. Transfer hal bo‘lmagan holda qoladi (hamyon bloklanadi, `tonWalletBlocked`), uni reconciler (S9) yoki ega hal qiladi. `tonWitnessConflict` alerti verdiktdan emas, saqlangan faktdan (`tonNoticesFor`) yasaladi, shuning uchun navbatga qo‘yish yiqilsa keyingi qarash uni qayta yuboradi (bir xil dedupe id). **Mainnet’dan oldin ikkinchi manba majburiy:** ikkinchi mustaqil zanjir manbasi (masalan Tonviewer) ulanmaguncha live mainnet worker boot’da rad etiladi (`TON_NETWORK=mainnet: a second, independent chain source ...`).

**To‘lov manzili allowlist’i (audit L1).** `FRAGMENT_PAY_ADDRESSES` — vergul bilan ajratilgan Fragment manzillari (raw yoki user-friendly, faqat workchain 0; mainnet’da test-only manzil rad etiladi; xato yozuv tartib raqami bilan aytiladi, qiymati emas). Ro‘yxat har rejimda tekshiriladi, live mainnet’da kamida bitta manzil majburiy. `ORDER` to‘lovi ro‘yxatda yo‘q yoki workchain 0 bo‘lmagan manzilga **imzolashdan oldin** `HELD` (`ADAPTER_ERROR`) bo‘ladi, urinish `FAILED` (`error = PAY_ADDRESS_NOT_ALLOWED`), egaga `held` alert; zanjirga hech narsa so‘ralmaydi. Tekshiruv ikki joyda: servisda (qulfdan oldin) va imzolash tranzaksiyasi ichida. Modul tashqariga faqat hamyon manzilini eksport qiladi, imzolovchini emas.

**Limitlar (audit L5).** `TON_MAX_PER_ORDER_NANO` va `TON_MAX_DAILY_NANO` live’da aniq berilishi shart (standart qiymatlar faqat dry-run uchun). 24 soatlik yig‘indiga chiqib ketgan bo‘lishi mumkin bo‘lgan har transfer kiradi, `EXPIRED` ham. Limitga teng — ruxsat, bir nanoton ortiq — `HELD` (`LIMIT_PER_ORDER`/`LIMIT_DAILY`) + alert.

**Endpoint (audit L4, I2).** Live rejimda `TON_API_ENDPOINT` hamisha `https` (faqat production’da emas) va host `TON_NETWORK` ga mos bo‘lishi shart (`toncenter.com` — mainnet, `testnet.toncenter.com` — testnet). HTTP transporti o‘zimizniki: javob hajmi 2 MiB bilan cheklangan (e’lon qilingan va oqimdagi), redirect’ga yurilmaydi, proxy ishlatilmaydi (o‘z `https.Agent`), bitta umumiy muddat, xato matnida so‘rov sarlavhalari (API kaliti) yo‘q. Bu zod@3 istisnosining (D-60 (4)) sharti. Host oxiridagi nuqta olib tashlanib tekshiriladi (audit I-2): `toncenter.com.` — mainnet, testnet’da rad etiladi.

**Sirlar (audit L2).** Shifrlangan mnemonic va kalit env’dan bir martalik handle’ga o‘tadi (`take()` bir marta, `toJSON`/`inspect` yashiradi); `TON_API_KEY`, `WALLET_ENC_KEY`, `TON_MNEMONIC_ENC` boot’dan keyin `process.env` dan o‘chiriladi. `WORKER_CONFIG` da `TON_API_KEY` oddiy satr emas, `TonApiKey` ushlagichi (review m5, audit I-3): `toJSON`/`String`/`inspect` → `[redacted]`; qiymatni faqat toncenter transporti (`toncenter-http.ts`) `X-API-Key` sarlavhasiga qo‘yadi, `TonClient` kalitni olmaydi (lint boshqa joyda o‘qishni taqiqlaydi). Imzolovchi (audit I-1): `TON_WALLET` belgisini `src/ton` dan tashqarida import qilish lint bilan taqiqlangan (`moduleRef.get(TON_WALLET, …)` yozib bo‘lmaydi), hamyonni ushlovchi servislar uni `#private` maydonda saqlaydi (sender), yoki umuman saqlamaydi (reader faqat ochiq `own` ni, balans monitori faqat manzilni).

**Soatlar (review m5).** Imzolashdan oldin: zanjir ↔ worker ≤ `maxClockSkewSec`, worker ↔ DB ≤ 30 s (aks holda `NOT_SENT CLOCK_SKEW`, hech narsa imzolanmaydi), imzolash tranzaksiyasi ichida DB − zanjir vaqti ≤ `maxClockSkewSec + 30 s` (aks holda hech narsa yozilmaydi, qayta urinish). Live worker boot’da DB soatini tekshiradi va farq bo‘lsa log yozadi.

**Hamyon bloklangan (review M4/L3).** Hal bo‘lmagan (`SIGNED`/`BROADCAST`) transfer tasdiq kutish muddatidan (`TON_CONFIRM_TIMEOUT_MS`, DB soati bo‘yicha) eski bo‘lsa, yangi to‘lovlar `WALLET_BUSY` bilan to‘xtaydi va egaga kritik `tonWalletBlocked` alert boradi (payload `{kind, refId = transferId}`, barqaror dedupe id: bitta transfer uchun bir marta). Uni uch joy chiqaradi: buyurtma `NEEDS_REVIEW` ga hal bo‘lmagan transfer bilan o‘tganda, sender `WALLET_BUSY` yo‘lida va live balans monitori. Renderer — S6.

**Natija semantikasi (review m1, m2).** `pay()` **xato tashlasa — natija noma’lum**: qayta urinish hamisha xavfsiz (oldin urinishning o‘z transferi qidiriladi va kuzatiladi, qayta imzolanmaydi), lekin xato hech qachon `FAILED`, `HELD` yoki refund sababi emas (S4). Urinishning o‘z transferi bo‘lsa, u hamyon qulfisiz ham kuzatiladi (o‘lik worker qulfi uni yashirmaydi). Qulf ostida qayta tekshiriladi.

**S12 darvozasi (mainnet’dan oldin).** L-1: «topilmadi» javobini testnet’dan yozib olingan fixture bilan aniq moslash va grace’dan oldin hamyonimizga qaytgan bounce’ni mustaqil tekshirish; M-1 (c): S12 guvohi ham M-1 (a) bosh tekshiruvi bilan skan qiladi (`advanceScan` orqali — boshqa yo‘l yo‘q); I-5: guvohlar soni ≥ 1, primary’dan boshqa provayder yoki host, env bilan tekshiriladi. **Qolgan xavf (yakuniy qayta sharh, RR2 #2):** butun primary provayder — account state, indeks **va** yangi ulanish — gap’dan (30 s) uzoqroq vaqt davomida bir xil eskirgan holatni bersa, ikki «mos» kuzatuv yig‘iladi → soxta `EXPIRED` → `TON_NOT_SENT` → ikkinchi to‘lov. Bosh tekshiruv ham, yangi ulanish ham buni yopmaydi; uni **faqat mustaqil guvoh** yopadi (D-60 (2)). S12 testi majburiy: `freshIsStale=true` (eskirgan provayder, yangi ulanish ham eskirgan) va haqiqatni ko‘radigan guvoh → `WITNESS_CONFLICT`, `sendBoc` = 1, to‘lov bir marta. Repo’dagi E4c testi faqat `freshIsStale=false` holatini (yangi ulanish yangi node’ga tushadi) isbotlaydi; to‘liq eskirgan provayder S12 ga qoladi. Shu bilan birga RR2-4 kafolati: guvoh bir marta nizo bildirsa, transfer keyin hech qachon `EXPIRED` bo‘lmaydi (yuqoridagi «Nizo doimiy»).

**S6 uchun.** `held` va `tonDailyLimit` alertlarining `refId` i tarkibiy: `<orderId>_<attemptId>` (har urinish o‘z xabari; renderer `refIdSubject` bilan buyurtma id’sini oladi). `ORDER_REVIEW` buyurtma bo‘yicha.

## 5-faza S4: yetkazish yadrosi (`fulfill-order`)

Kod: `apps/worker/src/fulfillment/**`, simulyator: `apps/worker/src/adapters/simulator/**`. TON to‘lovi S5 modulidan (`TonSenderService.pay`) tor `TonPayer` interfeysi orqali olinadi; yadro hamyonni ham, gateway’ni ham ko‘rmaydi.

**Processor.** `fulfill-order` (jobId = orderId, 5 urinish, eksponensial backoff), `concurrency: 1`, `lockDuration = FULFILL_ORDER_LOCK_DURATION_MS` (240 s). Payload faqat `{ orderId }` (strict), boshqasi `UnrecoverableError`. Oxirgi urinish: `attemptsMade + 1 >= attempts`. Xato loglari `describeErrorForLog` orqali.

**Algoritm (bitta run).**

1. `lock:order:{id}` (Redis, TTL 60 s, run davomida yangilanadi). Band bo‘lsa — `RetryLaterError` (oxirgi urinishda no-op); Redis javob bermasa — hech narsa qilinmaydi, job qayta urinadi. Haqiqiy himoya DB’da: CAS holat o‘tishlari, buyurtmada bitta jonli urinish, hamyonda bitta hal qilinmagan transfer.
2. Buyurtma qayta o‘qiladi: `PAID → QUEUED → PROCESSING` (`transitionOrder`, CAS). Boshqa holat — **replay**: hech narsa to‘lanmaydi, yakuniy holatning bildirishnomalari barqaror id bilan qayta navbatga qo‘yiladi (HELD — hold alerti, NEEDS_REVIEW — `ORDER_REVIEW` + `needsReview`, DELIVERED — `ORDER_DELIVERED`, yadro qilgan refund — kesh invalidatsiyasi + `ORDER_REFUNDED`).
3. Hal qilinmagan urinish (`SENDING`/`SENT`/`UNKNOWN`) bo‘lsa — faqat u kuzatiladi, yangi to‘lov yo‘q. `UNKNOWN` — darhol NEEDS_REVIEW. TON urinishi uchun `pay()` qayta chaqiriladi (S5: transfer bo‘lsa faqat kuzatadi; bo‘lmasa — demak hech qachon imzolanmagan — bir marta imzolaydi). Ta’minotchi urinishi qayta **yuborilmaydi**, faqat `confirm`; aniq DELIVERED bo‘lmagan har natija NEEDS_REVIEW.
4. Yangi urinish: `providerRef` null/bo‘sh → FAILED + REFUND (`RECIPIENT_GONE`); router (yoqilgan `ProductRoute` lar priority bo‘yicha, health = OK; buyurtmada urinish bo‘lgan bo‘lsa — faqat o‘sha adapter) → `prepare` → `RECIPIENT_CHANGED/GONE` → FAILED + REFUND; `REFUSED` → HELD `ADAPTER_ERROR`; valyuta farqi → HELD `NO_ADAPTER`; `costMinor > maxCostMinor` → HELD `PRICE_ABOVE_MAX` (teng — ruxsat); TON yo‘riqnomasi (`request.ton = { toAddress, amountNano, payloadBoc }`, summa = `costMinor`, `externalRef = null`, manzil workchain 0 va `FRAGMENT_PAY_ADDRESSES` da, `payloadBoc` haqiqiy BOC — audit L-4; `pay()` o‘z tekshiruvini ham saqlaydi) noto‘g‘ri → HELD `ADAPTER_ERROR`, urinish yaratilmaydi; USDT’da `costMinor > SUPPLIER_MAX_PER_ORDER_MICRO_USDT` → HELD `LIMIT_PER_ORDER`; oldindan hisoblangan `externalRef` siz ta’minotchi urinishi → HELD `ADAPTER_ERROR`.
5. Bitta tranzaksiyada, buyurtma qatori qulfi ostida: buyurtma hamon PROCESSING, buyurtmaning `PURCHASE` yozuvi aynan `−(priceTiyin − discountTiyin)` (bo‘lmasa — HELD `ADAPTER_ERROR`), keyin `FulfillmentAttempt(SENDING)` — **commit**.
6. To‘lov: TON — `pay()`; ta’minotchi — `send` → `SENT` → `confirm` so‘rovlari, `TON_CONFIRM_TIMEOUT_MS` gacha (DB soati bo‘yicha, urinish yaratilganidan; timeout → NEEDS_REVIEW `CONFIRM_TIMEOUT`). Urinish CONFIRMED faqat buyurtma DELIVERED bilan **bitta tranzaksiyada**.
7. Run oxirida (BullMQ `completed`/`failed` hodisasi) holat qayta o‘qiladi: hamon `QUEUED` bo‘lsa — worker’ning `FulfillEnqueuer` i (`decideEnqueue`, API bilan bir xil mantiq) bilan qayta navbat. Oddiy `queue.add` ishlatilmaydi. Job **butunlay** yiqilgan bo‘lsa (quyida) — `settleAbandoned`.

**Butunlay yiqilgan job (CR M1, audit M-1).** Job’ni BullMQ boshqa ishga tushirmaydigan holat ikki xil: (1) oxirgi urinishda istisno (SENDING commit javobi yo‘qolishi, `toReview`/`hold`/`failAndRefund` dagi DB xatosi, `LivePayoutError`); (2) crash-loop — job ikki marta stalled bo‘ladi va BullMQ uni `process()` ni chaqirmasdan failed qiladi (`job stalled more than allowable limit`). Ikkalasida buyurtma order lock ostida yakunlanadi (`fulfill-settle.ts`; (1) uchun lease bo‘shamasdan, run ichida; `failed` hodisasida `finishedOn` son bo‘lsa — qaytadan; `Job.retry()` uni `null` qiladi, shuning uchun `typeof` bilan tekshiriladi): PROCESSING + jonli urinish → NEEDS_REVIEW `ADAPTER_ERROR` + `ORDER_REVIEW`/`needsReview` (+ transfer hal bo‘lmagan bo‘lsa `tonWalletBlocked`); PROCESSING, jonli urinish yo‘q → yadro hold’i `ADAPTER_ERROR` + `held` alerti; PAID/QUEUED → qayta navbat, lekin 24 soatda ko‘pi bilan 3 marta (Redis hisoblagich `fulfill:abandoned:{orderId}`, migratsiyasiz; 4-yakuniy yiqilishda — `needsReview` alerti va to‘xtash, cheksiz aylanish yo‘q, CR m8). PAID/QUEUED faqat `failed` hodisasida navbatga qo‘yiladi va sanaladi: run ichida job hali `active`, navbatga qo‘yish hech narsa qilmasdi, lekin hisoblagichni oshirardi (`DEFERRED`; har yiqilish bir marta sanaladi, qayta sharh R2); boshqa holat — replay; hech narsa yozib bo‘lmasa (DB yo‘q) — kamida `needsReview` alerti, refId `<orderId>_abandoned` (notify id’lari kunlab dedupe qilinadi: oddiy `orderId` keyingi haqiqiy NEEDS_REVIEW alerti uchun bo‘sh qolishi kerak; renderer `refIdSubject` bilan buyurtmani topadi, qayta sharh R1). Jonli urinish bo‘lsa hech qachon HELD/FAILED/refund emas.

**`pay()` natijalari bo‘yicha qaror.**

| Natija              | Yadro nima qiladi                                                                                                                                                                        |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DELIVERED`, `HELD` | Tugadi (holat va bildirishnomalarni TON moduli yozgan).                                                                                                                                  |
| `REVIEW`            | Buyurtma NEEDS_REVIEW bo‘lsa — tugadi; hamon PROCESSING bo‘lsa — qayta urinish, oxirgisida yadro o‘zi NEEDS_REVIEW.                                                                      |
| `EXPIRED`           | «Yuborilmagan» isbotlangan → keyingi urinish (chegara quyida).                                                                                                                           |
| `NOT_SENT`          | Qayta urinish. Oxirgi urinishda: urinish FAILED (`TON_NOT_SENT_<sabab>`) + buyurtma HELD `ADAPTER_ERROR` bitta tranzaksiyada (DB guard transfer bo‘lsa rad etadi → NEEDS_REVIEW), alert. |
| `STOPPED`           | `ORDER_NOT_PROCESSING` — tugadi; boshqasi — qayta urinish, oxirgisida NEEDS_REVIEW.                                                                                                      |
| throw               | Natija noma’lum: o‘sha urinish bilan qayta urinish; oxirgisida NEEDS_REVIEW (`ADAPTER_ERROR`), hech qachon HELD/FAILED/refund emas.                                                      |

**EXPIRED siyosati va urinishlar chegarasi (`MAX_SEND_ATTEMPTS = 2`).** EXPIRED dan keyin refund emas, **yangi urinish**: pul hamyondan chiqmagani isbotlangan, mijoz esa yetkazishni kutyapti. Lekin bitta buyurtmaga ko‘pi bilan 2 ta «yuborilmagani isbotlangan» urinish (bugun faqat TON EXPIRED; ta’minotchi uchun mos isbot turi S8 da paydo bo‘lsa — u ham); uchinchisi o‘rniga buyurtma HELD `ADAPTER_ERROR` + alert. Sabab: ikkinchi mustaqil zanjir manbasi (D-60 (2), S12) ulanmaguncha EXPIRED bitta provayderga tayanadi, soxta EXPIRED esa ikkinchi to‘lov demak; ketma-ket ikki «yuborilmadi» — nimadir buzilgan, qarorni odam yoki reconciler qiladi (HELD → bo‘shatish yoki `HELD_MAX_AGE` dan keyin FAILED + REFUND, S9). Hold urinishlari (limit, balans, manzil, `TON_NOT_SENT_*`) chegaraga kirmaydi. Chegara buyurtmaning butun hayoti uchun: HELD dan bo‘shatilgan buyurtma ikki EXPIRED dan keyin yana HELD bo‘ladi (S9 va operator buni biladi).

**Yuborishdan oldingi xatolar.** Router yoki `prepare` xatosi — job qayta urinadi; oxirgi urinishda HELD `ADAPTER_ERROR`. SENDING commit javobi yo‘qolsa: oxirgi bo‘lmagan urinishda keyingi run urinishni kuzatadi; **oxirgi urinishda** keyingi run yo‘q, shuning uchun buyurtma darhol yakunlanadi (yuqoridagi «Butunlay yiqilgan job»): urinish commit bo‘lgan bo‘lsa — NEEDS_REVIEW, bo‘lmagan bo‘lsa — yadro hold’i. SENDING kaliti rad etilsa (`STALE`) va buyurtmani boshqa run egallamagan bo‘lsa (PROCESSING, jonli urinish yo‘q) — HELD `ADAPTER_ERROR`, jim qolmaydi.

**HELD sabablari.** Yadro: `PRICE_ABOVE_MAX`, `NO_ADAPTER`, `LIMIT_PER_ORDER` (ta’minotchi), `ADAPTER_ERROR` (oxirgi urinishda prepare xatosi, `REFUSED`, noto‘g‘ri yo‘riqnoma yoki allowlist’dan tashqari manzil, PURCHASE yo‘q, urinishlar chegarasi, oxirgi urinishda `NOT_SENT`, rad etilgan SENDING, urinishsiz butunlay yiqilgan job). TON moduli (ikkinchi qatlam): `LIMIT_PER_ORDER`, `LIMIT_DAILY`, `LOW_BALANCE`, `ADAPTER_ERROR` (manzil allowlist’da yo‘q).

**Hold alerti refId.** Urinish hold’i (S5 ning imzodan oldingi hold’lari va `TON_NOT_SENT_*`): `<orderId>_<attemptId>` (S5 bilan bir xil id). Yadro hold’i (urinish yaratilmasdan): `<orderId>_<HELD OrderEvent.id>`; event note’i `core hold: ` bilan boshlanadi va replay shu bilan ajratadi. Mijozga `ORDER_REVIEW` buyurtmaga bir marta. Guruhlash (S12 dan oldin) faqat `heldNotices` ni o‘zgartiradi — ikkala tur uchun bir joy.

**HELD replay (CR m3).** Replay `pay()` ni **chaqirmaydi**: `pay()` buyurtma PROCESSING emasligini ko‘rishdan oldin hamyon qulfini oladi, bu esa boshqa buyurtmaning jonli to‘lovini WALLET_BUSY ga aylantirardi. S5 ning hold bildirishnomalari — `heldNotices` (xuddi shu id’lar), ularni yadro o‘zi yuboradi; urinish hold’i uchun buyurtmaning **eng oxirgi** urinishi olinadi (yadroda ham, S5 ning `tonHoldOf` ida ham, CR m4). e2e: bildirishnomalar o‘chiriladi, replay ularni qaytaradi, hamyon qulfiga murojaat 0, `sendBoc` = 0.

**Ta’minotchi NOT_SENT (CR M2, audit L-1).** Yadro adapter bergan isbotga o‘zi ishonmaydi: operator-only isbot (`MANUAL` — OWNER + OTP talab qiladi) va TON isbot turlari (ta’minotchi bizning zanjirimiz nomidan gapira olmaydi) rad etiladi. Ta’minotchi uchun mos isbot turi hali yo‘q (S8; sxema o‘zgarishi egadan so‘raladi), shuning uchun bugun har qanday ta’minotchi `NOT_SENT` → urinish UNKNOWN + NEEDS_REVIEW, ikkinchi `send` avtomatik ketmaydi. Ta’minotchiga idempotentlik kaliti = `orderId` (CLAUDE §5.4), `attemptNo` siz; simulyator ref’i `sim-<orderId>`. **S8 uchun (qayta sharh):** shu kalit bilan ta’minotchining **ikkinchi urinishi** `(adapter, externalRef)` unikal kalitiga uriladi → `STALE` → HELD `ADAPTER_ERROR`. S8 buni aniq tanlashi shart: ta’minotchi uchun `MAX_SEND_ATTEMPTS = 1` yoki o‘sha urinishni o‘sha kalit bilan qayta yuborish (yangi urinish qatori emas). Unikal kalit xatosiga tayanib bo‘lmaydi — u himoya qatlami, oqim emas. `confirm` ning DELIVERED/PENDING dan boshqa javobi — NEEDS_REVIEW.

**Replika va concurrency (5-bosqich sharti).** `fulfill-order` — **bitta worker replikasi, concurrency 1**: hamyon band bo‘lsa (`WALLET_BUSY`) `pay()` `NOT_SENT` qaytaradi va bu BullMQ urinishini sarflaydi; oxirgi urinishgacha band qolsa buyurtma HELD bo‘ladi. Bitta replika va concurrency 1 da hamyonni faqat shu jarayonning bitta run’i ushlaydi, shuning uchun bu amalda bo‘lmaydi. Replikalar qo‘shilishidan oldin WALLET_BUSY urinish sarflamasligi kerak (masalan, BullMQ `DelayedError` bilan kechiktirish yoki hamyon bo‘yicha alohida navbat) — bu shartsiz replika qo‘shilmaydi.

**Simulyator (dry-run).** Adapterlar ro‘yxati bitta fabrikada (`adapter-registry.ts`): `DRY_RUN=true` va production emas → `FRAGMENT` (TON bilan to‘lanadi) va `RESELLER_STARS` (USDT); aks holda bo‘sh (har buyurtma HELD `NO_ADAPTER`; haqiqiy adapterlar S8). Simulyator konstruktorlari production’da va `DRY_RUN=false` da istisno tashlaydi. Ssenariylar: `OK`, `PRICE_UP` (narx ×2), `NOT_FOUND`, `NOT_SENT`, `UNKNOWN`, `TIMEOUT`, `GOT_PREMIUM` (`simulator-script.ts`). `GOT_PREMIUM` — faqat Premium mahsulotda: tekshiruv hali `FOUND`, lekin `prepare` `RECIPIENT_REFUSED` qaytaradi (kotirovkadan keyin Premium paydo bo‘ldi → `FAILED` + `REFUND` `RECIPIENT_GONE`). Fragment simulyatori mahsulot turini slug bo‘yicha oladi (`fragmentProductKind`): Premium faqat 3/6/12 oy, boshqa uzunlikda `prepare` `REFUSED` (HELD). Faqat dry-run’da noma’lum slug Stars deb narxlanadi (test katalogi o‘z slug’ini ishlatishi uchun); haqiqiy adapter buni qilmaydi. Zanjir tomonidagi natijalar (tushdi, yo‘qoldi) `FakeTonGateway` da. Simulyator `providerRef` i `sim_<username>` — S3b `validate-recipient` simulyatori ham shuni beradi (normallashgan username bilan).

**Testlar.** `fulfill-crash.e2e-spec.ts` (to‘rt o‘lim nuqtasi, zanjirda bajarilgan ≤ 1), `fulfill-outcomes.e2e-spec.ts`, `fulfill-flow.e2e-spec.ts` (oqim, replay, parallel run’lar, DB fence, refund, run oxiri), `fulfill-retries.e2e-spec.ts` (`pay()` natijalari, chegara, ta’minotchi NOT_SENT → review), `fulfill-guards.e2e-spec.ts` (HAS_TRANSFER, PURCHASE yo‘q, yadrodagi `providerRef` tekshiruvi, allowlist’dan tashqari manzil, eng oxirgi urinish hold’i, rad etilgan SENDING → HELD), `fulfill-abandoned.e2e-spec.ts` (butunlay yiqilgan job: haqiqiy BullMQ Worker bilan ikki marta stalled va oxirgi urinishdagi istisno; `_abandoned` alerti haqiqiy review alertini yutmaydi; PAID dagi har yiqilish bir marta sanaladi), `fulfill-dry-run-net.e2e-spec.ts` (DB/Redis’dan boshqa tarmoq yo‘q).

## 5-faza S3b: `validate-recipient` processori

Kod: `apps/worker/src/recipients/**`, adapterlar: `apps/worker/src/adapters/adapters.module.ts`. API (`POST /recipients/validate`, docs/04) navbatga job qo‘shadi va `RECIPIENT_CHECK_TIMEOUT_MS` (10 s) kutadi; worker — Fragment yoki ta’minotchiga yeta oladigan yagona jarayon.

**Ishlash.**

1. Job ma’lumoti `RecipientCheckRequestSchema` bilan tekshiriladi. Mos kelmasa — bu producer va consumer orasidagi dasturiy xato: `UnrecoverableError` (qayta urinilmaydi, API failed job’ni ko‘rib 503 beradi), logda faqat Zod kodlari.
2. Muddat: javob API kutishni to‘xtatishidan `replyMarginMs` (1 s) oldin tayyor bo‘lishi kerak, ya’ni `job.timestamp + 10 s − 1 s`. Byudjet yuqoridan ham `10 s − 1 s` bilan cheklanadi: kelajakdagi `timestamp` (soat farqi) slotni API kutishidan uzoq ushlab turmaydi. Qolgan vaqt `minCallMs` (0,5 s) dan kam bo‘lsa — eski job, javobni hech kim kutmayapti: provider’ga bormasdan `UNAVAILABLE` (`STALE`).
3. Mahsulot DB’dan o‘qiladi; input mahsulotning `inputSchema` si bo‘yicha `normalizeRecipientInput` bilan qayta normallashtiriladi (himoya qatlami; mos kelmasa — 1-banddagi kabi `UnrecoverableError`).
4. Adapter fulfillment bilan bir xil router orqali tanlanadi (yoqilgan `ProductRoute`, priority, health = OK). `validateRecipient` dan oldin qolgan vaqt yana tekshiriladi: `minCallMs` dan kam bo‘lsa (DB yoki router sekin bo‘lgan) — provider chaqirilmaydi, `TIMEOUT`. Mahsulot o‘qish, router (health ham) va chaqiruv — hammasi bitta muddat ichida.
5. Javob `RecipientCheckResultSchema` bilan tekshiriladi (ism uchinchi tomon matni).
6. Processor adapter xatosida **throw qilmaydi**: javob har doim natija sifatida qaytadi. Navbatda `attempts: 1` (`queues.ts`), shuning uchun bugun throw qayta urinilmaydi; faqat `attempts > 1` bo‘lsagina BullMQ qayta urinardi, u ham API kutishni to‘xtatgandan keyin — behuda provider so‘rovi. Throw qilmaslik shu qiymatga bog‘liq bo‘lmagan himoya.
7. Muddat slotni bo‘shatadi va provider chaqiruvini ham to‘xtatadi (S7): `validateRecipient` ga `AbortSignal` uzatiladi, muddat tugaganda yoki lookup tugagach u abort qilinadi; abortdan keyin adapter yangi provider so‘rovi boshlamaydi. Bundan tashqari har adapter chaqiruvi o‘zi `ADAPTER_CALL_TIMEOUT_MS` (10 s) dan oshmaydi (`FragmentHttp` — `AbortSignal.timeout`).

**`UNAVAILABLE` holatlari (hech qachon «topilmadi» emas):** mahsulot yo‘q (`NO_PRODUCT`), nofaol (`INACTIVE`), mahsulot formasi buzilgan (`BAD_PRODUCT_INPUT`), yo‘nalish yo‘q yoki sog‘lom adapter yo‘q (`NO_ADAPTER`; production’da yoki `DRY_RUN=false` da haqiqiy adapterlar S8 gacha yo‘q, shuning uchun har tekshiruv shu — test bilan), muddat tugadi (`TIMEOUT`), adapter yoki DB istisnosi (`ERROR`), javob sxemaga mos emas (`BAD_ANSWER`), eski job (`STALE`).

**Tezlik va parallellik (konstantalar, env emas).**

- BullMQ `limiter`: **1 job/s**, barcha replikalar uchun umumiy (Redis’da). Fragment’ning ochiq API’si yo‘q; bot kabi ko‘ringan akkaunt sessiyasini yo‘qotishi mumkin, sessiya o‘lsa esa to‘langan buyurtmalar ham HELD bo‘ladi. Shuning uchun suiiste’mol paytida tekshiruvning 503 berishi sessiyani xavfga qo‘yishdan yaxshiroq. Limiter testlangan: metadata unit testi va e2e (darhol javob beradigan 3 job ≥ ~1 s oraliq bilan boshlanadi); limiter olib tashlansa ikkalasi yiqiladi.
- `concurrency` = 10 (= 10 s / 1 s) **job sloti**: har bir job o‘z muddatida tugaydi, shuning uchun provider osilib qolsa ham ~10 slot band bo‘ladi. Bitta sekin tekshiruv tezini to‘smaydi; provider’ga murojaat chastotasini faqat limiter cheklaydi.
- Limiter kvotasini **har job** yeydi — provider’ga bormaganlari ham (`STALE`, `NO_ADAPTER`, noto‘g‘ri javob, noto‘g‘ri so‘rov). Navbat to‘lganda hamma 503 oladi. API qulasa, u discard qilmagan job’lar sweep’gacha (≤ 60 + 30 s) kvota yeydi.
- Bir xil savollar (mahsulot + normallashgan input, 60 s oyna) bitta job’ni bo‘lishadi. Muddat birinchi qo‘shilgan job `timestamp` idan hisoblanadi, shuning uchun keyin qo‘shilgan foydalanuvchi `STALE` yoki 503 olishi mumkin (fail-closed; API `UNAVAILABLE` dan keyin job’ni o‘chiradi, shuning uchun qayta so‘rov yangi job oladi).
- Navbatni to‘ldirish (API: bir foydalanuvchiga bir vaqtda bitta tekshiruv, daqiqasiga 20): navbatdagi har job ~1 s kutish qo‘shadi. Muddat ~8,5 s, shuning uchun bir vaqtda faol **~9 dan ortiq** akkaunt (har biri o‘z javobini olgach darhol yangisini yuborsa) haqiqiy mijozning tekshiruvini 503 ga aylantiradi. Bu fail-closed: pul yo‘qolmaydi, Fragment sessiyasi himoyalangan. Kuchaytirish — egasining qarori (pastdagi «Ochiq»).

**Logs.** Faqat `productId`, adapter kodi, status, sabab va davomiylik (ms). Username, input, ism, `providerRef` va **job id** (username’ning kalitsiz hash’i, lug‘at bilan ochiladi) yozilmaydi. Xato matnidan faqat klass nomi olinadi (xabarida username bo‘lishi mumkin). `failedReason` — faqat qat’iy matn. Worker `error` hodisasi (yo‘qolgan lock, Redis xatosi: BullMQ matnida job id bor, tinglovchi bo‘lmasa BullMQ uni `console.error` ga chiqaradi) processor’da tinglanadi: faqat klass nomi, o‘zgarganda bir marta va ko‘pi bilan har 60 s da qayta.

**Saqlash tozalovi.** BullMQ `removeOnComplete/removeOnFail.age` ni faqat **boshqa** job tugaganda qo‘llaydi, job hash’ida TTL yo‘q. Trafik kam bo‘lsa oxirgi javob (username, ism, `providerRef`) Redis’da qolib ketardi. Events stream’ning `completed` yozuvlari ham javobni (ism, `providerRef`) ko‘chiradi va har yozuvda job id bor; stream’ning `maxLen` i uzunlikni cheklaydi, yoshni emas. `RecipientJobSweeper` har 30 s (boot’da ham):

- `queue.clean(60 s, …)` — `completed`, `failed`, hech kim olmagan `wait` va `prioritized` (API kelajakda priority bilan qo‘shsa) job’lari uchun;
- `XTRIM <events> MINID <Redis TIME − 60 s>` — aniq (`~` siz), Redis server soati bo‘yicha. API QueueEvents ≤ 10 s orqada o‘qiydi, 60 s unga zarar qilmaydi.

Job hash’i ham, uning stream yozuvlari ham job tugaganidan keyin ko‘pi bilan 60 + 30 s yashaydi. Oddiy taymer (unref, shutdown’da to‘xtaydi): shu navbatdagi repeatable job processor’ga tushardi. Xato — klass nomi bilan bitta warn, keyingi takt yana urinadi.

**Adapterlar ro‘yxati.** Bitta `AdaptersModule` (`SIMULATOR_SCRIPT`, `FULFILL_ADAPTERS`, `AdapterRouter`) — `FulfillmentModule` ham, `RecipientsModule` ham uni import qiladi. Tekshiruv va yetkazish bitta adapter nusxasidan (S7/S8 dan — bitta provider sessiyasidan) foydalanadi.

**Simulyator username shakllari (dev va test, ssenariy `OK`).** Hammasi normallashgan shaklda (`@` siz, kichik harf):

| Username       | Natija                                                                                                                                                                             |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `notfound_*`   | `NOT_FOUND` (shunday qabul qiluvchiga `prepare` — `RECIPIENT_GONE`)                                                                                                                |
| `slowcheck_*`  | 15 s kutadi (API kutishidan uzoq) → worker muddatida `UNAVAILABLE`                                                                                                                 |
| `haspremium_*` | faqat Premium (`telegram-premium`): `REFUSED` `HAS_PREMIUM` (API `422 RECIPIENT_HAS_PREMIUM`), shunday qabul qiluvchiga `prepare` — `RECIPIENT_REFUSED`; boshqa mahsulotda `FOUND` |
| `premiumext_*` | faqat Premium: `FOUND` + `PREMIUM_EXTENDS` ogohlantirishi; boshqa mahsulotda oddiy `FOUND`                                                                                         |
| boshqasi       | `FOUND`, `providerRef = sim_<username>`, `displayName` = username                                                                                                                  |

`username` maydoni yo‘q yoki bo‘sh — har ssenariyda `UNAVAILABLE` (savolning o‘zi buzilgan, fail-closed). Telegram username bo‘la olmaydigan qiymat (`x`, `1abc`) — `NOT_FOUND` (haqiqiy provider ham shunday ismli odamni topmaydi). FOUND berilgan har username uchun `prepare` qayta tekshiruvi `null`, shuning uchun dry-run buyurtma `RECIPIENT_CHANGED` bilan refund bo‘lmaydi. Ssenariylar (`NOT_FOUND`, `UNKNOWN`, `TIMEOUT`) avvalgidek.

**Testlar.** Unit: `validate-recipient.processor.spec.ts`, `validate-recipient-bounds.spec.ts` (limiter/concurrency metadata, worker error listener, muddat chegaralari: kelajakdagi timestamp, sekin DB, osilgan `health()`, `<` chegarasi, `dispose`), `recipient-job-sweeper.spec.ts`, `recipients-production.spec.ts` (production simoni → `NO_ADAPTER`), `simulated-validation.spec.ts`. E2e (haqiqiy BullMQ Worker, job’lar API qo‘shgandek): `validate-recipient.e2e-spec.ts` (shakllar, normallashtirish, muddat, concurrency, limiter, eski job, log satrlari), `validate-recipient-failsafe.e2e-spec.ts` (adapter xatosi — bitta urinish; yo‘nalish/health/mahsulot → `UNAVAILABLE`; noto‘g‘ri so‘rov; tarmoq guard), `validate-recipient-errors.e2e-spec.ts` (worker error va haqiqatan yo‘qolgan lock → stderr toza, logda job id yo‘q), `validate-recipient-sweep.e2e-spec.ts` (boshqa job tugamasa ham job va stream yozuvlari o‘chadi), `validate-recipient-worker.e2e-spec.ts` (butun `WorkerModule`, `logDestination` bilan loglarda shaxsiy ma’lumot yo‘q).

**S7/S8 darvozalari (haqiqiy Fragment/reseller adapteridan oldin).**

- ~~`providerRef` qaysi adapterdan kelgani saqlanmaydi~~ — S7 da yopildi (CR #2, quyida "5-faza S7").
- ~~Provider chaqiruviga `AbortSignal` va adapterning o‘zida qattiq timeout~~ — S7 da yopildi (I-1).
- ~~Router har lookup’da `health()` ni chaqiradi~~ — S7 da 5 s kesh (I-1).
- Provider chaqiruvi atrofida token bucket (provider’ga bormaydigan job’lar kvota yemasin).
- Fragment so‘rovlari hajmiga shift va alert (audit M-2; ega qarori, yangi alert turi va i18n kerak).

**Ochiq (egasi uchun).** Navbatni to‘ldirishga qarshi kuchliroq himoya (audit M-1): ishonchsiz akkauntlar uchun API’da priority va umumiy byudjet, foydalanuvchilar bo‘yicha adolatli navbat (BullMQ Pro groups — yangi qaramlik) yoki Fragment chidasa limiter’ni oshirish (masalan 2/s → ~17 akkaunt kerak bo‘ladi).

## 5-faza S7: Fragment sessiyasi, keep-alive, health va zaxiraga o‘tish

**Saqlash.** `FragmentSession.cookiesEnc` — cookie jar **va** sahifa `hash` bitta AES-256-GCM blob’da (AAD `ggpin/fragment-session/v1`); ochiq `pageHash` ustuni ataylab `NULL` qoladi. Kalit — `FRAGMENT_SESSION_ENC_KEY_FILE` (Docker secret, D-52 D3); inline `FRAGMENT_SESSION_ENC_KEY` faqat dev/test, ikkalasi birga — rad. Dry-run’da kalit umuman o‘qilmaydi (reja §8). Har javobdagi `Set-Cookie` jar’ga qo‘llanadi va blob qayta yoziladi (faqat o‘sha qator va o‘sha status bo‘lsa — eski jar yangi importni bosib ketmaydi). Boshqa domen, noto‘g‘ri nom/qiymat, 32 tadan ortiq cookie — e’tiborsiz. Bitta ACTIVE qator (partial unique).

**HTTP.** `FragmentHttp` — fragment.com’ga yagona eshik: `fetch` tashqaridan beriladi (Node fetch faqat dry-run o‘chiq bo‘lganda), faqat `https://fragment.com` (port, login, boshqa host — `FOREIGN_HOST`, fetch chaqirilmaydi), `redirect: 'manual'` (har 3xx — `REDIRECT`), body bilan birga qattiq timeout (≤ `ADAPTER_CALL_TIMEOUT_MS` = 10 s) va javob hajmi chegarasi (2 MiB). Xato xabarida faqat kod — URL query, cookie yoki body yo‘q.

**Keep-alive** (`fragment-keepalive` navbati, scheduler id `fragment-keepalive:check`, `FRAGMENT_KEEPALIVE_EVERY_MS`, standart 20 daqiqa):

| Holat                     | Natija                                                                                                                           |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| ACTIVE, sahifa login      | `lastOkAt`, `lastError` tozalanadi, Redis `fragment:health=ok` (TTL = 3 davr)                                                    |
| ACTIVE, 1-xato            | `lastError` = kod, hali ACTIVE (bitta uzilish — o‘lim emas)                                                                      |
| ACTIVE, ketma-ket 2-xato  | `DEAD` + `deadAt` (CAS), Redis `down`, `fragmentSessionDead`, sessiya umri loglanadi, router keshi tashlanadi                    |
| ACTIVE yo‘q, oxirgi o‘lim | dead alert yana (o‘sha id — BullMQ tashlab yuboradi), Redis `down`; sahifa yana login bo‘lsa — ACTIVE, `fragmentSessionRestored` |
| Yangi import, birinchi OK | oldingi o‘lim uchun `fragmentSessionRestored`                                                                                    |
| Hech qanday sessiya       | Redis kaliti o‘chiriladi (API: `disabled`)                                                                                       |

Bitta o‘lim — bitta alert: `refId` = `<sessionId>_<deadAt ms>`, holat o‘tishlari compare-and-set (ikki replika bir vaqtda ko‘rsa ham bitta o‘lim). Import bilan almashtirilgan qator `DEAD` + `lastError=REPLACED`, `deadAt` bo‘sh — bu o‘lim emas, alert yo‘q, qayta tiklanmaydi. Login holati Zod bilan tekshiriladi: login belgilari + API `hash` bo‘lsa `LOGGED_IN`, login tugmasi bo‘lsa `LOGGED_OUT`, aks holda `BAD_PAGE` (fail-closed). Belgilar hali S0b taxminlari; testlar **sintetik** sahifalarda (`synthetic-fragment-pages.ts`), S8 ularni egasining yozib olingan sahifalari bilan almashtiradi. Dry-run’da keep-alive sintetik sahifani tekshiradi va blob’ni ochmaydi; production + dry-run’da umuman ishlamaydi.

**Health.** Worker: `FragmentHealth.read()` faqat DB bo‘yicha hal qiladi (S7 m2): ACTIVE → `ok`, DEAD (oxirgi o‘limdan keyin ACTIVE yo‘q) → `down`, hech narsa → `disabled`. Redis kaliti — API uchun; shuning uchun o‘limdan keyin import qilingan sessiya worker’da darhol (router keshi ≤ 5 s) ishlatiladi, API’dagi `down` esa keep-alive’ning keyingi qarashigacha (≤ 1 davr) qoladi. Haqiqiy Fragment adapteri (S8) faqat `ok` da OK; dry-run Fragment simulyatori faqat `down` da DOWN (sessiyasiz dev Stars’ni FRAGMENT’ga yuboraveradi). API `/health/ready`: `fragment` Redis’dan — `ok`/`down`, kalit yo‘q → `disabled` (worker hali yozmagan: dev, test, dry-run), o‘qib bo‘lmasa yoki timeout → `down`. Umumiy `status` ga ta’sir qilmaydi (zaxira provayder bor), javob shakli o‘zgarmadi (docs/04).

**Router va zaxiraga o‘tish.** Buyurtma faqat **o‘z narx valyutasidagi** adapterlarga taklif qilinadi (`FulfillmentAdapter.costCurrency`, S7 M1): bu filtr hammasidan oldin — emitent ustunligi va qayta tekshiruvdan oldin, hech qaysi provider’ga murojaat qilinmasdan. TON narxli buyurtma USDT reseller’ga hech qachon berilmaydi (u to‘lay olmaydi, tannarx chegarasi bilan solishtirib bo‘lmaydi). Mos adapter yo‘q yoki sog‘lom emas → `HELD NO_ADAPTER`, `validate` ham `prepare` ham chaqirilmaydi, refund yo‘q. Lookup (buyurtma hali yo‘q) valyutasiz tanlaydi.

**O‘tish oynasi.** Fragment o‘lishidan oldin TON’da narxlangan buyurtmalar o‘limdan keyin `HELD NO_ADAPTER` bo‘ladi (zaxira USDT’da). Cost-sync keyingi ishga tushishida mahsulotni zaxira narxida narxlaydi, yangi buyurtmalar USDT’da bo‘ladi va zaxira orqali yetkaziladi. HELD `NO_ADAPTER` qolganlar Fragment qaytganda (yangi import yoki tiklanish) reconciler HELD qadamida bo‘shatiladi (shartlar va chegaralar — «5-faza S9: reconcile», HELD siyosati); operator `order:retry` ham ishlaydi.

Oyna ichidagi ssenariy (S7 re-review N3, qabul qilingan):

1. Fragment o‘lgach lookup darhol `RESELLER_STARS:` handle’ini beradi, mahsulot snapshot’i esa hali TON bo‘lishi mumkin — cost-sync keyingi ishga tushguncha (≤ 5 daqiqa; zaxira narxlamaydigan mahsulotda — snapshot eskirguncha, ≤ 30 daqiqa).
2. Shu oraliqda olingan quote — TON, handle — `RESELLER:` → buyurtma `HELD NO_ADAPTER` (TON adapteri DOWN, zaxira boshqa valyutada).
3. Fragment qaytgach buyurtma qayta ochilsa, Fragment handle’ni ism bo‘yicha qayta tekshiradi; tasdiq `RECHECK_MAX_AGE_MS` dan eski bo‘lsa → `HELD ADAPTER_ERROR`.
4. Pul yo‘qolmaydi (PURCHASE turadi, hech narsa yuborilmagan); buyurtmani operator yoki S9 hal qiladi.

**S9g (D-62 (4), D-64 (8)) — yuqoridagi oyna yopildi.** Lookup endi mahsulotning eng yangi, eskirmagan (fresh) `CostSnapshot` valyutasidagi adapterni tanlaydi (`router.pick(product.id, null, snapshot.adapter, snapshot.currency)`, `recipient-lookup.service.ts`). Shu valyutada sog‘lom adapter yo‘q bo‘lsa — `UNAVAILABLE` (`NO_ADAPTER`, API `503`), boshqa valyutadagi adapterga tushilmaydi; paketlar har xil valyutada narxlansa — ham `UNAVAILABLE`. Snapshot yo‘q yoki eskirgan bo‘lsa — avvalgi (valyutasiz) tanlov, chunki API baribir narx bermaydi (`503 PRICE_UNAVAILABLE`). Shu sababli yuqoridagi 1–2-qadamlar (TON narxli quote + `RESELLER:` handle) endi yuzaga kelmaydi; 3–4 faqat oldin yozilgan buyurtmalar uchun.

`AdapterRouter.pick` faqat sog‘lom adapterni tanlaydi; `health()` har adapter uchun 5 s keshlanadi, 2 s da javob bermasa — sog‘lom emas (I-1); keep-alive holat o‘zgarganda shu jarayonning keshini darhol tashlaydi, boshqa replikalar ≤ 5 s da ko‘radi. Dry-run’da zaxira — `RESELLER_STARS` simulyatori. Production’da haqiqiy zaxira hali yo‘q: urinishsiz buyurtma `HELD NO_ADAPTER` + alert, tekshiruv — `UNAVAILABLE` (API 503).

- Hal bo‘lmagan urinishli buyurtma (SENDING/SENT/UNKNOWN) hech qachon routerga bormaydi — faqat kuzatiladi (rules/45 2-qadam).
- **CR m6:** urinishi bor buyurtma, hatto urinish **yuborilmagani isbotlangan** bo‘lsa ham (`FAILED`, masalan `TON_EXPIRED`), o‘sha adapterda qoladi. U adapter DOWN bo‘lsa — `HELD NO_ADAPTER`, zaxiraga o‘tmaydi (operator hal qiladi). Sabab: buyurtma yarim yo‘lda boshqa provayderga ko‘chmasin, ikki provayderda ikki xil iz qolmasin.
- **Adapter chaqiruvi.** `validateRecipient(product, input, signal)` — `AbortSignal` majburiy; lookup muddati tugaganda yoki lookup tugagach signal abort qilinadi; adapter o‘zi ham `ADAPTER_CALL_TIMEOUT_MS` dan oshmasligi shart.

**Qabul qiluvchi handle’i kimniki (CR #2, D-62 nomzodi).** Lookup `providerRef` ni `<ADAPTER_CODE>:<handle>` ko‘rinishida saqlaydi. Yetkazish emitentni (handle bergan adapter) birinchi tanlaydi (sog‘lom va route yoqilgan bo‘lsa). Boshqa adapter tanlansa (emitent DOWN), hech narsa yuborilmasdan oldin u qabul qiluvchini **qayta tekshiradi** (mijoz kiritgan maydonlar bilan):

- displayName — evristika, identifikator emas: ikki adapterning umumiy id fazosi yo‘q, solishtirsa bo‘ladigan yagona narsa — mijoz ko‘rgan ism. U NFC, trim va ichki bo‘shliqlarni bittaga siqishdan keyin solishtiriladi;
- ism vaqt o‘tib boshqa akkauntga o‘tishi mumkin (username bo‘shatilib, boshqasi olgan), shuning uchun faqat ism bo‘yicha moslik tasdiq yangi bo‘lsagina ishonchli: `order.createdAt` dan `RECHECK_MAX_AGE_MS` (30 daqiqa, konstanta: quote 10 daqiqa yashaydi, fulfill navbatining 5 urinishi ~75 s da tugaydi, qolgani — navbat tiqilinchi uchun zaxira) o‘tgan bo‘lsa (masalan soatlab HELD turgan buyurtma `order:retry` bilan ochilganda), provider so‘ralmaydi → `HELD ADAPTER_ERROR` (operator hal qiladi); emitentning o‘zi esa (ism emas, o‘z handle’i) yoshidan qat’i nazar ishlaydi;
- yosh `Order.createdAt` dan (DB soati) hisoblanadi, lookup’dan emas: ism lookup’i buyurtmadan taxminan 20 daqiqagacha oldin bo‘lishi mumkin (tasdiq tokeni 10 daqiqa + quote 10 daqiqa), demak ismning amaldagi yoshi ~50 daqiqagacha yetadi (S7 re-review N8). `createdAt` worker soatidan `RECHECK_CLOCK_TOLERANCE_MS` (5 daqiqa, konstanta) dan ko‘proq oldinda bo‘lsa (worker soati orqada), yoshga ishonilmaydi → xuddi eski tasdiqdek `HELD ADAPTER_ERROR` (audit N-2);
- FOUND va displayName mijoz tasdiqlaganiga teng → o‘sha adapter handle’i ishlatiladi, urinish `request` ida `recheckedProviderRef` saqlanadi (kuzatish yo‘li shuni oladi);
- NOT_FOUND yoki boshqa ism → `FAILED` + REFUND (`RECIPIENT_CHANGED`), urinish yaratilmaydi;
- UNAVAILABLE, xato, timeout, tushunarsiz javob → throw (job qayta urinadi, oxirgisida `HELD ADAPTER_ERROR`). Tekshirilmagan handle’ga hech qachon to‘lanmaydi.

Namespace’siz eski handle (S7 dan oldin yozilgan) o‘zgarmay uzatiladi. Sxema, migratsiya va shartnoma o‘zgarmadi.

**Import CLI.** `npm run fragment:session-import -w worker`: cookie’lar faqat stdin’dan (asosiy yo‘l — yashirin TTY kiritish; fayl ishlatilsa — faqat repo tashqarisidan va darhol o‘chiriladi; argument va env — yo‘q), `name=value` qatorlari yoki brauzer `Cookie:` sarlavhasi. Shifrlanadi, oldingi ACTIVE qator `REPLACED` bo‘ladi va undan eski barcha qatorlarning cookie’lari o‘chiriladi (`cookiesEnc = ''`, audit I-2: ular endi hech qachon ishlatilmaydi). Ekranga faqat soni, cookie **nomlari**, yangi qator id va kalit barmoq izi (`HMAC(key, "ggpin/fragment-session/fp")` ning 8 hex belgisi; worker boot’da ham shuni loglaydi — kalitlar bir xilligini ko‘rish uchun) chiqadi; xato faqat qator raqamini aytadi. Sahifa `hash` so‘ralmaydi — keep-alive birinchi login sahifasidan oladi. `.gitignore` — `*cookie*.txt`, `*cookie*.json`; gitleaks — `fragment-cookie-bare` qoidasi (`stel_ssid`/`stel_token`/`stel_ton_token`/`stel_dt`, `=` atrofida bo‘shliq bo‘lishi mumkin, 8+ belgi; audit N-4).

**Set-Cookie saqlash (CAS).** Keep-alive yangilangan jar’ni faqat o‘qilgan qatorga va faqat u o‘qilgandan beri o‘zgarmagan bo‘lsa yozadi: `id`, `status` va **o‘qilgan blob**ning o‘zi bo‘yicha (audit N-1). Shunda probe paytida import bo‘lsa, eski cookie’lar tombstone’ga qayta yozilmaydi, ikki replika bir vaqtda yozsa — ikkinchisi yutqazadi (birinchisining yangilanishi yo‘qolmaydi).

**Jonli boot (dry-run o‘chiq).** `FRAGMENT_SESSION_ENC_KEY_FILE` (yoki production’dan tashqari inline kalit) majburiy (audit L-4, hamyon kaliti naqshi). Node HTTPS’ni zaiflashtiradigan yoki yo‘naltiradigan env rad etiladi (audit L-2): `NODE_TLS_REJECT_UNAUTHORIZED=0`, `NODE_EXTRA_CA_CERTS`, `NODE_USE_SYSTEM_CA`, `NODE_USE_ENV_PROXY`, `SSL_CERT_FILE`, `SSL_CERT_DIR`, `OPENSSL_CONF`, `HTTP(S)_PROXY`, `ALL_PROXY` (kichik harfli shakllari ham; ro‘yxat yozib olish vositasi bilan umumiy — `network-env.ts`), shuningdek `NODE_OPTIONS` yoki buyruq qatoridagi (`process.execArgv`) `--use-system-ca`, `--use-openssl-ca`, `--use-env-proxy` flaglari (audit N-3). `NODE_OPTIONS` ning boshqa qiymatlari (masalan heap hajmi) rad etilmaydi; `--require`/`--import` ham — jarayon env’ini boshqargan kishi baribir o‘z kodini ishga tushira oladi, bu ro‘yxat noto‘g‘ri sozlangan CA/proxy’dan himoya qiladi. Sessiya kaliti hamyon kalitiga (`WALLET_ENC_KEY`) teng bo‘lsa boot rad etiladi (audit I-11; doimiy vaqtli solishtirish, qiymat chiqmaydi). `FragmentHttp` ichida alohida `https` Agent o‘rniga shu tanlandi: rad etish jarayonning har Node so‘roviga taalluqli, CA o‘zgaruvchisi esa alohida Agent’ga ham ta’sir qilardi. Keep-alive logida `NO_KEY` va `BAD_BLOB` o‘z kodlari bilan alohida error qatori oladi (`FRAGMENT_SESSION_NO_KEY`, `FRAGMENT_SESSION_BAD_BLOB`); egaga alert matni o‘zgarmagan. Cookie jar faqat `Domain=fragment.com` (yoki `.fragment.com`) ni qabul qiladi, subdomenni emas (audit I-4).

**Testlar.** Unit: `fragment-http.spec.ts`, `fragment-session-crypto.spec.ts`, `fragment-probe.spec.ts`, `fragment-health.spec.ts`, `provider-ref.spec.ts`, `fulfill-recipient.spec.ts`, `adapter-router.spec.ts`, `recipient-lookup.service.spec.ts`, `env-fragment-session.spec.ts`, `fragment-session-import-flow.spec.ts`. E2e: `fragment-keepalive.e2e-spec.ts` (jonli probe soxta fetch bilan: shifrlangan `Set-Cookie`, bitta o‘lim — bitta alert, ikki replika, tiklanish, import, loglarda cookie/hash/sahifa yo‘q), `fragment-failover.e2e-spec.ts` (5-mezon real oqimda: DEAD → bitta alert → cost-sync zaxira narxi (USDT) → lookup → shu narxdagi quote/buyurtma (API’ning shared narx funksiyalari bilan; faraz qilinganlar `fulfill-e2e.quote.ts` da) → `RESELLER_STARS` orqali DELIVERED; o‘tish oynasi: TON buyurtma → `HELD NO_ADAPTER`, zaxira chaqirilmaydi; emitent zaxira + TON + Fragment sog‘lom → Fragment qayta tekshiradi va yetkazadi; CR #2 FOUND/NOT_FOUND; eski tasdiq → HELD; tarmoq qo‘riqchisi), `fragment-failover-attempts.e2e-spec.ts` (hal bo‘lmagan va EXPIRED Fragment urinishli buyurtma ko‘chmaydi; M3: bir xil valyutadagi sog‘lom ikkinchi adapterga ham ko‘chmaydi), `fragment-session-edges.e2e-spec.ts` (yo‘qolgan dead alert keyingi tickda bitta; o‘limdan keyingi import darhol sog‘lom; tombstone; CAS — tombstone’ga yozilmaydi, ikki parallel yozuvdan bittasi yutadi; `NO_KEY`/`BAD_BLOB` loglari; barmoq izi). Eski tasdiq e2e’si worker’ning butun soatini (faqat `Date`, taymerlar emas) 2 soat oldinga suradi. Unit: `cost-sync-health.spec.ts` (sog‘lom route bo‘yicha narx).

## 5-faza S9: reconcile (buyurtma reconciler'i)

Kod: `apps/worker/src/reconcile/orders/**` (qadamlar), TON tomoni — `apps/worker/src/ton/ton-late*.ts` va `ton-tx-hint.verifier.ts`; doimiylar — `packages/shared/src/orders/reconcile-config.ts`; env — `apps/worker/src/config/order-reconcile-env.ts`. Qarorlar — `docs/13` D-64. Alertlar va refId formatlari — `docs/07`. Reconciler **hech qachon imzolamaydi, `pay()` ni chaqirmaydi, `lock:ton-wallet` ni olmaydi va `TIMEOUT` yozmaydi**: pul faqat `failAndRefundOrder` va `resolveNeedsReview` orqali harakatlanadi; TON ma’lumotini faqat TON moduli (`TonConfirmService`, `TonLateService`) o‘qiydi va yozadi.

### Tik va qadamlar tartibi

`reconcile` navbati (`QUEUES.RECONCILE`), job nomi `orders`, scheduler id `reconcile:orders` (`order-reconcile.scheduler.ts`), davr — `ORDER_RECONCILE_EVERY_MS` (standart 600 000 ms = 10 daqiqa; chegara 60 000 … 3 600 000 ms). Processor `concurrency: 1` (bitta jarayonda ikki tik ustma-ust tushmaydi); ikki worker jarayoni to‘qnashsa, buyurtma qulflari va DB compare-and-set buni zararsiz qiladi. Tik DB soatini **bir marta** o‘qiydi, barcha oynalar shu soat bo‘yicha o‘lchanadi (jarayon soati emas). Har qadam o‘z `try/catch` ida: bittasi yiqilsa, qolganlari ishlaydi (`order-reconcile.service.ts`). Qadamlar `RECONCILE_STEPS` (`order-reconcile.module.ts`) tartibida, har biri tikda ko‘pi bilan `RECONCILE_BATCH_LIMIT` = 100 qator:

| №   | Qadam (`name`)  | Nima qiladi                                                                                                                                                                                                                                                                     |
| --- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `transfers`     | Shu hamyon va tarmoqdagi `SIGNED`/`BROADCAST` ORDER transferlariga zanjirda bitta qarash (`TonConfirmService.check`), buyurtma qulfi ostida. Fulfill run shu transferni kutayotgan bo‘lsa (BUSY) — run'ga qoldiriladi. Boshqa hamyon/tarmoq transferi faqat sanaladi            |
| 2   | `review`        | `NEEDS_REVIEW` buyurtmalar (eskidan yangiga, kursor aylanadi): saqlangan zanjir dalili bo‘yicha `TON_TX` → DELIVERED yoki `TON_NOT_SENT` → FAILED + REFUND; aks holda egaga qoladi                                                                                              |
| 3   | `stale`         | `PAID`/`QUEUED`/`PROCESSING` buyurtma 10 daqiqa (`ORDER_STALE_AFTER_MS`) o‘zgarmay, `fulfill-order` job'i tirik bo‘lmasa — faqat `FulfillEnqueuer` orqali qayta navbatga. Abandon hisobi chegaraga yetgan buyurtma qayta qo‘yilmaydi: `needsReview` `<orderId>_abandoned_<kun>` |
| 4   | `lockStuck`     | `lock:order:{id}` bir xil egada ≥ 30 daqiqa (`ORDER_LOCK_STUCK_AFTER_MS`, ikki tik bilan isbotlangan) tursa va buyurtma shuncha vaqt o‘zgarmasa — egaga `needsReview` `<orderId>_lock_<soat>`; kalit **hech qachon o‘chirilmaydi**                                              |
| 5   | `noticeResend`  | `HELD`/`NEEDS_REVIEW` xabarlari (mijoz va ega) shu holatga kirganiga < 24 soat (`REVIEW_NOTICE_RESEND_WINDOW_MS`) bo‘lsa, o‘sha barqaror id'lar bilan qayta navbatga qo‘yiladi (BullMQ dublikatni tashlaydi)                                                                    |
| 6   | `held`          | `HELD` buyurtmalar: muddati o‘tgan → FAILED + REFUND, sababi yo‘qolgan → `HELD → QUEUED` (quyida — HELD siyosati)                                                                                                                                                               |
| 7   | `walletBlocked` | `TON_CONFIRM_TIMEOUT_MS` dan oshib hamyonni bloklab turgan transfer haqida eslatma: `tonWalletBlocked` `<transferId>_wb_<n>`, har `WALLET_BLOCKED_REMIND_EVERY_MS` = 6 soatda (blokdan sanaladi); faqat o‘qish                                                                  |
| 8   | `late`          | Kech zanjir faktlari (quyida): ONCHAIN_FAILED, Z6 hint, kech CONFIRMED, kech bounce / abort                                                                                                                                                                                     |
| 9   | `auditEffects`  | AuditLog bo‘yicha yo‘qolgan after-commit effektlarni tiklash (quyida)                                                                                                                                                                                                           |

Hamma qadam uchun umumiy qoidalar:

- Har buyurtma `lock:order:{id}` ostida ko‘riladi; qulf band (BUSY) bo‘lsa — shu tikda tegilmaydi. Redis qulfni bera olmasa — qadam **to‘xtaydi** (fail-closed), qolgan qadamlar davom etadi.
- Holat yoki pul yozuvi faqat shared helper'lar orqali va CAS bilan: operator `order:retry` yoki parallel tik bilan poygada bittasi yutadi (`StaleOrderStateError` — jim no-op).
- `GG001` (DB qo‘riqchisi) → `reconcileGuardRefused`; shu tikda qayta urinilmaydi, jim yutilmaydi.
- `PURCHASE` yozuvi yo‘q yoki summasi `priceTiyin − discountTiyin` ga teng emas → `orderNoPurchase` (kritik): buyurtma faqat egada qoladi, avtomatik bo‘shatish ham, refund ham yo‘q.
- Jurnalga faqat id va sonlar yoziladi (summa, username, manzil — yo‘q).

### NEEDS_REVIEW: reconciler ishlatadigan ikki isbot

Qaror — `review-evidence.ts` (sof funksiya), yozuv — `review-resolver.ts` → `resolveNeedsReview`; commit'dan keyin mijozga xabar, refund bo‘lsa kesh `DEL`, egaga `reviewResolved` (`<orderId>_<auditId>`).

- **`TON_TX` → DELIVERED:** aynan bitta transfer `CONFIRMED` (tx bilan), qolganlari `EXPIRED`, uning urinishi — buyurtmaning yagona hal bo‘lmagan urinishi.
- **`TON_NOT_SENT` → FAILED + REFUND:** **hamma** transfer `EXPIRED` va har biri o‘ziga bog‘langan ikkita kuzatuvga (`response.ton.expiry.first/second`) ega.
- Isbotsiz egaga qoladi: witness nizosi yoki SUSPECT fakti bo‘lgan; hal bo‘lmagan transfer; `BOUNCED`; `ONCHAIN_FAILED`; transfersiz hal bo‘lmagan urinish; boshqa hamyon/tarmoq transferi. `CONSUMED_UNMATCHED` — faqat `tonConsumedUnmatched` eslatmasi (`<transferId>_cu_<soat>`).
- **Kech topilgan transfer isbot emas** (audit I-5): `late` belgili transfer yoki `lateBounce`/`lateDestination` faktli `CONFIRMED` transfer reconciler uchun SUSPECT bilan teng — faqat `tonLateConfirmed` alerti chiqadi, buyurtmani ega hal qiladi.

### HELD siyosati

`held-release-policy.ts` (sof funksiya; manbalar DB yoki config'dan o‘qiladi, provayderga so‘rov yo‘q), qadam — `held-sweep.step.ts`. Buyurtma qulf ostida qayta o‘qiladi. Ikki bosqich: (1) `triageHeld` — manbasiz; (2) `releaseVerdict` — faqat bo‘shatiladigan sabablar uchun. Muddat **oxirgi** HELD hodisasidan, DB soati bo‘yicha sanaladi, chegara `>=` (aynan `HELD_MAX_AGE_MS` — allaqachon uzoq).

| Holat / sabab                                                                                              | Natija                | Izoh                                                                                                                                                                              |
| ---------------------------------------------------------------------------------------------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PURCHASE` yozuvi mos emas                                                                                 | **keep** (egaga)      | `orderNoPurchase`; hech qachon refund yoki bo‘shatish yo‘q                                                                                                                        |
| Buyurtmada kech zanjir fakti (`late` / `lateDestination`)                                                  | **keep** (egaga)      | `reconcileGuardRefused` `<orderId>_heldlate_<kun>` (kuniga bir marta). Pul chiqib ketgan bo‘lishi mumkin: refund ham, qayta urinish ham yo‘q                                      |
| `EXPIRED` dan boshqa holatdagi transfer                                                                    | **keep** (egaga)      | `reconcileGuardRefused` `<orderId>_heldlive_<kun>`. Faqat guard'lar chetlab o‘tilgandagina bo‘ladi                                                                                |
| Oxirgi HELD hodisasidan `HELD_MAX_AGE_MS` (6 soat) o‘tdi — **har qanday sabab**                            | **refund**            | `failAndRefundOrder` (`HELD_EXPIRED`): bir tranzaksiyada FAILED → REFUNDED; commit'dan keyin kesh `DEL`, mijozga `ORDER_REFUNDED`, egaga `heldExpiredRefunded` (refId = buyurtma) |
| `ADAPTER_ERROR` (urinishlar chegarasi, rad etilgan SENDING, eskirgan qayta tekshiruv…) yoki noma’lum sabab | **keep**              | Hech qachon avtomatik bo‘shatilmaydi (D-64 (4)); muddat o‘tgach faqat refund                                                                                                      |
| Reconciler buyurtmani allaqachon 3 marta bo‘shatgan                                                        | **keep**              | `HELD_AUTO_RELEASE_MAX` = 3; hisob — `OrderEvent` dagi `reconcile release: <SABAB>` yozuvlari (migratsiyasiz). Keyin ega yoki muddat refund'i                                     |
| `NO_ADAPTER`, `PRICE_ABOVE_MAX`, `LIMIT_PER_ORDER`, `LIMIT_DAILY`, `LOW_BALANCE`                           | **release** yoki keep | Pastdagi umumiy tekshiruvlarning **hammasi** o‘tsagina `HELD → QUEUED`                                                                                                            |

`releaseVerdict` tekshiruvlari (birortasi bajarilmasa — keep; run baribir yana HELD qilardi va bo‘shatishlardan birini yeb qo‘yardi):

- **Marshrut** (hamma sabab uchun): `router.pick(product, oldingi adapter, emitent, valyuta)` bo‘sh bo‘lmasin (`noRoute`). Handle boshqa adapter bergan bo‘lsa — buyurtma yoshi `RECHECK_MAX_AGE_MS − 5 daqiqa` (25 daqiqa) dan kichik bo‘lsin, aks holda run qayta tekshirishni rad etadi (`recheckStale`).
- **Narx:** shu adapterning yangi (fresh) `CostSnapshot` i bo‘lsa u `maxCost` dan oshmasin (`price`); `PRICE_ABOVE_MAX` uchun yangi snapshot majburiy (`noCost`).
- **Summa:** buyurtma tannarxi va oxirgi urinishdagi tannarxning kattasi (yangi snapshot kattaroq bo‘lsa — u) ≥ 1.
- **TON buyurtma:** `checkTonLimits` (bitta buyurtma va rolling 24 soat) — `limit`; yangi `WalletSnapshot` bo‘lsa balans to‘lov + komissiya zaxirasini qoplasin (`balance`); snapshot yo‘q bo‘lsa (dry-run yozmaydi) faqat `LOW_BALANCE` keep (`noBalance`).
- **USDT (ta’minotchi) buyurtma:** summa `SUPPLIER_MAX_PER_ORDER_MICRO_USDT` dan oshmasin; `LIMIT_DAILY` va `LOW_BALANCE` USDT uchun hech qachon bo‘shatilmaydi (`notReleasable`).

Bo‘shatish — `transitionOrder(HELD → QUEUED, actor: 'system', note: 'reconcile release: <SABAB>')` (OrderEvent `actor = SYSTEM`; bo‘shatishlar cap'i aynan shu `SYSTEM` + izoh prefiksi bo‘yicha sanaladi); commit'dan keyin `fulfill-order` job'i **faqat** `FulfillEnqueuer` orqali (yo‘qolgan job'ni `stale` qadami tiklaydi). Bo‘shatish to‘lov qarori emas: run hamma narsani qulf ostida qayta tekshiradi. `HELD` hodisasi yo‘q buyurtmaga tegilmaydi, egaga `reconcileGuardRefused` `<orderId>_held_<soat>`. Refund/bo‘shatish tranzaksiyasi ichida buyurtmaning to‘lov qatorlari yana o‘qiladi (`assertHeldPayoutClean`): shu orada kech fakt yoki tirik transfer paydo bo‘lsa — hammasi rollback.

Reconciler refund'ida AuditLog qatori yo‘q, shuning uchun uning effektlari `REVIEW_NOTICE_RESEND_WINDOW_MS` ichida har tikda o‘sha id'lar bilan qayta navbatga qo‘yiladi (`audit-effects` qadamiga tayanmaydi).

### Kech zanjir faktlari (`late` qadami)

Tikning 8-qadami. Faqat worker'ning o‘z hamyoni (`purpose = ORDER`, shu tarmoq va manzil). To‘rt ro‘yxat (ONCHAIN_FAILED nomzodlari, hint'lar, «yuborilmagan» transferlar, `CONFIRMED` transferlar), har biri o‘z keyset kursori bilan aylanadi (eskidan yangiga, oxiriga yetgach boshidan), har biri tikda ≤ 25 transfer. ONCHAIN_FAILED nomzodlarining `ton.suspect` filtri JSON'dan sahifa olingandan **keyin** o‘qiladi va guvohsiz SUSPECT abadiy nomzod bo‘lib qoladi, shuning uchun bu ro‘yxat ham kursor bilan yuradi (S9i darvoza D2). Hozir `TonTransfer_wallet_unresolved_key` unikal indeksi bir hamyonda bittadan ortiq `SIGNED`/`BROADCAST` transferga yo‘l qo‘ymaydi, ya’ni ro‘yxatda ko‘pi bilan bitta qator bo‘ladi; kursor indeks o‘zgargan kunda ham ro‘yxatni to‘g‘ri saqlaydi. Transfer buyurtma qulfi ostida `TonLateService` orqali ko‘riladi: TON moduli zanjirni o‘qiydi va faktni yagona tranzaksiyada yozadi (qulf tartibi buyurtma → urinish → transfer; `40P01` da butun tranzaksiya qayta); xabarlar **commit'dan keyin** barqaror id bilan ketadi. **Kech fakt buyurtma holatiga ham, ledger'ga ham tegmaydi** (kech bounce'ning `PROCESSING → NEEDS_REVIEW` o‘tishidan tashqari) va hech qachon `EXPIRED` yozmaydi. Kuzatuv oynasi — `LATE_WATCH_WINDOW_MS` = 72 soat (DB soati; transfer yaratilganidan, kech `CONFIRMED` bo‘lganida shu yozuv paytidan ham). Buyurtma `REFUNDED` bo‘lsa ham kuzatiladi. Natija turlari: `WRITTEN`, `NOTHING`, `WAIT` (manba yiqildi yoki dalil to‘liq emas — keyingi tikda), `REFUSED` (guard yoki unique indeks).

| Hodisa             | Qachon                                                                                                                                                                                             | Nima yoziladi                                                                                                                                                                                                                                                                                                                                                                                                             | Alert                                                                                      |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| **Kech CONFIRMED** | `EXPIRED`/`CONSUMED_UNMATCHED` transferning o‘z xabari (`extMsgHash`) hamyon tarixidan topildi (skan jarayon xotirasida) va `classifyOurTx` = PAID                                                 | Transfer → `CONFIRMED` (`txHash`, `txLt`, fee, `confirmedAt` = DB soati) va `ton.late = {from, outcome: 'CONFIRMED', via: 'SCAN', txHash, txLt, feeNanoTon}`. PAID bo‘lmasa transfer holati o‘zgarmaydi, `late.outcome = 'SUSPECT'` (+ `detail`). `seqno` ni tirik transfer ushlab tursa (unique indeks) — `late.outcome = 'SEQNO_HELD'`                                                                                  | `tonLateConfirmed` (refId = transfer); buyurtma `REFUNDED` bo‘lsa — pul ikki marta chiqqan |
| **Kech bounce**    | `CONFIRMED` transferning manzili xabarni keyin qaytardi (qaytish tx topildi)                                                                                                                       | Buyurtma `PROCESSING`/`NEEDS_REVIEW`, urinish ochiq (`SENDING`/`SENT`/`UNKNOWN`), boshqa transferlar «yuborilmagani isbotlangan» va summa `TON_BOUNCED` diapazonida bo‘lsa: transfer → `BOUNCED`, urinish `UNKNOWN`, `ton.bounce`, `PROCESSING` bo‘lsa buyurtma → `NEEDS_REVIEW` (`ADAPTER_ERROR`). Aks holda (masalan `DELIVERED`) transfer `CONFIRMED` qoladi, faqat `ton.lateBounce` fakti (+ `detail`, `orderStatus`) | `tonBounced` (refId = transfer); `DELIVERED` da egaga admin refund qoladi                  |
| **Kech abort**     | `CONFIRMED` transferning manzili xabarni bounce'siz abort qildi, yoki unda yozilgan tx imzolanganidek to‘lamagan                                                                                   | Faqat `ton.lateDestination = {verdict: 'DESTINATION_ABORTED' \| 'NOT_PAID', destTxHash, orderStatus}` (bir marta). Reconciler uni SUSPECT deb hisoblaydi                                                                                                                                                                                                                                                                  | `reconcileGuardRefused` `<orderId>_ton_<soat>` (oyna ichida soatiga bir marta)             |
| **ONCHAIN_FAILED** | `SIGNED`/`BROADCAST` transfer, buyurtma `NEEDS_REVIEW`, urinishda `ton.suspect` (`NO_OUT_MESSAGE`/`ACTION_FAILED`) bor; **primary va har guvoh** shu `(lt, hash)` tx'ni chiquvchi xabarsiz ko‘radi | Transfer → `ONCHAIN_FAILED` (`txHash`, `txLt`) va `ton.onchainFailed = {txHash, txLt, outMsgCount: 0, sources}`. Buyurtma `NEEDS_REVIEW` da qoladi, chiqish — eganing `TON_NOT_DEBITED` isboti. Guvoh yo‘q yoki rozi emas — hech narsa yozilmaydi                                                                                                                                                                         | `needsReview` `<orderId>_<transferId>`                                                     |

Yozish rad etilsa (`GG001` yoki unique indeks) — `reconcileGuardRefused` `<orderId>_ton_<soat>`. Yozilgan `late` / `lateBounce` fakti uchun alert har tikda **bazadagi faktdan** qayta navbatga qo‘yiladi (id bir xil): commit'dan keyingi navbatga qo‘yish yiqilsa, keyingi tik tuzatadi.

### Z6: hint oqimi (`CONSUMED_UNMATCHED`)

1. **Ega hint beradi.** Zanjirdan tranzaksiyani topgach (yuqoridagi runbook): `ton:hint <transferId> --tx <64 hex> --lt <decimal> --reason <≥ 20 belgi>` (`apps/api/src/cli/commands/tx-hint.command.ts`, servis — `modules/orders/admin/tx-hint.service.ts`). Faqat OWNER kanali, OTP yo‘q (pul harakatlanmaydi, tasdiqni kod qiladi). Transfer `CONSUMED_UNMATCHED` bo‘lishi shart; hash kichik harfga keltiriladi. Yozuv: `AuditLog(action 'TON_TX_HINT', targetType 'TonTransfer', targetId = transferId, actorType 'CLI')`, `after = {txHash, lt, operator, …}`. Aynan shu hint qayta berilsa yangi qator yozilmaydi (rad etilgan bo‘lsa — yoziladi).
2. **Reconciler tekshiradi.** `late` qadami transferning **oxirgi** hint'ini oladi (faqat eganing CLI qatori) va `TonLateService.checkHint` ishlaydi. `ton-tx-hint.verifier.ts` tekshiruvlari (har birining o‘z rad kodi): tx **primary** manbada `(lt, hash)` bo‘yicha topiladi (`TX_NOT_FOUND`); bizning hamyon akkaunti (`FOREIGN_ACCOUNT`); tashqi xabar (`NOT_EXTERNAL`); xabarning `extMsgHash` i **shu** transferniki — boshqa transferniki bo‘lsa `OTHER_TRANSFER`, hech birimiki bo‘lmasa `FOREIGN_MESSAGE`; imzolangan tanadagi `seqno` shu transferniki (`BODY_UNREADABLE`, `SEQNO_MISMATCH`); tx muvaffaqiyatli va bitta chiquvchi xabar (`TX_FAILED`, `OUT_MESSAGE_COUNT`); manzil transfer manzili (`DESTINATION_MISMATCH`) va `FRAGMENT_PAY_ADDRESSES` da (`PAYEE_NOT_ALLOWED`); summa (`AMOUNT_MISMATCH`); payload hash (`PAYLOAD_MISMATCH`); **kamida bitta guvoh bor** va **har guvoh** aynan shu tx'ni ko‘radi (`NO_WITNESS`, `WITNESS_MISMATCH`). So‘ng manzil: faqat xabarni **qayta ishlagan** manzil qabul qilinadi; `DESTINATION_BOUNCED`, `DESTINATION_ABORTED`, `RETURN_OUT_OF_RANGE` — rad. «Hali ko‘rinmayapti» hech qachon CONFIRMED'ga aylanmaydi, kutadi.
3. **Natija.** Hammasi mos — transfer `CONSUMED_UNMATCHED → CONFIRMED` (`txHash`/`txLt`), `ton.late = {from, outcome: 'CONFIRMED', via: 'HINT', auditId, …}` va `ton.hint = {auditId, verdict: 'ACCEPTED'}`; alert `tonLateConfirmed` (refId = transfer). **Buyurtma `NEEDS_REVIEW` da qoladi:** ega `order:resolve --proof TON_TX` bilan hal qiladi, reconciler DELIVERED qilmaydi. Mos emas — `ton.hint = {auditId, verdict: 'REJECTED', code}` (transfer o‘zgarmaydi, AuditLog qatori ham — append-only); ega buni `order:show` da «hint rad etildi: <kod>» ko‘rinishida ko‘radi.
4. **Kutish.** `TX_NOT_FOUND` va `WITNESS_MISMATCH` (manba tx'ni hali ro‘yxatga olmagan bo‘lishi mumkin) `HINT_TRANSIENT_LOOKS` = 10 qarashgacha kutiladi, keyin hukm sifatida saqlanadi. `NO_WITNESS` hech qachon hukm emas: guvoh ulangach o‘sha hint o‘ta oladi.
5. **Faqat o‘z xabarimiz.** `FOREIGN_MESSAGE` (bizning kalit buyurtmaga aloqasiz xabar imzolagan) — `tonSeqnoUnmatched`, refId `<transferId>_foreign` (S5 ning o‘z alerti — refId = transfer — yo‘qolgan bo‘lsa ham ega yangi topilmani eshitadi); qadam uni hint sahifasining har aylanishida **saqlangan faktdan** qayta navbatga qo‘yadi (bitta yo‘qolgan navbatga qo‘yish keyingi aylanishda tuzaladi).
6. **`OTHER_TRANSFER`.** Hint tx'i shu buyurtmaning **boshqa** transferi (T1) xabari bilan boshlangan bo‘lsa: hint rad etiladi, lekin T1 urinishiga `late = {from, outcome: 'OTHER_TRANSFER', via: 'HINT', auditId, hintedTransferId, txHash, txLt}` yoziladi (bir marta; faqat `EXPIRED`/`CONSUMED_UNMATCHED` T1 uchun; primary manba yetarli — noto‘g‘ri belgi faqat refund'ni to‘xtatadi, shuning uchun fail-closed). Shundan beri T1 «yuborilmagani isbotlangan» emas: `assertNoLivePayout`, `TON_NOT_SENT`, HELD qadami, M-1 imzolash darvozasi va `order:show` uni to‘langan deb hisoblaydi; undan o‘tishni faqat ega hal qiladi (T1 ga bog‘langan isbot yoki `MANUAL`). Buyurtma allaqachon **terminal** (`DELIVERED`/`FAILED`/`REFUNDED`/`CANCELLED`) bo‘lsa, hech bir guard to‘xtata olmaydi — egaga `tonLateConfirmed` chiqadi, refId `<T1>_<auditId>` (T1 ning o‘z alerti oddiy id'sini saqlaydi); belgi bir marta yoziladi. Alert uzilgan navbatga qo‘yishdan tiklanishi uchun hint aylanishi uni T1 dagi belgidan qayta navbatga qo‘yadi — hint'ning AuditLog qatori (`TON_TX_HINT`) yoshi DB soati bo‘yicha 29 kundan kichik ekan (`HINT_REPEAT_MAX_AGE_MS` = `NOTIFY_DEDUPE_SEC` (30 kun) − 1 kun: BullMQ dedupe muddati tugashidan oldin to‘xtaydi, eski alert qayta tug‘ilmaydi). `FOREIGN_MESSAGE` takrori ham xuddi shu oynada.

### Skan kursori (Variant A)

`NEEDS_REVIEW` transfer kunlab kuzatilishi mumkin, restart esa spam bilan to‘lgan oynani qaytadan o‘qitmasligi kerak. Shuning uchun hal bo‘lmagan ORDER transferining skan holati `FulfillmentAttempt.response.ton.scan` da saqlanadi (sxema o‘zgarmaydi): `transferId` **va** `extMsgHash` ga bog‘langan (boshqa transfer yoki xabarning kursori «yo‘q» hisoblanadi), qat’iy `strictObject` bilan o‘qiladi (o‘qib bo‘lmasa — kursor yo‘q, skan boshidan: xavfsiz yo‘nalish), faqat transfer hal bo‘lmaguncha yoziladi; Redis'da emas, DB'da (`ton-scan-cursor.ts`, `ton-scan-cursor.repository.ts`).

Bazadagi kursor **maslahat (advisory)**: soxta yoki buzilgan kursor har qarashni `STALE` qilib, bitta tranzaksiya-hamyon indeksi orqali butun hot wallet'ni bloklashi mumkin. **Faqat maslahat kursorigina tashlanadi** (`ton-scan-trust.ts`); jarayonning o‘z progressi va guvohlarniki S5 dagidek, ularga tegilmaydi (ularning `covered` va o‘tish langari — jarayonning o‘zi tekshirgan «pol»: ularni tashlash, bizning to‘lovdan pastda qotib qolgan node'ga o‘tishni tugatib, soxta EXPIRY kuzatuvi berishga yo‘l ochardi).

| Qarash                                         | Maslahat kursori (bazadan)             | O‘z progress va guvohlar |
| ---------------------------------------------- | -------------------------------------- | ------------------------ |
| `covered` yangi holatdan yuqori (zanjirga zid) | hammasi darhol tashlanadi              | tegilmaydi               |
| `STALE` (FLOOR yoki PASS)                      | ketma-ket 3 marta → hammasi tashlanadi | tegilmaydi               |
| `PARTIAL` (GATEWAY, shu o‘tishda)              | ketma-ket 3 marta → hammasi tashlanadi | tegilmaydi (sanalmaydi)  |
| `STALE` (RACE: holat/indeks poygasi)           | sanalmaydi                             | sanalmaydi               |
| `COMPLETE` yoki BUDGET                         | sanoqlar tozalanadi, endi o‘z progress | sanoqlar 0 qoladi        |

`ADVISORY_LOOKS_BEFORE_RESCAN` = 3; sanoqlar xotirada (kursorda emas: soxta kursor ularni yashira olmasin). Qabul qilingan narx: zanjir jarayonning o‘z progressiga zid chiqaversa (provayder eski yoki yolg‘on ma’lumot beradi), hamyon fail-closed bloklanadi (`tonWalletBlocked`) — node tiklanguncha yoki worker restart'igacha (restart'dan keyin kursor yana maslahat). 10 daqiqalik davrda restart'dan keyingi bloklanish ~30 daqiqa. **Kech faktlar skani** (`ton-late-reader.ts`) bazadan kursor yuklamaydi: uning progressi faqat shu jarayon xotirasida (restart'dan keyin boshidan), shuning uchun tashlash kerak bo‘ladigan narsa yo‘q.

### Guvoh (witness) talabi

Ikkinchi, mustaqil zanjir manbasi tor `TonChainWitness` interfeysi orqali ulanadi (`TON_EXPIRY_WITNESSES`; yuqorida «Guvohlar»). S9 uchta joyda unga tayanadi: (1) **ONCHAIN_FAILED** — primary va har guvoh bir xil tx'ni chiquvchi xabarsiz ko‘rishi shart; guvoh yo‘q → hech narsa yozilmaydi (`NO_WITNESS`); (2) **Z6 hint** — kamida bitta guvoh bo‘lishi va hammasi aynan shu `(lt, hash)` tx'ni ko‘rishi shart (`NO_WITNESS` kutadi, hukm emas); (3) **EXPIRED** (`TON_NOT_SENT` isboti) — guvoh bizning xabarni yoki o‘tib ketgan seqno'ni ko‘rsa `WITNESS_CONFLICT` (hech qachon EXPIRED); nizo doimiy. Hozircha guvohlar ro‘yxati bo‘sh, shuning uchun (1) va (2) hech narsa yozmaydi. **Mainnet'dan oldin** ikkinchi manba majburiy: usiz live mainnet worker boot'da rad etiladi (`ton-env-live.ts`, D-60 (2), S12). Bounce'ni ikki manbada talab qilish va fixture raqamlari — S12 ga qoldirilgan (D-64 (7), Q-13, Q-15).

### Audit-effects qadami (I-3)

API commit'dan keyin qulasa (`order:resolve`, `order:retry`, `fx:set`, `ton:hint`) yoki reconciler o‘zi hal qilib, navbatga qo‘yishdan oldin qulasa, AuditLog qatori yagona doimiy iz bo‘lib qoladi. `audit-effects.step.ts` har tikda `createdAt ∈ [now − AUDIT_EFFECTS_WINDOW_MS, now − AUDIT_EFFECTS_MIN_AGE_MS]` = **[2 daqiqa … 24 soat]** oynadagi qatorlarni (DB soati; action va **o‘z** `targetType` i: `ORDER_REVIEW_RESOLVE` va `ORDER_RETRY` — `Order`, `FX_SET` — `FxRate`, `TON_TX_HINT` — `TonTransfer`) **eskidan yangiga** (keyset `(createdAt, id)`, partiyada ≤ 100) ko‘radi. Kursor bitta jarayon xotirasida; qator kursordan faqat ishlangach o‘tadi, qisqa sahifa — oyna tugadi, keyingi tik boshidan. Processor `concurrency: 1`, shuning uchun bir jarayonda bitta yurish bor; boshqa worker jarayoni ustma-ust tushsa, id'lar bir xil bo‘lgani uchun dublikat ketmaydi. Pastki chegara yozuvchiga effektlarni o‘zi navbatga qo‘yishga vaqt beradi; yuqori chegara qayta yuborishni 30 kunlik `notify` dublikat oynasi (API'ning `EFFECTS_REPLAY_MAX_AGE_MS` = 29 kun) ichida ushlaydi: eski qator hech kimga ikkinchi marta yetmaydi.

- **Qaysi effekt, qaysi id bilan** — faqat umumiy `orderEffectsPlan` (`packages/shared/src/orders/order-effects-plan.ts`; API'ning `OrderAdminEffects` va `review` qadami ham shuni ishlatadi): id'lar birinchi yuborishnikiga aynan teng, BullMQ dublikatni tashlaydi; bu qadam id yasamaydi. Refund'da mijoz xabari `ORDER_REFUNDED` / `<orderId>` — HELD qadamining refund'i bilan bir xil job, ikki marta ketmaydi.
- Refund yozgan qatorda avval hamyon keshi `DEL` (idempotent).
- `ORDER_RETRY` va buyurtma hamon `QUEUED` bo‘lsa: faqat `FulfillEnqueuer` orqali (`jobId = orderId`); qaror `lock:order:{id}` ostida: job tirik emas va abandon hisobi chegaraga yetmagan bo‘lsagina; enqueue qulf bo‘shagach. Qulf band bo‘lsa kursor o‘tib ketadi va qator keyingi aylanishda yana ko‘riladi.
- Reconciler yozgan qator (`actorType SYSTEM`) uchun `adminAction` alerti yo‘q.
- Bazaga hech narsa yozilmaydi.

### Doimiylar va env

| Nom                                                    | Qiymat                                                                           | Qayerda                                                                     |
| ------------------------------------------------------ | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `ORDER_RECONCILE_EVERY_MS` (env)                       | 600 000 (chegara 60 000 … 3 600 000)                                             | `apps/worker/.env.example`, `apps/worker/src/config/order-reconcile-env.ts` |
| `HELD_MAX_AGE_MS` (env)                                | 21 600 000 (chegara 3 600 000 … 604 800 000)                                     | xuddi shu                                                                   |
| `ORDER_STALE_AFTER_MS`                                 | 10 daqiqa                                                                        | `packages/shared/src/orders/reconcile-config.ts`                            |
| `HELD_AUTO_RELEASE_MAX`                                | 3                                                                                | xuddi shu                                                                   |
| `RELEASABLE_HELD_REASONS`                              | `NO_ADAPTER`, `PRICE_ABOVE_MAX`, `LIMIT_PER_ORDER`, `LIMIT_DAILY`, `LOW_BALANCE` | xuddi shu (faqat worker reconciler'i uchun; API va UI import qilmaydi)      |
| `REVIEW_NOTICE_RESEND_WINDOW_MS`                       | 24 soat                                                                          | xuddi shu                                                                   |
| `AUDIT_EFFECTS_WINDOW_MS` / `AUDIT_EFFECTS_MIN_AGE_MS` | 24 soat / 2 daqiqa                                                               | xuddi shu                                                                   |
| `LATE_WATCH_WINDOW_MS`                                 | 72 soat                                                                          | xuddi shu                                                                   |
| `ORDER_LOCK_STUCK_AFTER_MS`                            | 30 daqiqa                                                                        | xuddi shu                                                                   |
| `RECONCILE_BATCH_LIMIT`                                | 100                                                                              | xuddi shu                                                                   |
| `WALLET_BLOCKED_REMIND_EVERY_MS`                       | 6 soat                                                                           | `apps/worker/src/common/episode-ref.ts`                                     |

## Dev va test

- `FULFILLMENT_DRY_RUN=true` (standart): barcha adapterlar simulyator bilan almashadi.
- `TON_NETWORK=testnet` — faqat aniq sozlansa.
- Dry-run’da ham `FRAGMENT_PAY_ADDRESSES` bo‘sh bo‘lsa har `ORDER` to‘lovi `HELD` bo‘ladi (review m4). Hech bir manzil avtomatik ruxsat etilmaydi: bunday kod yo‘li live konfiguratsiyaga sizib chiqishi mumkin edi. Dev’da ORDER to‘lovini xotiradagi zanjir orqali o‘tkazish uchun Fragment simulyatorining to‘lov manzilini (`SIMULATED_FRAGMENT_PAY_ADDRESS`, S4: `0:aa185e6828d6d7c3cfc960ee4cd3a6853a2fe2e0a386a4c991a99f19db224905` — kaliti hech kimda yo‘q, faqat xotiradagi zanjir uni ko‘radi) `FRAGMENT_PAY_ADDRESSES` ga yozing. Production’da (dry-run bo‘lsa ham) yoki `FULFILLMENT_DRY_RUN=false` da bu manzil ro‘yxatda bo‘lsa worker boot’da rad etadi (CR m7, audit I-2).
- Dev’da (Windows + WSL2 Docker) WSL soati kompyuter uyqudan chiqqach siljiydi (review n4): DB soati worker soatidan 30 s dan ko‘p farq qilsa hech narsa imzolanmaydi (`NOT_SENT CLOCK_SKEW`) va `EXPIRED` kechikadi. Davosi: `wsl --shutdown` va Docker’ni qayta ishga tushirish.
- Haqiqiy pul bilan birinchi sinov: ega ruxsati bilan, kichik summa (50 Stars), egasining o‘z akkauntiga.
