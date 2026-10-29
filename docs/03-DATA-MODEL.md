# 03 — Ma'lumotlar modeli

Quyidagi Prisma sxemasi — **boshlang‘ich loyiha**. 1-bosqichda agent uni `packages/db/prisma/schema.prisma`
ga ko‘chiradi, tekshiradi va kerak bo‘lsa aniqlashtiradi (o‘zgartirishlar shu faylda ham yangilanadi).

## Asosiy qoidalar

- Pul: `BigInt`, birligi ustun nomida (`Tiyin`, `MicroUsdt`, `NanoTon`, `Stars`).
- Balans saqlanmaydi: `LedgerEntry` yig‘indisi. `Wallet` jadvali faqat **qulf** (row lock) va
  sozlamalar uchun.
- Idempotentlik — unique indekslar orqali.
- `Order.status` faqat `order-state.ts` orqali o‘zgaradi.

## Sxema (loyiha)

```prisma
generator client {
  provider = "prisma-client-js"
}
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum Locale {
  uz
  ru
}

model User {
  id            String   @id @default(cuid())
  telegramId    BigInt   @unique
  username      String?
  firstName     String?
  lastName      String?
  photoUrl      String?
  phone         String?            // faqat foydalanuvchi ulashsa
  locale        Locale   @default(uz)
  referralCode  String   @unique
  referredById  String?
  referredBy    User?    @relation("Referrals", fields: [referredById], references: [id])
  referrals     User[]   @relation("Referrals")
  isBlocked     Boolean  @default(false)
  purchaseFrozen Boolean @default(false)  // to‘lov qaytarilib, balans manfiy bo‘lsa
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  lastSeenAt    DateTime?
  wallet        Wallet?
  @@index([referredById])
}

model Wallet {               // balans saqlanmaydi; FOR UPDATE qulfi uchun
  userId    String   @id
  user      User     @relation(fields: [userId], references: [id])
  createdAt DateTime @default(now())
}

enum LedgerKind {
  TOPUP
  TOPUP_REVERSAL
  PURCHASE
  REFUND
  REFERRAL_BONUS
  ADJUSTMENT
}

model LedgerEntry {
  id          String     @id @default(cuid())
  userId      String
  kind        LedgerKind
  amountTiyin BigInt                 // ishorali: + kirim, − chiqim
  refType     String                 // PAYMENT | ORDER | ADMIN | REFERRAL
  refId       String
  note        String?
  createdAt   DateTime   @default(now())
  @@unique([refType, refId, kind])
  @@index([userId, createdAt])
}

enum CoinKind {
  EARN
  SPEND
  EXPIRE
  ADJUSTMENT
  REVERSAL
}
model CoinEntry {
  id        String   @id @default(cuid())
  userId    String
  kind      CoinKind
  coins     BigInt
  refType   String
  refId     String
  createdAt DateTime @default(now())
  @@unique([refType, refId, kind])
  @@index([userId, createdAt])
}

// ---------- Katalog ----------
enum DeliveryType {
  TG_USERNAME
  GAME_ID
  STEAM_LOGIN
  VOUCHER
  USERNAME
}

model Category {
  id        String    @id @default(cuid())
  slug      String    @unique
  nameUz    String
  nameRu    String
  sort      Int       @default(0)
  products  Product[]
}

model Product {
  id            String       @id @default(cuid())
  slug          String       @unique
  categoryId    String
  category      Category     @relation(fields: [categoryId], references: [id])
  nameUz        String
  nameRu        String
  descriptionUz String?
  descriptionRu String?
  helpUz        String?      // "ID'ni qayerdan topaman?"
  helpRu        String?
  imageUrl      String
  regionBadge   String?      // GLOBAL | SNG | UZ ...
  deliveryType  DeliveryType
  inputSchema   Json         // forma maydonlari: [{key:"playerId",type:"digits",min:5,max:12}, ...]
  isAuto        Boolean      @default(true)
  isFeatured    Boolean      @default(false)
  isActive      Boolean      @default(false)
  allowCustomQty Boolean     @default(false)   // Stars: erkin miqdor
  minQty        Int?
  maxQty        Int?
  sort          Int          @default(0)
  skus          Sku[]
  routes        ProductRoute[]
  createdAt     DateTime     @default(now())
  updatedAt     DateTime     @updatedAt
}

model Sku {
  id            String   @id @default(cuid())
  productId     String
  product       Product  @relation(fields: [productId], references: [id])
  tab           String?  // "UC tezkor" / "To‘plamlar" kabi guruh (i18n kaliti)
  labelUz       String   // "60 UC", "3 oylik"
  labelRu       String
  quantity      Int      // 60 (UC), 3 (oy), 1 (voucher)
  supplierSku   String?  // ta'minotchidagi kod
  markupBps     Int      // ustama, bazis punktda (1500 = 15%)
  minMarginTiyin BigInt  @default(0)
  isActive      Boolean  @default(true)
  sort          Int      @default(0)
  vouchers      Voucher[]
}

model ProductRoute {         // mahsulot → adapter (ustuvorlik tartibida)
  id         String  @id @default(cuid())
  productId  String
  product    Product @relation(fields: [productId], references: [id])
  adapter    String  // FRAGMENT | RESELLER_STARS | FAZERCARDS | ...
  priority   Int
  isEnabled  Boolean @default(true)
  @@unique([productId, adapter])
}

enum VoucherStatus {
  AVAILABLE
  RESERVED
  SOLD
  INVALID
}
model Voucher {
  id          String        @id @default(cuid())
  skuId       String
  sku         Sku           @relation(fields: [skuId], references: [id])
  codeEnc     String        // shifrlangan
  codeHash    String        @unique
  status      VoucherStatus @default(AVAILABLE)
  orderId     String?       @unique
  costMicroUsdt BigInt
  createdAt   DateTime      @default(now())
  @@index([skuId, status])
}

// ---------- Narx ----------
model FxRate {
  id        String   @id @default(cuid())
  pair      String   // USDT_UZS, TON_USDT, TON_UZS
  rate      String   // o‘nlik qator (decimal string), hisob BigInt'da
  source    String
  createdAt DateTime @default(now())
  @@index([pair, createdAt])
}

model Quote {
  id             String   @id @default(cuid())
  userId         String
  skuId          String?
  productId      String
  quantity       Int
  recipient      Json     // tekshirilgan qabul qiluvchi: {username, displayName, ...}
  costCurrency   String   // TON | USDT
  costMinor      BigInt   // nanoTON yoki microUSDT
  fxRateId       String
  priceTiyin     BigInt
  maxCostMinor   BigInt   // shu chegaradan oshsa — HELD
  discountCodeId String?
  expiresAt      DateTime
  usedAt         DateTime?
  createdAt      DateTime @default(now())
  @@index([userId, createdAt])
}

// ---------- Buyurtma ----------
enum OrderStatus {
  PAID
  QUEUED
  PROCESSING
  HELD
  NEEDS_REVIEW
  DELIVERED
  FAILED
  CANCELLED
  REFUNDED
}

model Order {
  id             String      @id @default(cuid())
  number         Int         @unique @default(autoincrement())  // foydalanuvchiga ko‘rinadigan #
  userId         String
  quoteId        String      @unique
  productId      String
  skuId          String?
  quantity       Int
  recipient      Json
  priceTiyin     BigInt
  discountTiyin  BigInt      @default(0)
  costCurrency   String
  costMinor      BigInt
  maxCostMinor   BigInt
  status         OrderStatus
  statusReason   String?
  idempotencyKey String
  deliveredAt    DateTime?
  voucherId      String?
  createdAt      DateTime    @default(now())
  updatedAt      DateTime    @updatedAt
  attempts       FulfillmentAttempt[]
  events         OrderEvent[]
  @@unique([userId, idempotencyKey])
  @@index([status, createdAt])
  @@index([userId, createdAt])
}

model OrderEvent {           // holat tarixi (audit)
  id        String      @id @default(cuid())
  orderId   String
  order     Order       @relation(fields: [orderId], references: [id])
  from      OrderStatus?
  to        OrderStatus
  actor     String      // SYSTEM | WORKER | ADMIN:<id>
  note      String?
  createdAt DateTime    @default(now())
  @@index([orderId, createdAt])
}

enum AttemptStatus {
  SENDING
  SENT
  CONFIRMED
  FAILED
  UNKNOWN
}
model FulfillmentAttempt {
  id            String        @id @default(cuid())
  orderId       String
  order         Order         @relation(fields: [orderId], references: [id])
  attemptNo     Int
  adapter       String
  status        AttemptStatus
  externalRef   String?       // TON message hash / supplier order id / Fragment req_id
  request       Json          // sirlarsiz
  response      Json?
  costMinor     BigInt?
  error         String?
  createdAt     DateTime      @default(now())
  updatedAt     DateTime      @updatedAt
  @@unique([orderId, attemptNo])
  @@index([externalRef])
}

// ---------- To‘lovlar ----------
enum PaymentProviderCode {
  CLICK
  PAYME
  UZUM
  RAHMAT
  TG_STARS
}
enum IntentStatus {
  PENDING
  PAID
  CANCELLED
  EXPIRED
}

model PaymentIntent {
  id           String              @id @default(cuid())
  userId       String
  provider     PaymentProviderCode
  amountTiyin  BigInt
  status       IntentStatus        @default(PENDING)
  purpose      String              // TOPUP | TOPUP_AND_BUY
  quoteId      String?             // TOPUP_AND_BUY bo‘lsa
  expiresAt    DateTime
  createdAt    DateTime            @default(now())
  payments     Payment[]
  @@index([userId, createdAt])
}

enum PaymentStatus {
  CREATED
  CONFIRMED
  CANCELLED
}
model Payment {
  id             String              @id @default(cuid())
  intentId       String
  intent         PaymentIntent       @relation(fields: [intentId], references: [id])
  provider       PaymentProviderCode
  providerTxnId  String
  amountTiyin    BigInt
  status         PaymentStatus
  raw            Json                // redakt qilingan
  confirmedAt    DateTime?
  cancelledAt    DateTime?
  createdAt      DateTime            @default(now())
  @@unique([provider, providerTxnId])
}

// ---------- Promo ----------
model BonusCode {
  id          String   @id @default(cuid())
  codeHash    String   @unique
  rewardType  String   // WALLET_TIYIN | COINS
  rewardValue BigInt
  maxUses     Int
  usedCount   Int      @default(0)
  expiresAt   DateTime?
  createdById String
  createdAt   DateTime @default(now())
  redemptions BonusRedemption[]
}
model BonusRedemption {
  id        String    @id @default(cuid())
  codeId    String
  code      BonusCode @relation(fields: [codeId], references: [id])
  userId    String
  createdAt DateTime  @default(now())
  @@unique([codeId, userId])
}

model DiscountTier {
  id         String  @id @default(cuid())
  bps        Int
  priceCoins BigInt
  isActive   Boolean @default(true)
}
model DiscountCode {
  id        String   @id @default(cuid())
  userId    String
  tierId    String
  bps       Int
  code      String   @unique
  usedOrderId String? @unique
  expiresAt DateTime?
  createdAt DateTime @default(now())
  @@index([userId])
}

// ---------- Fragment / hamyon ----------
model FragmentSession {
  id          String   @id @default(cuid())
  cookiesEnc  String           // shifrlangan cookie jar
  pageHash    String?
  status      String           // ACTIVE | DEAD
  lastOkAt    DateTime?
  lastError   String?
  updatedAt   DateTime @updatedAt
}

model WalletSnapshot {          // hot wallet balansi tarixi (admin grafik uchun)
  id          String   @id @default(cuid())
  network     String
  address     String
  tonNano     BigInt
  usdtMicro   BigInt
  createdAt   DateTime @default(now())
}

// ---------- Auth / admin ----------
model WebSession {
  id          String   @id @default(cuid())
  userId      String
  refreshHash String   @unique
  familyId    String
  userAgent   String?
  ip          String?
  revokedAt   DateTime?
  expiresAt   DateTime
  createdAt   DateTime @default(now())
  @@index([userId])
}

model LoginRequest {            // web va admin OTP
  id         String   @id @default(cuid())
  nonce      String   @unique
  kind       String   // USER | ADMIN
  telegramId BigInt?
  codeHash   String?
  attempts   Int      @default(0)
  status     String   // PENDING | CODE_SENT | USED | EXPIRED | DENIED
  expiresAt  DateTime
  createdAt  DateTime @default(now())
}

enum AdminRole {
  OWNER
  OPERATOR
  SUPPORT
}
model AdminUser {
  id         String    @id @default(cuid())
  telegramId BigInt    @unique
  name       String
  role       AdminRole
  isActive   Boolean   @default(true)
  createdAt  DateTime  @default(now())
}
model AdminSession {
  id         String   @id @default(cuid())
  adminId    String
  tokenHash  String   @unique
  lastUsedAt DateTime
  expiresAt  DateTime
  revokedAt  DateTime?
  ip         String?
  createdAt  DateTime @default(now())
}
model AuditLog {
  id        String   @id @default(cuid())
  actorType String   // ADMIN | SYSTEM
  actorId   String?
  action    String   // ORDER_REFUND, WALLET_ADJUST, PRODUCT_UPDATE ...
  targetType String
  targetId  String
  before    Json?
  after     Json?
  reason    String?
  ip        String?
  createdAt DateTime @default(now())
  @@index([targetType, targetId])
  @@index([createdAt])
}

model Broadcast {
  id         String   @id @default(cuid())
  textUz     String
  textRu     String
  audience   Json
  status     String   // DRAFT | SENDING | DONE | CANCELLED
  sentCount  Int      @default(0)
  failCount  Int      @default(0)
  createdById String
  createdAt  DateTime @default(now())
}

model Setting {                 // admin'dan o‘zgaradigan sozlamalar
  key       String   @id      // REFERRAL_BPS, CASHBACK_BPS, TOPUP_MIN_TIYIN ...
  value     Json
  updatedAt DateTime @updatedAt
  updatedBy String?
}
```

## Nima qayerda hisoblanadi

| Ko‘rsatkich              | Qayerda                                                                     |
| ------------------------ | --------------------------------------------------------------------------- |
| Balans                   | `SUM(LedgerEntry.amountTiyin) WHERE userId` + Redis kesh                    |
| Keshbek tangalari        | `SUM(CoinEntry.coins)`                                                      |
| Referal daromadi         | `SUM(LedgerEntry WHERE kind=REFERRAL_BONUS)`                                |
| Buyurtma foydasi (admin) | `priceTiyin − discountTiyin − costMinor × fx` (buyurtmadagi snapshot bilan) |
| Hot wallet balansi       | worker, zanjirdan + `WalletSnapshot`                                        |
