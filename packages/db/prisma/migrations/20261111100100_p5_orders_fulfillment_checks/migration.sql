-- Migration 10, part 2 (phase 5, S1): CHECK constraints, partial unique indexes and guard triggers
-- for the order and fulfillment tables. Raw SQL because Prisma cannot express them.
-- Additive only: no column or table is dropped or renamed. Order, Quote, FulfillmentAttempt,
-- FragmentSession and TonTransfer have no writer yet (the first one is phase 5), so no existing
-- row can violate a new rule.
--
-- This file is the DATABASE's second line of defence: the helpers of @repo/db (transitionOrder,
-- refundFailedOrder, resolveNeedsReview) enforce the same rules first, and these guards hold even
-- if a path skips them. Every guard raises SQLSTATE GG001 ("immutable row or forbidden change",
-- docs/03). The allowed status edges live in three IMMUTABLE functions (`ggpin_*_edge_allowed`)
-- that a test compares with ORDER_TRANSITIONS of @repo/shared, so the two cannot drift apart.
--
-- NULL safety: every nullable column is tested with an explicit IS [NOT] NULL inside its CHECK,
-- so a CHECK never passes by evaluating to NULL. Partial index predicates use enum literals
-- (`"status" IN ('SIGNED', ...)`), not `::text` casts: index predicates must be IMMUTABLE.
--
-- search_path (audit N5): every function below, and the phase-4 guard functions at the end of this
-- file, runs with `SET search_path = public, pg_temp`. Without it a session could create a TEMP
-- table named like a guarded table ("FulfillmentAttempt") that pg_temp-first name resolution would
-- find before the real one, and the guard would look at an empty table. The table names inside
-- the bodies are also schema-qualified.
--
-- Races (audit N1, review R1): Postgres checks "does a live payout exist?" with a plain read, and
-- a foreign-key lock (FOR KEY SHARE) does not conflict with a status UPDATE, so two transactions
-- could each pass their own check. The INSERT guards therefore take FOR SHARE on the rows whose
-- state they test, which DOES conflict with the UPDATE of a status: one side waits for the other
-- to commit and then sees it. Lock order everywhere (helpers and guards): wallet -> order ->
-- attempt -> transfer.

-- The one number of the "never sent" waiting period. TON_NOT_SENT_MARGIN_MS of @repo/shared must
-- equal it (a test compares them): a transfer is EXPIRED only this long after `validUntil`.
CREATE FUNCTION ggpin_ton_not_sent_margin_ms() RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT 60000
$$;

-- A DELETE of a row that is the proof of a payout is never allowed (SQLSTATE GG001).
CREATE FUNCTION ggpin_forbid_delete_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION '% rows are never deleted: they are the proof of a payout', TG_TABLE_NAME
    USING ERRCODE = 'GG001';
END;
$$;

-- ============================================================================================
-- TonTransfer: one row per signed external message of the hot wallet
-- ============================================================================================

ALTER TABLE "TonTransfer" ADD CONSTRAINT "TonTransfer_purpose_check" CHECK (
  "purpose" IN ('ORDER', 'SELFTEST')
);
-- An order payout always belongs to an attempt; a self-test (testnet, no order) never does.
ALTER TABLE "TonTransfer" ADD CONSTRAINT "TonTransfer_attempt_purpose_check" CHECK (
  ("purpose" = 'ORDER') = ("attemptId" IS NOT NULL)
);
ALTER TABLE "TonTransfer" ADD CONSTRAINT "TonTransfer_network_check" CHECK (
  "network" IN ('mainnet', 'testnet')
);
-- A self-test never touches the real wallet's network.
ALTER TABLE "TonTransfer" ADD CONSTRAINT "TonTransfer_selftest_network_check" CHECK (
  "purpose" <> 'SELFTEST' OR "network" = 'testnet'
);
ALTER TABLE "TonTransfer" ADD CONSTRAINT "TonTransfer_values_check" CHECK (
  "seqno" >= 0
  AND "amountNanoTon" > 0
  AND ("feeNanoTon" IS NULL OR "feeNanoTon" >= 0)
);
-- A transfer seen on the chain (CONFIRMED; ONCHAIN_FAILED, whose action phase failed; BOUNCED, whose
-- value came back) always has the transaction hash AND the logical time of OUR transaction (audit
-- I4: ONCHAIN_FAILED without a logical time could be completed later; owner decision A1 for BOUNCED).
ALTER TABLE "TonTransfer" ADD CONSTRAINT "TonTransfer_chain_tx_check" CHECK (
  "status" NOT IN ('CONFIRMED', 'ONCHAIN_FAILED', 'BOUNCED') OR "txHash" IS NOT NULL
);
ALTER TABLE "TonTransfer" ADD CONSTRAINT "TonTransfer_chain_lt_check" CHECK (
  "status" NOT IN ('CONFIRMED', 'ONCHAIN_FAILED', 'BOUNCED') OR "txLt" IS NOT NULL
);
-- The chain data (audit N7) is the transaction of OUR message: it exists only once the message
-- was seen executed (CONFIRMED, ONCHAIN_FAILED when its action phase failed, BOUNCED when the
-- destination sent the value back). A message that is signed, broadcast, expired or whose seqno was
-- consumed WITHOUT a transaction of ours (CONSUMED_UNMATCHED: by definition no transaction was
-- found, docs/06) carries none; the data is written on the edge that finds the transaction.
ALTER TABLE "TonTransfer" ADD CONSTRAINT "TonTransfer_chain_fields_check" CHECK (
  "status" IN ('CONFIRMED', 'ONCHAIN_FAILED', 'BOUNCED')
  OR ("txHash" IS NULL AND "txLt" IS NULL AND "feeNanoTon" IS NULL AND "confirmedAt" IS NULL)
);
-- One spelling per account and per hash (audit M2, N6): a TON account has three textual forms
-- (raw, bounceable, non-bounceable) that all name the same wallet, so a fence keyed on the text
-- could be passed by re-spelling the address. Only the RAW form `<workchain>:<64 hex>` and
-- lowercase hex hashes are stored; the worker converts at the edge. The workchain is `0` or `-1`
-- literally: `00`, `000` and `-0` spell the same chain and would pass a numeric pattern.
-- RAW_TON_ADDRESS_PATTERN / TON_HASH_PATTERN of @repo/shared are the same patterns.
ALTER TABLE "TonTransfer" ADD CONSTRAINT "TonTransfer_address_format_check" CHECK (
  "walletAddress" ~ '^(0|-1):[0-9a-f]{64}$' AND "toAddress" ~ '^(0|-1):[0-9a-f]{64}$'
);
ALTER TABLE "TonTransfer" ADD CONSTRAINT "TonTransfer_hash_format_check" CHECK (
  "extMsgHash" ~ '^[0-9a-f]{64}$'
  AND "payloadHash" ~ '^[0-9a-f]{64}$'
  AND ("txHash" IS NULL OR "txHash" ~ '^[0-9a-f]{64}$')
);

