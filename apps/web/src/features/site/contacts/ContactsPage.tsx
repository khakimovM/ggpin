import type { Locale } from '@repo/shared';
import { cn } from '@repo/ui';
import { getTranslations } from 'next-intl/server';
import { requestNonce } from '../../../csp/request-nonce';
import { env } from '../../../env';
import { localizedPath } from '../../../i18n/paths';
import { LANDING_CONTAINER, LANDING_H2, LANDING_LEAD } from '../landing/landing-styles';
import { Breadcrumbs } from '../product/Breadcrumbs';
import { JsonLd } from '../seo/JsonLd';
import { breadcrumbLd } from '../seo/json-ld';
import { pageUrl } from '../seo/page-metadata';
import { siteLinks } from '../shell/site-links';
import { contactCards, type ContactCard } from './contact-cards';
import { ContactCardItem, type ContactCardView } from './ContactCardItem';

/**
 * The contacts page (`/contacts`, P8-Q10): the support chat, the bot and the channel (each only
 * when configured) and the operators' hours. No design of its own: the landing's heading and its
 * "Nega biz?" cards, under the product pages' trail. No company details until the lawyer answers.
 */
export async function ContactsPage({ locale }: { locale: Locale }) {
  const [crumbs, meta, t, why, ask, nonce] = await Promise.all([
    getTranslations({ locale, namespace: 'site.product.common.breadcrumb' }),
    getTranslations({ locale, namespace: 'site.meta.contacts' }),
    getTranslations({ locale, namespace: 'site.contacts' }),
    getTranslations({ locale, namespace: 'site.why.items.support' }),
    getTranslations({ locale, namespace: 'account.help.ask' }),
    requestNonce(),
  ]);
  const title = meta('title');
  const site = env.NEXT_PUBLIC_SITE_URL;

  const view = (card: ContactCard): ContactCardView => {
    const link = (label: string) => (card.href === null ? null : { href: card.href, label });
    switch (card.kind) {
      case 'support':
        return {
          kind: card.kind,
          title: t('support.title'),
          text: t('support.text'),
          value: card.handle,
          action: link(t('support.cta')),
        };
      case 'bot':
        return {
          kind: card.kind,
          title: t('bot.title'),
          text: t('bot.text'),
          value: card.handle,
          action: link(t('bot.cta')),
        };
      case 'channel':
        return {
          kind: card.kind,
          title: t('channel.title'),
          text: t('channel.text'),
          value: card.handle,
          action: link(t('channel.cta')),
        };
      case 'hours':
        // The same hours the help screen shows (`account.help.ask.hours`).
        return {
          kind: card.kind,
          title: t('hours.title'),
          text: null,
          value: ask('hours'),
          action: null,
        };
    }
  };

  return (
    <main>
      <JsonLd
        nonce={nonce}
        data={breadcrumbLd([
          { name: crumbs('home'), url: pageUrl(site, locale, '/') },
          { name: title, url: pageUrl(site, locale, '/contacts') },
        ])}
      />
      <Breadcrumbs
        label={crumbs('label')}
        items={[
          { label: crumbs('home'), href: localizedPath(locale, '/') },
          { label: title, href: null },
        ]}
      />
      <div
        className={cn(
          LANDING_CONTAINER,
          'flex flex-col gap-8 pt-[clamp(20px,3vw,40px)] pb-[clamp(48px,6vw,96px)]',
        )}
      >
        <div className="flex max-w-[640px] flex-col gap-3">
          <h1 className={LANDING_H2}>{title}</h1>
          {/* The landing's approved sentence about support ("Nega biz?"): no new promise here. */}
          <p className={LANDING_LEAD}>{why('text')}</p>
        </div>
        <ul className="m-0 grid list-none grid-cols-[repeat(auto-fit,minmax(min(100%,260px),1fr))] gap-4 p-0">
          {contactCards(siteLinks()).map((card) => (
            <ContactCardItem key={card.kind} view={view(card)} />
          ))}
        </ul>
      </div>
    </main>
  );
}
