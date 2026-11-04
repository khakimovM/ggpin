import { Inject, Injectable, Logger } from '@nestjs/common';
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

/** The adapter that serves a product: its enabled route with the lowest priority, if any. */
function firstEnabledAdapter(candidate: CostCandidate): string | null {
  return candidate.routes.find((route) => route.isEnabled)?.adapter ?? null;
}

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
  const sku = product.skus.find((s) => s.id === line.skuId);
  if (sku === undefined) return 'SKU is not an active SKU of the product';
  if (sku.quantity !== line.basisQuantity) return 'basis quantity differs from the SKU quantity';
  return null;
}

/**
 * One cost sync run (docs/06 "Narx sinxronlash"): for every ACTIVE product whose first enabled
 * route has a cost source, store what that adapter charges now as immutable CostSnapshot rows.
 * Phase 3 registers only the Fragment simulator, so only FRAGMENT-first products get rows.
 */
@Injectable()
export class CostSyncService {
  private readonly logger = new Logger(CostSyncService.name);

  constructor(
    @Inject(WORKER_CONFIG) private readonly config: WorkerConfig,
    @Inject(COST_SOURCES) private readonly sources: readonly CostSource[],
    @Inject(PricingSyncRepository) private readonly repository: CostSnapshotStore,
  ) {}

  async run(): Promise<CostSyncResult> {
    const usable = this.usableSources();
    if (usable.length === 0) return { products: 0, snapshots: 0 };

    const rows: NewCostSnapshot[] = [];
    let products = 0;
    for (const candidate of await this.repository.listCostCandidates()) {
      if (!candidate.isActive) continue;
      const adapter = firstEnabledAdapter(candidate);
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
