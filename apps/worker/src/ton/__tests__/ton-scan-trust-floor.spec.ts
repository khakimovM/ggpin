import { PAST, T0, trustSetup } from './ton-scan-trust.fixtures';

// Review M1 + M2, audit H-1 (S9c fix rounds 2 and 3): this process's own scan progress and every
// witness's keep BOTH floors they checked themselves (the covered transaction and the anchor of
// the pass in flight) for ever, exactly as in S5 (05bff3b). A node frozen below our landed payout
// (at covered, between covered and the payout, or before the payout with nothing covered) then
// answers STALE or fails, and never completes a pass: no EXPIRY observation is ever offered while
// the payout is on the chain. The scenarios are the reviewers' probes. Their listings from an
// unknown cursor answer below it ('BELOW', the fake's default) or with an error ('ERROR':
// toncenter's ASSUMED answer, TAXMIN until the S12 testnet fixture).

/** Looks against a frozen node: far more than any trust limit. */
const FROZEN_LOOKS = 14;

describe('own progress: a node falling below covered never offers an EXPIRY (review M1)', () => {
  it('7 looks STALE, then the node catches up: CONFIRMED', async () => {
    const { node, wallet, snapshot, lookAt, looksFrom, send, progress } = trustSetup();
    node.setChainTime(T0 - 1_000);
    node.receiveSpam(wallet.address, 3);
    const before = await snapshot();
    node.setChainTime(T0 - 900);
    node.receiveSpam(wallet.address, 2);
    expect(await lookAt(T0 - 800)).toBe('WAIT:IN_FLIGHT');
    expect(progress()?.covered?.lt).toBeGreaterThan(before.state.lastTx?.lt ?? 0n);
    node.setChainTime(T0);
    await send();
    node.frozen = before;
    expect(await looksFrom(PAST, 7)).toEqual(Array<string>(7).fill('WAIT:INDEX_STALE'));
    node.frozen = null;
    expect(await lookAt(PAST + 400)).toBe('CONFIRMED');
  });
});

describe('own progress: the pass in flight is a floor too (review M2, audit H-1)', () => {
  type Freeze = 'AT_COVERED' | 'BETWEEN' | 'NOTHING_COVERED';
  const cases: [Freeze, 'BELOW' | 'ERROR'][] = [
    ['AT_COVERED', 'BELOW'],
    ['AT_COVERED', 'ERROR'],
    ['BETWEEN', 'BELOW'],
    ['BETWEEN', 'ERROR'],
    ['NOTHING_COVERED', 'BELOW'],
    ['NOTHING_COVERED', 'ERROR'],
  ];

  it.each(cases)(
    'frozen %s, unknown cursor %s: kept for ever, then CONFIRMED',
    async (at, mode) => {
      const { node, wallet, snapshot, lookAt, looksFrom, send, progress } = trustSetup();
      node.setChainTime(T0 - 900);
      node.receiveSpam(wallet.address, 2);
      if (at !== 'NOTHING_COVERED') expect(await lookAt(T0 - 800)).toBe('WAIT:IN_FLIGHT');
      if (at === 'BETWEEN') {
        node.setChainTime(T0 - 500);
        node.receiveSpam(wallet.address, 3);
      }
      const frozen = await snapshot();
      node.setChainTime(T0);
      await send();
      // More than one look's page budget above our payout: the pass stays in flight above it.
      node.receiveSpam(wallet.address, 900);
      expect(await lookAt(T0 + 1)).toBe('WAIT:INDEX_SCANNING');
      const kept = progress();
      expect(kept?.pass).not.toBeNull();
      node.frozen = frozen;
      node.unknownCursor = mode;
      const answer = mode === 'ERROR' ? 'WAIT:GATEWAY' : 'WAIT:INDEX_STALE';
      expect(await looksFrom(PAST, FROZEN_LOOKS)).toEqual(Array<string>(FROZEN_LOOKS).fill(answer));
      expect(progress()).toEqual(kept);
      node.frozen = null;
      expect(await lookAt(PAST + 600)).toBe('CONFIRMED');
    },
  );

  it('a lagging index (empty pages) keeps the pass for ever, then CONFIRMED', async () => {
    const { node, wallet, lookAt, send, progress } = trustSetup();
    node.setChainTime(T0);
    await send();
    node.receiveSpam(wallet.address, 900);
    expect(await lookAt(T0 + 1)).toBe('WAIT:INDEX_SCANNING');
    const kept = progress();
    node.emptyListings = FROZEN_LOOKS;
    for (let i = 0; i < FROZEN_LOOKS; i += 1) expect(await lookAt(T0 + 1)).toBe('WAIT:INDEX_STALE');
    expect(progress()).toEqual(kept);
    expect(await lookAt(T0 + 1)).toBe('CONFIRMED');
  });

  it('failed listings at its own pass keep the pass for ever, then CONFIRMED', async () => {
    const { node, wallet, lookAt, send, progress } = trustSetup();
    node.setChainTime(T0);
    await send();
    node.receiveSpam(wallet.address, 900);
    expect(await lookAt(T0 + 1)).toBe('WAIT:INDEX_SCANNING');
    const kept = progress();
    node.failNext('getTransactions', FROZEN_LOOKS, 'HTTP');
    for (let i = 0; i < FROZEN_LOOKS; i += 1) expect(await lookAt(T0 + 1)).toBe('WAIT:GATEWAY');
    expect(progress()).toEqual(kept);
    expect(await lookAt(T0 + 1)).toBe('CONFIRMED');
  });
});

