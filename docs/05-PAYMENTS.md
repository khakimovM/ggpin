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
  (moslashganmi-yo‘qmi farqsiz: bank nuqtai nazari). **Karta holati va 80/100% ogohlantirishlari faqat haqiqatan tushgan pul bo‘yicha** (D-45, D-37 (6) ni
  o‘zgartiradi): umrlik limit uchun `receivedTiyin`, oylik limit uchun `receivedMonthTiyin`, kattasi olinadi (`receivedUsagePercent`). 80% da ega
  ogohlantiriladi (`cardNearLimit`), 100% da `ACTIVE` karta `FULL` bo‘ladi (`cardFull`). To‘lanmagan band summalar karta holatini **o‘zgartirmaydi**: ular
  faqat yangi so‘rov berishda sig‘imdan ayiriladi (`freeCapacity`, D-42 (1) oynasi), shuning uchun «yarat → bekor qil» kartani doimiy `FULL` qila olmaydi;
  band ulush katta bo‘lsa alohida `cardReservedHigh` alerti boradi. `FULL → ACTIVE` faqat `card:limit` orqali, yangi limitlarda tushgan pul 100% dan past bo‘lsa.
- **Test o‘tkazma.** `card:add` kartani `VERIFYING` qiladi va `verifyAmountTiyin` beradi; ega shu summani o‘tkazganda xabar kelib,
  karta `ACTIVE` bo‘ladi (ledger yozuvi yo‘q). Boshqa summa — review `NO_MATCH`.
- **Yopish.** Oddiy `card:retire` kartani `DRAINING` qiladi (alert `cardDraining`); shu kartaning band summalari `reservedUntil` gacha yoziladi, keyin
  karta avtomatik `RETIRED` bo‘ladi (har daqiqalik `topup-expire` sweep: karta qulfi ostida kartaning birorta so‘rovida — holatidan qat’i nazar —
  `reservedUntil >= now − LATE_STORED_AFTER_MS` (10 daqiqa) qolmagan va kartada qarorsiz xabar yo‘q bo‘lsa; `retiredAt`, SYSTEM `AuditLog` `CARD_RETIRE_DRAINED`,
  alert `cardDrained`). 10 daqiqa zaxira: matcher so‘rovni xabarning Telegram sanasi bo‘yicha oladi (`reservedUntil >= tgDate`), shuning uchun vaqtida
  qilingan, lekin biroz kech saqlangan to‘lov baribir avtomatik yoziladi; bundan kech saqlangani D-47 bo‘yicha baribir `LATE_STORED` review. Kartani faqat
  qarorsiz xabar ushlab tursa, sweep har daqiqa karta id’sini logga yozadi (`drainHeldByMessage`); xabar `missingOutcome` (kunlik solishtirish) yoki
  `messageStuck` da ko‘rinadi, `card:retire --emergency` kartani majburan yopadi. `--emergency` (karta bloklandi, ishonchsiz) — kartaning `PENDING` so‘rovlari `CANCELLED`, havola tokenlari
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

> **Holat (4-bosqich S11):** qabul filtri va `IngestService` (saqlash, kursor, `bank-message` job), matcher, tarix qayta skani (`BankFeedClient`
> shartnomasi, hozircha faqat `FakeBankFeedClient`) va kunlik solishtirish **tayyor** (S6, S9). Haqiqiy MTProto tinglovchi (`@mtcute/node`), login
> CLI, `BANK_FEED_MODE`, sessiya shifri, lider lock, heartbeat yozuvi va `getAuthorizations` kuzatuvi — **S7, hali yo‘q** (ega ruxsati bilan S0 dan
> keyin). Quyidagi S7 qismlari dizayn; ularning env’lari `apps/worker/.env.example` da izoh sifatida turibdi va kod hali ularni o‘qimaydi.

- **Manba.** Ikki bot: @HUMOcardbot (Humo) va @CardXabarBot (Uzcard). Ularning xabarlarini **bitta alohida ishchi Telegram akkaunti**
  (alohida SIM, 2FA, faqat shu ikki bot, D-37 (1)) oladi; worker shu akkauntning MTProto foydalanuvchi sessiyasi bilan (`@mtcute/node`, D-37 (13))
  botlarning shaxsiy chatini o‘qiydi. Telegram akkauntni cheklash xavfi qabul qilingan; shuning uchun faqat o‘qiladi, chastota past.
- **Ikki kanal.** Yangi xabar update’i faqat «turtki»; asosiy manba — har `BANK_FEED_POLL_SEC` (20 s) dagi `getHistory(minId = kursor)`.
  Kursor `BankFeedCursor` da, `BankMessage` INSERT bilan **bitta tranzaksiyada** suriladi: update yo‘qolsa ham poll topadi.
- **Lider.** Redis `lock:bank-feed` (TTL 30 s, har 10 s yangilanadi): bitta auth key bilan ikki ulanish (`AUTH_KEY_DUPLICATED`) bo‘lmasin.
- **Qabul filtri (parserdan oldin).** Faqat sozlangan **raqamli bot id** dan, botning shaxsiy chatida, `isBot`, **kiruvchi** (chiquvchi `out` xabar rad
  etiladi), forward emas, tahrirlanmagan (`editDate` bo‘sh), `viaBot` yo‘q xabar. Boshqa chatlar so‘ralmaydi, ularning matni o‘qilmaydi va logga
  tushmaydi. Tekshiruv tartibi (`ingestRejectReason`): `FOREIGN_CHAT` (chat qotirilgan bot chati emas) **birinchi**, keyin `OUTGOING`, `FORWARDED`,
  `EDITED`, `VIA_BOT`, `FOREIGN_SENDER`, `NOT_BOT` (jo‘natuvchi bot emas). **Boshqa chat xabari umuman saqlanmaydi** va kursorni siljitmaydi
  (S9 B2): uning id’si boshqa chat raqamlanishiga tegishli — kursorni haqiqiy xabarlardan oshirib yuborishi yoki botning o‘z chatidagi keyingi
  haqiqiy xabarga kerak bo‘ladigan `(senderId, tgMessageId)` kalitini egallab qo‘yishi mumkin edi; o‘rniga log (faqat manba va kod) va xavfsizlik
  alerti `foreignChat` (manba bo‘yicha soatiga bitta). Qolgan rad etilganlar — `BankMessage(REJECTED)` (`rejectReason` = `INGEST_REJECT_REASONS`),
  review va alert; `FOREIGN_SENDER` / `NOT_BOT` xabarning matni saqlanmaydi (begona so‘zlar), faqat `textSha256`. Takror kelgan xabar faqat
  `(senderId, tgMessageId)` unique buzilishi bilan «allaqachon saqlangan» deb tan olinadi (`stored: false`, `DUPLICATE`); boshqa unique xatosi —
  haqiqiy xato. Tahrir update’i — alert `edited`, avvalgi qator o‘zgarmaydi. Bot id’lari env’da qotirilgan; boot’da `getUsers(id)` bilan kutilgan
  username solishtiriladi, runtime’da username qidirilmaydi.
- **Kuzatuv.** Redis `bankfeed:heartbeat` (har poll’da). **`account.getAuthorizations` har poll’da** tekshiriladi: ishchi akkauntda noma’lum yangi avtorizatsiya
  chiqsa **BARCHA kartalarda avtomatik yozish to‘xtaydi** (fail-closed; kirimlar review `AUTO_CREDIT_PAUSED`) va alert `newAuthorization` yuboriladi;
  ega sessiyalarni tekshirib `card:resume` qiladi. `AUTH_KEY_UNREGISTERED` / `SESSION_REVOKED` = alert + tinglovchi to‘xtaydi. (Bu S7 dizayni.)
- **Rejimlar.** `BANK_FEED_MODE=off` (standart) | `fake` (dev/test: ega CLI’si fixture kiritadi, haqiqiy Telegram’siz to‘liq oqim) | `live`
  (barcha `BANK_FEED_*` bilan). Production’da `fake` rad etiladi.
- **Sessiya siri.** AES-256-GCM (`BANK_FEED_SESSION_ENC` = `iv(12)`, `tag(16)`, `ciphertext`; kalit `BANK_FEED_ENC_KEY`); faqat worker xotirasida
  ochiladi (`MemoryStorage`, diskka fayl yozilmaydi). API muhitida bu o‘zgaruvchilar bo‘lsa API ishga tushmaydi.
