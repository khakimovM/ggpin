# 05 — To‘lovlar (balansni to‘ldirish)

> Birinchi usul — **P2P o‘tkazma bizning Humo va Uzcard kartalarimizga** (D-31, D-37). Click, Payme, Uzum, Rahmat — keyinroq (D-04),
> ularning matni shu hujjat oxirida («Keyinroq»). Endpoint shakllari — `docs/04-API-CONTRACT.md` («To‘lovlar (P2P karta)»).
> `D-37 (n)` — `docs/13-DECISIONS.md` dagi D-37 qarorining n-bandi. Fixture va hujjatlarda haqiqiy karta raqami, summa, balans,
> vaqt va ismlar **hech qachon** ishlatilmaydi: faqat sintetik qiymatlar.

## 1. Model

```
PaymentIntent (PENDING, P2P_CARD, asos summa + noyob qo‘shimcha, karta, 30 daqiqa)
   │  foydalanuvchi o‘z kartasidan bizning kartaga AYNAN shu summani o‘tkazadi
   ▼
Bank boti (@HUMOcardbot / @CardXabarBot) kartamizga tushgan pul haqida xabar beradi
   ▼  ishchi Telegram akkaunti (MTProto, faqat worker) xabarni o‘qiydi
BankMessage (xom matn saqlanadi) → parser → balans zanjiri tekshiruvi → noyob summa bo‘yicha nomzod
   ▼  bitta $transaction (intent qatori FOR UPDATE, hamyon qulfi)
Payment(CONFIRMED) + Intent(PAID) + LedgerEntry(TOPUP) + BankMessageOutcome(CREDITED)
   ▼  commit'dan keyin
wallet:{userId} keshi o‘chadi → notify job → bot xabari «Hisobingiz to‘ldirildi»
```

- **Worker** — yagona jarayon, bank-feed sessiyasini ushlaydi; xabarni o‘qiydi, parse qiladi, moslashtiradi va TOPUP yozadi.
  **API** — karta tanlaydi, noyob summa beradi, intentlarni va hamyonni ko‘rsatadi, `notify` navbatini render qiladi.
- Hisobga yoziladigan summa — xabardagi **to‘liq tushgan summa** (asos + qo‘shimcha), asos summa emas (D-37 (4)).
- Hech narsa «tasdiqlangan»ni mijozdan olmaydi: web sahifadagi «To‘ladim» tugmasi yo‘q, havola/redirect holatni faqat ko‘rsatadi.
- `TOPUP_AND_BUY` — hozircha faqat `purpose` maydoni (D-37 (10)); avtomatik xarid 5-bosqichda.
- Chegaralar (D-37 (7)): minimum **5 000 so‘m**, bitta so‘rov maksimum **2 000 000 so‘m**, asos summa 1 000 so‘mga karrali. Click/Payme komissiyasi yo‘q.
- **Bot xabarlari.** `bot.wallet.topupCredited` / `topupLateCredited` — hisobga tushganda ({amount}, {balance}); ularning tagidagi tugma
  `bot.wallet.topupButton` («➕ Hisobni to‘ldirish») to‘ldirish sahifasini ochadi. `bot.wallet.openTopup` — to‘ldirishni boshlash xabarining matni
  («quyidagi tugmani bosing»), tugmaning o‘zi emas. Muddati o‘tgan so‘rov haqida xabar yuborilmaydi (D-37 (10)).

## 2. Karta puli

`TopupCard`: bank (`HUMO` yoki `UZCARD`), 16 raqamli `pan` (bizning qabul qiluvchi kartamiz — DB’da ochiq, D-37 (11)) va `last4`, egasi ismi,
holat, `receiveLimitTiyin`, ixtiyoriy `monthlyLimitTiyin`, `autoCreditPaused`.

| Holat       | Ma’no                                                                                                               |
| ----------- | ------------------------------------------------------------------------------------------------------------------- |
| `VERIFYING` | qo‘shildi, hali tasdiqlanmagan; foydalanuvchiga **berilmaydi**                                                      |
| `ACTIVE`    | yangi so‘rovlar shu kartaga beriladi                                                                                |
| `FULL`      | limit to‘ldi; yangi so‘rov yo‘q, lekin yo‘ldagi to‘lov baribir yoziladi                                             |
| `DRAINING`  | yopilmoqda: yangi so‘rov berilmaydi, mavjud so‘rovlar o‘z `reservedUntil` gacha yoziladi; keyin avtomatik `RETIRED` |
| `RETIRED`   | ishdan chiqarilgan; `last4` boshqa kartaga yaqinda berilmaydi (`card:add` rad etadi)                                |

- **Limit majburiy (D-37 (6)).** Umumiy standart yo‘q: `card:add` da `--limit` (kartaning pulda bo‘lgan **butun davri** bo‘yicha qabul qilingan
  summa) beriladi; ixtiyoriy `--monthly-limit`. «Qabul qilingan» — `verifiedAt` dan beri shu kartaga kelgan **barcha** PARSED kirimlar
  (moslashganmi-yo‘qmi farqsiz: bank nuqtai nazari). Band summalar (`reservedUntil > now`, grace ichidagilar ham) limitga sanaladi.
  80% da ega ogohlantiriladi, 100% da karta `FULL` bo‘ladi. `FULL → ACTIVE` faqat limit oshirilganda.
- **Test o‘tkazma.** `card:add` kartani `VERIFYING` qiladi va `verifyAmountTiyin` beradi; ega shu summani o‘tkazganda xabar kelib,
  karta `ACTIVE` bo‘ladi (ledger yozuvi yo‘q). Boshqa summa — review `NO_MATCH`.
- **Yopish.** Oddiy `card:retire` kartani `DRAINING` qiladi (alert `cardDraining`); shu kartaning band summalari `reservedUntil` gacha yoziladi, keyin
  karta avtomatik `RETIRED` bo‘ladi. `--emergency` (karta bloklandi, ishonchsiz) — kartaning `PENDING` so‘rovlari `CANCELLED`, havola tokenlari
  o‘ladi va karta darhol `RETIRED` bo‘ladi; yo‘ldagi pul baribir ko‘rib chiqishga tushadi.
- `(bank, last4)` bo‘yicha faqat bitta faol (`RETIRED` emas) karta bo‘lishi mumkin (bot xabari kartani `last4` bilan aniqlaydi). `card:add` yaqinda
  ishlatilgan `(bank, last4)` ni rad etadi: kartada hali `reservedUntil > now` so‘rov bor yoki u `RETIRED` bo‘lganiga 30 kun bo‘lmagan (taxmin, S4 da
  sozlanadi) — aks holda eski o‘tkazmalar yangi kartaga tegishli bo‘lib qolardi.
- Karta raqamlari faqat o‘z so‘rovi egasiga va faqat `PENDING` da ko‘rsatiladi; egasi ismi — qisqa shaklda (`ALISHER K.`). Mijoz kartasi ma’lumotlari
  **hech qachon** saqlanmaydi.
