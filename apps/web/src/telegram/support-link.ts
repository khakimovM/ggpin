import { resolveTelegramUrl } from './open-link';

/**
 * What the "Yordam" (support) button does, from the configured `NEXT_PUBLIC_SUPPORT_URL`:
 * - none: no link configured, so there is nothing to open (the button says "Tez orada");
 * - telegram: a `https://t.me/...` link, opened inside Telegram when the app runs in it
 *   (`openTelegramLink`), as an ordinary link otherwise;
 * - external: any other http(s) link, an ordinary link in a new tab.
 */
export type SupportLink =
  { kind: 'none' } | { kind: 'telegram'; href: string } | { kind: 'external'; href: string };

export function supportLink(url: string): SupportLink {
  if (url === '') return { kind: 'none' };
  // A second line of defence behind the env schema: only http(s) is ever put into an href.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { kind: 'none' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return { kind: 'none' };
  return resolveTelegramUrl(parsed.href) === null
    ? { kind: 'external', href: parsed.href }
    : { kind: 'telegram', href: parsed.href };
}
