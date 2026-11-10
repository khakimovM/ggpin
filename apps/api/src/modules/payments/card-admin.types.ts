import type { TopupCardStatus } from '@repo/db';
import type { CardAdminActor, CheckedActor } from './card-admin.input';

export interface AddCardInput {
  readonly bank: string;
  readonly pan: string;
  readonly holderName: string;
  /** Required (D-37 (6)): what the card may receive over its whole life, tiyin. */
  readonly limitTiyin: bigint;
  readonly monthlyLimitTiyin?: bigint;
  readonly reason: string;
  readonly actor: CardAdminActor;
}

export interface CardChange {
  /**
   * False when nothing was written and no audit row exists: the card was already in the
   * requested state. (card:pause of a paused card is applied: it records the owner's decision.)
   */
  readonly applied: boolean;
  readonly cardId: string;
  readonly status: TopupCardStatus;
  readonly auditId: string | null;
  /** Every owner alert of an applied change is queued (false if not applied or Redis failed). */
  readonly alertQueued: boolean;
}

export type Committed<T extends CardChange> = Omit<T, 'alertQueued'>;

export interface AddedCard extends CardChange {
  /** The owner sends exactly this to the card; its bank message moves the card to ACTIVE. */
  readonly verifyAmountTiyin: bigint;
  /**
   * Born paused under an open security pause (D-52 D2, r2 I-B): the CLI warns the owner to check
   * the bank-feed account and card:resume BEFORE sending the verify transfer.
   */
  readonly autoCreditPaused: boolean;
}

export type AuditExtra = Record<string, string | number | boolean | null>;

export interface CardAudit {
  readonly action: string;
  readonly reason: string;
  readonly actor: CheckedActor;
}
