import { configuredTelegramUrl } from './t-me-url';

/**
 * What the "Yordam" (support) button does, from the configured `NEXT_PUBLIC_SUPPORT_URL`:
 * - none: no link configured, so there is nothing to open (the button says "Tez orada");
 * - telegram: the operator's `https://t.me/<handle>`, opened inside Telegram when the app runs in
 *   it (`openTelegramLink`), as an ordinary link otherwise.
 * The env schema accepts nothing else (audit L-3: the link is on the public contacts page).
 */
export type SupportLink = { kind: 'none' } | { kind: 'telegram'; href: string };

export function supportLink(url: string): SupportLink {
  // The same rule the env schema applied, as a second line of defence: a value that is not a clean
  // t.me link (another host, `javascript:`, credentials) is no link at all, never an href.
  const href = url === '' ? null : configuredTelegramUrl(url);
  return href === null ? { kind: 'none' } : { kind: 'telegram', href };
}
