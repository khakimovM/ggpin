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
> `20261105200000_p4_wallet_p2p_immutables` ("Migratsiya 9"). Bu hujjat sxemani tushuntiradi, nusxasini
> saqlamaydi: ikkalasi farq qilsa, to‘g‘ri bo‘lgani — `schema.prisma`. Sxema o‘zgarsa shu fayl
> ham o‘sha o‘zgarishda yangilanadi.

## Asosiy qoidalar

- Pul: `BigInt`, birligi ustun nomida (`Tiyin`, `MicroUsdt`, `NanoTon`, `Minor`). `Decimal`/`Float` yo‘q.
- Balans saqlanmaydi: `LedgerEntry` yig‘indisi. `Wallet` jadvali faqat **qulf** (row lock) uchun.
- Idempotentlik — unique indekslar orqali (quyidagi jadval).
- `Order.status` faqat `order-state.ts` orqali o‘zgaradi; `OrderStatus` enum `ORDER_STATUSES` bilan
  bir xil (DB testi tekshiradi).
- id — `cuid(2)`; jadval nomlari model nomlari bilan bir xil (`"Wallet"`, `"LedgerEntry"`).

## Modellar (36 ta model, 21 ta enum)

| Guruh         | Modellar                                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------ |
| Foydalanuvchi | `User`, `Wallet`                                                                                       |
| Hamyon        | `LedgerEntry` (so‘m), `CoinEntry` (keshbek tangalari)                                                  |
| Katalog       | `Category`, `Product`, `Sku`, `ProductRoute`, `Voucher`                                                |
| Narx          | `FxRate`, `CostSnapshot`, `Quote`                                                                      |
| Buyurtma      | `Order`, `OrderEvent`, `FulfillmentAttempt`                                                            |
| To‘lov        | `PaymentIntent`, `Payment`                                                                             |
| P2P karta     | `TopupCard`, `BankMessage`, `BankMessageText`, `BankMessageOutcome`, `PaymentReview`, `BankFeedCursor` |
| Promo         | `BonusCode`, `BonusRedemption`, `DiscountTier`, `DiscountCode`                                         |
| Fragment      | `FragmentSession`, `WalletSnapshot`                                                                    |
| Auth / admin  | `WebSession`, `LoginRequest`, `AdminUser`, `AdminSession`, `AuditLog`, `Broadcast`, `Setting`          |

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
   `WebSession`, `LoginRequest`, `AdminUser`, `AdminSession`, `Broadcast`.
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

## Migratsiya 9: `20261104130000_p4_wallet_p2p`, `…130100_p4_wallet_p2p_checks`, `…130200_p4_review_kind_daily_limit`, `20261105090000_p4_wallet_p2p_hardening`, `20261105160000_p4_wallet_p2p_guards`, `20261105200000_p4_wallet_p2p_immutables`

4-faza (hamyon va P2P karta orqali to‘ldirish, D-37). Dastlab ikki fayl (uchinchisi — enum qiymatini qayta nomlash, to‘rtinchisi — S2 code-review tuzatishlari, pastda «Review tuzatishlari»): PostgreSQL `ALTER TYPE … ADD VALUE` bilan qo‘shilgan
qiymatni o‘sha tranzaksiyada ishlata olmaydi, shuning uchun enum/jadval/ustunlar birinchi, `P2P_CARD` ni ishlatadigan CHECK,
partial unique, EXCLUDE va triggerlar ikkinchi migratsiyada. Faqat qo‘shimcha; ikki yumshatish: `Payment.intentId` endi
nullable, `Payment.userId` yangi va NOT NULL. Birinchi migratsiya boshidagi `DO` qo‘riqchisi `Payment` bo‘sh bo‘lmasa
`RAISE EXCEPTION` (SQLSTATE `GG002`) bilan to‘xtaydi (egasini taxmin qilmaydi). Dev va test bazada `Payment` 0 qator edi.

