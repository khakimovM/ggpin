# 03 — Ma'lumotlar modeli

> **Haqiqat manbai — `packages/db/prisma/schema.prisma`** (Prisma 7, D-22). Migratsiyalar:
> `packages/db/prisma/migrations/20261029185158_init`, `20261031120000_domain_guardrails`
> ("Migratsiya 2" bo‘limi — trigger va `CHECK`lar faqat shu yerda), `20261101100000_discount_below_full_price`
> ("Migratsiya 3"), `20261102105448_auth_bot_guardrails` ("Migratsiya 4") va
> `20261102171806_login_session_link` + `20261102172000_login_session_link_check` ("Migratsiya 5"),
> `20261103164533_d30_column_renames` + `20261103165000_bonus_reward_check_null_safe` ("Migratsiya 6") va
> `20261103170006_catalog_pricing` ("Migratsiya 7"), `20261104120000_cost_snapshot_window_index` ("Migratsiya 8") va
> `20261104130000_p4_wallet_p2p` + `20261104130100_p4_wallet_p2p_checks` + `20261104130200_p4_review_kind_daily_limit` +
> `20261105090000_p4_wallet_p2p_hardening` + `20261105160000_p4_wallet_p2p_guards` +
> `20261105200000_p4_wallet_p2p_immutables` + `20261107090000_p4_bank_message_card_date_index` ("Migratsiya 9"). Bu hujjat sxemani tushuntiradi, nusxasini
> saqlamaydi: ikkalasi farq qilsa, to‘g‘ri bo‘lgani — `schema.prisma`. Sxema o‘zgarsa shu fayl
> ham o‘sha o‘zgarishda yangilanadi.

## Asosiy qoidalar

- Pul: `BigInt`, birligi ustun nomida (`Tiyin`, `MicroUsdt`, `NanoTon`, `Minor`). `Decimal`/`Float` yo‘q.
- Balans saqlanmaydi: `LedgerEntry` yig‘indisi. `Wallet` jadvali faqat **qulf** (row lock) uchun.
  Qabul kartasi (`TopupCard`) uchun alohida qator emas, tranzaksiya advisory qulfi (`lockTopupCard`, Migratsiya 9).
- Idempotentlik — unique indekslar orqali (quyidagi jadval).
- `Order.status` faqat `order-state.ts` orqali o‘zgaradi; `OrderStatus` enum `ORDER_STATUSES` bilan
  bir xil (DB testi tekshiradi).
- id — `cuid(2)`; jadval nomlari model nomlari bilan bir xil (`"Wallet"`, `"LedgerEntry"`).

## Modellar (36 ta model, 21 ta enum)

| Guruh         | Modellar                                                                                                                                           |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Foydalanuvchi | `User`, `Wallet`                                                                                                                                   |
| Hamyon        | `LedgerEntry` (so‘m), `CoinEntry` (keshbek tangalari)                                                                                              |
| Katalog       | `Category`, `Product`, `Sku`, `ProductRoute`, `Voucher`                                                                                            |
| Narx          | `FxRate`, `CostSnapshot`, `Quote`                                                                                                                  |
| Buyurtma      | `Order`, `OrderEvent`, `FulfillmentAttempt`                                                                                                        |
| To‘lov        | `PaymentIntent`, `Payment`                                                                                                                         |
| P2P karta     | `TopupCard`, `BankMessage`, `BankMessageText`, `BankMessageOutcome`, `PaymentReview`, `BankFeedCursor`, `BankFeedAccount`, `BankFeedAuthorization` |
| Promo         | `BonusCode`, `BonusRedemption`, `DiscountTier`, `DiscountCode`                                                                                     |
| Fragment      | `FragmentSession`, `WalletSnapshot`                                                                                                                |
| Auth / admin  | `WebSession`, `LoginRequest`, `AdminUser`, `AdminSession`, `AuditLog`, `Broadcast`, `Setting`                                                      |

## Idempotentlik unique'lari

| Jadval               | Unique                                                                                                                                                                            | Nimani himoya qiladi                                                                                                            |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `Payment`            | `(provider, providerTxnId)`                                                                                                                                                       | provayder callback'i takrorlansa                                                                                                |
| `Order`              | `(userId, idempotencyKey)`, `quoteId`                                                                                                                                             | buyurtma ikki marta yaratilmasin                                                                                                |
| `PaymentIntent`      | `(userId, idempotencyKey)`                                                                                                                                                        | intent ikki marta yaratilmasin                                                                                                  |
| `PaymentIntent`      | `(cardId, amountTiyin)` `WHERE status='PENDING'`; `(userId)` `WHERE status='PENDING' AND provider='P2P_CARD'`; `EXCLUDE (cardId, amountTiyin, tsrange(createdAt, reservedUntil))` | kartada bir xil summa ikki kishiga berilmasin (band summa `reservedUntil` gacha); foydalanuvchida bitta kutilayotgan P2P so‘rov |
| `PaymentIntent`      | `payTokenHash`                                                                                                                                                                    | pay-link tokeni bitta so‘rovga tegishli                                                                                         |
| `BankMessage`        | `(senderId, tgMessageId)`                                                                                                                                                         | bir bank xabari qayta o‘qilsa ikki marta saqlanmaydi                                                                            |
| `BankMessageOutcome` | `bankMessageId`, `paymentId`                                                                                                                                                      | bir xabar — bitta natija; bir to‘lov — bitta natija                                                                             |
| `Payment`            | `bankMessageId`, `reviewId`                                                                                                                                                       | bir bank xabari bitta to‘lov beradi (P2P idempotentligi); bir review bitta to‘lov beradi                                        |
| `PaymentReview`      | `(bankMessageId, kind)`                                                                                                                                                           | bir xabar uchun bir turdagi review bitta                                                                                        |
| `TopupCard`          | `(bank, last4)` `WHERE status<>'RETIRED'`                                                                                                                                         | bank bot kartani faqat `last4` bilan bildiradi, shuning uchun ikki faol karta bir juftlikka ega bo‘lmaydi                       |
| `FulfillmentAttempt` | `(orderId, attemptNo)`                                                                                                                                                            | urinish raqami bir marta                                                                                                        |
| `LedgerEntry`        | `(refType, refId, kind)`                                                                                                                                                          | bitta pul harakati bir marta yoziladi                                                                                           |
| `CoinEntry`          | `(refType, refId, kind)`                                                                                                                                                          | bitta tanga harakati bir marta yoziladi                                                                                         |
| `BonusRedemption`    | `(codeId, userId)`                                                                                                                                                                | bonus kod foydalanuvchiga bir marta                                                                                             |
| `FulfillmentAttempt` | `(adapter, externalRef)`                                                                                                                                                          | bitta tashqi to‘lov (TON hash / yetkazib beruvchi buyurtma id) faqat bitta urinishga tegishli; `NULL` ruxsat etiladi            |

## D-23 o‘zgarishlari (boshlang‘ich loyihaga nisbatan)

