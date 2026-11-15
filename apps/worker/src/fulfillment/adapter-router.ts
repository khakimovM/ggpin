import { Inject, Injectable, Logger } from '@nestjs/common';
import { describeErrorForLog, type CostCurrency } from '@repo/shared';
import type { FulfillmentAdapter } from '../adapters/fulfillment-adapter';
import { PrismaService } from '../infra/prisma/prisma.service';
import { FULFILL_ADAPTERS, type AdapterRegistry } from './fulfill-tokens';

// Which adapter fulfils an order or answers a recipient check (plan 6.6 step 5, docs/06 "Adapter
// interfeysi", S7). The product -> adapter mapping is data: enabled ProductRoute rows by priority,
// and only an adapter whose health is OK (a DEAD Fragment session makes FRAGMENT DOWN, S7).
//
// - An order that already had an attempt keeps that attempt's adapter (`previousAdapter`), even
//   when the attempt was PROVEN not sent (CR m6): it never wanders to another provider mid-way.
//   If that adapter is unhealthy, nothing is picked (the order is HELD, NO_ADAPTER). An
//   unresolved attempt is never routed at all; the core only follows it (rules/45 step 2).
// - `currency`: an order's cost currency. Only adapters that charge in it are candidates (S7
//   review M1), filtered BEFORE everything else: before the issuer preference and before any
//   provider is asked anything. A TON-priced order is never offered to a USDT reseller (it could
//   neither pay nor be compared with the stored ceiling), so with Fragment DOWN it is HELD
//   (NO_ADAPTER) without a re-check or a prepare, and refunded by nobody. Null (a recipient check,
//   which has no order yet): any currency.
// - `preferred`: the adapter that issued the order's recipient handle (CR #2): tried first among
//   the remaining candidates when healthy, so a handle is normally compared by its own issuer.
// - health() is cached per adapter for HEALTH_CACHE_MS (S3b gate I-1: not one provider/Redis call
//   per lookup) and bounded by HEALTH_TIMEOUT_MS; a throw or a timeout counts as unhealthy, and is
//   cached too. The keep-alive drops the cache of an adapter whose session changed state
//   (`forgetHealth`), so this process sees a death at once; other replicas within the TTL.

/** How long one health() answer is reused. */
export const HEALTH_CACHE_MS = 5_000;
/** A health() that has not answered by then is "not OK". */
export const HEALTH_TIMEOUT_MS = 2_000;

interface CachedHealth {
  readonly at: number;
  readonly healthy: Promise<boolean>;
}

@Injectable()
export class AdapterRouter {
  private readonly logger = new Logger(AdapterRouter.name);
  private readonly health = new Map<string, CachedHealth>();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(FULFILL_ADAPTERS) private readonly registry: AdapterRegistry,
  ) {}

  /** The registered adapter of a stored attempt, or null (not configured in this process). */
  adapterOf(code: string): FulfillmentAdapter | null {
    return this.registry.get(code) ?? null;
  }

  /** The adapter for the next attempt, or null: the order is then HELD (NO_ADAPTER). */
  async pick(
    productId: string,
    previousAdapter: string | null,
    preferred: string | null = null,
    currency: CostCurrency | null = null,
  ): Promise<FulfillmentAdapter | null> {
    const routes = await this.prisma.client.productRoute.findMany({
      where: { productId, isEnabled: true },
      orderBy: [{ priority: 'asc' }, { adapter: 'asc' }],
      select: { adapter: true },
    });
    let candidates = routes
      .map((r) => this.registry.get(r.adapter))
      .filter((adapter): adapter is FulfillmentAdapter => adapter !== undefined)
      .filter((adapter) => currency === null || adapter.costCurrency === currency)
      .filter((adapter) => previousAdapter === null || adapter.code === previousAdapter);
    const first = candidates.find((adapter) => adapter.code === preferred);
    if (previousAdapter === null && first !== undefined) {
      candidates = [first, ...candidates.filter((adapter) => adapter !== first)];
    }
    for (const adapter of candidates) {
      if (await this.healthy(adapter)) return adapter;
    }
    return null;
  }

  /**
   * Whether the adapter of `code` is registered here and healthy now (the same cached answer the
   * picks use). The cost sync prices a product from its first healthy route (S7 review M2).
   */
  async isHealthy(code: string): Promise<boolean> {
    const adapter = this.registry.get(code);
    return adapter !== undefined && (await this.healthy(adapter));
  }

  /** Drops the cached health of one adapter (its session just changed state). */
  forgetHealth(code: string): void {
    this.health.delete(code);
  }

  private healthy(adapter: FulfillmentAdapter): Promise<boolean> {
    const now = Date.now();
    const cached = this.health.get(adapter.code);
    if (cached !== undefined && now - cached.at < HEALTH_CACHE_MS && now >= cached.at) {
      return cached.healthy;
    }
    const healthy = this.ask(adapter);
    this.health.set(adapter.code, { at: now, healthy });
    return healthy;
  }

  private async ask(adapter: FulfillmentAdapter): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'TIMEOUT'>((resolve) => {
      timer = setTimeout(() => resolve('TIMEOUT'), HEALTH_TIMEOUT_MS);
      timer.unref();
    });
    try {
      const answer = await Promise.race([adapter.health(), timeout]);
      if (answer === 'TIMEOUT') this.logger.warn(`adapter ${adapter.code} health timed out`);
      return answer === 'OK';
    } catch (error) {
      this.logger.warn(`adapter ${adapter.code} health unknown: ${describeErrorForLog(error)}`);
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}
