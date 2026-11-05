import { describe, expect, it } from 'vitest';
import { REDACTED, isSensitiveKey, scrubSecretsInText } from './index';

// Built, not spelled out: a 43-character base64url literal looks like a secret to scanners.
const TOKEN = `${'Tk'.repeat(21)}x`;
// Well-known Luhn-valid test numbers, not real cards.
const PAN = '4111111111111111';
const PAN_SPACED = '4111 1111 1111 1111';
const PAN_DASHED = '5555-5555-5555-4444';

describe('pay-link token in text', () => {
  it.each([
    ['fragment', `https://ggpin.example/pay/cm3intent1#t=${TOKEN}`],
    ['query', `https://ggpin.example/pay/cm3intent1?t=${TOKEN}`],
    ['second query parameter', `https://ggpin.example/pay/cm3intent1?x=1&t=${TOKEN}`],
  ])('hides the token in the %s form and keeps the rest', (_name, url) => {
    const out = scrubSecretsInText(`GET ${url} failed`);
    expect(out).not.toContain(TOKEN);
    expect(out).toContain(`t=${REDACTED}`);
    expect(out).toContain('/pay/cm3intent1');
  });

  it('leaves a short or unrelated t= value alone', () => {
    expect(scrubSecretsInText('?t=1')).toBe('?t=1');
    expect(scrubSecretsInText('format=txt')).toBe('format=txt');
  });
});

describe('card numbers in text', () => {
  it.each([PAN, PAN_SPACED, PAN_DASHED])('hides the Luhn-valid number %s', (pan) => {
    const out = scrubSecretsInText(`card ${pan} was used`);
    expect(out).toBe(`card ${REDACTED} was used`);
  });

  it('keeps a 16-digit number that fails the Luhn check (an id, an amount)', () => {
    expect(scrubSecretsInText('amount 4111111111111112 tiyin')).toContain('4111111111111112');
  });

  it('does not cut a longer digit run or a word-embedded number', () => {
    expect(scrubSecretsInText(`n=${PAN}0`)).toContain(`${PAN}0`);
    expect(scrubSecretsInText(`id${PAN}`)).toContain(`id${PAN}`);
    expect(scrubSecretsInText(`1.${PAN}`)).toContain(`1.${PAN}`);
  });

  it('stays fast on a long digit run', () => {
    const started = Date.now();
    scrubSecretsInText('1'.repeat(10_000));
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe('sensitive keys of phase 4', () => {
  it.each([
    'redirectUrl',
    'payUrl',
    'payLink',
    'pan',
    'PAN',
    'cardNumber',
    'card_number',
    'rawText',
    'raw-text',
  ])('redacts %s', (key) => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  it('does not hide harmless neighbours', () => {
    for (const key of ['panel', 'company', 'last4', 'bank', 'text']) {
      expect(isSensitiveKey(key), key).toBe(false);
    }
  });
});

describe('pay link with ?locale= (D-38 Q21)', () => {
  it('hides the fragment token and keeps the language', () => {
    for (const locale of ['uz', 'ru']) {
      const out = scrubSecretsInText(
        `GET https://ggpin.example/pay/cm3intent1?locale=${locale}#t=${TOKEN} 404`,
      );
      expect(out).not.toContain(TOKEN);
      expect(out).toContain(`?locale=${locale}#t=${REDACTED}`);
    }
  });

  it('a retired ?t= next to the locale is still hidden, the locale stays', () => {
    const out = scrubSecretsInText(`/pay/cm3intent1?locale=ru&t=${TOKEN}`);
    expect(out).not.toContain(TOKEN);
    expect(out).toContain(`?locale=ru&t=${REDACTED}`);
  });

  it('the locale value is not mistaken for a token', () => {
    expect(scrubSecretsInText('/pay/cm3intent1?locale=ru')).toBe('/pay/cm3intent1?locale=ru');
  });
});

describe('pay-link token, URL-encoded', () => {
  it.each(['%23t%3D', '%3Ft%3D', '%26t%3D', '%23T%3d', '%3ft%3d'])(
    'hides the token after %s inside another URL',
    (prefix) => {
      const out = scrubSecretsInText(
        `redirect=https%3A%2F%2Fggpin.example%2Fpay%2Fcm3intent1${prefix}${TOKEN}&x=1`,
      );
      expect(out).not.toContain(TOKEN);
      expect(out).toContain(REDACTED);
      expect(out).toContain('cm3intent1');
    },
  );
});

describe('card numbers: separators and our own ranges', () => {
  it.each([' ', ' ', ' ', ' ', '-'])('hides a number grouped with %j', (sep) => {
    const pan = `4111${sep}1111${sep}1111${sep}1111`;
    expect(scrubSecretsInText(`card ${pan} used`)).toBe(`card ${REDACTED} used`);
  });

  // Uzcard 8600, Humo 9860 and 5614: hidden even when the check digit is wrong, because a
  // mistyped or synthetic number from our own ranges is still card data in a log.
  it.each(['8600123456789012', '9860123456789012', '5614123456789012', '8600 1234 5678 9012'])(
    'hides %s without a Luhn check',
    (pan) => {
      expect(scrubSecretsInText(`pan ${pan}.`)).toBe(`pan ${REDACTED}.`);
    },
  );

  it('other 16-digit numbers need a valid Luhn check', () => {
    expect(scrubSecretsInText('id 1234567890123456 end')).toContain('1234567890123456');
    expect(scrubSecretsInText('id 4111111111111112 end')).toContain('4111111111111112');
  });

  it('a 15 or 17 digit run is left alone', () => {
    expect(scrubSecretsInText('n 860012345678901 n')).toContain('860012345678901');
    expect(scrubSecretsInText('n 86001234567890123 n')).toContain('86001234567890123');
  });
});
