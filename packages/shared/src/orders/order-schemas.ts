// Wire shapes of docs/04 ("Qabul qiluvchi va kotirovka", "Buyurtmalar"). Final since the owner
// accepted the phase 5 plan without changes (D-56 (1)): the frontend builds against them and the
// orders API (phase 5 S2) answers with exactly these. They describe the `data` payload; the
// envelope is added by the API. Every field is derived from the Order/Quote models and the
// sentences already in docs/04 and docs/06; `Order.statusReason`, cost, margin, fx and attempts
// are internal and have no field here.
import { z } from 'zod';
import { DEFAULT_LOCALE, LOCALES } from '../auth/locale';
import { SlugSchema } from '../catalog/catalog-schemas';
import { NO_CONTROL_CHARS, ResourceIdSchema, pageQueryShape } from '../common-schemas';
import { SignedTiyinStringSchema, TiyinStringSchema } from '../money-schemas';
import { ORDER_STATUSES, orderStatusSchema } from '../order-state';
import { RECIPIENT_TOKEN_PATTERN, RecipientSchema } from '../pricing/quote-schemas';

const LocaleSchema = z.enum(LOCALES).default(DEFAULT_LOCALE);

// ---- POST /recipients/validate -------------------------------------------------------------
const INPUT_KEY_PATTERN = /^[a-z][A-Za-z0-9]{0,31}$/;
const MAX_INPUT_FIELDS = 8;

export const ValidateRecipientBodySchema = z.strictObject({
  productId: ResourceIdSchema,
  // Keys are the product's `inputSchema` field keys (`username` for a tgUsername field,
  // `playerId` and `zone` for a game). The service validates each value against that field's
  // type; here only the wire shape is fixed.
  input: z
    .record(
      z.string().regex(INPUT_KEY_PATTERN),
      z.string().trim().min(1).max(128).regex(NO_CONTROL_CHARS),
    )
    .refine((fields) => Object.keys(fields).length <= MAX_INPUT_FIELDS, {
      message: 'too many input fields',
    }),
});
export type ValidateRecipientBody = z.infer<typeof ValidateRecipientBodySchema>;

/**
 * A non-blocking remark about a valid recipient (recommendation Q-A: a recipient who cannot
 * receive the product stays a blocking 422 such as `RECIPIENT_HAS_PREMIUM`; `warnings` is for
 * cases that do not block). No warning exists yet, so the array is `[]` for Telegram Stars and
 * the code list is open: `message` is an i18n key in a future `warnings.*` namespace.
 */
export const RecipientWarningSchema = z.strictObject({
  code: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
  message: z.string().regex(/^warnings\.[A-Za-z0-9_.]{1,64}$/),
});
export type RecipientWarning = z.infer<typeof RecipientWarningSchema>;

export const ValidateRecipientResponseSchema = z.strictObject({
  recipientToken: z.string().regex(RECIPIENT_TOKEN_PATTERN),
  displayName: RecipientSchema.shape.displayName,
  photoUrl: RecipientSchema.shape.photoUrl,
  warnings: z.array(RecipientWarningSchema).max(8),
});
export type ValidateRecipientResponse = z.infer<typeof ValidateRecipientResponseSchema>;

// ---- POST /orders --------------------------------------------------------------------------
export const CreateOrderBodySchema = z.strictObject({ quoteId: ResourceIdSchema });
export type CreateOrderBody = z.infer<typeof CreateOrderBodySchema>;

/**
 * Who receives the order, in a shape that fits every product: `displayName` is what to show,
 * `fields` holds the same keys as the product's input form (`{ username }` for Telegram,
 * `{ playerId, zone }` for a game), so nothing is tied to a Telegram username.
 */
export const OrderRecipientSchema = z.strictObject({
  displayName: z.string().min(1).max(128),
  fields: z.record(z.string().regex(INPUT_KEY_PATTERN), z.string().min(1).max(128)),
});
export type OrderRecipient = z.infer<typeof OrderRecipientSchema>;

/**
 * Order as the owner sees it. `status` is the raw state; the client maps it to a label
 * (docs/04 "Buyurtma holatlari klientda"). No cost, margin, fx, attempt or internal reason.
 */
