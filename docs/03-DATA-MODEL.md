# 03 — Ma'lumotlar modeli

> **Haqiqat manbai — `packages/db/prisma/schema.prisma`** (Prisma 7, D-22). Migratsiyalar:
> `packages/db/prisma/migrations/20261029185158_init` va `20261031120000_domain_guardrails`
> ("Migratsiya 2" bo‘limi — trigger va `CHECK`lar faqat shu yerda). Bu hujjat sxemani tushuntiradi, nusxasini
> saqlamaydi: ikkalasi farq qilsa, to‘g‘ri bo‘lgani — `schema.prisma`. Sxema o‘zgarsa shu fayl
> ham o‘sha o‘zgarishda yangilanadi.

## Asosiy qoidalar

- Pul: `BigInt`, birligi ustun nomida (`Tiyin`, `MicroUsdt`, `NanoTon`, `Minor`). `Decimal`/`Float` yo‘q.
- Balans saqlanmaydi: `LedgerEntry` yig‘indisi. `Wallet` jadvali faqat **qulf** (row lock) uchun.
- Idempotentlik — unique indekslar orqali (quyidagi jadval).
- `Order.status` faqat `order-state.ts` orqali o‘zgaradi; `OrderStatus` enum `ORDER_STATUSES` bilan
  bir xil (DB testi tekshiradi).
- id — `cuid(2)`; jadval nomlari model nomlari bilan bir xil (`"Wallet"`, `"LedgerEntry"`).

## Modellar (29 ta model, 11 ta enum)

| Guruh         | Modellar                                                                                      |
| ------------- | --------------------------------------------------------------------------------------------- |
| Foydalanuvchi | `User`, `Wallet`                                                                              |
| Hamyon        | `LedgerEntry` (so‘m), `CoinEntry` (keshbek tangalari)                                         |
| Katalog       | `Category`, `Product`, `Sku`, `ProductRoute`, `Voucher`                                       |
| Narx          | `FxRate`, `Quote`                                                                             |
| Buyurtma      | `Order`, `OrderEvent`, `FulfillmentAttempt`                                                   |
| To‘lov        | `PaymentIntent`, `Payment`                                                                    |
| Promo         | `BonusCode`, `BonusRedemption`, `DiscountTier`, `DiscountCode`                                |
| Fragment      | `FragmentSession`, `WalletSnapshot`                                                           |
| Auth / admin  | `WebSession`, `LoginRequest`, `AdminUser`, `AdminSession`, `AuditLog`, `Broadcast`, `Setting` |

## Idempotentlik unique'lari

| Jadval               | Unique                                | Nimani himoya qiladi                                                                                                 |
| -------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `Payment`            | `(provider, providerTxnId)`           | provayder callback'i takrorlansa                                                                                     |
| `Order`              | `(userId, idempotencyKey)`, `quoteId` | buyurtma ikki marta yaratilmasin                                                                                     |
| `PaymentIntent`      | `(userId, idempotencyKey)`            | intent ikki marta yaratilmasin                                                                                       |
| `FulfillmentAttempt` | `(orderId, attemptNo)`                | urinish raqami bir marta                                                                                             |
| `LedgerEntry`        | `(refType, refId, kind)`              | bitta pul harakati bir marta yoziladi                                                                                |
| `CoinEntry`          | `(refType, refId, kind)`              | bitta tanga harakati bir marta yoziladi                                                                              |
| `BonusRedemption`    | `(codeId, userId)`                    | bonus kod foydalanuvchiga bir marta                                                                                  |
| `FulfillmentAttempt` | `(adapter, externalRef)`              | bitta tashqi to‘lov (TON hash / yetkazib beruvchi buyurtma id) faqat bitta urinishga tegishli; `NULL` ruxsat etiladi |

## D-23 o‘zgarishlari (boshlang‘ich loyihaga nisbatan)

