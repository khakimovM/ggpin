// Admin texts (D-63 (9), Q14): Uzbek only, from packages/i18n/admin.uz.json. API error texts are
// the backend-owned `errors.*` of uz.json, so the panel and the bot say the same thing.
import adminCatalog from '@repo/i18n/admin.uz.json';
import uz from '@repo/i18n/uz.json';

export const ADMIN_LOCALE = 'uz';

/** Every admin date and time is shown in Tashkent time, whatever the operator's machine says. */
export const ADMIN_TIME_ZONE = 'Asia/Tashkent';

export const messages = {
  admin: adminCatalog.admin,
  errors: uz.errors,
};

export type AdminMessages = typeof messages;

declare module 'use-intl' {
  interface AppConfig {
    Locale: typeof ADMIN_LOCALE;
    Messages: AdminMessages;
  }
}
