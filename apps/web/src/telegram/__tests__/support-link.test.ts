import { describe, expect, it } from 'vitest';
import { supportLink } from '../support-link';

describe('supportLink', () => {
  it('no link configured', () => {
    expect(supportLink('')).toEqual({ kind: 'none' });
  });

  it('a https://t.me link is a Telegram link', () => {
    expect(supportLink('https://t.me/ggpin_support')).toEqual({
      kind: 'telegram',
      href: 'https://t.me/ggpin_support',
    });
  });

  it('any other host is no link at all, look-alikes included (audit L-3)', () => {
    for (const url of [
      'https://help.example.test/ggpin',
      'http://t.me/ggpin_support',
      'https://t.me.evil.example/x',
      'https://telegram.me/x',
      'https://user:pw@t.me/x',
      'https://t.me:8443/x',
      'https://t.me/x?start=1',
      'https://t.me/"onmouseover=',
    ]) {
      expect(supportLink(url), url).toEqual({ kind: 'none' });
    }
  });

  it('anything that is not http(s) is no link at all, however it was configured', () => {
    for (const url of [
      'javascript:alert(1)',
      'JAVASCRIPT:alert(1)',
      'data:text/html,<script>1</script>',
      'ftp://files.example.test/x',
      'file:///etc/passwd',
      'tg://resolve?domain=ggpin_support',
      'blob:https://t.me/1',
    ]) {
      expect(supportLink(url), url).toEqual({ kind: 'none' });
    }
  });

  it('a malformed URL is no link', () => {
    for (const url of ['not a url', 'http://', 'https://[::1', '//t.me/x', 't.me/ggpin_support']) {
      expect(supportLink(url), url).toEqual({ kind: 'none' });
    }
  });

  it('the href is the normalised URL', () => {
    expect(supportLink('HTTPS://T.ME/ggpin_support')).toEqual({
      kind: 'telegram',
      href: 'https://t.me/ggpin_support',
    });
  });
});
