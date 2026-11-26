-- Migration 10, part 1 (phase 5, S1): the TON payout ledger and the Fragment session death time.
-- Additive only: one enum (BOUNCED, owner decision A1, is part of it), one table, three nullable columns (FragmentSession.deadAt, Quote.providerRef,
-- Order.providerRef). Nothing is dropped or renamed, and no existing row is touched, so no data guard is needed. The CHECK constraints, partial unique
-- indexes and triggers of the new table are in part 2 (Prisma cannot express them).

-- CreateEnum
CREATE TYPE "TonTransferStatus" AS ENUM ('SIGNED', 'BROADCAST', 'CONFIRMED', 'ONCHAIN_FAILED', 'EXPIRED', 'CONSUMED_UNMATCHED', 'BOUNCED');

-- AlterTable
ALTER TABLE "FragmentSession" ADD COLUMN     "deadAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "TonTransfer" (
    "id" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "attemptId" TEXT,
    "network" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "seqno" INTEGER NOT NULL,
    "validUntil" TIMESTAMP(3) NOT NULL,
    "toAddress" TEXT NOT NULL,
    "amountNanoTon" BIGINT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "extMsgHash" TEXT NOT NULL,
    "bocBase64" TEXT NOT NULL,
    "status" "TonTransferStatus" NOT NULL,
    "txHash" TEXT,
    "txLt" BIGINT,
    "feeNanoTon" BIGINT,
    "confirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TonTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TonTransfer_attemptId_key" ON "TonTransfer"("attemptId");

-- CreateIndex
CREATE UNIQUE INDEX "TonTransfer_extMsgHash_key" ON "TonTransfer"("extMsgHash");

-- CreateIndex
CREATE UNIQUE INDEX "TonTransfer_txHash_key" ON "TonTransfer"("txHash");

-- CreateIndex
CREATE INDEX "TonTransfer_walletAddress_createdAt_idx" ON "TonTransfer"("walletAddress", "createdAt");

-- AddForeignKey
ALTER TABLE "TonTransfer" ADD CONSTRAINT "TonTransfer_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "FulfillmentAttempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AlterTable (owner decision R3): the recipient's provider-side id, kept next to the recipient JSON
-- (whose schema is strict and has no such key). Nullable: a quote or order made before the value
-- existed has none, and delivery then refuses it (RECIPIENT_GONE). Immutable by the guards of part 2.
ALTER TABLE "Quote" ADD COLUMN     "providerRef" TEXT;
ALTER TABLE "Order" ADD COLUMN     "providerRef" TEXT;
