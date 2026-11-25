import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  DEFAULT_LOCALE,
  purchaseShortfall,
  storedRecipientView,
  totalAfterDiscount,
  type CreateOrderBody,
  type CreateOrderResponse,
  type OrderDetail,
  type OrderDetailQuery,
  type OrderDto,
  type OrderListQuery,
} from '@repo/shared';
import { CLOCK, type Clock } from '../../common/clock/clock';
import { AppError } from '../../common/exceptions/app-error';
import { paginated, type WithMeta } from '../../common/http/with-meta';
import { FixedWindowCounter } from '../../infra/redis/fixed-window-counter';
import { isUniqueViolation } from '../payments/db-errors';
import { toOrderDetail, toOrderDto } from './entities/order.mapper';
import { OrderEffects } from './order-effects';
import { replayOf } from './order-replay';
import { orderRequestHash } from './order-request-hash';
import {
  OrdersRepository,
  type OrderView,
  type PurchaseGate,
  type QuoteForOrder,
} from './orders.repository';

/** Purchases per user per window (rules/10 "order create 10/min/user", docs/04 429 row). */
export const ORDER_CREATE_LIMIT = { max: 10, windowSec: 60 } as const;

export const orderCreateLimitKey = (userId: string): string => `rl:order:${userId}`;

// No discount before phase 10: a quote stores no discount amount (only discountCodeId), so the
// order's discount is 0, and the database refuses anything else for a quote without a code.
const NO_DISCOUNT_TIYIN = 0n;

// The unique indexes of Order a lost race would hit (Prisma names them <Model>_<columns>_key).
const ORDER_UNIQUE_INDEXES = ['Order_userId_idempotencyKey_key', 'Order_quoteId_key'] as const;

/** `usedAt` was already set when the purchase wrote it (0 rows): the purchase rolled back. */
class QuoteUseLostError extends Error {
  constructor() {
    super('the quote was marked used by another write during the purchase');
    this.name = 'QuoteUseLostError';
  }
}

/**
 * Orders of the session user (docs/04 "Buyurtmalar", plan 6.1, D-49).
 *
 * The purchase is ONE transaction under the user's wallet row lock (`SELECT ... FOR UPDATE` on
 * Wallet, rules/20; not Serializable), so every purchase of a user, and the D-41 freeze written
 * under the same lock, runs one at a time: lock -> replay by (user, key) -> own quote (404) ->
 * blocked / frozen (403) -> used (409 + orderId) -> expired, or a Telegram quote without its
 * providerRef (410) -> balance (422, nothing written) -> Order(PAID) + OrderEvent +
 * LedgerEntry(PURCHASE) of what the stored order costs + quote usedAt. The replay comes before
 * every quote check (D-49): a retry whose answer was lost gets its order back even after the quote
 * expired, and a twin request under the same key finds the first one's order once it holds the
 * lock (201, never 404/410/422). After commit: OrderEffects (cache, fulfill-order, notice).
 */