- **Xom matn** admin ko‘rishi uchun 1 yil saqlanadi (D-37 (10)); hech qachon logga yozilmaydi. Har kuni 03:30 (Toshkent) `payment-reconcile` navbatidagi
  `bank-text-purge` jobi `purgeAfter` o‘tgan qatorlarda faqat `text` ni NULL qiladi (partiyalab, DB soati bo‘yicha, logda faqat son); `BankMessage` qatori qoladi.
  D-37 (10) faqat xom matnga tegishli: parse qilingan maydonlar (`amountTiyin`, `balanceAfterTiyin`, `last4`, `bankTxnAt`, `channel`) va `textSha256`
  doimiy saqlanadi.

**Runbook (VPS, ega ishtirokida — D-37 (14)).**

1. _Login:_ worker konteynerida `bank-feed-login` CLI (telefon, kod, 2FA; faqat TTY) — chiqishi **faqat shifrlangan blob**; uni env’ga qo‘yish.
   Ochiq sessiya hech qayerga yozilmaydi, dev kompyuterda saqlanmaydi.
2. _Bekor qilish:_ ishchi akkaunt Telegram → Devices orqali sessiyani yopish; keyin `BANK_FEED_MODE=off` va yangi login.
3. _Almashtirish:_ yangi akkaunt/sessiya bilan 1-band; eski sessiya yopiladi, kursor va `BankMessage` tarixi saqlanadi.
4. _Akkaunt cheklansa:_ tinglovchi to‘xtaydi, heartbeat eskiradi → yangi so‘rovlar avtomatik `503`, ega alert oladi; yo‘ldagi to‘lovlar
   tiklangandan keyin 48 soatlik qayta skan bilan topiladi (10-band). Telegram support orqali tiklanadi yoki yangi akkaunt.
5. _Karta bloklansa:_ `card:retire <id> --emergency` (PENDING so‘rovlar bekor, tokenlar o‘ladi), kartaga kelgan pulni bank orqali aniqlash, ko‘rib
   chiqishlarni (`review:list`) yopish; foydalanuvchilarga yangi so‘rov boshqa kartaga beriladi.
6. _Ledger’dan tashqari pul:_ foydalanuvchiga naqd yoki boshqa kanal orqali berilgan pul tizimga ko‘rinmaydi: matcher ham, `wallet:adjust` to‘sig‘i
   ham uni bilmaydi. Shunday pul berilsa, avval `wallet:adjust` bilan (sabab bilan) ledger’ga yozing, aks holda kech kelgan o‘tkazma avtomatik yoziladi.
7. _Kalit saqlash:_ `BANK_FEED_ENC_KEY` productionda Docker secret faylida turadi, env o‘zgaruvchisida emas (11-bosqich); worker konteynerida core dump
   o‘chiriladi (`ulimit -c 0`, `/proc/sys/kernel/core_pattern`), chunki xotirada ochiq sessiya bor.
8. _Pepper almashtirish:_ `PAY_TOKEN_PEPPER` almashsa barcha havola tokenlari o‘ladi (xesh mos kelmaydi); kutilayotgan foydalanuvchilar yangi havola oladi
   (`POST /payments/intents/:id/pay-link`). Rejali almashtirish — kam yuklangan vaqtda.
9. _Reverse proxy:_ access log formatida `t` query parametri va `X-Pay-Token` sarlavhasi yashiriladi (devops, 11-bosqich).
10. _`wallet:adjust` `RECENT_AUTO_TOPUP` bilan rad etsa (S9F-L1):_ chiqqan `recentAutoTopup=` to‘lovlarini (eng yangi 20 tasi, qolgani
    `recentAutoTopupMore`) bank va `review:list` bilan solishtiring. Berilayotgan pul ulardan boshqa bo‘lsa, buyruqni **aynan chiqqan**
    `--confirm-override=<recentAutoTopupSet>` (12 ta kichik hex belgi) bilan qayta yurgizing. Oraliqda yangi avtomatik to‘lov kelsa, qiymat
    eskiradi: buyruq yana rad etadi va yangi ro‘yxat bilan yangi `recentAutoTopupSet` ni chiqaradi — avval o‘sha yangi to‘lovni tekshiring.
    Qayta yurgizishda **xuddi shu `--key`** ni bering: oldingi ishga tushirish yozib ulgurgan bo‘lsa, buyruq `applied=false` bilan tugaydi.
11. _`effectsFailed` alerti (S9F-I1):_ xabarning qarori saqlangan, faqat undan keyingi amallar (foydalanuvchi bildirishnomasi, egaga
    ogohlantirishlar, karta limiti job’i) bajarilmagan; bu xabar avtomatik qayta ishlanmaydi. `review:list` va foydalanuvchining oxirgi
    to‘ldirishini tekshiring, kerak bo‘lsa foydalanuvchiga o‘zingiz xabar bering. Pulni qo‘lda **qayta bermang**: qaror (kirim bo‘lsa `TOPUP` ham) yozilgan.
12. _7 kundan eski o‘tkazma bo‘yicha shikoyat (S9 m1):_ `wallet:adjust` to‘sig‘i faqat oxirgi 7 kunda **tasdiqlangan** avtomatik to‘lovlarni ko‘radi
    (oyna hozirdan sanaladi, o‘tkazma vaqtidan emas). Shuning uchun bunday shikoyatda pul berishdan oldin foydalanuvchining to‘lovlar tarixini
    qo‘lda tekshiring (to‘siq uni ko‘rmaydi): o‘sha o‘tkazma allaqachon avtomatik yozilgan bo‘lishi mumkin.

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
9. Rad sabablari (`BankMessage.rejectReason`, faqat kod; ro‘yxat `PARSE_FAILURE_REASONS`, `packages/shared/src/payments/bank-parse.ts`): `EMPTY`, `TOO_LONG`,
   `UNEXPECTED_LINE`, `MISSING_DIRECTION`, `MISSING_CARD`, `MISSING_TIME`, `MISSING_BALANCE`, `DUPLICATE_DIRECTION`, `DUPLICATE_CARD`, `DUPLICATE_CHANNEL`,
   `DUPLICATE_TIME`, `DUPLICATE_BALANCE`, `AMOUNT_FORMAT`, `BALANCE_FORMAT`, `CARD_FORMAT`, `DATE_FORMAT`, `DATE`, `CHANNEL_FORMAT`, `CHANNEL_TOO_LONG`,
   `DIRECTION_CONFLICT`. Vaqt mintaqasi doimiysi (`TASHKENT_UTC_OFFSET_MINUTES` = 300) `packages/shared/src/tashkent-time.ts` da, parser va oy boshi hisobi uni ishlatadi.

## 6. Moslashtirish (`bank-message` navbati)

`bank-message` jobi: `jobId = bm-<BankMessage.id>`, concurrency 1, 5 urinish, eksponensial 2 s.

**Tartib kafolati navbatga emas, bazaga tayanadi (S6 dizayni).** BullMQ qayta urinish kutish (backoff) paytida keyingi jobni ishlaydi, shuning uchun concurrency 1
o‘zi tartibni kafolatlamaydi. Qoida: shu kartadagi `tgMessageId` kichikroq xabarning `BankMessageOutcome`i hali yo‘q bo‘lsa, job **o‘zini kechiktiradi**
(`PREDECESSOR_PENDING`: hech narsa yozmaydi, job `DelayedError` bilan 30 s ga kechiktiriladi va bu oddiy 5 urinishdan **ayrilmaydi**; kutishlar soni job
ma’lumotida, `predecessorWaits`, ko‘pi bilan 20 marta ≈ 10 daqiqa). Kutish tugasa — review va alert:
oldingi xabar ishlanmagani uchun zanjirni tekshirib bo‘lmaydi, shuning uchun kirim avtomatik yozilmaydi: review `CHAIN_BREAK` (`note = PREDECESSOR_PENDING`,
outcome `chainStatus = BREAK`), karta `autoCreditPaused`. Har bir holat o‘zgarishi (`VERIFYING → ACTIVE`, `ACTIVE → FULL`, intent `PAID`, pauza) faqat
`lockTopupCard(tx, cardId)` ostida (API bilan bir xil kalit `hashtext('topup-card:<id>')`); bir vaqtda bitta karta qulfi.

