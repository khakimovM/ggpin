import { Inject, Injectable } from '@nestjs/common';
import { COST_CURRENCIES, type CostCurrency } from '@repo/shared';
import { parseProviderRef } from '../../adapters/provider-ref';
import { WORKER_CONFIG, type WorkerConfig } from '../../config/config.module';
import { AdapterRouter } from '../../fulfillment/adapter-router';
import { TON_HOT_WALLET_ADDRESS, type TonHotWalletAddress } from '../../ton/ton-tokens';
import type { ReleaseEvidence } from './held-release-policy';
import { HeldSourcesRepository, type HeldOrder } from './held-sources.repository';

// The evidence a release decision rests on (phase 5 S9e, Q-3, Q-8), gathered from the database
// and the worker's config only. The route is the run's own choice: `AdapterRouter.pick` with the
// previous attempt's adapter, the handle's issuer and the order's cost currency, exactly as
// fulfill-fresh.ts asks (enabled routes in the database, each adapter's cached health: nothing is
// prepared or validated, no provider is asked for a price or a recipient). The numbers come from
// the newest fresh cost snapshot of that adapter, the hot wallet's newest fresh balance reading,
// the rolling 24 h sum and the configured limits.
// CR F9: `pick` calls `health()` (cached HEALTH_CACHE_MS, bounded by HEALTH_TIMEOUT_MS); there is no
// route-only path, and keeping the run's exact choice is the point. Today that is a Redis read
// (FragmentHealth) or the simulator. Phase 6 plan: a supplier adapter's `health()` must not call
// the provider per lookup (cache it, or read a keep-alive's verdict as Fragment does). The static
// spec bans `.fulfill(`, `.prepare(` and `validateRecipient` anywhere in the reconciler.

function currencyOf(text: string): CostCurrency | null {
  return COST_CURRENCIES.find((known) => known === text) ?? null;
}

@Injectable()
export class HeldEvidence {
  constructor(
    private readonly sources: HeldSourcesRepository,
    private readonly router: AdapterRouter,
    @Inject(WORKER_CONFIG) private readonly config: WorkerConfig,
    @Inject(TON_HOT_WALLET_ADDRESS) private readonly wallet: TonHotWalletAddress,
  ) {}

  /** Null when the order's cost currency is not one we know (never released). */
  async of(order: HeldOrder, nowMs: number): Promise<ReleaseEvidence | null> {
    const currency = currencyOf(order.costCurrency);
    if (currency === null) return null;
    const issuer = parseProviderRef(order.providerRef ?? '')?.adapter ?? null;
    const picked = await this.router.pick(
      order.productId,
      order.lastAttempt?.adapter ?? null,
      issuer,
      currency,
    );
    const route = {
      picked: picked?.code ?? null,
      issuer,
      orderAgeMs: nowMs - order.createdAt.getTime(),
    };
    const attemptCost = order.lastAttempt?.costMinor ?? null;
    const knownCostMinor =
      attemptCost !== null && attemptCost > order.costMinor ? attemptCost : order.costMinor;
    const evidence = {
      route,
      currency,
      maxCostMinor: order.maxCostMinor,
      freshCostMinor:
        picked === null ? null : await this.sources.freshCost(order, picked.code, nowMs),
      knownCostMinor,
      supplierMaxPerOrderMicroUsdt: this.config.SUPPLIER_MAX_PER_ORDER_MICRO_USDT,
    };
    if (currency !== 'TON' || picked === null) return { ...evidence, ton: null };
    const scope = { network: this.wallet.network, rawAddress: this.wallet.rawAddress };
    const [spentLast24hNano, balanceNano] = await Promise.all([
      this.sources.spentLast24h(scope),
      this.sources.freshBalance(scope, nowMs),
    ]);
    return {
      ...evidence,
      ton: {
        limits: {
          perOrderMaxNano: this.config.TON_MAX_PER_ORDER_NANO,
          dailyMaxNano: this.config.TON_MAX_DAILY_NANO,
        },
        spentLast24hNano,
        balanceNano,
        feeReserveNano: this.config.TON_FEE_RESERVE_NANO,
      },
    };
  }
}
