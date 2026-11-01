import { describe, expect, it } from 'vitest';
import { REDACTED, scrubSecretsInText } from './index';

describe('scrubSecretsInText: key=value, line-valued keys', () => {
  it.each([
    ['mnemonic=abandon ability able about above', 'mnemonic'],
    ['TON_MNEMONIC=abandon ability able about above', 'TON_MNEMONIC'],
    ['seed_phrase=abandon,ability,able', 'seed_phrase'],
  ])('%s runs to the end of the line', (line, key) => {
    expect(scrubSecretsInText(`${line}\nnext=1`)).toBe(`${key}=${REDACTED}\nnext=1`);
  });

  it('keeps `key: value` and `key=value` consistent', () => {
    const words = 'abandon ability able about above';
    expect(scrubSecretsInText(`mnemonic: ${words}`)).toBe(`mnemonic: ${REDACTED}`);
    expect(scrubSecretsInText(`mnemonic=${words}`)).toBe(`mnemonic=${REDACTED}`);
  });
});

describe('scrubSecretsInText: key=value after a harmless key', () => {
  it('finds a pair inside the quoted value of a non-sensitive key', () => {
    expect(scrubSecretsInText('msg="connect failed: host=db password=hunter2"')).toBe(
      `msg="connect failed: host=db password=${REDACTED}"`,
    );
  });

  it('finds a pair after an unterminated quote of a non-sensitive key', () => {
    expect(scrubSecretsInText('a=" password=hunter2')).toBe(`a=" password=${REDACTED}`);
  });

  it('still consumes a sensitive quoted value completely', () => {
    expect(scrubSecretsInText('password="a b" host=db')).toBe(`password=${REDACTED} host=db`);
    expect(scrubSecretsInText('password="a \\" b" host=db')).toBe(`password=${REDACTED} host=db`);
  });
});

describe('scrubSecretsInText: dotted keys and spaces around =', () => {
  it('classifies a dotted key by its last segment', () => {
    expect(scrubSecretsInText('cfg.hash=abcdef123 q.code=123456 x.sign=abc')).toBe(
      `cfg.hash=${REDACTED} q.code=${REDACTED} x.sign=${REDACTED}`,
    );
    expect(scrubSecretsInText('q.code=23505 cfg.mode=require')).toBe(
      'q.code=23505 cfg.mode=require',
    );
  });

  it('allows spaces around =', () => {
    expect(scrubSecretsInText('password = hunter2 host=db')).toBe(`password = ${REDACTED} host=db`);
    expect(scrubSecretsInText('token\t=\tabc123;')).toBe(`token\t=\t${REDACTED};`);
    expect(scrubSecretsInText('code = 123456')).toBe(`code = ${REDACTED}`);
  });
});

describe('scrubSecretsInText: innocuous key=value is untouched', () => {
  it('keeps modes, ids, dates and amounts', () => {
    const text =
      'sslmode=require orderId=o-1 at=2026-11-01T10:00:00.000Z amount=150000 status=failed a == b';
    expect(scrubSecretsInText(text)).toBe(text);
  });
});
