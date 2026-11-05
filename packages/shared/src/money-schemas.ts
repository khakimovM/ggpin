// Wire format of money (CLAUDE.md invariant 1): a non-negative integer of minor units as a
// decimal STRING, never a JSON number. Bounded to what a Postgres BIGINT column can hold.
import { z } from 'zod';

const BIGINT_MAX = 2n ** 63n - 1n;

// The range check is piped AFTER the shape check, not chained with `.refine`: Zod 4 runs a
// refinement even when the regex failed, and `BigInt('20000.50')` throws a SyntaxError, which
// a request body would turn into a 500 instead of a 400.
export const TiyinStringSchema = z
  .string()
  .regex(/^(0|[1-9]\d{0,18})$/)
  .pipe(
    z.string().refine((value) => BigInt(value) <= BIGINT_MAX, { message: 'amount exceeds BIGINT' }),
  );
export type TiyinString = z.infer<typeof TiyinStringSchema>;

/**
 * A signed amount for ledger rows, where a purchase is negative: `"-550000"`. Same bounds as
 * `TiyinStringSchema`, no `-0`, no leading zeros, no `+`.
 */
export const SignedTiyinStringSchema = z
  .string()
  .regex(/^(0|-?[1-9]\d{0,18})$/)
  .pipe(
    z.string().refine((value) => BigInt(value) <= BIGINT_MAX && BigInt(value) >= -BIGINT_MAX, {
      message: 'amount exceeds BIGINT',
    }),
  );
export type SignedTiyinString = z.infer<typeof SignedTiyinStringSchema>;
