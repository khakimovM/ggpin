import { describe, expect, it } from 'vitest';
import { REDACTED, TRUNCATED, scrubSecretsInText } from './index';

// The scan cap used to slice first and scrub second, so a secret straddling the cut matched no
// pattern any more and its prefix reached the log. Each shape is moved across every cut
// position (the `maxLength` parameter is the cap), and no 4-character prefix of the secret
// may survive in the output.
const SHAPES: ReadonlyArray<readonly [name: string, text: string, secret: string]> = [
  ['URL userinfo', 'db at postgresql://ggpin:hunter2@db:5432/app', 'hunt'],
  ['Bearer', 'sent Bearer abcdefghijklmnop to api', 'abcd'],
  ['bot token', 'bot 123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0 failed', '1234'],
  ['password=', 'login password=Zq8vLongSecretValue; user=app', 'Zq8v'],
  ['JSON apiKey', 'body {"apiKey":"Zq8vLongSecretValue","id":1}', 'Zq8v'],
  ['inspect apiKey', "err { apiKey: 'Zq8vLongSecretValue', id: 1 }", 'Zq8v'],
  ['phone', 'call +998901234567 now', '+998'],
  ['spaced phone', 'call +998 90 123 45 67 now', '+998'],
];

describe('scrubSecretsInText: the length cap never cuts through a secret', () => {
  it.each(SHAPES)('%s', (_name, text, prefix) => {
    expect(scrubSecretsInText(text, text.length)).not.toContain(prefix); // control: whole text
    for (let cap = 1; cap < text.length; cap += 1) {
      const out = scrubSecretsInText(text, cap);
      expect(out.endsWith(TRUNCATED), `cap ${String(cap)}`).toBe(true);
      expect(out, `cap ${String(cap)}`).not.toContain(prefix);
    }
  });

  it('cuts at the last delimiter instead of mid-token', () => {
    expect(scrubSecretsInText('alpha beta gamma delta', 13)).toBe(`alpha beta${TRUNCATED}`);
  });

  it('drops the whole head when it holds no delimiter (fail closed)', () => {
    expect(scrubSecretsInText(`${'x'.repeat(50)} tail`, 20)).toBe(TRUNCATED);
  });

  it('still hides what is complete before the cut', () => {
    expect(scrubSecretsInText(`token=abc ${'x'.repeat(100)}`, 20)).toBe(
      `token=${REDACTED}${TRUNCATED}`,
    );
  });
});
