-- Migration 9, part 2 (phase 4): CHECK constraints, partial unique indexes, the reservation
-- EXCLUDE constraint and the guard triggers. Raw SQL that Prisma cannot express (it ignores all
-- of it when diffing the schema). Separate from part 1 because it uses the new enum value
-- 'P2P_CARD', which PostgreSQL cannot use in the transaction that added it.
--
-- NULL safety (7th migration style): a CHECK passes when it evaluates to NULL, so every nullable
-- column is guarded by an explicit IS NOT NULL in the same AND chain. Every expression below is
-- therefore strictly true or false for any row.
--
-- Index predicates use the enum literal ("provider" = 'P2P_CARD'), not a ::text cast: the cast
-- goes through enum_out, which is STABLE, and index predicates must be IMMUTABLE.

-- ============================================================================================
-- TopupCard
-- ============================================================================================

ALTER TABLE "TopupCard" ADD CONSTRAINT "TopupCard_values_check" CHECK (
  "pan" ~ '^[0-9]{16}$'
  AND "last4" = right("pan", 4)
  AND "receiveLimitTiyin" > 0
  AND ("monthlyLimitTiyin" IS NULL OR "monthlyLimitTiyin" > 0)
  AND "verifyAmountTiyin" > 0
  AND length(btrim("holderName")) > 0
);

-- RETIRED exactly when retiredAt is set.
ALTER TABLE "TopupCard" ADD CONSTRAINT "TopupCard_retired_check" CHECK (
  ("status" = 'RETIRED') = ("retiredAt" IS NOT NULL)
);

-- The bank bot identifies a card by (bank, last4) only, so two live cards must not share it.
-- A retired card frees the pair (cards get reissued).
CREATE UNIQUE INDEX "TopupCard_bank_last4_active_key" ON "TopupCard" ("bank", "last4")
  WHERE "status" <> 'RETIRED';

-- bank, pan, last4 and holderName are the card's identity: a message already matched to the
-- card, an open intent and the pay page all rely on them. Status, limits and pause stay mutable.
CREATE FUNCTION ggpin_topup_card_identity_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."bank" IS DISTINCT FROM OLD."bank"
     OR NEW."pan" IS DISTINCT FROM OLD."pan"
     OR NEW."last4" IS DISTINCT FROM OLD."last4"
     OR NEW."holderName" IS DISTINCT FROM OLD."holderName" THEN
    RAISE EXCEPTION '% bank, pan, last4 and holderName are immutable: UPDATE is not allowed', TG_TABLE_NAME
      USING ERRCODE = 'GG001', HINT = 'Retire the card and add a new one.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "TopupCard_identity_immutable" BEFORE UPDATE ON "TopupCard"
  FOR EACH ROW EXECUTE FUNCTION ggpin_topup_card_identity_guard();

-- ============================================================================================
-- PaymentIntent
-- ============================================================================================

-- A P2P_CARD intent: card, base amount and reservation are mandatory; the amount is the base
-- plus a suffix of 1..999 so'm (100..99 900 tiyin), both in whole so'm; the base is a multiple
-- of 1 000 so'm. "reservedUntil >= expiresAt > createdAt" also keeps the EXCLUDE range below
-- valid (a range whose upper bound is below the lower one is an error, not an empty range).
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_p2p_check" CHECK (
  "provider" <> 'P2P_CARD'
  OR (
    "cardId" IS NOT NULL
    AND "baseAmountTiyin" IS NOT NULL
    AND "reservedUntil" IS NOT NULL
    AND "amountTiyin" % 100 = 0
    AND "baseAmountTiyin" % 100000 = 0
    AND "amountTiyin" - "baseAmountTiyin" BETWEEN 100 AND 99900
    AND "expiresAt" > "createdAt"
    AND "reservedUntil" >= "expiresAt"
  )
);

-- PAID exactly when paidAt is set.
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_paid_check" CHECK (
  ("status" = 'PAID') = ("paidAt" IS NOT NULL)
);

-- A paid P2P intent keeps its amount reserved at least until the moment it was paid.
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_p2p_paid_check" CHECK (
  "provider" <> 'P2P_CARD'
  OR "status" <> 'PAID'
  OR ("reservedUntil" IS NOT NULL AND "paidAt" IS NOT NULL AND "reservedUntil" >= "paidAt")
);

-- Two waiting requests can never share an amount on one card, and a user has at most one
-- waiting P2P request. The EXCLUDE below covers the first rule too; this plain unique stays
-- because it reports the race as an ordinary unique violation (23505, Prisma P2002), which the
-- allocator handles by retrying with another suffix, while the exclusion reports 23P01.
CREATE UNIQUE INDEX "PaymentIntent_card_amount_pending_key" ON "PaymentIntent" ("cardId", "amountTiyin")
  WHERE "status" = 'PENDING';