-- A wallet has at most ONE unresolved message at a time, per network (audit F14). This is the
-- fence that does not depend on Redis: even if the cooperative lock is lost, a second message
-- cannot be signed.
CREATE UNIQUE INDEX "TonTransfer_wallet_unresolved_key" ON "TonTransfer" ("network", "walletAddress")
  WHERE "status" IN ('SIGNED', 'BROADCAST');
-- A seqno is used by at most one live message; only an EXPIRED message (provably never accepted)
-- frees its seqno for a new one.
CREATE UNIQUE INDEX "TonTransfer_wallet_seqno_live_key" ON "TonTransfer" ("network", "walletAddress", "seqno")
  WHERE "status" <> 'EXPIRED';

-- The status machine of a transfer. SIGNED and BROADCAST are unresolved; EXPIRED means "provably
-- never accepted" and may only be overturned by a late-found transaction (CONFIRMED);
-- CONSUMED_UNMATCHED (the seqno moved without a message of ours) is resolved only by finding OUR
-- transaction (CONFIRMED): it never becomes ONCHAIN_FAILED, because that would let a made-up failed
-- transaction turn "unknown where the money went" into a refundable state (audit R2a2, owner
-- decision A2); BOUNCED (owner decision A1) is reached from BROADCAST by the classifier, and from
-- CONFIRMED when a bounce is found late. CONFIRMED -> BOUNCED is guarded separately (below).
-- ONCHAIN_FAILED, BOUNCED and (apart from a late CONFIRMED) the others are final.
CREATE FUNCTION ggpin_ton_transfer_edge_allowed(from_status "TonTransferStatus", to_status "TonTransferStatus")
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT CASE from_status
    WHEN 'SIGNED' THEN to_status IN ('BROADCAST', 'EXPIRED', 'CONFIRMED', 'ONCHAIN_FAILED', 'CONSUMED_UNMATCHED')
    WHEN 'BROADCAST' THEN to_status IN ('EXPIRED', 'CONFIRMED', 'ONCHAIN_FAILED', 'CONSUMED_UNMATCHED', 'BOUNCED')
    WHEN 'CONSUMED_UNMATCHED' THEN to_status = 'CONFIRMED'
    WHEN 'EXPIRED' THEN to_status = 'CONFIRMED'
    WHEN 'CONFIRMED' THEN to_status = 'BOUNCED'
    ELSE false
  END
$$;

-- A transfer is born SIGNED, and only for an attempt that is still SENDING of an order that is
-- still PROCESSING (audit N1, review R1: a worker that stalled and wakes up after an operator
-- failed and refunded the order must not sign a payment). `createdAt` is the database's clock, set
-- here whatever the client sent (audit L8: a backdated row would dodge the age rule of the review
-- helper). Its signed message never changes, its status only follows the machine above, it becomes
-- EXPIRED only after the margin past `validUntil` (audit N2), it becomes BOUNCED only while its
-- order is still PROCESSING or NEEDS_REVIEW (a BOUNCED transfer never belongs to a DELIVERED or
-- REFUNDED order: the order row is locked FOR SHARE, so a concurrent delivery either commits first
-- and refuses the bounce, or waits and then sees it), and the chain data is written once.
CREATE FUNCTION ggpin_ton_transfer_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'SIGNED' THEN
      RAISE EXCEPTION '% is created SIGNED, not %', TG_TABLE_NAME, NEW."status"
        USING ERRCODE = 'GG001';
    END IF;
    NEW."createdAt" := timezone('UTC', now());
    IF NEW."purpose" = 'ORDER' THEN
      -- Order row first, then the attempt row (lock order). The attempt's order never changes.
      PERFORM 1 FROM public."Order" o
        WHERE o."id" = (SELECT a."orderId" FROM public."FulfillmentAttempt" a WHERE a."id" = NEW."attemptId")
          AND o."status" = 'PROCESSING'
        FOR SHARE;
      IF NOT FOUND AND EXISTS (SELECT 1 FROM public."FulfillmentAttempt" a WHERE a."id" = NEW."attemptId") THEN
        RAISE EXCEPTION '% can only be signed for an order that is PROCESSING', TG_TABLE_NAME
          USING ERRCODE = 'GG001';
      END IF;
      PERFORM 1 FROM public."FulfillmentAttempt" a
        WHERE a."id" = NEW."attemptId" AND a."status" = 'SENDING'
        FOR SHARE;
      IF NOT FOUND AND EXISTS (SELECT 1 FROM public."FulfillmentAttempt" a WHERE a."id" = NEW."attemptId") THEN
        RAISE EXCEPTION '% can only be signed for an attempt that is SENDING', TG_TABLE_NAME
          USING ERRCODE = 'GG001';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."attemptId" IS DISTINCT FROM OLD."attemptId"
     OR NEW."purpose" IS DISTINCT FROM OLD."purpose"
     OR NEW."network" IS DISTINCT FROM OLD."network"
     OR NEW."walletAddress" IS DISTINCT FROM OLD."walletAddress"
     OR NEW."seqno" IS DISTINCT FROM OLD."seqno"
     OR NEW."validUntil" IS DISTINCT FROM OLD."validUntil"
     OR NEW."toAddress" IS DISTINCT FROM OLD."toAddress"
     OR NEW."amountNanoTon" IS DISTINCT FROM OLD."amountNanoTon"
     OR NEW."payloadHash" IS DISTINCT FROM OLD."payloadHash"
     OR NEW."extMsgHash" IS DISTINCT FROM OLD."extMsgHash"
     OR NEW."bocBase64" IS DISTINCT FROM OLD."bocBase64"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION '% the signed message (attempt, purpose, network, wallet, seqno, validUntil, toAddress, amountNanoTon, payloadHash, extMsgHash, bocBase64, createdAt) is immutable',
      TG_TABLE_NAME
      USING ERRCODE = 'GG001', HINT = 'Only status and the chain data change after INSERT.';
  END IF;
  -- The chain data is written once: a transaction that was recorded is never rewritten.
  IF (OLD."txHash" IS NOT NULL AND NEW."txHash" IS DISTINCT FROM OLD."txHash")
     OR (OLD."txLt" IS NOT NULL AND NEW."txLt" IS DISTINCT FROM OLD."txLt")
     OR (OLD."feeNanoTon" IS NOT NULL AND NEW."feeNanoTon" IS DISTINCT FROM OLD."feeNanoTon")
     OR (OLD."confirmedAt" IS NOT NULL AND NEW."confirmedAt" IS DISTINCT FROM OLD."confirmedAt") THEN
    RAISE EXCEPTION '% txHash, txLt, feeNanoTon and confirmedAt are written once', TG_TABLE_NAME
      USING ERRCODE = 'GG001';
  END IF;
  IF NEW."status" <> OLD."status" THEN
    IF NOT ggpin_ton_transfer_edge_allowed(OLD."status", NEW."status") THEN
      RAISE EXCEPTION '% status % -> % is not allowed', TG_TABLE_NAME, OLD."status", NEW."status"
        USING ERRCODE = 'GG001';
    END IF;
    -- "Provably never accepted" needs the message to be past its validity by the margin: `validUntil`
    -- is a UTC timestamp without zone (Prisma), so now() is converted to UTC before comparing.
    IF NEW."status" = 'EXPIRED'
       AND timezone('UTC', now()) < NEW."validUntil" + ggpin_ton_not_sent_margin_ms() * interval '1 millisecond' THEN
      RAISE EXCEPTION '% cannot expire before validUntil + the margin (% ms)',
        TG_TABLE_NAME, ggpin_ton_not_sent_margin_ms()
        USING ERRCODE = 'GG001';
    END IF;
    IF NEW."status" = 'BOUNCED' AND NEW."purpose" = 'ORDER' THEN
      PERFORM 1 FROM public."Order" o
        WHERE o."id" = (SELECT a."orderId" FROM public."FulfillmentAttempt" a WHERE a."id" = NEW."attemptId")
          AND o."status" IN ('PROCESSING', 'NEEDS_REVIEW')
        FOR SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION '% can only become BOUNCED while its order is PROCESSING or NEEDS_REVIEW', TG_TABLE_NAME
          USING ERRCODE = 'GG001';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "TonTransfer_guard" BEFORE INSERT OR UPDATE ON "TonTransfer"
  FOR EACH ROW EXECUTE FUNCTION ggpin_ton_transfer_guard();
