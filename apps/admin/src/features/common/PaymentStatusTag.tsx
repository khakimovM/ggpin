import type { PAYMENT_STATUSES } from '@repo/shared';

type PaymentStatus = (typeof PAYMENT_STATUSES)[number];
import { Tag, type TagTone } from './Tag';

const TONE: Record<PaymentStatus, TagTone> = {
  CREATED: 'warn',
  CONFIRMED: 'ok',
  CANCELLED: 'bad',
};

/** A payment's status as the API names it (CREATED / CONFIRMED / CANCELLED). */
export function PaymentStatusTag({ status }: { status: PaymentStatus }) {
  return <Tag tone={TONE[status]}>{status}</Tag>;
}