- Barcha karta amallari — ega CLI (VPS) orqali, `AuditLog` bilan (D-37 (9)); admin panel — 9-bosqichda.
- **Jimlik aniqlanishi.** Faol kartaga `BANK_FEED_DEFAULTS.SILENCE_ALERT_HOURS` (standart 6) **kunduzgi** soat davomida birorta ham kirim (`CREDIT`) bo‘lmasa
  alert `cardSilent`: jim tinglovchi yoki bot savdo yo‘qligidan farq qilmaydi. Tun soatlari (Asia/Tashkent 00:00–08:00) sanalmaydi
  (`daytimeMinutesBetween`, `isCardSilent`). Alert har jimlik davriga **bitta**: `refId` = `<cardId>_<oxirgi kirim vaqti, epoch soniya>`, shuning uchun
  davr tugamaguncha (yangi kirim kelmaguncha) job id o‘zgarmaydi va qayta yuborilmaydi.
- `card:add` egasi ismini qisqa shaklga keltirib ko‘radi (`shortHolderName`); natija **bo‘sh** chiqsa (ism faqat ko‘rinmas belgilardan iborat) kartani rad etadi.
- `card:add` karta raqamini (16 raqam, bo‘shliq va chiziqcha tashlab yuboriladi) **Luhn** nazorat raqami bilan tekshiradi (ISO/IEC 7812): bitta xato yoki
  ikki almashgan raqam karta mijozlarga ko‘rsatilishidan oldin ushlanadi; mos kelmasa — rad (`VALIDATION_ERROR`, `field: pan`).

## 3. Noyob summa va karta tanlash

- Foydalanuvchi asos summani beradi (masalan 20 000 so‘m); API unga 1–999 so‘m qo‘shimcha qo‘shadi (20 341 so‘m) — aynan shu summa
  to‘lovning identifikatori. Hamma summa tiyinda, `BigInt`.
- **Band muddati (`reservedUntil`).** Har P2P summa kartada `reservedUntil` gacha band: yaratilganda `expiresAt + grace` (30 daqiqa + 24 soat),
  so‘rov `PAID` bo‘lsa aynan `GREATEST(reservedUntil, paidAt + grace)`, bunda `grace = reservedUntil − expiresAt` (yaratilishda qo‘yilgan farq); ya’ni muddat
  hech qachon qisqarmaydi va 30 daqiqa ichida to‘langan so‘rovda eski, uzunroq muddat qoladi; boshqa qiymatni DB rad etadi (`reservedUntilAtCreation` /
  `reservedUntilWhenPaid`, `intent-state.ts`). Shunda to‘langandan keyin yana shu summa kelsa u begona pul emas, `DUPLICATE`. Himoya — DB exclusion
  constraint (S2): bir kartada bir summa uchun ikkita ustma-ust tushuvchi band oralig‘i bo‘lmaydi. Eslatma: `reservedUntil` o‘tgach summa qayta
  berilishi mumkin; shuning uchun tanlashda oxirgi 7 kunda ishlatilmagan qo‘shimchalar afzal ko‘riladi (tavsiya).
- Noyoblik **karta bo‘yicha umumiy summa** orasida. Bitta tranzaksiyada **bitta** karta uchun `pg_advisory_xact_lock` olinadi (ikkinchisini ushlab turib
  uchinchisi olinmaydi — deadlock yo‘q; kartalar «Karta tanlash» tartibida — avval yopishqoq karta, keyin bo‘sh sig‘imi kattaroq, teng bo‘lsa `id` — ketma-ket sinab ko‘riladi, har biri alohida tranzaksiyada). Bo‘sh qo‘shimchalardan
  `crypto.randomInt` bilan tanlanadi; DB himoyasi — `UNIQUE (userId) WHERE status = 'PENDING' AND provider = 'P2P_CARD'` va exclusion constraint.
  Poyga bo‘lsa bitta qayta urinish, keyin `503`. **Tanlash tartibi:** (1) oxirgi 7 kunda hech bir so‘rovga berilmagan bo‘sh qo‘shimchalardan tasodifiy;
  (2) bunday qo‘shimcha qolmasa — **LRU zaxirasi**: hozir bo‘sh (`reservedUntil` o‘tgan) qo‘shimchalar ichidan eng uzoq vaqt oldin band bo‘lganini olish
  (u eng kam xavfli: eski kech to‘lov unga tushishi ehtimoli eng past); (3) bo‘sh qo‘shimcha umuman yo‘q (999 tasi ham band) — keyingi karta, u ham bo‘lmasa `503`.
- **Muddat.** So‘rov 30 daqiqa (`TOPUP_INTENT_TTL_SEC`); summa muddatdan keyin yana 24 soat band (`TOPUP_LATE_GRACE_SEC`) (D-37 (2)).
- **Karta tanlash.** Foydalanuvchi bankni tanlaydi yoki «avtomatik» (D-37 (3)); bank ichida karta avtomatik: `ACTIVE`, pauza qilinmagan, sig‘imi
  yetadigan. **Yopishqoq karta:** foydalanuvchiga imkon qadar oldingi kartasi beriladi (sig‘imi bor bo‘lsa); aks holda eng katta bo‘sh sig‘imli karta.
  Sig‘im = limit − qabul qilingan − band summalar (oylik chek bo‘lsa joriy oy, Asia/Tashkent). **Band summalar (D-42 (1), D-37 (6) ni o‘zgartiradi):** har bir to‘lanmagan
  so‘rov (`PENDING`, `EXPIRED`, `CANCELLED`) bitta shart bilan sanaladi: `reservedUntil > now` va `expiresAt > now − TOPUP_CAPACITY_HOLD_SEC`, ya’ni
  `LEAST(reservedUntil, expiresAt + hold)` gacha (standart 3600 s, > 0, ≤ `TOPUP_LATE_GRACE_SEC`, production’da ≥ `TOPUP_INTENT_TTL_SEC`). Muddati ichidagi
  `PENDING` shunda to‘liq sanaladi, muddati o‘tgan, lekin sweep hali `EXPIRED` qilmagan `PENDING` esa `EXPIRED` bilan bir vaqtda sanalmay qoladi; `PAID` band emas, uning puli «qabul qilingan»da. Summaning o‘zi esa butun grace davomida band qoladi: exclusion constraint,
  qo‘shimcha tanlash va «3 ta to‘lanmagan band so‘rov» cheki `reservedUntil` bo‘yicha. Shunda «yarat → bekor qil» kartani 24 soat emas, ko‘pi bilan
  `expiresAt + 1 soat` gacha band qiladi. **Qoldiq xavf:** `expiresAt + hold` dan keyin bu sig‘im boshqalarga beriladi, kech to‘lov esa `reservedUntil` gacha
  (24 soat) kelishi mumkin, shuning uchun karta limitdan oshib ketishi mumkin. Runbook: karta limitini bank chegarasidan zaxira bilan pastroq qo‘ying. S6 da
  `paidAt > expiresAt + hold` bo‘lgan to‘lov kartani limitdan oshirsa, egaga alert boradi. Kartada to‘lanmagan band ulush qolgan limitning (umrlik va oylik qoldiqning kichigi) 50% idan oshsa, egaga alert
  (faqat id’lar, karta bo‘yicha soatiga bitta, so‘rov yaratilgandan keyin tekshiriladi, best effort). Hech biri yo‘q yoki tinglovchi
  heartbeat’i `BANK_FEED_HEARTBEAT_MAX_AGE_SEC` (120 s) dan eski bo‘lsa — `503 PAYMENT_METHOD_UNAVAILABLE`. Karta raqami har safar boshqacha bo‘lishi
  mumkinligi Mini App va to‘lov sahifasida ogohlantiriladi.
