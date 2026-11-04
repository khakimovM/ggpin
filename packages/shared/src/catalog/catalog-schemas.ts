// Request and response shapes of docs/04-API-CONTRACT.md "Katalog" (phase 3 plan, "API
// contract"). These describe the `data` payload; the envelope is in the API. Queries are
// `.strict()` on purpose: these routes are publicly cacheable, so an unknown key must be a
// 400 (never cached) rather than an unbounded set of distinct cache keys.
import { z } from 'zod';
import { DEFAULT_LOCALE, LOCALES } from '../auth/locale';
import { TiyinStringSchema } from '../money-schemas';
import { ProductInputSchema } from './input-schema';

export const CATALOG_MAX_LIMIT = 100;
export const CATALOG_DEFAULT_LIMIT = 20;
export const CATALOG_MAX_PAGE = 10_000;
export const CATALOG_SEARCH_MAX_LENGTH = 64;

export const DELIVERY_TYPES = [
  'TG_USERNAME',
  'GAME_ID',
  'STEAM_LOGIN',
  'VOUCHER',
  'USERNAME',
] as const;
export const DeliveryTypeSchema = z.enum(DELIVERY_TYPES);
export type DeliveryTypeName = z.infer<typeof DeliveryTypeSchema>;

const SlugSchema = z
  .string()
  .max(64)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/);
const LocaleSchema = z.enum(LOCALES).default(DEFAULT_LOCALE);

// ---- queries ----------------------------------------------------------------------------
export const CatalogLocaleQuerySchema = z.strictObject({ locale: LocaleSchema });
export type CatalogLocaleQuery = z.infer<typeof CatalogLocaleQuerySchema>;

export const ProductListQuerySchema = z.strictObject({
  category: SlugSchema.optional(),
  // An empty search box means "no filter", not "match the empty string". Control characters
  // are refused: Postgres rejects a NUL byte in text, which would turn the request into a 500.
  q: z
    .string()
    .trim()
    .max(CATALOG_SEARCH_MAX_LENGTH)
    .regex(/^\P{Cc}*$/u, 'search text must not contain control characters')
    .transform((value) => (value === '' ? undefined : value))
    .optional(),
  locale: LocaleSchema,
  page: z.coerce.number().int().min(1).max(CATALOG_MAX_PAGE).default(1),
  limit: z.coerce.number().int().min(1).max(CATALOG_MAX_LIMIT).default(CATALOG_DEFAULT_LIMIT),
});
export type ProductListQuery = z.infer<typeof ProductListQuerySchema>;

export const ProductSlugParamsSchema = z.strictObject({ slug: SlugSchema });
export type ProductSlugParams = z.infer<typeof ProductSlugParamsSchema>;

// ---- responses --------------------------------------------------------------------------
export const CatalogCategorySchema = z.object({
  slug: SlugSchema,
  name: z.string().min(1),
  productCount: z.number().int().min(1),
});
export type CatalogCategory = z.infer<typeof CatalogCategorySchema>;

export const CatalogProductListItemSchema = z.object({
  id: z.string().min(1),
  slug: SlugSchema,
  categorySlug: SlugSchema,
  name: z.string().min(1),
  imageUrl: z.string().min(1),
  regionBadge: z.string().min(1).nullable(),
  deliveryType: DeliveryTypeSchema,
  isAuto: z.boolean(),
  isFeatured: z.boolean(),
  inStock: z.boolean(),
  /** null when there is no fresh price; the client shows no price, never a stale one. */
  fromPriceTiyin: TiyinStringSchema.nullable(),
});
export type CatalogProductListItem = z.infer<typeof CatalogProductListItemSchema>;

export const CatalogListMetaSchema = z.object({
  page: z.number().int().min(1),
  limit: z.number().int().min(1).max(CATALOG_MAX_LIMIT),
  total: z.number().int().min(0),
});
export type CatalogListMeta = z.infer<typeof CatalogListMetaSchema>;

export const CatalogSkuSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  quantity: z.number().int().positive(),
  /** Group label as an i18n key ("UC tezkor"), null when the product has no tabs. */
  tab: z.string().min(1).nullable(),
  fromPriceTiyin: TiyinStringSchema.nullable(),
});
export type CatalogSku = z.infer<typeof CatalogSkuSchema>;

export const CatalogProductDetailSchema = z
  .object({
    id: z.string().min(1),
    slug: SlugSchema,
    name: z.string().min(1),
    description: z.string().nullable(),
    help: z.string().nullable(),
    imageUrl: z.string().min(1),
    deliveryType: DeliveryTypeSchema,
    regionBadge: z.string().min(1).nullable(),
    isAuto: z.boolean(),
    allowCustomQty: z.boolean(),
    minQty: z.number().int().positive().nullable(),
    maxQty: z.number().int().positive().nullable(),
    inputSchema: ProductInputSchema,
    skus: z.array(CatalogSkuSchema),
    /** Display only ("1 star costs about X"); the real price exists only in a quote. */
    unitPriceTiyin: TiyinStringSchema.nullable(),
    /** null means unlimited (no voucher inventory behind the product). */
    stock: z.number().int().min(0).nullable(),
    currency: z.literal('UZS'),
  })
  .refine(
    ({ allowCustomQty, minQty, maxQty }) =>
      (!allowCustomQty || (minQty !== null && maxQty !== null)) &&
      (minQty === null || maxQty === null || minQty <= maxQty),
    { message: 'custom quantity needs minQty <= maxQty', path: ['minQty'] },
  );
export type CatalogProductDetail = z.infer<typeof CatalogProductDetailSchema>;
