-- Migration 9, part 1 (phase 4: wallet and P2P card top-ups, D-37): enums, tables, columns,
-- foreign keys and plain indexes. Prisma-generated DDL below the guard. Additive, with two
-- relaxations of existing shape: "Payment"."intentId" becomes nullable (a payment credited from
-- a review has no intent) and "Payment"."userId" is added NOT NULL.
--
-- Everything that has to USE the new enum values (P2P_CARD in CHECKs and partial indexes) is in
-- the next migration: PostgreSQL cannot use a value added by ALTER TYPE ... ADD VALUE in the
-- transaction that added it.

-- Guard: "Payment"."userId" NOT NULL has no value to backfill with. The table is empty in dev
-- and test (no provider is integrated yet); if it ever is not, stop instead of guessing owners.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Payment") THEN
    RAISE EXCEPTION 'Payment is not empty: backfill "userId" from the intent before adding NOT NULL'
      USING ERRCODE = 'GG002';
  END IF;
END;
$$;

-- CreateEnum
CREATE TYPE "CardBank" AS ENUM ('HUMO', 'UZCARD');

-- CreateEnum
CREATE TYPE "TopupCardStatus" AS ENUM ('VERIFYING', 'ACTIVE', 'DRAINING', 'FULL', 'RETIRED');

-- CreateEnum
CREATE TYPE "BankFeedSource" AS ENUM ('HUMO_BOT', 'UZCARD_BOT');

-- CreateEnum
CREATE TYPE "BankParseStatus" AS ENUM ('PARSED', 'UNRECOGNIZED', 'REJECTED');

-- CreateEnum
CREATE TYPE "BankDirection" AS ENUM ('CREDIT', 'DEBIT');

-- CreateEnum
CREATE TYPE "ChainStatus" AS ENUM ('FIRST', 'OK', 'BREAK', 'NOT_APPLICABLE');

-- CreateEnum
CREATE TYPE "BankOutcome" AS ENUM ('CREDITED', 'CARD_VERIFIED', 'DEBIT_RECORDED', 'REVIEW');

-- CreateEnum
CREATE TYPE "PaymentReviewKind" AS ENUM ('UNRECOGNIZED', 'REJECTED', 'CARD_UNKNOWN', 'CARD_RETIRED', 'CHAIN_BREAK', 'AUTO_CREDIT_PAUSED', 'NO_MATCH', 'AMBIGUOUS', 'DUPLICATE', 'TIME_SKEW', 'CANCELLED_LATE', 'NEW_ACCOUNT_LIMIT', 'POSSIBLE_REVERSAL', 'USER_BLOCKED');

-- CreateEnum
CREATE TYPE "PaymentReviewStatus" AS ENUM ('OPEN', 'RESOLVED');

-- CreateEnum
CREATE TYPE "PaymentReviewResolution" AS ENUM ('CREDITED_USER', 'IGNORED', 'RETURNED_OFFLINE', 'CHAIN_ACCEPTED');

