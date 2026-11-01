import { parseTrustedProxies } from '../trust-proxy';

describe('parseTrustedProxies', () => {
  it('treats empty and blank input as "trust no proxy"', () => {
    expect(parseTrustedProxies('')).toEqual({ ok: true, entries: [] });
    expect(parseTrustedProxies(' , ,')).toEqual({ ok: true, entries: [] });
  });

  it('accepts IPv4/IPv6 addresses and CIDRs, trimmed', () => {
    expect(
      parseTrustedProxies('127.0.0.1, ::1 ,10.0.0.0/8,2001:db8::/32,fd00::1/128,1.2.3.4/32'),
    ).toEqual({
      ok: true,
      entries: ['127.0.0.1', '::1', '10.0.0.0/8', '2001:db8::/32', 'fd00::1/128', '1.2.3.4/32'],
    });
  });

  it.each([
    ['true', 'not "true"'],
    ['false', 'not "true"'],
    ['*', 'wildcard'],
    ['1', 'bare number'],
    ['0', 'bare number'],
    ['0.0.0.0/0', 'too wide'],
    ['::/0', 'too wide'],
    ['10.0.0.0/0', 'too wide'],
    ['0.0.0.0/1', 'too wide'],
    ['128.0.0.0/1', 'too wide'],
    ['10.0.0.0/7', 'too wide'],
    ['2001:db8::/31', 'too wide'],
    ['::ffff:0:0/96', 'too wide'],
    ['::ffff:0.0.0.0/97', 'too wide'],
    ['::ffff:0:0/80', 'IPv4-mapped'],
    ['::ffff:10.0.0.0/64', 'IPv4-mapped'],
    ['10.0.0.0/33', 'longer than the address'],
    ['::1/129', 'longer than the address'],
    ['10.0.0.0/-1', 'invalid CIDR prefix'],
    ['10.0.0.0/', 'invalid CIDR prefix'],
    ['10.0.0.0/8/8', 'invalid CIDR prefix'],
    ['10.0.0.0/abc', 'invalid CIDR prefix'],
    ['10.0.0.0/1234', 'invalid CIDR prefix'],
    ['proxy.internal', 'valid IPv4/IPv6'],
    ['300.1.1.1', 'valid IPv4/IPv6'],
  ])('rejects %s', (entry, fragment) => {
    const result = parseTrustedProxies(entry);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toContain(fragment);
  });

  it('accepts the narrowest allowed networks', () => {
    expect(parseTrustedProxies('10.0.0.0/8,2001:db8::/32')).toEqual({
      ok: true,
      entries: ['10.0.0.0/8', '2001:db8::/32'],
    });
  });

  it('refuses a list that is only wide when read as two halves of the address space', () => {
    // Each half is a /1: together they trust every IPv4 address without ever writing /0.
    const result = parseTrustedProxies('0.0.0.0/1,128.0.0.0/1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toContain('entry 1:');
  });

  describe('IPv4-mapped IPv6 entries are rewritten to IPv4 before validation', () => {
    it.each([
      ['::ffff:127.0.0.1', '127.0.0.1'],
      ['::FFFF:10.1.2.3', '10.1.2.3'],
      ['::ffff:0a00:0001', '10.0.0.1'],
      ['0:0:0:0:0:ffff:172.18.0.2', '172.18.0.2'],
      ['::ffff:10.0.0.0/104', '10.0.0.0/8'],
      ['::ffff:172.18.0.0/112', '172.18.0.0/16'],
      ['::ffff:172.18.0.2/128', '172.18.0.2/32'],
    ])('%s -> %s', (entry, expected) => {
      expect(parseTrustedProxies(entry)).toEqual({ ok: true, entries: [expected] });
    });

    it('rewrites only mapped addresses: other IPv6 stays as written', () => {
      expect(parseTrustedProxies('::1,2001:db8::1,::ffff:1.2.3.4,64:ff9b::1.2.3.4')).toEqual({
        ok: true,
        entries: ['::1', '2001:db8::1', '1.2.3.4', '64:ff9b::1.2.3.4'],
      });
    });

    it('applies the IPv4 minimum prefix after the rewrite', () => {
      // /103 maps to IPv4 /7.
      const result = parseTrustedProxies('::ffff:10.0.0.0/103');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.problem).toContain('too wide');
    });
  });

  it('names the position of the bad entry, not its text', () => {
    const result = parseTrustedProxies('127.0.0.1,not-an-ip-s3cr3t');
    expect(result).toEqual({ ok: false, problem: expect.stringContaining('entry 2:') as string });
    if (!result.ok) expect(result.problem).not.toContain('s3cr3t');
  });
});
