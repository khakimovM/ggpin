import { deviceLabel } from '../device-label';

describe('deviceLabel', () => {
  it.each<[string, string]>([
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      'Chrome, Windows',
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
      'Edge, Windows',
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 OPR/115.0.0.0',
      'Opera, Windows',
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 YaBrowser/24.10.0.0 Safari/537.36',
      'Yandex, Windows',
    ],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15',
      'Safari, macOS',
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
      'Safari, iOS',
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.6723.37 Mobile/15E148 Safari/604.1',
      'Chrome, iOS',
    ],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:132.0) Gecko/20100101 Firefox/132.0',
      'Firefox, macOS',
    ],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0', 'Firefox, Linux'],
    [
      'Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36',
      'Samsung Internet, Android',
    ],
    [
      'Mozilla/5.0 (Linux; Android 13; Redmi Note 12) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
      'Chrome, Android',
    ],
    [
      'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36 Telegram-Android/11.2.0',
      'Telegram, Android',
    ],
  ])('%s -> %s', (userAgent, label) => {
    expect(deviceLabel(userAgent)).toBe(label);
  });

  it('gives only the OS or only the browser when the other is unknown', () => {
    expect(deviceLabel('Mozilla/5.0 (Windows NT 10.0)')).toBe('Windows');
    expect(deviceLabel('Chrome/130')).toBe('Chrome');
  });

  it.each([undefined, null, '', '   ', 'curl/8.4.0', 'python-requests/2.31', 'Laptop/1.0'])(
    'nothing recognised (%p) -> null',
    (userAgent) => {
      expect(deviceLabel(userAgent)).toBeNull();
    },
  );

  it('hostile text is never echoed: only labels from the fixed list come out', () => {
    const hostile = [
      'https://evil.example/pay?x=1',
      '@fake_support write me',
      '<a href="https://evil.example">Chrome</a> @fake_support',
      'Mozilla/5.0 (Windows NT 10.0) Chrome/130 https://evil.example @fake_support t.me/fake',
      `${'A'.repeat(100_000)} Chrome/1`,
    ];
    const allowed =
      /^(?:(?:Telegram|Edge|Opera|Yandex|Samsung Internet|Firefox|Chrome|Safari)(?:, (?:Windows|iOS|Android|macOS|Linux))?|Windows|iOS|Android|macOS|Linux)$/;
    for (const userAgent of hostile) {
      const label = deviceLabel(userAgent);
      if (label !== null) expect(label).toMatch(allowed);
      expect(label ?? '').not.toMatch(/evil|fake_support|https?:|@|t\.me/);
    }
    expect(deviceLabel(hostile[0])).toBeNull();
    expect(deviceLabel(hostile[1])).toBeNull();
    expect(deviceLabel(hostile[3])).toBe('Chrome, Windows');
  });
});
