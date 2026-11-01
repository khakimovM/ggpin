import type { AppConfig } from '../../config/config.module';

// Exactly the first-party frontends. WEB_URL and ADMIN_URL are already normalised to origins
// by env.ts; MINI_APP_URL is a full URL (e.g. https://ggpin.uz/tg), so only its origin counts,
// and the Set drops it when it equals WEB_URL's origin (the normal case).
export function corsOrigins(config: AppConfig): string[] {
  const origins = new Set<string>([config.WEB_URL, config.ADMIN_URL]);
  if (config.MINI_APP_URL !== undefined) origins.add(new URL(config.MINI_APP_URL).origin);
  return [...origins];
}
