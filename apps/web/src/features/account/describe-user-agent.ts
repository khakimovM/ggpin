export type DeviceKind = 'mobile' | 'laptop' | 'desktop';

export interface DeviceInfo {
  /** "Chrome · Windows": product names, not translated. Null when nothing was recognised. */
  label: string | null;
  kind: DeviceKind;
}

// Order matters: Edge, Opera and Chrome-based browsers all contain "Chrome", Chrome contains
// "Safari". The first match wins.
const BROWSERS: readonly [RegExp, string][] = [
  [/\bEdgA?\//, 'Edge'],
  [/\bOPR\//, 'Opera'],
  [/\bFirefox\/|\bFxiOS\//, 'Firefox'],
  [/\bYaBrowser\//, 'Yandex'],
  [/\bSamsungBrowser\//, 'Samsung Internet'],
  [/\bChrome\/|\bCriOS\//, 'Chrome'],
  [/\bSafari\//, 'Safari'],
];

// iPhone/iPad strings also say "like Mac OS X", so iOS is tested before macOS.
const SYSTEMS: readonly [RegExp, string, DeviceKind][] = [
  [/\biPhone\b|\biPad\b|\biPod\b/, 'iOS', 'mobile'],
  [/\bAndroid\b/, 'Android', 'mobile'],
  [/\bWindows\b/, 'Windows', 'desktop'],
  [/\bMac OS X\b|\bMacintosh\b/, 'macOS', 'laptop'],
  [/\bCrOS\b/, 'ChromeOS', 'laptop'],
  [/\bLinux\b|\bX11\b/, 'Linux', 'desktop'],
];

/** Reduces the `User-Agent` the API stored for a session to what a person recognises. */
export function describeUserAgent(userAgent: string | null): DeviceInfo {
  if (userAgent === null || userAgent === '') return { label: null, kind: 'desktop' };
  const browser = BROWSERS.find(([pattern]) => pattern.test(userAgent))?.[1] ?? null;
  const system = SYSTEMS.find(([pattern]) => pattern.test(userAgent));
  const parts = [browser, system?.[1] ?? null].filter((part): part is string => part !== null);
  return { label: parts.length === 0 ? null : parts.join(' · '), kind: system?.[2] ?? 'desktop' };
}
