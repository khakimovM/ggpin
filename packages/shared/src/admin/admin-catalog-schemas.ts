// `/api/v1/admin/{categories,products,skus,routes}` (docs/04 "Admin" — catalog; docs/09 §4; plan
// S8, D-63 (8)). Reads for every role, writes OWNER only. Not editable here: `inputSchema`,
// `deliveryType`, new products, image upload (only a path under `/assets/`), vouchers.
import { z } from 'zod';
import { ResourceIdSchema } from '../common-schemas';
import { DeliveryTypeSchema } from '../catalog/catalog-schemas';
import { SignedTiyinStringSchema, TiyinStringSchema } from '../money-schemas';
import { ADMIN_MAX_MIN_MARGIN_TIYIN } from './admin-catalog-rules';
import {
  AdminReasonSchema,
  IsoDateTimeSchema,
  MinorUnitsStringSchema,
  adminMultiLine,
  adminQueryInt,
  adminSingleLine,
  adminStateResultShape,
} from './admin-common-schemas';

const CountSchema = z.number().int().min(0);
const SortSchema = z.number().int().min(0).max(1_000_000);
// Text an admin types is shown to every customer: no invisible or bidi character (review CR-M3).
const NameSchema = adminSingleLine(120);
const TextSchema = adminMultiLine(4000);
/** A decimal integer as typed in a query string: no sign, hex, exponent or padding (CR-L1). */
const queryInt = adminQueryInt;
/** Markup in basis points, 0..10 000 (0–100 %, D-63 (8)). */
export const MarkupBpsSchema = z.number().int().min(0).max(10_000);
/** A package's minimum margin written by the panel: 0..10 000 000 000 tiyin (owner 2026-11-22). */
export const AdminMinMarginTiyinSchema = TiyinStringSchema.refine(
  (value) => BigInt(value) <= ADMIN_MAX_MIN_MARGIN_TIYIN,
  { message: 'minimum margin above 100 mln so‘m' },
);
/** A site path under `/assets/`, no `..`, no query: images are never uploaded through the panel. */
export const AssetPathSchema = z
  .string()
  .max(200)
  .regex(/^\/assets\/[A-Za-z0-9_\-/]+\.(png|jpg|jpeg|webp|svg)$/)
  .refine((path) => !path.includes('//'), { message: 'no empty path segment' });

export const AdminCategorySchema = z.strictObject({
  id: ResourceIdSchema,
  slug: z.string(),
  nameUz: z.string(),
  nameRu: z.string(),
  sort: SortSchema,
  productsCount: CountSchema,
});
export const AdminCategoryListResponseSchema = z.array(AdminCategorySchema);
export type AdminCategoryListResponse = z.infer<typeof AdminCategoryListResponseSchema>;

export const ROUTE_HEALTH_STATES = ['OK', 'DEGRADED', 'DOWN', 'UNKNOWN'] as const;

export const AdminRouteSchema = z.strictObject({
  id: ResourceIdSchema,
  adapter: z.string(),
  priority: z.number().int().min(0).max(1000),
  isEnabled: z.boolean(),
  /** From the adapter health key (`adapter:health:<code>`, phase 5); UNKNOWN when absent. */
  health: z.enum(ROUTE_HEALTH_STATES),
  healthCheckedAt: IsoDateTimeSchema.nullable(),
});

export const AdminSkuSchema = z.strictObject({
  id: ResourceIdSchema,
  tab: z.string().nullable(),
  labelUz: z.string(),
  labelRu: z.string(),
  quantity: z.number().int().min(1),
  supplierSku: z.string().nullable(),
  markupBps: MarkupBpsSchema,
  minMarginTiyin: TiyinStringSchema,
  isActive: z.boolean(),
  sort: SortSchema,
});

