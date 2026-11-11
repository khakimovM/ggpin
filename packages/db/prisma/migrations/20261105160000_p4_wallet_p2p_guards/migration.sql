-- Migration 9, part 5 (phase 4, second review of S2): the guards of part 4 let a few wrong writes
-- through. Parts 1-4 are applied, so the fixes land here: CREATE OR REPLACE of four trigger
-- functions (the triggers keep pointing at them), one new trigger, two indexes. No table or
-- column changes, nothing to backfill.
--
-- SQLSTATEs: GG001 immutable / forbidden state change, GG003 BankMessage card does not match the
-- message, GG004 Payment disagrees with its intent or message, GG005 (new) a BankMessageOutcome
-- names a payment or review of another bank message.

-- ============================================================================================
-- PaymentIntent: the reservation is exactly GREATEST(old, paidAt + grace), paidAt is plausible
-- ============================================================================================

-- Replaces the function of part 4. New in the transition to PAID:
--   * reservedUntil must EQUAL GREATEST(old, paidAt + grace), where grace = old reservedUntil -
--     expiresAt (the gap fixed at creation). The trigger never writes the value, it only refuses
--     any other one: too short frees an amount still owed to the payer, too long (or infinity)
--     locks the amount on the card for good.
--   * paidAt lies in createdAt - 5 min .. now + 5 min. paidAt is either the bank message time
--     (the bank prints it to the minute, and its clock differs from ours) or the write time;
--     docs do not pin which, the window accepts both and refuses 2000-01-01 or the far future.
--   * reservedUntil is finite.
-- Everything else of part 4 is unchanged (immutable fields, status graph, frozen reservation).
CREATE OR REPLACE FUNCTION ggpin_payment_intent_guard() RETURNS trigger
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
      IF NEW."paidAt" IS NULL OR NEW."reservedUntil" IS NULL THEN
        RAISE EXCEPTION '% paidAt and reservedUntil are required when the intent is paid', TG_TABLE_NAME
          USING ERRCODE = 'GG001';
      END IF;
      IF NEW."paidAt" < OLD."createdAt" - interval '5 minutes'
         OR NEW."paidAt" > timezone('UTC', now()) + interval '5 minutes' THEN
        RAISE EXCEPTION '% paidAt must lie between createdAt - 5 minutes and now + 5 minutes', TG_TABLE_NAME
          USING ERRCODE = 'GG001';
      END IF;
      IF NOT isfinite(NEW."reservedUntil")
         OR NEW."reservedUntil" <> GREATEST(
              OLD."reservedUntil",
              NEW."paidAt" + (OLD."reservedUntil" - OLD."expiresAt")
            ) THEN
        RAISE EXCEPTION '% reservedUntil must equal GREATEST(old reservedUntil, paidAt + grace)', TG_TABLE_NAME
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

-- ============================================================================================
-- Payment: a payment of an intent is that intent's money, from a message for that card/amount
-- ============================================================================================

-- Replaces the function of part 4. New: a P2P_CARD payment that names an intent needs
--   intent.provider = 'P2P_CARD', intent.cardId = message.cardId (NULL never matches: the
--   intent always has a card) and intent.amountTiyin = message amount.
-- Otherwise a payment could credit user A for a transfer that went to another card or for
-- another amount. `review:credit --intent` therefore works only when card and amount match
-- exactly; anything else is credited to a user without an intent (`--user`).
CREATE OR REPLACE FUNCTION ggpin_payment_consistency_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  intent_found BOOLEAN := false;
  intent_user TEXT;
  intent_provider TEXT;
  intent_card TEXT;
  intent_amount BIGINT;
  msg RECORD;
BEGIN
  IF NEW."intentId" IS NOT NULL THEN
    SELECT true, "userId", "provider"::text, "cardId", "amountTiyin"
      INTO intent_found, intent_user, intent_provider, intent_card, intent_amount
      FROM "PaymentIntent" WHERE "id" = NEW."intentId";
    IF intent_found AND intent_user <> NEW."userId" THEN
      RAISE EXCEPTION 'Payment user % is not the owner of intent %', NEW."userId", NEW."intentId"
        USING ERRCODE = 'GG004';
    END IF;
  END IF;

  IF NEW."provider" = 'P2P_CARD' AND NEW."bankMessageId" IS NOT NULL THEN
    SELECT "parseStatus"::text AS parse_status, "direction"::text AS direction,
           "amountTiyin" AS amount, "cardId" AS card_id
      INTO msg FROM "BankMessage" WHERE "id" = NEW."bankMessageId";
    IF FOUND THEN
      IF msg.parse_status <> 'PARSED'
         OR msg.direction IS DISTINCT FROM 'CREDIT'
         OR msg.amount IS DISTINCT FROM NEW."amountTiyin" THEN
        RAISE EXCEPTION 'P2P_CARD payment must be a PARSED CREDIT bank message for exactly its amount'
          USING ERRCODE = 'GG004';
      END IF;
      IF intent_found AND (
        intent_provider <> 'P2P_CARD'
        OR intent_card IS DISTINCT FROM msg.card_id
        OR intent_amount IS DISTINCT FROM msg.amount
      ) THEN
        RAISE EXCEPTION 'P2P_CARD payment of intent % must come from a message for the intent card and amount',
          NEW."intentId"
          USING ERRCODE = 'GG004';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- ============================================================================================
