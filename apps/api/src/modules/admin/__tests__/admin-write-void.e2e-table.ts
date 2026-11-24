import type { AdminKeyedWritePermission } from '@repo/shared';

// 9-B SA-1: one row per keyed admin write the API serves (a static test, admin-write-void-routes
// .spec.ts, keeps it equal to the served handlers). Each row is a request that passes the body
// schema; after the key is voided it must answer 409 and write nothing, so a code (`otp`) is
// never checked and a fake one is enough.

export interface VoidTargets {
  readonly userId: string;
  readonly paymentId: string;
  readonly reviewId: string;
  readonly cardId: string;
  readonly categoryId: string;
  readonly productId: string;
  readonly skuId: string;
  readonly routeId: string;
  readonly adminId: string;
  readonly sessionId: string;
}

type Target = keyof VoidTargets | 'products';

export interface VoidCase {
  readonly method: 'POST' | 'PATCH';
  /** The matrix route below `/admin/`, `:id` standing for `target`. */
  readonly route: string;
  readonly target: Target;
  readonly body: (t: VoidTargets) => object;
}

const REASON = 'checked by the void table';
const OTP = { challengeId: 'c'.repeat(32), code: '123456' };
const post = (route: string, target: Target, body: (t: VoidTargets) => object): VoidCase => ({
  method: 'POST',
  route,
  target,
  body,
});
const patch = (route: string, target: Target, body: (t: VoidTargets) => object): VoidCase => ({
  method: 'PATCH',
  route,
  target,
  body,
});
const reason = () => ({ reason: REASON });

export const VOID_ROUTE_CASES: Readonly<Partial<Record<AdminKeyedWritePermission, VoidCase>>> = {
  'users.note': post('users/:id/notes', 'userId', () => ({ text: 'void table note' })),
  'users.block': post('users/:id/block', 'userId', reason),
  'users.unblock': post('users/:id/unblock', 'userId', reason),
  'users.freeze': post('users/:id/freeze', 'userId', reason),
  'users.unfreeze': post('users/:id/unfreeze', 'userId', reason),
  'users.sessionsRevoke': post('users/:id/sessions/revoke', 'userId', reason),
  'users.adjustWallet': post('users/:id/adjust-wallet', 'userId', () => ({
    amountTiyin: '-100',
    reason: REASON,
  })),
  'payments.reviewCredit': post('payments/reviews/:id/credit', 'reviewId', (t) => ({
    userId: t.userId,
    reason: REASON,
    otp: OTP,
  })),
  'payments.reverse': post('payments/:id/reverse', 'paymentId', reason),
  'cards.pause': post('payments/cards/:id/pause', 'cardId', reason),
  'cards.resume': post('payments/cards/:id/resume', 'cardId', reason),
  'cards.limit': post('payments/cards/:id/limit', 'cardId', () => ({
    receiveLimitTiyin: '100000',
    reason: REASON,
  })),
  'cards.retire': post('payments/cards/:id/retire', 'cardId', () => ({
    reason: REASON,
    emergency: true,
    otp: OTP,
  })),
  'catalog.categoryUpdate': patch('categories/:id', 'categoryId', () => ({ sort: 7 })),
  'catalog.productUpdate': patch('products/:id', 'productId', () => ({ isActive: true })),
  'catalog.productReorder': post('products/reorder', 'products', (t) => ({
    productIds: [t.productId],
  })),
  'catalog.skuCreate': post('products/:id/skus', 'productId', () => ({
    labelUz: '75 ta',
    labelRu: '75 шт',
    quantity: 75,
    markupBps: 1200,
    minMarginTiyin: '0',
    isActive: true,
    sort: 3,
  })),
  'catalog.skuUpdate': patch('skus/:id', 'skuId', () => ({ isActive: false })),
  'catalog.routeUpdate': patch('routes/:id', 'routeId', () => ({ isEnabled: false })),
  'admins.create': post('admins', 'adminId', () => ({
    telegramId: '700000999',
    name: 'Void table',
    role: 'SUPPORT',
    reason: REASON,
    otp: OTP,
  })),
  'admins.update': patch('admins/:id', 'adminId', () => ({
    isActive: false,
    reason: REASON,
    otp: OTP,
  })),
  'admins.sessionsRevoke': post('admins/:id/sessions/revoke', 'adminId', () => ({
    reason: REASON,
    otp: OTP,
  })),
  'sessions.revoke': post('sessions/:id/revoke', 'sessionId', () => ({ reason: REASON, otp: OTP })),
};

/** The id a row's request names (the reorder's is the catalog's fixed `products`). */
export function targetOf(row: VoidCase, t: VoidTargets): string {
  return row.target === 'products' ? 'products' : t[row.target];
}

export function pathOf(row: VoidCase, t: VoidTargets): string {
  return row.route.replace(':id', targetOf(row, t));
}