export const AdminProductRowSchema = z.strictObject({
  id: ResourceIdSchema,
  slug: z.string(),
  categoryId: ResourceIdSchema,
  nameUz: z.string(),
  nameRu: z.string(),
  imageUrl: z.string(),
  deliveryType: DeliveryTypeSchema,
  isActive: z.boolean(),
  isFeatured: z.boolean(),
  sort: SortSchema,
  activeSkusCount: CountSchema,
  routesEnabledCount: CountSchema,
});
export const AdminProductListResponseSchema = z.array(AdminProductRowSchema);
export type AdminProductListResponse = z.infer<typeof AdminProductListResponseSchema>;

export const AdminProductDetailResponseSchema = AdminProductRowSchema.extend({
  descriptionUz: z.string().nullable(),
  descriptionRu: z.string().nullable(),
  helpUz: z.string().nullable(),
  helpRu: z.string().nullable(),
  regionBadge: z.string().nullable(),
  isAuto: z.boolean(),
  allowCustomQty: z.boolean(),
  minQty: z.number().int().nullable(),
  maxQty: z.number().int().nullable(),
  skus: z.array(AdminSkuSchema),
  routes: z.array(AdminRouteSchema),
  updatedAt: IsoDateTimeSchema,
});
export type AdminProductDetailResponse = z.infer<typeof AdminProductDetailResponseSchema>;

/**
 * `GET /admin/products/:id/price-preview` — the price a quote would lock now, computed by
 * money-pricing.ts only. `skuId` for a package, `quantity` for a free-quantity product; a proposed
 * `markupBps` / `minMarginTiyin` previews an edit before it is saved.
 */
export const AdminPricePreviewQuerySchema = z
  .strictObject({
    skuId: ResourceIdSchema.optional(),
    quantity: queryInt(1_000_000)
      .refine((n) => n >= 1, { message: 'quantity must be positive' })
      .optional(),
    markupBps: queryInt(10_000).optional(),
    minMarginTiyin: TiyinStringSchema.optional(),
  })
  .refine((q) => (q.skuId === undefined) !== (q.quantity === undefined), {
    message: 'give exactly one of skuId or quantity',
    path: ['skuId'],
  });
export type AdminPricePreviewQuery = z.infer<typeof AdminPricePreviewQuerySchema>;

export const AdminPricePreviewResponseSchema = z.strictObject({
  costCurrency: z.string().max(8),
  costMinor: MinorUnitsStringSchema,
  fxRate: z.strictObject({ id: ResourceIdSchema, pair: z.string(), rate: z.string() }).nullable(),
  markupBps: MarkupBpsSchema,
  minMarginTiyin: TiyinStringSchema,
  priceTiyin: TiyinStringSchema,
  /** price − cost in so'm; negative means the price would sell at a loss. */
  marginTiyin: SignedTiyinStringSchema,
  belowMinMargin: z.boolean(),
});
export type AdminPricePreviewResponse = z.infer<typeof AdminPricePreviewResponseSchema>;

const hasChange = (body: Record<string, unknown>): boolean =>
  Object.keys(body).some((key) => key !== 'reason');
const NO_CHANGE = { message: 'nothing to change', path: [] };

/** Catalog writes: `reason` is optional (10..500 when given); at least one field must change. */
export const AdminCategoryUpdateBodySchema = z
  .strictObject({
    nameUz: NameSchema.optional(),
    nameRu: NameSchema.optional(),
    sort: SortSchema.optional(),
    reason: AdminReasonSchema.optional(),
  })
  .refine(hasChange, NO_CHANGE);
export type AdminCategoryUpdateBody = z.infer<typeof AdminCategoryUpdateBodySchema>;

