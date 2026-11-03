import { Inject, Injectable, Logger } from '@nestjs/common';
import type { CostSnapshot, FxRate } from '@repo/db';
import {
  COST_CURRENCIES,
  COST_FX_PAIR,
  COST_MAX_AGE_MS,
  FX_MAX_AGE_MS,
  MoneyError,
  costForQuantity,
  maxCostFor,
  priceFromCost,
  unitDisplayPrice,
  type CostCurrency,
} from '@repo/shared';
import { AppError } from '../../common/exceptions/app-error';
import { APP_CONFIG, type AppConfig } from '../../config/config.module';
import type {
  DisplayProduct,
  PriceRequest,
  PriceResult,
  PricingSku,
  ProductDisplayPrices,
} from './price-book.types';
import { SIMULATOR_SOURCE, isDerivedSource, isFresh, parseDerivedParents } from './price-sources';
import { PricingRepository, costSnapshotKey } from './pricing.repository';

type Checked<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };

function costCurrencyOf(snapshot: CostSnapshot): CostCurrency | null {
  return COST_CURRENCIES.find((currency) => currency === snapshot.currency) ?? null;
}

function scopeOf(snapshot: CostSnapshot): 'sku' | 'product' {
  return snapshot.skuId === null ? 'product' : 'sku';
}

// The single place that turns stored FX rates and supplier costs into a customer price. It is
// read-only (the worker writes the inputs) and fails closed: anything missing, stale or
// simulated in production is PRICE_UNAVAILABLE, never a guess.
@Injectable()
export class PriceBookService {
  private readonly logger = new Logger(PriceBookService.name);
  private readonly production: boolean;
  private readonly toleranceBps: number;

  constructor(
    private readonly repository: PricingRepository,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.production = config.NODE_ENV === 'production';
    this.toleranceBps = config.PRICE_TOLERANCE_BPS;
  }

  /** The price and the cost ceiling of one order, or `PRICE_UNAVAILABLE`. */
  async price(request: PriceRequest): Promise<PriceResult> {
    const { product, pricingSku, sku, quantity, now } = request;
    const unavailable = (reason: string): AppError => {
      this.logger.warn(`price unavailable for product ${product.id}: ${reason}`);
      return new AppError('PRICE_UNAVAILABLE');
    };

    const snapshot = await this.snapshotFor(product.id, sku?.id ?? null);
    if (snapshot === null) throw unavailable('no cost snapshot');
    const checkedSnapshot = this.checkSnapshot(snapshot, now);
    if (!checkedSnapshot.ok) throw unavailable(checkedSnapshot.reason);
    const currency = checkedSnapshot.value;
    const fx = await this.usableFx(COST_FX_PAIR[currency], now);
    if (!fx.ok) throw unavailable(fx.reason);

    try {
      const costMinor = costForQuantity({
        snapshotCostMinor: snapshot.costMinor,
        basisQuantity: snapshot.basisQuantity,
        quantity,
        scope: scopeOf(snapshot),
      });
      const { priceTiyin } = priceFromCost({
        costMinor,
        costCurrency: currency,
        rate: fx.value.rate,
        markupBps: pricingSku.markupBps,
        minMarginTiyin: pricingSku.minMarginTiyin,
      });
      const maxCostMinor = maxCostFor({
        costMinor,
        costCurrency: currency,
        rate: fx.value.rate,
        priceTiyin,
        discountTiyin: request.discountTiyin ?? 0n,
        minMarginTiyin: pricingSku.minMarginTiyin,
        toleranceBps: this.toleranceBps,
      });
      return {
        costCurrency: currency,
        costMinor,
        costSnapshotId: snapshot.id,
        fxRateId: fx.value.id,
        priceTiyin,
        maxCostMinor,
      };
    } catch (error) {
      // Inconsistent data (a pack snapshot for another quantity, a price that cannot cover its
      // own cost) must never become a quote.
      if (error instanceof MoneyError) throw unavailable(error.message);
      throw error;
    }
  }

  /**
   * Display prices for the catalog, in as few queries as possible. A pack without a fresh,
   * allowed cost or FX rate is simply absent (the client shows no price), never an error.
   */
  async displayPrices(
    products: readonly DisplayProduct[],
    now: Date,
  ): Promise<ReadonlyMap<string, ProductDisplayPrices>> {
    const result = new Map<string, ProductDisplayPrices>();
    if (products.length === 0) return result;
    const since = new Date(now.getTime() - COST_MAX_AGE_MS);
    const snapshots = await this.repository.latestCostSnapshotsSince(
      products.map((product) => product.id),
      since,
    );
    const fxByCurrency = new Map<CostCurrency, FxRate | null>();
    const fxFor = async (currency: CostCurrency): Promise<FxRate | null> => {
      if (!fxByCurrency.has(currency)) {
        const checked = await this.usableFx(COST_FX_PAIR[currency], now);
        fxByCurrency.set(currency, checked.ok ? checked.value : null);
      }
      return fxByCurrency.get(currency) ?? null;
    };

    for (const product of products) {
      const prices = new Map<string, bigint>();
      for (const sku of product.skus) {
        const snapshot =
          snapshots.get(costSnapshotKey(product.id, sku.id)) ??
          snapshots.get(costSnapshotKey(product.id, null));
        if (snapshot === undefined) continue;
        const checked = this.checkSnapshot(snapshot, now);
        if (!checked.ok) continue;
        const fx = await fxFor(checked.value);
        if (fx === null) continue;
        const priced = this.displayPrice(snapshot, checked.value, fx, sku);
        if (priced !== null) prices.set(sku.id, priced);
      }
      result.set(product.id, this.summarise(product.skus, prices));
    }
    return result;
  }

