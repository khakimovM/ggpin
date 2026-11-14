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
   - `TON_CONFIRM_TIMEOUT_MS` (standart 5 daqiqa) ichida tasdiq yo‘q → NEEDS_REVIEW (reconcile har 10 daqiqada tekshiradi).
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

**Tannarx (`cost`).** Har bir **faol** mahsulot uchun birinchi yoqilgan (`isEnabled`) route
(`priority` bo‘yicha) olinadi; u `FRAGMENT` bo‘lsa — `CostSnapshot` yoziladi (valyuta TON,
`adapter = 'FRAGMENT'`). Erkin miqdorli mahsulot (Stars, `allowCustomQty`): bitta mahsulot
darajasidagi qator (`skuId` NULL, `basisQuantity` 1, 1 dona narxi). Tayyor paketli mahsulot
(Premium): har bir faol SKU uchun bitta qator (`basisQuantity` = SKU miqdori, yaʼni oylar).
Nofaol mahsulot, nofaol SKU va birinchi routeʼi boshqa adapter bo‘lgan mahsulot o‘tkazib yuboriladi.
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
**S9:** buyurtma `REFUNDED` bo‘lsa-yu uning transferi keyin `CONFIRMED` bo‘lsa (kech topilgan tranzaksiya) — **kritik alert** (pul ikki marta chiqqan); alert kaliti S9 da qo‘shiladi.

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

**Kelajak ishi (S9/S10).** Reconciler transferni yangilaganda `GG001` olsa (masalan buyurtma boshqa holatga o‘tib bo‘lgan, yoki `BOUNCED` DELIVERED buyurtmada), bu **kritik alert** — jim yutilmaydi, qayta urinilmaydi; sabab (buyurtma holati, transfer holati) alert matniga yoziladi.

**CONSUMED_UNMATCHED — tekshiruvdan keyin refund (A3, ertalabki «refund yo‘q» qarori o‘rniga).** Seqno o‘tib ketgan, lekin shu seqno'ni nima iste'mol qilgani noma'lum: hamyondan pul ketgan bo‘lishi mumkin. Avtomatik refund **yo‘q**; odam zanjirga qarab xulosa yozgach, eganing CLI'si `TON_UNMATCHED_RESOLVED` isboti bilan refund qiladi (yuqorida). Kritik alert kaliti `tonConsumedUnmatched` (`fulfillment-alerts`); alertni S9 chiqaradi.
**Qo‘lda tekshiruv runbook'i** (egaga, shu tartibda; DB'ga qo‘lda aralashuv **yo‘q**):

1. Hot wallet manzili va `seqno` ni `TonTransfer` qatoridan oling (`walletAddress`, `seqno`, `validUntil`, `extMsgHash`).
2. Ikki mustaqil explorer'da (Tonviewer va Toncenter) hamyonning shu `seqno` dagi chiquvchi tranzaksiyasini toping. Kim yuborgan va qaysi manzilga ekanini, tranzaksiya hash'ini yozib qo‘ying.
3. Tranzaksiya **Fragment allowlist manziliga, shu summada** ketgan bo‘lsa — bu bizning xabarimiz (D-59 (8)). **Odam faqat tranzaksiya hash'ini beradi, tasdiqni kod qiladi; `MANUAL` bilan DELIVERED qilinmaydi.** Ega CLI orqali shu hash'ni reconciler'ga «hint» sifatida beradi. Reconciler tranzaksiyani zanjirda **ikki mustaqil manbadan** (Toncenter va Tonviewer) o‘zi tekshiradi: (a) manzil — Fragment allowlist (`FRAGMENT_PAY_ADDRESSES`); (b) summa; (c) payload yoki xabar bizning transferga mos (`payloadHash`/`extMsgHash`); (d) `seqno` shu transferniki. Hammasi mos kelsa transfer `CONSUMED_UNMATCHED → CONFIRMED` bo‘ladi (bu qirra DB'da bor; `txHash`/`txLt` shu qirrada yoziladi), so‘ng buyurtma odatdagi yo‘l bilan hal bo‘ladi: Fragment yetkazgan bo‘lsa `TON_TX` yoki `FRAGMENT_STATUS` orqali `DELIVERED`. Mos kelmasa — 4-qadam (`TON_UNMATCHED_RESOLVED` orqali refund). **S9 (reconciler) va S10 (CLI) mezoni:** hint oqimi S1 da kodlanmagan, faqat shu hujjat; S9 hint'ni qabul qilib yuqoridagi to‘rt tekshiruvni bajaradi, S10 CLI hash'ni beradi va natijani ko‘rsatadi.
4. Pul ketmagan bo‘lsa (`NOT_SENT`) yoki boshqa manzilga ketgan bo‘lsa (`SENT_ELSEWHERE`) — **mijozga refund qilinadi, zarar kompaniyaniki** (mijoz aybdor emas): CLI `TON_UNMATCHED_RESOLVED` isboti (`finding`, `consumingTxHash`, sabab) bilan buyurtmani FAILED + REFUND qiladi. `SENT_ELSEWHERE` bo‘lsa hamyon buzilgan: **yangi yuborishlarni to‘xtating** (`TON_*` limitlarini 0 qiling), kalitlarni almashtirish rejasini boshlang; CLI `tonWalletCompromised` alert'ini chiqaradi.
5. Refund kod yo‘li bilan bajariladi (DB'ga qo‘lda yozuv kerak emas): bitta tranzaksiyada urinish yopiladi, buyurtma FAILED → REFUNDED, `REFUND` ledger yozuvi va `AuditLog` yoziladi.
6. Har qadam `AuditLog` ga sabab bilan yoziladi (CLI buni isbotdagi `reason` va audit qatori bilan o‘zi qiladi).

**Marshrut va yetkazish (R3, R6 bilan bog‘liq).** Qabul qiluvchi ismida faqat bidi/ko‘rinmas belgilar rad etiladi (U+061C, U+180E, U+200B, U+200E–200F, U+2028–2029, U+202A–202E, U+2060–2064, U+2066–2069, U+FEFF); ZWJ (U+200D) va ZWNJ (U+200C) ruxsat (ega qarori R6), shuning uchun qo‘shma emoji'li ismlar o‘tadi; tag belgilari (U+E0020–E007F) ham ruxsat (England/Scotland/Wales bayroq emoji'lari ularni ishlatadi). Ismda kamida bitta **ko‘rinadigan** belgi bo‘lishi shart: faqat bo‘shliq, to‘ldiruvchi belgilar (U+3164, U+115F, U+1160, U+FFA0), ruxsat etilgan ZW belgilari, yumshoq defis, variatsiya selektorlari yoki yalang‘och tag belgilaridan iborat ism rad etiladi (D-59 Y8).

