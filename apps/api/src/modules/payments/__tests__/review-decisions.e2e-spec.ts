import type { PaymentReviewKind } from '@repo/db';
import { ACTOR, HOUR, MINUTE, useOpsE2e } from '../../../cli/__tests__/ops-e2e.harness';

// S8 round 1 on the owner CLI's real graph: pause reasons (M1), integrity notes (L2), a late
// credit onto a re-allocated amount (m1), returned-offline vs credited (m2), the blocked / daily
// limit override (D-46 (2)) and who ran the command (L5).

const t = useOpsE2e();
const WHO = ['--reason', 'checked in the bank app', '--operator', ACTOR.operator];

function fields(out: readonly string[]): Record<string, string> {
  return Object.fromEntries(
    out
      .filter((l) => l.includes('='))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );
}

async function auditOf(out: readonly string[]) {
  const id = fields(out)['audit'];
  if (id === undefined || id === '-') throw new Error('no audit id printed');
  return t.audit(id);
}

async function noteReview(
  messageId: string,
  kind: PaymentReviewKind,
  note: string,
  cardId: string,
) {
  const row = await t.db().paymentReview.create({
    data: { bankMessageId: messageId, kind, note, cardId },
    select: { id: true },
  });
  return row.id;
}

const paused = async (cardId: string) =>
  (await t.db().topupCard.findUniqueOrThrow({ where: { id: cardId } })).autoCreditPaused;

const status = async (id: string) =>
  (await t.db().paymentReview.findUniqueOrThrow({ where: { id } })).status;