CREATE TRIGGER "TonTransfer_no_delete" BEFORE DELETE ON "TonTransfer"
  FOR EACH ROW EXECUTE FUNCTION ggpin_forbid_delete_guard();

-- ============================================================================================
-- FulfillmentAttempt: one live attempt per order, a monotone status, a fixed identity
-- ============================================================================================

-- SENDING / SENT / UNKNOWN / CONFIRMED are the attempts that are in flight or already paid. A
-- second one for the same order would be a second payment in flight, or a payment after a
-- confirmed one (rules/45: never create a new payment while an earlier attempt is unresolved).
CREATE UNIQUE INDEX "FulfillmentAttempt_order_active_key" ON "FulfillmentAttempt" ("orderId")
  WHERE "status" IN ('SENDING', 'SENT', 'UNKNOWN', 'CONFIRMED');

ALTER TABLE "FulfillmentAttempt" ADD CONSTRAINT "FulfillmentAttempt_confirmed_ref_check" CHECK (
  "status" <> 'CONFIRMED' OR "externalRef" IS NOT NULL
);

-- Forward only: an attempt that failed is never revived, a confirmed one never reopened.
CREATE FUNCTION ggpin_attempt_edge_allowed(from_status "AttemptStatus", to_status "AttemptStatus")
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT CASE from_status
    WHEN 'SENDING' THEN to_status IN ('SENT', 'UNKNOWN', 'CONFIRMED', 'FAILED')
    WHEN 'SENT' THEN to_status IN ('UNKNOWN', 'CONFIRMED', 'FAILED')
    WHEN 'UNKNOWN' THEN to_status IN ('CONFIRMED', 'FAILED')
    ELSE false
  END
$$;

