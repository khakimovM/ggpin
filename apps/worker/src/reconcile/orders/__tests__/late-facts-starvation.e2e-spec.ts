import { parseMajor } from '@repo/shared';
import { payRequest, rowsOf, tonFactOf } from '../../../ton/__tests__/ton-e2e.fixtures';
import { WALLET_BALANCE } from '../../../ton/__tests__/ton-e2e.harness';
import { TON_HOT_WALLET_ADDRESS, type TonHotWalletAddress } from '../../../ton/ton-tokens';
import { LateFactsRepository } from '../late-facts.repository';
import { useReconcileE2e, type Reconciler } from './reconcile-e2e.harness';

// S9i gate D2 on the real database: the ONCHAIN_FAILED candidates (SIGNED / BROADCAST transfers of
// NEEDS_REVIEW orders, the SUSPECT filter read from the JSON response after the page is taken) are
// a keyset walk like the other lists of the late step. The unique index
// "TonTransfer_wallet_unresolved_key" (network, walletAddress WHERE SIGNED/BROADCAST) keeps at
// most ONE such transfer per wallet, so the starvation the gate described (25 old rows hiding
// newer ones) cannot happen today; the cursor keeps the list right if that index ever changes.
// What is proven here: a page that names its end is followed by an EMPTY page from that cursor
// (the keyset condition is applied in the query), and a null cursor starts again (the wrap).

const r = useReconcileE2e();
const { t } = r;

/** The wallet skipped the payout (balance gone after signing): SUSPECT NO_OUT_MESSAGE, review. */
async function suspectTransfer(rec: Reconciler): Promise<string> {
  rec.hooks.afterStoredFn = () => {
    t.gateway.setBalance(t.wallet.address, parseMajor('TON', '0.01'));
    return Promise.resolve();
  };
  const fixture = await r.order();
  const result = await rec.sender.pay(payRequest(fixture));
  rec.hooks.afterStoredFn = () => Promise.resolve();
  t.gateway.setBalance(t.wallet.address, WALLET_BALANCE);
  expect(result).toMatchObject({ status: 'REVIEW', transferStatus: 'BROADCAST' });
  const rows = await rowsOf(t.db, fixture);
  expect(rows.order.status).toBe('NEEDS_REVIEW');
  expect(tonFactOf(rows.attempt.response, 'suspect')).toMatchObject({ detail: 'NO_OUT_MESSAGE' });
  return rows.transfer?.id ?? '';
}

describe('late step: the ONCHAIN_FAILED candidates are a keyset walk (S9i gate D2)', () => {
  it('a page of one row names its end; from there the page is empty; null starts again', async () => {
    const rec = await r.boot();
    const transferId = await suspectTransfer(rec);
    const repository = rec.moduleRef.get(LateFactsRepository);
    const wallet = rec.moduleRef.get<symbol, TonHotWalletAddress>(TON_HOT_WALLET_ADDRESS);
    const scope = { network: wallet.network, rawAddress: wallet.rawAddress };
    const first = await repository.failedSuspectPage(scope, null, 1);
    expect(first.items.map((item) => item.transferId)).toEqual([transferId]);
    expect(first.next?.id).toBe(transferId);
    // Mutant D2-repo-no-cursor: the same row again, for ever (the old page-from-the-start query).
    expect(await repository.failedSuspectPage(scope, first.next, 1)).toEqual({
      items: [],
      next: null,
    });
    const wrapped = await repository.failedSuspectPage(scope, null, 1);
    expect(wrapped.items.map((item) => item.transferId)).toEqual([transferId]);
  });
});