  private displayPrice(
    snapshot: CostSnapshot,
    currency: CostCurrency,
    fx: FxRate,
    sku: PricingSku,
  ): bigint | null {
    try {
      const costMinor = costForQuantity({
        snapshotCostMinor: snapshot.costMinor,
        basisQuantity: snapshot.basisQuantity,
        quantity: sku.quantity,
        scope: scopeOf(snapshot),
      });
      return priceFromCost({
        costMinor,
        costCurrency: currency,
        rate: fx.rate,
        markupBps: sku.markupBps,
        minMarginTiyin: sku.minMarginTiyin,
      }).priceTiyin;
    } catch (error) {
      if (error instanceof MoneyError) return null;
      throw error;
    }
  }

  private summarise(
    skus: readonly PricingSku[],
    prices: ReadonlyMap<string, bigint>,
  ): ProductDisplayPrices {
    let cheapest: bigint | null = null;
    for (const price of prices.values()) {
      if (cheapest === null || price < cheapest) cheapest = price;
    }
    let smallest: PricingSku | null = null;
    for (const sku of skus) {
      if (smallest === null || sku.quantity < smallest.quantity) smallest = sku;
    }
    const smallestPrice = smallest === null ? undefined : prices.get(smallest.id);
    return {
      fromPriceTiyin: cheapest,
      unitPriceTiyin:
        smallest === null || smallestPrice === undefined
          ? null
          : unitDisplayPrice(smallestPrice, smallest.quantity),
      skuPriceTiyin: prices,
    };
  }

  // A pack-level snapshot (Premium) wins; otherwise the product-level one (Stars) is scaled.
  private async snapshotFor(productId: string, skuId: string | null): Promise<CostSnapshot | null> {
    if (skuId !== null) {
      const own = await this.repository.latestCostSnapshot(productId, skuId);
      if (own !== null) return own;
    }
    return this.repository.latestCostSnapshot(productId, null);
  }

  private checkSnapshot(snapshot: CostSnapshot, now: Date): Checked<CostCurrency> {
    const currency = costCurrencyOf(snapshot);
    if (currency === null) return { ok: false, reason: 'cost snapshot has an unknown currency' };
    if (!isFresh(snapshot.createdAt, now, COST_MAX_AGE_MS)) {
      return { ok: false, reason: 'cost snapshot is stale' };
    }
    if (this.production && snapshot.source === SIMULATOR_SOURCE) {
      return { ok: false, reason: 'simulated cost snapshot refused in production' };
    }
    return { ok: true, value: currency };
  }

  private async usableFx(pair: string, now: Date): Promise<Checked<FxRate>> {
    const fx = await this.repository.latestFxRate(pair);
    if (fx === null) return { ok: false, reason: `no ${pair} rate` };
    if (!isFresh(fx.createdAt, now, FX_MAX_AGE_MS)) {
      return { ok: false, reason: `${pair} rate is stale` };
    }
    if (this.production && (await this.isSimulated(fx))) {
      return { ok: false, reason: `simulated ${pair} rate refused in production` };
    }
    return { ok: true, value: fx };
  }

  /**
   * True when a rate is, or was built from, simulator data. A derived rate (TON_UZS) carries
   * its parents' ids in `source`, so we look the parents up and judge THEM: matching the
   * derived row's own source alone would let a simulated TON_USDT through. Fails closed: a
   * derived source we cannot parse, a missing parent or a parent that is itself derived
   * counts as simulated, because we cannot prove it is not.
   */
  private async isSimulated(fx: FxRate): Promise<boolean> {
    if (fx.source === SIMULATOR_SOURCE) return true;
    if (!isDerivedSource(fx.source)) return false;
    const parentIds = parseDerivedParents(fx.source);
    if (parentIds === null) return true;
    const parents = await this.repository.fxRatesByIds(parentIds);
    if (parents.length !== new Set(parentIds).size) return true;
    return parents.some(
      (parent) => parent.source === SIMULATOR_SOURCE || isDerivedSource(parent.source),
    );
  }
}
