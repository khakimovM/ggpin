import { REFERRAL_CODE_LENGTH } from '@repo/shared';
import { describe, expect, it } from 'vitest';
import { referralLink, supportHandle, telegramShareUrl } from '../referral-link';

describe('referralLink', () => {
  it('builds the bot and the Mini App link from the username and the code, nothing hardcoded', () => {
    expect(referralLink('some_test_bot', 'ab12cd34', 'bot')).toBe(
      'https://t.me/some_test_bot?start=ref_ab12cd34',
    );
    expect(referralLink('other_bot', 'ab12cd34', 'miniApp')).toBe(
      'https://t.me/other_bot?startapp=ref_ab12cd34',
    );
  });

  it('accepts exactly the codes the bot accepts (the generator length, lowercase alphanumerics)', () => {
    expect(
      referralLink('some_test_bot', 'a'.repeat(REFERRAL_CODE_LENGTH), 'miniApp'),
    ).not.toBeNull();
    expect(
      referralLink('some_test_bot', 'a'.repeat(REFERRAL_CODE_LENGTH - 1), 'miniApp'),
    ).toBeNull();
    expect(
      referralLink('some_test_bot', 'a'.repeat(REFERRAL_CODE_LENGTH + 1), 'miniApp'),
    ).toBeNull();
    expect(referralLink('some_test_bot', 'AB12CD34', 'miniApp')).toBeNull();
  });

  it('judges the whole start parameter, prefix included: 64 characters at most', () => {
    // "ref_" + 61 characters is over Telegram's cap by one, and over the generator's length anyway.
    expect(referralLink('some_test_bot', 'a'.repeat(61), 'miniApp')).toBeNull();
    expect(referralLink('some_test_bot', 'a'.repeat(60), 'miniApp')).toBeNull();
  });

  it('refuses a code or a username Telegram would not accept', () => {
    expect(referralLink('some_test_bot', '', 'miniApp')).toBeNull();
    expect(referralLink('some_test_bot', 'a b', 'miniApp')).toBeNull();
    expect(referralLink('some_test_bot', 'a&startapp=evil', 'miniApp')).toBeNull();
    expect(referralLink('bad name', 'ab12cd34', 'miniApp')).toBeNull();
    expect(referralLink('', 'ab12cd34', 'miniApp')).toBeNull();
  });
});

describe('telegramShareUrl', () => {
  it('puts the link and the text into the share dialog address, encoded', () => {
    const url = new URL(telegramShareUrl('https://t.me/x_bot?startapp=ref_a', 'a b&c'));
    expect(url.origin + url.pathname).toBe('https://t.me/share/url');
    expect(url.searchParams.get('url')).toBe('https://t.me/x_bot?startapp=ref_a');
    expect(url.searchParams.get('text')).toBe('a b&c');
  });
});

describe('supportHandle', () => {
  it('reads @name from a t.me link and nothing else', () => {
    expect(supportHandle('https://t.me/some_support')).toBe('@some_support');
    expect(supportHandle('https://example.com/some_support')).toBeNull();
    expect(supportHandle('https://t.me/')).toBeNull();
    expect(supportHandle('not a url')).toBeNull();
  });
});
