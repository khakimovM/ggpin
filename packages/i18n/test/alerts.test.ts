import { ALERT_KINDS, BANK_FEED_ALERT_PARAMS, TOPUP_LIMIT_REASONS } from '@repo/shared';
import { describe, expect, it } from 'vitest';
import ru from '../ru.json';
import uz from '../uz.json';

// Same extraction as catalogs.test.ts: `{name}` placeholders only (the bot cannot render ICU).
function placeholders(message: string): string[] {
  return [
    ...new Set([...message.matchAll(/\{(\w+)\}/g)].flatMap((m) => (m[1] ? [m[1]] : []))),
  ].sort();
}

const CATALOGS = [
  ['uz', uz],
  ['ru', ru],
] as const;

describe('owner alert texts (alerts.bankFeed.*)', () => {
  it.each(CATALOGS)('%s has exactly the alert kinds the pipeline can raise', (_locale, catalog) => {
    expect(Object.keys(catalog.alerts.bankFeed).sort()).toEqual([...ALERT_KINDS].sort());
  });

  it.each(CATALOGS)('%s texts take exactly the declared placeholders', (locale, catalog) => {
    const texts: Record<string, string> = catalog.alerts.bankFeed;
    for (const kind of ALERT_KINDS) {
      expect(placeholders(texts[kind] ?? ''), `${locale}:${kind}`).toEqual(
        [...BANK_FEED_ALERT_PARAMS[kind]].sort(),
      );
    }
  });

  it.each(CATALOGS)(
    '%s alerts use no ICU plural/select (the bot renders {name} only)',
    (_l, catalog) => {
      const all = [...Object.values(catalog.alerts.bankFeed), ...Object.values(catalog.alerts.bot)];
      for (const text of all) expect(text).not.toMatch(/\{\s*\w+\s*,/);
      // the two bot-lifecycle alerts take the attempt number and nothing else
      for (const text of Object.values(catalog.alerts.bot)) {
        expect(placeholders(text)).toEqual(['attempt']);
      }
    },
  );

  it.each(CATALOGS)('%s never prints a whole card number or message text', (_l, catalog) => {
    for (const text of Object.values(catalog.alerts.bankFeed)) {
      expect(text).not.toMatch(/\{(pan|number|cardNumber|text|balance|phone)\}/);
    }
  });
});

describe('wallet notifications (bot.wallet.*)', () => {
  it.each(CATALOGS)('%s credit texts take {amount} and {balance}', (_l, catalog) => {
    for (const key of ['topupCredited', 'topupLateCredited'] as const) {
      expect(placeholders(catalog.bot.wallet[key])).toEqual(['amount', 'balance']);
    }
    expect(placeholders(catalog.bot.wallet.topupButton)).toEqual([]);
    expect(placeholders(catalog.bot.wallet.openTopup)).toEqual([]);
  });

  it.each(CATALOGS)('%s has texts for the new error codes', (_l, catalog) => {
    expect(catalog.errors.TOPUP_ALREADY_PENDING.trim()).not.toBe('');
    expect(catalog.errors.PAYMENT_METHOD_UNAVAILABLE.trim()).not.toBe('');
  });
});

describe('dailyLimit alert: {limit} is a readable label, not a raw code', () => {
  it.each(CATALOGS)('%s has one label per cap, each taking the cap amount', (_l, catalog) => {
    expect(Object.keys(catalog.alerts.limitReason).sort()).toEqual([...TOPUP_LIMIT_REASONS].sort());
    for (const reason of TOPUP_LIMIT_REASONS) {
      const text: string = catalog.alerts.limitReason[reason];
      expect(placeholders(text), reason).toEqual(['cap']);
      expect(text).not.toContain(reason); // the code itself is never what the owner reads
    }
    expect(BANK_FEED_ALERT_PARAMS.dailyLimit).toContain('limit');
  });
});
