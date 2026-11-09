import { parseStartPayload } from '@repo/shared';

// Referral links (docs/04: `referralCode` on `GET /me`). They are built from the bot's username in
// env and the user's code; the brand is not written here. When `GET /referrals` exists (phase 10)
// its `link` / `miniAppLink` replace this.

const BOT_USERNAME = /^[A-Za-z][A-Za-z0-9_]{4,31}$/;

export type ReferralLinkKind = 'bot' | 'miniApp';

/**
 * `https://t.me/<bot>?start=ref_<code>` (opens the bot) or `...?startapp=ref_<code>` (opens the
 * Mini App; assumes the bot has a Main Mini App, the owner checks it). null when the username is
 * not a bot username or `ref_<code>` is not a start parameter the bot itself accepts: the whole
 * parameter, prefix included, is judged by the bot's own parser (`parseStartPayload`: 64
 * characters at most, the code as the generator makes it), so a broken value never becomes a link
 * the bot would then ignore.
 */
export function referralLink(
  botUsername: string,
  referralCode: string,
  kind: ReferralLinkKind,
): string | null {
  const param = `ref_${referralCode}`;
  if (!BOT_USERNAME.test(botUsername) || parseStartPayload(param).kind !== 'ref') return null;
  return `https://t.me/${botUsername}?${kind === 'bot' ? 'start' : 'startapp'}=${param}`;
}

/** Telegram's share dialog for a link and a line of text. */
export function telegramShareUrl(link: string, text: string): string {
  return `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}`;
}

/** "@name" of a `https://t.me/<name>` support link, for the line under the support button. */
export function supportHandle(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.origin !== 'https://t.me') return null;
    const name = parsed.pathname.split('/')[1];
    return name !== undefined && /^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(name) ? `@${name}` : null;
  } catch {
    return null;
  }
}
