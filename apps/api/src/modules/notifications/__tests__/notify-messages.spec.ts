import { BANK_FEED_ALERT_PARAMS, tgOutboxJobSchema, type TgOutboxJob } from '@repo/shared';
import { translate } from '../../../common/i18n/translate';
import { buildTestEnv } from '../../../config/__tests__/test-env';
import type { NotifySourcesRepository } from '../notify-sources.repository';
import { NotifyConsumer } from '../notify.consumer';
import type { OwnerAlertRenderer } from '../owner-alert.renderer';
import type { TgOutboxEnqueuer } from '../tg-outbox.enqueuer';

// Synthetic values only (no real card, user or amount). Top-up amounts go through moneyText as in
// production and are NFKC-normalised (`norm`) so the snapshot does not depend on Intl spaces;
// alert parameters are plain synthetic strings.
const MINI_APP = 'https://app.ggpin.test/tg';

function setup(locale: 'uz' | 'ru', miniAppUrl: string | undefined) {
  const sent: { id: string; job: TgOutboxJob }[] = [];
  const sources = {
    payment: () =>
      Promise.resolve({
        id: 'pay1',
        userId: 'u1',
        amountTiyin: 5_000_000n,
        status: 'CONFIRMED',
        user: { telegramId: 777n, locale, botBlockedAt: null },
        bankMessage: null,
      }),
    balance: () => Promise.resolve(15_000_000n),
  } as unknown as NotifySourcesRepository;
  const outbox = {
    enqueue: (id: string, job: TgOutboxJob) => {
      sent.push({ id, job: tgOutboxJobSchema.parse(job) });
      return Promise.resolve();
    },
  } as unknown as TgOutboxEnqueuer;
  const config = buildTestEnv(miniAppUrl === undefined ? {} : { MINI_APP_URL: miniAppUrl });
  const consumer = new NotifyConsumer(sources, {} as OwnerAlertRenderer, outbox, config);
  return { consumer, sent };
}

const norm = (job: TgOutboxJob | undefined): unknown =>
  // NFKC folds the no-break / narrow no-break spaces of formatMoney into plain spaces.
  job === undefined ? undefined : { ...job, text: job.text.normalize('NFKC') };

describe('TOPUP_CREDITED / TOPUP_LATE_CREDITED messages', () => {
  it.each([
    ['uz', 'TOPUP_CREDITED'],
    ['ru', 'TOPUP_CREDITED'],
    ['uz', 'TOPUP_LATE_CREDITED'],
    ['ru', 'TOPUP_LATE_CREDITED'],
  ] as const)('%s %s with the Mini App button', async (locale, kind) => {
    const { consumer, sent } = setup(locale, MINI_APP);
    await expect(consumer.handle({ id: 'j1', data: { kind, refId: 'pay1' } })).resolves.toBe(
      'queued',
    );
    expect(sent[0]?.id).toBe('topup-pay1');
    expect(norm(sent[0]?.job)).toMatchSnapshot();
  });

  it.each(['uz', 'ru'] as const)('%s without MINI_APP_URL has no button', async (locale) => {
    const { consumer, sent } = setup(locale, undefined);
    await consumer.handle({ id: 'j1', data: { kind: 'TOPUP_CREDITED', refId: 'pay1' } });
    expect(sent[0]?.job.replyMarkup).toBeUndefined();
    expect(norm(sent[0]?.job)).toMatchSnapshot();
  });

  it('keeps the query of MINI_APP_URL and a trailing slash out of the button url', async () => {
    const { consumer, sent } = setup('uz', 'https://app.ggpin.test/tg/?x=1');
    await consumer.handle({ id: 'j1', data: { kind: 'TOPUP_CREDITED', refId: 'pay1' } });
    expect(sent[0]?.job.replyMarkup).toEqual({
      inline_keyboard: [
        [
          {
            text: '➕ Hisobni to‘ldirish',
            web_app: { url: 'https://app.ggpin.test/tg/topup?x=1' },
          },
        ],
      ],
    });
  });

  it('sends no button for a non-https MINI_APP_URL', async () => {
    const { consumer, sent } = setup('uz', 'http://localhost:3000/tg');
    await consumer.handle({ id: 'j1', data: { kind: 'TOPUP_CREDITED', refId: 'pay1' } });
    expect(sent[0]?.job.replyMarkup).toBeUndefined();
  });
});

describe('owner alert templates (uz) with synthetic parameters', () => {
  const SYNTHETIC: Record<string, string | number> = {
    reviewId: 'rev1',
    bank: 'HUMO',
    last4: '1234',
    amount: '50 000 so‘m',
    reason: 'SENDER_MISMATCH',
    messageId: 'msg1',
    percent: 85,
    hours: 6,
    minutes: 12,
    userId: 'usr1',
    action: 'REFUND',
    ref: 'aud1',
    day: '20301231',
    count: 3,
    debits: 1,
    openReviews: 0,
    history: 'ok',
    details: '-',
    limit: 'kuniga 5 000 000 so‘m',
  };
  const value = (name: string): string | number => SYNTHETIC[name] ?? `<${name}>`;

  it('renders every declared alert', () => {
    const out: Record<string, string> = {};
    for (const [alert, names] of Object.entries(BANK_FEED_ALERT_PARAMS)) {
      const params = Object.fromEntries(names.map((n) => [n, value(n)]));
      out[alert] = translate('uz', `alerts.bankFeed.${alert}`, params);
    }
    expect(out).toMatchSnapshot();
  });

  it('HTML-escapes bank and user supplied parameters in every alert', () => {
    const hostile = '<b>&<script>alert(1)</script>';
    for (const [alert, names] of Object.entries(BANK_FEED_ALERT_PARAMS)) {
      const params = Object.fromEntries(names.map((n) => [n, hostile]));
      const text = translate('uz', `alerts.bankFeed.${alert}`, params);
      expect(text).not.toContain('<script>');
      expect(text).not.toContain('<b>&');
      if (names.length > 0) expect(text).toContain('&lt;script&gt;');
    }
  });
});

describe('topup message escaping', () => {
  it('escapes a hostile amount/balance parameter', () => {
    const text = translate('ru', 'bot.wallet.topupCredited', {
      amount: '<b>&1',
      balance: '<script>',
    });
    expect(text).toContain('&lt;b&gt;&amp;1');
    expect(text).toContain('&lt;script&gt;');
    expect(text).not.toContain('<script>');
  });
});
