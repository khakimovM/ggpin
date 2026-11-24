import {
  AdminProductUpdateBodySchema,
  type AdminProductDetailResponse,
  type AdminProductUpdateBody,
} from '@repo/shared';

// The product editor sends only what changed (plan S8b): the audit row then names exactly the
// edited fields, and an untouched field can never overwrite a newer value saved meanwhile.

export interface ProductDraft {
  nameUz: string;
  nameRu: string;
  descriptionUz: string;
  descriptionRu: string;
  helpUz: string;
  helpRu: string;
  regionBadge: string;
  imageUrl: string;
  isActive: boolean;
  isFeatured: boolean;
}

export type ProductTextField = Exclude<keyof ProductDraft, 'isActive' | 'isFeatured'>;

export function productDraftOf(product: AdminProductDetailResponse): ProductDraft {
  return {
    nameUz: product.nameUz,
    nameRu: product.nameRu,
    descriptionUz: product.descriptionUz ?? '',
    descriptionRu: product.descriptionRu ?? '',
    helpUz: product.helpUz ?? '',
    helpRu: product.helpRu ?? '',
    regionBadge: product.regionBadge ?? '',
    imageUrl: product.imageUrl,
    isActive: product.isActive,
    isFeatured: product.isFeatured,
  };
}

const orNull = (text: string) => (text.trim() === '' ? null : text.trim());

/** The draft as the API would store it (blank optional text = null). */
function wireOf(draft: ProductDraft) {
  return {
    nameUz: draft.nameUz.trim(),
    nameRu: draft.nameRu.trim(),
    descriptionUz: orNull(draft.descriptionUz),
    descriptionRu: orNull(draft.descriptionRu),
    helpUz: orNull(draft.helpUz),
    helpRu: orNull(draft.helpRu),
    regionBadge: orNull(draft.regionBadge),
    imageUrl: draft.imageUrl.trim(),
    isActive: draft.isActive,
    isFeatured: draft.isFeatured,
  };
}

export interface ProductChange {
  /** The changed fields only; null when nothing changed or a changed field is not valid. */
  body: AdminProductUpdateBody | null;
  /** Names of the changed fields (wire names), for the confirmation dialog. */
  fields: (keyof ReturnType<typeof wireOf>)[];
  /** Changed fields the shared schema refuses. */
  invalid: ProductTextField[];
}

export function productChange(
  product: AdminProductDetailResponse,
  draft: ProductDraft,
): ProductChange {
  const saved = wireOf(productDraftOf(product));
  const next = wireOf(draft);
  const fields = (Object.keys(next) as (keyof typeof next)[]).filter(
    (key) => next[key] !== saved[key],
  );
  const changed = Object.fromEntries(fields.map((key) => [key, next[key]]));
  const parsed = AdminProductUpdateBodySchema.safeParse(changed);
  if (parsed.success) return { body: fields.length > 0 ? parsed.data : null, fields, invalid: [] };
  const invalid = parsed.error.issues
    .map((issue) => String(issue.path[0]))
    .filter((path): path is ProductTextField => fields.some((field) => field === path));
  return { body: null, fields, invalid: [...new Set(invalid)] };
}
