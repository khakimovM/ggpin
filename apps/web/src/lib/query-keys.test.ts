import { describe, expect, it } from 'vitest';
import { qk } from './query-keys';

describe('query keys', () => {
  it('are plain, stable arrays', () => {
    expect(qk.me()).toEqual(['me']);
    expect(qk.sessions()).toEqual(['sessions']);
    expect(qk.wallet.balance()).toEqual(['wallet', 'balance']);
    expect(qk.orders.detail('o1', 'uz')).toEqual(['orders', 'detail', 'o1', 'uz']);
    expect(qk.catalog.product('telegram-stars', 'ru')).toEqual([
      'catalog',
      'product',
      'telegram-stars',
      'ru',
    ]);
    expect(qk.referrals()).toEqual(['referrals']);
  });

  it('put every feature key under its root so one invalidation covers the feature', () => {
    const roots: [readonly string[], readonly (readonly unknown[])[]][] = [
      [
        qk.wallet.all,
        [
          qk.wallet.balance(),
          qk.wallet.ledger({ page: 2 }),
          qk.wallet.ledgerInfinite({ limit: 20 }),
        ],
      ],
      [
        qk.orders.all,
        [qk.orders.list({ limit: 5 }), qk.orders.infinite({ limit: 20 }), qk.orders.detail('o1')],
      ],
      [
        qk.payments.all,
        [
          qk.payments.methods(),
          qk.payments.intents({}),
          qk.payments.intent('i1'),
          qk.payments.display('i1'),
        ],
      ],
      [
        qk.catalog.all,
        [
          qk.catalog.categories('uz'),
          qk.catalog.products({ locale: 'uz' }),
          qk.catalog.product('a', 'uz'),
        ],
      ],
    ];
    for (const [root, keys] of roots) {
      for (const key of keys) expect(key.slice(0, root.length)).toEqual(root);
    }
  });

  it('separates filters so different pages never share a cache entry', () => {
    expect(qk.wallet.ledger({ page: 1 })).not.toEqual(qk.wallet.ledger({ page: 2 }));
    expect(qk.orders.list({ status: ['PAID'] })).not.toEqual(
      qk.orders.list({ status: ['FAILED'] }),
    );
  });

  it('the pay page key carries the intent id only, never the capability token', () => {
    expect(qk.payments.display('intent_1')).toEqual(['payments', 'display', 'intent_1']);
  });
});