-- An attempt is born SENDING, and only for an order that is PROCESSING at that moment (audit N1,
-- review R1): the order row is locked FOR SHARE, so an operator who fails the order concurrently
-- either commits first (this INSERT then sees FAILED and is refused) or waits for this INSERT and
-- is refused by the order guard (it sees the live attempt). `createdAt` is the database's clock (audit
-- L8). Afterwards the identity is fixed, the reference of the payout is written once and only while
-- the attempt is in flight, the status only moves forward, and FAILED needs the transfer, if any,
-- to be provably EXPIRED, or one of the three that only a resolved review may close (below).
CREATE FUNCTION ggpin_attempt_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'SENDING' THEN
      RAISE EXCEPTION '% is created SENDING, not %', TG_TABLE_NAME, NEW."status"
        USING ERRCODE = 'GG001';
    END IF;
    PERFORM 1 FROM public."Order" o
      WHERE o."id" = NEW."orderId" AND o."status" = 'PROCESSING'
      FOR SHARE;
    -- An order that does not exist is the foreign key's business (it raises a clearer error).
    IF NOT FOUND AND EXISTS (SELECT 1 FROM public."Order" o WHERE o."id" = NEW."orderId") THEN
      RAISE EXCEPTION '% can only be created for an order that is PROCESSING', TG_TABLE_NAME
        USING ERRCODE = 'GG001';
    END IF;
    NEW."createdAt" := timezone('UTC', now());
    RETURN NEW;
  END IF;
  IF NEW."orderId" IS DISTINCT FROM OLD."orderId"
     OR NEW."attemptNo" IS DISTINCT FROM OLD."attemptNo"
     OR NEW."adapter" IS DISTINCT FROM OLD."adapter"
     OR NEW."request" IS DISTINCT FROM OLD."request"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION '% order, attemptNo, adapter, request and createdAt are immutable', TG_TABLE_NAME
      USING ERRCODE = 'GG001';
  END IF;
  -- The reference of the payout is written once (the first write is the SENDING commit), and only
  -- while the attempt is alive: a FAILED or CONFIRMED attempt is a closed claim.
  IF NEW."externalRef" IS DISTINCT FROM OLD."externalRef" THEN
    IF OLD."externalRef" IS NOT NULL THEN
      RAISE EXCEPTION '% externalRef is written once', TG_TABLE_NAME USING ERRCODE = 'GG001';
    END IF;
    IF OLD."status" NOT IN ('SENDING', 'SENT', 'UNKNOWN') THEN
      RAISE EXCEPTION '% externalRef cannot be written on a % attempt', TG_TABLE_NAME, OLD."status"
        USING ERRCODE = 'GG001';
    END IF;
  END IF;
  IF NEW."status" <> OLD."status" THEN
    IF NOT ggpin_attempt_edge_allowed(OLD."status", NEW."status") THEN
      RAISE EXCEPTION '% status % -> % is not allowed', TG_TABLE_NAME, OLD."status", NEW."status"
        USING ERRCODE = 'GG001';
    END IF;
    -- "Failed" claims that nothing was paid: it needs the transfer, if any, to be provably EXPIRED.
    -- The exception (owner decision A4) is a transfer that failed on the chain (ONCHAIN_FAILED), was
    -- bounced (BOUNCED) or lost its seqno to an unknown transaction (CONSUMED_UNMATCHED): such an
    -- attempt may be closed only while its order is NEEDS_REVIEW, i.e. inside resolveNeedsReview,
    -- whose owner-only proof decides it. The order is read without a lock (the helper already holds
    -- it; the order guard checks the rest).
    IF NEW."status" = 'FAILED' AND EXISTS (
      SELECT 1 FROM public."TonTransfer" t
      WHERE t."attemptId" = NEW."id" AND t."status" <> 'EXPIRED'
        AND NOT (
          t."status" IN ('ONCHAIN_FAILED', 'BOUNCED', 'CONSUMED_UNMATCHED')
          AND EXISTS (
            SELECT 1 FROM public."Order" o WHERE o."id" = NEW."orderId" AND o."status" = 'NEEDS_REVIEW'
          )
        )
    ) THEN
      RAISE EXCEPTION '% cannot fail while its TON transfer is not EXPIRED', TG_TABLE_NAME
        USING ERRCODE = 'GG001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "FulfillmentAttempt_guard" BEFORE INSERT OR UPDATE ON "FulfillmentAttempt"
  FOR EACH ROW EXECUTE FUNCTION ggpin_attempt_guard();
CREATE TRIGGER "FulfillmentAttempt_no_delete" BEFORE DELETE ON "FulfillmentAttempt"
  FOR EACH ROW EXECUTE FUNCTION ggpin_forbid_delete_guard();

-- "Attempt CONFIRMED" means "delivery confirmed" (D-59 N1, owner decision B): an attempt may become
-- CONFIRMED only in a transaction that also leaves its order DELIVERED. Without this a late bounce
-- (the transfer CONFIRMED -> BOUNCED) found beside a CONFIRMED attempt of an order that is not
-- DELIVERED had no way out: a CONFIRMED attempt is final, FAILED refuses it, DELIVERED refuses the
-- bounced transfer. So the attempt stays SENT/UNKNOWN until the order is DELIVERED, and a bounce
-- found before that is settled by the TON_BOUNCED proof. The check is DEFERRED to COMMIT (the
-- attempt and the order are written in either order inside the transaction) and fires only in
-- the transaction that makes the attempt CONFIRMED, so a later DELIVERED -> REFUNDED (the attempt
-- stays CONFIRMED) is not touched.
-- The attempt's OWN transfer (Z3): none, or CONFIRMED, is fine (a supplier attempt has no TON
-- transfer); SIGNED, BROADCAST, CONSUMED_UNMATCHED or BOUNCED never; EXPIRED or ONCHAIN_FAILED (the
-- payout did not go out, so only the owner delivering by hand, outside the system, can confirm it)
-- need an ORDER_REVIEW_RESOLVE audit row of the order with a MANUAL proof carried by an OWNER with a
-- verified OTP. The row is a trace, not a boundary (audit I1): the check does not prove it was written
-- by this transaction or by the review path; resolveNeedsReview writes it in the same transaction.
CREATE FUNCTION ggpin_attempt_confirmed_check() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  own_status "TonTransferStatus";
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public."Order" o WHERE o."id" = NEW."orderId" AND o."status" = 'DELIVERED'
  ) THEN
    RAISE EXCEPTION 'FulfillmentAttempt % is CONFIRMED but its order is not DELIVERED: an attempt is confirmed only together with the delivery', NEW."id"
      USING ERRCODE = 'GG001';
  END IF;
  SELECT t."status" INTO own_status FROM public."TonTransfer" t WHERE t."attemptId" = NEW."id";
  IF FOUND THEN
    IF own_status IN ('SIGNED', 'BROADCAST', 'CONSUMED_UNMATCHED', 'BOUNCED') THEN
      RAISE EXCEPTION 'FulfillmentAttempt % cannot be CONFIRMED beside its % TON transfer', NEW."id", own_status
        USING ERRCODE = 'GG001';
    END IF;
    IF own_status IN ('EXPIRED', 'ONCHAIN_FAILED') AND NOT EXISTS (
      SELECT 1 FROM public."AuditLog" l
      WHERE l."targetType" = 'Order' AND l."targetId" = NEW."orderId" AND l."action" = 'ORDER_REVIEW_RESOLVE'
        AND l."after" -> 'proof' ->> 'kind' = 'MANUAL'
        AND l."after" -> 'otpVerified' = 'true'::jsonb
        AND l."after" -> 'operator' ->> 'role' = 'OWNER'
    ) THEN
      RAISE EXCEPTION 'FulfillmentAttempt % cannot be CONFIRMED beside its % TON transfer without the owner MANUAL proof', NEW."id", own_status
        USING ERRCODE = 'GG001';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "FulfillmentAttempt_confirmed_check" AFTER UPDATE OF "status" ON "FulfillmentAttempt"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW."status" = 'CONFIRMED' AND OLD."status" IS DISTINCT FROM NEW."status")
  EXECUTE FUNCTION ggpin_attempt_confirmed_check();
