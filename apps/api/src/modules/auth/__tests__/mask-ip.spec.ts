import { maskIp, truncateUserAgent } from '../mask-ip';

describe('maskIp', () => {
  it.each([
    ['203.0.113.45', '203.0.113.x'],
    ['10.0.0.1', '10.0.0.x'],
    ['127.0.0.1', '127.0.0.x'],
  ])('IPv4 %s keeps the /24 only', (ip, masked) => {
    expect(maskIp(ip)).toBe(masked);
  });

  it.each([
    ['2001:db8:85a3:1:2:3:4:5', '2001:db8:85a3::x'],
    ['2001:db8:85a3::7', '2001:db8:85a3::x'],
    ['2001:0DB8:85A3:0000:0000:8A2E:0370:7334', '2001:db8:85a3::x'],
    ['2001:db8::1', '2001:db8:0::x'],
    ['::1', '0:0:0::x'],
    ['fe80::1%eth0', 'fe80:0:0::x'],
  ])('IPv6 %s keeps the /48 only', (ip, masked) => {
    expect(maskIp(ip)).toBe(masked);
  });

  it('masks an IPv4-mapped IPv6 address like the IPv4 one', () => {
    expect(maskIp('::ffff:203.0.113.45')).toBe('203.0.113.x');
  });

  it('never returns the host part of the input', () => {
    expect(maskIp('203.0.113.45')).not.toContain('45');
    expect(maskIp('2001:db8:85a3:1:2:3:4:5')).not.toContain('4:5');
  });

  it.each([[null], [undefined], [''], ['not an ip'], ['999.1.1.1'], ['1:2:3:4:5:6:7:8:9']])(
    'returns null for %p',
    (ip) => {
      expect(maskIp(ip)).toBeNull();
    },
  );
});

describe('truncateUserAgent', () => {
  it('passes a normal agent through, bounds a huge one, and maps empty to null', () => {
    expect(truncateUserAgent('Mozilla/5.0')).toBe('Mozilla/5.0');
    expect(truncateUserAgent('a'.repeat(1000))).toHaveLength(256);
    expect(truncateUserAgent('')).toBeNull();
    expect(truncateUserAgent(undefined)).toBeNull();
    expect(truncateUserAgent(null)).toBeNull();
  });
});
