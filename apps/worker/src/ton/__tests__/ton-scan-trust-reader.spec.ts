import { ADVISORY_LOOKS_BEFORE_RESCAN } from '../ton-scan-trust';
import { NO_PROGRESS, type ScanProgress } from '../ton-tx-scan';
import { T0, hash, trustSetup } from './ton-scan-trust.fixtures';

// Audit L-1 through TonChainReader: a cursor kept in the database (advisory) that the chain
// contradicts never keeps a transfer BROADCAST: a `covered` above the chain is forgotten at once,
// a pass the listing does not continue (STALE) or answers with an error (audit R-1: toncenter's
// ASSUMED answer to an unknown cursor, TAXMIN until the S12 fixture) after a few looks. Forgetting
// it equals a restart without a cursor (S5). ton-scan-trust-floor.spec.ts shows that this
// process's own progress and the witnesses' are never dropped.

const LIMIT = ADVISORY_LOOKS_BEFORE_RESCAN;

async function landedWithSpam() {
  const s = trustSetup();
  s.node.setChainTime(T0);
  await s.send();
  s.node.receiveSpam(s.wallet.address, 300);
  const fresh = await s.node.getAccountState(s.wallet.address);
  if (fresh.lastTx === null) throw new Error('no transactions');
  const bogusPass: ScanProgress = {
    covered: null,
    pass: {
      anchor: { state: fresh, atMs: null },
      next: { lt: fresh.lastTx.lt - 1n, hash: hash('ee') },
    },
  };
  return { ...s, bogusPass };
}

describe('TonChainReader: a database cursor never keeps a transfer BROADCAST (L-1)', () => {
  it('covering a transaction above the chain: the first look rescans and confirms', async () => {
    const { reader, transfer, lookAt } = await landedWithSpam();
    reader.resumeScan(transfer.id, { covered: { lt: 10n ** 18n, hash: hash('cd') }, pass: null });
    expect(await lookAt(T0 + 1)).toBe('CONFIRMED');
  });

  it(`a pass whose next does not exist, listed past (STALE): forgotten after ${String(LIMIT)} looks`, async () => {
    const { reader, transfer, lookAt, bogusPass, progress } = await landedWithSpam();
    reader.resumeScan(transfer.id, bogusPass);
    const seen: string[] = [];
    for (let i = 0; i < LIMIT; i += 1) seen.push(await lookAt(T0 + 1));
    expect(seen).toEqual(Array<string>(LIMIT).fill('WAIT:INDEX_STALE'));
    expect(progress()).toEqual(NO_PROGRESS);
    expect(await lookAt(T0 + 1)).toBe('CONFIRMED');
  });

  it(`the same pass answered with an error (R-1, ASSUMED toncenter): forgotten after ${String(LIMIT)} looks`, async () => {
    const { node, reader, transfer, lookAt, bogusPass, progress } = await landedWithSpam();
    node.unknownCursor = 'ERROR';
    reader.resumeScan(transfer.id, bogusPass);
    const seen: string[] = [];
    for (let i = 0; i < LIMIT; i += 1) seen.push(await lookAt(T0 + 1));
    expect(seen).toEqual(Array<string>(LIMIT).fill('WAIT:GATEWAY'));
    expect(progress()).toEqual(NO_PROGRESS);
    expect(await lookAt(T0 + 1)).toBe('CONFIRMED');
  });

  it('a general outage (the account state fails too) counts for nothing', async () => {
    const { node, reader, transfer, lookAt, bogusPass, progress } = await landedWithSpam();
    node.unknownCursor = 'ERROR';
    reader.resumeScan(transfer.id, bogusPass);
    node.failNext('getAccountState', LIMIT * 3, 'HTTP');
    for (let i = 0; i < LIMIT * 3; i += 1) expect(await lookAt(T0 + 1)).toMatch(/^WAIT:/);
    expect(progress()).toEqual(bogusPass);
  });
});