- **Band qilish fermasiga qarshi:** bir vaqtda 1 ta `PENDING` va jami **3 ta TO‘LANMAGAN** band so‘rov (`PENDING` va `reservedUntil > now` bo‘lgan
  `EXPIRED`/`CANCELLED`; `PAID` sanalmaydi: chek «yarat → bekor qil» fermasiga qarshi, to‘langan so‘rov esa haqiqiy pul; `Retry-After` shu so‘rovlarning eng yaqin
  `reservedUntil`i); 5 so‘rov / 10 daqiqa va 10 so‘rov / 24 soat (`429`). **Kunlik pul cheklari ASOS summa bo‘yicha** sanaladi (`baseAmountTiyin`, tasodifiy
  qo‘shimcha emas): oxirgi 24 soatdagi `PAID` (`paidAt` bo‘yicha) va `PENDING` (`createdAt` bo‘yicha) so‘rovlar + yangisi ≤ 5 000 000 so‘m (barcha akkaunt) va
  ≤ 500 000 so‘m (7 kundan yosh akkaunt); `EXPIRED`/`CANCELLED` sanalmaydi. Hisob — bitta sof funksiya (`checkDailyTopupLimit`): aynan 500 000 so‘m ruxsat,
  501 000 so‘m `422`; xatoda `details.max` = bugun qolgan limit (`min` dan kichik bo‘lishi mumkin — «bugungi limit tugadi»). **Nazorat raqami yo‘q** (summa tuzilishi
  o‘zgarmaydi, D-37 (2)): raqam so‘rovni begona odamga yuborishni yengillashtirmasin, qolgan cheklar yetarli deb qabul qilingan.
- **Havola tokeni** — 8-bo‘lim.

## 4. Xabar manbasi

- **Manba.** Ikki bot: @HUMOcardbot (Humo) va @CardXabarBot (Uzcard). Ularning xabarlarini **bitta alohida ishchi Telegram akkaunti**
  (alohida SIM, 2FA, faqat shu ikki bot, D-37 (1)) oladi; worker shu akkauntning MTProto foydalanuvchi sessiyasi bilan (`@mtcute/node`, D-37 (13))
  botlarning shaxsiy chatini o‘qiydi. Telegram akkauntni cheklash xavfi qabul qilingan; shuning uchun faqat o‘qiladi, chastota past.
- **Ikki kanal.** Yangi xabar update’i faqat «turtki»; asosiy manba — har `BANK_FEED_POLL_SEC` (20 s) dagi `getHistory(minId = kursor)`.
  Kursor `BankFeedCursor` da, `BankMessage` INSERT bilan **bitta tranzaksiyada** suriladi: update yo‘qolsa ham poll topadi.
- **Lider.** Redis `lock:bank-feed` (TTL 30 s, har 10 s yangilanadi): bitta auth key bilan ikki ulanish (`AUTH_KEY_DUPLICATED`) bo‘lmasin.
- **Qabul filtri (parserdan oldin).** Faqat sozlangan **raqamli bot id** dan, botning shaxsiy chatida, `isBot`, **kiruvchi** (chiquvchi `out` xabar rad
  etiladi), forward emas, tahrirlanmagan (`editDate` bo‘sh), `viaBot` yo‘q xabar. Boshqa chatlar so‘ralmaydi, ularning matni o‘qilmaydi va logga
  tushmaydi. Rad etilgani — `BankMessage(REJECTED)` + review + alert; tahrir update’i — alert `edited`, avvalgi qator o‘zgarmaydi. Bot id’lari env’da
  qotirilgan; boot’da `getUsers(id)` bilan kutilgan username solishtiriladi, runtime’da username qidirilmaydi.
- **Kuzatuv.** Redis `bankfeed:heartbeat` (har poll’da). **`account.getAuthorizations` har poll’da** tekshiriladi: ishchi akkauntda noma’lum yangi avtorizatsiya
  chiqsa **BARCHA kartalarda avtomatik yozish to‘xtaydi** (fail-closed; kirimlar review `AUTO_CREDIT_PAUSED`) va alert `newAuthorization` yuboriladi;
  ega sessiyalarni tekshirib `card:resume` qiladi. `AUTH_KEY_UNREGISTERED` / `SESSION_REVOKED` = alert + tinglovchi to‘xtaydi. (Bu S7 dizayni.)
- **Rejimlar.** `BANK_FEED_MODE=off` (standart) | `fake` (dev/test: ega CLI’si fixture kiritadi, haqiqiy Telegram’siz to‘liq oqim) | `live`
  (barcha `BANK_FEED_*` bilan). Production’da `fake` rad etiladi.
- **Sessiya siri.** AES-256-GCM (`BANK_FEED_SESSION_ENC` = `iv(12)`, `tag(16)`, `ciphertext`; kalit `BANK_FEED_ENC_KEY`); faqat worker xotirasida
  ochiladi (`MemoryStorage`, diskka fayl yozilmaydi). API muhitida bu o‘zgaruvchilar bo‘lsa API ishga tushmaydi.
- **Xom matn** admin ko‘rishi uchun 1 yil saqlanadi (D-37 (10)); hech qachon logga yozilmaydi.

**Runbook (VPS, ega ishtirokida — D-37 (14)).**

1. _Login:_ worker konteynerida `bank-feed-login` CLI (telefon, kod, 2FA; faqat TTY) — chiqishi **faqat shifrlangan blob**; uni env’ga qo‘yish.
   Ochiq sessiya hech qayerga yozilmaydi, dev kompyuterda saqlanmaydi.
