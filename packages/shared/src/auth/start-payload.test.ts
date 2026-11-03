import { describe, expect, it } from 'vitest';
import { parseStartPayload } from './start-payload';

const NONCE = ['A', 'b', '0', '_', '-'].join('').repeat(9).slice(0, 43);
const NONE = { kind: 'none' };

describe('parseStartPayload', () => {
  it('parses each known shape', () => {
    expect(parseStartPayload('ref_ab12cd34')).toEqual({ kind: 'ref', code: 'ab12cd34' });
    expect(parseStartPayload(`login_${NONCE}`)).toEqual({ kind: 'login', nonce: NONCE });
    expect(parseStartPayload(`admin_${NONCE}`)).toEqual({ kind: 'admin', nonce: NONCE });
    expect(parseStartPayload('p_telegram-stars')).toEqual({
      kind: 'product',
      slug: 'telegram-stars',
    });
  });

  it('accepts the longest product slug that fits the 64-char cap', () => {
    const slug = 'a'.repeat(62);
    expect(parseStartPayload(`p_${slug}`)).toEqual({ kind: 'product', slug });
  });

  it.each([
    ['undefined', undefined],
    ['empty', ''],
    ['unknown prefix', 'foo_bar'],
    ['ref too short', 'ref_ab12cd3'],
    ['ref too long', 'ref_ab12cd345'],
    ['ref uppercase', 'ref_AB12CD34'],
    ['ref with suffix', 'ref_ab12cd34x'],
    ['ref with prefix', 'xref_ab12cd34'],
    ['login nonce too short', `login_${NONCE.slice(1)}`],
    ['login nonce bad char', `login_${NONCE.slice(1)}!`],
    ['admin nonce too short', `admin_${NONCE.slice(1)}`],
    ['product slug empty', 'p_'],
    ['product slug leading hyphen', 'p_-abc'],
    ['product slug uppercase', 'p_Stars'],
    ['product slug underscore', 'p_a_b'],
    ['newline smuggled after a valid ref', 'ref_ab12cd34\n'],
    ['over 64 chars', `p_${'a'.repeat(63)}`],
    ['very long input', 'a'.repeat(100_000)],
  ])('treats %s as none', (_name, input) => {
    expect(parseStartPayload(input)).toEqual(NONE);
  });
});
