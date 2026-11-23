// The one registry of TanStack Query keys of the admin panel. Every feature reads its keys from
// here, so an invalidation after an action can name exactly what it refreshes.
type Params = Readonly<Record<string, string | number | undefined>>;

export const qk = {
  auth: {
    all: () => ['auth'] as const,
    me: () => ['auth', 'me'] as const,
    loginStatus: (attempt: number) => ['auth', 'login-status', attempt] as const,
  },
  dashboard: {
    all: () => ['dashboard'] as const,
    summary: (period: string) => ['dashboard', period] as const,
  },
  orders: {
    all: () => ['orders'] as const,
    list: (params: Params) => ['orders', 'list', params] as const,
    detail: (id: string) => ['orders', 'detail', id] as const,
    reviewQueue: (params: Params) => ['orders', 'review-queue', params] as const,
  },
  users: {
    all: () => ['users'] as const,
    list: (params: Params) => ['users', 'list', params] as const,
    detail: (id: string) => ['users', 'detail', id] as const,
    tab: (id: string, tab: string, params: Params) => ['users', 'tab', id, tab, params] as const,
    adjustPreview: (id: string, amountTiyin: string) =>
      ['users', 'adjust-preview', id, amountTiyin] as const,
  },
  payments: {
    all: () => ['payments'] as const,
    list: (kind: string, params: Params) => ['payments', kind, params] as const,
    cards: () => ['payments', 'cards'] as const,
    review: (id: string) => ['payments', 'review', id] as const,
    creditPreview: (id: string, target: string) =>
      ['payments', 'credit-preview', id, target] as const,
    bankMessage: (id: string) => ['payments', 'bank-message', id] as const,
    reconcile: (params: Params) => ['payments', 'reconcile', params] as const,
  },
  catalog: {
    all: () => ['catalog'] as const,
    categories: () => ['catalog', 'categories'] as const,
    products: () => ['catalog', 'products'] as const,
    product: (id: string) => ['catalog', 'product', id] as const,
    pricePreview: (id: string, skuId: string) => ['catalog', 'price-preview', id, skuId] as const,
  },
  settings: {
    all: () => ['settings'] as const,
    values: () => ['settings', 'values'] as const,
    fxHistory: (params: Params) => ['settings', 'fx-history', params] as const,
  },
  infra: {
    all: () => ['infra'] as const,
    queues: () => ['infra', 'queues'] as const,
    wallet: () => ['infra', 'wallet'] as const,
    fragment: () => ['infra', 'fragment'] as const,
  },
  audit: {
    all: () => ['audit'] as const,
    list: (params: Params) => ['audit', 'list', params] as const,
  },
  admins: {
    all: () => ['admins'] as const,
    list: () => ['admins', 'list'] as const,
    sessions: (id: string) => ['admins', 'sessions', id] as const,
  },
} as const;

/**
 * What an applied (or found) admin write makes stale, by the action's area: its own records, the
 * lists that show them, and the audit log that now has its row. Never the session.
 */
export function invalidationsFor(kind: string): readonly (readonly unknown[])[] {
  const area = kind.slice(0, kind.indexOf('.'));
  const touched: Record<string, readonly (readonly unknown[])[]> = {
    users: [qk.users.all(), qk.dashboard.all()],
    payments: [qk.payments.all(), qk.users.all(), qk.dashboard.all()],
    cards: [qk.payments.all()],
    orders: [qk.orders.all(), qk.users.all(), qk.dashboard.all()],
    catalog: [qk.catalog.all()],
    fx: [qk.settings.all()],
    admins: [qk.admins.all()],
    sessions: [qk.admins.all()],
    queues: [qk.infra.all()],
  };
  return [...(touched[area] ?? []), qk.audit.all()];
}

/** Everything except the session itself: what a sign-out must drop from the cache. */
export function isPrivateQuery(queryKey: readonly unknown[]): boolean {
  return queryKey[0] !== 'auth';
}