**Yangi enum'lar (10):** `CardBank`, `TopupCardStatus` (`VERIFYING ACTIVE DRAINING FULL RETIRED`), `BankFeedSource`,
`BankParseStatus`, `BankDirection`, `ChainStatus`, `BankOutcome`, `PaymentReviewKind` (10 asosiy tur + `CANCELLED_LATE`,
`DAILY_LIMIT`, `POSSIBLE_REVERSAL`, `USER_BLOCKED`), `PaymentReviewStatus`, `PaymentReviewResolution`;
`DAILY_LIMIT` bitta tur bilan ikkala kunlik chekni qamraydi (yangi akkaunt va barcha akkauntlar), qaysi chek oshgani
review'ning `note` maydonida yoziladi. Qiymat birinchi migratsiyada `NEW_ACCOUNT_LIMIT` deb yaratilgan edi; u qo‘llanib
bo‘lgani uchun tahrirlanmadi, uchinchi migratsiya (`ALTER TYPE … RENAME VALUE`) uni qayta nomladi;
`PaymentProviderCode` ga `P2P_CARD`. Hammasi `packages/shared/src/payments/bank-feed.ts` ro‘yxatlari bilan bir xil;
`packages/db/src/payments-enums.test.ts` to‘plam tengligini tekshiradi (tartib ahamiyatsiz).

**Yangi modellar (6):**

- `TopupCard` — o‘zgaruvchan (`updatedAt` bor). `bank`, `pan`, `last4`, `holderName` INSERT'dan keyin o‘zgarmaydi
  (`BEFORE UPDATE` trigger, `GG001`; L6): xabar kartaga moslangan, ochiq so‘rov va pay sahifasi shularga tayanadi; karta
  almashsa eskisi `RETIRED` qilinib yangisi qo‘shiladi. Holat, limitlar, pauza o‘zgara oladi. `DRAINING` — yangi so‘rov
  berilmaydi, mavjudlari `reservedUntil` gacha avtomatik yoziladi (oddiy `card:retire` shu holatdan o‘tadi).
- `BankMessage` — append-only (`ggpin_forbid_mutation()`, `GG001`), `updatedAt` yo‘q. **Xom matn bu yerda yo‘q:** faqat
  `textSha256` qoladi (L9).
