import { randomBytes } from 'node:crypto';
import { appendLedgerEntry, type OrderStatus, type Prisma, type PrismaClient } from '@repo/db';
import { fixtureCatalog, fixtureQuote, moveOrder, paidOrder } from './admin-fixture-orders';

// Orders for the I-5 suites (phase 9 S7a): an order of the user in `status`, on the persistent
// `oo-fixture` catalog (admin-fixture-orders.ts), built the way the purchase and the worker build
// them (D-60): Order(PAID) with its PURCHASE of -price. A real purchase needs the money first
// (422 INSUFFICIENT_BALANCE otherwise), so the fixture funds it with an ADJUSTMENT of +price
// (ADMIN_ACTION/oo-…) just before: the user's balance is what it was, never negative, and an
// adjustment under test never meets a debt (wallet-admin.steps.ts would freeze the account).
// A REFUNDED order is not funded: its REFUND returns the debit, so the user ends where they began
// (funding it would leave a lasting credit of the price).

/** The default price of a fixture order. */
export const OPEN_ORDER_PRICE = 1_600_000n;

/** The prefix of the funding ADJUSTMENT's refId (an AuditLog id never starts with it). */
const FUNDING_REF = 'oo-';

/**
 * The ledger entries the fixture did NOT write: not an order's PURCHASE / REFUND (refType ORDER;
 * an admin adjustment is ADMIN_ACTION) and not a funding ADJUSTMENT. What a suite counts as
 * "written by the action under test".
 */
export const NOT_FIXTURE_ENTRY: Prisma.LedgerEntryWhereInput = {
  NOT: [{ refType: 'ORDER' }, { refId: { startsWith: FUNDING_REF } }],
};

export interface OpenOrderRow {
  readonly id: string;
  readonly number: number;
}

export async function orderOf(
  db: PrismaClient,
  userId: string,
  status: OrderStatus,
  priceTiyin = OPEN_ORDER_PRICE,
): Promise<OpenOrderRow> {
  const catalog = await fixtureCatalog(db, 'oo-');
  const quote = await fixtureQuote(db, catalog, userId, {
    priceTiyin,
    recipient: { username: 'someone', displayName: 'Some One' },
  });
  if (status !== 'REFUNDED') {
    await db.$transaction((tx) =>
      appendLedgerEntry(tx, {
        userId,
        kind: 'ADJUSTMENT',
        amountTiyin: priceTiyin,
        refType: 'ADMIN_ACTION',
        refId: `${FUNDING_REF}${randomBytes(8).toString('hex')}`,
      }),
    );
  }
  const order = await paidOrder(db, quote, 'oo-');
  await moveOrder(db, order.id, status);
  return order;
}

/**
 * Moves the order on to `status` along a legal path, as the worker or an operator would (a HELD
 * order to REFUNDED goes through FAILED and the refund helper, which writes the REFUND entry).
 */
export async function setOrderStatus(
  db: PrismaClient,
  orderId: string,
  status: OrderStatus,
): Promise<void> {
  await moveOrder(db, orderId, status);
}

/** The account's purchase freeze flag (D-41: a negative balance after an adjustment raises it). */
export async function purchaseFrozen(db: PrismaClient, userId: string): Promise<boolean> {
  const user = await db.user.findUniqueOrThrow({
    where: { id: userId },
    select: { purchaseFrozen: true },
  });
  return user.purchaseFrozen;
}