2. _Bekor qilish:_ ishchi akkaunt Telegram → Devices orqali sessiyani yopish; keyin `BANK_FEED_MODE=off` va yangi login.
3. _Almashtirish:_ yangi akkaunt/sessiya bilan 1-band; eski sessiya yopiladi, kursor va `BankMessage` tarixi saqlanadi.
4. _Akkaunt cheklansa:_ tinglovchi to‘xtaydi, heartbeat eskiradi → yangi so‘rovlar avtomatik `503`, ega alert oladi; yo‘ldagi to‘lovlar
   tiklangandan keyin 48 soatlik qayta skan bilan topiladi (10-band). Telegram support orqali tiklanadi yoki yangi akkaunt.
5. _Karta bloklansa:_ `card:retire <id> --emergency` (PENDING so‘rovlar bekor, tokenlar o‘ladi), kartaga kelgan pulni bank orqali aniqlash, ko‘rib
   chiqishlarni (`review:list`) yopish; foydalanuvchilarga yangi so‘rov boshqa kartaga beriladi.
6. _Kalit saqlash:_ `BANK_FEED_ENC_KEY` productionda Docker secret faylida turadi, env o‘zgaruvchisida emas (11-bosqich); worker konteynerida core dump
   o‘chiriladi (`ulimit -c 0`, `/proc/sys/kernel/core_pattern`), chunki xotirada ochiq sessiya bor.
7. _Pepper almashtirish:_ `PAY_TOKEN_PEPPER` almashsa barcha havola tokenlari o‘ladi (xesh mos kelmaydi); kutilayotgan foydalanuvchilar yangi havola oladi
   (`POST /payments/intents/:id/pay-link`). Rejali almashtirish — kam yuklangan vaqtda.
8. _Reverse proxy:_ access log formatida `t` query parametri va `X-Pay-Token` sarlavhasi yashiriladi (devops, 11-bosqich).

## 5. Parser

Tildan mustaqil, faqat **boshidagi marker** bo‘yicha (`apps/worker/src/bank-feed/parsers/`). Tuzilma (qiymatsiz):

- **Humo:** 1-qator emoji + sarlavha (kirim yoki chiqim); `➕`/`➖` + summa; `📍` kanal; `💳` karta `*NNNN`; soat emojisi + vaqt; `💰` + keyingi balans.
- **Uzcard:** 1-qator `🟢`/`🔴` + sarlavha; `➕`/`➖` + summa; `💳` karta `***NNNN`; `📍` kanal (bir necha qator bo‘lishi mumkin); soat emojisi + vaqt;
  `💵` + balans.
- Bitta bot chatiga bir nechta kartaning xabari keladi: karta `last4` bo‘yicha aniqlanadi. Xabar ostidagi inline tugmalar e’tiborsiz.

Qoidalar:

1. Matn NFC, `U+FE0F` olib tashlanadi, `U+00A0` / `U+202F` / `U+2009` oddiy bo‘shliqqa aylanadi, bo‘sh qatorlar tashlanadi.
2. Qator turi marker bilan: yo‘nalish `➕ + ➖ − -`; karta `💳`; kanal `📍 📌`; vaqt — istalgan soat emojisi (`U+1F550–1F567`, `⏰`, `🕰`);
   balans `💰 💴 💵 💶 💷`. Emoji kod nuqtalari rasmdan to‘liq bilinmagani uchun variantlar ataylab keng (D-37 (18)); har bir variant unit test bilan.
3. Yo‘nalish faqat ➕/➖ qatoridan; sarlavha qo‘shimcha tekshiruv: ma’lum sarlavha yo‘nalishga zid bo‘lsa — `UNRECOGNIZED(DIRECTION_CONFLICT)`.
4. Summa: `UZS` majburiy, aynan 2 kasr xonasi; Humo uslubi (nuqta — minglik, vergul — kasr), Uzcard uslubi (bo‘shliq — minglik, nuqta — kasr) va
   ajratgichsiz. `somToTiyin` orqali `BigInt`; **float yo‘q**. Boshqa shakl — `UNRECOGNIZED(AMOUNT_FORMAT)`.
5. Vaqt: ikki format (`HH:MM DD.MM.YYYY` va `DD.MM.YY HH:MM`), Asia/Tashkent = UTC+5 (_taxmin_, S11 da tasdiqlanadi); mavjud bo‘lmagan sana — rad.
6. Yo‘nalish, summa, karta, vaqt, balans — har biri **aynan bir marta**; kanal ixtiyoriy (≤ 200 belgi). Yetishmasa yoki takrorlansa — `UNRECOGNIZED`.
7. Natija: `{ direction, amountTiyin, balanceAfterTiyin, last4, bankTxnAt, channel, titleHint }` yoki `{ ok: false, reason }`; `PARSER_VERSION` har qatorda saqlanadi.
8. Matn va kanal ega CLI’sida (`review:show`) ko‘rsatilganda boshqaruv va bidi belgilari escape qilinadi (terminal in’ektsiyasi); parser matnni hech qachon
   `eval`, shell yoki SQL qatoriga qo‘ymaydi.

## 6. Moslashtirish (`bank-message` navbati)

`bank-message` jobi: `jobId = bm-<BankMessage.id>`, concurrency 1, 5 urinish, eksponensial 2 s.

**Tartib kafolati navbatga emas, bazaga tayanadi (S6 dizayni).** BullMQ qayta urinish kutish (backoff) paytida keyingi jobni ishlaydi, shuning uchun concurrency 1
o‘zi tartibni kafolatlamaydi. Qoida: shu kartadagi `tgMessageId` kichikroq xabarning `BankMessageOutcome`i hali yo‘q bo‘lsa, job **o‘zini kechiktiradi**
(`PREDECESSOR_PENDING`: hech narsa yozmasdan xato bilan chiqadi, BullMQ backoff bilan qayta uradi). Urinishlar tugasa (5 ta) — review va alert:
oldingi xabar ishlanmagani uchun zanjirni tekshirib bo‘lmaydi, shuning uchun kirim avtomatik yozilmaydi. Tartib:

1. `BankMessageOutcome` bor bo‘lsa — hech narsa qilinmaydi (idempotent).
2. `parseStatus ≠ PARSED` → review `UNRECOGNIZED` / `REJECTED` + alert.
3. Karta **qabul paytida** aniqlanadi: listener `BankMessage` ni INSERT qilayotgan o‘sha tranzaksiyada `(bank, last4)` bo‘yicha kartani topib `cardId` ni
   yozadi — avval `RETIRED` bo‘lmagan karta, bo‘lmasa eng oxirgi `RETIRED` karta, hech biri bo‘lmasa `NULL`. `BankMessage` append-only, shuning uchun
   `cardId` keyin yozilmaydi va zanjir so‘rovi (`cardId`, `tgMessageId`) shu qiymatga tayanadi. Moslashtirishda: `cardId` `NULL` → review `CARD_UNKNOWN`;
   karta `RETIRED` → `CARD_RETIRED`. `DRAINING` karta mos keladi (mavjud so‘rovlar yoziladi).
