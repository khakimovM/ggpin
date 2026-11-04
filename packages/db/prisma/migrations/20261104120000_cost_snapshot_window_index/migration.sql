-- CostSnapshot is append-only and grows by a row per product (and pack) every few minutes. Two
-- reads filter on productId and a createdAt range while skuId is unconstrained or IS NULL:
--   * the catalog display read:  productId IN (...) AND createdAt BETWEEN since AND until
--   * the product-level latest:  productId = $1 AND skuId IS NULL ORDER BY createdAt DESC LIMIT 1
-- The existing (productId, skuId, createdAt) index cannot bound a createdAt range past an
-- unconstrained skuId, so both walked every row of the product. This index lets them read only
-- the recent rows. Non-destructive: only adds an index.

-- CreateIndex
CREATE INDEX "CostSnapshot_productId_createdAt_idx" ON "CostSnapshot"("productId", "createdAt");
