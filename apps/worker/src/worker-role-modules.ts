import type { Type } from '@nestjs/common';
import { QUEUES, type QueueName, type WorkerRole } from '@repo/shared';
import { FragmentSessionModule } from './adapters/fragment/fragment-session.module';
import { BankFeedModule } from './bank-feed/bank-feed.module';
import { TopupExpireModule } from './bank-feed/topup-expire.module';
import { FulfillmentModule } from './fulfillment/fulfillment.module';
import { PricingSyncModule } from './pricing-sync/pricing-sync.module';
import { OrderReconcileModule } from './reconcile/orders/order-reconcile.module';
import { ReconcileModule } from './reconcile/reconcile.module';
import { RecipientsModule } from './recipients/recipients.module';
import { TonModule } from './ton/ton.module';

// D-76: the worker image runs as two containers. A module of the side that does not run is not in
// the Nest graph at all, so none of its providers is built: no TON wallet factory, no Fragment
// session key, no bank-feed client (and so no @mtcute/node, no native better-sqlite3). The env
// loader is the first wall (it never reads the other side's key files); this is the second.

/** Value out: price/FX sync, the hot wallet, fulfill-order, recipients, Fragment, order reconcile. */
export const FULFILLMENT_ROLE_MODULES: readonly Type[] = [
  PricingSyncModule,
  // Phase 5 S5: the hot wallet (dry run: a throw-away key on a fake chain, plan §8).
  TonModule,
  // Phase 5 S4: the fulfill-order consumer (dry run: simulators + the in-memory chain).
  FulfillmentModule,
  // Phase 5 S3b: the validate-recipient consumer (dry run: the simulators' lookups).
  RecipientsModule,
  // Phase 5 S7: the Fragment session keep-alive (dry run: a synthetic page, no cookie read).
  FragmentSessionModule,
  // Phase 5 S9: the order reconciler (`reconcile:orders`; never signs, never pays).
  OrderReconcileModule,
];

/**
 * Value in (D-76 Q1 = A): the bank-feed listener and its history re-scan, ingest, the matcher
 * (TOPUP), card limits, top-up expiry and the daily payment reconciliation. The re-scan needs the
 * leader's MTProto client, so the reconciliation lives with the listener.
 */
export const BANK_FEED_ROLE_MODULES: readonly Type[] = [
  BankFeedModule,
  TopupExpireModule,
  ReconcileModule,
];

/** The queues each side consumes (docs/02; the wiring test checks this against the graph). */
const FULFILLMENT_QUEUES: readonly QueueName[] = [
  QUEUES.PRICE_SYNC,
  QUEUES.FULFILL_ORDER,
  QUEUES.VALIDATE_RECIPIENT,
  QUEUES.FRAGMENT_KEEPALIVE,
  QUEUES.RECONCILE,
];
const BANK_FEED_QUEUES: readonly QueueName[] = [
  QUEUES.BANK_MESSAGE,
  QUEUES.CARD_LIMIT,
  QUEUES.TOPUP_EXPIRE,
  QUEUES.PAYMENT_RECONCILE,
];

export function roleModules(role: WorkerRole): readonly Type[] {
  if (role === 'fulfillment') return FULFILLMENT_ROLE_MODULES;
  if (role === 'bankfeed') return BANK_FEED_ROLE_MODULES;
  return [...FULFILLMENT_ROLE_MODULES, ...BANK_FEED_ROLE_MODULES];
}

export function roleQueues(role: WorkerRole): readonly QueueName[] {
  if (role === 'fulfillment') return FULFILLMENT_QUEUES;
  if (role === 'bankfeed') return BANK_FEED_QUEUES;
  return [...FULFILLMENT_QUEUES, ...BANK_FEED_QUEUES];
}

export interface WorkerStartedFacts {
  readonly WORKER_ROLE: WorkerRole;
  readonly FULFILLMENT_DRY_RUN: boolean;
  readonly TON_NETWORK: string;
  readonly BANK_FEED_MODE: string;
}

/**
 * The boot log line (SA F-7): names and switches only, never a secret; each side's switches only
 * where that side runs, so a bankfeed log never shows a "dryRun" it does not act on. The operator
 * checks `role=` after every deploy (D-76).
 */
export function workerStartedLine(env: WorkerStartedFacts, queuesRegistered: number): string {
  const role = env.WORKER_ROLE;
  const parts = [
    `role=${role}`,
    `consumers=${roleQueues(role).join(',')}`,
    `${String(queuesRegistered)} queues registered`,
  ];
  if (role !== 'bankfeed') {
    parts.push(`dryRun=${String(env.FULFILLMENT_DRY_RUN)}`, `ton=${env.TON_NETWORK}`);
  }
  if (role !== 'fulfillment') parts.push(`bankFeed=${env.BANK_FEED_MODE}`);
  return `worker started (${parts.join(', ')})`;
}
