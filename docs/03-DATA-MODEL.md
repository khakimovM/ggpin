# 03 — Ma'lumotlar modeli

> **Haqiqat manbai — `packages/db/prisma/schema.prisma`** (Prisma 7, D-22). Birinchi migratsiya:
> `packages/db/prisma/migrations/20261029185158_init`. Bu hujjat sxemani tushuntiradi, nusxasini
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

| Jadval               | Unique                                | Nimani himoya qiladi                    |
| -------------------- | ------------------------------------- | --------------------------------------- |
| `Payment`            | `(provider, providerTxnId)`           | provayder callback'i takrorlansa        |
| `Order`              | `(userId, idempotencyKey)`, `quoteId` | buyurtma ikki marta yaratilmasin        |
| `PaymentIntent`      | `(userId, idempotencyKey)`            | intent ikki marta yaratilmasin          |
| `FulfillmentAttempt` | `(orderId, attemptNo)`                | urinish raqami bir marta                |
| `LedgerEntry`        | `(refType, refId, kind)`              | bitta pul harakati bir marta yoziladi   |
| `CoinEntry`          | `(refType, refId, kind)`              | bitta tanga harakati bir marta yoziladi |
| `BonusRedemption`    | `(codeId, userId)`                    | bonus kod foydalanuvchiga bir marta     |

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

## Nima qayerda hisoblanadi

| Ko‘rsatkich              | Qayerda                                                                     |
| ------------------------ | --------------------------------------------------------------------------- |
| Balans                   | `SUM(LedgerEntry.amountTiyin) WHERE userId` + Redis kesh                    |
| Keshbek tangalari        | `SUM(CoinEntry.coins)`                                                      |
| Referal daromadi         | `SUM(LedgerEntry WHERE kind=REFERRAL_BONUS)`                                |
| Buyurtma foydasi (admin) | `priceTiyin − discountTiyin − costMinor × fx` (buyurtmadagi snapshot bilan) |
| Hot wallet balansi       | worker, zanjirdan + `WalletSnapshot`                                        |