1. **Hamma `*Id` — haqiqiy FK.** Har biriga `@relation` va indeks qo‘shildi (32 ta FK). `onDelete`:
   hamma joyda `Restrict` (pul va audit tarixi kaskad bilan o‘chib ketmasin; `SetNull` ham yo‘q —
   u tarix qatorini jimgina o‘zgartirardi). Yagona istisno — `Cascade`: `WebSession`, `AdminSession`
   (tarix saqlamaydigan kirish ma'lumotlari). FK bo‘lmagan joylar (polimorf havola):
   `LedgerEntry`/`CoinEntry` `(refType, refId)`, `AuditLog` `actorId`/`targetId`, `Setting.updatedBy`.
2. **`updatedAt` faqat o‘zgaradigan jadvallarda.** Append-only jadvallarda yo‘q: `LedgerEntry`,
   `CoinEntry`, `AuditLog`, `OrderEvent`; o‘zgarmas snapshot'lar: `FxRate`, `WalletSnapshot`,
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

   | Jadval                         | Cheklov                                                                                                                    |
   | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
   | `LedgerEntry`                  | ishora turga qarab (jadval pastda); noma'lum tur rad etiladi (`ELSE false`) — yangi tur qo‘shilsa, cheklov ham yangilanadi |
   | `CoinEntry`                    | `EARN` > 0; `SPEND`, `EXPIRE` < 0; `ADJUSTMENT`, `REVERSAL` ≠ 0 (`REVERSAL` EARN yoki SPEND'ni bekor qilishi mumkin)       |
   | `Order`, `Quote`               | `quantity` > 0, `priceTiyin` > 0, `costMinor` > 0, `maxCostMinor` ≥ `costMinor`                                            |
   | `Order`                        | `0 ≤ discountTiyin ≤ priceTiyin` (`priceTiyin` — chegirmadan oldingi narx)                                                 |
   | `PaymentIntent`, `Payment`     | `amountTiyin` > 0                                                                                                          |
   | `Sku`                          | `quantity` > 0, `minMarginTiyin` ≥ 0, `markupBps` ≥ 0 (ustama 100% dan oshishi mumkin, shuning uchun yuqori chegara yo‘q)  |
   | `Product`                      | `minQty`, `maxQty` > 0 va `minQty` ≤ `maxQty`                                                                              |
   | `Voucher`                      | `costMicroUsdt` > 0                                                                                                        |
   | `FulfillmentAttempt`           | `attemptNo` > 0, `costMinor` ≥ 0                                                                                           |
   | `WalletSnapshot`               | `tonNano` ≥ 0, `usdtMicro` ≥ 0                                                                                             |
   | `BonusCode`                    | `rewardValue` > 0, `maxUses` > 0, `0 ≤ usedCount ≤ maxUses`                                                                |
   | `DiscountTier`, `DiscountCode` | `bps` 0..10000; `DiscountTier.priceCoins` > 0                                                                              |
   | `FxRate`                       | `rate` — musbat o‘nlik qator, ko‘pi bilan 18 xona (`money.ts` bilan bir xil)                                               |
   | `User`                         | `referredById` ≠ `id` (o‘zini o‘zi taklif qila olmaydi)                                                                    |

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

## Nima qayerda hisoblanadi

| Ko‘rsatkich              | Qayerda                                                                     |
| ------------------------ | --------------------------------------------------------------------------- |
| Balans                   | `SUM(LedgerEntry.amountTiyin) WHERE userId` + Redis kesh                    |
| Keshbek tangalari        | `SUM(CoinEntry.coins)`                                                      |
| Referal daromadi         | `SUM(LedgerEntry WHERE kind=REFERRAL_BONUS)`                                |
| Buyurtma foydasi (admin) | `priceTiyin − discountTiyin − costMinor × fx` (buyurtmadagi snapshot bilan) |
| Hot wallet balansi       | worker, zanjirdan + `WalletSnapshot`                                        |
