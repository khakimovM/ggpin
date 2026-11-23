import type { PAYMENT_STATUSES } from '@repo/shared';
import { useTranslations } from 'use-intl';
import { Tag, type TagTone } from './Tag';

type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

const TONE: Record<PaymentStatus, TagTone> = {
  CREATED: 'warn',
  CONFIRMED: 'ok',
  CANCELLED: 'bad',
};

/** A payment's status in words (CREATED / CONFIRMED / CANCELLED from the API, never shown raw). */
export function PaymentStatusTag({ status }: { status: PaymentStatus }) {
  const t = useTranslations();
  return <Tag tone={TONE[status]}>{t(`admin.payments.paymentStatus.${status}`)}</Tag>;
}
