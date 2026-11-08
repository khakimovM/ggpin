import { notifyJobId } from '@repo/shared';
import { LATE_STORED_AFTER_MS } from '../match-rules';
import { useMatcherE2e } from './matcher-e2e.harness';
import {
  MINUTE,
  createCard,
  createIntent,
  createUser,
  insertMessage,
  uniqueAmount,
} from './matcher-e2e.fixtures';

// D-47 (S9-M1, owner decision b) on the real ggpin_test DB: a CREDIT stored late (found by the
// re-scan, or the listener catching up after an outage) for a request that was not open when the
// row was stored (not PENDING, or PENDING past expiresAt) is never credited automatically: a
// review AMBIGUOUS / LATE_STORED and an owner alert.
// "Late" is read from the row (createdAt - tgDate), so a re-queued job decides the same way.
const t = useMatcherE2e();

const SENT = () => new Date(Date.now() - 15 * MINUTE);

interface Scenario {
  readonly status: 'PENDING' | 'EXPIRED';
  /** Default: EXPIRED 50 min (expired 20 min ago, inside grace), PENDING 20 min (10 min left). */
  readonly createdMinAgo?: number;
  /** When the row was stored after Telegram's date; default: now (15 min, late). */
  readonly storedAfterMs?: number;
  readonly title?: string;
}

/** A user, a card, one request for the amount and the CREDIT that pays it, sent 15 min ago. */
async function scenario(o: Scenario) {
  const user = await createUser(t.db);
  const card = await createCard(t.db);
  const amountTiyin = uniqueAmount();
  const tgDate = SENT();
  const minutes = o.createdMinAgo ?? (o.status === 'EXPIRED' ? 50 : 20);
  const createdAt = new Date(Date.now() - minutes * MINUTE);
  const intent = await createIntent(t.db, user.id, card.id, {
    amountTiyin,
    status: o.status,
    createdAt,
  });
  const stored = o.storedAfterMs;
  const message = await insertMessage(t.db, {
    card,
    amountTiyin,
    balanceAfterTiyin: 30_000_000n,
    tgDate,
    ...(stored === undefined ? {} : { storedAt: new Date(tgDate.getTime() + stored) }),
    ...(o.title === undefined ? {} : { title: o.title }),
  });
  return { user, card, intent, message };
}

describe('matcher: a late-stored CREDIT (D-47)', () => {
  it('stored late for an EXPIRED request: review LATE_STORED with the request, no money, alert', async () => {
    // storedAt = now (default): 15 min after Telegram's date, past the 10 min bound.
    const { user, card, intent, message } = await scenario({ status: 'EXPIRED' });
    expect(message.createdAt.getTime() - message.tgDate.getTime()).toBeGreaterThan(
      LATE_STORED_AFTER_MS,
    );
    await expect(t.a.matcher.process(message.id, false)).resolves.toBe('PROCESSED');
    const outcome = await t.outcome(message.id);
    expect(outcome).toMatchObject({ outcome: 'REVIEW', payment: null });
    expect(outcome?.review).toMatchObject({
      kind: 'AMBIGUOUS',
      note: 'LATE_STORED',
      intentId: intent.id,
      cardId: card.id,
      status: 'OPEN',
    });
    expect(await t.ledger(user.id)).toHaveLength(0);
    const after = await t.db.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } });
    expect(after.status).toBe('EXPIRED');
    const refId = outcome?.review?.id ?? '';
    const job = await t.notifyJob(notifyJobId({ kind: 'OWNER_ALERT', alert: 'lateStored', refId }));
    expect(job?.data).toEqual({ kind: 'OWNER_ALERT', alert: 'lateStored', refId });
  });

  it('the same message stored on time (5 s after its date) is credited automatically', async () => {
    const { user, intent, message } = await scenario({ status: 'EXPIRED', storedAfterMs: 5_000 });
    await t.a.matcher.process(message.id, false);
    expect((await t.outcome(message.id))?.outcome).toBe('CREDITED');
    expect(await t.ledger(user.id)).toHaveLength(1);
    const paid = await t.db.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } });
    expect(paid.status).toBe('PAID');
  });

  it('exactly at the bound is still on time; one millisecond more is late', async () => {
    const onBound = await scenario({ status: 'EXPIRED', storedAfterMs: LATE_STORED_AFTER_MS });
    await t.a.matcher.process(onBound.message.id, false);
    expect((await t.outcome(onBound.message.id))?.outcome).toBe('CREDITED');
    const past = await scenario({ status: 'EXPIRED', storedAfterMs: LATE_STORED_AFTER_MS + 1 });
    await t.a.matcher.process(past.message.id, false);
    expect((await t.outcome(past.message.id))?.review?.note).toBe('LATE_STORED');
  });

  it('stored late for a PENDING request still open when stored: credited', async () => {
    // The user is still waiting on an open request, so nobody has credited it by hand: the
    // reason for D-47 does not apply, and holding the money would only delay an honest payment.
    const { user, intent, message } = await scenario({ status: 'PENDING' });
    await t.a.matcher.process(message.id, false);
    expect((await t.outcome(message.id))?.outcome).toBe('CREDITED');
    expect(await t.ledger(user.id)).toHaveLength(1);
    const paid = await t.db.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } });
    expect(paid.status).toBe('PAID');
  });

  it('B1: stored late for a request still PENDING but past expiresAt (no sweep yet): review', async () => {
    // The sweep runs in the same worker: right after an outage the overdue request still says
    // PENDING. It was not open when the row was stored, so the owner decides (D-47).
    const { user, intent, message } = await scenario({ status: 'PENDING', createdMinAgo: 50 });
    expect(intent.expiresAt.getTime()).toBeLessThanOrEqual(message.createdAt.getTime());
    await t.a.matcher.process(message.id, false);
    const outcome = await t.outcome(message.id);
    expect(outcome?.review).toMatchObject({
      kind: 'AMBIGUOUS',
      note: 'LATE_STORED',
      intentId: intent.id,
    });
    expect(await t.ledger(user.id)).toHaveLength(0);
    const after = await t.db.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } });
    expect(after.status).toBe('PENDING');
  });

  it('B3: a late message with an unknown title keeps its own anomaly note (TITLE_UNKNOWN)', async () => {
    const { user, message } = await scenario({ status: 'EXPIRED', title: 'Uvedomlenie TEST' });
    await t.a.matcher.process(message.id, false);
    expect((await t.outcome(message.id))?.review).toMatchObject({
      kind: 'UNRECOGNIZED',
      note: 'TITLE_UNKNOWN',
    });
    expect(await t.ledger(user.id)).toHaveLength(0);
  });

  it('a replay (the re-queued job, a second worker) opens no second review and moves no money', async () => {
    const { user, message } = await scenario({ status: 'EXPIRED' });
    await t.a.matcher.process(message.id, false);
    await expect(t.a.matcher.process(message.id, false)).resolves.toBe('ALREADY_PROCESSED');
    await expect(t.b.matcher.process(message.id, true)).resolves.toBe('ALREADY_PROCESSED');
    expect(await t.db.paymentReview.count({ where: { bankMessageId: message.id } })).toBe(1);
    expect(await t.db.bankMessageOutcome.count({ where: { bankMessageId: message.id } })).toBe(1);
    expect(await t.ledger(user.id)).toHaveLength(0);
  });
});
