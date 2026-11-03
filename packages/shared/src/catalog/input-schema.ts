// Product.inputSchema: the recipient form a product needs (docs/04 "Katalog"). Phase 3 knows
// one field type; later phases add members to the union (playerId, steamLogin, ...) without
// touching existing rows, because the discriminator is `type`.
import { z } from 'zod';

/** `area.name` style i18n key (`fields.tgUsername`); the text lives in packages/i18n. */
const I18N_KEY_PATTERN = /^[a-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*)+$/;
const FIELD_KEY_PATTERN = /^[a-z][A-Za-z0-9]{0,31}$/;

export const MAX_INPUT_FIELDS = 8;

export const InputFieldSchema = z.discriminatedUnion('type', [
  z.strictObject({
    key: z.string().regex(FIELD_KEY_PATTERN),
    type: z.literal('tgUsername'),
    label: z.string().max(64).regex(I18N_KEY_PATTERN),
  }),
]);
export type InputField = z.infer<typeof InputFieldSchema>;

export const ProductInputSchema = z
  .array(InputFieldSchema)
  .max(MAX_INPUT_FIELDS)
  .refine((fields) => new Set(fields.map((field) => field.key)).size === fields.length, {
    message: 'input field keys must be unique',
  });
export type ProductInput = z.infer<typeof ProductInputSchema>;
