-- Domain guardrails (fix set B). Additive only: no column/table is dropped or renamed.
-- Part 1 is the Prisma-generated DDL; part 2 is raw SQL that Prisma cannot express
-- (triggers, CHECK constraints). Both dev and test databases had 0 rows in Order/FxRate/
-- LedgerEntry/CoinEntry/Quote when this was written, so NOT NULL "Order"."fxRateId" needs no backfill.

-- ============================================================================================
-- Part 1: schema changes (Prisma generated)
-- ============================================================================================

-- AlterEnum
ALTER TYPE "LedgerKind" ADD VALUE 'REFERRAL_BONUS_REVERSAL';

-- AlterTable
ALTER TABLE "Category" ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "DiscountTier" ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "FragmentSession" ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "fxRateId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "ProductRoute" ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "Setting" ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "Sku" ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateIndex
CREATE UNIQUE INDEX "FulfillmentAttempt_adapter_externalRef_key" ON "FulfillmentAttempt"("adapter", "externalRef");

-- CreateIndex
CREATE INDEX "Order_fxRateId_idx" ON "Order"("fxRateId");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_fxRateId_fkey" FOREIGN KEY ("fxRateId") REFERENCES "FxRate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================================================
-- Part 2a: append-only enforcement (row triggers)
-- ============================================================================================
-- BEFORE UPDATE OR DELETE row triggers. TRUNCATE does not fire row triggers, which is what the
-- test helpers rely on for cleanup. Production roles should additionally not hold TRUNCATE.

CREATE FUNCTION ggpin_forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "LedgerEntry_append_only" BEFORE UPDATE OR DELETE ON "LedgerEntry"
  FOR EACH ROW EXECUTE FUNCTION ggpin_forbid_mutation();
CREATE TRIGGER "CoinEntry_append_only" BEFORE UPDATE OR DELETE ON "CoinEntry"
  FOR EACH ROW EXECUTE FUNCTION ggpin_forbid_mutation();
CREATE TRIGGER "OrderEvent_append_only" BEFORE UPDATE OR DELETE ON "OrderEvent"
  FOR EACH ROW EXECUTE FUNCTION ggpin_forbid_mutation();
CREATE TRIGGER "AuditLog_append_only" BEFORE UPDATE OR DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION ggpin_forbid_mutation();

-- ============================================================================================
-- Part 2b: CHECK constraints
-- ============================================================================================
-- "kind"::text (not the enum literal) so the new REFERRAL_BONUS_REVERSAL value can be referenced
-- in the same transaction that adds it. ELSE false fails closed: a future kind must be added to
-- the constraint explicitly.

-- Ledger sign per kind (docs/03-DATA-MODEL.md, rules/40-domain-money.md).
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_amount_sign_check" CHECK (
  CASE "kind"::text
    WHEN 'TOPUP' THEN "amountTiyin" > 0
    WHEN 'REFUND' THEN "amountTiyin" > 0
    WHEN 'REFERRAL_BONUS' THEN "amountTiyin" > 0
    WHEN 'TOPUP_REVERSAL' THEN "amountTiyin" < 0
    WHEN 'PURCHASE' THEN "amountTiyin" < 0
    WHEN 'REFERRAL_BONUS_REVERSAL' THEN "amountTiyin" < 0
    WHEN 'ADJUSTMENT' THEN "amountTiyin" <> 0
    ELSE false
  END
);

-- Coin sign per kind. REVERSAL may undo an EARN (-) or a SPEND (+), so it is only non-zero.
ALTER TABLE "CoinEntry" ADD CONSTRAINT "CoinEntry_coins_sign_check" CHECK (
  CASE "kind"::text
    WHEN 'EARN' THEN "coins" > 0
    WHEN 'SPEND' THEN "coins" < 0
    WHEN 'EXPIRE' THEN "coins" < 0
    WHEN 'ADJUSTMENT' THEN "coins" <> 0
    WHEN 'REVERSAL' THEN "coins" <> 0
    ELSE false
  END
);

-- Amounts, prices, quantities.
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_amounts_check" CHECK (
  "quantity" > 0 AND "priceTiyin" > 0 AND "costMinor" > 0 AND "maxCostMinor" >= "costMinor"
);

ALTER TABLE "Order" ADD CONSTRAINT "Order_amounts_check" CHECK (
  "quantity" > 0 AND "priceTiyin" > 0 AND "costMinor" > 0 AND "maxCostMinor" >= "costMinor"
);
ALTER TABLE "Order" ADD CONSTRAINT "Order_discount_check" CHECK (
  "discountTiyin" >= 0 AND "discountTiyin" <= "priceTiyin"
);

ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_amount_check" CHECK ("amountTiyin" > 0);
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_amount_check" CHECK ("amountTiyin" > 0);

ALTER TABLE "Sku" ADD CONSTRAINT "Sku_amounts_check" CHECK (
  "quantity" > 0 AND "minMarginTiyin" >= 0 AND "markupBps" >= 0
);

ALTER TABLE "Product" ADD CONSTRAINT "Product_qty_check" CHECK (
  ("minQty" IS NULL OR "minQty" > 0)
  AND ("maxQty" IS NULL OR "maxQty" > 0)
  AND ("minQty" IS NULL OR "maxQty" IS NULL OR "minQty" <= "maxQty")
);

ALTER TABLE "Voucher" ADD CONSTRAINT "Voucher_cost_check" CHECK ("costMicroUsdt" > 0);

ALTER TABLE "FulfillmentAttempt" ADD CONSTRAINT "FulfillmentAttempt_values_check" CHECK (
  "attemptNo" > 0 AND ("costMinor" IS NULL OR "costMinor" >= 0)
);

ALTER TABLE "WalletSnapshot" ADD CONSTRAINT "WalletSnapshot_balances_check" CHECK (
  "tonNano" >= 0 AND "usdtMicro" >= 0
);

-- Promo: usage counters and rewards.
ALTER TABLE "BonusCode" ADD CONSTRAINT "BonusCode_usage_check" CHECK (
  "rewardValue" > 0 AND "maxUses" > 0 AND "usedCount" >= 0 AND "usedCount" <= "maxUses"
);

ALTER TABLE "DiscountTier" ADD CONSTRAINT "DiscountTier_values_check" CHECK (
  "bps" BETWEEN 0 AND 10000 AND "priceCoins" > 0
);
ALTER TABLE "DiscountCode" ADD CONSTRAINT "DiscountCode_bps_check" CHECK ("bps" BETWEEN 0 AND 10000);

-- FX rate is a decimal string parsed by money.ts (max 18 decimals, strictly positive).
ALTER TABLE "FxRate" ADD CONSTRAINT "FxRate_rate_check" CHECK (
  "rate" ~ '^[0-9]+(\.[0-9]{1,18})?$' AND "rate" !~ '^0+(\.0+)?$'
);

-- No self-referral.
ALTER TABLE "User" ADD CONSTRAINT "User_no_self_referral_check" CHECK (
  "referredById" IS NULL OR "referredById" <> "id"
);
