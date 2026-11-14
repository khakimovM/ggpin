import { Inject, Injectable, Logger } from '@nestjs/common';
import { describeErrorForLog } from '@repo/shared';
import type { FulfillmentAdapter } from '../adapters/fulfillment-adapter';
import { PrismaService } from '../infra/prisma/prisma.service';
import { FULFILL_ADAPTERS, type AdapterRegistry } from './fulfill-tokens';

// Which adapter fulfils an order (plan 6.6 step 5, docs/06 "Adapter interfeysi"). The product ->
// adapter mapping is data: enabled ProductRoute rows by priority. An order that already had an
// attempt keeps that attempt's adapter (a new attempt is made only after the previous one was
// PROVEN not sent): it never wanders to another provider mid-way. An unresolved attempt is never
// routed at all; the core only follows it (rules/45 step 2).

@Injectable()
export class AdapterRouter {
  private readonly logger = new Logger(AdapterRouter.name);

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
  ): Promise<FulfillmentAdapter | null> {
    const routes = await this.prisma.client.productRoute.findMany({
      where: { productId, isEnabled: true },
      orderBy: [{ priority: 'asc' }, { adapter: 'asc' }],
      select: { adapter: true },
    });
    const codes = routes
      .map((r) => r.adapter)
      .filter((code) => previousAdapter === null || code === previousAdapter);
    for (const code of codes) {
      const adapter = this.registry.get(code);
      if (adapter !== undefined && (await this.healthy(adapter))) return adapter;
    }
    return null;
  }

  private async healthy(adapter: FulfillmentAdapter): Promise<boolean> {
    try {
      return (await adapter.health()) === 'OK';
    } catch (error) {
      this.logger.warn(`adapter ${adapter.code} health unknown: ${describeErrorForLog(error)}`);
      return false;
    }
  }
}
