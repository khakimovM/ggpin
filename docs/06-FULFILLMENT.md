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
va to‘g‘ri kursni to‘sa olmaydi.
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

**Simulyator.** 3-fazada haqiqiy kurs manbai ham, Fragment narxini olish ham yo‘q (ega javobi Q6):
faqat `FxSource` / `CostSource` interfeyslari va simulyatorlar. Simulyator qiymatlari soxta, doimiy
va hech qayerdan olinmaydi: `USDT_UZS = 12650`, `TON_USDT = 3.2` (demak `TON_UZS = 40480`);
1 Star = 0,0047 TON; Premium 3 oy = 3,75 TON, 6 oy = 5 TON, 12 oy = 9,1 TON
(`apps/worker/src/pricing-sync/fx-sources/simulated-fx.source.ts`,
`apps/worker/src/adapters/simulator/simulated-fragment-prices.ts`). Qatorlarda `source = 'simulator'`;
productionʼdagi API `simulator` va undan hosil bo‘lgan kurslar bilan narx bermaydi (Q15).
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
ham bir xil qoida bilan tanlanadi, shuning uchun mijoz ko‘rgan narx — to‘laydigan narx:
paketning o‘z tannarxi (`skuId` bilan) yangi bo‘lsa — u; eskirgan bo‘lsa — mahsulot darajasidagi
yangi tannarx miqdorga ko‘paytiriladi; ikkalasi ham bo‘lmasa narx yo‘q. Worker soati biroz oldinda
bo‘lishi mumkin, shuning uchun 1 daqiqagacha kelajakdagi qator qabul qilinadi (`MAX_CLOCK_SKEW_MS`);
undan uzoqroq kelajakdagi qator xato yozuv hisoblanadi va umuman o‘qilmaydi — u "eng yangi" bo‘lib
to‘g‘ri kursni yashira olmaydi. Simulyator qatorlari (`source = 'simulator'`, hamda ulardan hosil bo‘lgan `derived:`
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

## Dev va test

- `FULFILLMENT_DRY_RUN=true` (standart): barcha adapterlar simulyator bilan almashadi.
- `TON_NETWORK=testnet` — faqat aniq sozlansa.
- Haqiqiy pul bilan birinchi sinov: ega ruxsati bilan, kichik summa (50 Stars), egasining o‘z akkauntiga.
