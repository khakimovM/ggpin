import type { BankFeedSource } from '@repo/shared';
import type { ParsedBankMessage } from '../parse-result';
import { SYN } from './synthetic';

// Expected parse of every fixture file (synthetic values, see ./synthetic).
const humo = (
  direction: 'CREDIT' | 'DEBIT',
  overrides: Partial<ParsedBankMessage> = {},
): ParsedBankMessage => ({
  ok: true,
  direction,
  amountTiyin: SYN.amountTiyin,
  balanceAfterTiyin: SYN.humoBalanceTiyin,
  last4: '0000',
  bankTxnAt: SYN.instant,
  channel: SYN.humoChannel,
  titleHint: direction,
  titleKnown: true,
  ...overrides,
});

const uzcard = (
  direction: 'CREDIT' | 'DEBIT',
  last4: '1111' | '9999',
  overrides: Partial<ParsedBankMessage> = {},
): ParsedBankMessage => ({
  ok: true,
  direction,
  amountTiyin: SYN.amountTiyin,
  balanceAfterTiyin: SYN.uzcardBalanceTiyin,
  last4,
  bankTxnAt: SYN.instant,
  channel: SYN.uzcardChannel,
  titleHint: direction,
  titleKnown: true,
  ...overrides,
});

export const FIXTURE_EXPECTATIONS: ReadonlyArray<
  readonly [string, BankFeedSource, ParsedBankMessage]
> = [
  ['humo.uz.credit.txt', 'HUMO_BOT', humo('CREDIT')],
  ['humo.uz.debit.txt', 'HUMO_BOT', humo('DEBIT')],
  // humo.ru.* titles are ASSUMED (to be confirmed in S11).
  ['humo.ru.credit.txt', 'HUMO_BOT', humo('CREDIT')],
  ['humo.ru.debit.txt', 'HUMO_BOT', humo('DEBIT')],
  ['uzcard.ru.credit.txt', 'UZCARD_BOT', uzcard('CREDIT', '1111')],
  ['uzcard.ru.debit-purchase.txt', 'UZCARD_BOT', uzcard('DEBIT', '9999')],
  ['uzcard.ru.debit-ecom.txt', 'UZCARD_BOT', uzcard('DEBIT', '9999')],
  // uzcard.uz.* title is ASSUMED (to be confirmed in S11).
  ['uzcard.uz.credit.txt', 'UZCARD_BOT', uzcard('CREDIT', '1111')],
  ['uzcard.ru.multiline-channel.txt', 'UZCARD_BOT', uzcard('CREDIT', '1111')],
  ['edge.humo.fe0f.txt', 'HUMO_BOT', humo('CREDIT')],
  ['edge.humo.alt-markers.txt', 'HUMO_BOT', humo('DEBIT')],
  ['edge.humo.nbsp.txt', 'HUMO_BOT', humo('CREDIT')],
  ['edge.humo.no-title.txt', 'HUMO_BOT', humo('CREDIT', { titleHint: null, titleKnown: false })],
  ['edge.uzcard.alt-markers.txt', 'UZCARD_BOT', uzcard('CREDIT', '1111')],
  ['edge.uzcard.thin-space.txt', 'UZCARD_BOT', uzcard('CREDIT', '1111')],
  ['edge.uzcard.crlf-blank-lines.txt', 'UZCARD_BOT', uzcard('CREDIT', '1111')],
];
