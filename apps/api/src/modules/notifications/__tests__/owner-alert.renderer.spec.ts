import type { BankFeedAlertKind } from '@repo/shared';
import { AlertSourceMissingError } from '../owner-alert.renderer';
import { renderer } from './owner-alert.test-renderer';

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

  it('lateStored (D-47) says the message was stored late and asks to check a hand credit', async () => {
    const text = (await onCard('LATE_STORED').render('lateStored', 'rev1')).replace(
      /[\u00a0\u202f]/g,
      ' ',
    );
    expect(text).toContain('HUMO kartasi ***4321');
    expect(text).toContain('50 001 so‘m');
    expect(text).toContain('kech saqlandi');
    expect(text).toContain('qo‘lda bermaganingizni');
    expect(text).toContain('Ko‘rib chiqish: rev1');
  });

  it('manualCreditSeen (R1) says a hand credit came after the request, ids and amount only', async () => {
    const text = (await onCard('MANUAL_CREDIT_SEEN').render('manualCreditSeen', 'rev1')).replace(
      /[\u00a0\u202f]/g,
      ' ',
    );
    expect(text).toContain('HUMO kartasi ***4321');
    expect(text).toContain('50 001 so‘m');
    expect(text).toContain('bu so‘rovdan keyin qo‘lda pul berilgan');
    expect(text).toContain('Ikki marta yozmaslik uchun tekshiring');
    expect(text).toContain('Ko‘rib chiqish: rev1');
  });

  it('the card alerts of a review are never half-filled: no card, no text', async () => {
    const cardAlerts: readonly BankFeedAlertKind[] = [
      'integrityAnomaly',
      'processingFailed',
      'amountReallocated',
      'lateStored',
      'manualCreditSeen',
    ];
    for (const alert of cardAlerts) {
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
    // F-L1: the re-run may credit it first, so the owner checks the last top-up before paying.
    await expect(renderer({}).render('messageStuck', 'msg1')).resolves.toContain(
      'Qo‘lda berishdan oldin foydalanuvchining oxirgi to‘ldirishini tekshiring',
    );
  });

  it('S9F-I1: effectsFailed (decision stored, effects failed) never promises an automatic re-run', async () => {
    const text = await renderer({}).render('effectsFailed', 'msg2');
    expect(text).toContain('Bank xabari msg2 bo‘yicha qaror saqlangan');
    expect(text).toContain('avtomatik qayta ishlanmaydi');
    expect(text).not.toContain('avtomatik qayta ishlanadi');
    expect(text).toContain('review:list va foydalanuvchining oxirgi to‘ldirishini tekshiring');
    expect(text).toContain('bildirishnoma');
    expect(text).not.toMatch(/\d{4}\s?\d{4}|so‘m|UZS/); // ids only: no card number, no money
  });

  it('a missing source row is AlertSourceMissingError (never a half-filled text)', async () => {
    await expect(renderer({}).render('noMatch', 'gone')).rejects.toBeInstanceOf(
      AlertSourceMissingError,
    );
    await expect(renderer({}).render('lateOverLimit', 'gone')).rejects.toBeInstanceOf(
      AlertSourceMissingError,
    );
  });

  it('walletFrozen takes the user id from the composite refId', async () => {
    await expect(renderer({}).render('walletFrozen', 'user1_entry1')).resolves.toContain(
      'Foydalanuvchi user1 hamyoni',
    );
    await expect(renderer({}).render('walletFrozen', 'no-underscore')).rejects.toBeInstanceOf(
      AlertSourceMissingError,
    );
  });

  describe('reconcileOk / reconcileMismatch (the latest audit row of the day, docs/05 §10)', () => {
    const run = (after: unknown) => renderer({ reconcileRun: () => Promise.resolve({ after }) });
    const clean = {
      count: 12,
      debits: 3,
      openReviews: 1,
      historyScan: 'ok',
      mismatches: { recovered: 0, chainBreak: 0 },
    };

    it('reconcileOk: counts and the history state, nothing else', async () => {
      await expect(run(clean).render('reconcileOk', '20300504')).resolves.toBe(
        '✅ Kunlik solishtirishda farq yo‘q. Tekshirilgan xabarlar: 12. Chiqimlar: 3. ' +
          'Ochiq ko‘rib chiqishlar: 1. Tarix qayta skani: bajarildi.',
      );
    });

    it('reconcileMismatch: the non-zero codes in their fixed order, and an unread history', async () => {
      const after = {
        ...clean,
        count: 3,
        historyScan: 'unavailable',
        mismatches: { lateOverLimit: 1, recovered: 2, chainBreak: 0 },
      };
      const text = await run(after).render('reconcileMismatch', '20300504');
      expect(text).toContain('Farqlar soni: 3 (recovered=2, lateOverLimit=1)');
      expect(text).toContain(
        'bajarilmadi, bank xabarlari mijozi yoki bot id sozlanmagan yoki bu worker hozir lider emas',
      );
      const none = await run({ ...clean, historyScan: 'failed' }).render('reconcileMismatch', 'd');
      expect(none).toContain('Farqlar soni: 12 (-)');
      expect(none).toContain('xato bilan tugadi');
    });

    it('L-1 / I-1 / m1: source reasons and an old open review in the details; unknown code is ?', async () => {
      const history = {
        HUMO_BOT: { state: 'failed', reason: 'FOREIGN_CHAT' },
        UZCARD_BOT: { state: 'failed', reason: 'x; DROP' }, // a newer worker: still sent
      };
      const after = {
        ...clean,
        historyScan: 'failed',
        history,
        mismatches: { reviewOpenOver24h: 1 },
      };
      const text = await run(after).render('reconcileMismatch', '20300504');
      expect(text).toContain('(reviewOpenOver24h=1, HUMO_BOT=FOREIGN_CHAT, UZCARD_BOT=?)');
      expect(text).not.toContain('DROP');
    });

    it.each([
      ['no row', null],
      ['a fractional count', { ...clean, count: 1.5 }],
      ['an unknown history state', { ...clean, historyScan: 'maybe' }],
      ['a non-numeric mismatch', { ...clean, mismatches: { recovered: '1; DROP' } }],
      ['no mismatches object', { ...clean, mismatches: undefined }],
    ])('%s is AlertSourceMissingError (never a half-filled text)', async (_name, after) => {
      const r = after === null ? renderer({}) : run(after);
      await expect(r.render('reconcileOk', '20300504')).rejects.toBeInstanceOf(
        AlertSourceMissingError,
      );
    });

    it('reconcileFailed names the day and reads nothing from the database', async () => {
      const reconcileRun = jest.fn(() => Promise.resolve(null));
      const r = renderer({ reconcileRun });
      await expect(r.render('reconcileFailed', '20300504')).resolves.toBe(
        '⛔ 20300504 kungi solishtirish barcha urinishlarda xato bilan tugadi: farqlar ' +
          'tekshirilmadi. Worker loglarini ko‘ring; ertangi solishtirish yana oxirgi 48 soatni ' +
          'qamraydi.',
      );
      expect(reconcileRun).not.toHaveBeenCalled();
      await expect(r.render('reconcileFailed', '2030-05-04')).rejects.toBeInstanceOf(
        AlertSourceMissingError,
      );
    });
  });
});
