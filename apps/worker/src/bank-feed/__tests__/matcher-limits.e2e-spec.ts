import type { TopupCard, TopupCardStatus } from '@repo/db';
import { cardLimitAlertRef, type CardLimitAlert } from '@repo/shared';
import { useMatcherE2e } from './matcher-e2e.harness';
import {
  HOUR,
  createCard,
  createIntent,
  createUser,
  insertMessage,
  uniqueAmount,
} from './matcher-e2e.fixtures';

const t = useMatcherE2e();

/** Whether the card-limit alert for the card at its CURRENT limits was queued. */
async function limitAlert(alert: CardLimitAlert, card: TopupCard): Promise<boolean> {
  const refId = cardLimitAlertRef(alert, {
    cardId: card.id,
    receiveLimitTiyin: card.receiveLimitTiyin,
    monthlyLimitTiyin: card.monthlyLimitTiyin,
  });
  return (await t.notifyJob(`alert-${alert}-${refId}`)) !== undefined;
}

async function alertExists(alert: string, refId: string): Promise<boolean> {
  return (await t.notifyJob(`alert-${alert}-${refId}`)) !== undefined;
}

interface CreditOptions {
  readonly card: TopupCard;
  readonly late?: boolean;
  /** Balance before this credit (the chain of the card's messages). */
  readonly before?: bigint;
}

/** One credited payment of about 50 000 so'm on `card`; returns the card after the effects. */
async function credit(opts: CreditOptions) {
  const user = await createUser(t.db);
  const amountTiyin = uniqueAmount();
  await createIntent(t.db, user.id, opts.card.id, {
    amountTiyin,
    // Late: expired 1.5 h ago, i.e. past the 1 h capacity hold but well inside the 24 h grace.
    ...(opts.late === true
      ? { status: 'EXPIRED' as const, createdAt: new Date(Date.now() - 2 * HOUR) }
      : {}),
  });
  const balanceAfterTiyin = (opts.before ?? 0n) + amountTiyin;
  const message = await insertMessage(t.db, { card: opts.card, amountTiyin, balanceAfterTiyin });
  await t.a.matcher.process(message.id, false);
  await t.checkLimits(message.id);
  const outcome = await t.outcome(message.id);
  expect(outcome?.outcome).toBe('CREDITED');
  const card = await t.db.topupCard.findUniqueOrThrow({ where: { id: opts.card.id } });
  return { card, paymentId: outcome?.paymentId ?? '', user, balanceAfterTiyin };
}

async function cardWith(limitTiyin: bigint, extra: { status?: TopupCardStatus; monthly?: bigint }) {
  return createCard(t.db, {
    limitTiyin,
    ...(extra.status === undefined ? {} : { status: extra.status }),
    ...(extra.monthly === undefined ? {} : { monthlyLimitTiyin: extra.monthly }),
  });
}

