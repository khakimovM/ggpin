import { randomUUID } from 'node:crypto';
import { syntheticPan } from '../../modules/payments/__tests__/payments.fixtures';
import { ACTOR, useOpsE2e } from './ops-e2e.harness';

const t = useOpsE2e();
const WHO = ['--reason', 'checked in the bank app', '--operator', ACTOR.operator];

/** A PAN whose HUMO last4 no card on the test DB has used (card:add refuses a recent last4). */
async function freshPan(): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const pan = syntheticPan();
    if ((await t.db().topupCard.count({ where: { bank: 'HUMO', last4: pan.slice(-4) } })) === 0) {
      return pan;
    }
  }
  throw new Error('freshPan: no unused last4 in 50 attempts');
}

async function reviewRow(id: string) {
  return t.db().paymentReview.findUniqueOrThrow({ where: { id } });
}

/** `key=value` lines of a command's output. */
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

/** A hand-made ADJUSTMENT of the user, `hoursAgo` hours back (synthetic, D-47 preview). */
function adjust(userId: string, amountTiyin: bigint, hoursAgo: number) {
  return t.db().ledgerEntry.create({
    data: {
      userId,
      kind: 'ADJUSTMENT',
      amountTiyin,
      refType: 'ADMIN_ACTION',
      refId: randomUUID(),
      createdAt: new Date(Date.now() - hoursAgo * 3_600_000),
    },
  });
}

