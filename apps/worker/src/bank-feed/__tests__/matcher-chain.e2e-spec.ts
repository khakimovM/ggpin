import { useMatcherE2e } from './matcher-e2e.harness';
import {
  createCard,
  createIntent,
  createUser,
  insertMessage,
  uniqueAmount,
} from './matcher-e2e.fixtures';

const t = useMatcherE2e();

async function alertExists(alert: string, refId: string): Promise<boolean> {
  return (await t.notifyJob(`alert-${alert}-${refId}`)) !== undefined;
}

async function card(id: string) {
  return t.db.topupCard.findUniqueOrThrow({ where: { id } });
}

describe('matcher: balance chain, outgoing money and card verification', () => {
  it('FIRST -> OK credits; a BREAK pauses the card; then even an exact match is AUTO_CREDIT_PAUSED', async () => {
    const user = await createUser(t.db);
    const c = await createCard(t.db);
    const first = await insertMessage(t.db, {
      card: c,
      amountTiyin: 300n,
      balanceAfterTiyin: 1_000n,
    });
    await t.a.matcher.process(first.id, false);
    expect(await t.outcome(first.id)).toMatchObject({ chainStatus: 'FIRST', outcome: 'REVIEW' });

    const paid = uniqueAmount();
    await createIntent(t.db, user.id, c.id, { amountTiyin: paid, status: 'PENDING' });
    const ok = await insertMessage(t.db, {
      card: c,
      amountTiyin: paid,
      balanceAfterTiyin: 1_000n + paid,
    });
    await t.a.matcher.process(ok.id, false);
    expect(await t.outcome(ok.id)).toMatchObject({ chainStatus: 'OK', outcome: 'CREDITED' });

    // A balance that does not follow from the previous one: a message is missing or forged.
    const broken = await insertMessage(t.db, {
      card: c,
      amountTiyin: 500n,
      balanceAfterTiyin: 999_999n,
    });
    await t.a.matcher.process(broken.id, false);
    const breakOutcome = await t.outcome(broken.id);
    expect(breakOutcome).toMatchObject({ chainStatus: 'BREAK', outcome: 'REVIEW' });
    expect(breakOutcome?.review?.kind).toBe('CHAIN_BREAK');
    expect((await card(c.id)).autoCreditPaused).toBe(true);
    expect(await alertExists('chainBreak', breakOutcome?.review?.id ?? '')).toBe(true);

    const waiting = uniqueAmount();
    const intent = await createIntent(t.db, user.id, c.id, { amountTiyin: waiting });
    const next = await insertMessage(t.db, {
      card: c,
      amountTiyin: waiting,
      balanceAfterTiyin: 999_999n + waiting,
    });
    await t.a.matcher.process(next.id, false);
    const paused = await t.outcome(next.id);
    expect(paused).toMatchObject({ chainStatus: 'OK', outcome: 'REVIEW' });
    expect(paused?.review?.kind).toBe('AUTO_CREDIT_PAUSED');
    expect(await t.ledger(user.id)).toHaveLength(1);
    expect((await t.db.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })).status).toBe(
      'PENDING',
    );
  });

  it('a DEBIT is recorded, never touches a wallet, and always alerts the owner', async () => {
    const c = await createCard(t.db);
    const debit = await insertMessage(t.db, {
      card: c,
      direction: 'DEBIT',
      amountTiyin: 2_000_000n,
      balanceAfterTiyin: 3_000_000n,
    });
    await t.a.matcher.process(debit.id, false);
    expect(await t.outcome(debit.id)).toMatchObject({
      outcome: 'DEBIT_RECORDED',
      chainStatus: 'FIRST',
      reviewId: null,
      paymentId: null,
    });
    expect(await alertExists('debit', debit.id)).toBe(true);
  });

  it('a DEBIT equal to a payment just credited on the card is POSSIBLE_REVERSAL', async () => {
    const user = await createUser(t.db);
    const c = await createCard(t.db);
    const amountTiyin = uniqueAmount();
    const intent = await createIntent(t.db, user.id, c.id, { amountTiyin });
    const credit = await insertMessage(t.db, {
      card: c,
      amountTiyin,
      balanceAfterTiyin: 10_000_000n + amountTiyin,
    });
    await t.a.matcher.process(credit.id, false);
    expect((await t.outcome(credit.id))?.outcome).toBe('CREDITED');

    const debit = await insertMessage(t.db, {
      card: c,
      direction: 'DEBIT',
      amountTiyin,
      balanceAfterTiyin: 10_000_000n,
    });
    await t.a.matcher.process(debit.id, false);
    const outcome = await t.outcome(debit.id);
    expect(outcome?.review).toMatchObject({ kind: 'POSSIBLE_REVERSAL', intentId: intent.id });
    expect(await alertExists('possibleReversal', outcome?.review?.id ?? '')).toBe(true);
    expect(await alertExists('debit', debit.id)).toBe(true);
    // The reversal itself is an owner action (S10): the matcher only books the TOPUP.
    expect((await t.ledger(user.id)).map((e) => e.kind)).toEqual(['TOPUP']);
  });

  it('VERIFYING: the exact test amount activates the card (verifiedAt = arrival), no ledger', async () => {
    const c = await createCard(t.db, { status: 'VERIFYING', verifyAmountTiyin: 123_400n });
    const message = await insertMessage(t.db, {
      card: c,
      amountTiyin: 123_400n,
      balanceAfterTiyin: 5_000_000n,
    });
    await t.a.matcher.process(message.id, false);
    expect(await t.outcome(message.id)).toMatchObject({
      outcome: 'CARD_VERIFIED',
      reviewId: null,
      paymentId: null,
    });
    const after = await card(c.id);
    expect(after.status).toBe('ACTIVE');
    expect(after.verifiedAt).toEqual(message.tgDate);
    expect(await alertExists('cardVerified', c.id)).toBe(true);
    expect(await t.db.ledgerEntry.count({ where: { refId: message.id } })).toBe(0);
  });

  it('VERIFYING: any other amount is NO_MATCH and the card stays VERIFYING', async () => {
    const c = await createCard(t.db, { status: 'VERIFYING', verifyAmountTiyin: 123_400n });
    const message = await insertMessage(t.db, {
      card: c,
      amountTiyin: 123_500n,
      balanceAfterTiyin: 5_000_000n,
    });
    await t.a.matcher.process(message.id, false);
    expect((await t.outcome(message.id))?.review?.kind).toBe('NO_MATCH');
    expect((await card(c.id)).status).toBe('VERIFYING');
  });
});
