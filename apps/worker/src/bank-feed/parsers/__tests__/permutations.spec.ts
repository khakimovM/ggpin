import { parseBankMessage } from '../parse-bank-message';
import { FIXTURE_EXPECTATIONS } from './expectations';
import { SYN, humoMessage, loadFixture, permutations } from './synthetic';

// Title emojis used by the fixtures. The title is structurally the FIRST line, so it stays put;
// every other line block moves. A line starting with a letter continues the block above it
// (the Uzcard multi-line channel), so a channel moves together with its continuation lines.
const TITLE_START = /^(\u{1F514}|\u{1F7E2}|\u{1F534})/u;
const CONTINUATION = /^\p{L}/u;

interface Split {
  readonly title: string | null;
  readonly blocks: readonly string[][];
}

function splitBlocks(text: string): Split {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const [first, ...rest] = lines;
  const hasTitle = first !== undefined && TITLE_START.test(first);
  const blocks: string[][] = [];
  for (const line of hasTitle ? rest : lines) {
    const last = blocks.at(-1);
    if (CONTINUATION.test(line) && last) last.push(line);
    else blocks.push([line]);
  }
  return { title: hasTitle ? (first ?? null) : null, blocks };
}

function join({ title }: Split, blocks: readonly string[][]): string {
  return [...(title === null ? [] : [title]), ...blocks.flat()].join('\n');
}

describe('line order does not change the result', () => {
  it.each(FIXTURE_EXPECTATIONS)(
    '%s: every permutation of its field lines',
    (name, source, expected) => {
      const split = splitBlocks(loadFixture(name));
      const orders = permutations(split.blocks);
      // 5 field blocks (direction, card, channel, time, balance) → 120 orders.
      expect(orders).toHaveLength(120);
      for (const blocks of orders) {
        expect(parseBankMessage(source, join(split, blocks))).toEqual(expected);
      }
    },
  );

  it('a failure reason does not depend on the order either', () => {
    const text = humoMessage({ card: '\u{1F4B3} HUMOCARD 0000', time: `\u23F0 31.02.30 12:00` });
    const split = splitBlocks(text);
    const reasons = new Set(
      permutations(split.blocks).map((blocks) => {
        const result = parseBankMessage('HUMO_BOT', join(split, blocks));
        return result.ok ? 'OK' : result.reason;
      }),
    );
    // Card format is checked before the date: fixed check order, not line order.
    expect([...reasons]).toEqual(['CARD_FORMAT']);
  });

  it('a duplicated field is refused in every position', () => {
    const extra = `\u2795 ${SYN.humoAmount}`;
    const split = splitBlocks(humoMessage());
    for (const blocks of permutations([...split.blocks, [extra]])) {
      expect(parseBankMessage('HUMO_BOT', join(split, blocks))).toEqual({
        ok: false,
        reason: 'DUPLICATE_DIRECTION',
      });
    }
  });
});