-- AlterEnum
ALTER TYPE "PaymentProviderCode" ADD VALUE 'P2P_CARD';

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "bankMessageId" TEXT,
ADD COLUMN     "reviewId" TEXT,
ADD COLUMN     "userId" TEXT NOT NULL,
ALTER COLUMN "intentId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "PaymentIntent" ADD COLUMN     "baseAmountTiyin" BIGINT,
ADD COLUMN     "cardId" TEXT,
ADD COLUMN     "paidAt" TIMESTAMP(3),
ADD COLUMN     "payTokenHash" TEXT,
ADD COLUMN     "reservedUntil" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "TopupCard" (
    "id" TEXT NOT NULL,
    "bank" "CardBank" NOT NULL,
    "pan" TEXT NOT NULL,
    "last4" TEXT NOT NULL,
    "holderName" TEXT NOT NULL,
    "status" "TopupCardStatus" NOT NULL DEFAULT 'VERIFYING',
    "receiveLimitTiyin" BIGINT NOT NULL,
    "monthlyLimitTiyin" BIGINT,
    "verifyAmountTiyin" BIGINT NOT NULL,
    "verifiedAt" TIMESTAMP(3),
    "retiredAt" TIMESTAMP(3),
    "autoCreditPaused" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TopupCard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankMessage" (
    "id" TEXT NOT NULL,
    "source" "BankFeedSource" NOT NULL,
    "senderId" BIGINT NOT NULL,
    "tgMessageId" BIGINT NOT NULL,
    "tgDate" TIMESTAMP(3) NOT NULL,
    "textSha256" TEXT NOT NULL,
    "parseStatus" "BankParseStatus" NOT NULL,
    "rejectReason" TEXT,
    "parserVersion" INTEGER NOT NULL,
    "direction" "BankDirection",
    "amountTiyin" BIGINT,
    "balanceAfterTiyin" BIGINT,
    "last4" TEXT,
    "cardId" TEXT,
    "bankTxnAt" TIMESTAMP(3),
    "channel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BankMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankMessageText" (
    "bankMessageId" TEXT NOT NULL,
    "text" TEXT,
    "purgeAfter" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BankMessageText_pkey" PRIMARY KEY ("bankMessageId")
);

-- CreateTable
CREATE TABLE "BankMessageOutcome" (
    "id" TEXT NOT NULL,
    "bankMessageId" TEXT NOT NULL,
    "chainStatus" "ChainStatus" NOT NULL,
    "outcome" "BankOutcome" NOT NULL,
    "paymentId" TEXT,
    "reviewId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BankMessageOutcome_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentReview" (
    "id" TEXT NOT NULL,
    "kind" "PaymentReviewKind" NOT NULL,
    "status" "PaymentReviewStatus" NOT NULL DEFAULT 'OPEN',
    "bankMessageId" TEXT,
    "cardId" TEXT,
    "intentId" TEXT,
    "resolution" "PaymentReviewResolution",
    "resolvedAuditLogId" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankFeedCursor" (
    "source" "BankFeedSource" NOT NULL,
    "lastMessageId" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BankFeedCursor_pkey" PRIMARY KEY ("source")
);

-- CreateIndex
CREATE INDEX "TopupCard_status_bank_idx" ON "TopupCard"("status", "bank");

-- CreateIndex
CREATE INDEX "BankMessage_cardId_tgMessageId_idx" ON "BankMessage"("cardId", "tgMessageId");

-- CreateIndex
CREATE INDEX "BankMessage_createdAt_idx" ON "BankMessage"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "BankMessage_senderId_tgMessageId_key" ON "BankMessage"("senderId", "tgMessageId");

-- CreateIndex
CREATE INDEX "BankMessageText_purgeAfter_idx" ON "BankMessageText"("purgeAfter");

-- CreateIndex
CREATE UNIQUE INDEX "BankMessageOutcome_bankMessageId_key" ON "BankMessageOutcome"("bankMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "BankMessageOutcome_paymentId_key" ON "BankMessageOutcome"("paymentId");

-- CreateIndex
CREATE INDEX "PaymentReview_status_createdAt_idx" ON "PaymentReview"("status", "createdAt");

-- CreateIndex
CREATE INDEX "PaymentReview_cardId_idx" ON "PaymentReview"("cardId");

-- CreateIndex
CREATE INDEX "PaymentReview_intentId_idx" ON "PaymentReview"("intentId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentReview_bankMessageId_kind_key" ON "PaymentReview"("bankMessageId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_bankMessageId_key" ON "Payment"("bankMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_reviewId_key" ON "Payment"("reviewId");

-- CreateIndex
CREATE INDEX "Payment_userId_createdAt_idx" ON "Payment"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentIntent_payTokenHash_key" ON "PaymentIntent"("payTokenHash");

-- CreateIndex
CREATE INDEX "PaymentIntent_cardId_reservedUntil_amountTiyin_idx" ON "PaymentIntent"("cardId", "reservedUntil", "amountTiyin");

-- CreateIndex
CREATE INDEX "PaymentIntent_userId_reservedUntil_idx" ON "PaymentIntent"("userId", "reservedUntil");

-- AddForeignKey
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "TopupCard"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_bankMessageId_fkey" FOREIGN KEY ("bankMessageId") REFERENCES "BankMessage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "PaymentReview"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankMessage" ADD CONSTRAINT "BankMessage_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "TopupCard"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankMessageText" ADD CONSTRAINT "BankMessageText_bankMessageId_fkey" FOREIGN KEY ("bankMessageId") REFERENCES "BankMessage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankMessageOutcome" ADD CONSTRAINT "BankMessageOutcome_bankMessageId_fkey" FOREIGN KEY ("bankMessageId") REFERENCES "BankMessage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentReview" ADD CONSTRAINT "PaymentReview_bankMessageId_fkey" FOREIGN KEY ("bankMessageId") REFERENCES "BankMessage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentReview" ADD CONSTRAINT "PaymentReview_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "TopupCard"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentReview" ADD CONSTRAINT "PaymentReview_intentId_fkey" FOREIGN KEY ("intentId") REFERENCES "PaymentIntent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
