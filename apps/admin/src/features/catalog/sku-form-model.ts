import {
  ADMIN_MAX_MIN_MARGIN_TIYIN,
  AdminSkuCreateBodySchema,
  AdminSkuUpdateBodySchema,
  type AdminProductDetailResponse,
  type AdminSkuCreateBody,
  type AdminSkuUpdateBody,
} from '@repo/shared';
import { formatTiyin } from '../../lib/format';
import { parseAmountInput } from '../common/amount-input';

// The SKU dialog's text fields and their wire values (plan S8b). A percent is read as text into
// whole basis points (no float ever: "12.5" is 12 and 50 hundredths), so'm into tiyin through the
// shared money parser only. The server checks every bound again (docs/04 «Katalog»).

type Sku = AdminProductDetailResponse['skus'][number];

export interface SkuDraft {
  tab: string;
  labelUz: string;
  labelRu: string;
  quantity: string;
  supplierSku: string;
  markup: string;
  minMargin: string;
  isActive: boolean;
  sort: string;
}

export type SkuField = Exclude<keyof SkuDraft, 'isActive'>;
export type SkuIssues = Partial<Record<SkuField, 'required' | 'invalid'>>;

const PERCENT = /^(\d{1,3})(?:[.,](\d{1,2}))?$/;
const MAX_BPS = 10_000;

/** "12.5" / "12,5" → 1250; more than two decimals, above 100 % or not a number → null. */
export function percentToBps(raw: string): number | null {
  const match = PERCENT.exec(raw.trim());
  if (match === null) return null;
  const whole = match[1] ?? '0';
  const hundredths = (match[2] ?? '').padEnd(2, '0');
  // Digits glued as text, then read as one integer: 12 and "50" → "1250".
  const bps = Number.parseInt(`${whole}${hundredths}`, 10);
  return bps <= MAX_BPS ? bps : null;
}

/** 1250 → "12,5", 1205 → "12,05", 1200 → "12": exact, for refilling the field. */
export function bpsToPercentText(bps: number): string {
  const whole = Math.trunc(bps / 100);
  const rest = String(bps % 100)
    .padStart(2, '0')
    .replace(/0+$/, '');
  return rest === '' ? String(whole) : `${whole},${rest}`;
}

/** The minimum margin in tiyin: 0 is allowed, the top is 100 mln so‘m; null when not valid. */
export function minMarginToTiyin(raw: string): string | null {
  const parsed = parseAmountInput(raw, { maxTiyin: ADMIN_MAX_MIN_MARGIN_TIYIN });
  if (parsed.ok) return parsed.tiyin;
  return parsed.issue === 'zero' ? '0' : null;
}

function wholeNumber(raw: string, min: number, max: number): number | null {
  const text = raw.trim();
  if (!/^\d{1,10}$/.test(text)) return null;
  const value = Number.parseInt(text, 10);
  return value >= min && value <= max ? value : null;
}

export const quantityOf = (raw: string) => wholeNumber(raw, 1, 1_000_000_000);
export const sortOf = (raw: string) => wholeNumber(raw, 0, 1_000_000);

export function skuDraftOf(sku: Sku): SkuDraft {
  return {
    tab: sku.tab ?? '',
    labelUz: sku.labelUz,
    labelRu: sku.labelRu,
    quantity: String(sku.quantity),
    supplierSku: sku.supplierSku ?? '',
    markup: bpsToPercentText(sku.markupBps),
    minMargin: formatTiyin(sku.minMarginTiyin),
    isActive: sku.isActive,
    sort: String(sku.sort),
  };
}

export function emptySkuDraft(sort: number): SkuDraft {
  return {
    tab: '',
    labelUz: '',
    labelRu: '',
    quantity: '',
    supplierSku: '',
    markup: '',
    minMargin: '0',
    isActive: true,
    sort: String(sort),
  };
}

const optional = (text: string) => (text.trim() === '' ? null : text.trim());

/** Every field of the draft as the API takes it (a create body without the reason). */
function wireOf(draft: SkuDraft) {
  return {
    tab: optional(draft.tab),
    labelUz: draft.labelUz.trim(),
    labelRu: draft.labelRu.trim(),
    quantity: quantityOf(draft.quantity),
    supplierSku: optional(draft.supplierSku),
    markupBps: percentToBps(draft.markup),
    minMarginTiyin: minMarginToTiyin(draft.minMargin),
    isActive: draft.isActive,
    sort: sortOf(draft.sort),
  };
}

const FIELD_OF: Record<string, SkuField> = {
  tab: 'tab',
  labelUz: 'labelUz',
  labelRu: 'labelRu',
  quantity: 'quantity',
  supplierSku: 'supplierSku',
  markupBps: 'markup',
  minMarginTiyin: 'minMargin',
  sort: 'sort',
};

/** What is wrong with the draft, field by field (the shared schema has the last word). */
export function skuIssues(draft: SkuDraft): SkuIssues {
  const issues: SkuIssues = {};
  const parsed = AdminSkuCreateBodySchema.safeParse(wireOf(draft));
  if (parsed.success) return issues;
  for (const issue of parsed.error.issues) {
    const field = FIELD_OF[String(issue.path[0])];
    if (field === undefined || issues[field] !== undefined) continue;
    const blank = draft[field].trim() === '';
    issues[field] = blank && field !== 'tab' && field !== 'supplierSku' ? 'required' : 'invalid';
  }
  return issues;
}

export function skuCreateBody(draft: SkuDraft): AdminSkuCreateBody | null {
  const parsed = AdminSkuCreateBodySchema.safeParse(wireOf(draft));
  return parsed.success ? parsed.data : null;
}

export interface SkuChange {
  /** Only the fields that differ from the saved SKU; null when the draft is not valid. */
  body: AdminSkuUpdateBody | null;
  /** Nothing differs: there is nothing to save. */
  empty: boolean;
  /** The package size changes: no price until the next cost sync (docs/04, PRICE_UNAVAILABLE). */
  quantityChanged: boolean;
}

export function skuUpdateChange(sku: Sku, draft: SkuDraft): SkuChange {
  const wire = skuCreateBody(draft);
  if (wire === null) return { body: null, empty: false, quantityChanged: false };
  const changed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(wire)) {
    const before = sku[key as keyof Sku];
    if (value !== before) changed[key] = value;
  }
  const quantityChanged = 'quantity' in changed;
  if (Object.keys(changed).length === 0) return { body: null, empty: true, quantityChanged };
  const parsed = AdminSkuUpdateBodySchema.safeParse(changed);
  return { body: parsed.success ? parsed.data : null, empty: false, quantityChanged };
}
