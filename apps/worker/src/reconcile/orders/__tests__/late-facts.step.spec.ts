import type { TonLateService } from '../../../ton/ton-late.service';
import type { TonHotWalletAddress } from '../../../ton/ton-tokens';
import type { LateCursor, LateFactsRepository, LateItem, LatePage } from '../late-facts.repository';
import { LateFactsStep } from '../late-facts.step';
import type { ReconcileNotifier } from '../reconcile-notifier';
import type { ReconcileOrderLock } from '../reconcile-order-lock';

// S9i gate D2: the step carries the ONCHAIN_FAILED walk's cursor from tick to tick (the page the
// repository returns names where the next one starts; null wraps to the oldest). The page query
// itself (the keyset condition) is proven on the database (late-facts-starvation e2e).

const WALLET = { network: 'testnet', rawAddress: '0:abc' } as unknown as TonHotWalletAddress;
const EMPTY = { items: [], next: null };

function cursorAt(id: string): LateCursor {
  return { createdAt: new Date('2026-11-23T00:00:00.000Z'), id };
}

function setup(pages: readonly LatePage<LateItem>[]) {
  const asked: (LateCursor | null)[] = [];
  const repository = {
    failedSuspectPage: (_scope: unknown, cursor: LateCursor | null) => {
      asked.push(cursor);
      return Promise.resolve(pages[asked.length - 1] ?? EMPTY);
    },
    hintPage: () => Promise.resolve({ ...EMPTY, foreign: [], otherLate: [] }),
    notSentPage: () => Promise.resolve(EMPTY),
    confirmedPage: () => Promise.resolve(EMPTY),
  } as unknown as LateFactsRepository;
  const looked: string[] = [];
  const late = {
    onchainFailed: (transferId: string) => {
      looked.push(transferId);
      return Promise.resolve({ kind: 'NOTHING', why: 'NO_WITNESS' });
    },
  } as unknown as TonLateService;
  const lock = {
    run: async (_orderId: string, fn: () => Promise<unknown>) => ({
      busy: false,
      value: await fn(),
    }),
  } as unknown as ReconcileOrderLock;
  const notifier = { alert: () => Promise.resolve(true) } as unknown as ReconcileNotifier;
  const step = new LateFactsStep(repository, late, notifier, lock, WALLET);
  return { step, asked, looked };
}

describe('LateFactsStep: the ONCHAIN_FAILED walk (S9i gate D2)', () => {
  it('each tick starts where the last page ended, and wraps after the end', async () => {
    const { step, asked, looked } = setup([
      { items: [{ transferId: 'old', orderId: 'o1' }], next: cursorAt('old') },
      { items: [{ transferId: 'new', orderId: 'o2' }], next: null },
      { items: [{ transferId: 'old', orderId: 'o1' }], next: cursorAt('old') },
    ]);
    for (let tick = 0; tick < 3; tick += 1) await step.run({ nowMs: 1_000 });
    expect(asked).toEqual([null, cursorAt('old'), null]);
    expect(looked).toEqual(['old', 'new', 'old']);
  });
});
