import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// SYNTHETIC values only (plan S5, E-29): never a real card ending, amount, balance, time,
// channel or name from a screenshot or a log.
export const FIXTURE_HEADER = '# SYNTHETIC — structure only';

export const SYN = {
  humoAmount: '20.341,00 UZS',
  uzcardAmount: '20 341.00 UZS',
  amountTiyin: 2_034_100n,
  humoBalance: '123.456,78 UZS',
  humoBalanceTiyin: 12_345_678n,
  uzcardBalance: '987 654.32 UZS',
  uzcardBalanceTiyin: 98_765_432n,
  humoCard: 'HUMOCARD *0000',
  uzcardCard: '***1111',
  humoTime: '12:00 01.01.2030',
  uzcardTime: '01.01.30 12:00',
  // 12:00 in Tashkent (UTC+5) is 07:00 UTC.
  instant: new Date('2030-01-01T07:00:00.000Z'),
  humoChannel: 'TEST P2P>SHAHAR',
  uzcardChannel: 'TEST BANK P2P, UZ',
} as const;

/** Fixture text without its header line; fails loudly when the header is missing. */
export function loadFixture(name: string): string {
  const raw = readFileSync(join(__dirname, '..', '__fixtures__', name), 'utf8');
  const breakAt = raw.indexOf('\n');
  const header = raw.slice(0, breakAt).replace(/\r$/, '');
  if (header !== FIXTURE_HEADER) throw new Error(`${name}: missing synthetic header`);
  return raw.slice(breakAt + 1);
}

export interface MessageParts {
  title?: string | null;
  direction?: string;
  channel?: string | null;
  card?: string;
  time?: string;
  balance?: string;
}

/** A Humo-shaped message from synthetic parts; `null` drops a line. */
export function humoMessage(parts: MessageParts = {}): string {
  const lines = [
    parts.title === undefined ? "\u{1F514} To'ldirish" : parts.title,
    parts.direction ?? `\u2795 ${SYN.humoAmount}`,
    parts.channel === undefined ? `\u{1F4CD} ${SYN.humoChannel}` : parts.channel,
    parts.card ?? `\u{1F4B3} ${SYN.humoCard}`,
    parts.time ?? `\u{1F55B} ${SYN.humoTime}`,
    parts.balance ?? `\u{1F4B0} ${SYN.humoBalance}`,
  ];
  return lines.filter((line): line is string => line !== null).join('\n');
}

/** An Uzcard-shaped credit message from synthetic parts; `null` drops a line. */
export function uzcardMessage(parts: MessageParts = {}): string {
  const lines = [
    parts.title === undefined ? '\u{1F7E2} Perevod na kartu' : parts.title,
    parts.direction ?? `\u2795 ${SYN.uzcardAmount}`,
    parts.card ?? `\u{1F4B3} ${SYN.uzcardCard}`,
    parts.channel === undefined ? `\u{1F4CD} ${SYN.uzcardChannel}` : parts.channel,
    parts.time ?? `\u{1F550} ${SYN.uzcardTime}`,
    parts.balance ?? `\u{1F4B5} ${SYN.uzcardBalance}`,
  ];
  return lines.filter((line): line is string => line !== null).join('\n');
}

export function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [
      item,
      ...rest,
    ]),
  );
}

/** Deterministic PRNG (LCG) so a fuzz failure is reproducible from its seed. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}
