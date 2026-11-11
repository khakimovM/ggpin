import { BankTextPurgeService } from '../bank-text-purge.service';
import { useMatcherE2e } from '../../bank-feed/__tests__/matcher-e2e.harness';
import {
  createCard,
  createIntent,
  createUser,
  insertMessage,
  uniqueAmount,
} from '../../bank-feed/__tests__/matcher-e2e.fixtures';
import { bootReconcileWorker, type ReconcileWorker } from './reconcile-e2e.harness';

// The daily raw-text purge (D-37 (10)) on the real ggpin_test DB. The purge is global by design
// (every row past its purgeAfter), so the assertions name this file's rows only. The trigger's
// own refusals (DELETE, any other UPDATE, a purge before purgeAfter) are covered by
// packages/db/test/bank-message.e2e.test.ts ("BankMessageText retention purge (trigger)").
const t = useMatcherE2e();
let w: ReconcileWorker;
let purge: BankTextPurgeService;

beforeAll(async () => {
  w = await bootReconcileWorker(t.env);
  purge = w.moduleRef.get(BankTextPurgeService);
});

afterAll(async () => {
  await w.close();
});

async function message(purgeable: boolean) {
  const card = await createCard(t.db);
  return insertMessage(t.db, {
    card,
    amountTiyin: uniqueAmount(),
    balanceAfterTiyin: 9_000_000n,
    purgeable,
  });
}

const textRow = (bankMessageId: string) =>
  t.db.bankMessageText.findUniqueOrThrow({ where: { bankMessageId } });
const messageRow = (id: string) => t.db.bankMessage.findUniqueOrThrow({ where: { id } });

describe('bank-text purge (real Postgres)', () => {
  it('erases only the text past purgeAfter; the BankMessage row, purgeAfter and createdAt stay; a second run does nothing', async () => {
    const due = await message(true);
    const kept = await message(false);
    const [dueText, keptText, dueRow] = await Promise.all([
      textRow(due.id),
      textRow(kept.id),
      messageRow(due.id),
    ]);
    expect(dueText.text).not.toBeNull();

    const first = await purge.run();
    expect(first.purged).toBeGreaterThanOrEqual(1);
    expect(first.more).toBe(false);

    const after = await textRow(due.id);
    expect(after).toEqual({ ...dueText, text: null });
    expect(await textRow(kept.id)).toEqual(keptText);
    expect(await messageRow(due.id)).toEqual(dueRow);

    // Idempotent: nothing is left to purge, nothing changes.
    expect(await purge.run()).toEqual({ purged: 0, batches: 1, more: false });
    expect(await textRow(due.id)).toEqual(after);
    expect(await textRow(kept.id)).toEqual(keptText);
  });

  it('works in batches until nothing is due', async () => {
    const rows = [await message(true), await message(true), await message(true)];
    const result = await purge.run(2);
    expect(result.purged).toBeGreaterThanOrEqual(3);
    expect(result.batches).toBeGreaterThanOrEqual(2);
    expect(result.more).toBe(false);
    for (const row of rows) expect((await textRow(row.id)).text).toBeNull();
  });

  it('stops at the batch cap and says more is left; the next run finishes', async () => {
    const rows = [await message(true), await message(true), await message(true)];
    const capped = await purge.run(1, 2);
    expect(capped).toEqual({ purged: 2, batches: 2, more: true });
    await purge.run();
    for (const row of rows) expect((await textRow(row.id)).text).toBeNull();
  });

  it('L2: a text kept more than 2 days past purgeAfter is purgeOverdue until the purge runs', async () => {
    const day = 24 * 60 * 60 * 1000;
    const card = await createCard(t.db);
    const insert = (purgeAfter: Date) =>
      insertMessage(t.db, {
        card,
        amountTiyin: uniqueAmount(),
        balanceAfterTiyin: 9_000_000n,
        purgeAfter,
      });
    const overdue = await insert(new Date(Date.now() - 3 * day));
    // Due for the purge, but only a day late: not yet a mismatch.
    const recent = await insert(new Date(Date.now() - day));
    const before = await w.repo.purgeOverdue();
    expect(before.count).toBeGreaterThanOrEqual(1);
    expect(before.ids).toContain(overdue.id);
    expect(before.ids).not.toContain(recent.id);

    await purge.run();
    const after = await w.repo.purgeOverdue();
    expect(after).toEqual({ count: 0, ids: [] });
  });

  it('a message whose text the job purged is never credited: matcher TEXT_MISSING review, no ledger', async () => {
    const user = await createUser(t.db);
    const card = await createCard(t.db);
    const amountTiyin = uniqueAmount();
    const intent = await createIntent(t.db, user.id, card.id, { amountTiyin });
    const row = await insertMessage(t.db, {
      card,
      amountTiyin,
      balanceAfterTiyin: 7n,
      purgeable: true,
    });
    await purge.run();
    expect((await textRow(row.id)).text).toBeNull();

    await expect(t.a.matcher.process(row.id, false)).resolves.toBe('PROCESSED');
    const outcome = await t.outcome(row.id);
    expect(outcome?.outcome).toBe('REVIEW');
    expect(outcome?.review).toMatchObject({
      kind: 'UNRECOGNIZED',
      note: 'TEXT_MISSING',
      intentId: intent.id,
    });
    expect(await t.ledger(user.id)).toHaveLength(0);
  });
});
