import type { AdminKeyedWritePermission } from '@repo/shared';

/**
 * `AuditLog.targetType` of a tombstone: the type the voided action's own audit row names, so the
 * audit log's target filter finds the tombstone beside the action it stopped (docs/04 «Kalitni
 * bekor qilish»). Same strings as the writers: users and wallet `User`, P2P `PaymentReview` /
 * `Payment` / `TopupCard`, catalog (admin-catalog-write.service.ts), admins (admin-users
 * repository), orders `Order` and FX `FxRate` (phase 5 writers). `QueueJob`: no writer yet.
 */
export const VOID_TARGET_TYPES: Readonly<Record<AdminKeyedWritePermission, string>> = Object.freeze(
  {
    'orders.note': 'Order',
    'orders.retry': 'Order',
    'orders.cancel': 'Order',
    'orders.failAndRefund': 'Order',
    'orders.resolve': 'Order',
    'orders.refund': 'Order',
    'users.note': 'User',
    'users.block': 'User',
    'users.unblock': 'User',
    'users.freeze': 'User',
    'users.unfreeze': 'User',
    'users.sessionsRevoke': 'User',
    'users.adjustWallet': 'User',
    'payments.reviewCredit': 'PaymentReview',
    'payments.reverse': 'Payment',
    'cards.pause': 'TopupCard',
    'cards.resume': 'TopupCard',
    'cards.limit': 'TopupCard',
    'cards.retire': 'TopupCard',
    'catalog.categoryUpdate': 'Category',
    'catalog.productUpdate': 'Product',
    'catalog.productReorder': 'Catalog',
    'catalog.skuCreate': 'Product',
    'catalog.skuUpdate': 'Sku',
    'catalog.routeUpdate': 'ProductRoute',
    'fx.set': 'FxRate',
    'admins.create': 'AdminUser',
    'admins.update': 'AdminUser',
    'admins.sessionsRevoke': 'AdminUser',
    'sessions.revoke': 'AdminSession',
    'queues.retry': 'QueueJob',
  },
);
