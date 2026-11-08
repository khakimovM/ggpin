/**
 * Builds the URL of a Mini App PAGE from MINI_APP_URL (e.g. `https://ggpin.uz/tg`) for outbox
 * buttons (the bot's own keyboards and menu button still use MINI_APP_URL as is):
 * `miniAppUrl(config, '/topup')` -> `https://ggpin.uz/tg/topup`. Undefined when MINI_APP_URL is
 * not set (dev without HTTPS) or is not https: callers then send no button at all.
 */
export interface MiniAppUrlConfig {
  readonly MINI_APP_URL?: string | undefined;
}

export function miniAppUrl(config: MiniAppUrlConfig, path: `/${string}`): string | undefined {
  if (config.MINI_APP_URL === undefined) return undefined;
  const url = new URL(config.MINI_APP_URL);
  if (url.protocol !== 'https:') return undefined;
  url.pathname = `${url.pathname.replace(/\/+$/, '')}${path}`;
  return url.toString();
}
