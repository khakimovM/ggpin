import type { FxPair } from '@repo/shared';
import { buildTestEnv } from '../../config/__tests__/test-env';
import { tonLiveSource } from '../../config/__tests__/ton-live-env';
import type { WorkerConfig } from '../../config/config.module';
import type { FxSource } from '../fx-sources/fx-source';
import {
  latestAnchorCreatedAt,
  type CostCandidate,
  type CostSnapshotStore,
  type FxRateStore,
  type NewCostSnapshot,
  type NewFxRate,
  type StoredFxRate,
} from '../pricing-sync.repository';

// A live config needs the TON settings DRY_RUN=false requires (plan §5); they are per-run fakes.
export const dryRunConfig = (dryRun: boolean): WorkerConfig =>
  buildTestEnv(
    dryRun ? { FULFILLMENT_DRY_RUN: 'true' } : { ...tonLiveSource(), FULFILLMENT_DRY_RUN: 'false' },
  );

/** In-memory FxRate table: ids are sequential, writes commit only when the callback resolves. */
export class FakeFxStore implements FxRateStore {
  readonly rows: (NewFxRate & StoredFxRate)[] = [];
  private nextId = 1;

  /** The `now` of every latestFxRate call, to prove the service passes its clock through. */
  readonly latestCalls: { pair: FxPair; now: Date }[] = [];

  seed(pair: FxPair, rate: string, createdAt = new Date(0), id = `seed-${pair}`): void {
    this.rows.push({ id, pair, rate, source: 'seed', createdAt });
  }

  // Same contract as the repository: the newest row not stamped past latestAnchorCreatedAt(now).
  // The real query is proven on Postgres in price-sync.e2e-spec.ts.
  latestFxRate(pair: FxPair, now: Date): Promise<StoredFxRate | null> {
    this.latestCalls.push({ pair, now });
    const bound = latestAnchorCreatedAt(now).getTime();
    const rows = this.rows
      .filter((row) => row.pair === pair && row.createdAt.getTime() <= bound)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
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

/**
 * Named 'fake-fx' by default, NOT 'simulator': a simulated source's rows must be labelled
 * 'simulator' because of its flag, whatever its name.
 */
export class FakeFxSource implements FxSource {
  fetchCalls = 0;

  constructor(
    private readonly quotes: readonly unknown[],
    readonly simulated = true,
    readonly name = 'fake-fx',
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
