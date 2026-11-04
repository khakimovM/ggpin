import type { Locale } from '@repo/shared';
import type { Messages } from './messages';

// Type-safe `t('key')` lookups against the uz catalog.
declare module 'next-intl' {
  interface AppConfig {
    Locale: Locale;
    Messages: Messages;
  }
}
