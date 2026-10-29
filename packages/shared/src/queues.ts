// BullMQ queue names, docs/02-ARCHITECTURE.md "Navbatlar". A typo in a queue name silently
// strands jobs, so producers (api) and consumers (worker) both import these.
export const QUEUES = {
  FULFILL_ORDER: 'fulfill-order',
  VALIDATE_RECIPIENT: 'validate-recipient',
  PRICE_SYNC: 'price-sync',
  FRAGMENT_KEEPALIVE: 'fragment-keepalive',
  RECONCILE: 'reconcile',
  TG_OUTBOX: 'tg-outbox',
  PAYMENT_RECONCILE: 'payment-reconcile',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];