-- BankMessage: the card is the latest RETIRED one; comparisons use the enum type
-- ============================================================================================

-- Replaces the function of part 4. New: among RETIRED cards with the same (bank, last4) the
-- message must point at the one retired last (docs/05 section 6.3). Also: the bank is compared
-- as the "CardBank" enum, not as text, so the lookup can use the (bank, last4) indexes.
CREATE OR REPLACE FUNCTION ggpin_bank_message_card_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  card RECORD;
  expected_bank "CardBank";
BEGIN
  IF NEW."cardId" IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT "bank" AS bank, "last4" AS last4, "status" AS status, "retiredAt" AS retired_at
    INTO card FROM "TopupCard" WHERE "id" = NEW."cardId";
  IF NOT FOUND THEN
    RETURN NEW; -- the foreign key reports the missing card
  END IF;
  expected_bank := CASE NEW."source"
    WHEN 'HUMO_BOT' THEN 'HUMO'::"CardBank"
    WHEN 'UZCARD_BOT' THEN 'UZCARD'::"CardBank"
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
    WHERE t."bank" = card.bank AND t."last4" = card.last4 AND t."status" <> 'RETIRED'
  ) THEN
    RAISE EXCEPTION 'BankMessage card % is retired but a live card has the same bank and last4',
      NEW."cardId"
      USING ERRCODE = 'GG003';
  END IF;
  IF card.status = 'RETIRED' AND EXISTS (
    SELECT 1 FROM "TopupCard" t
    WHERE t."bank" = card.bank AND t."last4" = card.last4
      AND t."status" = 'RETIRED' AND t."retiredAt" > card.retired_at
  ) THEN
    RAISE EXCEPTION 'BankMessage card % is not the most recently retired card with this bank and last4',
      NEW."cardId"
      USING ERRCODE = 'GG003';
  END IF;
  RETURN NEW;
END;
$$;

-- ============================================================================================
-- TopupCard: RETIRED is final
-- ============================================================================================

-- Replaces the function of part 4 (same trigger). New: a RETIRED card never leaves RETIRED and
-- its retiredAt does not move. Messages keep pointing at retired cards for the "latest RETIRED"
-- rule above, so a resurrected or re-dated card would silently re-attribute them. The full state
-- graph of the other statuses belongs to the card pool (slice S4).
CREATE OR REPLACE FUNCTION ggpin_topup_card_identity_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."bank" IS DISTINCT FROM OLD."bank"
     OR NEW."pan" IS DISTINCT FROM OLD."pan"
     OR NEW."last4" IS DISTINCT FROM OLD."last4"
     OR NEW."holderName" IS DISTINCT FROM OLD."holderName" THEN
    RAISE EXCEPTION '% bank, pan, last4 and holderName are immutable: UPDATE is not allowed', TG_TABLE_NAME
      USING ERRCODE = 'GG001', HINT = 'Retire the card and add a new one.';
  END IF;
  IF OLD."status" = 'RETIRED' AND NEW."status" <> 'RETIRED' THEN
    RAISE EXCEPTION '% status RETIRED is final', TG_TABLE_NAME
      USING ERRCODE = 'GG001', HINT = 'Add a new card instead of reviving a retired one.';
  END IF;
  IF OLD."retiredAt" IS NOT NULL AND NEW."retiredAt" IS DISTINCT FROM OLD."retiredAt" THEN
    RAISE EXCEPTION '% retiredAt is final once set', TG_TABLE_NAME
      USING ERRCODE = 'GG001';
  END IF;
  RETURN NEW;
END;
$$;

-- ============================================================================================
-- BankMessageOutcome: the rows it names belong to the same bank message
-- ============================================================================================

-- BankMessageOutcome is insert-once, so a mismatch could never be corrected: CREDITED would
-- point at the payment of another message. A missing row is left to the foreign keys.
CREATE FUNCTION ggpin_bank_message_outcome_links_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  linked TEXT;
BEGIN
  IF NEW."paymentId" IS NOT NULL THEN
    SELECT "bankMessageId" INTO linked FROM "Payment" WHERE "id" = NEW."paymentId";
    IF FOUND AND linked IS DISTINCT FROM NEW."bankMessageId" THEN
      RAISE EXCEPTION 'BankMessageOutcome payment % belongs to another bank message', NEW."paymentId"
        USING ERRCODE = 'GG005';
    END IF;
  END IF;
  IF NEW."reviewId" IS NOT NULL THEN
    SELECT "bankMessageId" INTO linked FROM "PaymentReview" WHERE "id" = NEW."reviewId";
    IF FOUND AND linked IS DISTINCT FROM NEW."bankMessageId" THEN
      RAISE EXCEPTION 'BankMessageOutcome review % belongs to another bank message', NEW."reviewId"
        USING ERRCODE = 'GG005';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "BankMessageOutcome_links_guard" BEFORE INSERT ON "BankMessageOutcome"
  FOR EACH ROW EXECUTE FUNCTION ggpin_bank_message_outcome_links_guard();

-- ============================================================================================
-- Indexes on foreign keys that lacked one (Prisma generated)
-- ============================================================================================

-- CreateIndex
CREATE INDEX "BankMessageOutcome_reviewId_idx" ON "BankMessageOutcome"("reviewId");

-- CreateIndex
CREATE INDEX "PaymentReview_resolvedAuditLogId_idx" ON "PaymentReview"("resolvedAuditLogId");
