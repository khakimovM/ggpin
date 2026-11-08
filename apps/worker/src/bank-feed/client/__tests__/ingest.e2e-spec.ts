import { alertRef, notifyJobId } from '@repo/shared';
import { useMatcherE2e } from '../../__tests__/matcher-e2e.harness';
import { MINUTE, SENDER_ID, createCard, uniqueAmount } from '../../__tests__/matcher-e2e.fixtures';
import { uzcardText } from '../../__tests__/synthetic-message';
import {
  bootReconcileWorker,
  type ReconcileWorker,
} from '../../../reconcile/__tests__/reconcile-e2e.harness';
import { PARSER_VERSION } from '../../parsers/parser-version';
import type { BankFeedMessage } from '../bank-feed-client';

// The ingest path on the real ggpin_test DB (S9 review n3 and S9-L2): a replay is recognised by
// the unique (senderId, tgMessageId) alone, the cursor never moves back, and a message from
// another sender keeps only its hash. Every stored row is then decided by the matcher, so none
// is left without an outcome in the shared DB.
const t = useMatcherE2e();
let w: ReconcileWorker;
const stored: string[] = [];

beforeAll(async () => {
  w = await bootReconcileWorker(t.env);
});

// useMatcherE2e's afterAll runs first (jest-circus: declaration order); this one only needs
// the worker's own queue and module.
afterAll(async () => {
  await w.removeBankMessageJobs(stored);
  await w.close();
});

/** A Telegram id with no stored row of the pinned sender (the shared DB keeps older runs). */
async function freeId(start: bigint): Promise<bigint> {
  let id = start;
  while ((await t.db.bankMessage.count({ where: { senderId: SENDER_ID, tgMessageId: id } })) > 0) {
    id += 1n;
  }
  return id;
}

function message(id: bigint, last4: string, over: Partial<BankFeedMessage> = {}): BankFeedMessage {
  const date = new Date(Date.now() - MINUTE);
  return {
    id,
    date,
    chatId: SENDER_ID,
    senderId: SENDER_ID,
    senderIsBot: true,
    text: uzcardText({
      direction: 'CREDIT',
      amountTiyin: uniqueAmount(),
      balanceAfterTiyin: 50_000_000n,
      last4,
      bankTxnAt: date,
    }),
    outgoing: false,
    forwarded: false,
    editDate: null,
    viaBotId: null,
    ...over,
  };
}

async function ingest(m: BankFeedMessage) {
  const result = await w.ingest.ingest('UZCARD_BOT', m);
  if (result.stored) {
    stored.push(result.bankMessageId);
    await t.a.matcher.process(result.bankMessageId, false);
  }
  return result;
}

const cursor = async () =>
  (await t.db.bankFeedCursor.findUniqueOrThrow({ where: { source: 'UZCARD_BOT' } })).lastMessageId;

describe('ingest (real Postgres + Redis)', () => {
  it('a replay of a stored message is stored:false; a lower id never moves the cursor back', async () => {
    const card = await createCard(t.db);
    const high = message(await freeId(BigInt(Date.now() + 30_000_000) * 1_000n), card.last4);
    await expect(ingest(high)).resolves.toMatchObject({ stored: true });
    await expect(ingest(high)).resolves.toEqual({ stored: false, reason: 'DUPLICATE' });
    const rows = await t.db.bankMessage.count({
      where: { senderId: SENDER_ID, tgMessageId: high.id },
    });
    expect(rows).toBe(1);
    const top = await cursor();
    expect(top >= high.id).toBe(true);

    // A message the re-scan finds below the cursor is stored, and the cursor stays where it was.
    const low = message(await freeId(high.id - 1_000_000_000n), card.last4);
    await expect(ingest(low)).resolves.toMatchObject({ stored: true });
    expect(await cursor()).toBe(top);
  });

  it('B2: a message of another chat is not stored, does not move the cursor, and alerts', async () => {
    const card = await createCard(t.db);
    const top = await cursor();
    // The pinned bot itself, in another chat, with an id far above this chat's numbering.
    const foreign = message(top + 10_000_000_000n, card.last4, { chatId: SENDER_ID + 99n });
    const at = new Date();
    await expect(w.ingest.ingest('UZCARD_BOT', foreign, at)).resolves.toEqual({
      stored: false,
      reason: 'FOREIGN_CHAT',
    });
    const rows = await t.db.bankMessage.count({
      where: { senderId: SENDER_ID, tgMessageId: foreign.id },
    });
    expect(rows).toBe(0);
    expect(await cursor()).toBe(top);
    const refId = alertRef.foreignChat('UZCARD_BOT', at);
    const job = await t.notifyJob(
      notifyJobId({ kind: 'OWNER_ALERT', alert: 'foreignChat', refId }),
    );
    expect(job?.data).toEqual({ kind: 'OWNER_ALERT', alert: 'foreignChat', refId });
  });

  it('B2: an older FOREIGN_CHAT row is neither the re-scan start point nor a "known" id', async () => {
    const since = new Date(Date.now() - 48 * 60 * MINUTE);
    const start = await w.repo.lastIdBefore('UZCARD_BOT', since);
    const id = await freeId((start ?? 0n) + 20_000_000_000n);
    // A row as the ingest stored it before B2 (synthetic, no text), dated before the window.
    const row = await t.db.bankMessage.create({
      data: {
        source: 'UZCARD_BOT',
        senderId: SENDER_ID,
        tgMessageId: id,
        tgDate: new Date(since.getTime() - MINUTE),
        textSha256: '0'.repeat(64),
        parseStatus: 'REJECTED',
        rejectReason: 'FOREIGN_CHAT',
        parserVersion: PARSER_VERSION,
      },
    });
    // Decided like any REJECTED row, so it is not left without an outcome in the shared DB.
    await t.a.matcher.process(row.id, false);
    expect(await w.repo.lastIdBefore('UZCARD_BOT', since)).toBe(start);
    expect((await w.repo.knownIds('UZCARD_BOT', [id])).has(id)).toBe(false);
  });

  it('another sender in the chat: stored REJECTED FOREIGN_SENDER with its hash, without the text', async () => {
    const card = await createCard(t.db);
    const foreign = message(await freeId(BigInt(Date.now() + 31_000_000) * 1_000n), card.last4, {
      senderId: SENDER_ID + 7n,
    });
    const result = await ingest(foreign);
    expect(result.stored).toBe(true);
    const row = await t.db.bankMessage.findFirstOrThrow({
      where: { senderId: foreign.senderId, tgMessageId: foreign.id },
      include: { rawText: true },
    });
    expect(row).toMatchObject({
      parseStatus: 'REJECTED',
      rejectReason: 'FOREIGN_SENDER',
      cardId: null,
      rawText: null,
    });
    expect(row.textSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await t.outcome(row.id)).toMatchObject({ outcome: 'REVIEW', payment: null });
    // Its "rejected" owner alert: read through notifyJob, so the harness removes it.
    const review = await t.db.paymentReview.findFirstOrThrow({ where: { bankMessageId: row.id } });
    const jobId = notifyJobId({ kind: 'OWNER_ALERT', alert: 'rejected', refId: review.id });
    expect(await t.notifyJob(jobId)).toBeDefined();
  });
});