**Qulflar va xatolar.** Har worker tranzaksiyasi (matcher, karta limiti tekshiruvi) avval `lock_timeout` ni o‘rnatadi (`BANK_FEED_LOCK_TIMEOUT_MS`, 3 s,
bog‘langan parametr, API kabi); band karta 55P03 beradi va job oddiy backoff bilan qayta uradi. Qulflar tartibi: karta → intent `FOR UPDATE` → `Wallet`
(`lockWallet`, kunlik chek hisobidan **oldin**: bitta foydalanuvchiga ikki kartadan bir vaqtda kelgan pul chekni ikki marta o‘tolmaydi). Faqat unique
to‘qnashuvi (P2002) va outcome mavjudligi «boshqa ishlovchi yozib bo‘lgan» deb qabul qilinadi; boshqa har qanday xato (exclusion 23P01 ham) — xato.
**Fail-closed:** oxirgi urinish kutilmagan xato bilan tugasa, alohida qisqa tranzaksiya review `UNRECOGNIZED` (`note = PROCESSING_FAILED`; tur «tushunilmadi,
odam hal qiladi» ma’nosida — aniqlanmagan sababni `CHAIN_BREAK` yoki `AMBIGUOUS` deb ko‘rsatmaslik uchun) va outcome `REVIEW` yozadi, karta
`autoCreditPaused`, alert `processingFailed` (kartasiz xabarda `unrecognized`). Job’ni kechiktirishning o‘zi (Redis) xato bersa ham oxirgi urinishda
shu yo‘l ishlaydi. Yozuv bir necha marta uriniladi (3 urinish, har birida `lock_timeout` 10 s, oraliq 1 s: asl xato ko‘pincha band karta). Baribir yozib
bo‘lmasa — egaga alert `messageStuck` (faqat `BankMessage.id`, bazaga hech narsa yozilmaydi) va job failed bo‘lib qoladi. Uning matni egaga xabar
30 daqiqadan keyin avtomatik qayta ishlanishini (yetim qayta navbat, §8) va pul allaqachon yozilgan bo‘lishi mumkinligini aytadi: qo‘lda berishdan oldin
foydalanuvchining oxirgi to‘ldirishini tekshirish kerak. Qayta ishlashdan **oldin** qo‘lda berilgan pul `MANUAL_CREDIT_SEEN` review’ini ochadi (7-qadam);
qayta ishlash **keyin** bo‘lsa, `wallet:adjust` to‘sig‘i ushlaydi (§7, S9 F-L1; uning oynasi yetim qayta navbatning 7 kunlik ufqi bilan bir xil —
`AUTO_CREDIT_HORIZON_MS`, `packages/db`, S9F-L2). Oyna **hozirdan** orqaga sanaladi (`Payment.confirmedAt` bo‘yicha), o‘tkazma vaqtidan emas: qayta
navbat kech yozgan to‘lov hozir tasdiqlanadi va doim oyna ichida, lekin 7 kundan oldin yozilgan to‘lovni to‘siq ko‘rmaydi (runbook 12-band). **Qaror saqlangan-u, faqat commit’dan keyingi effektlar xato bergan bo‘lsa** (matcher’da yoki
fail-closed review’ni yozgandan keyin) alert boshqa — `effectsFailed` (S9F-I1): yetim qayta navbat faqat qarorsiz xabarlarni oladi, shuning uchun bu xabar
hech qachon qayta ishlanmaydi va matn «avtomatik qayta ishlanadi» demaydi; u `review:list` va oxirgi to‘ldirishni tekshirishni, foydalanuvchiga
bildirishnoma bormagan bo‘lishi mumkinligini aytadi (runbook 11-band). Kelgan pul hech qachon jimgina ishlanmay qolmaydi. Tartib:

1. `BankMessageOutcome` bor bo‘lsa — hech narsa qilinmaydi (idempotent).
2. `parseStatus ≠ PARSED` → review `UNRECOGNIZED` / `REJECTED` + alert.
3. Karta **qabul paytida** aniqlanadi: listener `BankMessage` ni INSERT qilayotgan o‘sha tranzaksiyada `(bank, last4)` bo‘yicha kartani topib `cardId` ni
   yozadi — avval `RETIRED` bo‘lmagan karta, bo‘lmasa eng oxirgi `RETIRED` karta, hech biri bo‘lmasa `NULL`. `BankMessage` append-only, shuning uchun
   `cardId` keyin yozilmaydi va zanjir so‘rovi (`cardId`, `tgMessageId`) shu qiymatga tayanadi. Moslashtirishda: `cardId` `NULL` → review `CARD_UNKNOWN`;
   karta `RETIRED` → `CARD_RETIRED`. `DRAINING` karta mos keladi (mavjud so‘rovlar yoziladi).
   Keyin **saqlangan qator yaxlitligi** (L3, karta qulfi ostida): `senderId` shu manbaning qotirilgan bot id’siga teng (`BANK_FEED_HUMO_BOT_ID` /
   `BANK_FEED_UZCARD_BOT_ID`, worker env’i, production’da majburiy) va `sha256(xom matn) = textSha256` (matn o‘chirilgan bo‘lsa xesh tekshirilmaydi, kirim
   7-bandda `TEXT_MISSING` bilan to‘xtaydi). Aks holda review `UNRECOGNIZED` (`note = SENDER_MISMATCH` / `TEXT_HASH_MISMATCH`), karta `autoCreditPaused`, ledger yo‘q,
   alert `integrityAnomaly` — xavfsizlik hodisasi (qaysi tekshiruv, bank, last4, «avtomatik yozish to‘xtatildi» va bot id sozlamasini tekshirish eslatmasi).
4. **Zanjir** (karta bo‘yicha, `tgMessageId` o‘sish tartibida): kirim → `oldingi + summa = keyingi balans`; chiqim → `oldingi − summa = keyingi balans`.
   Birinchi xabar `FIRST`. Mos kelmasa `BREAK`: review `CHAIN_BREAK`, alert, karta `autoCreditPaused` — **fail-closed** (D-37 (8)). Pauza paytidagi
   kirimlar review `AUTO_CREDIT_PAUSED`. Ega `card:resume` yoki `review:accept-chain` qiladi.
   **Chiqim (DEBIT)** hisobga tegmaydi (`DEBIT_RECORDED`), lekin **har DEBIT haqida egaga alert** (`debit`: last4 va summa); yaqinda (7 kun) yozilgan to‘lov
   summasiga teng DEBIT — review `POSSIBLE_REVERSAL` (bank pulni qaytarib olgan bo‘lishi mumkin).
5. `VERIFYING` karta va kirim = `verifyAmountTiyin`, xabar sanasi karta qo‘shilgandan keyin (`tgDate >= card.createdAt`: skan topgan eski bir xil
   summali o‘tkazma kartani tasdiqlamaydi, S9-L1) → karta `ACTIVE`, outcome `CARD_VERIFIED`, ledger yo‘q, alert `cardVerified`.
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