## 5-faza S5: TON issiq hamyon (tuzatish raundi)

Kod: `apps/worker/src/ton/**`, env: `apps/worker/src/config/ton-env*.ts`. Bu bo‘lim S5 review va audit topilmalari bo‘yicha qabul qilingan qoidalarni yozadi; S9 (reconciler) va S10 (CLI) shularga tayanadi.

**Hamyon tranzaksiyalarini qidirish — vaqt bilan chegaralangan skan (audit H1).** Bizning chiquvchi tranzaksiyamiz «oxirgi 128 tadan» qidirilmaydi: hamyonga kelgan spam (masalan 1000 ta kichik kiruvchi o‘tkazma) uni oynadan itarib chiqarardi va to‘lov chiqqan bo‘lsa ham `EXPIRED`/refund xulosasiga olib kelardi. Skan sahifalab (`SCAN_PAGE_SIZE` = 100 — toncenter `getTransactions` ning hujjatlangan maksimumi, `limit` ≤ 100 (audit L-2); bir qarashda ko‘pi bilan `SCAN_PAGES_PER_LOOK` = 8 sahifa) eng yangidan transfer yaratilgan vaqtgacha (`createdAt − scanSlackSec`) yuradi va kursor qarashlar orasida saqlanadi. Natija: `FOUND` (topildi), `COMPLETE` (butun oyna ko‘rildi, yo‘q), `PARTIAL` (oyna oxirigacha yetilmadi — keyingi qarashda davom) yoki `STALE` (provayder eski holat berdi). **Faqat `COMPLETE` «tranzaksiya yo‘q» degani**; `PARTIAL`/`STALE` hamisha `WAIT` (hech qachon `EXPIRED` emas). Regress testlari: tranzaksiyadan keyin 128 va 1000 spam (unit), 128 va 600 spam (e2e, haqiqiy DB). **S9 reconciler 128 ta bilan cheklangan eski skanni qayta ishlatmaydi** — faqat shu chegaralangan skan (`advanceScan`) bilan ishlaydi.

**Skan eskirgan holatga tayanmaydi (audit M-1 (a)).** Yangi o‘tish (pass) faqat shu manbaning indeksi account state’dagi oxirgi tranzaksiyani **eng yangi** deb ko‘rsatsa boshlanadi. Node eski holat (eski seqno, eski `lastTx`) va hozirgi zanjir vaqtini bersa-yu, indeksda bizning tranzaksiya turgan bo‘lsa — `STALE` (`WAIT`), hech qachon `COMPLETE`/`EXPIRY` emas. Bu «bosh» ro‘yxati o‘tishning birinchi sahifasi, shuning uchun qo‘shimcha so‘rov faqat «qamrab olingandan beri yangi narsa yo‘q» qarashida: bitta `getTransactions(limit 1)`. **Progress yo‘qolmaydi (review m1, audit L-2):** sahifa xatosi (429, 503, tarmoq) qarashni `PARTIAL` bilan tugatadi va kursor saqlanadi; `STALE` avval qamrab olinganni (`covered`) va davom etayotgan o‘tish kursorini saqlaydi; faqat zanjirning o‘zi `covered` ga zid bo‘lsa, u tashlanadi. Kursorni restart’dan keyin saqlash va NEEDS_REVIEW transferlarni skanlashni davom ettirish — S9.

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

## Dev va test

- `FULFILLMENT_DRY_RUN=true` (standart): barcha adapterlar simulyator bilan almashadi.
- `TON_NETWORK=testnet` — faqat aniq sozlansa.
- Dry-run’da ham `FRAGMENT_PAY_ADDRESSES` bo‘sh bo‘lsa har `ORDER` to‘lovi `HELD` bo‘ladi (review m4). Hech bir manzil avtomatik ruxsat etilmaydi: bunday kod yo‘li live konfiguratsiyaga sizib chiqishi mumkin edi, Fragment simulyatori va uning fixture manzili esa hali yo‘q (S8). Dev’da ORDER to‘lovini xotiradagi zanjir orqali o‘tkazish uchun simulyator ishlatadigan manzilni `FRAGMENT_PAY_ADDRESSES` ga yozing.
- Dev’da (Windows + WSL2 Docker) WSL soati kompyuter uyqudan chiqqach siljiydi (review n4): DB soati worker soatidan 30 s dan ko‘p farq qilsa hech narsa imzolanmaydi (`NOT_SENT CLOCK_SKEW`) va `EXPIRED` kechikadi. Davosi: `wsl --shutdown` va Docker’ni qayta ishga tushirish.
- Haqiqiy pul bilan birinchi sinov: ega ruxsati bilan, kichik summa (50 Stars), egasining o‘z akkauntiga.
