import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { scrubSecretsInText } from '@repo/shared';
import { WORKER_CONFIG, type WorkerConfig } from '../config/config.module';
import {
  COST_SOURCES,
  type CostLine,
  type CostProduct,
  type CostSource,
} from './cost-sources/cost-source';
import {
  PricingSyncRepository,
  type CostCandidate,
  type CostSnapshotStore,
  type NewCostSnapshot,
} from './pricing-sync.repository';
import { storedSourceLabel } from './source-label';

/** A source cleared to write this run, with the label its rows carry. */
interface UsableSource {
  readonly source: CostSource;
  readonly label: string;
}

export interface CostSyncResult {
  readonly products: number;
  readonly snapshots: number;
}

const COST_CURRENCIES: ReadonlySet<string> = new Set(['TON', 'USDT']);

/**
 * Which adapters are healthy now: the AdapterRouter's cached health (HEALTH_CACHE_MS), the same
 * answer an order or a recipient check would get. Not bound -> no adapter is known healthy.
 */
export interface RouteHealth {
  isHealthy(adapter: string): Promise<boolean>;
}

export const ROUTE_HEALTH = Symbol('ROUTE_HEALTH');

/**
 * Mirrors the CostSnapshot CHECKs and adds what the database cannot know: a SKU row must be for
 * one of this product's active SKUs with that SKU's quantity as the basis, and a product-level
 * row exists only for custom-quantity products. Returns the reason, or null when valid.
 */
function lineProblem(product: CostProduct, line: CostLine): string | null {
  if (line.costMinor <= 0n) return 'cost must be positive';
  if (!COST_CURRENCIES.has(line.currency)) return 'unknown currency';
  if (!Number.isSafeInteger(line.basisQuantity) || line.basisQuantity <= 0) {
    return 'basis quantity must be a positive integer';
  }
  if (line.skuId === null) {
    return product.allowCustomQty ? null : 'product-level row for a fixed-pack product';
  }
  // A custom-quantity product is priced from ONE product-level unit cost. A pack row would price
  // a typed pack size at the pack's cost while one unit more uses the unit cost, so buying more
  // could cost less; refused here so such a row never reaches the API.
  if (product.allowCustomQty) return 'pack-level row for a custom-quantity product';
  const sku = product.skus.find((s) => s.id === line.skuId);
  if (sku === undefined) return 'SKU is not an active SKU of the product';
  if (sku.quantity !== line.basisQuantity) return 'basis quantity differs from the SKU quantity';
  return null;
}

/**
 * One cost sync run (docs/06 "Narx sinxronlash"): for every ACTIVE product, store what the adapter
 * that would serve it now charges, as immutable CostSnapshot rows. That adapter is the product's
 * first enabled route whose adapter is HEALTHY (S7 review M2): while the Fragment session is DEAD
 * a Stars product is priced by its backup (RESELLER_STARS, USDT), so new quotes and orders are in
 * the backup's currency and the router can fulfil them (it offers an order only to adapters of
 * its cost currency, M1). No healthy route -> the first enabled route, as before S7; that is
 * always the case in production until the real adapters exist (no registry, no backup, Q20), so
 * nothing changes there. A product whose chosen adapter has no cost source gets no row (its
 * quotes stop after COST_MAX_AGE_MS: fail closed, never priced by an adapter that cannot serve).
 *
 * Health can flap (a keep-alive blip, a provider timeout), and with it the currency of new
 * quotes from one run to the next. Accepted: each quote keeps the snapshot it was priced from,
 * an order is only ever offered to its own currency, and the router's health cache smooths
 * single blips. Orders priced in TON before a death are HELD (NO_ADAPTER) until Fragment is back
 * and the S9 reconciler releases them (docs/06).
 */
@Injectable()
export class CostSyncService {
  private readonly logger = new Logger(CostSyncService.name);

