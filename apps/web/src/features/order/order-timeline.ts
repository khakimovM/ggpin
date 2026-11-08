import type { OrderDetail, OrderStatus } from '@repo/shared';
import type { TimelineState, TimelineTone } from '@repo/ui';

// The steps of the order page (Checkout.dc.html `order`): To‘landi, Navbatda, Bajarilmoqda,
// Yetkazildi on the happy path; a step under review, a failure or a cancellation replaces the tail.
// The times are the ones the server recorded (`timeline[]`); nothing is invented for a step that
// has not happened.

export type StepId =
  'paid' | 'queued' | 'processing' | 'delivered' | 'review' | 'failed' | 'cancelled' | 'refunded';

export interface TimelineStep {
  id: StepId;
  state: TimelineState;
  tone?: TimelineTone;
  /** When the order entered this step (ISO), when it did. */
  at: string | null;
}

function enteredAt(detail: OrderDetail, statuses: readonly OrderStatus[]): string | null {
  const entry = detail.timeline.find((item) => statuses.includes(item.status));
  return entry?.at ?? null;
}

export function buildSteps(detail: OrderDetail): TimelineStep[] {
  const { status } = detail;
  const paid: TimelineStep = { id: 'paid', state: 'done', at: enteredAt(detail, ['PAID']) };
  const queuedAt = enteredAt(detail, ['QUEUED']);
  const processingAt = enteredAt(detail, ['PROCESSING']);

  switch (status) {
    case 'PAID':
    case 'QUEUED':
    case 'PROCESSING':
    case 'DELIVERED': {
      const order: StepId[] = ['paid', 'queued', 'processing', 'delivered'];
      const current =
        status === 'PAID' ? 0 : status === 'QUEUED' ? 1 : status === 'PROCESSING' ? 2 : 3;
      const times = [paid.at, queuedAt, processingAt, enteredAt(detail, ['DELIVERED'])];
      return order.map((id, index) => ({
        id,
        // Everything done once delivered; before that the current step spins and later ones wait.
        state:
          status === 'DELIVERED' || index < current
            ? 'done'
            : index === current
              ? 'active'
              : 'pending',
        at: index <= current ? (times[index] ?? null) : null,
      }));
    }
    case 'HELD':
    case 'NEEDS_REVIEW':
      return [
        paid,
        { id: 'queued', state: 'done', at: queuedAt },
        {
          id: 'review',
          state: 'active',
          tone: 'warning',
          at: enteredAt(detail, ['HELD', 'NEEDS_REVIEW']),
        },
        { id: 'delivered', state: 'pending', at: null },
      ];
    case 'FAILED':
    case 'REFUNDED': {
      const steps: TimelineStep[] = [paid];
      if (queuedAt !== null) steps.push({ id: 'queued', state: 'done', at: queuedAt });
      if (processingAt !== null) steps.push({ id: 'processing', state: 'done', at: processingAt });
      steps.push({
        id: 'failed',
        state: 'done',
        tone: 'danger',
        at: enteredAt(detail, ['FAILED']),
      });
      steps.push({
        id: 'refunded',
        state: 'done',
        tone: 'refund',
        // No REFUNDED entry yet (a FAILED order not yet marked REFUNDED): no time rather than a made-up one.
        at: enteredAt(detail, ['REFUNDED']),
      });
      return steps;
    }
    case 'CANCELLED':
      return [
        paid,
        { id: 'cancelled', state: 'done', tone: 'muted', at: enteredAt(detail, ['CANCELLED']) },
        { id: 'refunded', state: 'done', tone: 'refund', at: enteredAt(detail, ['REFUNDED']) },
      ];
  }
}
