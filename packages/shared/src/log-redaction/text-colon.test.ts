import { describe, expect, it } from 'vitest';
import { REDACTED, scrubSecretsInText } from './index';

describe('scrubSecretsInText: key: value with unusual spacing and keys', () => {
  it('skips any amount of whitespace around the colon', () => {
    expect(scrubSecretsInText(`password:${'\t'.repeat(10)}hunter2 next`)).toBe(
      `password:${'\t'.repeat(10)}${REDACTED} next`,
    );
    expect(scrubSecretsInText(`password${' '.repeat(20)}:${' '.repeat(20)}hunter2`)).toBe(
      `password${' '.repeat(20)}:${' '.repeat(20)}${REDACTED}`,
    );
    expect(scrubSecretsInText(`code:${' '.repeat(12)}123456`)).toBe(
      `code:${' '.repeat(12)}${REDACTED}`,
    );
  });

  it('classifies keys longer than 64 characters', () => {
    const key = `${'a'.repeat(100)}_password`;
    expect(scrubSecretsInText(`{ "${key}": "hunter2" }`)).toBe(`{ "${key}": "${REDACTED}" }`);
    expect(scrubSecretsInText(`${key}: hunter2`)).toBe(`${key}: ${REDACTED}`);
  });

  it('classifies a quoted key that contains a space', () => {
    expect(scrubSecretsInText('{"api key": "s3cr3t", "n": 1}')).toBe(
      `{"api key": "${REDACTED}", "n": 1}`,
    );
    expect(scrubSecretsInText("{ 'private key' : 'abc' }")).toBe(
      `{ 'private key' : '${REDACTED}' }`,
    );
  });

  it('keeps harmless quoted keys with spaces and plain prose', () => {
    const text = '{"order id": "o-1", "full name": "Ali"} he said "hello world": fine';
    expect(scrubSecretsInText(text)).toBe(text);
  });
});

describe('scrubSecretsInText: dotted keys with a colon', () => {
  it('classifies by the last segment', () => {
    expect(scrubSecretsInText('cfg.hash: abcdef123 q.code: 123456 q.code: 23505')).toBe(
      `cfg.hash: ${REDACTED} q.code: ${REDACTED} q.code: 23505`,
    );
  });
});
