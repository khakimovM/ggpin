-- Migration 9, part 4 (phase 4, code review of S2): closes the gaps found in review. Migrations
-- 1-3 of this phase are already applied, so every change lands here instead of editing them.
-- Additive: new constraints, triggers and foreign keys; one NOT NULL on an empty table.
--
-- Custom SQLSTATEs (class GG, same family as GG001 "append-only"):
--   GG001  immutable / append-only row or forbidden state change (ggpin_forbid_mutation et al.)
--   GG002  migration guard: data present that the migration cannot safely reinterpret
--   GG003  BankMessage points at a card that does not match the message
--   GG004  Payment disagrees with its intent or its bank message

-- ============================================================================================
-- PaymentReview: every review comes out of one bank message; a resolution has an audit row
-- ============================================================================================

-- Guard: no review exists before slice S6, so this never fires on dev/test; if it ever does,
-- stop instead of inventing a message for it.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "PaymentReview" WHERE "bankMessageId" IS NULL) THEN
    RAISE EXCEPTION 'PaymentReview has rows without a bank message: fix them before NOT NULL'
      USING ERRCODE = 'GG002';
  END IF;
END;
$$;

-- AlterTable
ALTER TABLE "PaymentReview" ALTER COLUMN "bankMessageId" SET NOT NULL;

-- AddForeignKey
ALTER TABLE "PaymentReview" ADD CONSTRAINT "PaymentReview_resolvedAuditLogId_fkey" FOREIGN KEY ("resolvedAuditLogId") REFERENCES "AuditLog"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RESOLVED exactly when the owner's decision is audited (resolution + time are covered by
-- PaymentReview_resolved_check).
ALTER TABLE "PaymentReview" ADD CONSTRAINT "PaymentReview_audit_check" CHECK (
  ("status" = 'RESOLVED') = ("resolvedAuditLogId" IS NOT NULL)
);

-- ============================================================================================
-- BankMessageOutcome: the outcome and the rows it names must agree
-- ============================================================================================

-- AddForeignKey
ALTER TABLE "BankMessageOutcome" ADD CONSTRAINT "BankMessageOutcome_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankMessageOutcome" ADD CONSTRAINT "BankMessageOutcome_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "PaymentReview"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CREDITED exactly when a payment was written; a REVIEW outcome names its review.
ALTER TABLE "BankMessageOutcome" ADD CONSTRAINT "BankMessageOutcome_payment_check" CHECK (
  ("outcome" = 'CREDITED') = ("paymentId" IS NOT NULL)
);

ALTER TABLE "BankMessageOutcome" ADD CONSTRAINT "BankMessageOutcome_review_check" CHECK (
  "outcome" <> 'REVIEW' OR "reviewId" IS NOT NULL
);

-- ============================================================================================
-- TopupCard, PaymentIntent: value checks
-- ============================================================================================

-- A card that is (or was) in service has been verified; only VERIFYING and a card retired
-- before verification may lack verifiedAt.
ALTER TABLE "TopupCard" ADD CONSTRAINT "TopupCard_verified_check" CHECK (
  "status" IN ('VERIFYING', 'RETIRED') OR "verifiedAt" IS NOT NULL
);

-- The base amount is a positive number of whole thousands of so'm. (PaymentIntent_p2p_check
-- only fixes "% 100000 = 0", which 0 satisfies.) NULL stays allowed for non-P2P providers.
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_base_positive_check" CHECK (
  "baseAmountTiyin" IS NULL OR "baseAmountTiyin" > 0
);

-- ============================================================================================
-- BankMessage: the card named at ingestion must be the card the message is about
-- ============================================================================================

-- The listener fills "cardId" in the transaction that inserts the message (docs/05 section 6.3).
-- BankMessage is append-only, so a wrong cardId could never be corrected and would feed the
-- balance chain of the wrong card. This trigger refuses it: the card's bank must be the bank
-- of the message source, "last4" must match, and a RETIRED card is only acceptable when no
-- live card carries the same (bank, last4). No card at all (NULL) is always allowed
-- (CARD_UNKNOWN).
CREATE FUNCTION ggpin_bank_message_card_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  card RECORD;
  expected_bank TEXT;
BEGIN
  IF NEW."cardId" IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT "bank"::text AS bank, "last4" AS last4, "status"::text AS status
    INTO card FROM "TopupCard" WHERE "id" = NEW."cardId";
  IF NOT FOUND THEN
    RETURN NEW; -- the foreign key reports the missing card
  END IF;
  expected_bank := CASE NEW."source"::text
    WHEN 'HUMO_BOT' THEN 'HUMO'
    WHEN 'UZCARD_BOT' THEN 'UZCARD'
  END;
  IF expected_bank IS NULL OR card.bank <> expected_bank THEN
    RAISE EXCEPTION 'BankMessage card % is a % card but the message came from %',
      NEW."cardId", card.bank, NEW."source"
      USING ERRCODE = 'GG003';
  END IF;
  IF NEW."last4" IS NULL OR card.last4 <> NEW."last4" THEN
    RAISE EXCEPTION 'BankMessage card % does not end in the last4 of the message', NEW."cardId"
      USING ERRCODE = 'GG003';
  END IF;
  IF card.status = 'RETIRED' AND EXISTS (
    SELECT 1 FROM "TopupCard" t
    WHERE t."bank"::text = card.bank AND t."last4" = card.last4 AND t."status" <> 'RETIRED'
  ) THEN
    RAISE EXCEPTION 'BankMessage card % is retired but a live card has the same bank and last4',
      NEW."cardId"
      USING ERRCODE = 'GG003';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "BankMessage_card_guard" BEFORE INSERT ON "BankMessage"
  FOR EACH ROW EXECUTE FUNCTION ggpin_bank_message_card_guard();

