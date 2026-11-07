import { randomBytes } from 'node:crypto';
import type { TopupCard } from '@repo/db';
import { TopupIntentCreatedSchema, notifyJobId } from '@repo/shared';
import { AppError } from '../../../common/exceptions/app-error';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { CardAdminService, type AddCardInput } from '../card-admin.service';
import { CardPauseRepository } from '../card-pause.repository';
import { CardPauseService } from '../card-pause.service';
import { PaymentsAlerts } from '../payments-alerts';
import { TEST_HOLDER, syntheticPan } from './payments.fixtures';
import { tokenOf, usePaymentsE2e } from './payments-e2e.helpers';

const e2e = usePaymentsE2e();
const ACTOR = { operator: 'owner-cli', ip: '203.0.113.5' };
const admin = () => e2e.app().get(CardAdminService);
// card:pause / card:resume live in the owner CLI's graph only; built here on the same services.
const pauses = () =>
  new CardPauseService(admin(), new CardPauseRepository(), e2e.app().get(PrismaService));

async function refusal(promise: Promise<unknown>): Promise<Record<string, unknown> | undefined> {
  const error: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(error instanceof AppError)) throw new Error('expected an AppError');
  return error.details;
}

/** A PAN whose last4 no card of these banks on the test DB has ever used (10 000 last4s). */
async function freshPan(banks: readonly ('HUMO' | 'UZCARD')[] = ['HUMO']): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const pan = syntheticPan();
    const used = await e2e.db().topupCard.count({
      where: { bank: { in: [...banks] }, last4: pan.slice(-4) },
    });
    if (used === 0) return pan;
  }
  throw new Error('freshPan: no unused last4 in 50 attempts (clean up the test DB)');
}

const input = (pan: string, overrides: Partial<AddCardInput> = {}): AddCardInput => ({
  bank: 'HUMO',
  pan,
  holderName: TEST_HOLDER,
  limitTiyin: 10_000_000_000n,
  reason: 'new receiving card',
  actor: ACTOR,
  ...overrides,
});

function track(alert: 'adminAction' | 'cardDraining', refId: string | null): string {
  if (refId === null) throw new Error('expected an id');
  const id = notifyJobId({ kind: 'OWNER_ALERT', alert, refId });
  e2e.trackJob(id);
  return id;
}

describe('addCard (owner CLI)', () => {
  it('a VERIFYING card with a verification amount; the AuditLog row holds bank and last4, never the PAN or the name', async () => {
    const pan = await freshPan();
    const added = await admin().addCard(input(pan));
    e2e.adopt(added.cardId);
    expect(added).toMatchObject({ applied: true, status: 'VERIFYING' });
    expect(added.verifyAmountTiyin % 100n).toBe(0n);
    expect(added.verifyAmountTiyin >= 100_100n && added.verifyAmountTiyin <= 199_900n).toBe(true);

    const card = await e2e.db().topupCard.findUniqueOrThrow({ where: { id: added.cardId } });
    expect(card).toMatchObject({ pan, last4: pan.slice(-4), verifiedAt: null });
    const audit = await e2e.db().auditLog.findUniqueOrThrow({ where: { id: added.auditId ?? '' } });
    expect(audit).toMatchObject({
      action: 'CARD_ADD',
      targetType: 'TopupCard',
      targetId: added.cardId,
      reason: 'new receiving card',
    });
    const text = JSON.stringify(audit);
    expect(text).toContain(pan.slice(-4));
    expect(text).not.toContain(pan);
    expect(text).not.toContain(TEST_HOLDER);
    expect(await e2e.notifyQueue().getJob(track('adminAction', added.auditId))).toBeDefined();
  });

  it('refuses a missing limit, a bad PAN, an invisible holder name and an empty reason; nothing written', async () => {
    const pan = await freshPan();
    const bad = `${pan.slice(0, 15)}${String((Number(pan[15]) + 1) % 10)}`;
    expect(await refusal(admin().addCard(input(pan, { limitTiyin: 0n })))).toMatchObject({
      field: 'limitTiyin',
    });
    expect(await refusal(admin().addCard(input(bad)))).toMatchObject({ field: 'pan' });
    expect(await refusal(admin().addCard(input(pan, { holderName: '​' })))).toMatchObject({
      field: 'holderName',
    });
    expect(await refusal(admin().addCard(input(pan, { reason: ' ' })))).toMatchObject({
      field: 'reason',
    });
    expect(await e2e.db().topupCard.count({ where: { pan } })).toBe(0);
  });

  it('no two live cards with one (bank, last4); the other bank is fine', async () => {
    // A last4 neither bank has used, so both steps below are unconditional.
    const pan = await freshPan(['HUMO', 'UZCARD']);
    const uzcard = await admin().addCard(input(pan, { bank: 'UZCARD' }));
    e2e.adopt(uzcard.cardId);
    track('adminAction', uzcard.auditId);
    expect(await refusal(admin().addCard(input(pan, { bank: 'UZCARD' })))).toMatchObject({
      field: 'pan',
      reason: 'LIVE_CARD',
    });
    const humo = await admin().addCard(input(pan, { bank: 'HUMO' }));
    e2e.adopt(humo.cardId);
    track('adminAction', humo.auditId);
    expect(humo).toMatchObject({ applied: true, status: 'VERIFYING', alertQueued: true });
  });
});