4. **Zanjir** (karta bo‘yicha, `tgMessageId` o‘sish tartibida): kirim → `oldingi + summa = keyingi balans`; chiqim → `oldingi − summa = keyingi balans`.
   Birinchi xabar `FIRST`. Mos kelmasa `BREAK`: review `CHAIN_BREAK`, alert, karta `autoCreditPaused` — **fail-closed** (D-37 (8)). Pauza paytidagi
   kirimlar review `AUTO_CREDIT_PAUSED`. Ega `card:resume` yoki `review:accept-chain` qiladi.
   **Chiqim (DEBIT)** hisobga tegmaydi (`DEBIT_RECORDED`), lekin **har DEBIT haqida egaga alert** (`debit`: last4 va summa); yaqinda (7 kun) yozilgan to‘lov
   summasiga teng DEBIT — review `POSSIBLE_REVERSAL` (bank pulni qaytarib olgan bo‘lishi mumkin).
5. `VERIFYING` karta va kirim = `verifyAmountTiyin` → karta `ACTIVE`, outcome `CARD_VERIFIED`, ledger yo‘q, alert `cardVerified`.
6. Kirim nomzodlari: `P2P_CARD`, shu karta, holati **`PENDING` / `EXPIRED` / `CANCELLED`**, summasi **aynan teng**, `reservedUntil ≥ xabar vaqti`, so‘rov yaratilishidan 120 s dan oldingi emas
   (`createdAt − 120 s ≤ tgDate`). Bank vaqti va Telegram vaqti farqi `BANK_TIME_SKEW_SEC` (600 s) dan oshsa — review `TIME_SKEW`.

| Nomzod                                                                                              | Natija                                                                         |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 1 ta `PENDING`                                                                                      | avtomatik TOPUP, `notify TOPUP_CREDITED`                                       |
| 1 ta `EXPIRED` (grace ichida)                                                                       | avtomatik TOPUP, so‘rov `PAID`, `notify TOPUP_LATE_CREDITED` (D-37 (5))        |
| 1 ta `CANCELLED` (grace ichida)                                                                     | **avtomatik yozilmaydi**: review `CANCELLED_LATE` (foydalanuvchi bekor qilgan) |
| 0 ta nomzod, lekin **alohida qidiruvda** shu summali `PAID` so‘rov topildi (`reservedUntil` ichida) | review `DUPLICATE` — ega qo‘lda yozadi                                         |
| 0 ta                                                                                                | review `NO_MATCH`                                                              |
| 2+ ta                                                                                               | review `AMBIGUOUS` + alert (bo‘lmasligi kerak)                                 |

`NO_MATCH` haqida: summa hech bir so‘rovning band oralig‘ida bo‘lmasa, pul kimniki ekanini bilib bo‘lmaydi — ega ko‘radi. **Qoldiq xavf:** grace’dan
(24 soat) keyin kelgan kech to‘lov, agar o‘sha summa shu vaqtda boshqa foydalanuvchining `PENDING` so‘roviga berilgan bo‘lsa, ajratib bo‘lmaydi va
o‘sha so‘rovga yoziladi; bunga qarshi — uzun grace va ishlatilmagan qo‘shimchalarni afzal ko‘rish (3-band), hamda kunlik solishtirish.

7. **Hisobga yozishdan oldingi qo‘shimcha tekshiruvlar** (nomzod aniq bitta bo‘lganda): foydalanuvchi bloklangan bo‘lsa — review `USER_BLOCKED`; **IKKALA kunlik
   chek** (yangi akkaunt 500 000 so‘m va barcha akkaunt 5 000 000 so‘m) yaratishdagi formula bilan qayta tekshiriladi: oxirgi 24 soat (`PAID` — `paidAt`, `PENDING` —
   `createdAt` bo‘yicha), ASOS summalar, shu so‘rovning o‘zi hisobda ikki marta emas. Oshsa — review `DAILY_LIMIT` (bitta tur); review ma’lumotida qaysi chek oshgani
   yoziladi (`DAILY_LIMIT` yoki `NEW_ACCOUNT_DAILY_LIMIT`); alert `dailyLimit` kodni emas, egaga tushunarli matnni ko‘rsatadi: «barcha akkaunt: kuniga 5 000 000 so‘m» yoki
   «yangi akkaunt: kuniga 500 000 so‘m» (`alerts.limitReason.*`, uz va ru).
8. **Hisobga yozish — BITTA `$transaction`:** intent `FOR UPDATE` → holat `assertIntentTransition` bilan qayta tekshiriladi → `lockWallet` →
   `Payment(P2P_CARD, providerTxnId = "<senderId>:<tgMessageId>", bankMessageId, userId, intentId, CONFIRMED)` → intent `PAID` →
   `LedgerEntry(TOPUP, +summa, PAYMENT/<paymentId>)` → `BankMessageOutcome(CREDITED)`. Har qanday unique to‘qnashuvi — rollback va «allaqachon
   ishlangan». Commit’dan **keyin**: `DEL wallet:{userId}`, `notify` job (faqat `paymentId` bilan: API foydalanuvchini `Payment` qatoridan oladi), karta limiti
   tekshiruvi (80% → alert, 100% → `FULL`).

**Hech qachon avtomatik yozilmaydi:** tanilmagan, rad etilgan, karta noma’lum/RETIRED, zanjir buzilgan, pauza, mos kelmagan, bir nechta nomzod,
takroriy, vaqti mos kelmagan, bekor qilingan so‘rovga kelgan, bloklangan foydalanuvchi, yangi akkaunt limiti oshgan. Ularning hammasi `PaymentReview`
va ega alertiga tushadi.

## 7. Tekshiruv navbati va ega CLI

`PaymentReview` (`kind`: `UNRECOGNIZED`, `REJECTED`, `CARD_UNKNOWN`, `CARD_RETIRED`, `CHAIN_BREAK`, `AUTO_CREDIT_PAUSED`, `NO_MATCH`, `AMBIGUOUS`, `DUPLICATE`,
`TIME_SKEW`, `CANCELLED_LATE`, `DAILY_LIMIT`, `POSSIBLE_REVERSAL`, `USER_BLOCKED`; `OPEN`/`RESOLVED`; `(bankMessageId, kind)` unique). Yechimlar:
`CREDITED_USER`, `IGNORED`, `RETURNED_OFFLINE` (pul bot tashqarisida qaytarilgan), `CHAIN_ACCEPTED`. Ega VPS’dagi CLI orqali ishlaydi (D-37 (9)),
har buyruq `--reason` bilan va `AuditLog` yozuvi (`actorType=CLI`) bilan **bitta tranzaksiyada**:

- `review:list`, `review:show <id>` (xom matn faqat shu yerda; boshqaruv va bidi belgilari escape qilinadi), `review:credit <id> --user | --intent`,
  `review:ignore`, `review:returned-offline`, `review:accept-chain`;
