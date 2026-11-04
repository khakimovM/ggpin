// Wire format of money (CLAUDE.md invariant 1): a non-negative integer of minor units as a
// decimal STRING, never a JSON number. Bounded to what a Postgres BIGINT column can hold.
import { z } from 'zod';

const BIGINT_MAX = 2n ** 63n - 1n;

export const TiyinStringSchema = z
  .string()
  .regex(/^(0|[1-9]\d{0,18})$/)
  .refine((value) => BigInt(value) <= BIGINT_MAX, { message: 'amount exceeds BIGINT' });
export type TiyinString = z.infer<typeof TiyinStringSchema>;