-- Defence in depth: the BEFORE guard already refuses an attempt created CONFIRMED (it is created
-- SENDING), so this INSERT variant is not reachable today.
CREATE CONSTRAINT TRIGGER "FulfillmentAttempt_confirmed_insert_check" AFTER INSERT ON "FulfillmentAttempt"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW."status" = 'CONFIRMED')
  EXECUTE FUNCTION ggpin_attempt_confirmed_check();

-- ============================================================================================
-- FragmentSession: a known state, and a single ACTIVE session
-- ============================================================================================

ALTER TABLE "FragmentSession" ADD CONSTRAINT "FragmentSession_status_check" CHECK (
  "status" IN ('ACTIVE', 'DEAD')
);
-- `((true))` indexes a constant, so any two ACTIVE rows collide: at most one live session.
CREATE UNIQUE INDEX "FragmentSession_single_active_key" ON "FragmentSession" ((true))
  WHERE "status" = 'ACTIVE';

-- ============================================================================================
-- Order: delivered means a delivery time, a closed reason list, one door per status, a fixed purchase
-- ============================================================================================

ALTER TABLE "Order" ADD CONSTRAINT "Order_delivered_at_check" CHECK (
  "status" <> 'DELIVERED' OR "deliveredAt" IS NOT NULL
);
-- Must equal ORDER_STATUS_REASONS in @repo/shared (a test compares them).
ALTER TABLE "Order" ADD CONSTRAINT "Order_status_reason_check" CHECK (
  "statusReason" IS NULL OR "statusReason" IN (
    'PRICE_ABOVE_MAX', 'LIMIT_PER_ORDER', 'LIMIT_DAILY', 'LOW_BALANCE', 'NO_ADAPTER',
    'RECIPIENT_CHANGED', 'RECIPIENT_GONE', 'ADAPTER_ERROR', 'CONFIRM_TIMEOUT', 'HELD_EXPIRED'
  )
);

-- The union over all actors of ORDER_TRANSITIONS (packages/shared/src/order-state.ts); WHO may
-- take an edge stays in application code, the database only knows which edges exist.
CREATE FUNCTION ggpin_order_edge_allowed(from_status "OrderStatus", to_status "OrderStatus")
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT CASE from_status
    WHEN 'PAID' THEN to_status IN ('QUEUED', 'CANCELLED')
    WHEN 'QUEUED' THEN to_status IN ('PROCESSING', 'CANCELLED')
    WHEN 'PROCESSING' THEN to_status IN ('DELIVERED', 'FAILED', 'HELD', 'NEEDS_REVIEW')
    WHEN 'HELD' THEN to_status IN ('QUEUED', 'FAILED', 'CANCELLED')
    WHEN 'NEEDS_REVIEW' THEN to_status IN ('DELIVERED', 'FAILED')
    WHEN 'DELIVERED' THEN to_status = 'REFUNDED'
    WHEN 'FAILED' THEN to_status = 'REFUNDED'
    WHEN 'CANCELLED' THEN to_status = 'REFUNDED'
    ELSE false
  END
$$;