- `card:add --bank --pan --holder --limit [--monthly-limit]`, `card:list`, `card:retire [--emergency]`, `card:limit`, `card:pause`, `card:resume`;
- `wallet:adjust --user --amount`, `payment:reverse <paymentId>`.

`review:credit` bank xabari bo‘yicha ham idempotent: bitta xabar ikki marta yozilmaydi (`Payment.bankMessageId` unique); bekor qilingan so‘rovni
yopish (`CANCELLED → PAID`) faqat shu yo‘l bilan (`actor: admin`) va faqat **grace ichida**. **Grace’dan keyin so‘rov holati umuman o‘zgarmaydi**
(`EXPIRED`/`CANCELLED` → `PAID` yo‘q): pul faqat review orqali, so‘rovsiz yoziladi (`Payment` + `reviewId`, `intentId` yo‘q), `reservedUntil` esa uzaytirilmaydi. **Xavfsizlik (S8 dizayni):** `ADMIN_CONFIRM_THRESHOLD_TIYIN` dan katta pul amalida
(`review:credit`, `wallet:adjust`, `payment:reverse`) summa qayta kiritiladi **va** ega botdan OTP oladi (`rules/60-security.md`: yangi OTP tasdig‘i); **har
pul yoki karta amali haqida egaga alert** (`adminAction`: amal va `AuditLog` havolasi, summasiz). Noto‘g‘ri/ortiqcha pul qaytarish — bot tashqarisida (D-37 (5)).

`review:credit --intent` faqat xabar kartasi va summasi so‘rovniki bilan **aynan** mos bo‘lsa ishlaydi (DB `Payment` triggeri boshqasini rad etadi); mos kelmasa — `--user` (so‘rovsiz, `reviewId` bilan). `UNRECOGNIZED` va `REJECTED` xabar `review:credit` bilan pulga aylanmaydi (DB faqat `PARSED` kirim xabarini qabul qiladi): bunday pulni ega faqat `wallet:adjust` orqali, sabab va `AuditLog` bilan yozadi.

## 8. Havola tokeni (D-39)

Mini App to‘ldirish sahifasini web domenda `openLink` bilan sessiyasiz ochadi (D-03), shuning uchun `POST /payments/intents` javobidagi
`redirectUrl` capability token olib yuradi: `${WEB_URL}/pay/<intentId>?locale=<uz|ru>#t=<token>` — token **URL fragmentida** (D-37 (15)): fragment hech qaysi serverga,
proksi log’iga va `Referer` ga tushmaydi. Sahifa tili (D-38 Q21) `?locale=` da: foydalanuvchi tili, standart `uz`, faqat `uz` yoki `ru`; boshqa hech qanday so‘rov
parametri yo‘q (`PayLinkUrlSchema`).

- Token: 32 bayt `crypto.randomBytes`, base64url (43 belgi). DB’da faqat `HMAC-SHA256(PAY_TOKEN_PEPPER, intentId + ":" + token)` (hex, unique);
  ochiq token faqat yaratish/qayta berish javobida, log/Redis/navbat/DB’da yo‘q.
- Endpoint: `GET /api/v1/payments/pay/:intentId`, token **`X-Pay-Token` sarlavhasida**. `@Public`, faqat o‘qish; javob: bank, karta raqami, egasi
  ismi (qisqa), to‘lanadigan summa, `expiresAt`, holat, `ownerHint`. Karta faqat `PENDING` da; foydalanuvchi, balans, ledger, boshqa so‘rovlar — yo‘q.
- Muddat: `now < intent.expiresAt`; `PAID` bo‘lgach ham `expiresAt` gacha o‘qiladi (`card: null`). Token o‘qishda bir martalik **emas**: sahifa polling qiladi (≥ 5 s).
- Rotatsiya: `POST /payments/intents/:id/pay-link` va idempotent takror (faqat `PENDING` va muddati o‘tmagan) yangi token beradi, eskisi o‘ladi; `CANCELLED` bo‘lsa xesh `NULL`.
- Rad etish: noma’lum so‘rov, **noto‘g‘ri shakldagi `intentId`**, token yo‘q/noto‘g‘ri shakl/xesh mos emas (`timingSafeEqual`, xesh doim hisoblanadi)/muddat
  o‘tgan/bekor — hammasi **bir xil `404`** va bir xil vaqt tartibida. Limitlar: IP’ga 300/daqiqa (IPv6 /64) + so‘rovga 30/daqiqa → `429` + `Retry-After`.
- Sarlavhalar: `Cache-Control: no-store`, `Referrer-Policy: no-referrer`; CORS faqat `WEB_URL`. `/pay` HTML javobi: shuningdek `X-Robots-Tag: noindex`,
  `frame-ancestors 'none'`.
- **Firibgarlikka qarshi (D-37 (7)):** sahifa va Mini App «Bu havola faqat o‘z ggpin hisobingizni to‘ldirish uchun. Boshqa odam yuborgan bo‘lsa, to‘lamang»
  deydi va `ownerHint` (`S***r`) ko‘rsatadi — begona odam yuborgan havola bo‘yicha to‘layotgan odam hisob egasini darhol tanishi uchun.
- Frontend: tokenni `location.hash` dan o‘qiydi, `history.replaceState` bilan olib tashlaydi (`?locale=` qoladi), tilni `readPayLocaleFromQuery` bilan oladi, `credentials: 'omit'`, uchinchi tomon resursi yo‘q (`docs/04`).
- **Qoldiq xavf:** havola kimdadir bo‘lsa shu so‘rovning karta va summasini ko‘ra oladi (hisobga kira olmaydi); bu cheklangan: o‘qish huquqi, `expiresAt` gacha.

## 9. Reversal va ADJUSTMENT

Faqat ega CLI’si, `--reason` majburiy (1–500 belgi), `AuditLog` bilan bir tranzaksiyada, katta summalarda OTP (7-band).

- **`payment:reverse`** (karta egasi pulni qaytarib oldi / noto‘g‘ri yozilgan): `Payment` `CONFIRMED` bo‘lishi shart → `lockWallet` →
  `LedgerEntry(TOPUP_REVERSAL, −summa, PAYMENT/<paymentId>)` + `Payment.status=CANCELLED`. Foydalanuvchi pulni sarflab bo‘lgan bo‘lsa reversal
  baribir yoziladi, **balans manfiyga tushadi**, `User.purchaseFrozen=true` va ega alert oladi (`walletFrozen`). Manfiy hisob to‘ldirish bilan yopiladi.
  Bank pulni o‘zi qaytarib olsa (chiqim xabari) bu `POSSIBLE_REVERSAL` review sifatida keladi (6-band) — egaga `payment:reverse` qilish qoladi.
