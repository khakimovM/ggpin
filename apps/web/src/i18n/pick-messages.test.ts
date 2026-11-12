import { describe, expect, it } from 'vitest';
import { MESSAGES } from './messages';
import { LOGIN_NAMESPACES, ROOT_NAMESPACES, STORE_NAMESPACES } from './namespaces';
import { pickMessages } from './pick-messages';

describe('pickMessages', () => {
  it('returns exactly the listed namespaces, in both locales', () => {
    for (const locale of ['uz', 'ru'] as const) {
      const picked = pickMessages(locale, ['common', 'web']);
      expect(Object.keys(picked)).toEqual(['common', 'web']);
      expect(picked.common).toBe(MESSAGES[locale].common);
      expect(picked.web).toBe(MESSAGES[locale].web);
    }
  });

  it('returns an empty object for no namespaces', () => {
    expect(pickMessages('uz', [])).toEqual({});
  });
});

describe('namespace sets of the website', () => {
  // The bot, admin, alert and Mini App texts are never needed by a website page.
  const NEVER = ['bot', 'admin', 'alerts', 'tg'];

  it('the root layout sends only `common`', () => {
    expect([...ROOT_NAMESPACES]).toEqual(['common']);
  });

  it('the sign-in page sends its own texts and nothing else of the store', () => {
    expect([...LOGIN_NAMESPACES].sort()).toEqual(['common', 'errors', 'web']);
  });

  it('the store sends the namespaces its screens read', () => {
    expect([...STORE_NAMESPACES].sort()).toEqual(
      ['account', 'common', 'errors', 'fields', 'pay', 'store', 'wallet', 'web'].sort(),
    );
  });

  it('no set carries bot, admin, alert or Mini App texts, and every name exists in the catalog', () => {
    for (const set of [ROOT_NAMESPACES, LOGIN_NAMESPACES, STORE_NAMESPACES]) {
      for (const name of set) {
        expect(NEVER).not.toContain(name);
        expect(Object.keys(MESSAGES.uz)).toContain(name);
        expect(Object.keys(MESSAGES.ru)).toContain(name);
      }
    }
  });
});