describe('matcher: card limits after a credit (docs/05 §2, D-42, D-45)', () => {
  it('money that still arrives on a FULL card is credited (the user paid what we showed)', async () => {
    const { card, user } = await credit({
      card: await cardWith(1_000_000_000n, { status: 'FULL' }),
    });
    expect(card.status).toBe('FULL');
    expect(await t.ledger(user.id)).toHaveLength(1);
  });

  it('D-45: held requests far past the limit never make the card FULL and raise no limit alert', async () => {
    // 100 000 so'm limit; two other users hold ~100 000 so'm on it; ~50 000 so'm arrives (50 %).
    const card = await cardWith(10_000_000n, {});
    for (let i = 0; i < 2; i += 1) {
      await createIntent(t.db, (await createUser(t.db)).id, card.id, {
        amountTiyin: uniqueAmount(),
      });
    }
    const after = (await credit({ card })).card;
    expect(after.status).toBe('ACTIVE');
    expect(await limitAlert('cardNearLimit', after)).toBe(false);
    expect(await limitAlert('cardFull', after)).toBe(false);
  });

  it('below 80 % received: no limit alert, the card stays ACTIVE', async () => {
    const { card } = await credit({ card: await cardWith(1_000_000_000n, {}) });
    expect(card.status).toBe('ACTIVE');
    expect(await limitAlert('cardNearLimit', card)).toBe(false);
    expect(await limitAlert('cardFull', card)).toBe(false);
  });

  it('80 % received: cardNearLimit (<cardId>_80_<limits>), the card stays ACTIVE', async () => {
    // ~50 000 so'm received of a 60 000 so'm limit = 83 %.
    const { card } = await credit({ card: await cardWith(6_000_000n, {}) });
    expect(card.status).toBe('ACTIVE');
    expect(await limitAlert('cardNearLimit', card)).toBe(true);
    expect(await limitAlert('cardFull', card)).toBe(false);
  });

  it('100 % received: ACTIVE -> FULL and cardFull (<cardId>_<limits>)', async () => {
    const { card, paymentId } = await credit({ card: await cardWith(5_000_000n, {}) });
    expect(card.status).toBe('FULL');
    expect(await limitAlert('cardFull', card)).toBe(true);
    // Paid in time: its share was held, so this is not the late-payment risk.
    expect(await alertExists('lateOverLimit', paymentId)).toBe(false);
  });

  it('the monthly limit fills the card the same way (its value is in the refId)', async () => {
    const near = (await credit({ card: await cardWith(1_000_000_000n, { monthly: 6_000_000n }) }))
      .card;
    expect(near.status).toBe('ACTIVE');
    expect(await limitAlert('cardNearLimit', near)).toBe(true);
    const full = (await credit({ card: await cardWith(1_000_000_000n, { monthly: 5_000_000n }) }))
      .card;
    expect(full.status).toBe('FULL');
    expect(await limitAlert('cardFull', full)).toBe(true);
  });

  it('after the limit is raised (card:limit) the card filling up again is announced again', async () => {
    const first = await credit({ card: await cardWith(5_000_000n, {}) });
    expect(first.card.status).toBe('FULL');
    expect(await limitAlert('cardFull', first.card)).toBe(true);
    // What card:limit does (S4): new limit, FULL -> ACTIVE because received < limit.
    const raised = await t.db.topupCard.update({
      where: { id: first.card.id },
      data: { receiveLimitTiyin: 10_000_000n, status: 'ACTIVE' },
    });
    const second = await credit({ card: raised, before: first.balanceAfterTiyin });
    expect(second.card.status).toBe('FULL');
    expect(await limitAlert('cardFull', second.card)).toBe(true);
    expect(
      cardLimitAlertRef('cardFull', {
        cardId: raised.id,
        receiveLimitTiyin: 10_000_000n,
        monthlyLimitTiyin: null,
      }),
    ).not.toBe(
      cardLimitAlertRef('cardFull', {
        cardId: raised.id,
        receiveLimitTiyin: 5_000_000n,
        monthlyLimitTiyin: null,
      }),
    );
  });

  it('a late payment past the capacity hold that takes the card over its limit raises lateOverLimit', async () => {
    const { card, paymentId } = await credit({ card: await cardWith(4_000_000n, {}), late: true });
    expect(card.status).toBe('FULL');
    expect(await limitAlert('cardFull', card)).toBe(true);
    const job = await t.notifyJob(`alert-lateOverLimit-${paymentId}`);
    expect(job?.data).toEqual({ kind: 'OWNER_ALERT', alert: 'lateOverLimit', refId: paymentId });
  });

  it('a late payment that stays under the limit raises nothing extra', async () => {
    const { paymentId } = await credit({ card: await cardWith(1_000_000_000n, {}), late: true });
    expect(await alertExists('lateOverLimit', paymentId)).toBe(false);
  });

  it('code #2: a CREDIT that is only reviewed (NO_MATCH) still counts: the card becomes FULL with cardFull', async () => {
    const card = await cardWith(5_000_000n, {});
    const message = await insertMessage(t.db, {
      card,
      amountTiyin: uniqueAmount(),
      balanceAfterTiyin: 9n,
    });
    await t.a.matcher.process(message.id, false);
    await t.checkLimits(message.id);
    expect((await t.outcome(message.id))?.review?.kind).toBe('NO_MATCH');
    const after = await t.db.topupCard.findUniqueOrThrow({ where: { id: card.id } });
    expect(after.status).toBe('FULL');
    expect(await limitAlert('cardFull', after)).toBe(true);
  });

  it('L7: cardNearLimit only when a credit crosses 80 %, cardFull only when the card turns FULL', async () => {
    // ~50 000 so'm of 60 000 so'm = 83 %: crosses 80 %.
    const near = await credit({ card: await cardWith(6_000_000n, {}) });
    const nearId = cardLimitAlertRef('cardNearLimit', {
      cardId: near.card.id,
      receiveLimitTiyin: near.card.receiveLimitTiyin,
      monthlyLimitTiyin: null,
    });
    const nearJob = await t.notifyJob(`alert-cardNearLimit-${nearId}`);
    expect(nearJob).toBeDefined();
    await nearJob?.remove();
    // 1 so'm more (unmatched): still 83 %, nothing crossed, so the alert is not queued again.
    const small = await insertMessage(t.db, {
      card: near.card,
      amountTiyin: 100n,
      balanceAfterTiyin: near.balanceAfterTiyin + 100n,
    });
    await t.a.matcher.process(small.id, false);
    await t.checkLimits(small.id);
    expect(await limitAlert('cardNearLimit', near.card)).toBe(false);

    const full = await credit({ card: await cardWith(5_000_000n, {}) });
    expect(full.card.status).toBe('FULL');
    const fullId = cardLimitAlertRef('cardFull', {
      cardId: full.card.id,
      receiveLimitTiyin: full.card.receiveLimitTiyin,
      monthlyLimitTiyin: null,
    });
    const fullJob = await t.notifyJob(`alert-cardFull-${fullId}`);
    expect(fullJob).toBeDefined();
    await fullJob?.remove();
    const more = await insertMessage(t.db, {
      card: full.card,
      amountTiyin: 100n,
      balanceAfterTiyin: full.balanceAfterTiyin + 100n,
    });
    await t.a.matcher.process(more.id, false);
    await t.checkLimits(more.id);
    expect(await limitAlert('cardFull', full.card)).toBe(false);
  });

  it('m-3: a crossing message whose check ran late still gets cardNearLimit (before = earlier messages only)', async () => {
    // 125 000 so'm limit; unmatched CREDITs of ~50 000, ~50 000 and 1 so'm: 40 %, 80 %, 80 %.
    const card = await cardWith(12_500_000n, {});
    let balance = 0n;
    const messages: Awaited<ReturnType<typeof insertMessage>>[] = [];
    for (const amountTiyin of [uniqueAmount(), uniqueAmount(), 100n]) {
      balance += amountTiyin;
      messages.push(await insertMessage(t.db, { card, amountTiyin, balanceAfterTiyin: balance }));
    }
    const [m0, m1, m2] = messages;
    if (m0 === undefined || m1 === undefined || m2 === undefined) throw new Error('no messages');
    await t.a.matcher.process(m0.id, false);
    await t.checkLimits(m0.id);
    // M1 crosses 80 %, but its limit job does not run yet (a busy card, a crash)...
    await t.a.matcher.process(m1.id, false);
    expect(await t.limitJob(m1.id)).toBeDefined();
    // ...M2 is checked first: before it (M0 + M1) the card was already past 80 %, so nothing.
    await t.a.matcher.process(m2.id, false);
    await t.checkLimits(m2.id);
    const after = await t.db.topupCard.findUniqueOrThrow({ where: { id: card.id } });
    expect(after.status).toBe('ACTIVE');
    expect(await limitAlert('cardNearLimit', after)).toBe(false);
    // M1's late check: by message order "before" is M0 only (40 %) and "after" 80 %, so the
    // crossing still belongs to M1 and is not lost. ("Everything now minus M1" would count M2
    // in "before"; with a bigger M2 that is past 80 % and the alert would never come.)
    await expect(t.checkLimits(m1.id)).resolves.toBe('CHECKED');
    expect(await limitAlert('cardNearLimit', after)).toBe(true);
    expect(await limitAlert('cardFull', after)).toBe(false);
  });

  it('a replay of the crossing message on a FULL card re-adds the same cardFull id (a lost alert is recovered)', async () => {
    const full = await credit({ card: await cardWith(5_000_000n, {}) });
    const fullId = cardLimitAlertRef('cardFull', {
      cardId: full.card.id,
      receiveLimitTiyin: full.card.receiveLimitTiyin,
      monthlyLimitTiyin: null,
    });
    await (await t.notifyJob(`alert-cardFull-${fullId}`))?.remove();
    const outcome = await t.db.bankMessageOutcome.findFirstOrThrow({
      where: { paymentId: full.paymentId },
    });
    await t.a.matcher.process(outcome.bankMessageId, false);
    await t.checkLimits(outcome.bankMessageId);
    expect(await limitAlert('cardFull', full.card)).toBe(true);
  });
});