-- An order is created PAID (inside the purchase transaction), for the recipient its quote was made
-- for (audit Y6: the order's `recipient` and `providerRef` equal the quote's, so the payout cannot go
-- to somebody else than the person the customer confirmed), and its status follows the machine.
--
-- Failing, holding, cancelling or refunding-as-unsent is a claim that nothing was paid out: it is
-- refused while an attempt is in flight or confirmed, or while ANY transfer of the order is not
-- provably EXPIRED (signed, broadcast, confirmed, failed on chain, bounced, or its seqno consumed
-- without a match: audit N1). One exception (owner decision A4, D-59), and only inside the review
-- resolution: NEEDS_REVIEW -> FAILED and FAILED -> REFUNDED do not stop at a transfer that is
-- ONCHAIN_FAILED, BOUNCED or CONSUMED_UNMATCHED, because the owner-only proof of
-- resolveNeedsReview is the way out of those three; HELD and CANCELLED, and every other edge, stay
-- blocked, and the deferred check below demands that proof's audit row at COMMIT. The helpers
-- (transitionOrder, refundFailedOrder) still refuse the three without the proof.
-- REFUNDED is checked too, so a payout that appears between FAILED and the refund (the late
-- worker of audit N1, a late-found transaction) stops the refund.
--
-- DELIVERED means a confirmed payout (audit Y1, L5): the order needs a CONFIRMED attempt, no attempt
-- still waiting for an outcome, and every transfer CONFIRMED, EXPIRED or ONCHAIN_FAILED (none
-- signed, broadcast, consumed-unmatched or bounced). A BOUNCED transfer therefore never belongs to
-- a DELIVERED order. The delivery time is the database's clock (audit Y11), so `deliveredAt` cannot
-- be backdated by a caller. A DELIVERED order may still be refunded by an admin although its payout
-- is confirmed, but not while an attempt is in flight or a transfer is signed, broadcast,
-- consumed-unmatched or bounced (a refund beside a payout that may still land).
CREATE FUNCTION ggpin_order_status_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  review_exit boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'PAID' THEN
      RAISE EXCEPTION '% is created PAID, not %', TG_TABLE_NAME, NEW."status" USING ERRCODE = 'GG001';
    END IF;
    -- An order is born undelivered (Z1: deliveredAt is stamped only by the move to DELIVERED) and its
    -- creation time is the database's, like an attempt's and a transfer's (L8): the caller's is ignored.
    IF NEW."deliveredAt" IS NOT NULL THEN
      RAISE EXCEPTION '% is created without deliveredAt (it is set by the move to DELIVERED)', TG_TABLE_NAME
        USING ERRCODE = 'GG001';
    END IF;
    NEW."createdAt" := timezone('UTC', now());
    -- A quote that does not exist is the foreign key's business (it raises a clearer error).
    -- Every column the quote fixed must be the order's too (audit Z4): owner, product, sku, quantity,
    -- recipient, providerRef, price, cost, ceiling and FX snapshot. The quote stores no discount
    -- amount (only discountCodeId, docs/03), so without a discount code the order's discount is 0;
    -- how a code's amount is bound is decided with discount codes (phase 10).
    IF EXISTS (SELECT 1 FROM public."Quote" q WHERE q."id" = NEW."quoteId") AND NOT EXISTS (
      SELECT 1 FROM public."Quote" q
      WHERE q."id" = NEW."quoteId"
        AND q."userId" = NEW."userId"
        AND q."productId" = NEW."productId"
        AND q."skuId" IS NOT DISTINCT FROM NEW."skuId"
        AND q."quantity" = NEW."quantity"
        AND q."recipient" = NEW."recipient"
        AND q."providerRef" IS NOT DISTINCT FROM NEW."providerRef"
        AND q."priceTiyin" = NEW."priceTiyin"
        AND q."costCurrency" = NEW."costCurrency"
        AND q."costMinor" = NEW."costMinor"
        AND q."maxCostMinor" = NEW."maxCostMinor"
        AND q."fxRateId" = NEW."fxRateId"
        AND (q."discountCodeId" IS NOT NULL OR NEW."discountTiyin" = 0)
    ) THEN
      RAISE EXCEPTION '% must equal its quote (user, product, sku, quantity, recipient, providerRef, price, cost, ceiling, fx rate, no discount without a code)', TG_TABLE_NAME
        USING ERRCODE = 'GG001';
    END IF;
    -- Nor is an order created from a quote that has expired (audit R4-3), judged by the clock at the
    -- moment of the write like the quote's own usedAt guard (Y5). A backstop: the purchase path checks
    -- the expiry first and marks the quote used in the same transaction.
    IF EXISTS (
      SELECT 1 FROM public."Quote" q
      WHERE q."id" = NEW."quoteId" AND timezone('UTC', clock_timestamp()) > q."expiresAt"
    ) THEN
      RAISE EXCEPTION '% cannot be created from an expired quote', TG_TABLE_NAME USING ERRCODE = 'GG001';
    END IF;
    RETURN NEW;
  END IF;
  -- deliveredAt (audit Z1) is stamped once, by the move to DELIVERED below, and never changes:
  -- not on a DELIVERED order (it keeps its delivery time through a later refund), and not written on
  -- an order that is not DELIVERED.
  IF NOT (NEW."status" = 'DELIVERED' AND OLD."status" <> 'DELIVERED')
     AND NEW."deliveredAt" IS DISTINCT FROM OLD."deliveredAt" THEN
    RAISE EXCEPTION '% deliveredAt is set only by the move to DELIVERED and never changes', TG_TABLE_NAME
      USING ERRCODE = 'GG001';
  END IF;
  IF NEW."status" = OLD."status" THEN
    RETURN NEW;
  END IF;
  IF NOT ggpin_order_edge_allowed(OLD."status", NEW."status") THEN
    RAISE EXCEPTION '% status % -> % is not allowed', TG_TABLE_NAME, OLD."status", NEW."status"
      USING ERRCODE = 'GG001';
  END IF;
  IF NEW."status" IN ('FAILED', 'HELD', 'CANCELLED') OR (NEW."status" = 'REFUNDED' AND OLD."status" <> 'DELIVERED') THEN
    review_exit := (OLD."status" = 'NEEDS_REVIEW' AND NEW."status" = 'FAILED')
      OR (OLD."status" = 'FAILED' AND NEW."status" = 'REFUNDED');
    IF EXISTS (
      SELECT 1 FROM public."FulfillmentAttempt" a
      WHERE a."orderId" = NEW."id" AND a."status" IN ('SENDING', 'SENT', 'UNKNOWN', 'CONFIRMED')
    )
    OR EXISTS (
      SELECT 1 FROM public."TonTransfer" t JOIN public."FulfillmentAttempt" a ON a."id" = t."attemptId"
      WHERE a."orderId" = NEW."id" AND t."status" <> 'EXPIRED'
        AND NOT (review_exit AND t."status" IN ('ONCHAIN_FAILED', 'BOUNCED', 'CONSUMED_UNMATCHED'))
    ) THEN
      RAISE EXCEPTION '% % -> % is refused: a payout of the order may have gone out',
        TG_TABLE_NAME, OLD."status", NEW."status"
        USING ERRCODE = 'GG001';
    END IF;
  END IF;
  IF OLD."status" = 'DELIVERED' AND NEW."status" = 'REFUNDED' AND (
    EXISTS (
      SELECT 1 FROM public."FulfillmentAttempt" a
      WHERE a."orderId" = NEW."id" AND a."status" IN ('SENDING', 'SENT', 'UNKNOWN')
    )
    OR EXISTS (
      SELECT 1 FROM public."TonTransfer" t JOIN public."FulfillmentAttempt" a ON a."id" = t."attemptId"
      WHERE a."orderId" = NEW."id" AND t."status" IN ('SIGNED', 'BROADCAST', 'CONSUMED_UNMATCHED', 'BOUNCED')
    )
  ) THEN
    RAISE EXCEPTION '% DELIVERED -> REFUNDED is refused: a payout of the order is still unresolved or bounced',
      TG_TABLE_NAME
      USING ERRCODE = 'GG001';
  END IF;
  IF NEW."status" = 'DELIVERED' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public."FulfillmentAttempt" a WHERE a."orderId" = NEW."id" AND a."status" = 'CONFIRMED'
    )
    OR EXISTS (
      SELECT 1 FROM public."FulfillmentAttempt" a
      WHERE a."orderId" = NEW."id" AND a."status" IN ('SENDING', 'SENT', 'UNKNOWN')
    )
    OR EXISTS (
      SELECT 1 FROM public."TonTransfer" t JOIN public."FulfillmentAttempt" a ON a."id" = t."attemptId"
      WHERE a."orderId" = NEW."id" AND t."status" NOT IN ('CONFIRMED', 'EXPIRED', 'ONCHAIN_FAILED')
    ) THEN
      RAISE EXCEPTION '% % -> DELIVERED is refused: it needs a CONFIRMED attempt, no unresolved attempt and no live or bounced transfer',
        TG_TABLE_NAME, OLD."status"
        USING ERRCODE = 'GG001';
    END IF;
    NEW."deliveredAt" := timezone('UTC', now());
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Order_status_guard" BEFORE INSERT OR UPDATE ON "Order"
  FOR EACH ROW EXECUTE FUNCTION ggpin_order_status_guard();

