import type { AdminPaymentRow } from '@repo/shared';
import { Button } from '@repo/ui';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { useAdminAction } from '../common/use-admin-action';
import { ReversePaymentDialog } from './ReversePaymentDialog';

/** The row action of a top-up: "Qaytarish" for a confirmed one, OWNER only (UX; the API checks). */
export function PaymentActionCell({ payment }: { payment: AdminPaymentRow }) {
  const t = useTranslations();
  const act = useAdminAction();
  const [open, setOpen] = useState(false);
  if (payment.status !== 'CONFIRMED' || !act.can('payments.reverse')) return null;
  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        {t('admin.payments.reverse.action')}
      </Button>
      <ReversePaymentDialog payment={payment} open={open} onOpenChange={setOpen} />
    </>
  );
}