- **`wallet:adjust`** (`±`, ≠ 0): `LedgerEntry(ADJUSTMENT, ADMIN_ACTION/<AuditLog.id>)`; manfiy natija ham `purchaseFrozen` + alert. Bir audit id ikki marta yozilmaydi.
- Ikkalasi ham balans keshini commit’dan keyin o‘chiradi. Tushmagan yoki noto‘g‘ri pul uchun **qaytarish** bot tashqarisida bajariladi (`RETURNED_OFFLINE`).

## 10. Solishtirish (`payment-reconcile`, worker)

Har kuni 03:00 (Asia/Tashkent) — tarixni qayta skan qilish MTProto talab qilgani uchun u **worker**da ishlaydi. Oxirgi 48 soatlik tarix qayta o‘qiladi
(yo‘q id oddiy ingest’dan o‘tadi); tekshiriladi: har PARSED kirimda outcome bor; har `P2P_CARD` Payment’da `BankMessage` bor; karta bo‘yicha kirim
summasi = CREDITED + CARD_VERIFIED + review summalari; zanjir uzluksiz; OPEN review soni; grace o‘tgan so‘rovlar; **chiqimlar xulosasi** (karta bo‘yicha
DEBIT soni va summasi, yaqinda yozilgan to‘lovga teng chiqimlar). Natija `AuditLog(PAYMENT_RECONCILE)` va alert (`reconcileOk` / `reconcileMismatch`, ikkalasida
chiqimlar soni). Solishtirish o‘zi **pul yozmaydi**. Yana: `topup-expire` har daqiqada `PENDING` va `expiresAt` o‘tganini `EXPIRED` qiladi, karta limitlarini va
jimlikni (2-band) tekshiradi.

### Ogohlantirishlar jadvali (`notify` → `OWNER_ALERT`)

Job faqat `{ alert, refId }` olib yuradi; API `refId` bo‘yicha ma’lumotni bazadan o‘qiydi va matnni `alerts.bankFeed.*` (uz) dan yasaydi. Job id =
`alert-<alert>-<refId>`: BullMQ bir xil id ni qayta qabul qilmaydi, shuning uchun `refId` har **mantiqiy hodisaga** bitta bo‘lishi kerak (takrorlanishi
kerak bo‘lgan alertlarda vaqt bo‘lagi qo‘shiladi). `refId` faqat `[A-Za-z0-9_]`, ko‘pi bilan 64 belgi.

| Alert                                                               | `refId`                                                        | Parametrlar manbasi                                                                                                                   |
| ------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `unrecognized`, `cardUnknown`, `timeSkew`                           | `PaymentReview.id`                                             | `reviewId` = refId                                                                                                                    |
| `rejected`                                                          | `PaymentReview.id`                                             | `reviewId`; `reason` = `BankMessage.rejectReason` (kod, matn emas)                                                                    |
| `cardRetired`, `chainBreak`, `autoCreditPaused`                     | `PaymentReview.id`                                             | `reviewId`; `last4` = kartadan                                                                                                        |
| `noMatch`, `ambiguous`, `duplicate`, `cancelledLate`, `userBlocked` | `PaymentReview.id`                                             | `reviewId`; `amount` = xabar summasi (`formatMoney`)                                                                                  |
| `dailyLimit`                                                        | `PaymentReview.id`                                             | `reviewId`; `amount`; `limit` = oshgan chekning o‘qiladigan matni (`alerts.limitReason.<kod>`, `{cap}` = chek summasi, `formatMoney`) |
| `possibleReversal`                                                  | `PaymentReview.id`                                             | `reviewId`; `last4`; `amount`                                                                                                         |
| `edited`                                                            | `BankMessage.id`                                               | `messageId` = refId                                                                                                                   |
| `debit`                                                             | `BankMessage.id`                                               | `last4`; `amount` (xabardan, har chiqim uchun)                                                                                        |
| `cardVerified`, `cardFull`, `cardDraining`                          | `TopupCard.id`                                                 | `bank`; `last4`                                                                                                                       |
| `cardNearLimit`                                                     | `<cardId>_80` (80% chegarasi, bir marta)                       | `bank`; `last4`; `percent`                                                                                                            |
| `cardReservedHigh`                                                  | `<cardId>_<epoch soat>` (soatiga bitta; `cardReservedHighRef`) | `bank`; `last4`; `percent` = to‘lanmagan band ulushi, bazadan qayta hisoblanadi (`reservedSharePercent`)                              |
| `cardSilent`                                                        | `<cardId>_<oxirgi kirim, epoch soniya>`                        | `bank`; `last4`; `hours` = kunduzgi jimlik soatlari                                                                                   |
| `listenerDown`                                                      | `<epoch soat>` (soat bo‘lagi)                                  | `minutes` = heartbeat yoshi                                                                                                           |
| `sessionRevoked`                                                    | `<epoch soat>`                                                 | —                                                                                                                                     |
| `newAuthorization`                                                  | `<Telegram avtorizatsiya id>`                                  | —                                                                                                                                     |
| `reconcileOk`, `reconcileMismatch`                                  | `<yyyymmdd>` (Asia/Tashkent)                                   | `count` = tekshirilgan xabarlar yoki farqlar; `debits` = chiqimlar soni                                                               |
| `walletFrozen`                                                      | `<userId>_<ledgerEntryId>`                                     | `userId` (refId ning birinchi qismi)                                                                                                  |
| `adminAction`                                                       | `AuditLog.id`                                                  | `action` = `AuditLog.action`; `ref` = `AuditLog.id` (summasiz)                                                                        |

`refId` ni yasash: `alertRef.walletFrozen`, `alertRef.cardSilent` (`packages/shared/src/notify.ts`). Bot-lifecycle alertlari (`webhookFailed`, `setupFailed`) bu navbatdan
o‘tmaydi: API ularni to‘g‘ridan-to‘g‘ri `tg-outbox` ga qo‘yadi (job id boot vaqti va urinish raqamidan).

## 11. Xavfsizlik, firibgarlik limitlari va xavf yozuvi

- Soxta xabar: qotirilgan sender id, shaxsiy chat, kiruvchi xabar, forward/tahrir rad, zanjir, 2FA, avtorizatsiya kuzatuvi. Ikki marta yozish: `(senderId, tgMessageId)`
  unique, `Payment.bankMessageId`, outcome unique, ledger unique, intent `FOR UPDATE`. Noto‘g‘ri foydalanuvchi: noyob summa + band oralig‘i (exclusion constraint) + partial unique.
- **Firibgarlik limitlari — majburiy (D-37 (7)):** bitta `PENDING` va jami 3 TO‘LANMAGAN band so‘rov; so‘rov yaratish 5 ta / 10 daqiqa va 10 ta / 24 soat; **barcha**
  akkauntga 24 soatda 5 000 000 so‘m (`TOPUP_DAILY_MAX_TIYIN`); 7 kundan yosh akkauntga 500 000 so‘m — ikkalasi ASOS summa bo‘yicha, yaratishda ham, pul yozilayotganda ham
  (review `DAILY_LIMIT`); `ownerHint` va ogohlantirish; reversal + `purchaseFrozen`; karta limitlari.