describe('a witness keeps both its floors (review M1, M2)', () => {
  it('a witness falling below what it covered never agrees with "not sent"', async () => {
    const { node, wallet, witness, snapshot, lookAt, looksFrom, send } = trustSetup(true);
    node.setChainTime(T0 - 1_000);
    node.receiveSpam(wallet.address, 3);
    const old = await snapshot();
    node.setChainTime(T0 - 900);
    node.receiveSpam(wallet.address, 2);
    const mid = await snapshot();
    node.setChainTime(T0);
    await send();
    // The primary serves the oldest state from the start (it never sees our payout): only the
    // witness can contradict it. The witness first serves a newer state, then falls back.
    node.frozen = old;
    witness.frozen = mid;
    expect(await lookAt(PAST)).toBe('EXPIRY_SEEN');
    witness.frozen = old;
    const seen = await looksFrom(PAST + 40, FROZEN_LOOKS);
    expect(seen).toEqual(Array<string>(FROZEN_LOOKS).fill('WAIT:WITNESS_PENDING'));
    witness.frozen = null;
    expect(await lookAt(PAST + 800)).toBe('WITNESS_CONFLICT');
  });

  it.each(['BELOW', 'ERROR'] as const)(
    'a witness pass in flight, then frozen below our payout (%s): never agrees',
    async (mode) => {
      const { node, wallet, witness, snapshot, lookAt, looksFrom, send } = trustSetup(true);
      node.setChainTime(T0 - 900);
      node.receiveSpam(wallet.address, 2);
      const old = await snapshot();
      node.setChainTime(T0);
      await send();
      node.receiveSpam(wallet.address, 900);
      node.frozen = old;
      // The witness sees the real chain first: its pass stays in flight above our payout.
      expect(await lookAt(PAST)).toBe('WAIT:WITNESS_PENDING');
      witness.frozen = old;
      witness.unknownCursor = mode;
      const seen = await looksFrom(PAST + 40, FROZEN_LOOKS);
      expect(seen).toEqual(Array<string>(FROZEN_LOOKS).fill('WAIT:WITNESS_PENDING'));
      witness.frozen = null;
      expect(await lookAt(PAST + 800)).toBe('WITNESS_CONFLICT');
    },
  );
});