1. **Hamma `*Id` — haqiqiy FK.** Har biriga `@relation` va indeks qo‘shildi (32 ta FK). `onDelete`:
   hamma joyda `Restrict` (pul va audit tarixi kaskad bilan o‘chib ketmasin; `SetNull` ham yo‘q —
   u tarix qatorini jimgina o‘zgartirardi). Yagona istisno — `Cascade`: `WebSession`, `AdminSession`
   (tarix saqlamaydigan kirish ma'lumotlari). FK bo‘lmagan joylar (polimorf havola):
   `LedgerEntry`/`CoinEntry` `(refType, refId)`, `AuditLog` `actorId`/`targetId`, `Setting.updatedBy`.
2. **`updatedAt` faqat o‘zgaradigan jadvallarda.** Append-only jadvallarda yo‘q: `LedgerEntry`,
   `CoinEntry`, `AuditLog`, `OrderEvent`; o‘zgarmas snapshot'lar: `FxRate`, `CostSnapshot`, `WalletSnapshot`,
   `BonusRedemption`, `Wallet`. Qo‘shildi (qatorlari o‘zgaradi): `Category`, `Sku`, `ProductRoute`,
   `Voucher`, `Quote`, `PaymentIntent`, `Payment`, `BonusCode`, `DiscountTier`, `DiscountCode`,
   `WebSession`, `LoginRequest`, `AdminUser`, `AdminSession`, `Broadcast`. 4-fazada (Migratsiya 9) `updatedAt`siz
   qo‘shilganlar: `BankMessage`, `BankMessageText`, `BankMessageOutcome`; `updatedAt` bilan: `TopupCard`,
   `PaymentReview`, `BankFeedCursor`.
3. **Idempotentlik:** `Order.requestHash` va `PaymentIntent.idempotencyKey` + `requestHash`
   (`@@unique([userId, idempotencyKey])`) qo‘shildi: bir xil kalit + boshqa body → `409 IDEMPOTENCY_CONFLICT`.
4. **`Voucher` ↔ `Order` bog‘lanishi bitta:** faqat `Voucher.orderId` (`@unique`). `Order.voucherId`
   olib tashlandi — ikki tomonli havola bir-biriga zid bo‘lishi mumkin edi. Zahirada turadigan
   va sotiladigan qator voucher, shuning uchun havolani inventar tomoni ushlaydi; buyurtma
   uni `Order.voucher` orqali o‘qiydi.
5. **Qo‘shimcha indekslar:** `Product.categoryId`, `Sku.productId`, `Quote` (`skuId`, `productId`,
   `fxRateId`, `discountCodeId`, `expiresAt`), `Order` (`productId`, `skuId`), `PaymentIntent`
   (`quoteId`, `status+createdAt`), `Payment` (`intentId`, `status+createdAt`), `BonusCode.createdById`,
   `BonusRedemption.userId`, `DiscountCode.tierId`, `AdminSession.adminId`, `Broadcast.createdById`,
   `WebSession.familyId`, `AuditLog (actorId, createdAt)`, `WalletSnapshot.createdAt`.
6. **Generator:** `prisma-client` (Prisma 7), `moduleFormat = "cjs"`, natija `packages/db/src/generated`
   (git'da yo‘q, `npm run build -w @repo/db` yaratadi). `datasource`da URL yo‘q — u `prisma.config.ts`
   (faqat CLI) va ilovalarning tekshirilgan konfigidan keladi.

Eslatma: `Setting.updatedBy`, `LedgerEntry.refId` kabi polimorf maydonlar FK emas; ularning
yaxlitligi servis qatlamida ta'minlanadi.

## Migratsiya 2: `20261031120000_domain_guardrails`

Faqat qo‘shimcha (additive) o‘zgarishlar: hech bir ustun yoki jadval o‘chirilmagan va nomi o‘zgartirilmagan.
Prisma ifodalay olmaydigan qismlar (trigger va `CHECK`) xom SQL sifatida shu migratsiyada; ular
`schema.prisma`da ko‘rinmaydi, lekin DB testlari (`packages/db/test/*.e2e.test.ts`) har birini tekshiradi.

1. **`Order.fxRateId`** — `FxRate`ga haqiqiy FK (`Restrict`), indeksli, `NOT NULL`. Qoida: buyurtma
   narxlangan FX snapshot id'sini o‘zida saqlaydi (avval faqat `Quote`da edi). Qiymat yaratilish
   paytida `Quote.fxRateId` bilan bir xil bo‘lishi servis qatlamida ta'minlanadi. Migratsiya paytida
   dev va test bazalarida `Order` jadvali bo‘sh edi, shuning uchun to‘ldirish (backfill) kerak bo‘lmadi.
2. **Append-only DB darajasida.** `LedgerEntry`, `CoinEntry`, `OrderEvent`, `AuditLog` jadvallarida
   `BEFORE UPDATE OR DELETE` qator triggeri (`ggpin_forbid_mutation()`) istisno ko‘taradi. `TRUNCATE`
   qator triggerlarini ishga tushirmaydi — test tozalash shunga tayanadi (`TRUNCATE ... CASCADE`);
   productionda ilova roliga `TRUNCATE` huquqi berilmaydi. Xato kodi — loyihaga xos SQLSTATE `GG001`
   (`20261031130000_append_only_error_code` migratsiyasi). Dastlabki `restrict_violation` (23001) kodini
   Prisma pg adapteri FK xatosiga o‘xshatib ko‘rsatar va trigger matnini yashirar edi; `GG001` bilan
   kod ham, `… is append-only` matni ham klientgacha yetib boradi.
3. **`CHECK` cheklovlari:**

   | Jadval                         | Cheklov                                                                                                                                                        |
   | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `LedgerEntry`                  | ishora turga qarab (jadval pastda); noma'lum tur rad etiladi (`ELSE false`) — yangi tur qo‘shilsa, cheklov ham yangilanadi                                     |
   | `CoinEntry`                    | `EARN` > 0; `SPEND`, `EXPIRE` < 0; `ADJUSTMENT`, `REVERSAL` ≠ 0 (`REVERSAL` EARN yoki SPEND'ni bekor qilishi mumkin)                                           |
   | `Order`, `Quote`               | `quantity` > 0, `priceTiyin` > 0, `costMinor` > 0, `maxCostMinor` ≥ `costMinor`                                                                                |
   | `Order`                        | `0 ≤ discountTiyin < priceTiyin` (`priceTiyin` — chegirmadan oldingi narx; 3-migratsiyada qat'iylashtirilgan)                                                  |
   | `PaymentIntent`, `Payment`     | `amountTiyin` > 0                                                                                                                                              |
   | `Sku`                          | `quantity` > 0, `minMarginTiyin` ≥ 0, `markupBps` ≥ 0 (ustama 100% dan oshishi mumkin, shuning uchun yuqori chegara yo‘q)                                      |
   | `Product`                      | `minQty`, `maxQty` > 0 va `minQty` ≤ `maxQty`; `allowCustomQty` bo‘lsa ikkalasi ham to‘ldirilgan (`_custom_qty_check`, 7-migratsiya)                           |
   | `CostSnapshot`                 | `costMinor` > 0, `basisQuantity` > 0, `currency` ∈ `TON`, `USDT`; `adapter`, `source` bo‘sh emas (7-migratsiya)                                                |
   | `Quote`                        | `costCurrency` ∈ `TON`, `USDT` (`_cost_currency_check`, 7-migratsiya)                                                                                          |
   | `Voucher`                      | `costMicroUsdt` > 0                                                                                                                                            |
   | `FulfillmentAttempt`           | `attemptNo` > 0, `costMinor` ≥ 0                                                                                                                               |
   | `WalletSnapshot`               | `nanoTon` ≥ 0, `microUsdt` ≥ 0 (6-migratsiyada ustunlar nomi o‘zgargan, CHECK nomi bilan birga ko‘chgan)                                                       |
   | `BonusCode`                    | `maxUses` > 0, `0 ≤ usedCount ≤ maxUses` (`_usage_check`); aynan bitta mukofot ustuni, `rewardType` ga mos, > 0 (`_reward_check`, 6-migratsiya)                |
   | `DiscountTier`, `DiscountCode` | `bps` 0..9999 (3-migratsiyada qat'iylashtirilgan); `DiscountTier.priceCoins` > 0                                                                               |
   | `FxRate`                       | `rate` — musbat o‘nlik qator, ko‘pi bilan 18 xona (`money.ts` bilan bir xil); `pair` ∈ `USDT_UZS`, `TON_USDT`, `TON_UZS` va `source` bo‘sh emas (7-migratsiya) |
   | `User`                         | `referredById` ≠ `id` (o‘zini o‘zi taklif qila olmaydi)                                                                                                        |

   `Quote`da chegirma ustuni yo‘q, shuning uchun "chegirma ≤ narx" cheklovi faqat `Order`da.

4. **Yangi `LedgerKind.REFERRAL_BONUS_REVERSAL` (−).** Yetkazilgan buyurtma admin tomonidan qaytarilsa,
   referal bonusi shu tur bilan bekor qilinadi. Keshbek uchun yangi tur kerak emas: `CoinKind.REVERSAL` bor.
   `LedgerEntry` ishora jadvali:

   | `kind`                    | `amountTiyin` |
   | ------------------------- | ------------- |
   | `TOPUP`                   | > 0           |
   | `REFUND`                  | > 0           |
   | `REFERRAL_BONUS`          | > 0           |
   | `TOPUP_REVERSAL`          | < 0           |
   | `PURCHASE`                | < 0           |
   | `REFERRAL_BONUS_REVERSAL` | < 0           |
   | `ADJUSTMENT`              | ≠ 0           |

5. **`refType` kelishuvi.** `(refType, refId, kind)` unique — idempotentlik himoyasi, shuning uchun bitta
   buyurtmaga bitta `REFUND`. Avtomatik qaytarish (xato/bekor) va admin'ning to‘liq qaytarishi
   `ORDER/<orderId>` bilan yoziladi. Admin'ning **qisman** qaytarishi va tuzatishlari
   `refType = 'ADMIN_ACTION'`, `refId = AuditLog.id` bilan yoziladi — shunda bir buyurtmaga bir necha
   qisman qaytarish to‘qnashmaydi, bir xil audit amali esa ikki marta yozilmaydi. `refType` qiymatlari:
   `PAYMENT | ORDER | REFERRAL | ADMIN_ACTION`.
6. **`FulfillmentAttempt (adapter, externalRef)` unique.** `NULL` qiymatlar Postgres'da to‘qnashmaydi.
   Oddiy `@@index([externalRef])` saqlab qolindi: reconciler zanjirdan olingan hash bo‘yicha faqat
   `externalRef` bilan qidiradi, unique esa `adapter` bilan boshlangani uchun bunga yaramaydi.
7. **`createdAt` qo‘shildi:** `Category`, `Sku`, `ProductRoute`, `DiscountTier`, `Setting`,
   `FragmentSession`. Endi hamma modelda `createdAt` bor (sxema testi tekshiradi).
8. **`Payment.provider` uchun alohida indeks kerak emas:** `@@unique([provider, providerTxnId])` indeksi
   `provider` bilan boshlanadi va shu so‘rovlarga xizmat qiladi.

## Migratsiya 3: `20261101100000_discount_below_full_price`

Faqat `CHECK` cheklovlari o‘chirilib, qatʼiyroq shaklda qayta yaratildi; ustun, jadval va maʼlumotga
tegilmadi.

- Muammo: 2-migratsiyada `bps BETWEEN 0 AND 10000` va `discountTiyin <= priceTiyin` 100% chegirmaga
  ruxsat berar edi. Lekin xarid `LedgerEntry(PURCHASE)` yozadi (summa **< 0**), qaytarish esa
  `REFUND` (**> 0**): to‘liq chegirmali buyurtmaning yozuvi `LedgerEntry` cheklovidan o‘tmay, checkout
  tranzaksiyasi DB xatosi bilan yiqilar edi. PRDʼdagi chegirma darajalari 0,2–1,5%, yaʼni 100% kerak emas.
- Yangi qoida: `DiscountTier.bps`, `DiscountCode.bps` ∈ [0, 9999]; `Order.discountTiyin` ∈ [0, `priceTiyin`).
  Cheklov nomlari o‘zgarmadi (`DiscountTier_values_check`, `DiscountCode_bps_check`, `Order_discount_check`).
- Xavfsizlik: qo‘llashdan oldin dev va test bazalarida chegaradagi qator (`bps >= 10000`,
  `discountTiyin >= priceTiyin`) yo‘qligi tekshirildi, shuning uchun qayta qo‘shish xatosiz o‘tadi.
- Servis qatlamida (keyingi fazalar) chegirma hisoblash ham shu qoidaga amal qiladi: narx kamida 1 tiyin.

## Migratsiya 4: `20261102105448_auth_bot_guardrails`

2-faza (autentifikatsiya + bot). Faqat qo‘shimcha: ustun, jadval o‘chirilmadi, nomi yoki turi
o‘zgarmadi. Yozilgan paytda `LoginRequest` dev va test bazalarida bo‘sh edi.

- **`User.botBlockedAt DateTime?`** — foydalanuvchi botni bloklagan vaqt (`my_chat_member` → `kicked`
  yoki `sendMessage` 403). Bu admin bloki **`isBlocked` emas**: `isBlocked` `403 USER_BLOCKED` beradi va
  Mini App/vebga kirishni yopadi, `botBlockedAt` esa faqat bot xabarlarini to‘xtatadi. Foydalanuvchi
  botni qayta ishga tushirsa (`/start` yoki `member`) — `null` bo‘ladi. docs/07 dagi "`isBlocked=true`"
  iborasi shu ustun bilan almashtirildi (D-28).
- **`LoginRequest` indeksi** `(status, expiresAt)` — muddati o‘tgan so‘rovlarni tozalovchi sweep uchun.
- **`LoginRequest` `CHECK`lari** (`kind`/`status` matn bo‘lib qoladi — enumʼga o‘tkazish tur
  o‘zgarishi bo‘lardi; cheklovlar xuddi shu himoyani beradi va yangi qiymat aniq qo‘shilmaguncha rad etadi):
  - `LoginRequest_attempts_check`: `attempts BETWEEN 0 AND 5` — `packages/shared/src/auth/auth-constants.ts`
    dagi `OTP_MAX_ATTEMPTS = 5` bilan birga o‘zgaradi.
  - `LoginRequest_kind_check`: `kind IN ('USER','ADMIN')`.
  - `LoginRequest_status_check`: `status IN ('PENDING','CODE_SENT','USED','EXPIRED','DENIED')`.
  - `LoginRequest_code_sent_check`: `CODE_SENT` holatida `codeHash` va `telegramId` majburiy.
- **DDLsiz maʼno o‘zgarishi:** `LoginRequest.codeHash` = hex HMAC-SHA256(`OTP_PEPPER`, `nonce:code`);
  `WebSession.refreshHash` = HMAC-SHA256(`JWT_REFRESH_SECRET`, token). Peppersiz oddiy sha256 6 xonali
  kodni DB nusxasidan bir zumda topishga imkon berardi. Jadvallar bo‘sh edi, backfill kerak emas.
- Isbot: `packages/db/test/check-constraints-auth.e2e.test.ts`.

## Migratsiya 5: `20261102171806_login_session_link` + `20261102172000_login_session_link_check`

2-faza review tuzatishlari (D-29). Faqat qo‘shimcha. Ikkiga bo‘lingan, chunki birinchisi dev
bazaga allaqachon qo‘llangan edi va qo‘llangan migratsiya tahrirlanmaydi.

- **`LoginRequest.sessionFamilyId String?`** — shu kod bilan ochilgan web sessiya oilasi.
  `verify` uni `USED` bilan bitta tranzaksiyada yozadi. Botdagi «Bu men emasman» kod
  ishlatilgandan keyin bosilsa, aynan shu oila bekor qilinadi va so‘rov `DENIED` bo‘ladi.
- **Indeks `(telegramId, expiresAt)`** — botning "10 daqiqada 5 kod" sanog‘i uchun. Bu sanoq
  oldin butun jadvalni ko‘rib chiqardi (Seq Scan).
- **`LoginRequest_session_family_check`:** `sessionFamilyId` faqat `USED` yoki `DENIED` holatida
  bo‘lishi mumkin.
- `createdAt` endi servisdagi soatdan yoziladi (DB `now()` emas). Kod yetkazilmay qolganda
  so‘rov `PENDING` holatiga qaytariladi va `expiresAt = createdAt + 10 daqiqa` bo‘ladi.
- Isbot: `packages/db/test/check-constraints-auth.e2e.test.ts`.

## Migratsiya 6: `20261103164533_d30_column_renames` + `20261103165000_bonus_reward_check_null_safe`

D-30.2 (egasi tasdiqlagan): ustun nomlari `rules/40` nomlash qoidasiga (`nanoTon`, `microUsdt`) keltirildi
va promo mukofoti tur bo‘yicha ajratildi. Ikkiga bo‘lingan, chunki birinchisi lokal bazalarga
allaqachon qo‘llangan edi va qo‘llangan migratsiya tahrirlanmaydi.

- **`WalletSnapshot.tonNano` → `nanoTon`, `usdtMicro` → `microUsdt`:** haqiqiy `RENAME COLUMN`
  (Prisma DROP+ADD chiqargan edi, qo‘lda almashtirilgan). Ma'lumot saqlanadi;
  `WalletSnapshot_balances_check` ustun nomi bilan birga o‘zi ko‘chadi.
- **`BonusCode.rewardValue` o‘rniga `rewardTiyin BIGINT?` va `rewardCoins BIGINT?`.** `DO $` qo‘riqchisi:
  jadvalda qator bo‘lsa migratsiya `RAISE EXCEPTION` bilan to‘xtaydi (ma'lumot jim yo‘qolmaydi).
  `BonusCode_usage_check` qayta yaratildi: avvalgi semantika (`maxUses` > 0, `0 ≤ usedCount ≤ maxUses`),
  faqat `rewardValue` > 0 sharti `BonusCode_reward_check` ga ko‘chdi.
- **`BonusCode_reward_check`:** `WALLET_TIYIN` → `rewardTiyin` > 0 va `rewardCoins` NULL; `COINS` → `rewardCoins` > 0
  va `rewardTiyin` NULL. Birinchi variant `IS NOT NULL`siz yozilgan edi va "ikkalasi ham NULL" holatini
  o‘tkazib yuborardi (CHECK natija NULL bo‘lsa o‘tadi); ikkinchi migratsiya buni tuzatadi.
- **Nega bitta (kichik) migratsiya yetarli:** productionda baza ham, deploy qilingan versiya ham yo‘q;
  DB testlaridan tashqari hech narsa bu ustunlarni o‘qimaydi; `WalletSnapshot` o‘zgarishi ma'lumotni
  saqlovchi RENAME; `BonusCode` ustunini olib tashlash bo‘shlik tekshiruvi bilan qo‘riqlangan; egasi
  D-30.2 da tasdiqlagan. Qiymat bor bo‘lganda expand → backfill → contract kerak bo‘lardi.
- Isbot: `packages/db/test/check-constraints-catalog.e2e.test.ts` (mukofot matritsasi, nomlar o‘zgargani).

## Migratsiya 7: `20261103170006_catalog_pricing`

3-faza (katalog va narx). Faqat qo‘shimcha; mavjud ustun o‘zgarmaydi.

- **Yangi model `CostSnapshot`** (o‘zgarmas, `updatedAt` yo‘q): `productId` (FK Restrict), `skuId?` (FK Restrict),
  `adapter`, `currency` (`TON` | `USDT`), `basisQuantity`, `costMinor` (nanoTON yoki microUSDT, shu miqdor uchun),
  `source` (`simulator` va h.k.). `skuId` NULL — mahsulot darajasidagi qator (Stars: `basisQuantity` 1).
  Indekslar: `(productId, skuId, createdAt)` (oxirgi snapshot'ni topish; `productId` FK'si ham shu bilan qoplanadi),
  `skuId`.
- **`Sku(productId, quantity)` unique emas** (sxema bir miqdorli ikki paketni taqiqlamaydi).
  Erkin miqdorli mahsulotda bir xil miqdorli ikki **faol** paket bo‘lsa, erkin miqdor yopiladi (katalog
  `allowCustomQty: false` ko‘rsatadi, kotirovka `QTY_OUT_OF_RANGE` `{ min: null, max: null }` qaytaradi), chunki qaysi paket
  markup beradi noaniq; paketlar `skuId` bilan avvalgidek sotiladi. 9-bosqich admin paneli buning oldini oladi.
- **`Quote.costSnapshotId`** — NOT NULL, FK Restrict, indeksli: kotirovka qaysi tannarxdan chiqqani keyinroq ham
  isbotlanadi (`fxRateId` bilan birga). Eski kotirovka uchun snapshot'ni tiklab bo‘lmaydi, shuning uchun migratsiya
  `Quote` bo‘sh bo‘lmasa `RAISE EXCEPTION` bilan to‘xtaydi (avval `DO $` qo‘riqchisi, keyin ustun qo‘shiladi).
- **CHECK'lar** (hammasi NULL-xavfsiz, ya'ni natija hech qachon NULL bo‘lmaydi — CHECK NULL'ni o‘tkazib yuboradi):
  `CostSnapshot_values_check` va `FxRate_pair_check` faqat NOT NULL ustunlarga tayanadi; `Quote_cost_currency_check`
  NOT NULL `costCurrency` ustida; `Product_custom_qty_check` — `NOT "allowCustomQty" OR ("minQty" IS NOT NULL AND
"maxQty" IS NOT NULL)`: nullable `minQty`/`maxQty` faqat `IS NOT NULL` orqali tekshiriladi, `allowCustomQty` NOT NULL.
- **Triggerlar:** `FxRate_no_update` va `CostSnapshot_no_update` — `BEFORE UPDATE` qator triggeri, mavjud
  `ggpin_forbid_mutation()` (SQLSTATE `GG001`). Faqat UPDATE: bog‘langan qatorni DELETE qilishni `Quote`/`Order`
  dagi Restrict FK'lar to‘xtatadi, `TRUNCATE` (test tozalash) qator triggerini ishga tushirmaydi. Bog‘lanmagan
  snapshot'ni DELETE qilish taqiqlanmagan (plan shunday).
- Jadvallar bo‘sh edi (dev bazada `Quote`, `FxRate`, `Product` 0 qator), shuning uchun yangi CHECK'lar mavjud qatorga
  to‘qnashmaydi.
- Isbot: `packages/db/test/check-constraints-pricing.e2e.test.ts` (har CHECK uchun qabul/rad matritsasi, NULL
  holatlari, triggerlar, FK), `src/schema.test.ts`.

## Migratsiya 8: `20261104120000_cost_snapshot_window_index`

Faqat indeks qo‘shadi; ma’lumot va mavjud ustunlar o‘zgarmaydi (destruktiv emas, `CREATE INDEX`).

- **Yangi indeks `CostSnapshot_productId_createdAt_idx`** — `(productId, createdAt)`. Sabab: `CostSnapshot` faqat o‘sadi
  (sinxronlash har mahsulot/SKU uchun bir necha daqiqada bitta qator qo‘shadi), ikkita o‘qish esa `skuId` cheklanmagan yoki
  `IS NULL` bo‘lganda `createdAt` oralig‘i bilan filtrlaydi: katalog narxi (`productId IN (…) AND createdAt BETWEEN …`) va
  mahsulot darajasidagi eng yangi snapshot (`skuId IS NULL ORDER BY createdAt DESC LIMIT 1`). `(productId, skuId, createdAt)`
  indeksi `skuId` dan keyingi `createdAt` oralig‘ini chegaralay olmaydi, shuning uchun ikkalasi ham mahsulotning butun
  tarixini o‘qirdi (tarix bilan chiziqli o‘sadi).
- **Isbot** (`ggpin_test`, PostgreSQL 16, tranzaksiya ichida va `ROLLBACK`; 1 mahsulotda 50 000 snapshot, boshqa 50 mahsulotda
  5 000 tadan, `FxRate` 30 000 qator): katalog o‘qishi 462 → 15 buffer (2,6 ms → 0,1 ms); mahsulot darajasidagi eng yangi
  snapshot parallel `Seq Scan` (3 804 buffer, 16 ms) → `Index Scan Backward` (4 buffer, 0,1 ms). `latestFxRate` oldindan
  `FxRate_pair_createdAt_idx` dan foydalanadi (`Index Scan Backward`, 4–7 buffer) — o‘zgarmadi.
- Qoldiq cheklov (yangilandi): mahsulot darajasidagi qator (`skuId IS NULL`) endi faqat `allowCustomQty` mahsulotlar (Stars)
  uchun so‘raladi va ularda doim mavjud. `allowCustomQty = false` mahsulot (Premium) faqat SKU darajasidagi qatordan
  narxlanadi va mahsulot darajasidagi qator umuman so‘ralmaydi, shuning uchun "bo‘sh natija uchun butun tarixni o‘qish" yo‘li
  yopildi. Qolgan cheklov: Stars'da SKU qatori eskirib mahsulot darajasiga qaytilganda ham indeks mahsulot qatorlarini orqaga
  qarab o‘qiydi (topiladi, tarix bilan o‘sadi); kerak bo‘lsa keyin qisman indeks qo‘shiladi.

## Migratsiya 9: 4-faza — hamyon va P2P karta orqali to‘ldirish (D-31, D-37)

Yetti fayl. Qo‘llangan migratsiya tahrirlanmaydi, shuning uchun har review tuzatishi yangi faylda. Quyidagi tavsif —
**yettitasi qo‘llangandan keyingi holat**, jadval bo‘yicha. Qavsdagi belgilar (H1, M1…, m1…, N1…, Y1…) review
topilmalari; ular kod izohlari va testlarda ham shu nom bilan uchraydi.

| #   | Migratsiya                                       | Nima qiladi                                                                                                                                                                                                  |
| --- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `20261104130000_p4_wallet_p2p`                   | `GG002` qo‘riqchisi (`Payment` bo‘sh bo‘lmasa to‘xtaydi: `userId` ni taxmin qilmaydi); 10 enum, `PaymentProviderCode.P2P_CARD`; 6 jadval; `PaymentIntent` va `Payment` ustunlari; FK'lar va oddiy indekslar  |
| 2   | `20261104130100_p4_wallet_p2p_checks`            | CHECK'lar, partial unique'lar, `btree_gist` + EXCLUDE, append-only va karta identifikatori triggerlari. Alohida fayl: `ALTER TYPE … ADD VALUE` bilan qo‘shilgan `P2P_CARD` o‘sha tranzaksiyada ishlatilmaydi |
| 3   | `20261104130200_p4_review_kind_daily_limit`      | `PaymentReviewKind.NEW_ACCOUNT_LIMIT` → `DAILY_LIMIT` (`ALTER TYPE … RENAME VALUE`; 1-fayl qo‘llangan edi)                                                                                                   |
| 4   | `20261105090000_p4_wallet_p2p_hardening`         | S2 code-review: `PaymentReview.bankMessageId NOT NULL` (`GG002` qo‘riqchisi bilan), yangi FK'lar va CHECK'lar, `BankMessage_card_guard`, `PaymentIntent_p2p_guard`, `Payment_consistency_guard`              |
| 5   | `20261105160000_p4_wallet_p2p_guards`            | Ikkinchi review: to‘rt trigger funksiyasi `CREATE OR REPLACE` (triggerlar o‘sha funksiyalarga qarab turaveradi), yangi `BankMessageOutcome_links_guard`, ikki FK indeksi                                     |
| 6   | `20261105200000_p4_wallet_p2p_immutables`        | Uchinchi review: yangi `Payment_immutable_guard`, `PaymentReview_immutable_guard`; ikki funksiya `CREATE OR REPLACE`. Jadval, ustun, indeks o‘zgarishi yo‘q                                                  |
| 7   | `20261107090000_p4_bank_message_card_date_index` | S6 (D-43 (2)): `BankMessage(cardId, tgDate)` indeksi                                                                                                                                                         |

Faqat qo‘shimcha. Ikki yumshatish: `Payment.intentId` nullable bo‘ldi (review'dan yozilgan to‘lovda so‘rov yo‘q),
`Payment.userId` yangi va NOT NULL (dev va test bazada `Payment` 0 qator edi). Yangi kengaytma: `btree_gist` (trusted).
NULL-xavfsizlik: har nullable ustun CHECK ichida aniq `IS NOT NULL` bilan tekshiriladi, shuning uchun hech bir CHECK
NULL natija berib o‘tib ketmaydi. Partial indeks predikatlari enum literalini ishlatadi (`"provider" = 'P2P_CARD'`),
`::text` emas: cast `STABLE`, indeks predikati esa `IMMUTABLE` bo‘lishi shart.

### SQLSTATE kodlari

| Kod     | Maʼnosi                                                                                          |
| ------- | ------------------------------------------------------------------------------------------------ |
| `GG001` | o‘zgarmas / append-only qator yoki taqiqlangan holat o‘zgarishi (2-migratsiyadan beri)           |
| `GG002` | migratsiya qo‘riqchisi: jadvalda migratsiya xavfsiz qayta talqin qila olmaydigan maʼlumot bor    |
| `GG003` | `BankMessage.cardId` xabarga mos emas                                                            |
| `GG004` | `Payment` o‘z intenti yoki bank xabari bilan ziddiyatli                                          |
| `GG005` | `BankMessageOutcome` boshqa bank xabariga tegishli to‘lov yoki review'ni nomlaydi (5-migratsiya) |

### Enum'lar (10 yangi + 1 qiymat)

| Enum                      | Qiymatlar                                                                                                                                                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CardBank`                | `HUMO`, `UZCARD`                                                                                                                                                                                                         |
| `TopupCardStatus`         | `VERIFYING`, `ACTIVE`, `DRAINING`, `FULL`, `RETIRED`                                                                                                                                                                     |
| `BankFeedSource`          | `HUMO_BOT`, `UZCARD_BOT`                                                                                                                                                                                                 |
| `BankParseStatus`         | `PARSED`, `UNRECOGNIZED`, `REJECTED`                                                                                                                                                                                     |
| `BankDirection`           | `CREDIT`, `DEBIT`                                                                                                                                                                                                        |
| `ChainStatus`             | `FIRST`, `OK`, `BREAK`, `NOT_APPLICABLE`                                                                                                                                                                                 |
| `BankOutcome`             | `CREDITED`, `CARD_VERIFIED`, `DEBIT_RECORDED`, `REVIEW`                                                                                                                                                                  |
| `PaymentReviewKind`       | `UNRECOGNIZED`, `REJECTED`, `CARD_UNKNOWN`, `CARD_RETIRED`, `CHAIN_BREAK`, `AUTO_CREDIT_PAUSED`, `NO_MATCH`, `AMBIGUOUS`, `DUPLICATE`, `TIME_SKEW`, `CANCELLED_LATE`, `DAILY_LIMIT`, `POSSIBLE_REVERSAL`, `USER_BLOCKED` |
| `PaymentReviewStatus`     | `OPEN`, `RESOLVED`                                                                                                                                                                                                       |
| `PaymentReviewResolution` | `CREDITED_USER`, `IGNORED`, `RETURNED_OFFLINE`, `CHAIN_ACCEPTED`                                                                                                                                                         |
| `PaymentProviderCode`     | mavjud enum'ga `P2P_CARD` qo‘shildi                                                                                                                                                                                      |

- `DAILY_LIMIT` bitta tur bilan ikkala kunlik chekni qamraydi (yangi akkaunt va barcha akkauntlar); qaysi biri oshgani
  `PaymentReview.note` da kod bilan yoziladi (`DAILY_LIMIT` yoki `NEW_ACCOUNT_DAILY_LIMIT`).
- Ro‘yxatlar `packages/shared/src/payments/bank-feed.ts` (`CARD_BANKS`, `TOPUP_CARD_STATUSES`, `BANK_FEED_SOURCES`,
  `BANK_PARSE_STATUSES`, `BANK_DIRECTIONS`, `CHAIN_STATUSES`, `BANK_OUTCOMES`, `REVIEW_KINDS`, `PAYMENT_REVIEW_STATUSES`,
  `PAYMENT_REVIEW_RESOLUTIONS`) va `intent-state.ts` (`INTENT_STATUSES`) bilan bir xil; `packages/db/src/payments-enums.test.ts`
  to‘plam tengligini tekshiradi (tartib ahamiyatsiz).

### `TopupCard` — qabul qiluvchi kartalarimiz

O‘zgaruvchan (`updatedAt` bor). `pan` — **o‘zimizning** qabul kartamiz raqami (E-13), faqat kutilayotgan so‘rov egasiga
ko‘rsatiladi; mijoz kartasining maʼlumoti hech qayerda saqlanmaydi.

| Ustun               | Tur               | Qoida                                                                       |
| ------------------- | ----------------- | --------------------------------------------------------------------------- |
| `bank`              | `CardBank`        | o‘zgarmas                                                                   |
| `pan`               | `String`          | 16 raqam; o‘zgarmas                                                         |
| `last4`             | `String`          | `= right(pan, 4)`; bank bot kartani faqat shu bilan bildiradi; o‘zgarmas    |
| `holderName`        | `String`          | bo‘sh emas (`btrim`); o‘zgarmas                                             |
| `status`            | `TopupCardStatus` | standart `VERIFYING`                                                        |
| `receiveLimitTiyin` | `BigInt`          | > 0; `card:add` da majburiy, umumiy standart yo‘q (E-9)                     |
| `monthlyLimitTiyin` | `BigInt?`         | NULL yoki > 0                                                               |
| `verifyAmountTiyin` | `BigInt`          | > 0; shu test o‘tkazmasi kelsa `VERIFYING → ACTIVE` (`verifiedAt` yoziladi) |
| `verifiedAt`        | `DateTime?`       | `VERIFYING` va `RETIRED` dan boshqa holatda majburiy                        |
| `retiredAt`         | `DateTime?`       | `RETIRED` ⇔ bor; o‘rnatilgach o‘zgarmaydi                                   |
| `autoCreditPaused`  | `Boolean`         | standart `false`                                                            |

- **CHECK:** `TopupCard_values_check` (pan `^[0-9]{16}$`, `last4 = right(pan,4)`, `receiveLimitTiyin` > 0,
  `monthlyLimitTiyin` NULL yoki > 0, `verifyAmountTiyin` > 0, ism bo‘sh emas); `TopupCard_retired_check`
  (`RETIRED` ⇔ `retiredAt`); `TopupCard_verified_check` (n1: `status IN ('VERIFYING','RETIRED') OR verifiedAt IS NOT NULL` —
  tasdiqlanmasdan `RETIRED` qilingan karta ham mumkin).
- **Unique:** `TopupCard_bank_last4_active_key` — `(bank, last4) WHERE status <> 'RETIRED'`: ikki tirik karta bir juftlikka
  ega bo‘lmaydi; `RETIRED` juftlikni bo‘shatadi (karta qayta chiqariladi). Ikki parallel `card:add` dan bittasi o‘tadi.
- **Indeks:** `(status, bank)`.
- **Trigger `TopupCard_identity_immutable`** (`ggpin_topup_card_identity_guard()`, `BEFORE UPDATE`, `GG001`): `bank, pan,
last4, holderName` o‘zgarmaydi (L6) — xabar kartaga moslangan, ochiq so‘rov va pay sahifasi shularga tayanadi; karta
  almashsa eskisi `RETIRED`, yangisi qo‘shiladi. `RETIRED` yakuniy va `retiredAt` o‘rnatilgach o‘zgarmaydi (N6: aks holda
  «eng oxirgi `RETIRED`» qoidasi ostidagi xabarlar jimgina boshqa kartaga o‘tib qolardi). Holat, limitlar va pauza
  (`RETIRED` kartada ham) o‘zgara oladi.
- **Qolgan holat grafi faqat TS'da** (`packages/shared/src/payments/card-state.ts`, `assertCardTransition`):
  `VERIFYING → ACTIVE | RETIRED`, `ACTIVE → FULL | DRAINING | RETIRED`, `FULL → ACTIVE | DRAINING | RETIRED`,
  `DRAINING → RETIRED`. `DRAINING` — yangi so‘rov berilmaydi, berilganlari `reservedUntil` gacha to‘lanadi. Oddiy
  `card:retire`: `ACTIVE`/`FULL` → `DRAINING`, `VERIFYING` → darhol `RETIRED`; favqulodda retire — darhol `RETIRED`,
  karta `PENDING` so‘rovlari `CANCELLED`. `FULL ↔ ACTIVE` olingan pulga qarab (D-45).
- **Qulf:** kartani o‘zgartiradigan yoki unda summa ajratadigan kod `lockTopupCard(tx, cardId)` ni oladi
  (`pg_advisory_xact_lock(hashtext(topupCardLockKey(id)))`, tranzaksiya oxirigacha; bir tranzaksiyada ikki karta qulfi
  olinmaydi).

### `PaymentIntent` — P2P to‘ldirish so‘rovi

1-migratsiyadagi ustunlar (`provider`, `amountTiyin`, `status`, `purpose`, `quoteId`, `idempotencyKey`, `requestHash`,
`expiresAt`) o‘zgarmagan. P2P so‘rovda: `provider = P2P_CARD`, `purpose = 'TOPUP'`, `amountTiyin` = asosiy summa + noyob
qo‘shimcha (foydalanuvchi aynan shu summani o‘tkazadi), `expiresAt` — `TOPUP_INTENT_TTL_SEC` bo‘yicha (standart 30 daqiqa).

| Yangi ustun       | Tur                                   | Qoida                                                                            |
| ----------------- | ------------------------------------- | -------------------------------------------------------------------------------- |
| `cardId`          | `String?` → `TopupCard` (FK Restrict) | P2P'da majburiy                                                                  |
| `baseAmountTiyin` | `BigInt?`                             | so‘ralgan summa, qo‘shimchasiz; P2P'da majburiy; NULL yoki > 0                   |
| `paidAt`          | `DateTime?`                           | `PAID` ⇔ bor (hamma provayder)                                                   |
| `reservedUntil`   | `DateTime?`                           | summa kartada shu paytgacha band; P2P'da majburiy; grace yagona saqlanadigan joy |
| `payTokenHash`    | `String?` `@unique`                   | pay-link tokenining HMAC-SHA256 xeshi (D-39); `POST /pay-link` uni almashtiradi  |

**CHECK'lar:**

- `PaymentIntent_amount_check` (2-migratsiya): `amountTiyin` > 0.
- `PaymentIntent_p2p_check`: P2P'da `cardId`, `baseAmountTiyin`, `reservedUntil` NOT NULL; `amountTiyin % 100 = 0` (butun
  so‘m); `baseAmountTiyin % 100000 = 0` (1 000 so‘m karrali); `amountTiyin − baseAmountTiyin` ∈ [100; 99 900] tiyin
  (1..999 so‘m qo‘shimcha); `expiresAt > createdAt`; `reservedUntil >= expiresAt` — EXCLUDE oralig‘i doim to‘g‘ri (teskari
  oraliq PostgreSQL'da xato, bo‘sh oraliq emas).
- `PaymentIntent_base_positive_check` (m1): `baseAmountTiyin` NULL yoki > 0 (`% 100000 = 0` ni 0 ham qanoatlantirardi).
- `PaymentIntent_paid_check`: `PAID` ⇔ `paidAt`.
- `PaymentIntent_p2p_paid_check`: to‘langan P2P'da `reservedUntil >= paidAt`.

**Unique va EXCLUDE:**

- `PaymentIntent_card_amount_pending_key`: `UNIQUE (cardId, amountTiyin) WHERE status = 'PENDING'` (provayder filtri yo‘q;
  P2P bo‘lmagan so‘rovda `cardId` NULL, NULL'lar to‘qnashmaydi).
- `PaymentIntent_user_pending_p2p_key`: `UNIQUE (userId) WHERE status = 'PENDING' AND provider = 'P2P_CARD'` — foydalanuvchida
  bitta kutilayotgan P2P so‘rov.
- `PaymentIntent_card_amount_reserved_excl`: `EXCLUDE USING gist ("cardId" WITH =, "amountTiyin" WITH =,
tsrange("createdAt", "reservedUntil") WITH &&) WHERE ("provider" = 'P2P_CARD')`.
- `payTokenHash` unique; `(userId, idempotencyKey)` unique (oldindan).

**Band summa — `reservedUntil` (H1, security-auditor topilmasi).** Faqat `PENDING` ni unique qilish yetmaydi: to‘langan
(`PAID`) yoki muddati o‘tgan (`EXPIRED`/`CANCELLED`) so‘rovning summasi grace davomida (`TOPUP_LATE_GRACE_SEC`, standart
24 soat; productionda kamida 1 kun) shu kartada band turishi kerak, aks holda takroriy yoki kech to‘lov shu summani olgan
boshqa foydalanuvchiga yozilib ketadi. Bandlik muddati ustunda, hisob bir joyda:

| Holat                   | `reservedUntil`                                                               |
| ----------------------- | ----------------------------------------------------------------------------- |
| yaratilganda            | `expiresAt + grace` (`reservedUntilAtCreation`)                               |
| `PAID` bo‘lganda        | aynan `GREATEST(eski, paidAt + (eski − expiresAt))` (`reservedUntilWhenPaid`) |
| `CANCELLED` / `EXPIRED` | o‘zgarmaydi                                                                   |

- EXCLUDE holatdan qatʼi nazar ishlaydi; ajratuvchi (API) ham, moslovchi (worker) ham bandlikni `reservedUntil > now()`
  (yoki `>= tgDate`) bilan o‘qiydi — grace hisobi boshqa joyda takrorlanmaydi. Oraliq yarim ochiq `[)`: eskisi tugagan
  paytning o‘zida yaratilgan so‘rov ruxsat etiladi, 1 ms oldin — yo‘q.
- **Tip:** `reservedUntil` boshqa vaqt ustunlari kabi `timestamp(3)` (UTC, Prisma standarti), shuning uchun `tstzrange`
  emas `tsrange`. Bitta sxemada ikki xil vaqt turi aralashtirilmaydi.
- **Partial unique (`PENDING`) EXCLUDE bilan birga saqlandi:** poygani oddiy unique xatosi (`23505`, Prisma `P2002`) bilan
  qaytaradi, EXCLUDE esa `23P01` beradi. Ajratuvchi ikkalasini ham «poyga» deb qabul qilib boshqa qo‘shimchani sinaydi.
- **Kech to‘lov:** `PAID` ga o‘tganda `reservedUntil` uzayadi. Agar summa shu orada shu kartada yangi so‘rovga berilgan
  bo‘lsa, uzaytirish EXCLUDE bilan to‘qnashardi (`23P01`). Moslovchi buni yozishdan **oldin** tekshiradi va pul yozmay
  `AMBIGUOUS` review ochadi (`note = AMOUNT_REALLOCATED`); kutilmagan `23P01` xato sifatida ishlanadi.

**Indekslar.** `(cardId, reservedUntil, amountTiyin)`: ajratuvchining «kartaning band summalari» so‘rovi
(`cardId = ? AND reservedUntil > now()`, natija `amountTiyin`) faqat indeksdan o‘qiladi va oyna bilan cheklangani uchun
tarix o‘sganda ham kichik qoladi; moslovchi shu prefiksni (`reservedUntil >= tgDate`) ishlatadi, aniq summa qidiruvini
EXCLUDE'ning GiST indeksi ham qoplaydi. `(userId, reservedUntil)`: foydalanuvchining hali band so‘rovlarini sanash
(suiisteʼmolga qarshi limitlar). Kunlik so‘rovlar soni oldindan bor `(userId, createdAt)` bilan. Rejadagi
`(cardId, status, amountTiyin)` va `(cardId, status, paidAt)` indekslari qo‘shilmadi: holatga emas, muddatga qarab o‘qiladi.

**Trigger `PaymentIntent_p2p_guard`** (`ggpin_payment_intent_guard()`, `BEFORE UPDATE`, `GG001`; faqat eski yoki yangi
`provider = P2P_CARD` qatorlar, M5 → N1/N5 → Y5):

1. O‘zgarmas: `id, userId, provider, cardId, amountTiyin, baseAmountTiyin, createdAt, expiresAt`.
2. Holat grafi `intent-state.ts` bilan bir xil: `PENDING → PAID | EXPIRED | CANCELLED`, `EXPIRED → PAID`,
   `CANCELLED → PAID`, `PAID` yakuniy (test har juftni `intentTransitionRefusal` bilan solishtiradi). Trigger bilmaydigan
   ikki qoida `assertIntentTransition` da: grace (voqea vaqti kerak) va `CANCELLED → PAID` faqat audit qilingan admin
   (aktor kerak).
3. `PAID` ga o‘tishda: `paidAt` va `reservedUntil` NOT NULL; `paidAt` ∈ [`createdAt − 5 daqiqa`; UTC `now() + 5 daqiqa`];
   `reservedUntil` chekli va **aynan** `GREATEST(OLD.reservedUntil, NEW.paidAt + (OLD.reservedUntil − OLD.expiresAt))`.
   Trigger qiymatni yozmaydi, faqat boshqasini rad etadi: kalta qiymat hali qarz bo‘lgan summani bo‘shatadi, uzun yoki
   `infinity` summani kartada abadiy band qiladi. TS formulasi (`reservedUntilWhenPaid`) shu bilan bir xil (Y1;
   `payment-intent-guard.e2e.test.ts` triggerni shu funksiya natijasi bilan sinaydi).
4. Boshqa har UPDATE'da `reservedUntil` va `paidAt` o‘zgarmaydi (masalan `EXPIRED`/`CANCELLED` ga o‘tishda).
5. Trigger tekshirmaydigan ustunlar: `payTokenHash` (token almashadi), `updatedAt`, shuningdek `purpose`, `quoteId`,
   `idempotencyKey`, `requestHash`.

- **`paidAt` nima?** `docs/05` aniq aytmaydi (bank vaqti yoki yozish vaqti), shuning uchun oraliq ikkalasini qabul qiladi:
  bank vaqti daqiqagacha kesiladi va bank soati bizdan farq qiladi, yozish vaqti esa `now()` dan oshmaydi.
- **Muddati o‘tgani:** `expireOverdueTopups` (`@repo/db`) — `PENDING → EXPIRED`, sharti `expiresAt <= now`; `reservedUntil` ga
  tegmaydi va karta qulfini olmaydi. API har o‘qish/yozishdan oldin, worker `topup-expire` sweep'i har daqiqada chaqiradi.
- **Qoldirildi (keyingi provayder):** trigger faqat P2P qatorlarni qo‘riqlaydi; P2P bo‘lmagan so‘rovda `userId` o‘zgarishi
  hozircha to‘silmagan (Click/Payme qo‘shilganda o‘sha provayder qoidalari bilan birga).

### `Payment` — tasdiqlangan to‘lov

| O‘zgarish       | Qoida                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------- |
| `intentId`      | endi nullable: review'dan (so‘rovsiz) yozilgan to‘lovda yo‘q                                            |
| `userId`        | yangi, NOT NULL, FK → `User` (Restrict), indeks `(userId, createdAt)`; `User.payments` — teskari tomoni |
| `bankMessageId` | yangi, `@unique`, FK → `BankMessage`: P2P to‘lov qaysi bank xabaridan (P2P idempotentlik kaliti)        |
| `reviewId`      | yangi, `@unique`, FK → `PaymentReview`: egasi review'dan yozgan to‘lov                                  |
| `providerTxnId` | P2P'da `"<senderId>:<tgMessageId>"` (moslovchi ham, `review:credit` ham shu formatda)                   |

P2P to‘lovi darhol `CONFIRMED` (`confirmedAt` bilan) yoziladi; reversal (`payment:reverse`) `CONFIRMED → CANCELLED` va
`cancelledAt` ni yozadi.

- **CHECK:** `Payment_amount_check` (2-migratsiya, > 0); `Payment_source_check` (`intentId` yoki `reviewId` bor);
  `Payment_p2p_check` (P2P'da `bankMessageId` majburiy).
- **Unique:** `(provider, providerTxnId)`, `bankMessageId`, `reviewId`.
- **Trigger `Payment_consistency_guard`** (`ggpin_payment_consistency_guard()`, `BEFORE INSERT OR UPDATE OF intentId, userId,
provider, bankMessageId, amountTiyin`, `GG004`; m5 → N2 → Y3/Y5):
  - intent to‘lovi intent egasiniki (`intent.userId = userId`) va intent provayderiga ega (`intent.provider = provider`;
    Click to‘lovi `P2P_CARD` so‘roviga yoki aksincha — yo‘q);
  - `P2P_CARD` to‘lovi — `PARSED` `CREDIT` bank xabari, summasi xabar summasiga aynan teng (N8: `UNRECOGNIZED`/`REJECTED`
    xabar `review:credit` bilan pulga aylanmaydi, bunday pul faqat `wallet:adjust` orqali);
  - so‘rovli P2P to‘lov — so‘rovning kartasi va summasi: `intent.cardId = xabar.cardId` (xabarda karta NULL bo‘lsa mos
    kelmaydi) va `intent.amountTiyin = xabar summasi`. Shuning uchun `review:credit --intent` faqat aynan moslikda ishlaydi,
    qolgan hamma holatda `--user` (so‘rovsiz, `reviewId` bilan).
  - **Og‘ish:** kompozit FK `(intentId, userId)` o‘rniga trigger — Prisma qisman nullable kompozit relation'ni modellay
    olmaydi, xom FK esa har `migrate dev` da drift bo‘lib ko‘rinardi.
- **Trigger `Payment_immutable_guard`** (`ggpin_payment_immutable_guard()`, `BEFORE UPDATE`, `GG001`, Y2): `intentId, userId,
provider, providerTxnId, amountTiyin, bankMessageId, reviewId` INSERT'dan keyin o‘zgarmaydi (aks holda
  `TOPUP PAYMENT/<id>` yozuvi uni asoslovchi qatordan ajralib qolardi). O‘zgaruvchan: `status`, `confirmedAt`,
  `cancelledAt`, `raw`, `updatedAt`.

### `BankMessage` — bank bot xabari

Append-only (`updatedAt` yo‘q). **Xom matn bu yerda yo‘q** — faqat `textSha256` (L9); matn `BankMessageText` da.

| Ustun                     | Tur                     | Izoh                                                                                                                                                          |
| ------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `source`                  | `BankFeedSource`        | qaysi bank boti                                                                                                                                               |
| `senderId`, `tgMessageId` | `BigInt`                | Telegram jo‘natuvchi va xabar id; juftligi unique                                                                                                             |
| `tgDate`                  | `DateTime`              | Telegram'dagi xabar vaqti                                                                                                                                     |
| `textSha256`              | `String`                | xom matn xeshi                                                                                                                                                |
| `parseStatus`             | `BankParseStatus`       |                                                                                                                                                               |
| `rejectReason`            | `String?`               | faqat kod: `PARSE_FAILURE_REASONS` yoki `INGEST_REJECT_REASONS` (`packages/shared/src/payments/bank-parse.ts`); matn bo‘lagi, summa, karta raqami hech qachon |
| `parserVersion`           | `Int`                   |                                                                                                                                                               |
| `direction`               | `BankDirection?`        |                                                                                                                                                               |
| `amountTiyin`             | `BigInt?`               | `PARSED` da > 0                                                                                                                                               |
| `balanceAfterTiyin`       | `BigInt?`               | balans zanjiri uchun                                                                                                                                          |
| `last4`                   | `String?`               | `PARSED` da 4 raqam                                                                                                                                           |
| `cardId`                  | `String?` → `TopupCard` | qabul paytida yoziladi; NULL — karta nomaʼlum (`CARD_UNKNOWN`)                                                                                                |
| `bankTxnAt`               | `DateTime?`             | bank chop etgan amal vaqti                                                                                                                                    |
| `channel`                 | `String?`               | to‘lov kanali satri                                                                                                                                           |

- **CHECK:** `BankMessage_parsed_check` (`PARSED` da `direction`, `amountTiyin` > 0, `balanceAfterTiyin`, `last4 ~ '^[0-9]{4}$'`,
  `bankTxnAt` majburiy); `BankMessage_reason_check` (`PARSED` bo‘lmasa `rejectReason` bo‘sh emas, `UNRECOGNIZED` ham).
- **Unique:** `(senderId, tgMessageId)` — qayta o‘qilgan xabar ikki marta saqlanmaydi.
- **Indekslar:** `(cardId, tgMessageId)` — balans zanjiri; `(cardId, tgDate)` — karta sig‘imi (`cardTotals`: karta bo‘yicha
  `PARSED CREDIT` yig‘indisi `verifiedAt` dan va oy boshidan; API taqsimlovchisi, karta buyruqlari, notify renderer va
  worker — 80% alert, `ACTIVE → FULL`, kech limit oshishi — shu bitta so‘rovni ishlatadi; 7-migratsiya, D-42, D-43);
  `(createdAt)`.
- **Trigger `BankMessage_append_only`** (`ggpin_forbid_mutation()`, `BEFORE UPDATE OR DELETE`, `GG001`).
- **Trigger `BankMessage_card_guard`** (`ggpin_bank_message_card_guard()`, `BEFORE INSERT`, `GG003`; M2 → N3/N9 → Y4).
  Listener `cardId` ni xabarni INSERT qiladigan tranzaksiyada yozadi (`docs/05` §6.3); `BankMessage` append-only, noto‘g‘ri
  `cardId` tuzatilmaydi va boshqa kartaning balans zanjirini buzardi. Qoidalar: `cardId = NULL` doim mumkin; karta banki
  manbaga mos (`HUMO_BOT → HUMO`, `UZCARD_BOT → UZCARD`); `card.last4 = last4` (`last4` siz xabarga karta yozilmaydi);
  `RETIRED` karta faqat shu `(bank, last4)` da tirik karta bo‘lmasa va u `(retiredAt, id)` bo‘yicha eng oxirgi `RETIRED`
  bo‘lsa. Bank `CardBank` enum tipida solishtiriladi (`::text` emas), shuning uchun `(bank, last4)` indekslari ishlaydi.
  Mavjud bo‘lmagan karta — FK xatosi.

### `BankMessageText` — xom matn (E-25: 1 yil)

`bankMessageId` (PK + FK → `BankMessage`), `text String?`, `purgeAfter`, `createdAt`; `updatedAt` yo‘q; indeks `purgeAfter`.
`BankMessage` append-only bo‘lgani uchun matn alohida jadvalda — muddati o‘tgach o‘chiriladi. Listener
`purgeAfter = qabul vaqti + 365 kun` yozadi. Bank botining so‘zi bo‘lmagan xabar (`FOREIGN_CHAT`, `FOREIGN_SENDER`,
`NOT_BOT`) uchun qator umuman yaratilmaydi — faqat `textSha256` qoladi.

- **Trigger `BankMessageText_guard`** (`ggpin_bank_message_text_guard()`, `BEFORE UPDATE OR DELETE`, `GG001`): yagona ruxsat —
  `text` NULL bo‘lmagan qatorda uni NULL qilish, `timezone('UTC', now()) >= purgeAfter` bo‘lganda va qolgan ustunlar
  o‘zgarmagan holda. `purgeAfter` UTC `timestamp` (Prisma), shuning uchun `now()` avval UTC'ga o‘tkaziladi; aks holda
  solishtirish seans vaqt mintaqasiga bog‘liq bo‘lardi. Boshqa har UPDATE (matnni qayta yozish, NULL'dan tiklash,
  `purgeAfter` ni surish) va har DELETE rad etiladi.
- Tozalash so‘rovi trigger ruxsat beradigan shaklda bo‘lishi kerak:
  `UPDATE "BankMessageText" SET "text" = NULL WHERE "purgeAfter" <= timezone('UTC', now()) AND "text" IS NOT NULL`.
  Worker'ning kunlik `bank-text-purge` jobi (03:30 Asia/Tashkent, `payment-reconcile` navbati) aynan shu shaklda, 1000 talik partiyalarda
  (`ORDER BY "purgeAfter" LIMIT … FOR UPDATE SKIP LOCKED`) faqat `text = NULL` qiladi; orqada qolsa kunlik solishtirish `purgeOverdue` beradi.

### `BankMessageOutcome` — xabarni qayta ishlash natijasi

`bankMessageId` (`@unique`, FK), `chainStatus ChainStatus`, `outcome BankOutcome`, `paymentId` (`@unique`, FK → `Payment`),
`reviewId` (FK → `PaymentReview`, indeks N7, unique emas), `createdAt`. Bir xabar — bitta natija; bir to‘lov — bitta natija.

- **CHECK:** `BankMessageOutcome_payment_check` (`CREDITED` ⇔ `paymentId`); `BankMessageOutcome_review_check`
  (`REVIEW` ⇒ `reviewId`) (m2).
- **Trigger `BankMessageOutcome_append_only`** (`ggpin_forbid_mutation()`, `GG001`): bir marta yoziladi.
- **Trigger `BankMessageOutcome_links_guard`** (`BEFORE INSERT`, `GG005`, N4): `paymentId` nomlagan `Payment.bankMessageId` va
  `reviewId` nomlagan `PaymentReview.bankMessageId` outcome'ning o‘z `bankMessageId` siga teng. Mavjud bo‘lmagan qator FK'ga
  qoldiriladi.

### `PaymentReview` — egasi tekshiradigan navbat

| Ustun                | Tur                        | Qoida                                                                                      |
| -------------------- | -------------------------- | ------------------------------------------------------------------------------------------ |
| `kind`               | `PaymentReviewKind`        | o‘zgarmas                                                                                  |
| `status`             | `PaymentReviewStatus`      | standart `OPEN`                                                                            |
| `bankMessageId`      | `String` → `BankMessage`   | **NOT NULL** (m4: har tur bank xabarini qayta ishlashdan chiqadi, `docs/05` §6); o‘zgarmas |
| `cardId`, `intentId` | `String?` (FK)             | ko‘rsatma; o‘zgaruvchan                                                                    |
| `resolution`         | `PaymentReviewResolution?` | `RESOLVED` ⇔ bor                                                                           |
| `resolvedAt`         | `DateTime?`                | `RESOLVED` ⇔ bor                                                                           |
| `resolvedAuditLogId` | `String?` → `AuditLog`     | `RESOLVED` ⇔ bor (m3): egasi qarorining audit qatori                                       |
| `note`               | `String?`                  | kod, `REVIEW_NOTE_CODES` (`bank-parse.ts`) dan                                             |

- **Unique:** `(bankMessageId, kind)` — to‘liq idempotentlik kaliti (xabarsiz review turi yo‘q).
- **Indekslar:** `(status, createdAt)`, `cardId`, `intentId`, `resolvedAuditLogId` (N7).
- **CHECK:** `PaymentReview_resolved_check` (`RESOLVED` ⇔ `resolution` **va** `resolvedAt`; `OPEN` da ikkalasi yo‘q);
  `PaymentReview_audit_check` (`RESOLVED` ⇔ `resolvedAuditLogId`).
- **Trigger `PaymentReview_immutable_guard`** (`BEFORE UPDATE`, `GG001`, Y2): `bankMessageId` va `kind` o‘zgarmaydi.
  Holat, hal qilish maydonlari, `cardId`/`intentId`, `note` o‘zgaruvchan.
- `note` kodlari: `TITLE_UNKNOWN`, `REPARSE_MISMATCH`, `TEXT_MISSING`, `PREDECESSOR_PENDING`, `DAILY_LIMIT`,
  `NEW_ACCOUNT_DAILY_LIMIT`, `AMOUNT_REALLOCATED`, `SENDER_MISMATCH`, `TEXT_HASH_MISMATCH`, `PROCESSING_FAILED`, `LATE_STORED`,
  `MANUAL_CREDIT_SEEN` (oxirgi ikkisi `AMBIGUOUS` turi bilan, D-47).
- Yechim va audit amali: `CREDITED_USER` ← `REVIEW_CREDIT`, `IGNORED` ← `REVIEW_IGNORE`, `RETURNED_OFFLINE` ←
  `REVIEW_RETURNED_OFFLINE`, `CHAIN_ACCEPTED` ← `REVIEW_ACCEPT_CHAIN`.

### `BankFeedCursor`

`source BankFeedSource` (PK), `lastMessageId BigInt`, `createdAt`, `updatedAt`. Har manba uchun oxirgi saqlangan xabar id;
listener so‘rovi shu yerdan davom etadi. Xabar bilan bitta tranzaksiyada `INSERT … ON CONFLICT DO UPDATE SET lastMessageId =
GREATEST(eski, yangi)` bilan yoziladi: tarixni qayta ko‘rish kursorni orqaga surmaydi (DB'da trigger emas, yozuvchida).
Kursor umuman yo‘q bo‘lsa (birinchi start), tinglovchi chatning eng oxirgi xabar id’sini bitta chaqiruv bilan olib shu yerga yozadi
va undan keyingilarni o‘qiydi; eskilari kunlik qayta skanga qoladi (D-52, M2).

### `BankFeedAccount` (D-52, migratsiya `20261109165317_p4_bank_feed_account`)

`id` (cuid), `slot Int @unique @default(1)` (CHECK `slot = 1` — ko‘pi bilan bitta qator), `telegramUserId BigInt` (CHECK `> 0`),
`createdAt`; `updatedAt` yo‘q (o‘zgarmaydi). Bank-feed sessiyasi tegishli Telegram akkaunti: birinchi startda `getMe` id’si
yoziladi. Keyingi startda id farq qilsa tinglovchi lider bo‘lmaydi, heartbeat yozmaydi va `listenerStopped`
(`ACCOUNT_MISMATCH`) alerti ketadi (fail-closed). Akkaunt almashtirish hozircha qo‘llab-quvvatlanmaydi (alohida bo‘lak).

### `BankFeedAuthorization` (D-52)

`id` (cuid), `hash String @unique` (Telegram avtorizatsiya hash’ining ishorasiz o‘nlik yozuvi, CHECK faqat raqam), `appName?`,
`deviceModel?` (CHECK ≤ 128 belgi), `authCreatedAt?` (Telegram `date_created`), `createdAt` (birinchi ko‘rilgan vaqt);
`updatedAt` yo‘q (faqat qo‘shiladi). Ishchi akkauntning ma’lum sessiyalari: jadvalda yo‘q hash — yangi qurilma, BARCHA
kartalarda avtomatik yozish to‘xtaydi. Jadval bo‘sh bo‘lsa ham hammasi to‘xtaydi (`authorizationsBaseline`, jim asos yo‘q).
IP, mamlakat va hudud hech qachon saqlanmaydi. Avval Redis `bankfeed:authorizations` edi; undan voz kechildi (Redis
tozalansa asos jimgina qayta yozilardi).

### Hamyon: `User`, `Wallet`, `LedgerEntry`, `AuditLog` (DDL o‘zgarmagan)

4-faza bu jadvallarga ustun qo‘shmadi; quyidagilar 1–2-migratsiyalardan bor va endi ishlatiladi:

- **`LedgerEntry`:** `TOPUP` (+) — `PAYMENT/<Payment.id>`; `TOPUP_REVERSAL` (−) — `PAYMENT/<Payment.id>` (reversal ham shu
  to‘lovga, shuning uchun bir to‘lovga bitta reversal); `ADJUSTMENT` (±) — `ADMIN_ACTION/<AuditLog.id>`. `refType` ga DB
  CHECK yo‘q: qiymatlar `LEDGER_REF_TYPES` (`@repo/db`) bilan TS'da cheklanadi.
- **`User.purchaseFrozen`:** reversaldan keyin balans manfiy bo‘lsa `true` qilinadi (`false → true` o‘tishi alert beradi);
  faqat egasi `user:unfreeze` bilan tushiradi (D-41).
- **`Wallet`:** qator foydalanuvchi yaratilganda (`createMany … skipDuplicates`) qo‘shiladi; har pul harakati
  `lockWallet` (`SELECT … FOR UPDATE`) ostida.
- **`AuditLog`** (append-only). `actorType` matn ustun (sxema izohida `ADMIN | SYSTEM`), 4-fazada yangi qiymat — `CLI`
  (ega CLI'si) — DDL yo‘q. CLI qatori: `actorType = 'CLI'`, `actorId = NULL`, operator `after.operator` da (OS login —
  `after.osUser`), `reason` majburiy.

  | `action`                                                                                      | `targetType`          | Kim               |
  | --------------------------------------------------------------------------------------------- | --------------------- | ----------------- |
  | `CARD_ADD`, `CARD_LIMIT`, `CARD_PAUSE`, `CARD_RESUME`, `CARD_RETIRE`, `CARD_RETIRE_EMERGENCY` | `TopupCard`           | CLI               |
  | `REVIEW_CREDIT`, `REVIEW_IGNORE`, `REVIEW_RETURNED_OFFLINE`, `REVIEW_ACCEPT_CHAIN`            | `PaymentReview`       | CLI               |
  | `WALLET_ADJUST`, `USER_UNFREEZE`                                                              | `User`                | CLI               |
  | `PAYMENT_REVERSE`                                                                             | `Payment`             | CLI               |
  | `PAYMENT_RECONCILE` (`targetId` = Toshkent kuni `yyyymmdd`)                                   | `PaymentReconcileDay` | `SYSTEM` (worker) |
  | `CARD_RETIRE_DRAINED` (DRAINING → RETIRED, `reason = RESERVATIONS_ENDED`)                     | `TopupCard`           | `SYSTEM` (worker) |

### `@repo/db` yordamchilari

Pul va karta qoidalari bitta joyda — API va worker bir xil so‘rovni ishlatadi:

- `packages/db/src/ledger/`: `lockWallet(tx, userId)` (`Wallet` qatorida `FOR UPDATE`; qator yo‘q — `WalletNotFoundError`),
  `appendLedgerEntry(tx, entry)` (takror `(refType, refId, kind)` → `P2002`, noto‘g‘ri ishora → `LedgerEntry_amount_sign_check`),
  `sumBalance(tx, userId)` (`0n` agar yozuv yo‘q). **M1:** `lockWallet` va `appendLedgerEntry` ildiz klient kelsa
  `NotInTransactionError` tashlaydi. Farqlovchi belgi — `'$connect' in tx` (Prisma 7.10.1 tranzaksiya klientida
  `$connect, $disconnect, $on, $use, $extends` yo‘q; `$transaction` esa ish vaqtida bor, shuning uchun u yaramaydi). Ikkala
  fakt `ledger.e2e.test.ts` da; Prisma yangilansa test yiqiladi. `sumBalance` ildiz klientni ham qabul qiladi.
- `packages/db/src/payments/`: `lockTopupCard` (karta advisory qulfi, faqat tranzaksiyada), `cardTotals` (karta sig‘imi,
  D-42 (1)), `expireOverdueTopups`, `usedTopupBaseSince` (kunlik limit uchun asosiy summalar: `PAID` — `paidAt` bo‘yicha,
  `PENDING` — `createdAt` bo‘yicha), `manualCreditsSince` / `hasManualCredit` (D-47 R1: musbat `ADJUSTMENT` va `reviewId` li
  to‘lovlarning `TOPUP` yozuvlari), `AUTO_CREDIT_HORIZON_MS` (7 kun).

### Isbot

`packages/db/test/*.e2e.test.ts`: `check-constraints-topup-card`, `check-constraints-intent` (CHECK matritsalari, partial
unique'lar; m9: `PENDING` unique yolg‘iz o‘zi `P2002` beradi), `payment-intent-guard` (har ruxsat va rad, Y1 formulasi),
`payment-reservation` (H1, parallel INSERT'lar), `bank-message` (`BankMessage`, matn tozalash, karta qo‘riqchisi), `payment-review`
(review va outcome), `payment-consistency` (m5, N2, Y3, bir xabarga parallel to‘lov, `GG002` qo‘riqchisi),
`payment-immutables` (Y2), `ledger` (qulf, M1, 2^53 dan katta summa), `schema` (haqiqiy `pg_enum`); unit:
`src/payments-enums.test.ts`, `src/schema.test.ts`, `src/payments/card-lock.test.ts`.

## Seed (boshlang‘ich ma’lumotlar)

`npm run db:seed` → `packages/db`: `tsc -p tsconfig.seed.json` (`dist/seed` ga) → `prisma db seed`
(`prisma.config.ts` → `migrations.seed`). Kod: `packages/db/prisma/seed.ts` va `prisma/seed/`.

- **Yaratadi:** kategoriya `telegram`; `telegram-stars` (`TG_USERNAME`, erkin miqdor 50..100000, SKU 50/100/250/500/1000/2500)
  va `telegram-premium` (SKU 3/6/12 oy); `ProductRoute`: Stars uchun `FRAGMENT` (1, yoqilgan) va `RESELLER_STARS` (2, o‘chirilgan),
  Premium uchun `FRAGMENT` (1, yoqilgan). `markupBps` 1000, `minMarginTiyin` 0 — vaqtincha qiymat (Q8), egasi belgilaydi.
  `inputSchema` yozishdan oldin `ProductInputSchema` bilan tekshiriladi; `label` kalitlari `packages/i18n` da (`fields.tgUsername`).
- **Faqat yaratadi:** mavjud qator hech qachon qayta yozilmaydi (SKU `productId + quantity + tab` bo‘yicha topiladi), shuning uchun
  qayta ishga tushirish xavfsiz va admin kiritgan o‘zgarishni bosib ketmaydi. Bir vaqtda ikki seed advisory lock bilan ketma-ket bajariladi.
- **Faollashtirish (fail-closed):** mahsulotlar `isActive=true` bilan faqat `NODE_ENV` aniq `development` yoki `test` bo‘lsa
  yaratiladi. `production`, o‘rnatilmagan `NODE_ENV` yoki boshqa har qanday qiymat (masalan `prod`, `staging`) bo‘lsa — `isActive=false`
  (egasi admin'dan yoqadi); log qatori buni va faol demo mahsulot olish yo‘lini aytadi: `NODE_ENV=development npm run db:seed`.
  Qaror `prisma/seed/activation.ts` dagi `shouldActivateProducts` da; unit-test: `packages/db/src/seed-activation.test.ts`.
- Isbot: `packages/db/test/seed.e2e.test.ts`.

## Nima qayerda hisoblanadi

| Ko‘rsatkich              | Qayerda                                                                          |
| ------------------------ | -------------------------------------------------------------------------------- |
| Balans                   | `SUM(LedgerEntry.amountTiyin) WHERE userId` + Redis kesh                         |
| Keshbek tangalari        | `SUM(CoinEntry.coins)`                                                           |
| Referal daromadi         | `SUM(LedgerEntry WHERE kind=REFERRAL_BONUS)`                                     |
| Buyurtma foydasi (admin) | `priceTiyin − discountTiyin − costMinor × fx` (buyurtmadagi snapshot bilan)      |
| Hot wallet balansi       | worker, zanjirdan + `WalletSnapshot`                                             |
| Karta sig‘imi (P2P)      | `cardTotals` (`@repo/db`): `PARSED CREDIT` xabarlar + band to‘lanmagan so‘rovlar |
| Kunlik to‘ldirish limiti | `usedTopupBaseSince` (`@repo/db`): `baseAmountTiyin` yig‘indisi                  |
| Qo‘lda berilgan pul      | `manualCreditsSince` (`@repo/db`): musbat `ADJUSTMENT` + review `TOPUP`          |
