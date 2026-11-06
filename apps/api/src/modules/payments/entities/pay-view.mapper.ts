import { PayViewSchema, maskOwnerHint, type PayView } from '@repo/shared';
import type { IntentWithCard } from '../topup-intents.repository';
import { cardWhilePending } from './intent.mapper';

export interface PayViewOwner {
  readonly firstName: string | null;
  readonly username: string | null;
}

/**
 * What a pay-link token may read (D-39) and nothing more: no user id, username, balance, ledger
 * or other intents; the owner only as a masked hint (`S***r`). Keys are an allowlist, checked
 * by the strict shared schema and pinned by a snapshot test.
 */
export function toPayView(row: IntentWithCard, owner: PayViewOwner): PayView {
  if (row.baseAmountTiyin === null) throw new Error(`P2P intent ${row.id} has no base amount`);
  return PayViewSchema.parse({
    intentId: row.id,
    status: row.status,
    baseAmountTiyin: row.baseAmountTiyin.toString(),
    payAmountTiyin: row.amountTiyin.toString(),
    card: cardWhilePending(row),
    expiresAt: row.expiresAt.toISOString(),
    ownerHint: maskOwnerHint(owner.firstName, owner.username),
    currency: 'UZS',
  });
}
