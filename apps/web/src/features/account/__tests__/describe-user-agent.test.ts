import { describe, expect, it } from 'vitest';
import { describeUserAgent } from '../describe-user-agent';

const UAS = {
  chromeWindows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  edgeWindows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
  safariMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  safariIphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  chromeAndroid:
    'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  firefoxLinux: 'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0',
  operaWindows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 OPR/112.0.0.0',
};

describe('describeUserAgent', () => {
  it.each([
    ['chromeWindows', 'Chrome · Windows', 'desktop'],
    ['edgeWindows', 'Edge · Windows', 'desktop'],
    ['operaWindows', 'Opera · Windows', 'desktop'],
    ['safariMac', 'Safari · macOS', 'laptop'],
    ['safariIphone', 'Safari · iOS', 'mobile'],
    ['chromeAndroid', 'Chrome · Android', 'mobile'],
    ['firefoxLinux', 'Firefox · Linux', 'desktop'],
  ] as const)('%s -> %s', (name, label, kind) => {
    expect(describeUserAgent(UAS[name])).toEqual({ label, kind });
  });

  it('a missing, empty or unknown user agent has no label', () => {
    expect(describeUserAgent(null)).toEqual({ label: null, kind: 'desktop' });
    expect(describeUserAgent('')).toEqual({ label: null, kind: 'desktop' });
    expect(describeUserAgent('curl/8.0')).toEqual({ label: null, kind: 'desktop' });
  });

  it('a browser without a known system, or a system without a known browser, keeps what it has', () => {
    expect(describeUserAgent('Firefox/127.0')).toEqual({ label: 'Firefox', kind: 'desktop' });
    expect(describeUserAgent('SomeApp (Android 14)')).toEqual({ label: 'Android', kind: 'mobile' });
  });
});
