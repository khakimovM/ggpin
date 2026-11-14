import { describe, expect, it } from 'vitest';
import { OrderRecipientSchema } from './order-schemas';
import { RECIPIENT_PLACEHOLDER, storedRecipientView } from './stored-recipient';

describe('storedRecipientView: the recipient an order stores, read leniently (review M2)', () => {
  it('today’s shape: the name, and the username as the Telegram form field', () => {
    const stored = { username: 'aziz_k', displayName: 'Aziz', photoUrl: 'https://t.me/i/a.jpg' };
    expect(storedRecipientView(stored)).toEqual({
      displayName: 'Aziz',
      fields: { username: 'aziz_k' },
    });
  });

  it('a row of an older rule (a username today’s pattern refuses, unknown keys) is still read', () => {
    const stored = { username: 'old-name.1', displayName: 'Eski', legacy: true, v: 1 };
    expect(storedRecipientView(stored)).toEqual({
      displayName: 'Eski',
      fields: { username: 'old-name.1' },
    });
  });

  it.each([
    ['missing', {}],
    ['blank', { displayName: '   ' }],
    ['too long', { displayName: 'x'.repeat(129) }],
    ['not a string', { displayName: 42 }],
  ])('a name that is %s: the username is shown instead', (_case, name) => {
    expect(storedRecipientView({ username: 'aziz_k', ...name })).toEqual({
      displayName: 'aziz_k',
      fields: { username: 'aziz_k' },
    });
  });

  // Audit I1: the input rule's ban on invisible and bidi controls holds for a stored row too. The
  // characters are built from escapes: they never appear literally in a source file.
  const RLO = '\u202e';
  const ZWSP = '\u200b';
  it.each([
    ['a right-to-left override', `Aziz${RLO}gpj.exe`],
    ['a zero-width space', `Az${ZWSP}iz`],
    ['a bidi isolate', '\u2066Aziz\u2069'],
  ])('a name with %s: the username is shown instead', (_case, displayName) => {
    expect(storedRecipientView({ username: 'aziz_k', displayName })).toEqual({
      displayName: 'aziz_k',
      fields: { username: 'aziz_k' },
    });
  });

  it('a bidi control in both fields: null, so the caller shows the placeholder', () => {
    const stored = { username: `aziz${RLO}k`, displayName: `Az${RLO}iz` };
    expect(storedRecipientView(stored)).toBeNull();
    expect(RECIPIENT_PLACEHOLDER).toBe('\u2014');
  });

  it('a bidi control in the username only: the name is shown, with no form field', () => {
    expect(storedRecipientView({ username: `aziz${RLO}k`, displayName: 'Aziz' })).toEqual({
      displayName: 'Aziz',
      fields: {},
    });
  });

  it('a name without a usable username: shown, with no form field', () => {
    expect(storedRecipientView({ displayName: 'Aziz', username: '' })).toEqual({
      displayName: 'Aziz',
      fields: {},
    });
  });

  it.each([
    ['neither field', { name: 'x', id: 7 }],
    ['an empty object', {}],
    ['a string', 'aziz_k'],
    ['an array', [{ username: 'aziz_k' }]],
    ['null', null],
    ['a number', 7],
  ])('%s: null (the caller shows a placeholder), never a throw', (_case, stored) => {
    expect(storedRecipientView(stored)).toBeNull();
  });

  it('whatever it reads, the answer passes the contract schema', () => {
    const rows: unknown[] = [
      { username: ' padded ', displayName: ' Name ' },
      { username: 'u'.repeat(128), displayName: 'n'.repeat(128) },
      { username: 'aziz_k', displayName: 'Aziz', extra: { deep: [1, 2] } },
      { displayName: 'faqat ism' },
    ];
    for (const row of rows) {
      const view = storedRecipientView(row);
      expect(view).not.toBeNull();
      expect(OrderRecipientSchema.safeParse(view).success).toBe(true);
    }
  });
});