describe('retireCard', () => {
  async function activeWithRequest(): Promise<{
    card: TopupCard;
    intentId: string;
    token: string;
  }> {
    const card = await e2e.card();
    const user = await e2e.newUser();
    const res = await e2e.create(user);
    const data = TopupIntentCreatedSchema.parse(res.body.data);
    return { card, intentId: data.intentId, token: tokenOf(data.redirectUrl) };
  }

  it('ordinary: ACTIVE -> DRAINING (no new requests, the issued one stays payable) + cardDraining alert', async () => {
    const { card, intentId, token } = await activeWithRequest();
    const change = await admin().retireCard(card.id, 'bank asked to rotate', ACTOR);
    expect(change).toMatchObject({ applied: true, status: 'DRAINING', alertQueued: true });
    track('adminAction', change.auditId);
    expect(await e2e.notifyQueue().getJob(track('cardDraining', card.id))).toBeDefined();
    expect((await e2e.pay(intentId, token)).status).toBe(200);
    expect((await e2e.create(await e2e.newUser())).status).toBe(503);
    // Again: already draining, nothing written.
    expect(await admin().retireCard(card.id, 'again', ACTOR)).toMatchObject({
      applied: false,
      auditId: null,
      alertQueued: false,
    });
  });

  it('emergency: RETIRED now, PENDING requests CANCELLED and their links dead; RETIRED is final', async () => {
    const { card, intentId, token } = await activeWithRequest();
    const change = await admin().retireCard(card.id, 'card blocked', ACTOR, { emergency: true });
    track('adminAction', change.auditId);
    expect(change).toMatchObject({ applied: true, status: 'RETIRED' });
    const intent = await e2e.db().paymentIntent.findUniqueOrThrow({ where: { id: intentId } });
    expect(intent).toMatchObject({ status: 'CANCELLED', payTokenHash: null });
    expect((await e2e.pay(intentId, token)).status).toBe(404);
    const audit = await e2e
      .db()
      .auditLog.findUniqueOrThrow({ where: { id: change.auditId ?? '' } });
    expect(audit.action).toBe('CARD_RETIRE_EMERGENCY');
    expect(audit.after).toMatchObject({ status: 'RETIRED', cancelledIntents: 1 });

    expect(await admin().retireCard(card.id, 'again', ACTOR, { emergency: true })).toMatchObject({
      applied: false,
    });
    expect(
      await refusal(admin().setLimit(card.id, { limitTiyin: 1_000n }, 'raise', ACTOR)),
    ).toMatchObject({ field: 'status' });
    // Pause/resume of a RETIRED card is refused too, and writes no AuditLog (m9).
    const audits = () => e2e.db().auditLog.count({ where: { targetId: card.id } });
    const before = await audits();
    expect(await refusal(pauses().pauseAutoCredit(card.id, 'pause it', ACTOR))).toEqual({
      field: 'status',
      reason: 'RETIRED',
    });
    expect(await refusal(pauses().resumeAutoCredit(card.id, 'resume it', ACTOR))).toEqual({
      field: 'status',
      reason: 'RETIRED',
    });
    expect(await audits()).toBe(before);
  });

  it('a VERIFYING card retires at once; an unknown card is NOT_FOUND', async () => {
    const card = await e2e.card({ status: 'VERIFYING' });
    const change = await admin().retireCard(card.id, 'typo in the number', ACTOR);
    track('adminAction', change.auditId);
    expect(change.status).toBe('RETIRED');
    const missing: unknown = await admin()
      .retireCard('no_such_card', 'x reason', ACTOR)
      .catch((e: unknown) => e);
    expect(missing).toMatchObject({ code: 'NOT_FOUND' });
  });
});

/**
 * Money that arrived on `card`: one PARSED CREDIT as the worker stores it (synthetic, E-29),
 * settled the way the matcher settles unmatched money (NO_MATCH review + REVIEW outcome), so no
 * processed-looking message without an outcome is left in the shared test database
 * (BankMessage is append-only and cannot be deleted in afterAll).
 */
