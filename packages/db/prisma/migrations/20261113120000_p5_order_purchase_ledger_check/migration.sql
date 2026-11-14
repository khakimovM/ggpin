-- Migration 11 (phase 5, S2 fix rounds; owner decision D-60 (1), review "outside S2", audit M1; at
-- the end: Order.id fixed and Order_no_delete, re-audit N1 and review N6):
-- an order and its PURCHASE ledger entry exist only together. The purchase writes both in one
-- transaction (Order(PAID) + LedgerEntry(PURCHASE, ORDER/<orderId>) under the wallet lock); until
-- now nothing in the database said so, while REFUNDED already needs its REFUND entry
-- (Order_refund_ledger_check). Raw SQL only: schema.prisma does not change. Additive: two functions
-- and two constraint triggers, then the two Order guards at the end; no column, index or row is
-- touched. The triggers fire on INSERT only, so rows written before this migration are not
-- re-checked.
--
-- Both checks are DEFERRED to COMMIT, like the other ledger checks (a row written later in the same
-- transaction counts), and both raise GG001 with a message that names the broken rule (docs/03):
--   * every new Order has exactly one LedgerEntry(kind PURCHASE, refType ORDER, refId = the order
--     id) of the order's own user for exactly what the order costs: amountTiyin =
--     -(priceTiyin - discountTiyin). "At most one" is the unique (refType, refId, kind) index.
--   * every new PURCHASE entry is that debit: refType ORDER, refId an order of the entry's own
--     user, the amount the order costs. So no PURCHASE without an order (or of another user, or of
--     another amount), even for an order written by an earlier transaction.
-- A sign or an amount that the CHECKs refuse (LedgerEntry_amount_sign_check) fails earlier, at the
-- INSERT. session_replication_role = replica switches these off like every trigger (tests only).

CREATE FUNCTION ggpin_order_purchase_ledger_check() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public."LedgerEntry" l
    WHERE l."refType" = 'ORDER' AND l."refId" = NEW."id" AND l."kind" = 'PURCHASE'
      AND l."userId" = NEW."userId"
      AND l."amountTiyin" = -(NEW."priceTiyin" - NEW."discountTiyin")
  ) THEN
    RAISE EXCEPTION 'Order % is created without its PURCHASE ledger entry for what it costs (-(price - discount), its own user)', NEW."id"
      USING ERRCODE = 'GG001';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "Order_purchase_ledger_check" AFTER INSERT ON "Order"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION ggpin_order_purchase_ledger_check();

CREATE FUNCTION ggpin_ledger_purchase_order_check() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW."refType" IS DISTINCT FROM 'ORDER' OR NOT EXISTS (
    SELECT 1 FROM public."Order" o
    WHERE o."id" = NEW."refId" AND o."userId" = NEW."userId"
      AND -(o."priceTiyin" - o."discountTiyin") = NEW."amountTiyin"
  ) THEN
    RAISE EXCEPTION 'LedgerEntry % is a PURCHASE that is not the debit of an order of its own user (refType ORDER, refId the order, amount -(price - discount))', NEW."id"
      USING ERRCODE = 'GG001';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "LedgerEntry_purchase_order_check" AFTER INSERT ON "LedgerEntry"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW."kind" = 'PURCHASE')
  EXECUTE FUNCTION ggpin_ledger_purchase_order_check();

-- ============================================================================================
-- Order: the id is part of the purchase, and an order is never deleted (S2 re-audit N1, review N6)
-- ============================================================================================

-- The checks above find an order's debit by its id (LedgerEntry.refId). If the id could change, an
-- order could be re-keyed and a new order written under the old id would be met by the old debit:
-- one PURCHASE, two refunds (re-audit probe D11b). So the id joins the fixed columns. The function
-- is the one of migration 10 (p5_orders_fulfillment_checks) word for word, plus the `id` line and
-- `id` in the message; the trigger "Order_immutable_guard" keeps calling it.
CREATE OR REPLACE FUNCTION ggpin_order_immutable_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."number" IS DISTINCT FROM OLD."number"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
     OR NEW."userId" IS DISTINCT FROM OLD."userId"
     OR NEW."quoteId" IS DISTINCT FROM OLD."quoteId"
     OR NEW."productId" IS DISTINCT FROM OLD."productId"
     OR NEW."skuId" IS DISTINCT FROM OLD."skuId"
     OR NEW."quantity" IS DISTINCT FROM OLD."quantity"
     OR NEW."recipient" IS DISTINCT FROM OLD."recipient"
     OR NEW."providerRef" IS DISTINCT FROM OLD."providerRef"
     OR NEW."priceTiyin" IS DISTINCT FROM OLD."priceTiyin"
     OR NEW."discountTiyin" IS DISTINCT FROM OLD."discountTiyin"
     OR NEW."costCurrency" IS DISTINCT FROM OLD."costCurrency"
     OR NEW."costMinor" IS DISTINCT FROM OLD."costMinor"
     OR NEW."maxCostMinor" IS DISTINCT FROM OLD."maxCostMinor"
     OR NEW."fxRateId" IS DISTINCT FROM OLD."fxRateId"
     OR NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey"
     OR NEW."requestHash" IS DISTINCT FROM OLD."requestHash" THEN
    RAISE EXCEPTION '% the purchase (id, number, createdAt, user, quote, product, sku, quantity, recipient, providerRef, price, discount, cost, ceiling, fx rate, key, request hash) is immutable',
      TG_TABLE_NAME
      USING ERRCODE = 'GG001', HINT = 'Only status, statusReason and deliveredAt change after INSERT.';
  END IF;
  RETURN NEW;
END;
$$;

-- An order is the record its ledger entries, events, attempts and transfers point to; deleting it
-- would orphan a debit or a refund. Its children already restrict a delete by foreign key, but an
-- order without children (a bare PAID order) had nothing. TRUNCATE does not fire row triggers, so
-- the test cleanup keeps working; no application code deletes an order.
CREATE FUNCTION ggpin_order_no_delete_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'Order % is never deleted: it is the record of a purchase and its ledger entries', OLD."id"
    USING ERRCODE = 'GG001';
END;
$$;

CREATE TRIGGER "Order_no_delete" BEFORE DELETE ON "Order"
  FOR EACH ROW EXECUTE FUNCTION ggpin_order_no_delete_guard();