- Logga yozilmaydi: sessiya, telefon, login kodi, 2FA paroli, bank xabari matni, balans, karta raqami, havola tokeni (qiymat va `#t=`/`?t=` ham redakt qilinadi).
- **Ongli qabul qilingan xavf (D-37 (16); D-14/D-15).**
  - _Zararni kim ko‘taradi:_ ega shaxsan: pul shaxsiy kartalarga tushadi, bank uni qaytarib olsa yoki karta bloklansa yo‘qotish egada; platformada foydalanuvchi
    hamyoni manfiy bo‘lsa xaridlar muzlatiladi.
  - _Maksimal ta’sir:_ bitta kartada — kartaning `receiveLimitTiyin` si (butun davr) va shu vaqtdagi qoldiq; bir foydalanuvchida — kuniga 5 000 000 so‘m
    (yangi akkauntda 500 000); jami — faol kartalar limitlari yig‘indisi.
  - _Karta bloklansa:_ 4-bandning 5-qadami (`card:retire --emergency`), bankga murojaat, qoldiqni ko‘chirish, review’larni yopish.
  - _YaTT’ga o‘tish triggerlari:_ (a) bank kartani bloklasa yoki tijorat tushumi bo‘yicha so‘rov yuborsa; (b) oylik aylanma ega belgilaydigan chegaradan oshsa
    (qiymatni ega belgilaydi); (c) birinchi chargeback yoki firibgarlik (mule) holati; (d) D-04 qayta ko‘rilib Click/Payme ulanadigan bo‘lsa; (e) soliq yoki fiskal
    talab (D-14, D-15) paydo bo‘lsa. Ishga tushirish bunga bloklanmaydi.

## 12. Testlar (majburiy)

Fake tinglovchi + sintetik fixture bilan to‘liq oqim (so‘rov → pay sahifasi → xabar → TOPUP → bot xabari → `/me/wallet`) · bitta xabar 3 marta (update +
tarix + qayta ishga tushish) → bitta TOPUP · ikki ishlovchi parallel → bitta TOPUP · tanilmagan / forward / tahrir / chiquvchi / begona yuboruvchi / zanjir
buzilishi / mos kelmagan / takroriy → avtomatik yozilmaydi, review + alert · kech to‘lov grace ichida (`EXPIRED`) → TOPUP; `CANCELLED` → `CANCELLED_LATE` ·
bloklangan foydalanuvchi, kunlik limit (`DAILY_LIMIT`), yaqinda yozilgan to‘lovga teng chiqim → review · noma’lum yangi avtorizatsiya → hamma kartada pauza ·
bitta kartada 50 parallel so‘rov → 50 xil summa; band oraliq ustma-ust tushmaydi · ikkinchi kutilayotgan so‘rov rad; 4-so‘rov 3 ta to‘lanmagan bandda rad (PAID sanalmaydi) · kunlik chek chegarasi: aynan 500 000 so‘m ruxsat, 501 000 so‘m `422`, `max` = qolgan limit · pul yozilayotganda ikkala chek qayta tekshiriladi → `DAILY_LIMIT` ·
FULL/VERIFYING/DRAINING kartaga yo‘naltirilmaydi, FULL/DRAINING kartaga yo‘ldagi to‘lov yoziladi · havola tokeni: begona / eski / rotatsiya qilingan /
muddati o‘tgan / noto‘g‘ri `intentId` → bir xil 404 · tranzaksiya o‘rtasida xato → hech narsa yozilmaydi · reversal va ADJUSTMENT idempotentligi,
manfiy balans → `purchaseFrozen` · sessiya satri, matn, karta raqami va token logda yo‘q · worker sirlari API’da bo‘lsa boot rad. Haqiqiy akkaunt va test
karta bilan sinov — faqat ega ruxsati va ishtirokida (4-bosqich yakunida); shunda Telegram `openLink` fragmentni (`#t=`) Android, iOS va Desktop’da saqlashi ham
tekshiriladi.

## 13. Keyinroq

### Click, Payme, Uzum, Rahmat (D-04)

Bular hozir ulanmaydi (har bir to‘lovdan ~2% komissiya); aylanma oshib D-04 qayta ko‘rilganda, YaTT shartnomasi bilan, `docs/providers/<code>.md`
rasmiy hujjati asosida qo‘shiladi. Adapter interfeysi bir xil bo‘ladi: `createCheckout`, `handleCallback`, `reconcile`. Qisqacha eslatma:

- **Click** (Shop API): Prepare (`action=0`) va Complete (`action=1`); imzo `sign_string` (MD5) hujjatdagi maydonlar bo‘yicha; `merchant_trans_id` =
  `intentId`; summa so‘mda keladi (tiyinga aniq o‘tkaziladi).
- **Payme** (Merchant API, JSON-RPC 2.0): bitta endpoint, `Authorization: Basic base64("Paycom:<KEY>")`, summa tiyinda; `CheckPerformTransaction`,
  `CreateTransaction`, `PerformTransaction`, `CancelTransaction`, `CheckTransaction`, `GetStatement`; `CancelTransaction` bajarilgandan keyin →
  `TOPUP_REVERSAL` (9-band bilan bir xil qoida). Fiskalizatsiya — buxgalter bilan (D-15).
- **Uzum, Rahmat:** shartnoma va hujjat kelgach to‘ldiriladi (endpointlar, imzo, holatlar, IP allowlist, test muhit).
- Provayder callback’lari uchun xavfsizlik: imzo/auth, aniq summa, intent holati, IP allowlist, `(provider, providerTxnId)` unique, saqlangan javobni
  qaytarish, har imzo xatosi — xavfsizlik hodisasi. Testlar: to‘g‘ri oqim · noto‘g‘ri imzo · noto‘g‘ri summa · callback 3 marta · bekor qilish · muddati o‘tgan intent · parallel callback’lar.

### Telegram Stars (D-33)

Bot API `sendInvoice` / `createInvoiceLink` (`currency: "XTR"`), `pre_checkout_query` → tasdiq, `successful_payment` → TOPUP; Stars → so‘m kursi admin
sozlamasida; Telegram komissiyasi va Stars’ni Fragment orqali yechib olish shartlari hisobga olinadi. Qaror kutilmoqda (D-33).

### Telegram qoidasi haqida eslatma

Telegram hujjatiga ko‘ra bot va Mini App ichida **raqamli mahsulotlar** uchun to‘lov Telegram Stars orqali bo‘lishi kerak. Qaror D-03: to‘ldirish
web-domenda (`/pay/:intentId`), Mini App uni `openLink` bilan ochadi; Stars to‘ldirish usuli keyinroq alohida adapter sifatida yoqilishi mumkin.
