import type { LedgerKind } from '@repo/shared';
import { Gift, ShoppingBag, SlidersHorizontal, Undo2, Wallet, type LucideIcon } from 'lucide-react';

export interface LedgerLook {
  icon: LucideIcon;
  /** Classes of the icon's square: background and icon colour (Account.dc.html `FI`). */
  tone: string;
}

const NEUTRAL = 'bg-muted text-foreground-secondary';
const CREDIT = 'bg-success-soft text-success';
const BONUS = 'bg-accent-soft text-accent-soft-foreground';

// Account.dc.html draws a purchase, a top-up, a refund and the two bonus kinds. The reversals and
// the admin adjustment have no frame in the design; they get the neutral square so that they never
// pass for money received.
export const LEDGER_LOOK: Record<LedgerKind, LedgerLook> = {
  PURCHASE: { icon: ShoppingBag, tone: NEUTRAL },
  TOPUP: { icon: Wallet, tone: CREDIT },
  REFUND: { icon: Undo2, tone: CREDIT },
  REFERRAL_BONUS: { icon: Gift, tone: BONUS },
  TOPUP_REVERSAL: { icon: Undo2, tone: NEUTRAL },
  REFERRAL_BONUS_REVERSAL: { icon: Gift, tone: NEUTRAL },
  ADJUSTMENT: { icon: SlidersHorizontal, tone: NEUTRAL },
};

/** Money in is green with a plus; money out is plain with a minus (a debit is never red). */
export function isCredit(amountTiyin: string): boolean {
  return !amountTiyin.startsWith('-') && amountTiyin !== '0';
}