-- ============================================================================================
-- PaymentIntent: P2P status graph, immutable fields, monotonic reservation
-- ============================================================================================

-- Mirrors packages/shared/src/payments/intent-state.ts (the only source of the graph):
--   PENDING -> PAID | EXPIRED | CANCELLED;  EXPIRED -> PAID;  CANCELLED -> PAID;  PAID is final.
-- The grace window and the actor (CANCELLED -> PAID only by the owner) depend on the event time
-- and on who acts, which a row does not carry, so assertIntentTransition keeps those two rules.
-- On top of the graph the database refuses what no code path may ever do:
--   * change who/what/where the request is for: id, userId, provider, cardId, amountTiyin,
--     baseAmountTiyin, createdAt, expiresAt;
--   * move reservedUntil except in the transition to PAID, and then only upwards
--     (GREATEST(old, paidAt + grace)): a reservation never shrinks, or the EXCLUDE constraint
--     would free an amount that is still owed to a payer;
--   * change paidAt once the intent is PAID (or at all outside the transition to PAID).
-- payTokenHash, idempotency fields and updatedAt stay mutable (POST /pay-link rotates the token).
CREATE FUNCTION ggpin_payment_intent_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."provider" <> 'P2P_CARD' AND NEW."provider" <> 'P2P_CARD' THEN
    RETURN NEW;
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."userId" IS DISTINCT FROM OLD."userId"
     OR NEW."provider" IS DISTINCT FROM OLD."provider"
     OR NEW."cardId" IS DISTINCT FROM OLD."cardId"
     OR NEW."amountTiyin" IS DISTINCT FROM OLD."amountTiyin"
     OR NEW."baseAmountTiyin" IS DISTINCT FROM OLD."baseAmountTiyin"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
     OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt" THEN
    RAISE EXCEPTION '% (P2P_CARD): id, userId, provider, cardId, amounts, createdAt and expiresAt are immutable',
      TG_TABLE_NAME
      USING ERRCODE = 'GG001';
  END IF;

  IF NEW."status" IS DISTINCT FROM OLD."status" THEN
    IF NOT (
      (OLD."status" = 'PENDING' AND NEW."status" IN ('PAID', 'EXPIRED', 'CANCELLED'))
      OR (OLD."status" IN ('EXPIRED', 'CANCELLED') AND NEW."status" = 'PAID')
    ) THEN
      RAISE EXCEPTION '% status transition % -> % is not allowed', TG_TABLE_NAME, OLD."status", NEW."status"
        USING ERRCODE = 'GG001';
    END IF;
    IF NEW."status" = 'PAID' THEN
      IF NEW."reservedUntil" IS NULL OR NEW."reservedUntil" < OLD."reservedUntil" THEN
        RAISE EXCEPTION '% reservedUntil must not shrink when the intent is paid', TG_TABLE_NAME
          USING ERRCODE = 'GG001';
      END IF;
      RETURN NEW;
    END IF;
  END IF;

  -- Any update that is not "to PAID": the reservation and the payment time are frozen.
  IF NEW."reservedUntil" IS DISTINCT FROM OLD."reservedUntil"
     OR NEW."paidAt" IS DISTINCT FROM OLD."paidAt" THEN
    RAISE EXCEPTION '% reservedUntil and paidAt change only in the transition to PAID', TG_TABLE_NAME
      USING ERRCODE = 'GG001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "PaymentIntent_p2p_guard" BEFORE UPDATE ON "PaymentIntent"
  FOR EACH ROW EXECUTE FUNCTION ggpin_payment_intent_guard();

-- ============================================================================================
-- Payment: agrees with its intent's owner and with its bank message
-- ============================================================================================

-- A composite foreign key ("intentId", "userId") -> PaymentIntent ("id", "userId") would state
-- the first rule, but Prisma cannot model a relation whose fields are partly nullable and the
-- raw constraint would show up as drift on every `migrate dev`. A trigger does the same job:
--   * a payment of an intent belongs to the intent's user (any provider);
--   * a P2P_CARD payment is one parsed CREDIT bank message, for exactly the message's amount.
-- Missing rows are left to the foreign keys, which report them.
CREATE FUNCTION ggpin_payment_consistency_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  intent_user TEXT;
  msg RECORD;
BEGIN
  IF NEW."intentId" IS NOT NULL THEN
    SELECT "userId" INTO intent_user FROM "PaymentIntent" WHERE "id" = NEW."intentId";
    IF FOUND AND intent_user <> NEW."userId" THEN
      RAISE EXCEPTION 'Payment user % is not the owner of intent %', NEW."userId", NEW."intentId"
        USING ERRCODE = 'GG004';
    END IF;
  END IF;

  IF NEW."provider" = 'P2P_CARD' AND NEW."bankMessageId" IS NOT NULL THEN
    SELECT "parseStatus"::text AS parse_status, "direction"::text AS direction,
           "amountTiyin" AS amount
      INTO msg FROM "BankMessage" WHERE "id" = NEW."bankMessageId";
    IF FOUND AND (
      msg.parse_status <> 'PARSED'
      OR msg.direction IS DISTINCT FROM 'CREDIT'
      OR msg.amount IS DISTINCT FROM NEW."amountTiyin"
    ) THEN
      RAISE EXCEPTION 'P2P_CARD payment must be a PARSED CREDIT bank message for exactly its amount'
        USING ERRCODE = 'GG004';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Payment_consistency_guard"
  BEFORE INSERT OR UPDATE OF "intentId", "userId", "provider", "bankMessageId", "amountTiyin" ON "Payment"
  FOR EACH ROW EXECUTE FUNCTION ggpin_payment_consistency_guard();
