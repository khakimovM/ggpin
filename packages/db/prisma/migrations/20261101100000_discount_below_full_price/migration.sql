-- A 100% discount can never be fulfilled: the purchase writes LedgerEntry(PURCHASE) whose
-- amount must be < 0 (and the matching REFUND must be > 0), so a fully discounted order
-- (discountTiyin = priceTiyin, or bps = 10000) would fail that CHECK inside the checkout
-- transaction. Reject it at the source instead: discounts stay strictly below the full price.
--
-- Only CHECK constraints are dropped and re-created (no column, table or data is touched). The
-- stricter versions were verified against every existing row first: DiscountTier.bps,
-- DiscountCode.bps and Order.discountTiyin all satisfy them (dev and test databases hold no
-- row at the old boundary), so re-adding validates cleanly.

ALTER TABLE "DiscountTier" DROP CONSTRAINT "DiscountTier_values_check";
ALTER TABLE "DiscountTier" ADD CONSTRAINT "DiscountTier_values_check" CHECK (
  "bps" >= 0 AND "bps" < 10000 AND "priceCoins" > 0
);

ALTER TABLE "DiscountCode" DROP CONSTRAINT "DiscountCode_bps_check";
ALTER TABLE "DiscountCode" ADD CONSTRAINT "DiscountCode_bps_check" CHECK (
  "bps" >= 0 AND "bps" < 10000
);

ALTER TABLE "Order" DROP CONSTRAINT "Order_discount_check";
ALTER TABLE "Order" ADD CONSTRAINT "Order_discount_check" CHECK (
  "discountTiyin" >= 0 AND "discountTiyin" < "priceTiyin"
);