@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly repository: OrdersRepository,
    private readonly effects: OrderEffects,
    private readonly counter: FixedWindowCounter,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async create(
    userId: string,
    idempotencyKey: string,
    body: CreateOrderBody,
  ): Promise<CreateOrderResponse> {
    await this.enforceLimit(userId);
    const requestHash = orderRequestHash(body);
    const order = await this.purchaseOrRecover(userId, idempotencyKey, requestHash, body.quoteId);
    // A replay of an order that already moved on (QUEUED, DELIVERED, ...) re-runs nothing.
    if (order.status === 'PAID') await this.effects.afterPurchase(userId, order.id);
    // docs/04 gives POST no `locale` (only the GETs take it): the name is in the default language.
    return { order: toOrderDto(order, DEFAULT_LOCALE) };
  }

  async list(userId: string, query: OrderListQuery): Promise<WithMeta<readonly OrderDto[]>> {
    const { rows, total } = await this.repository.listOwn(userId, query);
    return paginated(
      rows.map((row) => toOrderDto(row, query.locale)),
      { page: query.page, limit: query.limit, total },
    );
  }

  /** The user's own order; another user's is 404 like a missing one (rules/60). */
  async get(userId: string, orderId: string, query: OrderDetailQuery): Promise<OrderDetail> {
    const row = await this.repository.findOwnDetail(userId, orderId);
    if (row === null) throw new AppError('NOT_FOUND');
    return toOrderDetail(row, query.locale);
  }

  private async purchaseOrRecover(
    userId: string,
    idempotencyKey: string,
    requestHash: string,
    quoteId: string,
  ): Promise<OrderView> {
    try {
      return await this.purchase(userId, idempotencyKey, requestHash, quoteId);
    } catch (error) {
      const lostRace =
        error instanceof QuoteUseLostError ||
        ORDER_UNIQUE_INDEXES.some((index) => isUniqueViolation(error, index));
      if (!lostRace) throw error;
      // Unreachable while every purchase takes the wallet lock first (two writers of one key or
      // one quote queue on it); the backstop of plan 6.1 step 4. The transaction is gone, so the
      // winner is read without it, in the D-49 order: the replay first, then "already used".
      const replayed = replayOf(
        await this.repository.findByKey(userId, idempotencyKey),
        requestHash,
      );
      if (replayed !== null) return replayed;
      const orderId = await this.repository.findOwnOrderIdByQuote(userId, quoteId);
      if (orderId !== null) throw new AppError('QUOTE_ALREADY_USED', { orderId });
      throw error;
    }
  }

  private purchase(
    userId: string,
    idempotencyKey: string,
    requestHash: string,
    quoteId: string,
  ): Promise<OrderView> {
    return this.repository.transaction(async (tx) => {
      await this.repository.lockWallet(tx, userId);
      // Read after the lock: a request that waited for a twin decides with the current time.
      const now = this.clock.now();
      const stored = await this.repository.findByKey(userId, idempotencyKey, tx);
      const replayed = replayOf(stored, requestHash);
      if (replayed !== null) return replayed;

      const quote = await this.repository.findOwnQuote(tx, userId, quoteId);
      if (quote === null) throw new AppError('NOT_FOUND');
      this.assertMayPurchase(userId, await this.repository.purchaseGate(tx, userId));
      this.assertUnused(userId, quote);
      if (quote.expiresAt.getTime() <= now.getTime()) throw new AppError('QUOTE_EXPIRED');
      this.assertRecipientCheckable(quote);
      this.assertNoDiscountCode(quote);

      const total = totalAfterDiscount(quote.priceTiyin, NO_DISCOUNT_TIYIN);
      const balance = await this.repository.balance(tx, userId);
      if (balance < total) {
        throw new AppError('INSUFFICIENT_BALANCE', {
          balance,
          required: total,
          shortfall: purchaseShortfall(balance, total),
        });
      }

      const order = await this.repository.createPaid(tx, {
        userId,
        quote,
        discountTiyin: NO_DISCOUNT_TIYIN,
        idempotencyKey,
        requestHash,
      });
      // The debit is what the stored order costs (review N3); the database checks the pair at
      // commit (migration p5_order_purchase_ledger_check).
      const debit = totalAfterDiscount(order.priceTiyin, order.discountTiyin);
      if (debit !== total) {
        // The balance was checked against `total`; a stored order that costs anything else is a
        // broken copy of its quote (review N3). Throwing here rolls the order back: nothing written.
        this.logger.error(`order ${order.id} costs other than its quote: purchase refused`);
        throw new AppError('INTERNAL_ERROR');
      }
      await this.repository.appendPurchase(tx, userId, order.id, debit);
      // In the same transaction as the order (R4-3): a quote is never used without its order.
      const marked = await this.repository.markQuoteUsed(tx, userId, quote.id, now);
      if (!marked) throw new QuoteUseLostError();
      return order;
    });
  }

  // A blocked or frozen account buys nothing (docs/04 403s). Read under the lock, so a block or a
  // freeze written while this purchase waited for it counts (audit L1). The wallet row is locked,
  // so a missing user is a broken database, not a customer state: refused, nothing written.
  private assertMayPurchase(userId: string, gate: PurchaseGate | null): void {
    if (gate === null) {
      // The internal user id (a cuid, review N4) is what an operator needs to find the row.
      this.logger.error(`user ${userId} has a wallet but no user row: purchase refused`);
      throw new AppError('INTERNAL_ERROR');
    }
    if (gate.isBlocked) throw new AppError('USER_BLOCKED');
    if (gate.purchaseFrozen) throw new AppError('PURCHASE_FROZEN');
  }

  // Fulfillment re-checks a Telegram recipient by its provider handle before paying (CLAUDE.md
  // invariant 8). A quote without one (older than S2, or written by hand) cannot be re-checked, so
  // it is refused like an expired one and the client asks for a new quote (audit L2). A handle of
  // spaces is no handle (re-audit N2), and a recipient without a readable username has nothing to
  // re-check it against (review M3). The log names the quote only: nothing of the recipient.
  private assertRecipientCheckable(quote: QuoteForOrder): void {
    if (quote.product.deliveryType !== 'TG_USERNAME') return;
    const hasRef = (quote.providerRef ?? '').trim() !== '';
    const hasUsername = storedRecipientView(quote.recipient)?.fields['username'] !== undefined;
    if (hasRef && hasUsername) return;
    const missing = hasRef ? 'username' : 'providerRef';
    this.logger.warn(
      `quote ${quote.id} of a Telegram product has no ${missing}: refused as expired`,
    );
    throw new AppError('QUOTE_EXPIRED');
  }

  // A quote becomes one order. Its owner's existing order is named (docs/04 Q-D), so a client
  // that lost the answer of another key opens that order instead of paying again.
  private assertUnused(userId: string, quote: QuoteForOrder): void {
    if (quote.order !== null && quote.order.userId === userId) {
      throw new AppError('QUOTE_ALREADY_USED', { orderId: quote.order.id });
    }
    if (quote.order !== null || quote.usedAt !== null) {
      // Used without an order of its owner: the INSERT guard and this transaction make that
      // impossible, and no contract answer would be true (409 needs the order's id).
      this.logger.error(`quote ${quote.id} is marked used but has no order of its owner`);
      throw new AppError('INTERNAL_ERROR');
    }
  }

  // Phase 10 binds a code's amount to the order (R4-4). Until then no quote is created with a
  // code (POST /quotes refuses every code), so one here is a broken internal invariant, not a
  // customer error: nothing is written and no contract code fits, hence 500. It comes after the
  // 410 on purpose: a client that retries the same key gets QUOTE_EXPIRED once the quote expires,
  // which settles its doubt, and no 422 is ever computed without the code's amount.
  private assertNoDiscountCode(quote: QuoteForOrder): void {
    if (quote.discountCodeId === null) return;
    this.logger.error(
      `quote ${quote.id} carries a discount code: no order from it before phase 10`,
    );
    throw new AppError('INTERNAL_ERROR');
  }

  private async enforceLimit(userId: string): Promise<void> {
    const hit = await this.counter.hit(orderCreateLimitKey(userId), ORDER_CREATE_LIMIT.windowSec);
    if (hit.count > ORDER_CREATE_LIMIT.max) {
      throw new AppError('RATE_LIMITED', undefined, { retryAfterSec: hit.ttlSec });
    }
  }
}
