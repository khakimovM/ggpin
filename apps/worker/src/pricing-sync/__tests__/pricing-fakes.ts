import type { FxPair } from '@repo/shared';
import { buildTestEnv } from '../../config/__tests__/test-env';
import type { WorkerConfig } from '../../config/config.module';
import type { FxSource } from '../fx-sources/fx-source';
import type {
  CostCandidate,
  CostSnapshotStore,
  FxRateStore,
  NewCostSnapshot,
  NewFxRate,
  StoredFxRate,
} from '../pricing-sync.repository';

export const dryRunConfig = (dryRun: boolean): WorkerConfig =>
  buildTestEnv({ FULFILLMENT_DRY_RUN: String(dryRun) });

/** In-memory FxRate table: ids are sequential, writes commit only when the callback resolves. */
export class FakeFxStore implements FxRateStore {
  readonly rows: (NewFxRate & StoredFxRate)[] = [];
  private nextId = 1;

  seed(pair: FxPair, rate: string): void {
    this.rows.push({ id: `seed-${pair}`, pair, rate, source: 'seed', createdAt: new Date(0) });
  }

  latestFxRate(pair: FxPair): Promise<StoredFxRate | null> {
    const rows = this.rows.filter((row) => row.pair === pair);
    return Promise.resolve(rows.at(-1) ?? null);
  }

  async writeFxRates<T>(
    write: (insert: (row: NewFxRate) => Promise<StoredFxRate>) => Promise<T>,
  ): Promise<T> {
    const pending: (NewFxRate & StoredFxRate)[] = [];
    const result = await write((row) => {
      const stored = { ...row, id: `fx-${this.nextId++}`, createdAt: new Date() };
      pending.push(stored);
      return Promise.resolve(stored);
    });
    this.rows.push(...pending); // like a transaction: nothing lands if `write` throws
    return result;
  }

  written(source?: string): (NewFxRate & StoredFxRate)[] {
    return this.rows.filter(
      (row) => row.source !== 'seed' && (source === undefined || row.source === source),
    );
  }
}

export class FakeFxSource implements FxSource {
  readonly name = 'simulator';
  fetchCalls = 0;

  constructor(
    private readonly quotes: readonly unknown[],
    readonly simulated = true,
  ) {}

  fetchRates(): Promise<readonly unknown[]> {
    this.fetchCalls += 1;
    return Promise.resolve(this.quotes);
  }
}

export class FakeCostStore implements CostSnapshotStore {
  readonly inserted: NewCostSnapshot[] = [];
  listCalls = 0;

  constructor(private readonly candidates: readonly CostCandidate[]) {}

  listCostCandidates(): Promise<CostCandidate[]> {
    this.listCalls += 1;
    return Promise.resolve([...this.candidates]);
  }

  insertCostSnapshots(rows: readonly NewCostSnapshot[]): Promise<number> {
    this.inserted.push(...rows);
    return Promise.resolve(rows.length);
  }
}

export function candidate(
  overrides: Partial<CostCandidate> & { productId: string },
): CostCandidate {
  return {
    isActive: true,
    allowCustomQty: false,
    routes: [{ adapter: 'FRAGMENT', isEnabled: true }],
    skus: [],
    ...overrides,
  };
}