-- Two exits of the order machine move money or decide an unknown outcome, so they must leave a
-- trace in the same transaction. The checks are DEFERRED to COMMIT (a row written later in the same
-- transaction counts), so a raw status UPDATE that skips the helpers cannot commit without it:
--   * REFUNDED needs the REFUND ledger entry `ORDER/<orderId>` (the one automatic and full admin
--     refunds write; a partial admin refund uses ADMIN_ACTION and does not change the status) for
--     exactly what the order cost (`priceTiyin - discountTiyin`) and to the order's own user (audit
--     L6: a ten times bigger refund, or one credited to somebody else, does not commit);
--   * leaving NEEDS_REVIEW (FAILED or DELIVERED) needs the ORDER_REVIEW_RESOLVE audit row of that
--     order (`targetType = 'Order'`, `targetId` = the order id), which resolveNeedsReview writes;
--   * an order that is FAILED, or REFUNDED after FAILED, and has a transfer that ONCHAIN_FAILED,
--     was BOUNCED or was CONSUMED_UNMATCHED (the three the guard above lets through only inside the
--     review resolution) needs the audit row of the proof that fits that transfer: the proof kind of
--     the transfer's state (TON_NOT_DEBITED, TON_BOUNCED, TON_UNMATCHED_RESOLVED), naming that very
--     transfer, carried by an OWNER whose OTP was verified (owner decision A4, D-59). The audit row is
--     a trace, not a boundary (a forged row passes, audit I1): the helper is what binds the proof to
--     the chain data; this check makes the three exits impossible without any proof at all.
CREATE FUNCTION ggpin_order_refund_ledger_check() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public."LedgerEntry" l
    WHERE l."refType" = 'ORDER' AND l."refId" = NEW."id" AND l."kind" = 'REFUND'
      AND l."userId" = NEW."userId"
      AND l."amountTiyin" = NEW."priceTiyin" - NEW."discountTiyin"
  ) THEN
    RAISE EXCEPTION 'Order % is REFUNDED without its REFUND ledger entry for what it cost (price - discount, its own user)', NEW."id"
      USING ERRCODE = 'GG001';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "Order_refund_ledger_check" AFTER UPDATE OF "status" ON "Order"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW."status" = 'REFUNDED' AND OLD."status" IS DISTINCT FROM NEW."status")
  EXECUTE FUNCTION ggpin_order_refund_ledger_check();

CREATE FUNCTION ggpin_order_review_audit_check() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public."AuditLog" a
    WHERE a."targetType" = 'Order' AND a."targetId" = NEW."id" AND a."action" = 'ORDER_REVIEW_RESOLVE'
  ) THEN
    RAISE EXCEPTION 'Order % left NEEDS_REVIEW without its ORDER_REVIEW_RESOLVE audit row', NEW."id"
      USING ERRCODE = 'GG001';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "Order_review_audit_check" AFTER UPDATE OF "status" ON "Order"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (
    OLD."status" = 'NEEDS_REVIEW' AND NEW."status" IN ('FAILED', 'DELIVERED')
  )
  EXECUTE FUNCTION ggpin_order_review_audit_check();

CREATE FUNCTION ggpin_order_special_transfer_check() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  special record;
BEGIN
  FOR special IN
    SELECT t."id" AS "transferId", t."status" AS "transferStatus", t."txHash" AS "txHash", t."txLt" AS "txLt"
    FROM public."TonTransfer" t JOIN public."FulfillmentAttempt" a ON a."id" = t."attemptId"
    WHERE a."orderId" = NEW."id" AND t."status" IN ('ONCHAIN_FAILED', 'BOUNCED', 'CONSUMED_UNMATCHED')
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public."AuditLog" l
      WHERE l."targetType" = 'Order' AND l."targetId" = NEW."id" AND l."action" = 'ORDER_REVIEW_RESOLVE'
        AND l."after" -> 'proof' ->> 'transferId' = special."transferId"
        AND l."after" -> 'proof' ->> 'kind' = CASE special."transferStatus"
          WHEN 'ONCHAIN_FAILED' THEN 'TON_NOT_DEBITED'
          WHEN 'BOUNCED' THEN 'TON_BOUNCED'
          ELSE 'TON_UNMATCHED_RESOLVED'
        END
        AND l."after" -> 'otpVerified' = 'true'::jsonb
        AND l."after" -> 'operator' ->> 'role' = 'OWNER'
        -- The proof carries our own transaction for the two that have one (audit I-1) ...
        AND (special."transferStatus" NOT IN ('BOUNCED', 'ONCHAIN_FAILED') OR (
          l."after" -> 'proof' ->> 'txHash' = special."txHash"
          AND l."after" -> 'proof' ->> 'txLt' = special."txLt"::text))
        -- ... the bounce that paid out (a bounce is refunded against the return transaction) ...
        AND (special."transferStatus" <> 'BOUNCED' OR l."after" -> 'proof' ->> 'returnTxHash' IS NOT NULL)
        -- ... and an unmatched seqno only from the owner CLI, naming the transaction found
        -- (owner decision A3: no ADMIN path).
        AND (special."transferStatus" <> 'CONSUMED_UNMATCHED' OR (
          l."after" -> 'operator' ->> 'type' = 'CLI'
          AND l."after" -> 'proof' ->> 'consumingTxHash' IS NOT NULL))
    ) THEN
      RAISE EXCEPTION 'Order % has a % transfer without the owner-only review proof that fits it',
        NEW."id", special."transferStatus"
        USING ERRCODE = 'GG001';
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "Order_special_transfer_check" AFTER UPDATE OF "status" ON "Order"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (
    OLD."status" IS DISTINCT FROM NEW."status"
    AND (NEW."status" = 'FAILED' OR (NEW."status" = 'REFUNDED' AND OLD."status" = 'FAILED'))
  )
  EXECUTE FUNCTION ggpin_order_special_transfer_check();

