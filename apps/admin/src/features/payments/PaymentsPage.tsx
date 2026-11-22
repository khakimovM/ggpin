import { useSearchParams } from 'react-router';
import { useTranslations } from 'use-intl';
import { PageHeader } from '../common/PageHeader';
import { SectionGate } from '../common/SectionGate';
import { UnderlineTabs } from '../common/UnderlineTabs';
import { BankMessageDrawer } from './BankMessageDrawer';
import { CardsTab } from './CardsTab';
import { IntentsTab } from './IntentsTab';
import { PaymentRowsTab } from './PaymentRowsTab';
import { ReviewDrawer } from './ReviewDrawer';
import { ReviewsTab } from './ReviewsTab';

// Q9: the design's provider payments become the P2P card flow — the review queue first (what
// needs the owner), then credited payments, top-up requests and our receiving cards.
const TABS = ['reviews', 'payments', 'intents', 'cards'] as const;

function Payments() {
  const t = useTranslations();
  const [search] = useSearchParams();
  const raw = search.get('tab');
  const tab = TABS.find((id) => id === raw) ?? 'reviews';
  return (
    <>
      <PageHeader title={t('admin.nav.payments')} sub={t('admin.payments.sub')} />
      <UnderlineTabs
        label={t('admin.payments.tabs.label')}
        value={tab}
        tabs={TABS.map((id) => ({ id, label: t(`admin.payments.tabs.${id}`) }))}
      />
      {tab === 'reviews' ? <ReviewsTab /> : null}
      {tab === 'payments' ? <PaymentRowsTab /> : null}
      {tab === 'intents' ? <IntentsTab /> : null}
      {tab === 'cards' ? <CardsTab /> : null}
      <ReviewDrawer />
      <BankMessageDrawer />
    </>
  );
}

export function PaymentsPage() {
  const t = useTranslations();
  return (
    <SectionGate permission="payments.read" title={t('admin.nav.payments')}>
      <Payments />
    </SectionGate>
  );
}
