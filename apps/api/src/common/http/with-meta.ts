// Return this from a handler to get `{ success: true, data, meta }`. A plain return value
// becomes `{ success: true, data }` with no `meta`.
export class WithMeta<T, M extends object = PageMeta> {
  constructor(
    readonly data: T,
    readonly meta: M,
  ) {}
}

// docs/04-API-CONTRACT.md: `?page=1&limit=20` (limit <= 100) => `meta: { page, limit, total }`.
export interface PageMeta {
  readonly page: number;
  readonly limit: number;
  readonly total: number;
}

export function paginated<T>(items: readonly T[], meta: PageMeta): WithMeta<readonly T[]> {
  return new WithMeta(items, meta);
}
