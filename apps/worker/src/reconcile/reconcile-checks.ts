import { chainVerdict } from '../bank-feed/match-rules';
import { EXAMPLE_IDS, type Finding, type WindowMessage } from './reconcile.repository';

// Pure rules of the daily reconciliation (docs/05 §10). No I/O: the service reads the window's
// rows and hands them in. Every verdict names ids, never an amount, a balance or a text.
// (Messages without a decision are counted by the repository over ALL time, not here: a stuck
// message must not drop out of the report after 48 h.)

/** Up to EXAMPLE_IDS ids and the full count. */
export function findingOf(ids: readonly string[]): Finding {
  return { count: ids.length, ids: ids.slice(0, EXAMPLE_IDS) };
}

/**
 * Per card: the received CREDIT sum must equal what its decisions account for: CREDITED (a
 * payment of exactly the message amount), CARD_VERIFIED, or REVIEW. A CREDIT with no outcome,
 * a wrong outcome (DEBIT_RECORDED) or a payment of another amount leaves the card unaccounted.
 * A message stored after `settledBefore` without a decision yet is skipped: its job may be
 * running right now (if it never gets one, the all-time missingOutcome count reports it).
 * Messages without a card are left to missingOutcome. Returns the card ids.
 */
export function creditUnaccounted(
  messages: readonly WindowMessage[],
  settledBefore: Date,
): Finding {
  const sums = new Map<string, { received: bigint; accounted: bigint }>();
  for (const m of messages) {
    if (m.parseStatus !== 'PARSED' || m.direction !== 'CREDIT' || m.cardId === null) continue;
    if (m.outcome === null && m.createdAt >= settledBefore) continue;
    const amount = m.amountTiyin ?? 0n;
    const sum = sums.get(m.cardId) ?? { received: 0n, accounted: 0n };
    sum.received += amount;
    if (isAccounted(m, amount)) sum.accounted += amount;
    sums.set(m.cardId, sum);
  }
  return findingOf(
    [...sums].filter(([, s]) => s.received !== s.accounted).map(([cardId]) => cardId),
  );
}

function isAccounted(m: WindowMessage, amount: bigint): boolean {
  const outcome = m.outcome;
  if (outcome === null) return false;
  if (outcome.outcome === 'CARD_VERIFIED' || outcome.outcome === 'REVIEW') return true;
  return outcome.outcome === 'CREDITED' && outcome.payment?.amountTiyin === amount;
}

export interface ChainCheck {
  /** Gaps nobody has looked at yet: the mismatch. */
  readonly breaks: Finding;
  /** Gaps whose CHAIN_BREAK review the owner already resolved (any resolution): information. */
  readonly reviewed: number;
}

/**
 * The balance chain recomputed over the window (the matcher's `chainVerdict`): per card, every
 * PARSED message against the previous PARSED one (`firstLinks` gives the link before the
 * window). A gap whose CHAIN_BREAK review is RESOLVED (accepted, credited, ignored or returned:
 * the owner has seen it) is counted as `reviewed`, not as a mismatch, or every later day would
 * report the same old gap again. A message recovered by the re-scan closes the gap it caused, so
 * a chain that is whole now is not reported. `breaks` names the messages right after a gap.
 */
export function chainBreaks(
  messages: readonly WindowMessage[],
  firstLinks: ReadonlyMap<string, bigint | null>,
): ChainCheck {
  const breaks: string[] = [];
  let reviewed = 0;
  const last = new Map<string, bigint | null>(firstLinks);
  for (const m of messages) {
    if (m.parseStatus !== 'PARSED' || m.cardId === null) continue;
    if (m.direction === null || m.amountTiyin === null || m.balanceAfterTiyin === null) continue;
    const previous = last.get(m.cardId) ?? null;
    const verdict = chainVerdict(previous === null ? null : { balanceAfterTiyin: previous }, {
      direction: m.direction,
      amountTiyin: m.amountTiyin,
      balanceAfterTiyin: m.balanceAfterTiyin,
    });
    last.set(m.cardId, m.balanceAfterTiyin);
    if (verdict !== 'BREAK') continue;
    const seen = m.reviews.some((r) => r.kind === 'CHAIN_BREAK' && r.status === 'RESOLVED');
    if (seen) reviewed += 1;
    else breaks.push(m.id);
  }
  return { breaks: findingOf(breaks), reviewed };
}

/** One card's DEBIT summary: how many left it in the window and their sum (tiyin, as a string). */
export type CardDebits = {
  readonly count: number;
  readonly sumTiyin: string;
};

/**
 * The DEBIT summary of the window per card (docs/05 §10). For the owner's audit row only: the
 * alert carries the total count, never a sum.
 */
export function debitsByCard(messages: readonly WindowMessage[]): Record<string, CardDebits> {
  const sums = new Map<string, { count: number; sum: bigint }>();
  for (const m of messages) {
    if (m.parseStatus !== 'PARSED' || m.direction !== 'DEBIT') continue;
    const key = m.cardId ?? 'unknownCard';
    const entry = sums.get(key) ?? { count: 0, sum: 0n };
    entry.count += 1;
    entry.sum += m.amountTiyin ?? 0n;
    sums.set(key, entry);
  }
  return Object.fromEntries(
    [...sums].map(([card, e]) => [card, { count: e.count, sumTiyin: e.sum.toString() }]),
  );
}

/** The first PARSED message of each card in the window (where the chain is linked from). */
export function firstParsedPerCard(messages: readonly WindowMessage[]): Map<string, bigint> {
  const first = new Map<string, bigint>();
  for (const m of messages) {
    if (m.parseStatus === 'PARSED' && m.cardId !== null && !first.has(m.cardId)) {
      first.set(m.cardId, m.tgMessageId);
    }
  }
  return first;
}