describe('review decisions (S8 round 1, real Postgres)', () => {
  it('accept-chain of a DEBIT break keeps the card paused while a TEXT_HASH_MISMATCH is open (M1)', async () => {
    const card = await t.card({ paused: true });
    const debit = await t.message({ card, direction: 'DEBIT' });
    const breakReview = await t.review(debit.id, 'CHAIN_BREAK', { cardId: card.id });
    const tampered = await t.message({ card });
    const integrity = await noteReview(tampered.id, 'UNRECOGNIZED', 'TEXT_HASH_MISMATCH', card.id);

    const accepted = await t.run(['review:accept-chain', breakReview, ...WHO]);
    expect(accepted.code).toBe(0);
    expect(await status(breakReview)).toBe('RESOLVED');
    expect(await paused(card.id)).toBe(true);
    expect(fields(accepted.out)).toMatchObject({
      autoCreditResumed: '-',
      stillPausedBy: `UNRECOGNIZED/TEXT_HASH_MISMATCH:${integrity}`,
    });
    expect(accepted.out.join('\n')).toContain('card:resume');
    expect((await auditOf(accepted.out)).after).toMatchObject({
      autoCreditResumed: false,
      remainingPauseReasons: `UNRECOGNIZED/TEXT_HASH_MISMATCH:${integrity}`,
    });

    // card:resume lists it and needs --confirm-override.
    const refused = await t.run(['card:resume', card.id, ...WHO]);
    expect(refused.code).toBe(1);
    expect(refused.out.join('\n')).toContain(integrity);
    expect(refused.err[0]).toContain('OPEN_PAUSE_REVIEWS');
    expect(await paused(card.id)).toBe(true);
    const forced = await t.run(['card:resume', card.id, '--confirm-override', ...WHO]);
    expect(forced.code).toBe(0);
    expect(await paused(card.id)).toBe(false);
    expect((await auditOf(forced.out)).after).toMatchObject({
      override: true,
      openPauseReviews: `UNRECOGNIZED/TEXT_HASH_MISMATCH:${integrity}`,
    });
  });

  it('a card:pause by the owner made BEFORE the break still stands after accept-chain (R1)', async () => {
    const card = await t.card();
    const pause = await t.run(['card:pause', card.id, ...WHO]);
    expect(fields(pause.out)['applied']).toBe('true');
    const pauseAudit = fields(pause.out)['audit'];
    // Later the chain breaks (the worker finds the card already paused).
    const debit = await t.message({ card, direction: 'DEBIT' });
    const breakReview = await t.review(debit.id, 'CHAIN_BREAK', { cardId: card.id });
    const accepted = await t.run(['review:accept-chain', breakReview, ...WHO]);
    expect(accepted.code).toBe(0);
    expect(fields(accepted.out)).toMatchObject({
      autoCreditResumed: '-',
      stillPausedBy: `CARD_PAUSE:${pauseAudit ?? '?'}`,
    });
    expect(await paused(card.id)).toBe(true);
  });

  it('card:pause of a card the worker already paused is recorded, and accept-chain keeps it paused (R1)', async () => {
    const card = await t.card({ paused: true });
    const debit = await t.message({ card, direction: 'DEBIT' });
    const breakReview = await t.review(debit.id, 'CHAIN_BREAK', { cardId: card.id });
    const pause = await t.run(['card:pause', card.id, ...WHO]);
    expect(fields(pause.out)['applied']).toBe('true');
    expect((await auditOf(pause.out)).after).toMatchObject({
      alreadyPaused: true,
      autoCreditPaused: true,
    });
    const accepted = await t.run(['review:accept-chain', breakReview, ...WHO]);
    expect(fields(accepted.out)['stillPausedBy']).toBe(
      `CARD_PAUSE:${fields(pause.out)['audit'] ?? '?'}`,
    );
    expect(await paused(card.id)).toBe(true);
    // A resume on a card that is already on stays a no-op.
    const other = await t.card();
    expect(fields((await t.run(['card:resume', other.id, ...WHO])).out)['applied']).toBe('false');
  });

  it('pause -> resume -> break -> accept-chain switches the card back on (R1)', async () => {
    const card = await t.card();
    expect((await t.run(['card:pause', card.id, ...WHO])).code).toBe(0);
    expect((await t.run(['card:resume', card.id, ...WHO])).code).toBe(0);
    // The worker pauses the card on the break.
    await t.db().topupCard.update({ where: { id: card.id }, data: { autoCreditPaused: true } });
    const first = await t.message({ card, direction: 'DEBIT' });
    const firstBreak = await t.review(first.id, 'CHAIN_BREAK', { cardId: card.id });
    const resumed = await t.run(['review:accept-chain', firstBreak, ...WHO]);
    expect(fields(resumed.out)['autoCreditResumed']).toBe(card.id);
    expect(await paused(card.id)).toBe(false);
  });

  it('a SENDER_MISMATCH credit needs --bank-verified, recorded in the AuditLog (L2)', async () => {
    const userId = await t.user();
    const card = await t.card();
    const message = await t.message({ card });
    const reviewId = await noteReview(message.id, 'UNRECOGNIZED', 'SENDER_MISMATCH', card.id);
    const argv = ['review:credit', reviewId, '--user', userId, ...WHO];
    const refused = await t.run(argv);
    expect(refused.code).toBe(1);
    expect(refused.err.join('\n')).toContain('BANK_VERIFICATION_REQUIRED');
    expect(await t.db().payment.count({ where: { bankMessageId: message.id } })).toBe(0);
    const done = await t.run([...argv, '--bank-verified']);
    expect(done.code).toBe(0);
    expect((await auditOf(done.out)).after).toMatchObject({ bankVerified: true });
  });

  it('--intent onto an amount handed to a newer request is AMOUNT_REALLOCATED, not a database error (m1)', async () => {
    const card = await t.card();
    const amountTiyin = 5_000_000n + 4_200n;
    const createdAt = new Date(Date.now() - 3 * 24 * HOUR);
    const late = await t.intent(await t.user(), {
      cardId: card.id,
      amountTiyin,
      status: 'EXPIRED',
      createdAt,
    });
    const lateRow = await t.db().paymentIntent.findUniqueOrThrow({ where: { id: late } });
    const reservedUntil = lateRow.reservedUntil ?? new Date();
    // The newer request got the same amount an hour after the old reservation ended; the money
    // for the old one (sent inside its grace) is processed only now, so paying it would stretch
    // its reservation over the newer one (tgDate + 24 h).
    await t.intent(await t.user(), {
      cardId: card.id,
      amountTiyin,
      status: 'PENDING',
      createdAt: new Date(reservedUntil.getTime() + HOUR),
    });
    const message = await t.message({
      card,
      amountTiyin,
      tgDate: new Date(reservedUntil.getTime() - MINUTE),
    });
    const reviewId = await t.review(message.id, 'NO_MATCH', { cardId: card.id });
    const refused = await t.run(['review:credit', reviewId, '--intent', late, ...WHO]);
    expect(refused.code).toBe(1);
    expect(refused.err.join('\n')).toContain('AMOUNT_REALLOCATED');
    expect(refused.err.join('\n')).not.toContain('23P01');
    expect((await t.db().paymentIntent.findUniqueOrThrow({ where: { id: late } })).status).toBe(
      'EXPIRED',
    );
    expect(await t.db().payment.count({ where: { bankMessageId: message.id } })).toBe(0);
  });

  it('returned-offline after a credit is ALREADY_CREDITED; a credit after returned-offline is refused; review:show names the Payment (m2)', async () => {
    const userId = await t.user();
    const card = await t.card();
    const credited = await t.message({ card });
    const first = await t.review(credited.id, 'NO_MATCH', { cardId: card.id });
    const second = await t.review(credited.id, 'DUPLICATE', { cardId: card.id });
    const credit = await t.run(['review:credit', first, '--user', userId, ...WHO]);
    expect(credit.code).toBe(0);
    const offline = await t.run(['review:returned-offline', second, ...WHO]);
    expect(offline.code).toBe(1);
    expect(offline.err[0]).toContain('ALREADY_CREDITED');
    const shown = await t.run(['review:show', second]);
    expect(fields(shown.out)['payment']).toContain(`${fields(credit.out)['payment'] ?? '?'} `);
    expect(fields(shown.out)['payment']).toContain(`via=review ${first}`);

    const returned = await t.message({ card });
    const a = await t.review(returned.id, 'NO_MATCH', { cardId: card.id });
    const b = await t.review(returned.id, 'AMBIGUOUS', { cardId: card.id });
    expect((await t.run(['review:returned-offline', a, ...WHO])).code).toBe(0);
    const late = await t.run(['review:credit', b, '--user', userId, ...WHO]);
    expect(late.code).toBe(1);
    expect(late.err[0]).toContain('RETURNED_OFFLINE');
    expect(await t.db().payment.count({ where: { bankMessageId: returned.id } })).toBe(0);
  });

  it('a blocked user or one over the daily limit: the state is shown, nothing written without --confirm-override (D-46 (2))', async () => {
    const card = await t.card();
    const blocked = await t.user();
    await t.db().user.update({ where: { id: blocked }, data: { isBlocked: true } });
    const m1 = await t.message({ card });
    const r1 = await t.review(m1.id, 'USER_BLOCKED', { cardId: card.id });
    const refused = await t.run(['review:credit', r1, '--user', blocked, ...WHO]);
    expect(refused.code).toBe(1);
    expect(fields(refused.out)).toMatchObject({ blocked: 'true', purchaseFrozen: 'false' });
    expect(refused.err.join('\n')).toContain('USER_BLOCKED');
    expect(await t.db().payment.count({ where: { bankMessageId: m1.id } })).toBe(0);
    const forced = await t.run([
      'review:credit',
      r1,
      '--user',
      blocked,
      '--confirm-override',
      ...WHO,
    ]);
    expect(forced.code).toBe(0);
    expect((await auditOf(forced.out)).after).toMatchObject({
      override: true,
      user: { blocked: true, overLimit: false },
    });

    // A new account (cap 500 000 so'm a day) gets 600 000 so'm.
    const young = await t.user();
    const m2 = await t.message({ card, amountTiyin: 60_000_000n + 7_700n });
    const r2 = await t.review(m2.id, 'DAILY_LIMIT', { cardId: card.id });
    const over = await t.run(['review:credit', r2, '--user', young, ...WHO]);
    expect(over.code).toBe(1);
    expect(fields(over.out)).toMatchObject({ overLimit: 'true', accountAgeDays: '0' });
    expect(fields(over.out)['todayBase']).toContain('NEW_ACCOUNT_DAILY_LIMIT');
    expect(over.err.join('\n')).toContain('NEW_ACCOUNT_DAILY_LIMIT');
    const allowed = await t.run([
      'review:credit',
      r2,
      '--user',
      young,
      '--confirm-override',
      ...WHO,
    ]);
    expect(allowed.code).toBe(0);
    expect((await auditOf(allowed.out)).after).toMatchObject({
      override: true,
      user: { overLimit: true, limitReason: 'NEW_ACCOUNT_DAILY_LIMIT', limitTiyin: '50000000' },
    });
  });

  it('the AuditLog names the SSH client and the OS account; a different --ip is refused (L5)', async () => {
    const card = await t.card();
    const message = await t.message({ card });
    const reviewId = await t.review(message.id, 'NO_MATCH', { cardId: card.id });
    const ssh = { sshIp: '198.51.100.4', osUser: 'deploy (sudo from aziz)' };
    const wrongIp = await t.run(
      ['review:ignore', reviewId, ...WHO, '--ip', '203.0.113.5'],
      [],
      ssh,
    );
    expect(wrongIp.code).toBe(2);
    expect(await status(reviewId)).toBe('OPEN');
    const done = await t.run(['review:ignore', reviewId, ...WHO], [], ssh);
    expect(done.code).toBe(0);
    const audit = await auditOf(done.out);
    expect(audit.ip).toBe('198.51.100.4');
    expect(audit.after).toMatchObject({ osUser: 'deploy (sudo from aziz)' });
  });
});
