import type { CreateQuoteBody, Locale } from '@repo/shared';
import type { ProductListParams } from './api/catalog';
import type { LedgerFilters } from './api/me';
import type { OrderListParams } from './api/orders';
import type { IntentFilters } from './api/payments';

// The only place query keys are written. Every key starts with its feature root, so
// `invalidateQueries({ queryKey: qk.wallet.all })` refreshes everything wallet-related.
//
// Keys never hold session or pay-link tokens. The one exception is the quote key, see below.
export const qk = {
  me: () => ['me'] as const,
  sessions: () => ['sessions'] as const,

  // The status poll of one login attempt. The attempt number, not the nonce, goes into the key:
  // the nonce is a login capability and keys end up in devtools and error reports.
  auth: {
    loginStatus: (attempt: number) => ['auth', 'login-status', attempt] as const,
  },

  catalog: {
    all: ['catalog'] as const,
    categories: (locale: Locale) => ['catalog', 'categories', locale] as const,
    products: (params: ProductListParams) => ['catalog', 'products', params] as const,
    product: (slug: string, locale: Locale) => ['catalog', 'product', slug, locale] as const,
  },

  // The key holds `recipientToken` and `discountCode`. The cache lives in memory only: do not give
  // it to a persister (localStorage/IndexedDB) and do not ship it to devtools in production.
  quote: (input: CreateQuoteBody) => ['quote', input] as const,

  wallet: {
    all: ['wallet'] as const,
    balance: () => ['wallet', 'balance'] as const,
    ledger: (filters: LedgerFilters) => ['wallet', 'ledger', filters] as const,
  },

  orders: {
    all: ['orders'] as const,
    list: (filters: OrderListParams) => ['orders', 'list', filters] as const,
    detail: (id: string) => ['orders', 'detail', id] as const,
  },

  payments: {
    all: ['payments'] as const,
    methods: () => ['payments', 'methods'] as const,
    intents: (filters: IntentFilters) => ['payments', 'intents', filters] as const,
    intent: (id: string) => ['payments', 'intent', id] as const,
    // The pay page's own view (capability token); the token is NOT part of the key.
    display: (id: string) => ['payments', 'display', id] as const,
  },

  referrals: () => ['referrals'] as const,
} as const;