-- One bounce pays out one refund (owner decision A1): the transaction that carried the value back
-- is named by `returnTxHash` in the proof of the audit row, and a second resolution may not name
-- the same one (audit R2e: the same bounce refunding two orders). A partial unique expression index,
-- no new column; the helper checks it first to give a clear error, the index is the backstop.
CREATE UNIQUE INDEX "AuditLog_review_return_tx_key"
  ON "AuditLog" ((("after" -> 'proof') ->> 'returnTxHash'))
  WHERE "action" = 'ORDER_REVIEW_RESOLVE' AND (("after" -> 'proof') ->> 'returnTxHash') IS NOT NULL;

-- The same for the unknown transaction that consumed a seqno (audit Z5): one finding, one refund.
CREATE UNIQUE INDEX "AuditLog_review_consuming_tx_key"
  ON "AuditLog" ((("after" -> 'proof') ->> 'consumingTxHash'))
  WHERE "action" = 'ORDER_REVIEW_RESOLVE' AND (("after" -> 'proof') ->> 'consumingTxHash') IS NOT NULL;

-- The purchase (who, what, for whom, at which price and cost ceiling, under which key) is fixed
-- at creation: the PURCHASE ledger entry and the idempotent replay both rely on it. status,
-- statusReason, deliveredAt and updatedAt are the order's life and stay mutable.
CREATE FUNCTION ggpin_order_immutable_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW."number" IS DISTINCT FROM OLD."number"
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
    RAISE EXCEPTION '% the purchase (number, createdAt, user, quote, product, sku, quantity, recipient, providerRef, price, discount, cost, ceiling, fx rate, key, request hash) is immutable',
      TG_TABLE_NAME
      USING ERRCODE = 'GG001', HINT = 'Only status, statusReason and deliveredAt change after INSERT.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Order_immutable_guard" BEFORE UPDATE ON "Order"
  FOR EACH ROW EXECUTE FUNCTION ggpin_order_immutable_guard();

-- ============================================================================================
-- Quote: the locked price never changes, "used" is one-way and only before the quote expires
-- ============================================================================================

-- A quote is the price the customer saw. Its numbers, owner and expiry never change (an expired
-- quote is not extended: a new one is issued). `usedAt` goes NULL -> a time exactly once, inside
-- the purchase transaction, and can never be cleared or moved: that is what makes a quote
-- single-use even if a bug tried to "release" it. It is only set while the quote is alive: the
-- purchase transaction checks expiry too, this is the backstop for any path that forgets. "Alive" is
-- judged by the clock at the moment of the write (`clock_timestamp()`, audit Y5), not by the start of
-- the transaction (`now()`): a long transaction that began before the expiry must not be able to use
-- the quote after it.
-- `providerRef` (the recipient's provider-side id, owner decision R3) is written at INSERT and never
-- changes, not even from NULL to a value: a recipient that was confirmed must stay the one paid.
-- `expiresAt` is a UTC timestamp without zone, so the clock is converted to UTC before comparing.
CREATE FUNCTION ggpin_quote_immutable_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
     OR NEW."userId" IS DISTINCT FROM OLD."userId"
     OR NEW."skuId" IS DISTINCT FROM OLD."skuId"
     OR NEW."productId" IS DISTINCT FROM OLD."productId"
     OR NEW."quantity" IS DISTINCT FROM OLD."quantity"
     OR NEW."recipient" IS DISTINCT FROM OLD."recipient"
     OR NEW."providerRef" IS DISTINCT FROM OLD."providerRef"
     OR NEW."costCurrency" IS DISTINCT FROM OLD."costCurrency"
     OR NEW."costMinor" IS DISTINCT FROM OLD."costMinor"
     OR NEW."fxRateId" IS DISTINCT FROM OLD."fxRateId"
     OR NEW."costSnapshotId" IS DISTINCT FROM OLD."costSnapshotId"
     OR NEW."priceTiyin" IS DISTINCT FROM OLD."priceTiyin"
     OR NEW."maxCostMinor" IS DISTINCT FROM OLD."maxCostMinor"
     OR NEW."discountCodeId" IS DISTINCT FROM OLD."discountCodeId"
     OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt" THEN
    RAISE EXCEPTION '% the quoted price, cost, recipient, providerRef, expiry and createdAt are immutable', TG_TABLE_NAME
      USING ERRCODE = 'GG001';
  END IF;
  IF OLD."usedAt" IS NOT NULL AND NEW."usedAt" IS DISTINCT FROM OLD."usedAt" THEN
    RAISE EXCEPTION '% usedAt is set once and cannot be cleared or changed', TG_TABLE_NAME
      USING ERRCODE = 'GG001';
  END IF;
  IF OLD."usedAt" IS NULL AND NEW."usedAt" IS NOT NULL AND timezone('UTC', clock_timestamp()) > NEW."expiresAt" THEN
    RAISE EXCEPTION '% an expired quote cannot be used', TG_TABLE_NAME USING ERRCODE = 'GG001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Quote_immutable_guard" BEFORE UPDATE ON "Quote"
  FOR EACH ROW EXECUTE FUNCTION ggpin_quote_immutable_guard();

-- ============================================================================================
-- Phase-4 guard functions: the same search_path pin (audit N5)
-- ============================================================================================

-- Their bodies are unchanged (the applied migrations are not edited); only the function attribute
-- is set, so a TEMP table cannot shadow a guarded table for them either.
ALTER FUNCTION ggpin_forbid_mutation() SET search_path = public, pg_temp;
ALTER FUNCTION ggpin_topup_card_identity_guard() SET search_path = public, pg_temp;
ALTER FUNCTION ggpin_bank_message_text_guard() SET search_path = public, pg_temp;
ALTER FUNCTION ggpin_bank_message_card_guard() SET search_path = public, pg_temp;
ALTER FUNCTION ggpin_bank_message_outcome_links_guard() SET search_path = public, pg_temp;
ALTER FUNCTION ggpin_payment_intent_guard() SET search_path = public, pg_temp;
ALTER FUNCTION ggpin_payment_consistency_guard() SET search_path = public, pg_temp;
ALTER FUNCTION ggpin_payment_immutable_guard() SET search_path = public, pg_temp;
ALTER FUNCTION ggpin_payment_review_immutable_guard() SET search_path = public, pg_temp;