describe('owner CLI commands (real Postgres, scripted terminal)', () => {
  it('review:list shows open reviews; review:show prints the raw text with hidden characters escaped', async () => {
    const card = await t.card();
    // A right-to-left override and an escape sequence in the bank text (synthetic).
    const message = await t.message({
      card,
      text: `Popolnenie\u202E 50 000\u001b[2J\nkarta *${card.last4}`,
    });
    const reviewId = await t.review(message.id, 'NO_MATCH', { cardId: card.id });
    const listed = await t.run(['review:list', '--kind', 'NO_MATCH', '--card', card.id]);
    expect(listed.code).toBe(0);
    expect(listed.out.some((l) => l.startsWith(reviewId))).toBe(true);
    const shown = await t.run(['review:show', reviewId]);
    expect(shown.code).toBe(0);
    const text = shown.out.join('\n');
    expect(text).toContain('\\u{202E}');
    expect(text).toContain('\\u{1B}[2J');
    expect(text).not.toContain('\u202E');
    expect(text).not.toContain('\u001b');
    // I1: every bank text line is prefixed and the text has an end marker.
    const start = shown.out.indexOf('--- bank text ---');
    const end = shown.out.indexOf('--- end bank text ---');
    expect(end - start).toBe(3);
    expect(shown.out.slice(start + 1, end).every((l) => l.startsWith('| '))).toBe(true);
  });

  it('review:credit through the CLI; a missing reason or both targets is a usage error and writes nothing', async () => {
    const userId = await t.user();
    const card = await t.card();
    const message = await t.message({ card });
    const reviewId = await t.review(message.id, 'NO_MATCH', { cardId: card.id });
    expect(
      (await t.run(['review:credit', reviewId, '--user', userId, '--operator', 'x'])).code,
    ).toBe(2);
    expect(
      (await t.run(['review:credit', reviewId, '--user', userId, '--intent', userId, ...WHO])).code,
    ).toBe(2);
    expect((await reviewRow(reviewId)).status).toBe('OPEN');
    // D-47: hand-given money is shown first. Without a request the count starts at the transfer
    // (a minute ago) but never covers less than 48 h. Counted: the positive one inside; not
    // counted: a negative one, and a positive one 49 h old.
    await adjust(userId, 1_500_000n, 2);
    await adjust(userId, -200_000n, 1);
    await adjust(userId, 900_000n, 49);
    const done = await t.run(['review:credit', reviewId, '--user', userId, ...WHO]);
    expect(done.code).toBe(0);
    expect(fields(done.out)['manualCreditsSinceRequest']).toMatch(
      /^adjust=1 \(\+15000 UZS\), reviewCredit=0 \(\+0 UZS\) since /,
    );
    expect(fields(done.out)).toMatchObject({ resolution: 'CREDITED_USER', user: userId });
    expect((await auditOf(done.out)).actorType).toBe('CLI');
    const again = await t.run(['review:credit', reviewId, '--user', userId, ...WHO]);
    expect(again.code).toBe(1);
    expect(again.err[0]).toContain('refused: VALIDATION_ERROR');
  });

  it('review:credit --intent: hand payments since the request began show, even 49 h back (R2, R1 review)', async () => {
    const userId = await t.user();
    const card = await t.card();
    const amountTiyin = 5_012_300n; // whole so‘m with a suffix (PaymentIntent_p2p_check)
    const opened = new Date(Date.now() - 50 * 3_600_000);
    const intentId = await t.intent(userId, {
      cardId: card.id,
      amountTiyin,
      status: 'EXPIRED',
      createdAt: opened,
    });
    // Paid 10 min after the request was opened, found and reviewed only now.
    const message = await t.message({
      card,
      amountTiyin,
      tgDate: new Date(opened.getTime() + 10 * 60_000),
    });
    // The matcher's R1 review: the same line shows the owner the hand credit it saw.
    const r1 = { cardId: card.id, intentId, note: 'MANUAL_CREDIT_SEEN' };
    const reviewId = await t.review(message.id, 'AMBIGUOUS', r1);
    await adjust(userId, 5_000_000n, 49); // after the request opened, before the last 48 h
    await adjust(userId, 700_000n, 51); // before the request: not counted
    // Another transfer of the user, credited by hand from its review: the second kind (F-L2).
    const other = await t.message({ card: await t.card(), amountTiyin: 3_000_000n });
    const otherReview = await t.review(other.id, 'NO_MATCH', { cardId: other.cardId });
    expect((await t.run(['review:credit', otherReview, '--user', userId, ...WHO])).code).toBe(0);
    const done = await t.run(['review:credit', reviewId, '--intent', intentId, ...WHO]);
    expect(fields(done.out)['manualCreditsSinceRequest']).toBe(
      `adjust=1 (+50000 UZS), reviewCredit=1 (+30000 UZS) since ${opened.toISOString()}`,
    );
  });

  it('review:ignore and review:returned-offline close a review once, with an AuditLog row', async () => {
    const card = await t.card();
    const credit = await t.message({ card });
    const ignored = await t.review(credit.id, 'NO_MATCH', { cardId: card.id });
    const ignore = await t.run(['review:ignore', ignored, ...WHO]);
    expect(ignore.code).toBe(0);
    expect(await reviewRow(ignored)).toMatchObject({ status: 'RESOLVED', resolution: 'IGNORED' });
    expect(await auditOf(ignore.out)).toMatchObject({ actorType: 'CLI', action: 'REVIEW_IGNORE' });
    expect((await t.run(['review:ignore', ignored, ...WHO])).code).toBe(1);

    const other = await t.message({ card });
    const returned = await t.review(other.id, 'AMBIGUOUS', { cardId: card.id });
    expect((await t.run(['review:returned-offline', returned, ...WHO])).code).toBe(0);
    expect((await reviewRow(returned)).resolution).toBe('RETURNED_OFFLINE');
    // Nothing was received on a DEBIT: there is nothing to pay back.
    const debit = await t.message({ card, direction: 'DEBIT' });
    const debitReview = await t.review(debit.id, 'POSSIBLE_REVERSAL', { cardId: card.id });
    expect((await t.run(['review:returned-offline', debitReview, ...WHO])).code).toBe(1);
    expect((await reviewRow(debitReview)).status).toBe('OPEN');
  });

  it('review:accept-chain: CHAIN_BREAK only, never over an undecided credit; resumes the card', async () => {
    const card = await t.card({ paused: true });
    const debit = await t.message({ card, direction: 'DEBIT' });
    const breakReview = await t.review(debit.id, 'CHAIN_BREAK', { cardId: card.id });
    const credit = await t.message({ card });
    const creditBreak = await t.review(credit.id, 'CHAIN_BREAK', { cardId: card.id });
    const noMatch = await t.review(credit.id, 'NO_MATCH', { cardId: card.id });

    const undecided = await t.run(['review:accept-chain', creditBreak, ...WHO]);
    expect(undecided.code).toBe(1);
    expect(undecided.err[0]).toContain('CREDIT_UNDECIDED');
    expect((await t.run(['review:accept-chain', noMatch, ...WHO])).err[0]).toContain(
      'NOT_A_CHAIN_BREAK',
    );
    // The other open break on the card would keep it paused (S8 M1): close it first.
    expect((await t.run(['review:ignore', creditBreak, ...WHO])).code).toBe(0);
    const accepted = await t.run(['review:accept-chain', breakReview, ...WHO]);
    expect(accepted.code).toBe(0);
    expect(await reviewRow(breakReview)).toMatchObject({ resolution: 'CHAIN_ACCEPTED' });
    const after = await t.db().topupCard.findUniqueOrThrow({ where: { id: card.id } });
    expect(after.autoCreditPaused).toBe(false);
    expect((await auditOf(accepted.out)).after).toMatchObject({ autoCreditResumed: true });
  });

  it('card:add: --limit is required; the output and the AuditLog never hold the PAN', async () => {
    const pan = await freshPan();
    const base = ['card:add', '--bank', 'HUMO'];
    const noLimit = await t.run([...base, ...WHO], ['TESTOV SINOV', pan]);
    expect(noLimit.code).toBe(2);
    expect(await t.db().topupCard.count({ where: { pan } })).toBe(0);

    const added = await t.run([...base, '--limit', '100000000', ...WHO], ['TESTOV SINOV', pan]);
    expect(added.code).toBe(0);
    const printed = [...added.out, ...added.err].join('\n');
    expect(printed).not.toContain(pan);
    const cardId = fields(added.out)['card'] ?? '';
    const audit = await auditOf(added.out);
    expect(JSON.stringify(audit)).not.toContain(pan);
    expect(audit).toMatchObject({ actorType: 'CLI', action: 'CARD_ADD', targetId: cardId });
    const listed = await t.run(['card:list']);
    expect(listed.out.join('\n')).toContain(`HUMO*${pan.slice(-4)}`);
    expect(listed.out.join('\n')).not.toContain(pan);
    // card:pause / card:resume / card:limit / card:retire each write their AuditLog row.
    for (const argv of [
      ['card:pause', cardId],
      ['card:resume', cardId],
      ['card:limit', cardId, '--limit', '200000000'],
      ['card:retire', cardId, '--emergency'],
    ]) {
      const run = await t.run([...argv, ...WHO]);
      expect(run.code).toBe(0);
      expect((await auditOf(run.out)).actorType).toBe('CLI');
    }
  });

  it('card:add asks for the holder and the number (kept out of the shell history and npm log)', async () => {
    const pan = await freshPan();
    const argv = ['card:add', '--bank', 'HUMO', '--limit', '100000'];
    const added = await t.run([...argv, ...WHO], ['TESTOV SINOV', pan]);
    expect(added.code).toBe(0);
    expect(added.asked).toEqual(['Holder name as on the card: ', 'Card number (16 digits): ']);
    const printed = [...added.out, ...added.err].join('\n');
    expect(printed).not.toContain('TESTOV');
    expect(printed).not.toContain(pan);
    const cardId = fields(added.out)['card'] ?? '';
    expect((await t.db().topupCard.findUniqueOrThrow({ where: { id: cardId } })).pan).toBe(pan);
    expect((await t.run(['card:retire', cardId, '--emergency', ...WHO])).code).toBe(0);
  });

  it('wallet:adjust above the threshold asks for the amount again; a wrong answer moves nothing', async () => {
    const userId = await t.user();
    const key = randomUUID().replaceAll('-', '');
    const big = ['wallet:adjust', '--user', userId, '--amount', '2000000', '--key', key, ...WHO];
    const wrong = await t.run(big, ['200000']);
    expect(wrong.asked).toHaveLength(1); // no code is sent for a wrong re-typed amount
    expect(wrong.code).toBe(1);
    expect(await t.db().ledgerEntry.count({ where: { userId } })).toBe(0);
    const right = await t.run(big, ['2000000', t.codeFor(`user ${userId} key ${key}`)]);
    expect(right.code).toBe(0);
    expect(right.asked).toHaveLength(2);
    expect((await auditOf(right.out)).after).toMatchObject({ otpVerified: true });
    expect(fields(right.out)).toMatchObject({ applied: 'true', balance: '2000000 UZS' });
    expect((await auditOf(right.out)).action).toBe('WALLET_ADJUST');
    // At or below the threshold nothing is asked.
    const small = await t.run([
      'wallet:adjust',
      '--user',
      userId,
      '--amount=-500.50',
      '--key',
      randomUUID().replaceAll('-', ''),
      ...WHO,
    ]);
    expect(small.asked).toHaveLength(0);
    expect(fields(small.out)['balance']).toBe('1999499.5 UZS');
  });

  it('payment:reverse of a review credit freezes a spent wallet; user:unfreeze lifts it once', async () => {
    const userId = await t.user();
    const card = await t.card();
    const message = await t.message({ card });
    const reviewId = await t.review(message.id, 'NO_MATCH', { cardId: card.id });
    const credited = await t.run(['review:credit', reviewId, '--user', userId, ...WHO]);
    const paymentId = fields(credited.out)['payment'] ?? '';
    // The user spent it (an adjustment stands in for a purchase here).
    const spent = `-${String((message.amountTiyin ?? 0n) / 100n)}`;
    expect(
      (
        await t.run([
          'wallet:adjust',
          '--user',
          userId,
          `--amount=${spent}`,
          '--key',
          randomUUID().replaceAll('-', ''),
          ...WHO,
        ])
      ).code,
    ).toBe(0);
    const reversed = await t.run(['payment:reverse', paymentId, ...WHO]);
    expect(reversed.code).toBe(0);
    expect(fields(reversed.out)).toMatchObject({ purchaseFrozen: 'true' });
    expect((await t.db().user.findUniqueOrThrow({ where: { id: userId } })).purchaseFrozen).toBe(
      true,
    );

    const unfreeze = await t.run(['user:unfreeze', userId, ...WHO]);
    expect(unfreeze.code).toBe(0);
    expect(await auditOf(unfreeze.out)).toMatchObject({
      action: 'USER_UNFREEZE',
      actorType: 'CLI',
    });
    expect((await t.db().user.findUniqueOrThrow({ where: { id: userId } })).purchaseFrozen).toBe(
      false,
    );
    const twice = await t.run(['user:unfreeze', userId, ...WHO]);
    expect(fields(twice.out)).toMatchObject({ applied: 'false', audit: '-' });
  });
});
