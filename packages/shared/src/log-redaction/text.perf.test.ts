import { describe, expect, it } from 'vitest';
import { MAX_SCRUBBED_LENGTH, scrubSecretsInText } from './index';

// Regression for RA-1: `'"a":['.repeat(n)` took 59 s at 160 KB because every `"key":` match
// scanned to the end of the text. The shapes below are the adversarial ones for each pattern.
// The scan cap is lifted to the full input so the REGEXES themselves are measured, not only
// the cap in front of them. Linear code needs a few tens of milliseconds for 1 MB here;
// quadratic code needs minutes, so the generous bound catches it without being flaky.
const ONE_MB = 1_000_000;
const BOUND_MS = 500;

const fill = (unit: string): string => unit.repeat(Math.ceil(ONE_MB / unit.length));

const SHAPES: Record<string, string> = {
  'unbalanced JSON, sensitive key': fill('"token":['),
  'unbalanced JSON, plain key': fill('"a":['),
  'unbalanced nested braces': fill('{"a":'),
  'escaped JSON, unterminated': fill('\\"apiKey\\":\\"'),
  'many "k": pairs': fill('"k":1,'),
  'many unquoted k: pairs': fill('k: v, '),
  'many k=v pairs': fill('k=v&'),
  'many sensitive k=v pairs': fill('password=x;'),
  'unterminated quotes': fill('a="'),
  'long digit run': '1'.repeat(ONE_MB),
  'digits and colons': fill('123456789:'),
  'long quote run': '"'.repeat(ONE_MB),
  'long key-char run': 'a'.repeat(ONE_MB),
  'long whitespace run': `"k"${' '.repeat(ONE_MB)}`,
  'url scheme without @': fill('://a'),
  'phone-like fragments': fill('+7 9 '),
  'bearer words': fill('Bearer '),
};

describe('scrubSecretsInText performance', () => {
  it.each(Object.entries(SHAPES))('1 MB of %s stays linear', (_name, input) => {
    const started = performance.now();
    scrubSecretsInText(input, Number.MAX_SAFE_INTEGER);
    expect(performance.now() - started).toBeLessThan(BOUND_MS);
  });

  it.each(Object.entries(SHAPES))('the default cap bounds 1 MB of %s', (_name, input) => {
    const started = performance.now();
    const out = scrubSecretsInText(input);
    expect(performance.now() - started).toBeLessThan(BOUND_MS);
    expect(out.endsWith('[Truncated]')).toBe(true);
    expect(out.length).toBeLessThan(2 * MAX_SCRUBBED_LENGTH); // replacements may be longer than the text
  });
});
