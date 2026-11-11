import { NextIntlClientProvider } from 'next-intl';
import { payLocaleOf } from '../../../features/pay/pay-locale';
import { PayPage } from '../../../features/pay/PayPage';
import { MESSAGES } from '../../../i18n/messages';

type Query = Record<string, string | string[] | undefined>;

// The token is in the URL fragment, which the server never sees: the server renders the shell
// (header, skeleton) in the right language and the client takes over after hydration. The provider
// is HERE, not in the layout: a language switch is a navigation to the same page with another
// `?locale=`, and a layout is not rendered again for that.
export default async function PayRoute({
  params,
  searchParams,
}: {
  params: Promise<{ intentId: string }>;
  searchParams: Promise<Query>;
}) {
  const { intentId } = await params;
  const locale = payLocaleOf(await searchParams);
  const { common, errors, pay } = MESSAGES[locale];
  return (
    <NextIntlClientProvider locale={locale} messages={{ common, errors, pay }}>
      <PayPage intentId={intentId} />
    </NextIntlClientProvider>
  );
}