export const OrderSchema = z.strictObject({
  id: ResourceIdSchema,
  /** The # shown to the user. */
  number: z.number().int().positive(),
  status: orderStatusSchema,
  productId: ResourceIdSchema,
  productSlug: SlugSchema,
  /** Localised like the catalog (recommendation Q-B: `?locale=uz|ru`, default uz). */
  productName: z.string().min(1),
  skuId: ResourceIdSchema.nullable(),
  quantity: z.number().int().positive(),
  recipient: OrderRecipientSchema,
  priceTiyin: TiyinStringSchema,
  discountTiyin: TiyinStringSchema,
  totalTiyin: TiyinStringSchema,
  currency: z.literal('UZS'),
  createdAt: z.iso.datetime(),
  deliveredAt: z.iso.datetime().nullable(),
});
export type OrderDto = z.infer<typeof OrderSchema>;

/** `201` of `POST /orders`: `data` is `{ order }` as docs/04 writes it (recommendation Q-F). */
export const CreateOrderResponseSchema = z.strictObject({ order: OrderSchema });
export type CreateOrderResponse = z.infer<typeof CreateOrderResponseSchema>;

// ---- GET /orders and GET /orders/:id ---------------------------------------------------------
// Recommendation Q-C: `?status=PAID,QUEUED` (comma-separated, each a raw status) so one client
// label group is one request. A single value stays valid.
const StatusListSchema = z
  .string()
  .transform((value) => value.split(','))
  .pipe(z.array(orderStatusSchema).min(1).max(ORDER_STATUSES.length));

export const OrderListQuerySchema = z.strictObject({
  status: StatusListSchema.optional(),
  locale: LocaleSchema,
  ...pageQueryShape,
});
export type OrderListQuery = z.infer<typeof OrderListQuerySchema>;

export const OrderDetailQuerySchema = z.strictObject({ locale: LocaleSchema });
export type OrderDetailQuery = z.infer<typeof OrderDetailQuerySchema>;

export const OrderParamsSchema = z.strictObject({ id: ResourceIdSchema });
export type OrderParams = z.infer<typeof OrderParamsSchema>;

/** One state change for the timeline: when the order entered `status`. No actor, no note. */
export const OrderTimelineItemSchema = z.strictObject({
  status: orderStatusSchema,
  at: z.iso.datetime(),
});

export const OrderDetailSchema = OrderSchema.extend({
  /** Oldest first. */
  timeline: z.array(OrderTimelineItemSchema).min(1),
  /** Gift-card style code, only once DELIVERED. `null` for everything but voucher products (G4). */
  voucher: z.strictObject({ code: z.string().min(1).max(512) }).nullable(),
});
export type OrderDetail = z.infer<typeof OrderDetailSchema>;

// ---- POST /orders: the answers that carry `details` ------------------------------------------
// Positive: a tiyin string other than "0" (TiyinStringSchema allows no leading zeros), review N7.
const PositiveTiyinStringSchema = TiyinStringSchema.refine((value) => value !== '0', {
  message: 'a positive amount',
});

/**
 * `422 INSUFFICIENT_BALANCE`: the SERVER's numbers; the client never works out a shortfall.
 * `balance` is signed (owner decision D-60): a reversed top-up can leave the wallet below zero,
 * and then the shortfall covers the debt too. `required` and `shortfall` are positive.
 */
export const InsufficientBalanceDetailsSchema = z.strictObject({
  balance: SignedTiyinStringSchema,
  required: PositiveTiyinStringSchema,
  shortfall: PositiveTiyinStringSchema,
});
export type InsufficientBalanceDetails = z.infer<typeof InsufficientBalanceDetailsSchema>;

/** `409 QUOTE_ALREADY_USED` (docs/04, Q-D): the caller's OWN order that this quote became. */
export const QuoteAlreadyUsedDetailsSchema = z.strictObject({ orderId: ResourceIdSchema });
export type QuoteAlreadyUsedDetails = z.infer<typeof QuoteAlreadyUsedDetailsSchema>;
