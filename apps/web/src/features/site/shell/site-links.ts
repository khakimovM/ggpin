import { env } from '../../../env';
import type { ClientEnv } from '../../../env-schema';
import { supportLink } from '../../../telegram/support-link';

// Where the website sends a visitor outside itself. Every link comes from configuration and is
// `null` when that configuration is empty: the page then draws no link at all (a dead or
// half-made link is worse than none). The brand's handles are never written in code.

export type SiteLinkEnv = Pick<
  ClientEnv,
  'NEXT_PUBLIC_BOT_USERNAME' | 'NEXT_PUBLIC_TELEGRAM_CHANNEL_URL' | 'NEXT_PUBLIC_SUPPORT_URL'
>;

export interface SiteLinks {
  /** `https://t.me/<bot>`: "Open in Telegram". */
  bot: string | null;
  /** The bot's @handle for display (`@ggpin_bot`). */
  botHandle: string | null;
  /** The brand's public channel. */
  channel: string | null;
  /** The operator chat behind the "write to support" entry. */
  support: string | null;
}

const CHANNEL_PREFIX = 'https://t.me/';

export function siteLinks(source: SiteLinkEnv = env): SiteLinks {
  const username = source.NEXT_PUBLIC_BOT_USERNAME.trim();
  const channel = source.NEXT_PUBLIC_TELEGRAM_CHANNEL_URL.trim();
  const support = supportLink(source.NEXT_PUBLIC_SUPPORT_URL.trim());
  return {
    bot: username === '' ? null : `${CHANNEL_PREFIX}${username}`,
    botHandle: username === '' ? null : `@${username}`,
    // The env schema already allows only https://t.me/...; a second check here keeps a look-alike
    // host out of an href even if the schema is ever loosened.
    channel: channel.startsWith(CHANNEL_PREFIX) ? channel : null,
    support: support.kind === 'none' ? null : support.href,
  };
}
