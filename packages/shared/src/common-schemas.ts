// Building blocks shared by several request/response schemas. One definition of "a resource id"
// and "free text typed by a customer" keeps every endpoint rejecting the same bad input the
// same way (a clean 400 instead of a database error).
import { z } from 'zod';

// Row ids are Prisma cuid(2) (lowercase letters and digits). The allowed set is a little wider
// on purpose (fixtures use `prod_1`, `no-such-product`) but has no control characters: a NUL
// byte reaches Postgres as an invalid text value and would answer 500 instead of a clean 400.
const ID_PATTERN = /^[A-Za-z0-9_-]+$/;
export const ResourceIdSchema = z.string().min(1).max(64).regex(ID_PATTERN);

// Free text typed by a customer: no control characters (NUL, newline, tab, DEL) for the same
// reason. \P{Cc} is "any character that is not a control character".
export const NO_CONTROL_CHARS = /^\P{Cc}*$/u;

/**
 * `Idempotency-Key` header (docs/04): required on order and payment-intent creation, unique per
 * user. A UUID fits; the bound keeps the DB unique index small and the value log-safe.
 */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
export const IdempotencyKeySchema = z.string().regex(IDEMPOTENCY_KEY_PATTERN);

// ---- pagination (docs/04: `?page=1&limit=20`, limit <= 100, `meta: { page, limit, total }`) ----
export const LIST_MAX_LIMIT = 100;
export const LIST_DEFAULT_LIMIT = 20;
export const LIST_MAX_PAGE = 10_000;

export const pageQueryShape = {
  page: z.coerce.number().int().min(1).max(LIST_MAX_PAGE).default(1),
  limit: z.coerce.number().int().min(1).max(LIST_MAX_LIMIT).default(LIST_DEFAULT_LIMIT),
} as const;

export const PageMetaSchema = z.object({
  page: z.number().int().min(1),
  limit: z.number().int().min(1).max(LIST_MAX_LIMIT),
  total: z.number().int().min(0),
});
export type PageMeta = z.infer<typeof PageMetaSchema>;
