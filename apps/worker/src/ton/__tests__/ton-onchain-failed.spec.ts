import { parseMajor } from '@repo/shared';
import { checkOnchainFailed, type OnchainFailedEvidence } from '../ton-onchain-failed';
import { txRef } from '../ton-tx-scan';
import { lateChain, type LateChain, type SentPayout } from './ton-late-chain.fixtures';

// ONCHAIN_FAILED (S9f, D-64 (7), R2a): only when the primary source AND every witness (at least
// one) list the very transaction the SUSPECT fact names, as our external message's transaction
// with zero outgoing messages. Anything else proves nothing.

let chain: LateChain;
let skipped: SentPayout;

function evidence(overrides: Partial<OnchainFailedEvidence> = {}): OnchainFailedEvidence {
  return {
    wallet: chain.wallet.address,
    extMsgHash: skipped.signed.extMsgHash,
    transfer: skipped.facts,
    recorded: txRef(skipped.tx),
    primary: skipped.tx,
    witnesses: [skipped.tx],
    ...overrides,
  };
}

const whyOf = (e: OnchainFailedEvidence): string => {
  const check = checkOnchainFailed(e);
  return check.kind === 'PROVEN' ? 'PROVEN' : check.why;
};

beforeEach(async () => {
  chain = lateChain();
  // The wallet cannot pay the value: the send is skipped (IGNORE_ERRORS), the fee is taken.
  chain.gateway.setBalance(chain.wallet.address, parseMajor('TON', '0.01'));
  skipped = await chain.pay();
});

describe('checkOnchainFailed', () => {
  it('proves it from the primary source and every witness, counting the sources', () => {
    expect(checkOnchainFailed(evidence({ witnesses: [skipped.tx, skipped.tx] }))).toMatchObject({
      kind: 'PROVEN',
      sources: 3,
      tx: { hash: txRef(skipped.tx).hash, outMessages: [], skippedActions: 1 },
    });
  });

  it('NO_WITNESS: the primary source alone proves nothing', () => {
    expect(whyOf(evidence({ witnesses: [] }))).toBe('NO_WITNESS');
  });

  it('NOT_FOUND: the primary source does not list it', () => {
    expect(whyOf(evidence({ primary: null }))).toBe('NOT_FOUND');
  });

  it('WITNESS_DISAGREES: any witness without the very transaction (mutant: witnesses not read)', async () => {
    chain.gateway.setBalance(chain.wallet.address, parseMajor('TON', '100'));
    const other = await chain.pay();
    expect(whyOf(evidence({ witnesses: [null] }))).toBe('WITNESS_DISAGREES');
    expect(whyOf(evidence({ witnesses: [skipped.tx, null] }))).toBe('WITNESS_DISAGREES');
    expect(whyOf(evidence({ witnesses: [other.tx] }))).toBe('WITNESS_DISAGREES');
  });

  it('NOT_OURS: the transaction of another external message', () => {
    expect(whyOf(evidence({ extMsgHash: '0'.repeat(64) }))).toBe('NOT_OURS');
  });

  it('HAS_OUT_MESSAGE: a transaction that paid out', async () => {
    chain.gateway.setBalance(chain.wallet.address, parseMajor('TON', '100'));
    const paid = await chain.pay();
    const e = evidence({
      extMsgHash: paid.signed.extMsgHash,
      transfer: paid.facts,
      recorded: txRef(paid.tx),
      primary: paid.tx,
      witnesses: [paid.tx],
    });
    expect(whyOf(e)).toBe('HAS_OUT_MESSAGE');
  });
});
