import ru from '@repo/i18n/ru.json';
import uz from '@repo/i18n/uz.json';
import {
  FULFILLMENT_ALERT_KINDS,
  FULFILLMENT_ALERT_PARAMS,
  type FulfillmentAlertKind,
} from '@repo/shared';
import { FulfillmentAlertRenderer } from '../fulfillment-alert.renderer';
import { fakeSources, orderRow, type FakeSources } from './order-notify.test-fixtures';

// Synthetic rows only: a made-up wallet address and transfer, the order fixture of the order spec.
const NOW = new Date('2030-01-01T09:00:00.000Z');
const TO_HEX = 'f'.repeat(8) + '0123456789abcdef'.repeat(3) + 'deadbeef';
const WALLET_HEX = 'a'.repeat(8) + '0123456789abcdef'.repeat(3) + 'cafebabe';
const TRANSFER = {
  id: 'cmtransfer1',
  seqno: 42,
  amountNanoTon: 1_500_000_000n,
  toAddress: `0:${TO_HEX}`,
  attempt: { order: { id: 'cmorder1', number: 1042 } },
};
const SNAPSHOT = { id: 'cmsnap1', address: `0:${WALLET_HEX}`, nanoTon: 250_000_000n };

const REF: Readonly<Record<FulfillmentAlertKind, string>> = {
  needsReview: 'cmorder1',
  held: 'cmorder1_cmattempt1',
  heldExpiredRefunded: 'cmorder1',
  reviewResolved: 'cmorder1',
  fragmentSessionDead: 'h1',
  fragmentSessionRestored: 'h1',
  fragmentAdapterDown: 'h1',
  tonLowBalance: 'cmsnap1',
  tonDailyLimit: 'cmorder1_cmattempt1',
  tonSeqnoUnmatched: 'cmtransfer1',
  tonConsumedUnmatched: 'cmtransfer1',
  tonBounced: 'cmtransfer1',
  tonWalletBlocked: 'cmtransfer1',
  tonWalletCompromised: 'cmtransfer1',
  tonWitnessConflict: 'cmtransfer1',
  queueStuck: `cmorder1_${String(NOW.getTime() - 6 * 60_000)}`,
  workerDown: String(NOW.getTime() - 7 * 60_000),
};

function renderer(fake: FakeSources): FulfillmentAlertRenderer {
  return new FulfillmentAlertRenderer(fakeSources(fake), { now: () => NOW });
}

const full = renderer({
  order: () => Promise.resolve(orderRow({ status: 'HELD', statusReason: 'LIMIT_DAILY' })),
  orderRefund: () => Promise.resolve({ amountTiyin: 5_000_000n }),
  tonTransfer: () => Promise.resolve(TRANSFER),
  walletSnapshot: () => Promise.resolve(SNAPSHOT),
});

function placeholders(text: string): string[] {
  return [...new Set([...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? ''))].sort();
}

describe('fulfillment alert texts (alerts.fulfillment.*)', () => {
  it.each([
    ['uz', uz],
    ['ru', ru],
  ] as const)('%s: one text per alert kind, with exactly the declared placeholders', (_l, cat) => {
    const texts: Record<string, unknown> = cat.alerts.fulfillment;
    const kinds = Object.keys(texts).filter((k) => k !== 'heldReason');
    expect(kinds.sort()).toEqual([...FULFILLMENT_ALERT_KINDS].sort());
    for (const kind of FULFILLMENT_ALERT_KINDS) {
      const text = texts[kind];
      expect(typeof text).toBe('string');
      expect({ kind, names: placeholders(String(text)) }).toEqual({
        kind,
        names: [...FULFILLMENT_ALERT_PARAMS[kind]].sort(),
      });
      // The bot renders {name} only: no ICU plural/select in an alert.
      expect(String(text)).not.toMatch(/\{\s*\w+\s*,/);
    }
  });

  it('renders every kind (uz, synthetic rows)', async () => {
    const out: Record<string, string> = {};
    for (const kind of FULFILLMENT_ALERT_KINDS) {
      out[kind] = (await full.render(kind, REF[kind])).normalize('NFKC');
    }
    expect(out).toMatchSnapshot();
  });

  it('never prints a full wallet address, only the shortened form', async () => {
    for (const kind of FULFILLMENT_ALERT_KINDS) {
      const text = await full.render(kind, REF[kind]);
      expect(text).not.toContain(TO_HEX);
      expect(text).not.toContain(WALLET_HEX);
    }
    expect(await full.render('tonBounced', 'cmtransfer1')).toContain('0:ffff…beef');
    expect(await full.render('tonLowBalance', 'cmsnap1')).toContain('0:aaaa…babe');
  });

  it('HELD: a known reason is a label, the order id comes from the composite ref', async () => {
    const text = await full.render('held', 'cmorder1_cmattempt1');
    expect(text).toContain('kunlik TON limiti');
    expect(text).not.toContain('LIMIT_DAILY');
    expect(text).toContain('Buyurtma: cmorder1');
    expect(text).not.toContain('cmattempt1');
  });

  it('a product name from the catalog is HTML-escaped', async () => {
    const r = renderer({
      order: () =>
        Promise.resolve(orderRow({ product: { nameUz: '<b>X</b>', nameRu: '<b>X</b>' } })),
    });
    const text = await r.render('needsReview', 'cmorder1');
    expect(text).toContain('&lt;b&gt;X&lt;/b&gt;');
    expect(text).not.toContain('<b>');
  });

  it.each(FULFILLMENT_ALERT_KINDS)(
    '%s still renders when its row is gone (? in the gaps)',
    async (kind) => {
      const text = await renderer({}).render(kind, REF[kind]);
      expect(text).not.toMatch(/\{\w+\}/);
    },
  );

  it('heldExpiredRefunded: the amount is the REFUND entry; none found prints ? (review m3)', async () => {
    const refunded = await full.render('heldExpiredRefunded', 'cmorder1');
    expect(refunded.normalize('NFKC')).toContain('50 000 so‘m');
    const noEntry = renderer({ order: () => Promise.resolve(orderRow({ status: 'REFUNDED' })) });
    const text = await noEntry.render('heldExpiredRefunded', 'cmorder1');
    expect(text).not.toContain('so‘m');
    expect(text).toContain('?');
  });

  it('queueStuck: the order # from the job ref, the 5-minute promise from the constant', async () => {
    const text = await full.render('queueStuck', REF.queueStuck);
    expect(text).toContain('5 daqiqadan');
    expect(text).toContain('#1042');
    expect(text).toContain('Buyurtma: cmorder1');
    expect(text).not.toContain(String(NOW.getTime() - 6 * 60_000));
    expect(await renderer({}).render('queueStuck', 'job_1')).toContain('#?');
  });

  it('workerDown counts the minutes since the last sighting; a bad ref prints ?', async () => {
    expect(await full.render('workerDown', REF.workerDown)).toContain(' 7 daqiqadan');
    expect(await full.render('workerDown', 'bad')).toContain(' ? daqiqadan');
  });
});
