'use client';

import { useLocale } from 'next-intl';
import { localizedPath } from '../../i18n/paths';

export interface AccountPaths {
  home: string;
  history: string;
  profile: string;
  order: (id: string) => string;
}

// The Mini App has no locale prefix; the web store lives under /[locale]/store. The order id comes
// from the API, but it is still encoded: it ends up inside a path.
export function useAccountPaths(variant: 'tg' | 'web'): AccountPaths {
  const locale = useLocale() === 'ru' ? 'ru' : 'uz';
  if (variant === 'tg') {
    return {
      home: '/tg',
      history: '/tg/history',
      profile: '/tg/profile',
      order: (id) => `/tg/orders/${encodeURIComponent(id)}`,
    };
  }
  return {
    home: localizedPath(locale, '/store'),
    history: localizedPath(locale, '/store/orders'),
    profile: localizedPath(locale, '/store/profile'),
    order: (id) => localizedPath(locale, `/store/orders/${encodeURIComponent(id)}` as `/${string}`),
  };
}
