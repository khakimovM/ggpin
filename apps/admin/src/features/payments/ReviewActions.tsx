import type { AdminReviewDetailResponse } from '@repo/shared';
import { Button, Icon } from '@repo/ui';
import { BadgeCheck, Terminal } from 'lucide-react';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { useAdminAction } from '../common/use-admin-action';
import { ReviewCreditDialog } from './ReviewCreditDialog';
import { isCreditable } from './review-credit-model';

/**
 * What an OPEN review offers in the panel: "Hisobga o‘tkazish" (OWNER) when its message is a
 * parsed credit. Every other way to close a review (ignore, chain accepted, returned offline)
 * stays with the owner CLI (docs/04), so there is no "ignore" button.
 */
export function ReviewActions({ review }: { review: AdminReviewDetailResponse }) {
  const t = useTranslations();
  const act = useAdminAction();
  const [open, setOpen] = useState(false);
  const canCredit = act.can('payments.reviewCredit') && isCreditable(review);
  return (
    <div className="flex flex-wrap items-center gap-2">
      {canCredit ? (
        <Button size="sm" onClick={() => setOpen(true)}>
          <Icon icon={BadgeCheck} size={14} />
          {t('admin.payments.review.credit')}
        </Button>
      ) : null}
      <span className="flex items-center gap-1.5 text-[11px] leading-4 font-semibold text-foreground-muted">
        <Icon icon={Terminal} size={13} />
        {canCredit ? t('admin.payments.review.otherCli') : t('admin.payments.review.cliOnly')}
      </span>
      <ReviewCreditDialog review={review} open={open} onOpenChange={setOpen} />
    </div>
  );
}
