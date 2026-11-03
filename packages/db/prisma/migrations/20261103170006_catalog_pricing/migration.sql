/*
  Warnings:

  - Added the required column `costSnapshotId` to the `Quote` table without a default value. This is not possible if the table is not empty.

*/
-- Quote.costSnapshotId is NOT NULL and cannot be back-filled (a quote's cost snapshot is the one
-- that existed when it was issued, which we cannot reconstruct). Quotes expire in 10 minutes and are
-- not issued anywhere yet (phase 3), so the table must be empty; otherwise stop instead of guessing.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Quote") THEN
    RAISE EXCEPTION 'Quote is not empty: costSnapshotId cannot be back-filled (catalog_pricing)';
  END IF;
END $$;

-- AlterTable
ALTER TABLE "Quote" ADD COLUMN     "costSnapshotId" TEXT NOT NULL;

-- CreateTable
CREATE TABLE "CostSnapshot" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "skuId" TEXT,
    "adapter" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "basisQuantity" INTEGER NOT NULL,
    "costMinor" BIGINT NOT NULL,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CostSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CostSnapshot_productId_skuId_createdAt_idx" ON "CostSnapshot"("productId", "skuId", "createdAt");

-- CreateIndex
CREATE INDEX "CostSnapshot_skuId_idx" ON "CostSnapshot"("skuId");

-- CreateIndex
CREATE INDEX "Quote_costSnapshotId_idx" ON "Quote"("costSnapshotId");

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_costSnapshotId_fkey" FOREIGN KEY ("costSnapshotId") REFERENCES "CostSnapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CostSnapshot" ADD CONSTRAINT "CostSnapshot_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CostSnapshot" ADD CONSTRAINT "CostSnapshot_skuId_fkey" FOREIGN KEY ("skuId") REFERENCES "Sku"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================================================
-- CHECK constraints. A CHECK passes when it evaluates to NULL, so each one below is stated
-- against NOT NULL columns only (or uses IS NOT NULL explicitly), which makes it strictly
-- true/false.
-- ============================================================================================

-- All five columns are NOT NULL. skuId is nullable but not part of the check.
ALTER TABLE "CostSnapshot" ADD CONSTRAINT "CostSnapshot_values_check" CHECK (
  "costMinor" > 0 AND "basisQuantity" > 0
  AND "currency" IN ('TON', 'USDT')
  AND "adapter" <> '' AND "source" <> ''
);

-- pair and source are NOT NULL. Same list as FX_PAIRS in packages/shared.
ALTER TABLE "FxRate" ADD CONSTRAINT "FxRate_pair_check" CHECK (
  "pair" IN ('USDT_UZS', 'TON_USDT', 'TON_UZS') AND "source" <> ''
);

-- costCurrency is NOT NULL.
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_cost_currency_check" CHECK (
  "costCurrency" IN ('TON', 'USDT')
);

-- allowCustomQty is NOT NULL, so NOT allowCustomQty is never NULL; the right side is built from
-- IS NOT NULL tests on the nullable minQty/maxQty, so it is never NULL either. (Product_qty_check
-- already covers ordering and positivity.)
ALTER TABLE "Product" ADD CONSTRAINT "Product_custom_qty_check" CHECK (
  NOT "allowCustomQty" OR ("minQty" IS NOT NULL AND "maxQty" IS NOT NULL)
);

-- ============================================================================================
-- Immutability. Rows are only ever inserted; a correction is a new row. Only UPDATE is blocked:
-- DELETE of a referenced row is already refused by the RESTRICT foreign keys (Quote, Order), and
-- TRUNCATE (test cleanup) does not fire row triggers. Reuses ggpin_forbid_mutation() (SQLSTATE GG001).
-- ============================================================================================
CREATE TRIGGER "FxRate_no_update" BEFORE UPDATE ON "FxRate"
  FOR EACH ROW EXECUTE FUNCTION ggpin_forbid_mutation();
CREATE TRIGGER "CostSnapshot_no_update" BEFORE UPDATE ON "CostSnapshot"
  FOR EACH ROW EXECUTE FUNCTION ggpin_forbid_mutation();
