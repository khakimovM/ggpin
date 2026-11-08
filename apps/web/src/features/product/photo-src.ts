import { isTelegramImageHost } from '../../telegram-image-hosts';

/**
 * The recipient's photo URL if an <img> may load it (https, a Telegram host the CSP `img-src`
 * allows), else undefined and the avatar shows initials. Anything else would only raise a CSP
 * report.
 */
export function telegramPhotoSrc(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'https:' && isTelegramImageHost(hostname) ? url : undefined;
  } catch {
    return undefined;
  }
}