export const AdminProductUpdateBodySchema = z
  .strictObject({
    nameUz: NameSchema.optional(),
    nameRu: NameSchema.optional(),
    descriptionUz: TextSchema.nullable().optional(),
    descriptionRu: TextSchema.nullable().optional(),
    helpUz: TextSchema.nullable().optional(),
    helpRu: TextSchema.nullable().optional(),
    regionBadge: adminSingleLine(12)
      .regex(/^[A-Z]{2,12}$/)
      .nullable()
      .optional(),
    imageUrl: AssetPathSchema.optional(),
    isActive: z.boolean().optional(),
    isFeatured: z.boolean().optional(),
    sort: SortSchema.optional(),
    reason: AdminReasonSchema.optional(),
  })
  .refine(hasChange, NO_CHANGE);
export type AdminProductUpdateBody = z.infer<typeof AdminProductUpdateBodySchema>;

/**
 * `POST /admin/products/reorder`: every product id once, in the new order (sort = index). A
 * repeated id is not refused here: the API answers it with `PRODUCT_SET_MISMATCH` like a missing
 * or foreign one (docs/04, S8a review m1), so the panel sees one code for "not the full set".
 */
export const AdminProductReorderBodySchema = z.strictObject({
  productIds: z.array(ResourceIdSchema).min(1).max(500),
});
export type AdminProductReorderBody = z.infer<typeof AdminProductReorderBodySchema>;

const skuFields = {
  tab: adminSingleLine(64).nullable().optional(),
  labelUz: NameSchema,
  labelRu: NameSchema,
  quantity: z.number().int().min(1).max(1_000_000_000),
  supplierSku: adminSingleLine(128).nullable().optional(),
  markupBps: MarkupBpsSchema,
  minMarginTiyin: AdminMinMarginTiyinSchema,
  isActive: z.boolean(),
  sort: SortSchema,
};

/** `POST /admin/products/:id/skus`. Two active packages of one quantity are refused (docs/04). */
export const AdminSkuCreateBodySchema = z.strictObject({
  ...skuFields,
  reason: AdminReasonSchema.optional(),
});
export type AdminSkuCreateBody = z.infer<typeof AdminSkuCreateBodySchema>;

export const AdminSkuUpdateBodySchema = z
  .strictObject({
    tab: skuFields.tab,
    labelUz: NameSchema.optional(),
    labelRu: NameSchema.optional(),
    quantity: skuFields.quantity.optional(),
    supplierSku: skuFields.supplierSku,
    markupBps: MarkupBpsSchema.optional(),
    minMarginTiyin: AdminMinMarginTiyinSchema.optional(),
    isActive: z.boolean().optional(),
    sort: SortSchema.optional(),
    reason: AdminReasonSchema.optional(),
  })
  .refine(hasChange, NO_CHANGE);
export type AdminSkuUpdateBody = z.infer<typeof AdminSkuUpdateBodySchema>;

export const AdminRouteUpdateBodySchema = z
  .strictObject({
    priority: z.number().int().min(0).max(1000).optional(),
    isEnabled: z.boolean().optional(),
    reason: AdminReasonSchema.optional(),
  })
  .refine(hasChange, NO_CHANGE);
export type AdminRouteUpdateBody = z.infer<typeof AdminRouteUpdateBodySchema>;

/**
 * Catalog write answers. A write that changes nothing (every field already has the asked value)
 * writes no audit row: `auditId: null`, `applied: false` (review CR-M2, the CLI's no-op rule).
 */
export const AdminCategoryUpdateResponseSchema = z.strictObject({
  category: AdminCategorySchema,
  ...adminStateResultShape,
});
export const AdminProductUpdateResponseSchema = z.strictObject({
  product: AdminProductDetailResponseSchema,
  ...adminStateResultShape,
});
export const AdminProductReorderResponseSchema = z.strictObject({
  products: z.array(z.strictObject({ id: ResourceIdSchema, sort: SortSchema })),
  ...adminStateResultShape,
});
export const AdminSkuResponseSchema = z.strictObject({
  sku: AdminSkuSchema,
  ...adminStateResultShape,
});
export const AdminRouteUpdateResponseSchema = z.strictObject({
  route: AdminRouteSchema,
  ...adminStateResultShape,
});