CREATE UNIQUE INDEX "PaymentIntent_user_pending_p2p_key" ON "PaymentIntent" ("userId")
  WHERE "status" = 'PENDING' AND "provider" = 'P2P_CARD';

-- A unique amount stays taken on its card from creation until "reservedUntil", whatever the
-- intent's status (expired, cancelled, paid). Without this, a repeat payment of an amount that
-- was just paid would be handed to another user and credited to the wrong wallet. btree_gist
-- (a trusted extension) provides the GiST operator classes for "=" on text and bigint.
-- "createdAt" and "reservedUntil" are UTC timestamps without zone, so tsrange (not tstzrange).
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_card_amount_reserved_excl"
  EXCLUDE USING gist (
    "cardId" WITH =,
    "amountTiyin" WITH =,
    tsrange("createdAt", "reservedUntil") WITH &&
  ) WHERE ("provider" = 'P2P_CARD');

-- ============================================================================================
-- Payment
-- ============================================================================================

-- A payment comes from an intent (automatic) or from a review (the owner credited it).
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_source_check" CHECK (
  "intentId" IS NOT NULL OR "reviewId" IS NOT NULL
);

-- A P2P payment is always one bank message; its unique "bankMessageId" is the idempotency key.
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_p2p_check" CHECK (
  "provider" <> 'P2P_CARD' OR "bankMessageId" IS NOT NULL
);

-- ============================================================================================
-- BankMessage, BankMessageText, BankMessageOutcome
-- ============================================================================================

-- A parsed message carries everything the matcher needs.
ALTER TABLE "BankMessage" ADD CONSTRAINT "BankMessage_parsed_check" CHECK (
  "parseStatus" <> 'PARSED'
  OR (
    "direction" IS NOT NULL
    AND "amountTiyin" IS NOT NULL AND "amountTiyin" > 0
    AND "balanceAfterTiyin" IS NOT NULL
    AND "last4" IS NOT NULL AND "last4" ~ '^[0-9]{4}$'
    AND "bankTxnAt" IS NOT NULL
  )
);

-- Anything that is not parsed says why (UNRECOGNIZED included).
ALTER TABLE "BankMessage" ADD CONSTRAINT "BankMessage_reason_check" CHECK (
  "parseStatus" = 'PARSED'
  OR ("rejectReason" IS NOT NULL AND length(btrim("rejectReason")) > 0)
);

-- Append-only / insert-once. TRUNCATE (test cleanup) does not fire row triggers.
CREATE TRIGGER "BankMessage_append_only" BEFORE UPDATE OR DELETE ON "BankMessage"
  FOR EACH ROW EXECUTE FUNCTION ggpin_forbid_mutation();
CREATE TRIGGER "BankMessageOutcome_append_only" BEFORE UPDATE OR DELETE ON "BankMessageOutcome"
  FOR EACH ROW EXECUTE FUNCTION ggpin_forbid_mutation();

-- The raw bank text is erased after the retention period (E-25: 1 year). The only change this
-- trigger lets through is the purge itself: "text" becomes NULL once "purgeAfter" has passed,
-- every other column untouched. Any other UPDATE and every DELETE raises GG001. "purgeAfter" is
-- a UTC timestamp without zone (Prisma), so now() is converted to UTC before comparing.
CREATE FUNCTION ggpin_bank_message_text_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD."text" IS NOT NULL
     AND NEW."text" IS NULL
     AND timezone('UTC', now()) >= OLD."purgeAfter"
     AND NEW."bankMessageId" = OLD."bankMessageId"
     AND NEW."purgeAfter" = OLD."purgeAfter"
     AND NEW."createdAt" = OLD."createdAt" THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'GG001',
          HINT = 'Only the retention purge is allowed: set "text" to NULL after "purgeAfter".';
END;
$$;

CREATE TRIGGER "BankMessageText_guard" BEFORE UPDATE OR DELETE ON "BankMessageText"
  FOR EACH ROW EXECUTE FUNCTION ggpin_bank_message_text_guard();

-- ============================================================================================
-- PaymentReview
-- ============================================================================================

-- RESOLVED exactly when a resolution AND a time are recorded; an OPEN review has neither.
ALTER TABLE "PaymentReview" ADD CONSTRAINT "PaymentReview_resolved_check" CHECK (
  ("status" = 'RESOLVED') = ("resolution" IS NOT NULL)
  AND ("status" = 'RESOLVED') = ("resolvedAt" IS NOT NULL)
);
