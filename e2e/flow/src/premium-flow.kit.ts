import { randomBytes } from 'node:crypto';
import {
  CreateOrderResponseSchema,
  OrderDetailSchema,
  QuoteResponseSchema,
  ValidateRecipientResponseSchema,
  type Locale,
} from '@repo/shared';
import type { FakeSender } from '../../../apps/api/src/modules/notifications/__tests__/tg-outbox.e2e-helpers';
import {
  newKey,
  type PaymentsE2e,
} from '../../../apps/api/src/modules/payments/__tests__/payments-e2e.helpers';
import { flat } from '../../../apps/api/src/modules/payments/__tests__/topup-flow.helpers';
import { chatGateKey } from '../../../apps/api/src/modules/notifications/tg-outbox.consumer';
import { fund, type PremiumFlowCatalog } from './premium-flow.fixtures';

// The API steps of the Premium order flow spec (phase 6 S6), each through the real HTTP routes
// with the buyer's Mini App bearer token, plus the reads the spec asserts on.

export interface Buyer {
  readonly id: string;
  readonly bearer: Record<string, string>;
  readonly chatId: string;
}

export interface KitDeps {
  readonly e2e: PaymentsE2e;
  readonly sender: FakeSender;
  /** flowKit's deliver: the notify job through the API's notify and tg-outbox consumers. */
  readonly deliver: (jobId: string) => Promise<unknown>;
  readonly catalog: () => PremiumFlowCatalog;
  /** Filled for the spec's cleanup. */
  readonly userIds: string[];
  readonly orderIds: Set<string>;
}

export function premiumFlowKit(deps: KitDeps) {
  const { e2e, sender, deliver, catalog, userIds, orderIds } = deps;
  const sfx = randomBytes(4).toString('hex');
  let seq = 0;

  async function buyer(locale: Locale, fundTiyin: bigint): Promise<Buyer> {
    const user = await e2e.newUser({ locale });
    userIds.push(user.id);
    if (fundTiyin > 0n) await fund(e2e.db(), (key) => e2e.redis().del(key), user.id, fundTiyin);
    const row = await e2e.db().user.findUniqueOrThrow({ where: { id: user.id } });
    return { ...user, chatId: row.telegramId.toString() };
  }

  /** A username unique to this run with a simulator prefix. */
  const username = (prefix: string): string => `${prefix}${sfx}_${String(++seq)}`;

  const validate = (user: Buyer, name: string) =>
    e2e.send('POST', '/recipients/validate', user.bearer, {
      productId: catalog().productId,
      input: { username: name },
    });

  const order = (user: Buyer, quoteId: string, key: string = newKey()) =>
    e2e.send('POST', '/orders', { ...user.bearer, 'idempotency-key': key }, { quoteId });

  /** validate (200), then `quote()` quotes the 3-month SKU with that token (201). */
  async function quoteFor(user: Buyer, name: string) {
    const checked = await validate(user, name);
    expect(checked.status).toBe(200);
    const recipient = ValidateRecipientResponseSchema.parse(checked.body.data);
    const quote = async () => {
      const res = await e2e.send('POST', '/quotes', user.bearer, {
        productId: catalog().productId,
        skuId: catalog().sku3,
        recipientToken: recipient.recipientToken,
      });
      expect(res.status).toBe(201);
      return QuoteResponseSchema.parse(res.body.data);
    };
    return { recipient, quote };
  }

  async function placed(user: Buyer, quoteId: string, key?: string) {
    const res = await order(user, quoteId, key);
    expect(res.status).toBe(201);
    const created = CreateOrderResponseSchema.parse(res.body.data).order;
    orderIds.add(created.id);
    return created;
  }

  async function detail(user: Buyer, orderId: string, locale: Locale = 'uz') {
    const res = await e2e.get(`/orders/${orderId}?locale=${locale}`, user);
    expect(res.status).toBe(200);
    return OrderDetailSchema.parse(res.body.data);
  }

  async function ledgerOf(userId: string) {
    const rows = await e2e.db().ledgerEntry.findMany({
      where: { userId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map((e) => [e.kind, e.amountTiyin, e.refType] as const);
  }

  /** The amounts (nanotons) of the TON transfers made for an order's attempts. */
  async function transfersOf(orderId: string): Promise<bigint[]> {
    const rows = await e2e.db().tonTransfer.findMany({
      where: { attempt: { orderId } },
      select: { amountNanoTon: true },
    });
    return rows.map((r) => r.amountNanoTon);
  }

  /** The notify job through the API's consumers; the text the fake Telegram got for it. */
  async function botText(
    user: Buyer,
    kind: 'accepted' | 'delivered' | 'refunded',
    orderId: string,
  ): Promise<string> {
    // One message per chat per second (the consumer's chat gap): the next one waits its turn,
    // as the BullMQ worker's delayed retry would, so this message is sent on its first run. The
    // wait follows the gate's own TTL in Redis (PTTL), not the host clock: the VM clock of the
    // test Redis steps back by seconds now and then; 15 rounds bound it.
    for (let round = 0; ; round += 1) {
      const ttlMs = await e2e.redis().pttl(chatGateKey(user.chatId));
      if (ttlMs === -2) break; // no gate: free to send
      if (ttlMs === -1 || round >= 15) throw new Error('the chat gap did not pass');
      await new Promise((resolve) => setTimeout(resolve, Math.min(ttlMs, 1_000) + 20));
    }
    const before = sender.deliveriesTo(user.chatId).length;
    await deliver(`order-${orderId}-${kind}`);
    const sent = sender.deliveriesTo(user.chatId);
    expect(sent).toHaveLength(before + 1);
    return flat(sent.at(-1)?.job.text ?? '');
  }

  return {
    buyer,
    username,
    validate,
    order,
    quoteFor,
    placed,
    detail,
    ledgerOf,
    transfersOf,
    botText,
  };
}
