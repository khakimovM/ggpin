import { TASHKENT_UTC_OFFSET_MINUTES, type BankDirection, type BankFeedSource } from '@repo/shared';

// SYNTHETIC bank notifications for BANK_FEED_MODE=fake (dev and e2e, E-29): the STRUCTURE of the
// two bots (docs/05 §5, the parser fixtures), with the values the operator gives and a made-up
// channel. Never a real card, balance, time, channel or name.

export interface InjectSpec {
  readonly source: BankFeedSource;
  readonly direction: BankDirection;
  readonly amountTiyin: bigint;
  readonly balanceAfterTiyin: bigint;
  readonly last4: string;
  readonly at: Date;
}

const THOUSANDS = /\B(?=(\d{3})+$)/g;
const two = (n: number): string => String(n).padStart(2, '0');

/** The bank's own number layout (not our display format): Humo "1.234,50", Uzcard "1 234.50". */
function bankAmount(tiyin: bigint, source: BankFeedSource): string {
  if (tiyin < 0n) throw new RangeError('a bank amount is never negative');
  const humo = source === 'HUMO_BOT';
  const som = (tiyin / 100n).toString().replace(THOUSANDS, humo ? '.' : ' ');
  const cents = (tiyin % 100n).toString().padStart(2, '0');
  return `${som}${humo ? ',' : '.'}${cents} UZS`;
}

function tashkent(at: Date): Date {
  return new Date(at.getTime() + TASHKENT_UTC_OFFSET_MINUTES * 60_000);
}

function humoTime(at: Date): string {
  const t = tashkent(at);
  return `${two(t.getUTCHours())}:${two(t.getUTCMinutes())} ${two(t.getUTCDate())}.${two(t.getUTCMonth() + 1)}.${String(t.getUTCFullYear())}`;
}

function uzcardTime(at: Date): string {
  const t = tashkent(at);
  return `${two(t.getUTCDate())}.${two(t.getUTCMonth() + 1)}.${two(t.getUTCFullYear() % 100)} ${two(t.getUTCHours())}:${two(t.getUTCMinutes())}`;
}

export function syntheticBankText(spec: InjectSpec): string {
  if (!/^\d{4}$/.test(spec.last4)) throw new RangeError('last4 must be 4 digits');
  const credit = spec.direction === 'CREDIT';
  const sign = credit ? '➕' : '➖';
  const amount = bankAmount(spec.amountTiyin, spec.source);
  const balance = bankAmount(spec.balanceAfterTiyin, spec.source);
  if (spec.source === 'HUMO_BOT') {
    return [
      credit ? "\u{1F514} To'ldirish" : "\u{1F514} To'lov",
      `${sign} ${amount}`,
      '\u{1F4CD} TEST P2P>SHAHAR',
      `\u{1F4B3} HUMOCARD *${spec.last4}`,
      `\u{1F55B} ${humoTime(spec.at)}`,
      `\u{1F4B0} ${balance}`,
    ].join('\n');
  }
  return [
    credit ? '\u{1F7E2} Perevod na kartu' : '\u{1F534} Pokupka',
    `${sign} ${amount}`,
    `\u{1F4B3} ***${spec.last4}`,
    '\u{1F4CD} TEST BANK P2P, UZ',
    `\u{1F550} ${uzcardTime(spec.at)}`,
    `\u{1F4B5} ${balance}`,
  ].join('\n');
}
