import type { TgOutboxJob } from '@repo/shared';
import { buildTestEnv } from '../../../config/__tests__/test-env';
import type { NotifySourcesRepository } from '../notify-sources.repository';
import { OrderNotifyRenderer } from '../order-notify.renderer';

// Synthetic order rows for the order-message and fulfillment-alert specs: no real user, product,
// recipient or amount. Shaped like NotifySourcesRepository.order().
export const MINI_APP = 'https://app.ggpin.test/tg';

type OrderRow = NonNullable<Awaited<ReturnType<NotifySourcesRepository['order']>>>;

export function orderRow(over: Partial<OrderRow> = {}): OrderRow {
  return {
    id: 'cmorder1',
    number: 1042,
    status: 'PAID',
    statusReason: null,
    deliveredAt: null,
    quantity: 500,
    recipient: { username: 'test_user', displayName: 'Test User' },
    product: { nameUz: 'Telegram Stars', nameRu: 'Telegram Stars' },
    sku: null,
    user: { telegramId: 777000111n, locale: 'uz', botBlockedAt: null },
    ...over,
  };
}

export interface FakeSources {
  order?: () => Promise<OrderRow | null>;
  orderRefund?: () => Promise<{ amountTiyin: bigint } | null>;
  tonTransfer?: () => Promise<unknown>;
  walletSnapshot?: () => Promise<unknown>;
}

export function fakeSources(fake: FakeSources): NotifySourcesRepository {
  return {
    order: () => Promise.resolve(null),
    orderRefund: () => Promise.resolve(null),
    tonTransfer: () => Promise.resolve(null),
    walletSnapshot: () => Promise.resolve(null),
    ...fake,
  } as unknown as NotifySourcesRepository;
}

export function orderRenderer(
  fake: FakeSources,
  miniAppUrl: string | null = MINI_APP,
): OrderNotifyRenderer {
  const config = buildTestEnv(miniAppUrl === null ? {} : { MINI_APP_URL: miniAppUrl });
  return new OrderNotifyRenderer(fakeSources(fake), config);
}

/** NFKC folds formatMoney's no-break spaces, so snapshots do not depend on Intl spacing. */
export const norm = (job: TgOutboxJob): TgOutboxJob => ({
  ...job,
  text: job.text.normalize('NFKC'),
});