7. **Hisobga yozishdan oldingi qo‘shimcha tekshiruvlar** (nomzod aniq bitta bo‘lganda, intent qatori `FOR UPDATE` bilan qulflanib nomzodlar qayta tekshirilgach):
   avval `Wallet` qulfi; **summa qayta berilmaganmi**: kech to‘lov `reservedUntil` ni `paidAt + grace` gacha uzaytiradi, shu oraliqda o‘sha kartada shu summa
   boshqa so‘rovga berilgan bo‘lsa (rezervlar ustma-ust tushardi, 23P01) — review `AMBIGUOUS`, `note = AMOUNT_REALLOCATED`, ledger yo‘q, alert `amountReallocated` («summa allaqachon boshqa so‘rovga berilgan»).
   **Kech saqlangan** (D-47, `createdAt − tgDate > 10 daqiqa`) xabar va so‘rov xabar saqlangan paytda ochiq emas edi (`PENDING` emas — masalan grace
   ichidagi `EXPIRED` — yoki `PENDING`, lekin `expiresAt <= createdAt`: sweep hali ishlamagan) — review `AMBIGUOUS`, `note = LATE_STORED`, ledger yo‘q,
   alert `lateStored` (7-band). Bu tekshiruv sarlavha tekshiruvidan **keyin**: `TITLE_UNKNOWN` / `REPARSE_MISMATCH` / `TEXT_MISSING` o‘z izohini saqlaydi.
   **Sarlavha** (D-43 (1)): matcher `BankMessageText` ni qayta tahlil qiladi; ma’lum sarlavha MATNI bo‘lmasa (rangli doira sarlavha emas, u faqat yo‘nalishni
   bildiradi; **aniq moslik, prefiks emas**: kanonik qator kalitga teng bo‘lishi shart, faqat oxiridagi tinish belgisi yoki emoji va boshidagi rangli doira
   e’tiborga olinmaydi, «To'ldirish TEST» kabi qo‘shimchali sarlavha tanilmagan; prefiks qoidasi faqat qarama-qarshi yo‘nalishni rad etish uchun qoladi) yoki sarlavha yo‘q bo‘lsa — review `UNRECOGNIZED`, `note = TITLE_UNKNOWN`, alohida alert `titleUnknown`; qayta tahlil saqlangan maydonlarga mos
   kelmasa — `note = REPARSE_MISMATCH`; matn o‘chirilgan bo‘lsa — `note = TEXT_MISSING` (bu ikkisi alert `unrecognized`; hammasida ledger yo‘q).
   Izoh kodlari: `REVIEW_NOTE_CODES` (`packages/shared/src/payments/bank-parse.ts`). Foydalanuvchi bloklangan bo‘lsa — review `USER_BLOCKED`; **IKKALA kunlik
   chek** (yangi akkaunt 500 000 so‘m va barcha akkaunt 5 000 000 so‘m) yaratishdagi formula bilan qayta tekshiriladi: oxirgi 24 soat (`PAID` — `paidAt`, `PENDING` —
   `createdAt` bo‘yicha), ASOS summalar, shu so‘rovning o‘zi hisobda ikki marta emas. Oshsa — review `DAILY_LIMIT` (bitta tur); review ma’lumotida qaysi chek oshgani
   yoziladi (`DAILY_LIMIT` yoki `NEW_ACCOUNT_DAILY_LIMIT`); alert `dailyLimit` kodni emas, egaga tushunarli matnni ko‘rsatadi: «barcha akkaunt: kuniga 5 000 000 so‘m» yoki
   «yangi akkaunt: kuniga 500 000 so‘m» (`alerts.limitReason.*`, uz va ru).
   **Qo‘lda berilgan pul** (D-47 R1) — yozishdan oldingi **oxirgi** to‘siq (yuqoridagi barcha sabablar o‘z o‘rnida, ular ustun), **har bir** avtomatik
   TOPUP’da: jonli, skan, qayta navbat; `PENDING` ham, grace ichidagi `EXPIRED` ham; kech yoki o‘z vaqtida saqlangan bo‘lishidan qat’i nazar. So‘rov
   yaratilgandan (`intent.createdAt`) keyin ega foydalanuvchiga qo‘lda pul bergan bo‘lsa — musbat `ADJUSTMENT` (`wallet:adjust`, `ADMIN_ACTION/<AuditLog.id>`)
   yoki `review:credit` ning `TOPUP` i (`PAYMENT/<Payment.id>`, `Payment.reviewId` to‘ldirilgan; avtomatik kreditda u yo‘q) — review `AMBIGUOUS`,
   `note = MANUAL_CREDIT_SEEN`, so‘rov id’si bilan, ledger yo‘q, alert `manualCreditSeen`. Manfiy adjustment va avtomatik `TOPUP` hisobga olinmaydi.
   Predikat bitta: `manualCreditsSince` (`packages/db/src/payments/manual-credits.ts`), `review:credit` preview’i ham shuni ishlatadi.
   O‘qish `Wallet` qulfi ostida; `wallet:adjust` va `review:credit` ham yozishdan oldin xuddi shu `lockWallet` ni oladi (`packages/db/src/ledger/ledger.ts`),
   demak qo‘lda to‘lov yo oldin commit bo‘lib bu yerda ko‘rinadi, yo matcher tranzaksiyasi tugashini kutadi. Qulf tartibi o‘zgarmaydi: karta → intent → hamyon.
8. **Hisobga yozish — BITTA `$transaction`:** intent `FOR UPDATE` → holat `assertIntentTransition` bilan qayta tekshiriladi → `lockWallet` →
   `Payment(P2P_CARD, providerTxnId = "<senderId>:<tgMessageId>", bankMessageId, userId, intentId, CONFIRMED)` → intent `PAID` →
   `LedgerEntry(TOPUP, +summa, PAYMENT/<paymentId>)` → `BankMessageOutcome(CREDITED)`. Har qanday unique to‘qnashuvi — rollback va «allaqachon
   ishlangan». Commit’dan **keyin**, shu tartibda: (a) `DEL wallet:{userId}` va `notify` job (faqat `paymentId` bilan: API foydalanuvchini `Payment` qatoridan oladi);
   (b) qarorning o‘z alertlari (review, DEBIT, `cardVerified`); (c) karta limiti tekshiruvi **o‘z `card-limit` jobiga** beriladi (`jobId = cl-<bankMessageId>`,
   8 urinish, eksponensial 2 s). Shuning uchun band karta yoki limit tekshiruvidagi xato (a) va (b) ni ushlab turmaydi va yo‘qotmaydi; tekshiruvning oxirgi
   urinishi ham xato bo‘lsa egaga alert `limitCheckFailed`. Tekshiruv alohida tranzaksiyada `lockTopupCard` ostida, API bilan bir xil `cardTotals` so‘rovi va `TOPUP_CAPACITY_HOLD_SEC` bilan (D-45: ulush faqat
   tushgan pul, band summalar holatni o‘zgartirmaydi). Tekshiruv **har PARSED kirimdan** keyin ishlaydi (`CREDITED`, `REVIEW`, `CARD_VERIFIED`: bank hamma
   tushgan pulni sanaydi). Alertlar takrorlanmaydi (L7): `cardNearLimit` — faqat shu kirim 80% chizig‘ini **kesib o‘tganda** (oldin < 80, keyin 80–99);
   100% da `ACTIVE → FULL`, `cardFull` esa faqat karta haqiqatan `ACTIVE → FULL` o‘tganda yoki karta `FULL` va 100% ni aynan shu kirim kesib o‘tgan
   bo‘lsa (commit’dan keyin yo‘qolgan alertni takroriy ishlash tiklaydi). «Oldin» qiymati holatsiz hisoblanadi: shu karta va shu botdan kelgan, `tgMessageId` kichikroq PARSED
   kirimlar yig‘indisi (keyin kelgan pul kirmaydi, shuning uchun kech ishlangan tekshiruv ham o‘z chizig‘ini yo‘qotmaydi); karta holati esa joriy yig‘indiga
   qaraydi. Karta 100% dan o‘tgan bo‘lsa `cardNearLimit` yuborilmaydi (`cardFull` uni qamraydi). `FULL` kartaga tushgan pul ham yoziladi (foydalanuvchi ko‘rsatilgan kartaga
   to‘lagan). Kech to‘lov (`paidAt > expiresAt + TOPUP_CAPACITY_HOLD_SEC`) kartadagi **tushgan** summani limitdan oshirsa — `lateOverLimit` (D-42 qoldiq xavfi).
   Commit’dan keyingi effektlar har safar saqlangan outcome’dan qayta chiqariladi (birinchi ishlash va takror), job id’lar barqaror, shuning uchun takrorlanmaydi.
   Tugagan `notify` job’lari 30 kun saqlanadi (`NOTIFY_DEDUPE_SEC`; ularda faqat id’lar bor) va effektlar outcome 30 kundan yosh bo‘lgandagina xabar
   qo‘shadi: foydalanuvchiga «hamyon to‘ldirildi» ham, egaga bir xil alert ham ikki marta bormaydi. `tg-outbox` job’i (tayyor matn, summa bilan) bajarilgani ham, xato bilan tugagani ham 1 kun saqlanadi.

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

**Kech saqlangan xabar (D-47).** `BankMessage.createdAt − tgDate > 10 daqiqa` (`LATE_STORED_AFTER_MS`) bo‘lgan CREDIT — kunlik skan topgani yoki
listener uzilishdan keyin olgani — xabar saqlangan paytda **ochiq bo‘lmagan** so‘rovga hech qachon avtomatik yozilmaydi: review `AMBIGUOUS`
(note `LATE_STORED`, so‘rov id’si bilan) va alert `lateStored`. «Ochiq» = muddati o‘tmagan `PENDING` (xabar saqlangan paytda, `createdAt < expiresAt`);
grace ichidagi `EXPIRED` ham, muddati o‘tgan, lekin sweep hali `EXPIRED` qilmagan `PENDING` ham ochiq emas (sweep ham worker’da: worker to‘xtasa u
ham to‘xtaydi, S9 B1). Sabab: uzilish paytida ega pulni `wallet:adjust` bilan qo‘lda bergan bo‘lishi mumkin. Kechikish qatorning o‘zidan o‘qiladi,
shuning uchun qayta navbatga qo‘yilgan job ham shunday qaror qiladi. Kech, lekin saqlangan paytda hali ochiq so‘rovga kelgan xabar avvalgidek yoziladi
(foydalanuvchi uni kutmoqda, ochiq so‘rovni hech kim qo‘lda yozmaydi); o‘z vaqtida saqlangan xabar o‘zgarmaydi. `review:credit` oldindan
`manualCreditsSinceRequest=adjust=<soni> (+<yig‘indi>), reviewCredit=<soni> (+<yig‘indi>) since <vaqt>` ni ko‘rsatadi: qo‘lda berilgan pul —
musbat `ADJUSTMENT` lar va `review:credit` `TOPUP` lari alohida — so‘rov yaratilgan paytdan (so‘rovsiz — o‘tkazma Telegram vaqtidan), lekin kamida
oxirgi 48 soat (S9 R2) — ikki marta bermaslik uchun. Bu matcher’ning `MANUAL_CREDIT_SEEN` predikatining o‘zi (`manualCreditsSince`, S9 F-L2).

**Qo‘lda berilgan pul (D-47 R1, 2026-11-08).** Kech-kechmasligidan qat’i nazar, so‘rovdan keyin qo‘lda pul olgan foydalanuvchining mos o‘tkazmasi
avtomatik yozilmaydi: review `AMBIGUOUS` (note `MANUAL_CREDIT_SEEN`, so‘rov id’si bilan) va alert `manualCreditSeen` (6-bo‘lim, 7-qadam). Bu review’ning
`review:credit` preview’ida ham `manualCreditsSinceRequest` qatori bor (so‘rov yaratilgan paytdan). **Qoida:** qo‘lda pul berishning har
**yangi** yo‘li (yangi CLI buyrug‘i, admin panel amali) `manualCreditsSince` predikatiga qo‘shiladi — aks holda matcher uni ko‘rmaydi va pul ikki
marta beriladi.

**Teskari tartib (S9 F-L1).** Matcher pulni avval yozib commit qilsa, keyin kelgan `wallet:adjust` hamyon qulfini kutadi. Musbat summada u
qulf ostida foydalanuvchining **avtomatik** P2P to‘lovlarini o‘qiydi (`Payment` `CONFIRMED`, `reviewId` yo‘q) — oxirgi 7 kun (`RECENT_AUTO_TOPUP_WINDOW_MS`
= `AUTO_CREDIT_HORIZON_MS`, worker’ning yetim qayta navbat ufqi `ORPHAN_LOOKBACK_MS` bilan bitta konstanta, S9F-L2: worker hali avtomatik yozishi mumkin
bo‘lgan har bir to‘lov oyna ichida). CLI ularni kodni so‘rashdan oldin ko‘rsatadi (`recentAutoTopup=<id> +<summa> at <vaqt>`, eng yangi 20 tasi;
ko‘prog‘i bo‘lsa `recentAutoTopupMore=<n>`) va **to‘plam id’sini** chiqaradi: `recentAutoTopupSet=<12 belgi>` — **barcha** to‘lov id’larining saralangan
sha256 hash’i (20 ta bilan cheklanmaydi). To‘plam bo‘sh bo‘lmasa, `--confirm-override=<recentAutoTopupSet>` siz yoki **boshqa** qiymat bilan hech narsa
yozilmaydi (`RECENT_AUTO_TOPUP`, har qanday summada, S9F-L1): servis tranzaksiya ichida, qulf ostida joriy to‘plam hash’ini berilgan qiymat bilan
solishtiradi. Rad etish va qayta yurgizish orasida yangi avtomatik to‘lov kelsa, eski qiymat endi mos emas: buyruq rad etadi va yangi ro‘yxat hamda
yangi to‘plam id’sini ko‘rsatadi; kod chegaradan yuqorida to‘plam o‘zgarganidan oldin yuborilgan bo‘lsa (`OTP_MISMATCH`), CLI ham yangi ro‘yxatni
va «kod eski to‘plamga bog‘langan» sababini chiqaradi (S9 n1). Rad etish matni «bu ishga tushirish hech narsa yozmadi; shu `--key` bilan oldingi
ishga tushirish yozgan bo‘lishi mumkin — yangi set va xuddi shu `--key` bilan qayta yurgizing» ma’nosida (S9 I-3: servis avval kalit takrorini
tekshiradi, shuning uchun oldingi yozuv `applied=false` bo‘lib chiqadi). **Diqqat (S9 m2):** `wallet:adjust` da `--confirm-override` **qiymat oladi**
(`--confirm-override=<set>`), `review:credit` va `card:resume` da esa qiymatsiz flag; nom bir xil qoldi. Qiymatsiz flag (oxirida yoki boshqa
option oldida) yoki 12 ta kichik hex belgi bo‘lmagan qiymat — foydalanish xatosi (kod 2), matnda shu farq aytiladi.
Override `AuditLog.after` ga yoziladi (`override`, `recentAutoTopups` — to‘lov id’lari) va chegaradan yuqorida D-46 bo‘yicha OTP ham unga bog‘lanadi
(`override: <n> recent auto top-up(s), set <12 belgi>`; kod berilgandan keyin to‘plam o‘zgarsa — soni bir xil bo‘lsa ham — `OTP_MISMATCH`). Manfiy summa tekshirilmaydi.

`review:credit --intent` faqat xabar kartasi va summasi so‘rovniki bilan **aynan** mos bo‘lsa ishlaydi (DB `Payment` triggeri boshqasini rad etadi); mos kelmasa — `--user` (so‘rovsiz, `reviewId` bilan). `UNRECOGNIZED` va `REJECTED` xabar `review:credit` bilan pulga aylanmaydi (DB faqat `PARSED` kirim xabarini qabul qiladi): bunday pulni ega faqat `wallet:adjust` orqali, sabab va `AuditLog` bilan yozadi.

**CLI (S8).** `apps/api/src/cli/ops-cli.ts` (`NestFactory.createApplicationContext`, HTTP yo‘q; API env’i, o‘zining modul grafi `OpsCliModule`, bot va
navbat iste’molchilarisiz). Serverda `apps/api` ichida `node --env-file-if-exists=.env dist/cli/ops-cli.js <buyruq> ...`, yoki repo ildizidan
`npm --logs-max=0 -w apps/api run -s ops -- <buyruq> ...` (`--logs-max=0` shart: npm debug log’i argv’ni saqlaydi). Yordam matni inglizcha (ichki vosita),
`help <buyruq>`. Har o‘zgartiruvchi buyruqda `--reason` va `--operator` majburiy (`AuditLog.actorType = CLI`, `actorId = null`, `after.operator`).
`AuditLog.ip` — SSH mijoz manzili (`SSH_CONNECTION`, bo‘lmasa `SSH_CLIENT`); `--ip` faqat SSH’siz konsolda olinadi, SSH manzilidan farq qilsa buyruq rad
etiladi. `after.osUser` — OS akkaunti (`os.userInfo().username`, sudo bo‘lsa `<login> (sudo from <SUDO_USER>)`). Summalar so‘mda (`50000`, `1250.50`;
manfiy — `--amount=-500`). `card:add` da karta raqami va egasi ismi buyruq qatorida **berilmaydi**: bank va limitlar tekshirilgach ikkalasi ekranda
ko‘rinmasdan so‘raladi (shell tarixi va npm log’iga tushmaydi); chiqishda va AuditLog’da faqat bank va last4. Qo‘shimcha: `review:list --card <id>` (`--limit` 1–100
butun son), `user:unfreeze <userId>` (D-41). `review:show` bank matnining har qatorini `| ` bilan boshlaydi va `--- end bank text ---` bilan tugatadi;
boshqa qiymatlarda yangi qator ham `\u{A}` bo‘lib chiqadi. Natija: 0 — bajarildi, 1 — rad etildi (kod va maydon, qiymat emas), 2 — buyruq noto‘g‘ri yozilgan.

- **Chegaradan katta summa (D-46):** `review:credit`, `wallet:adjust`, `payment:reverse` da summa qayta kiritiladi, mos kelsa ega Telegram’iga
  (`OWNER_ALERT_CHAT_ID`) bir martalik kod boradi (3 daqiqa, 5 urinish, amal + summa + target’ga bog‘langan), kod ekranda ko‘rinmasdan kiritiladi. Servis kodni
  tranzaksiyadan oldin tekshiradi, AuditLog `after.otpVerified = true`. Rad etishlar: `OTP_REQUIRED`, `OTP_INVALID`, `OTP_MISMATCH`, `OTP_EXPIRED`
  (muddati o‘tgan yoki ishlatilgan), `OTP_LOCKED`, `OTP_UNAVAILABLE`. Buyruq tugagach kod xabari navbatdan o‘chiriladi. `OTP_INVALID` va `OTP_LOCKED`
  security `warn` log yozadi (faqat amal va natija; kod, challenge va binding yo‘q). `review:credit` kodi `--confirm-override` va `--bank-verified` ga ham
  bog‘langan (`confirms=override: blocked, overLimit; bank-verified` chiqadi va xabarda ko‘rinadi); servis bu satrni hamyon qulfi ostida qayta hisoblaydi,
  mos kelmasa `OTP_MISMATCH`. Redis faqat ichki tarmoqda va parol bilan ishlaydi: kod matni outbox job’ida yuborilguncha turadi.
- **Kim bajargani:** SSH ip va operatorning haqiqiy manbai — sshd `auth.log` (IP + kalit fingerprint); tekshiruvda uni AuditLog vaqti, `ip` va
  `after.osUser` bilan solishtiring. OTP shell’ga (API env’i) ega hujumchiga qarshi emas: asosiy nazorat — SSH huquqi faqat egada (D-46).
- `review:credit`: avval holat chiqadi — summa, foydalanuvchi: bloklangan, `purchaseFrozen`, akkaunt yoshi, bugungi base yig‘indi / limit (matcher formulasi).
  Bloklangan yoki limitdan oshgan bo‘lsa `--confirm-override` siz hech narsa yozilmaydi (holat va override AuditLog `after` da; override OTP o‘rnini bosmaydi).
  `SENDER_MISMATCH` / `TEXT_HASH_MISMATCH` izohli review’ga faqat `--bank-verified` bilan (ega bank ilovasida tekshirgan; `after.bankVerified`). Qulflar tartibi:
  xabar kartasi (yagona karta qulfi) → review qatori `FOR UPDATE` → intent `FOR UPDATE` → `Wallet`. Bitta tranzaksiyada
  `Payment(CONFIRMED, reviewId, bankMessageId, providerTxnId = "<senderId>:<tgMessageId>")` → intent `PAID` (`assertIntentTransition`, `actor: admin`,
  `paidAt` = xabar vaqti) → `LedgerEntry(TOPUP, PAYMENT/<paymentId>)` → `AuditLog(REVIEW_CREDIT)` → review `RESOLVED / CREDITED_USER`. Commit’dan keyin:
  `DEL wallet:{userId}`, `notify TOPUP_CREDITED`, `adminAction`. Yopilgan review qayta yopilmaydi; bitta xabar faqat bir marta pulga aylanadi (boshqa review
  orqali ham); xabarning boshqa review’i `RETURNED_OFFLINE` bilan yopilgan bo‘lsa rad (`RETURNED_OFFLINE`). `--intent` da summa orada yangi so‘rovga
  berilgan bo‘lsa (worker’ning `overlappingIntent` predikati) `AMOUNT_REALLOCATED`.
- `review:returned-offline` faqat qabul qilingan (PARSED CREDIT) va hali Payment’ga aylanmagan xabarga (aylangan bo‘lsa `ALREADY_CREDITED`: pul
  `payment:reverse` bilan qaytariladi). `review:show` xabarning Payment’ini `bankMessageId` bo‘yicha ko‘rsatadi (avtomatik yoki qaysi review orqali).
- `review:accept-chain` faqat `CHAIN_BREAK` uchun va xabar hech kimga yozilmagan kirim bo‘lsa **rad etiladi** (`CREDIT_UNDECIDED`): avval pul hal qilinadi.
  Karta qulfi ostida kartaning boshqa pauza sabablari tekshiriladi: ochiq `CHAIN_BREAK` (shu jumladan `PREDECESSOR_PENDING`), `UNRECOGNIZED` +
  `SENDER_MISMATCH` / `TEXT_HASH_MISMATCH` / `PROCESSING_FAILED`, egasining oxirgi qarori `CARD_PAUSE` bo‘lsa (qachon yozilgani muhim emas;
  uzilishdan oldin qilingan pauza ham hisoblanadi). Bunday pauza faqat `CARD_RESUME` bilan bekor bo‘ladi: accept-chain turgan pauza ustidan
  kartani yoqmaydi. Pauzadagi kartaga `card:pause` ham `CARD_PAUSE` auditini yozadi (`after.alreadyPaused = true`). Sabab bo‘lsa review yopiladi, lekin
  avtomatik yozish yoqilmaydi (`autoCreditResumed = false`, qolgan sabablar va `card:resume` maslahati chiqadi); bo‘lmasa `autoCreditPaused = false`.
  `card:resume` ham ochiq pauza review’larini ko‘rsatadi va ular bor bo‘lsa `--confirm-override` talab qiladi (`after.openPauseReviews`, `after.override`).
- `wallet:adjust` musbat summada oxirgi 7 kundagi avtomatik P2P to‘lovlarni va ularning `recentAutoTopupSet` id’sini ko‘rsatadi; ular bo‘lsa aynan shu
  id bilan `--confirm-override=<recentAutoTopupSet>` talab qiladi, to‘plam o‘zgarsa rad etadi (§7, S9 F-L1, S9F-L1/L2; runbook 10-band).
- `wallet:adjust` da `--key <id>` majburiy (AuditLog id): kalitsiz buyruq hech narsa yozmaydi va yangi kalit chiqaradi; xuddi shu kalit + xuddi shu so‘rov →
  `applied=false`, boshqa summa yoki sabab → `IDEMPOTENCY_CONFLICT`. `payment:reverse` va `review:credit` ning tabiiy kalitlari bor.
- `wallet:adjust`, `payment:reverse`, `user:unfreeze` va har review/karta amalidan keyin egaga `adminAction` alerti.
- **Kechiktirildi:** CLI orqali yaratilgan pul (musbat ADJUSTMENT + REVIEW_CREDIT) uchun kunlik limit — S11 / 9-bosqich.

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

Har kuni 03:00 (Asia/Tashkent) — tarixni qayta skan qilish MTProto talab qilgani uchun u **worker**da ishlaydi (BullMQ job scheduler
`payment-reconcile:daily`, `pattern '0 3 * * *'`, `tz 'Asia/Tashkent'` = 22:00 UTC; attempts 3, eksponensial 60 s; oxirgi urinish ham xato bo‘lsa
egaga `reconcileFailed` (`refId = <yyyymmdd>`, render bazani o‘qimaydi) ketadi, job xato bilan tugaydi; keyingi kun yana shu 48 soatni qamraydi).

1. **Tarixni qayta skan.** Har manba uchun oyna boshidan oldingi oxirgi saqlangan xabar id’sidan `BankFeedClient.fetchSince(source, minId, 100)`
   bilan sahifalab o‘qiladi (ko‘pi bilan 50 sahifa). Saqlanmagan id **oddiy ingest yo‘lidan** o‘tadi (`IngestService`: qabul filtri, parser,
   `BankMessage` + xom matn + kursor bitta tranzaksiyada, commit’dan keyin `bank-message` job), id tartibida — matcher uni jonli kelgandagidek hal
   qiladi. Holat (`historyScan`): `ok` (ikkala manba oxirigacha o‘qildi) | `unavailable` (mijoz sozlanmagan — S7 gacha har doim — yoki bot id
   qotirilmagan) | `failed` (mijoz xatosi, oldinga siljimaydigan javob, 50 sahifadan uzun tarix yoki sahifada boshqa chat xabari — S9F-I2: mijoz
   shartnomani buzgan, o‘sha sahifadan hech narsa ingest qilinmaydi va kursor undan o‘tmaydi; log’da faqat manba va `FOREIGN_CHAT`; egaga listener’niki
   bilan bir xil soatlik `foreignChat` alerti ketadi — `alertRef.foreignChat(source, now)`, shuning uchun ikkalasi bitta alertga birlashadi, S9 L-1).
   Har manbaning **sabab kodi** (`RECONCILE_HISTORY_REASONS`): `unavailable` — `NO_CLIENT` / `NOT_PINNED`; `failed` — `CLIENT_ERROR` / `NO_PROGRESS` /
   `TOO_LONG` / `FOREIGN_CHAT`. U `after.history.<source>.reason` ga yoziladi va `reconcileMismatch` alertining `details` ida `<source>=<sabab>`
   bo‘lib chiqadi (masalan `HUMO_BOT=FOREIGN_CHAT`), shuning uchun ega umumiy «xato bilan tugadi» o‘rniga aniq sababni ko‘radi. `unavailable` va `failed` hech qachon
   «farq yo‘q» deb ko‘rsatilmaydi. Mijoz shartnomasi (`fetchSince`): eng eskisi birinchi, ko‘pi bilan `limit` ta, faqat shu manba chati; tarix
   oxiri faqat **bo‘sh sahifa** (qisqa sahifa oxir emas). Manbaning birinchi skanida (oynadan oldin saqlangan xabar yo‘q) oyna boshidan eski
   xabarlar olinmaydi. **10 daqiqadan yosh xabar o‘tkazib yuboriladi** (`LATE_STORED_AFTER_MS`: uni listener yoki ertangi skan oladi), shuning
   uchun skan saqlagan har xabar «kech saqlangan» (D-47, 7-band): u saqlangan paytda ochiq bo‘lmagan so‘rovga tushsa avtomatik yozilmaydi, review
   bo‘ladi. Boshlanish nuqtasi va «ma’lum id» lar `rejectReason = FOREIGN_CHAT` qatorlarni hisobga olmaydi (B2 dan oldin saqlangan bo‘lsa ham).
2. **Tekshiruvlar** (`RECONCILE_MISMATCH_CODES`, har biri to‘liq son + 10 tagacha misol id): `recovered` — skan topgan va hozir saqlangan xabarlar
   (tinglovchi o‘tkazib yuborgan); `missingOutcome` — 15 daqiqadan oldin saqlangan, qarori (`BankMessageOutcome`) yo‘q xabar, **butun tarix bo‘yicha**
   (48 soatlik oyna bilan cheklanmaydi: tiqilib qolgan xabar qaror olmaguncha har kungi hisobotda turadi; BullMQ stalled limiti bilan o‘lgan job ham shu
   yerda chiqadi); `creditUnaccounted` — karta bo‘yicha PARSED CREDIT summasi ≠ CREDITED (shu summadagi to‘lov) + CARD_VERIFIED + REVIEW (karta
   id’lari; 15 daqiqadan yosh, hali qarorsiz xabar hisobga olinmaydi — job’i hozir ishlayotgan bo‘lishi mumkin); `paymentWithoutMessage` — `BankMessage`siz
   `P2P_CARD` Payment (DB CHECK buni rad etadi, bu himoya qatlami); `chainBreak` — oynada qayta hisoblangan balans zanjiridagi uzilish (`CHAIN_BREAK`
   review’i `RESOLVED` bo‘lgani — ega qanday yopgan bo‘lmasin — farq emas, ma’lumot sifatida `chainBreaksReviewed` da sanaladi); `pendingPastGrace` — `reservedUntil` o‘tgan
   PENDING so‘rov; `lateOverLimit` — D-42 qoldiq xavfi: `paidAt > expiresAt + TOPUP_CAPACITY_HOLD_SEC` bo‘lgan avtomatik to‘lov, kartasi hozir
   limitdan oshgan (to‘lov id’lari); `reviewOpenOver24h` — 24 soatdan oldin ochilgan va hali `OPEN` review (S9 I-1: egasini kutayotgan pul hech qachon
   «farq yo‘q» kun emas; misollar eng eskisidan); `purgeOverdue` — `purgeAfter` dan 2 kundan (`PURGE_OVERDUE_DAYS`) ko‘p o‘tib hali NULL qilinmagan
   xom matnlar (tozalash jobi yiqilyapti yoki orqada qolgan; misollar — `BankMessage` id’lari, matn o‘qilmaydi). Ma’lumot uchun (farq emas): OPEN review’larning umumiy soni, **chiqimlar xulosasi** (karta bo‘yicha DEBIT soni va summasi,
   tiyin satr; yaqinda yozilgan to‘lovga teng chiqimlar — oynadagi `POSSIBLE_REVERSAL` review’lar soni), grace’i oynada tugagan to‘lanmagan so‘rovlar.
3. **Natija.** `AuditLog` (`RECONCILE_AUDIT`: `actorType = SYSTEM`, `action = PAYMENT_RECONCILE`, `targetType = PaymentReconcileDay`,
   `targetId = <yyyymmdd>` Asia/Tashkent = alert `refId`, `actorId` bo‘sh), `after = { count, debits, openReviews, historyScan, history, window,
checkedMessages, mismatches, examples, debitsByCard, possibleReversals, graceEnded, chainBreaksReviewed }` — faqat id, son va DEBIT summalari; karta raqami, balans va
   bank matni yo‘q. Alert `reconcileOk` faqat farq 0 **va** `historyScan = ok` bo‘lsa, aks holda `reconcileMismatch` (`count` = tekshirilgan
   xabarlar yoki farqlar jami). API kunning **eng oxirgi** qatoridan render qiladi.
4. **Idempotentlik.** Bir kunda ikkinchi yugurish yana audit qatori yozadi, alert job id’si esa bir xil (`alert-<kind>-<yyyymmdd>`, notify dedupe) —
   bir xil xulosa kuniga bitta alert. Xulosa o‘zgarsa (ok, keyin farq) ikkinchi tur yuboriladi — ataylab: yangi narsa topildi.

Solishtirish o‘zi **pul yozmaydi** va holat o‘zgartirmaydi (faqat skan topgan xabarlar oddiy ingest’dan o‘tadi).

**`topup-expire`** (har daqiqada, `topup-expire:sweep`): `assertIntentTransition('PENDING', 'EXPIRED')` dan keyin `expireOverdueTopups`
(@repo/db) — API’ning `expireOverdue` bilan **bitta predikat** (`P2P_CARD`, `PENDING`, `expiresAt <= now`); PAID/CANCELLED/EXPIRED tegilmaydi,
`reservedUntil` o‘zgarmaydi. Keyin ACTIVE kartalar limiti (D-45, faqat qabul qilingan pul): 80–99 % → `cardNearLimit`; 100 % → karta qulfi ostida
qayta o‘qib ACTIVE → FULL + `cardFull`; alert id’lari card-limit job’iniki bilan bir xil (`cardLimitAlertRef`), shuning uchun karta va limit to‘plami
uchun bitta alert (30 kunlik dedupe’dan keyin eslatma takrorlanadi). Kartaning jimligi (`cardSilent`, 2-band) hali yo‘q — alohida qadam.
Muddat UPDATE’i karta qulfini olmaydi va allocator/matcher bilan deadlock qilmasligi kerak; baribir `40P01` (deadlock) bo‘lsa PostgreSQL bitta
tranzaksiyani bekor qiladi: sweep job’i xato bilan tugaydi va keyingi daqiqada butunlay qayta ishlaydi (UPDATE idempotent, yarim yozuv yo‘q).
**DRAINING → RETIRED:** keyin DRAINING kartalar 2-banddagi qoida bo‘yicha yopiladi (`CardDrainService`, karta qulfi, `lock_timeout` dan uzun tranzaksiya
timeout’i; band karta keyingi daqiqada); natijada `retiredCards`, `drainHeldByMessage`, `drainAlertsFailed` sanaladi, yo‘qolgan `cardDrained` 1 soat davomida
qayta navbatga qo‘yiladi (job id kartaga bitta).
**Yetim xabarlar (S9 m1):** sweep oxirida oxirgi 7 kun ichida 15 daqiqadan oldin saqlangan, qarorsiz xabarlar (eng yangisi birinchi, 100 tagacha)
`bm-<id>` job’ini qaytadan oladi: job yo‘q bo‘lsa qo‘shiladi (ingest commit bo‘ldi, `add` bo‘lmadi), `failed` bo‘lsa va 30 daqiqadan oldin tushgan bo‘lsa
yangi urinishlar va toza job ma’lumoti bilan (`updateData({ bankMessageId })`: tugab qolgan `predecessorWaits` / `dbOutageWaits` tashlanadi, B4) `retry`; kutayotgan/kechiktirilgan/ishlayotgan job’ga tegilmaydi. Pulni baribir faqat matcher yozadi (qaror bor bo‘lsa job
hech narsa qilmaydi). 7 kundan eskilari `missingOutcome` da ko‘rinadi. Log’da faqat sonlar.

**`bank-text-purge`** (har kuni 03:30 Asia/Tashkent, `payment-reconcile` navbatida, `payment-reconcile:bank-text-purge`): `text IS NOT NULL AND
purgeAfter <= timezone('UTC', now())` qatorlarda faqat `text` = NULL (trigger ruxsat bergan yagona o‘zgarish), 1000 talik partiyalar, bir yurishda
ko‘pi bilan 100 partiya (qolgani ertaga), `FOR UPDATE SKIP LOCKED`; idempotent, alert yo‘q — yiqilsa yoki orqada qolsa kunlik `purgeOverdue` ko‘rsatadi.

**DB uzilishi (S6 N5).** `bank-message` job’i DB ulanish xatosida (Prisma P1001/P1002/P1008/P1017/P2024, adapter `DatabaseNotReachable`,
`ConnectionClosed`, `SocketTimeout`, `TooManyConnections`, SQLSTATE 08xxx/57P01-3) attempt sarflamay 30 s ga kechiktiriladi, ko‘pi bilan 20 marta
(~10 daqiqa, `dbOutageWaits`); undan keyin oddiy attempt’lar va oxirida fail-closed. Ma’lumot xatosi (constraint, lock timeout, trigger) kutmaydi.

### Ogohlantirishlar jadvali (`notify` → `OWNER_ALERT`)

Job faqat `{ alert, refId }` olib yuradi; API `refId` bo‘yicha ma’lumotni bazadan o‘qiydi va matnni `alerts.bankFeed.*` (uz) dan yasaydi. Job id =
`alert-<alert>-<refId>`: BullMQ bir xil id ni qayta qabul qilmaydi (30 kun, `NOTIFY_DEDUPE_SEC`), shuning uchun `refId` har **mantiqiy hodisaga** bitta bo‘lishi kerak (takrorlanishi
kerak bo‘lgan alertlarda vaqt bo‘lagi qo‘shiladi). `refId` faqat `[A-Za-z0-9_]`, ko‘pi bilan 64 belgi. `OWNER_ALERT_CHAT_ID` production’da majburiy (API boot tekshiruvi); dev’da yo‘q bo‘lsa alert job’i
xato bilan tugaydi va failed to‘plamida qoladi — hech qachon «bajarildi» deb yopilmaydi.

| Alert                                                               | `refId`                                                        | Parametrlar manbasi                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unrecognized`, `cardUnknown`, `timeSkew`                           | `PaymentReview.id`                                             | `reviewId` = refId                                                                                                                                                                                                                                                                 |
| `titleUnknown`                                                      | `PaymentReview.id`                                             | `reviewId`; `bank`, `last4` = review kartasidan; `amount` = xabar summasi (`formatMoney`)                                                                                                                                                                                          |
| `integrityAnomaly`                                                  | `PaymentReview.id`                                             | `reviewId`; `bank`, `last4` = review kartasidan; `reason` = `PaymentReview.note` (`SENDER_MISMATCH` / `TEXT_HASH_MISMATCH`)                                                                                                                                                        |
| `processingFailed`                                                  | `PaymentReview.id`                                             | `reviewId`; `bank`, `last4` = review kartasidan                                                                                                                                                                                                                                    |
| `amountReallocated`, `lateStored`, `manualCreditSeen`               | `PaymentReview.id`                                             | `reviewId`; `bank`, `last4` = review kartasidan; `amount` = xabar summasi                                                                                                                                                                                                          |
| `rejected`                                                          | `PaymentReview.id`                                             | `reviewId`; `reason` = `BankMessage.rejectReason` (kod, matn emas)                                                                                                                                                                                                                 |
| `cardRetired`, `chainBreak`, `autoCreditPaused`                     | `PaymentReview.id`                                             | `reviewId`; `last4` = kartadan                                                                                                                                                                                                                                                     |
| `noMatch`, `ambiguous`, `duplicate`, `cancelledLate`, `userBlocked` | `PaymentReview.id`                                             | `reviewId`; `amount` = xabar summasi (`formatMoney`)                                                                                                                                                                                                                               |
| `dailyLimit`                                                        | `PaymentReview.id`                                             | `reviewId`; `amount`; `limit` = oshgan chekning o‘qiladigan matni (`alerts.limitReason.<kod>`, `{cap}` = chek summasi, `formatMoney`)                                                                                                                                              |
| `possibleReversal`                                                  | `PaymentReview.id`                                             | `reviewId`; `last4`; `amount`                                                                                                                                                                                                                                                      |
| `edited`                                                            | `BankMessage.id`                                               | `messageId` = refId                                                                                                                                                                                                                                                                |
| `foreignChat`                                                       | `<source>_<epoch soat>` (`alertRef.foreignChat`)               | `bank` = manbaning banki (bazadan hech narsa o‘qilmaydi; xabar saqlanmagan)                                                                                                                                                                                                        |
| `messageStuck`                                                      | `BankMessage.id`                                               | `messageId` = refId (bazadan hech narsa o‘qilmaydi: yozuvning o‘zi xato bergan bo‘lishi mumkin)                                                                                                                                                                                    |
| `effectsFailed`                                                     | `BankMessage.id`                                               | `messageId` = refId (bazadan hech narsa o‘qilmaydi); qaror saqlangan, commit’dan keyingi effektlar xato bergan, qayta ishlanmaydi (S9F-I1)                                                                                                                                         |
| `limitCheckFailed`                                                  | `BankMessage.id`                                               | `messageId` = refId; `bank`, `last4` = xabar kartasidan                                                                                                                                                                                                                            |
| `debit`                                                             | `BankMessage.id`                                               | `last4`; `amount` (xabardan, har chiqim uchun)                                                                                                                                                                                                                                     |
| `cardVerified`, `cardDraining`, `cardDrained`                       | `TopupCard.id`                                                 | `bank`; `last4`                                                                                                                                                                                                                                                                    |
| `cardFull`                                                          | `<cardId>_<limit>[_<oylik limit>]` (`cardLimitAlertRef`)       | `bank`; `last4`                                                                                                                                                                                                                                                                    |
| `cardNearLimit`                                                     | `<cardId>_80_<limit>[_<oylik limit>]` (`cardLimitAlertRef`)    | `bank`; `last4`; `percent` = tushgan pul ulushi, bazadan qayta hisoblanadi (`receivedUsagePercent`)                                                                                                                                                                                |
| `cardReservedHigh`                                                  | `<cardId>_<epoch soat>` (soatiga bitta; `cardReservedHighRef`) | `bank`; `last4`; `percent` = to‘lanmagan band ulushi, bazadan qayta hisoblanadi (`reservedSharePercent`)                                                                                                                                                                           |
| `lateOverLimit`                                                     | `Payment.id`                                                   | `bank`; `last4` = to‘lov xabarining kartasidan; `amount` = `Payment.amountTiyin` (`formatMoney`)                                                                                                                                                                                   |
| `cardSilent`                                                        | `<cardId>_<oxirgi kirim, epoch soniya>`                        | `bank`; `last4`; `hours` = kunduzgi jimlik soatlari                                                                                                                                                                                                                                |
| `listenerDown`                                                      | `<epoch soat>` (soat bo‘lagi)                                  | `minutes` = heartbeat yoshi                                                                                                                                                                                                                                                        |
| `sessionRevoked`                                                    | `<epoch soat>`                                                 | —                                                                                                                                                                                                                                                                                  |
| `newAuthorization`                                                  | `<Telegram avtorizatsiya id>`                                  | —                                                                                                                                                                                                                                                                                  |
| `reconcileOk`, `reconcileMismatch`                                  | `<yyyymmdd>` (Asia/Tashkent)                                   | `count`; `debits` = chiqimlar soni; `openReviews`; `history` = `alerts.reconcileHistory.<historyScan>`; Mismatch’da `details` = noldan farqli kodlar `code=n` + har manba sababi `<source>=<sabab>` (noma’lum kod — `<source>=?`) (`-` agar yo‘q) — kunning oxirgi audit qatoridan |
| `reconcileFailed`                                                   | `<yyyymmdd>` (Asia/Tashkent)                                   | `day` = refId (bazadan hech narsa o‘qilmaydi)                                                                                                                                                                                                                                      |
| `walletFrozen`                                                      | `<userId>_<ledgerEntryId>`                                     | `userId` (refId ning birinchi qismi)                                                                                                                                                                                                                                               |
| `adminAction`                                                       | `AuditLog.id`                                                  | `action` = `AuditLog.action`; `ref` = `AuditLog.id` (summasiz)                                                                                                                                                                                                                     |

`refId` ni yasash: `alertRef.walletFrozen`, `alertRef.cardSilent` (`packages/shared/src/notify.ts`); `cardFull` va `cardNearLimit` uchun
`cardLimitAlertRef` / `parseCardLimitAlertRef` (`packages/shared/src/payments/card-limit-ref.ts`, D-45): limitlar tiyinda, **base36** (kichik harf, boshida nolsiz)
yoziladi, chunki 19 xonali BIGINT ikki marta cuid bilan 64 belgiga sig‘maydi; eng uzuni 63 belgi. Limit `card:limit` bilan o‘zgarsa refId ham o‘zgaradi,
shuning uchun karta yana to‘lsa alert qayta boradi; bir xil limitlarda takror ishlash bitta alert. Bot-lifecycle alertlari (`webhookFailed`, `setupFailed`) bu navbatdan
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
manfiy balans → `purchaseFrozen` · sessiya satri, matn, karta raqami va token logda yo‘q · worker sirlari API’da bo‘lsa boot rad · S9: kech saqlangan
xabar (`LATE_STORED`), qo‘lda pul berilgandan keyingi xabar (`MANUAL_CREDIT_SEEN`, ikkala poyga tartibi), `wallet:adjust` to‘plam id’si bilan override
(to‘plam o‘zgarsa rad, chegaradan past ham), yetim qayta navbat, boshqa chat xabari (saqlanmaydi; skan `FOREIGN_CHAT` bilan `failed`), kunlik solishtirish
(har tekshiruv kodi, `reviewOpenOver24h`, manba sababi), `effectsFailed` / `messageStuck`. Haqiqiy akkaunt va test
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
