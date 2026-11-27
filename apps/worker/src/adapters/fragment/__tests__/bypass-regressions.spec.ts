import { randomBytes } from 'node:crypto';
import { createFixtureSanitizer } from '../fixture-sanitizer';
import { createLeakCheck } from '../leak-check';
import { BYPASS_CASES, OWNER, OWNER_EQ, PAY, secrets } from './bypass-cases';
import { recoverable } from './recovery-oracle';

// Fix round 2: every bypass the security re-audit found (and every LEAK of its probe) is a
// regression test. A case passes when the staged text is withheld by the leak check, or when even
// the aggressive oracle cannot recover the secret from it. Exit code 0 with a leak is the failure.

type Verdict = 'withheld' | 'clean' | 'LEAK';

function verdictOf(c: (typeof BYPASS_CASES)[number]): Verdict {
  const sec = secrets(c.v ?? 'full', c.extra ?? []);
  const keep = c.keep ?? [PAY];
  const sanitizer = createFixtureSanitizer({ secrets: sec, keepAddresses: keep });
  const leak = createLeakCheck({ secrets: sec, keepAddresses: keep });
  const value = c.json ?? { response: { bodyKind: 'html-excerpt', body: c.text ?? '' } };
  const staged = `${JSON.stringify(sanitizer.sanitizeJson(value), null, 2)}\n`;
  if (leak(staged).length > 0) return 'withheld';
  return recoverable(staged, c.needle) ? 'LEAK' : 'clean';
}

describe('re-audit bypass cases (fix round 2)', () => {
  it('has the cases and builds valid made-up addresses', () => {
    expect(BYPASS_CASES.length).toBeGreaterThan(50);
    for (const address of [OWNER, OWNER_EQ, PAY]) expect(address).toHaveLength(48);
  });

  it.each(BYPASS_CASES.map((c) => [c.id, c] as const))('%s: withheld or clean', (_id, c) => {
    expect(['withheld', 'clean']).toContain(verdictOf(c));
  });

  it('R-7: a bare 32-byte hex never survives, even with no secret known', () => {
    const blind = createFixtureSanitizer({ secrets: [], keepAddresses: [PAY] });
    for (let i = 0; i < 200; i += 1) {
      const hex = randomBytes(32).toString('hex');
      expect(
        JSON.stringify(blind.sanitizeJson({ account_id: hex, note: `id ${hex}` })),
      ).not.toContain(hex);
    }
  });

  it('KEEP3: a kept address is kept only in its exact spelling', () => {
    const sec = secrets('noWallet');
    const sanitizer = createFixtureSanitizer({ secrets: sec, keepAddresses: [PAY, OWNER_EQ] });
    const out = sanitizer.sanitizeText(`<b>${OWNER}</b> <i>${OWNER_EQ}</i>`);
    expect(out).toBe(`<b><REDACTED:address></b> <i>${OWNER_EQ}</i>`);
    const leak = createLeakCheck({ secrets: sec, keepAddresses: [PAY, OWNER_EQ] });
    expect(leak(`<b>${OWNER}</b>`)).toContain('ton-address');
    expect(leak(`<b>${OWNER_EQ}</b>`)).toEqual([]);
  });

  it('R-4: a kept address that equals a secret account is not kept', () => {
    const sec = secrets('full');
    const sanitizer = createFixtureSanitizer({ secrets: sec, keepAddresses: [PAY, OWNER_EQ] });
    expect(sanitizer.sanitizeText(`to ${OWNER_EQ}`)).toBe('to <REDACTED:address>');
    expect(createLeakCheck({ secrets: sec, keepAddresses: [OWNER_EQ] })(OWNER_EQ)).not.toEqual([]);
  });
});