- `BankMessageText` — xom matn alohida (`bankMessageId` PK+FK, `text` nullable, `purgeAfter`, `createdAt`; `updatedAt` yo‘q).
  E-25: matn 1 yil saqlanadi, `BankMessage` esa append-only, shuning uchun matn alohida jadvalda. Trigger faqat bitta
  o‘zgarishga ruxsat beradi: `timezone('UTC', now()) >= purgeAfter` bo‘lganda `text` ni NULL qilish (qolgan ustunlar o‘zgarmagan holda;
  `purgeAfter` Prisma'ning UTC `timestamp`'i, shuning uchun `now()` avval UTC'ga o‘tkaziladi).
  Boshqa har qanday UPDATE (matnni qayta yozish, NULL'dan tiklash, `purgeAfter` ni surish) va har qanday DELETE → `GG001`.
  Tozalovchi (worker sweep): `UPDATE "BankMessageText" SET "text" = NULL WHERE "purgeAfter" <= timezone('UTC', now()) AND "text" IS NOT NULL`;
  `purgeAfter` indeksli. `now()` ni UTC'ga o‘tkazmasdan solishtirish seans vaqt mintaqasiga bog‘liq bo‘lib qoladi.
- `BankMessageOutcome` — bir marta yoziladi (`UPDATE`/`DELETE` → `GG001`), `bankMessageId` va `paymentId` unique.
  `paymentId` → `Payment` va `reviewId` → `PaymentReview` FK (Restrict); `CREDITED` ⇔ `paymentId` bor, `REVIEW` ⇒ `reviewId` bor (CHECK).
- `PaymentReview` — tekshiruv navbati; `bankMessageId` **NOT NULL** (har tur bank xabarini qayta ishlashdan chiqadi, `docs/05` §6; shuning
  uchun `(bankMessageId, kind)` unique to‘liq idempotentlik kaliti), `PaymentReview_resolved_check`: `RESOLVED` ⇔ `resolution` **va** `resolvedAt`
  bor (OPEN'da ikkalasi yo‘q); `PaymentReview_audit_check`: `RESOLVED` ⇔ `resolvedAuditLogId` bor (FK → `AuditLog`, Restrict).
- `BankFeedCursor` — har manba uchun oxirgi saqlangan xabar id (`source` PK).

**Mavjud jadvallarga qo‘shimchalar:**

- `PaymentIntent`: `cardId` (FK Restrict), `baseAmountTiyin`, `paidAt`, `reservedUntil`, `payTokenHash` (unique, HMAC xeshi).
- `Payment`: `userId` (FK Restrict, NOT NULL, indeksli `(userId, createdAt)`), `intentId` nullable, `bankMessageId` (unique, FK),
  `reviewId` (unique, FK). `providerTxnId` P2P'da `"<senderId>:<tgMessageId>"`.
- `User.payments`. `AuditLog.actorType` matn ustun: yangi qiymat `CLI` (ega CLI'si) — DDL yo‘q.

**Band summa — `reservedUntil` (H1, security-auditor topilmasi).** Muammo: dastlabki reja faqat `PENDING` ni
unique qilgan edi. Lekin to‘langan (`PAID`) yoki muddati o‘tgan (`EXPIRED`/`CANCELLED`) so‘rovning summasi grace davomida
(`TOPUP_LATE_GRACE_SEC`, 24 soat) shu kartada band turishi kerak: aks holda foydalanuvchining takroriy yoki kech to‘lovi
xuddi shu summani olgan boshqa foydalanuvchiga yozilib ketadi. Yechim — bandlik muddati ustunda, hisob bir joyda:

| Holat                   | `reservedUntil`                                                          |
| ----------------------- | ------------------------------------------------------------------------ |
| yaratilganda            | `expiresAt + grace`                                                      |
| `PAID` bo‘lganda        | aynan `GREATEST(eski, paidAt + (eski − expiresAt))` (trigger tekshiradi) |
| `CANCELLED` / `EXPIRED` | o‘zgarmaydi                                                              |

- `PaymentIntent_card_amount_reserved_excl`: `EXCLUDE USING gist ("cardId" WITH =, "amountTiyin" WITH =,
tsrange("createdAt","reservedUntil") WITH &&) WHERE ("provider" = 'P2P_CARD')` (`btree_gist` kengaytmasi, trusted).
  Oraliq yarim ochiq `[)`: eskisi tugagan paytning o‘zida yaratilgan so‘rov ruxsat etiladi, 1 ms oldin — yo‘q.
  Holatdan qat'i nazar ishlaydi, shuning uchun ajratuvchi (S4) ham, mos qiluvchi (S6) ham bandlikni `reservedUntil > now()`
  (yoki `>= tgDate`) bilan o‘qiydi — grace hisobi boshqa joyda takrorlanmaydi.
- **Tip:** `reservedUntil` boshqa hamma vaqt ustunlari kabi `timestamp(3)` (UTC, Prisma standarti), `timestamptz` emas; shuning
  uchun `tstzrange` emas `tsrange`. Bitta sxemada ikki xil vaqt turi aralashtirilmaydi (`createdAt` ham `timestamp(3)`).
- **Partial unique (`PENDING`) saqlandi** — ortiqcha ko‘rinsa ham, chunki poygani oddiy unique xatosi (`23505`, Prisma
  `P2002`) sifatida qaytaradi; EXCLUDE esa `23P01` beradi. S4 ajratuvchisi ikkalasini ham "poyga" deb qabul qilib boshqa
  qo‘shimchani sinaydi. Foydalanuvchi uchun `UNIQUE ("userId") WHERE status='PENDING' AND provider='P2P_CARD'` o‘z kuchida.
- **Muhim oqibat (S6 uchun):** kech to‘lov `PAID` ga o‘tkazilib `reservedUntil` uzaytirilganda, agar o‘sha oralig‘ida boshqa so‘rov
  allaqachon shu summani olgan bo‘lsa (ishchi kechikib, eski oyna tugagan), UPDATE EXCLUDE bilan rad etiladi (`23P01`).
  Moslovchi buni tutib review'ga o‘tkazadi, pul yozilmaydi.
- CHECK'lar: `PaymentIntent_p2p_check` (P2P'da `cardId`, `baseAmountTiyin`, `reservedUntil` majburiy; `amountTiyin % 100 = 0`,
  `baseAmountTiyin % 100000 = 0`, qo‘shimcha 100..99 900 tiyin; `expiresAt > createdAt`, `reservedUntil >= expiresAt` — EXCLUDE
  oralig‘i har doim to‘g‘ri), `PaymentIntent_paid_check` (`PAID` ⇔ `paidAt`), `PaymentIntent_p2p_paid_check` (to‘langan P2P'da
  `reservedUntil >= paidAt`).

**Indekslar (`PaymentIntent`).** `(cardId, reservedUntil, amountTiyin)`: ajratuvchi "kartaning band summalari" so‘rovini
(`cardId = ? AND reservedUntil > now()`, natija `amountTiyin`) faqat indeksdan o‘qiydi, va oyna bilan cheklangani uchun
tarix o‘sganda ham kichik qoladi; mos qiluvchi shu prefiksni (`reservedUntil >= tgDate`) ishlatadi, aniq summa bo‘yicha
qidiruvni esa EXCLUDE'ning GiST indeksi ham qoplaydi. `(userId, reservedUntil)`: S4 da foydalanuvchining hali band
so‘rovlarini (kutilayotgan + grace ichidagi tugaganlar) sanash; kunlik so‘rovlar soni mavjud `(userId, createdAt)` bilan.
Reja bo‘yicha dastlabki `(cardId, status, amountTiyin)` va `(cardId, status, paidAt)` indekslari `reservedUntil` kelgach
keraksiz bo‘ldi va qo‘shilmadi: holatga qarab emas, muddatga qarab o‘qiladi.

**Boshqa CHECK va unique'lar** (hammasi NULL-xavfsiz): `TopupCard_values_check` (pan 16 raqam, `last4 = right(pan,4)`,
limitlar > 0, ism bo‘sh emas), `TopupCard_retired_check` (`RETIRED` ⇔ `retiredAt`), `TopupCard_bank_last4_active_key`,
`Payment_source_check` (intent yoki review kerak), `Payment_p2p_check` (P2P'da `bankMessageId`), `BankMessage_parsed_check`
(`PARSED` da yo‘nalish, summa > 0, balans, `last4` 4 raqam, bank vaqti), `BankMessage_reason_check` (`PARSED` bo‘lmasa sabab,
bo‘sh emas), `PaymentReview_resolved_check`.

**Ledger yordamchisi:** `packages/db/src/ledger/` — `lockWallet(tx, userId)` (`SELECT … FOR UPDATE` `Wallet` qatorida;
qator yo‘q bo‘lsa `WalletNotFoundError`), `appendLedgerEntry(tx, entry)` (takror `(refType, refId, kind)` → Prisma `P2002`,
noto‘g‘ri ishora → `LedgerEntry_amount_sign_check`), `sumBalance(tx, userId)` (`0n` agar yozuv yo‘q). `@repo/db` dan eksport.
Faqat tranzaksiya klienti qabul qilinadi: pul harakati va uni keltirgan holat o‘zgarishi bir `$transaction` da bo‘lishi shart.

**Review tuzatishlari: 4-migratsiya `20261105090000_p4_wallet_p2p_hardening`** (S2 code-review; avvalgi uchta migratsiya qo‘llangani
uchun tahrirlanmadi). Maxsus SQLSTATE'lar: `GG001` — o‘zgarmas/append-only qator yoki taqiqlangan holat o‘zgarishi; `GG002` — migratsiya
qo‘riqchisi (`Payment`/`PaymentReview` da qayta talqin qilib bo‘lmaydigan ma’lumot); `GG003` — `BankMessage` kartasi xabarga mos emas;
`GG004` — `Payment` o‘z intenti yoki bank xabari bilan ziddiyatli.

- **M1. Ledger yordamchilari faqat tranzaksiyada.** `Prisma.TransactionClient` tipi ildiz klientga ham mos keladi, shuning uchun
  `lockWallet(prisma, id)` kompilyatsiya bo‘ladi, lekin qulf darhol bo‘shaydi. `lockWallet` va `appendLedgerEntry` ildiz klient kelsa
  `NotInTransactionError` tashlaydi. **Farqlovchi belgi — `'$connect' in tx`**: Prisma 7.10.1 ish vaqtida tranzaksiya klienti
  `$connect, $disconnect, $on, $use, $extends` ni yashiradi. `'$transaction' in tx` ishlatib bo‘lmaydi: tranzaksiya klientida u ish
  vaqtida mavjud (faqat tipda yo‘q). Ikkala fakt testda qayd etilgan (`ledger.e2e.test.ts`), Prisma yangilansa test yiqiladi. `sumBalance`
  oddiy o‘qish, ildiz klientni ham qabul qiladi.
- **M2. Karta qabul paytida.** Listener `BankMessage` ni INSERT qiladigan tranzaksiyada `cardId` ni yozadi (`docs/05` §6.3). `BEFORE INSERT`
  trigger `BankMessage_card_guard` (`GG003`): karta banki xabar manbasiga mos (`HUMO_BOT`→`HUMO`, `UZCARD_BOT`→`UZCARD`), `card.last4 = last4`
  (`last4` yo‘q xabarga karta yozilmaydi), `RETIRED` karta faqat shu `(bank, last4)` da faol karta bo‘lmasa qabul qilinadi. `cardId = NULL`
  doim mumkin (`CARD_UNKNOWN`); mavjud bo‘lmagan karta FK xatosini beradi. Sabab: `BankMessage` append-only, noto‘g‘ri `cardId`
  tuzatilmaydi va boshqa kartaning balans zanjirini buzardi.
- **M5. `PaymentIntent` ga `BEFORE UPDATE` qo‘riqchi** (`PaymentIntent_p2p_guard`, `GG001`, faqat P2P). `id, userId, provider, cardId, amountTiyin,
baseAmountTiyin, createdAt, expiresAt` o‘zgarmaydi. Holat grafi `intent-state.ts` bilan bir xil: `PENDING→PAID|EXPIRED|CANCELLED`,
  `EXPIRED→PAID`, `CANCELLED→PAID`, `PAID` yakuniy (test har juftni `intentTransitionRefusal` bilan solishtiradi). `reservedUntil` va `paidAt`
  faqat `PAID` ga o‘tishda o‘zgaradi, `reservedUntil` faqat oshadi (**m8: `GREATEST(eski, paidAt + grace)`**; qisqarsa EXCLUDE hali qarz
  bo‘lgan summani bo‘shatib yuborardi). 4-migratsiyada bu «kamaymasin» edi; 5-migratsiyada aniq tenglikka keltirildi (pastda N1). `payTokenHash` va `updatedAt` o‘zgaruvchan (`POST /pay-link` tokenni almashtiradi). Trigger bilmaydigan
  ikki qoida `assertIntentTransition` da qoladi: grace (voqea vaqti kerak) va `CANCELLED→PAID` faqat ega (aktor kerak).
- **m1.** `PaymentIntent_base_positive_check`: `baseAmountTiyin IS NULL OR > 0` (`% 100000 = 0` ni 0 ham qanoatlantirardi).
- **m2.** `BankMessageOutcome`: `CREDITED` ⇔ `paymentId`; `REVIEW` ⇒ `reviewId`; ikkala havola FK (Restrict).
- **m3.** `RESOLVED` review'da `resolvedAuditLogId` majburiy va FK → `AuditLog`.
- **m4.** `docs/05` §6 va `REVIEW_KINDS` bo‘yicha hamma review turi bank xabarini qayta ishlashdan chiqadi (kunlik solishtirish alert beradi,
  review emas) → `PaymentReview.bankMessageId NOT NULL`; xabarsiz tur yo‘q, shuning uchun boshqa idempotentlik kaliti kerak emas.
- **m5.** `Payment_consistency_guard` (`BEFORE INSERT OR UPDATE OF intentId, userId, provider, bankMessageId, amountTiyin`, `GG004`): intent
  to‘lovi intent egasiniki; `P2P_CARD` to‘lovi — `PARSED` `CREDIT` xabar va summasi xabar summasiga aynan teng. **Og‘ish:** kompozit FK
  `(intentId, userId)` o‘rniga trigger: Prisma qisman nullable kompozit relation'ni modellay olmaydi, xom FK esa har `migrate dev` da drift
  bo‘lib ko‘rinardi.
- **n1.** `TopupCard_verified_check`: `status IN ('VERIFYING','RETIRED') OR verifiedAt IS NOT NULL`.

**Ikkinchi review tuzatishlari: 5-migratsiya `20261105160000_p4_wallet_p2p_guards`** (4-migratsiya qo‘llangani uchun tahrirlanmadi: to‘rt trigger
funksiyasi `CREATE OR REPLACE` bilan almashtirildi, triggerlar o‘sha funksiyalarga qarab turaveradi; bitta yangi trigger; ikkita indeks). Yangi
SQLSTATE: **`GG005`** — `BankMessageOutcome` boshqa bank xabariga tegishli to‘lov yoki review'ni nomlaydi.

- **N1 + N5. `PaymentIntent_p2p_guard`: `PAID` ga o‘tishda band muddati aniq formula bilan.** Trigger qiymatni **yozmaydi**, faqat boshqa qiymatni
  rad etadi (`GG001`): `reservedUntil = GREATEST(OLD.reservedUntil, NEW.paidAt + (OLD.reservedUntil − OLD.expiresAt))`; `grace` — yaratilishda
  qo‘yilgan `reservedUntil − expiresAt` farqi (S6 shu formulani o‘zi hisoblaydi). Sabab: kalta qiymat hali qarz bo‘lgan summani bo‘shatib yuboradi;
  uzun yoki `infinity` qiymat summani kartada abadiy band qiladi. Qo‘shimcha: `paidAt` `createdAt − 5 daqiqa … now() + 5 daqiqa` oralig‘ida
  (`2000-01-01` ham, uzoq kelajak ham rad), `reservedUntil` chekli, `paidAt` va `reservedUntil` ikkalasi ham bir UPDATE'da beriladi. **`paidAt` nima?**
  `docs/05` buni aniq aytmaydi (bank vaqti yoki yozish vaqti), shuning uchun oraliq ikkalasini ham qabul qiladi: bank vaqti daqiqagacha kesiladi va
  bank soati bizdan farq qiladi (`createdAt − 120 s` qoidasi ham shu oraliqqa sig‘adi), yozish vaqti esa `now()` dan oshmaydi.
- **N2. `Payment_consistency_guard`: so‘rovli P2P to‘lov — shu so‘rovning kartasi va summasi** (`GG004`). `intentId` bor `P2P_CARD` to‘lovda:
  `intent.provider = 'P2P_CARD'`, `intent.cardId` = xabar `cardId` (xabarda karta `NULL` bo‘lsa mos kelmaydi), `intent.amountTiyin` = xabar summasi.
  Aks holda to‘lov boshqa kartaga yoki boshqa summaga kelgan pulni A foydalanuvchining so‘rovi deb yozardi. Natija: `review:credit --intent` faqat
  karta va summa aynan mos bo‘lsa ishlaydi; qolgan hamma holatda `--user` (so‘rovsiz, `reviewId` bilan).
- **N3. `BankMessage_card_guard`: «eng oxirgi RETIRED».** Bir `(bank, last4)` da bir nechta `RETIRED` karta bo‘lsa, xabar `retiredAt` eng
  kattasiga yozilishi shart (`GG003`); eskisiga yozish rad etiladi.
- **N4. `BankMessageOutcome_links_guard` (`BEFORE INSERT`, `GG005`):** `paymentId` ko‘rsatgan `Payment.bankMessageId` va `reviewId` ko‘rsatgan
  `PaymentReview.bankMessageId` outcome'ning o‘z `bankMessageId` siga teng bo‘lsin. Outcome bir marta yoziladi, noto‘g‘ri havolani keyin
  tuzatib bo‘lmaydi. Mavjud bo‘lmagan qator FK'ga qoldiriladi.
- **N6. `RETIRED` — yakuniy holat.** `TopupCard` triggeri (`GG001`): `RETIRED` dan boshqa holatga o‘tish yo‘q, `retiredAt` o‘rnatilgach o‘zgarmaydi
  (aks holda «eng oxirgi RETIRED» qoidasi ostidagi xabarlar jimgina boshqa kartaga o‘tib qolardi). Qolgan holatlarning to‘liq grafi karta puli
  (S4) ishi; `RETIRED` kartada limit va pauza belgisi o‘zgara oladi.
- **N7.** Indekslar: `BankMessageOutcome(reviewId)`, `PaymentReview(resolvedAuditLogId)` (FK'lar indekssiz edi).
- **N9.** Karta triggerida bank enum tipida solishtiriladi (`t.bank = card.bank`, `::text` emas), shuning uchun `(bank, last4)` indekslaridan foydalaniladi.
- **N8** (`docs/05` §7): `UNRECOGNIZED`/`REJECTED` xabar `review:credit` bilan pulga aylanmaydi (u `PARSED CREDIT` xabar talab qiladi, `GG004`);
  bunday pul faqat `wallet:adjust` orqali.
- **Qoldirildi (keyingi provayder):** `PaymentIntent` triggeri faqat P2P qatorlarni qo‘riqlaydi; P2P bo‘lmagan so‘rovda `userId` o‘zgarishi hozircha
  to‘silmagan (Click/Payme qo‘shilganda o‘sha provayderning qoidalari bilan birga).

**Uchinchi review tuzatishlari: 6-migratsiya `20261105200000_p4_wallet_p2p_immutables`** (5-migratsiya qo‘llangani uchun tahrirlanmadi; ikki trigger
funksiyasi `CREATE OR REPLACE`, ikki yangi trigger; jadval va ustun o‘zgarishi yo‘q).

- **Y1. Band muddati formulasi TS bilan bir xil.** `packages/shared/src/payments/intent-state.ts` da `intentReservedUntil` (PAID uchun `paidAt + grace` bergan,
  DB esa buni rad etardi: 30 daqiqa ichida to‘langan oddiy `PENDING` ham `GG001` olardi) o‘chirildi; o‘rniga `reservedUntilAtCreation(expiresAt, graceSec)`
  (`expiresAt + grace`) va `reservedUntilWhenPaid({ expiresAt, reservedUntil }, paidAt)` (`GREATEST(reservedUntil, paidAt + (reservedUntil − expiresAt))`).
  `payment-intent-guard.e2e.test.ts` triggerni shu funksiya natijasi bilan sinaydi (oyna ichida, chegarada, 1 ms keyin, kech to‘lov).
- **Y2. `Payment` va `PaymentReview` o‘zgarmas ustunlari** (`GG001`). `Payment`: `intentId, userId, provider, providerTxnId, amountTiyin, bankMessageId,
reviewId` INSERT'dan keyin o‘zgarmaydi (aks holda TOPUP yozuvi `PAYMENT/<id>` uni asoslovchi qatordan ajralib qolardi); `status`, `cancelledAt`,
  `confirmedAt`, `raw` o‘zgaruvchan (`CONFIRMED → CANCELLED` reversali). `PaymentReview`: `bankMessageId` va `kind` o‘zgarmas (ular idempotentlik kaliti);
  holat, hal qilish maydonlari, `cardId`/`intentId`, `note` o‘zgaruvchan. Hozirgi yozuvchilar tekshirildi: faqat `cancelConfirmedPayment` (`status`, `cancelledAt`)
  INSERT'dan keyin yozadi; `review:credit` `reviewId` ni INSERT'da beradi.
- **Y3.** Intent'i bor har qanday `Payment` shu intent'ning `provider` iga ega bo‘lishi shart (`GG004`; Click to‘lovi `P2P_CARD` so‘roviga yoki aksincha — yo‘q).
- **Y4.** «Eng oxirgi `RETIRED`» tenglikda `(retiredAt, id)` bo‘yicha: bir millisekundda ikki karta `RETIRED` bo‘lsa, id kattasi tanlanadi.
- **Y5.** Intent triggerida `intent_found := FOUND` darhol `SELECT … INTO` dan keyin (avval `INTO` qator topilmasa NULL yozishiga tayanardi).

**Isbot** (`packages/db/test/*.e2e.test.ts`): `check-constraints-topup-card`, `check-constraints-intent` (CHECK matritsalari, partial unique'lar;
m9: `PENDING` unique yolg‘iz o‘zi `P2002` beradi), `payment-intent-guard` (M5, har ruxsat va rad), `payment-reservation` (H1, parallel INSERT'lar),
`bank-message` (BankMessage, matn tozalash, M2), `payment-review` (review va outcome), `payment-consistency` (Payment, m5, N2, bir xabarga parallel
to‘lov, `GG002` qo‘riqchisi), `ledger` (qulf, M1, 2^53 dan katta summa), `schema` (haqiqiy `pg_enum`); unit: `src/payments-enums.test.ts`,
`src/schema.test.ts`.

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

| Ko‘rsatkich              | Qayerda                                                                     |
| ------------------------ | --------------------------------------------------------------------------- |
| Balans                   | `SUM(LedgerEntry.amountTiyin) WHERE userId` + Redis kesh                    |
| Keshbek tangalari        | `SUM(CoinEntry.coins)`                                                      |
| Referal daromadi         | `SUM(LedgerEntry WHERE kind=REFERRAL_BONUS)`                                |
| Buyurtma foydasi (admin) | `priceTiyin − discountTiyin − costMinor × fx` (buyurtmadagi snapshot bilan) |
| Hot wallet balansi       | worker, zanjirdan + `WalletSnapshot`                                        |
