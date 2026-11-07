import { buildTestEnv } from '../../../config/__tests__/test-env';
import type { NotifySourcesRepository } from '../notify-sources.repository';
import { AlertSourceMissingError, OwnerAlertRenderer } from '../owner-alert.renderer';

// Only the reads these cases use; awaited like the Prisma promises they stand for.
interface Sources {
  review: () => Promise<unknown>;
  heartbeat: () => Promise<string | null>;
  payment: () => Promise<unknown>;
  message: () => Promise<unknown>;
  card: () => Promise<unknown>;
}

const NOW = new Date('2030-01-01T09:00:00.000Z');

function renderer(sources: Partial<Sources>): OwnerAlertRenderer {
  const fake: Sources = {
    review: () => Promise.resolve(null),
    heartbeat: () => Promise.resolve(null),
    payment: () => Promise.resolve(null),
    message: () => Promise.resolve(null),
    card: () => Promise.resolve(null),
    ...sources,
  };
  return new OwnerAlertRenderer(fake as unknown as NotifySourcesRepository, buildTestEnv(), {
    now: () => NOW,
  });
}

function review(rejectReason: string | null, note: string | null = null) {
  return {
    id: 'rev1',
    note,
    card: null,
    bankMessage: { amountTiyin: 5_000_100n, rejectReason, last4: '1234' },
  };
}

describe('OwnerAlertRenderer', () => {
  it('HTML-escapes every parameter (bot messages are parse_mode HTML)', async () => {
    const r = renderer({ review: () => Promise.resolve(review('<b>&x</b>')) });
    await expect(r.render('rejected', 'rev1')).resolves.toBe(
      '🚫 Bank xabari rad etildi (&lt;b&gt;&amp;x&lt;/b&gt;). Ko‘rib chiqish: rev1',
    );
  });

  it('dailyLimit names which cap (from the review note) and its amount from config', async () => {
    const r = renderer({
      review: () => Promise.resolve(review(null, 'NEW_ACCOUNT_DAILY_LIMIT')),
    });
    const text = (await r.render('dailyLimit', 'rev1')).replace(/[\u00a0\u202f]/g, ' ');
    expect(text).toContain('(yangi akkaunt: kuniga 500 000 so‘m)');
  });

  it('titleUnknown names the review, the card (bank, last4) and the amount', async () => {
    const r = renderer({
      review: () =>
        Promise.resolve({
          ...review(null, 'TITLE_UNKNOWN'),
          card: { bank: 'HUMO', last4: '4321' },
        }),
    });
    const text = (await r.render('titleUnknown', 'rev1')).replace(/[\u00a0\u202f]/g, ' ');
    expect(text).toContain('HUMO kartasi ***4321');
    expect(text).toContain('50 001 so‘m');
    expect(text).toContain('Ko‘rib chiqish: rev1');
    // Without the card the text cannot be complete: never a half-filled alert.
    await expect(
      renderer({ review: () => Promise.resolve(review(null, 'TITLE_UNKNOWN')) }).render(
        'titleUnknown',
        'rev1',
      ),
    ).rejects.toBeInstanceOf(AlertSourceMissingError);
  });

  /** A review of a message on a HUMO card ***4321 with the given note. */
  function onCard(note: string) {
    return renderer({
      review: () =>
        Promise.resolve({ ...review(null, note), card: { bank: 'HUMO', last4: '4321' } }),
    });
  }

  it.each(['SENDER_MISMATCH', 'TEXT_HASH_MISMATCH'])(
    'integrityAnomaly (%s) is a security alert: the check, the card, auto-credit stopped, the bot id',
    async (note) => {
      const text = await onCard(note).render('integrityAnomaly', 'rev1');
      expect(text).toContain(`XAVFSIZLIK (${note})`);
      expect(text).toContain('HUMO kartasi ***4321');
      expect(text).toContain('avtomatik yozish to‘xtatildi');
      expect(text).toContain('BANK_FEED_*_BOT_ID');
      expect(text).toContain('Ko‘rib chiqish: rev1');
    },
  );

  it('processingFailed names the card and says auto-credit stopped', async () => {
    const text = await onCard('PROCESSING_FAILED').render('processingFailed', 'rev1');
    expect(text).toContain('HUMO kartasi ***4321');
    expect(text).toContain('avtomatik yozish to‘xtatildi');
    expect(text).toContain('Ko‘rib chiqish: rev1');
  });

  it('amountReallocated says the amount was already given to another request', async () => {
    const text = (await onCard('AMOUNT_REALLOCATED').render('amountReallocated', 'rev1')).replace(
      /[\u00a0\u202f]/g,
      ' ',
    );
    expect(text).toContain('50 001 so‘m');
    expect(text).toContain('summa allaqachon boshqa so‘rovga berilgan');
    expect(text).toContain('HUMO kartasi ***4321');
  });

  it('the card alerts of a review are never half-filled: no card, no text', async () => {
    for (const alert of ['integrityAnomaly', 'processingFailed', 'amountReallocated'] as const) {
      await expect(
        renderer({ review: () => Promise.resolve(review(null, 'X')) }).render(alert, 'rev1'),
      ).rejects.toBeInstanceOf(AlertSourceMissingError);
    }
  });

  it('limitCheckFailed names the card of the message and the message id', async () => {
    const r = renderer({
      message: () => Promise.resolve({ id: 'msg1', amountTiyin: 1n, last4: '4321', cardId: 'c1' }),
      card: () => Promise.resolve({ id: 'c1', bank: 'UZCARD', last4: '4321' }),
    });
    const text = await r.render('limitCheckFailed', 'msg1');
    expect(text).toContain('UZCARD kartasi ***4321 limitini tekshirib bo‘lmadi');
    expect(text).toContain('Xabar: msg1');
    await expect(renderer({}).render('limitCheckFailed', 'gone')).rejects.toBeInstanceOf(
      AlertSourceMissingError,
    );
  });

  it('messageStuck needs nothing from the database (the write itself may be what failed)', async () => {
    await expect(renderer({}).render('messageStuck', 'msg1')).resolves.toContain(
      'Bank xabari msg1 barcha urinishlarda',
    );
  });

  it('a missing source row is AlertSourceMissingError (never a half-filled text)', async () => {
    await expect(renderer({}).render('noMatch', 'gone')).rejects.toBeInstanceOf(
      AlertSourceMissingError,
    );
    await expect(renderer({}).render('lateOverLimit', 'gone')).rejects.toBeInstanceOf(
      AlertSourceMissingError,
    );
  });

  it('listenerDown counts minutes since the heartbeat, "?" without one', async () => {
    const tenMinAgo = String(NOW.getTime() - 10 * 60_000);
    await expect(
      renderer({ heartbeat: () => Promise.resolve(tenMinAgo) }).render('listenerDown', 'x1'),
    ).resolves.toContain('10 daqiqadan');
    await expect(renderer({}).render('listenerDown', 'x1')).resolves.toContain('? daqiqadan');
  });

  it('walletFrozen takes the user id from the composite refId', async () => {
    await expect(renderer({}).render('walletFrozen', 'user1_entry1')).resolves.toContain(
      'Foydalanuvchi user1 hamyoni',
    );
    await expect(renderer({}).render('walletFrozen', 'no-underscore')).rejects.toBeInstanceOf(
      AlertSourceMissingError,
    );
  });
});