async function receive(card: TopupCard, amountTiyin: bigint): Promise<void> {
  const now = new Date();
  const message = await e2e.db().bankMessage.create({
    data: {
      source: card.bank === 'HUMO' ? 'HUMO_BOT' : 'UZCARD_BOT',
      senderId: 920_000_000_000n + BigInt(randomBytes(3).readUIntBE(0, 3)),
      tgMessageId: BigInt(now.getTime()) * 1_000n + BigInt(randomBytes(1).readUInt8()),
      tgDate: now,
      textSha256: randomBytes(32).toString('hex'),
      parseStatus: 'PARSED',
      parserVersion: 1,
      direction: 'CREDIT',
      amountTiyin,
      balanceAfterTiyin: amountTiyin,
      last4: card.last4,
      bankTxnAt: now,
      cardId: card.id,
    },
    select: { id: true },
  });
  const review = await e2e.db().paymentReview.create({
    data: { bankMessageId: message.id, kind: 'NO_MATCH', cardId: card.id },
    select: { id: true },
  });
  await e2e.db().bankMessageOutcome.create({
    data: {
      bankMessageId: message.id,
      chainStatus: 'FIRST',
      outcome: 'REVIEW',
      reviewId: review.id,
    },
  });
}

describe('setLimit and pause/resume', () => {
  it('D-45: FULL <-> ACTIVE follows RECEIVED money; a held request never makes a card FULL', async () => {
    const card = await e2e.card({ status: 'FULL', limitTiyin: 1_000n });
    const limit = async (limits: { limitTiyin: bigint; monthlyLimitTiyin?: bigint | null }) => {
      const change = await admin().setLimit(card.id, limits, 'limit change', ACTOR);
      track('adminAction', change.auditId);
      return change.status;
    };
    expect(await limit({ limitTiyin: 10_000_000_000n })).toBe('ACTIVE');
    expect((await e2e.create(await e2e.newUser())).status).toBe(201);
    // The pending request (base + suffix) is far above 1 000 tiyin, but it is only held: the card
    // gets no new request (no room), yet it stays ACTIVE.
    expect(await limit({ limitTiyin: 1_000n })).toBe('ACTIVE');
    // Money that arrived is what fills a card: lifetime, then monthly.
    await receive(card, 1_000n);
    expect(await limit({ limitTiyin: 1_000n })).toBe('FULL');
    expect(await limit({ limitTiyin: 10_000_000_000n, monthlyLimitTiyin: 1_000n })).toBe('FULL');
    expect(await limit({ limitTiyin: 10_000_000_000n, monthlyLimitTiyin: 1_001n })).toBe('ACTIVE');
    expect(await limit({ limitTiyin: 10_000_000_000n, monthlyLimitTiyin: 1_000n })).toBe('FULL');
    expect(await limit({ limitTiyin: 10_000_000_000n, monthlyLimitTiyin: null })).toBe('ACTIVE');
  });

  it('a paused card gets no requests; resumed, it does; a second pause is recorded, a second resume is a no-op', async () => {
    const card = await e2e.card();
    const pause = await pauses().pauseAutoCredit(card.id, 'new device login', ACTOR);
    track('adminAction', pause.auditId);
    // The owner's decision is written even when the card is already paused (S8 R1).
    const again = await pauses().pauseAutoCredit(card.id, 'again', ACTOR);
    track('adminAction', again.auditId);
    expect(again.applied).toBe(true);
    expect(again.auditId).not.toBe(pause.auditId);
    const row = await e2e.db().auditLog.findUniqueOrThrow({ where: { id: again.auditId ?? '' } });
    expect(row).toMatchObject({ action: 'CARD_PAUSE', after: { alreadyPaused: true } });
    expect((await e2e.create(await e2e.newUser())).status).toBe(503);
    const resume = await pauses().resumeAutoCredit(card.id, 'checked', ACTOR);
    track('adminAction', resume.auditId);
    expect((await pauses().resumeAutoCredit(card.id, 'again', ACTOR)).applied).toBe(false);
    expect((await e2e.create(await e2e.newUser())).status).toBe(201);
  });

  it('alertQueued is false when the owner alert could not be queued (the change still stands)', async () => {
    const card = await e2e.card();
    const raise = jest.spyOn(e2e.app().get(PaymentsAlerts), 'raise').mockResolvedValueOnce(null);
    try {
      const pause = await pauses().pauseAutoCredit(card.id, 'new device login', ACTOR);
      expect(pause).toMatchObject({ applied: true, alertQueued: false });
      const row = await e2e.db().topupCard.findUniqueOrThrow({ where: { id: card.id } });
      expect(row.autoCreditPaused).toBe(true);
    } finally {
      raise.mockRestore();
    }
  });
});
