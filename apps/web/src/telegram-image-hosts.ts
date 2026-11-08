// Where Telegram serves profile pictures from. One list for two readers: the CSP `img-src`
// (security-headers.ts) and the check that decides whether a photo URL may be handed to an <img>
// at all (features/product/photo-src.ts). A host added to one and not the other would either break
// the picture or raise a CSP report, so both read this.
export const TELEGRAM_IMAGE_HOSTS = ['t.me'] as const;
export const TELEGRAM_IMAGE_DOMAINS = ['telegram.org'] as const;

/** The CSP source expressions for the hosts above. */
export const TELEGRAM_IMAGE_CSP_SOURCES: readonly string[] = [
  ...TELEGRAM_IMAGE_HOSTS.map((host) => `https://${host}`),
  ...TELEGRAM_IMAGE_DOMAINS.map((domain) => `https://*.${domain}`),
];

export function isTelegramImageHost(hostname: string): boolean {
  return (
    TELEGRAM_IMAGE_HOSTS.some((host) => hostname === host) ||
    TELEGRAM_IMAGE_DOMAINS.some((domain) => hostname.endsWith(`.${domain}`))
  );
}