  constructor(
    @Inject(WORKER_CONFIG) private readonly config: WorkerConfig,
    @Inject(COST_SOURCES) private readonly sources: readonly CostSource[],
    @Inject(PricingSyncRepository) private readonly repository: CostSnapshotStore,
    @Optional() @Inject(ROUTE_HEALTH) private readonly health: RouteHealth | null = null,
  ) {}

  async run(): Promise<CostSyncResult> {
    const usable = this.usableSources();
    if (usable.length === 0) return { products: 0, snapshots: 0 };

    const rows: NewCostSnapshot[] = [];
    let products = 0;
    for (const candidate of await this.repository.listCostCandidates()) {
      if (!candidate.isActive) continue;
      const adapter = await this.servingAdapter(candidate);
      const match = usable.find((u) => u.source.adapter === adapter);
      if (match === undefined) continue;
      const { source, label } = match;
      const product: CostProduct = {
        productId: candidate.productId,
        allowCustomQty: candidate.allowCustomQty,
        skus: candidate.skus
          .filter((sku) => sku.isActive)
          .map(({ id, quantity }) => ({ id, quantity })),
      };
      const lines = await this.costsOf(source, product);
      const valid = lines.filter((line) => this.isValidLine(product, line));
      if (valid.length > 0) products += 1;
      for (const line of valid) {
        rows.push({
          productId: product.productId,
          adapter: source.adapter,
          source: label,
          ...line,
        });
      }
    }

    const snapshots = await this.repository.insertCostSnapshots(rows);
    this.logger.log(`cost sync: wrote ${snapshots} snapshot(s) for ${products} product(s)`);
    return { products, snapshots };
  }

  /** The first enabled route whose adapter is healthy, else the first enabled route (see above). */
  private async servingAdapter(candidate: CostCandidate): Promise<string | null> {
    const enabled = candidate.routes.filter((route) => route.isEnabled).map((r) => r.adapter);
    if (this.health !== null) {
      for (const adapter of enabled) {
        if (await this.healthyNow(this.health, adapter)) return adapter;
      }
    }
    return enabled[0] ?? null;
  }

  private async healthyNow(health: RouteHealth, adapter: string): Promise<boolean> {
    try {
      return await health.isHealthy(adapter);
    } catch {
      return false;
    }
  }

  /**
   * Fails closed, like the FX sync: fake prices only in dry-run, and a real source may not carry
   * a name the API reads as simulated/derived. A refused source leaves its products without fresh
   * snapshots, so quotes for them stop after COST_MAX_AGE_MS. One error line per run.
   */
  private usableSources(): UsableSource[] {
    const usable: UsableSource[] = [];
    const refused: string[] = [];
    for (const source of this.sources) {
      if (source.simulated && !this.config.FULFILLMENT_DRY_RUN) {
        refused.push(
          `${source.adapter} (simulated, no real cost source and FULFILLMENT_DRY_RUN=false)`,
        );
        continue;
      }
      const label = storedSourceLabel(source);
      if (label === null) {
        refused.push(
          `${source.adapter} (real source with reserved name ${JSON.stringify(source.name)})`,
        );
        continue;
      }
      usable.push({ source, label });
    }
    if (refused.length > 0) {
      this.logger.error(
        `cost sync: refused cost source(s) ${refused.join(', ')}; nothing written for those products`,
      );
    }
    return usable;
  }

  // One product's failure must not stop the others; a real source's error text may carry a URL
  // or key, so it is scrubbed before logging.
  private async costsOf(source: CostSource, product: CostProduct): Promise<readonly CostLine[]> {
    try {
      return await source.costs(product);
    } catch (error) {
      const reason =
        error instanceof Error ? scrubSecretsInText(error.message) : 'non-Error thrown';
      this.logger.warn(
        `cost sync: ${source.adapter} failed for product ${product.productId}: ${reason}`,
      );
      return [];
    }
  }

  private isValidLine(product: CostProduct, line: CostLine): boolean {
    const problem = lineProblem(product, line);
    if (problem === null) return true;
    this.logger.warn(`cost sync: dropped a line for product ${product.productId}: ${problem}`);
    return false;
  }
}
