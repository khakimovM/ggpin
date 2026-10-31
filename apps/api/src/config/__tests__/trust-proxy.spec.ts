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
    ['0.0.0.0/0', '/0'],
    ['::/0', '/0'],
    ['10.0.0.0/0', '/0'],
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

  it('names the position of the bad entry, not its text', () => {
    const result = parseTrustedProxies('127.0.0.1,not-an-ip-s3cr3t');
    expect(result).toEqual({ ok: false, problem: expect.stringContaining('entry 2:') as string });
    if (!result.ok) expect(result.problem).not.toContain('s3cr3t');
  });
});
