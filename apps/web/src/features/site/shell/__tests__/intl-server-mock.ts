import type { Locale } from '@repo/shared';
import { createTranslator } from 'next-intl';
import { vi } from 'vitest';
import { MESSAGES } from '../../../../i18n/messages';

// `next-intl/server` needs a request; in a unit test the server components get a translator built
// from the real catalogs instead (same texts, no Next.js runtime). Use it as
//   vi.mock('next-intl/server', async () => (await import('./intl-server-mock')).intlServerMock);
type Namespace =
  | 'site'
  | 'site.nav'
  | 'site.footer'
  | 'site.error'
  // The landing (phase 8 S2).
  | 'site.hero'
  | 'site.hero.mock'
  | 'site.products'
  | 'site.products.names'
  | 'site.how'
  | 'site.how.methods'
  | 'site.why'
  | 'site.faq'
  | 'site.faq.items'
  | 'site.cta'
  // The product pages (phase 8 S3).
  | 'site.product.common'
  | 'site.product.common.breadcrumb'
  | 'site.product.common.facts'
  | 'site.product.common.related'
  | `site.product.${'stars' | 'premium'}`
  | `site.product.${'stars' | 'premium'}.how`
  | `site.product.${'stars' | 'premium'}.faq`
  | `site.product.${'stars' | 'premium'}.faq.items`
  | `site.product.${'stars' | 'premium'}.meta`
  | 'store.catalog'
  | 'common.money'
  | 'common.currency';

export const intlServerMock = {
  getTranslations: ({ locale, namespace }: { locale: Locale; namespace: Namespace }) =>
    Promise.resolve(createTranslator({ locale, messages: MESSAGES[locale], namespace })),
  setRequestLocale: vi.fn(),
};
