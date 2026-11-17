// Review round tests (phase 9 S1 fix): visible text (CR-M3, SA-L9), query integers (CR-L1),
// catalog no-op (CR-M2), queue retry reason (CR-L4), attempt facts (SA-M4), audit redaction
// (SA-M4) and the RFC 4180 / formula-safe CSV cell (SA-M8).
import { describe, expect, it } from 'vitest';
import * as a from './index';

const REASON = 'Mijoz pulni qaytarishni so‘radi';
const ok = (schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown) =>
  schema.safeParse(value).success;
const BAD_CHARS = ['\u0000', '‮', ' ', '​', '\r'];

describe('visible text', () => {
  it('refuses NUL, bidi, line separators and zero-width in one-line catalog fields', () => {
    for (const bad of BAD_CHARS) {
      const word = `Stars${bad}x`;
      expect(ok(a.AdminProductUpdateBodySchema, { nameUz: word }), JSON.stringify(bad)).toBe(false);
      expect(ok(a.AdminSkuUpdateBodySchema, { labelUz: word })).toBe(false);
      expect(ok(a.AdminSkuUpdateBodySchema, { tab: word })).toBe(false);
      expect(ok(a.AdminSkuUpdateBodySchema, { supplierSku: word })).toBe(false);
      expect(ok(a.AdminCategoryUpdateBodySchema, { nameRu: word })).toBe(false);
    }
    expect(ok(a.AdminSkuUpdateBodySchema, { labelUz: 'a\nb' })).toBe(false);
    expect(ok(a.AdminProductUpdateBodySchema, { nameUz: 'Telegram Stars' })).toBe(true);
    expect(ok(a.AdminProductUpdateBodySchema, { regionBadge: 'UZ' })).toBe(true);
    expect(ok(a.AdminProductUpdateBodySchema, { regionBadge: 'U‮Z' })).toBe(false);
  });

  it('allows only \\n as the invisible character of a description or help text', () => {
    expect(ok(a.AdminProductUpdateBodySchema, { descriptionUz: 'birinchi\nikkinchi' })).toBe(true);
    for (const bad of BAD_CHARS) {
      expect(ok(a.AdminProductUpdateBodySchema, { helpRu: `a${bad}b` }), JSON.stringify(bad)).toBe(
        false,
      );
    }
  });

  it('keeps admin names to visible text without < or >', () => {
    expect(ok(a.AdminNameSchema, 'Aziz Operator')).toBe(true);
    for (const bad of [...BAD_CHARS, '<b>', 'a>b']) {
      expect(ok(a.AdminNameSchema, `a${bad}b`), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('query integers and small bodies', () => {
  it('reads price-preview numbers as plain decimals only', () => {
    for (const bad of ['0x10', '1e3', '+5', '05', '-1', ' 5', '1.0', '0']) {
      expect(ok(a.AdminPricePreviewQuerySchema, { quantity: bad }), bad).toBe(false);
    }
    expect(ok(a.AdminPricePreviewQuerySchema, { quantity: '50', markupBps: '0' })).toBe(true);
    expect(ok(a.AdminPricePreviewQuerySchema, { skuId: 's_1', markupBps: '10001' })).toBe(false);
    expect(a.AdminPricePreviewQuerySchema.parse({ quantity: '50' }).quantity).toBe(50);
  });

  it('answers a catalog no-op without an audit row and asks a reason to retry a job', () => {
    const category = { id: 'c1', slug: 's', nameUz: 'a', nameRu: 'b', sort: 0, productsCount: 0 };
    expect(
      ok(a.AdminCategoryUpdateResponseSchema, { category, auditId: null, applied: false }),
    ).toBe(true);
    expect(ok(a.AdminQueueRetryBodySchema, {})).toBe(false);
    expect(ok(a.AdminQueueRetryBodySchema, { reason: REASON })).toBe(true);
  });

  it('shows attempt facts only through the strict projection', () => {
    expect(ok(a.AdminAttemptFactsSchema, { ton: null })).toBe(true);
    expect(ok(a.AdminAttemptFactsSchema, { ton: null, request: {} })).toBe(false);
    const ton = {
      toAddress: null,
      amountNanoTon: '1000',
      bounce: null,
      expiry: null,
      witnessConflict: false,
    };
    expect(ok(a.AdminAttemptFactsSchema, { ton })).toBe(true);
    expect(ok(a.AdminAttemptFactsSchema, { ton: { ...ton, payloadBoc: 'te6' } })).toBe(false);
  });
});

describe('audit JSON redaction', () => {
  const row = {
    amountTiyin: '500',
    verifyAmountTiyin: '137',
    company: 'ok',
    pan: '8600123412341234',
    nested: [{ providerRef: 'x', ok: 1 }, { otpCode: '123456' }],
    returnTxHash: 'ab',
    otpVerified: true,
  };
  const view = {
    ipFull: true,
    bankMessageRaw: true,
    maskIp: () => null,
    identityFull: true,
    maskTelegramId: () => null,
  };

  it('replaces every secret-named key at any depth and keeps the rest', () => {
    expect(a.findAuditSecretPaths(row)).toEqual([
      '$.verifyAmountTiyin',
      '$.pan',
      '$.nested[0].providerRef',
      '$.nested[1].otpCode',
    ]);
    const clean = a.redactAuditJson(row, view);
    expect(clean).toEqual({
      amountTiyin: '500',
      verifyAmountTiyin: a.AUDIT_REDACTED,
      company: 'ok',
      pan: a.AUDIT_REDACTED,
      nested: [{ providerRef: a.AUDIT_REDACTED, ok: 1 }, { otpCode: a.AUDIT_REDACTED }],
      // A public tx hash and the "was the code typed" flag stay visible (review M-2 / N2).
      returnTxHash: 'ab',
      otpVerified: true,
    });
    expect(a.findAuditSecretPaths(clean)).toEqual([]);
    expect(a.redactAuditJson(null, view)).toBeNull();
  });
});

describe('csvCell', () => {
  it('quotes every cell and doubles inner quotes (RFC 4180)', () => {
    expect(a.csvCell('a"b')).toBe('"a""b"');
    expect(a.csvCell('a,b\nc')).toBe('"a,b\nc"');
    expect(a.csvCell(null)).toBe('""');
    expect(a.csvCell(undefined)).toBe('""');
    expect(a.csvCell(5)).toBe('"5"');
    expect(a.csvCell(true)).toBe('"true"');
    expect(a.csvCell(12n)).toBe('"12"');
    expect(a.csvCell(Symbol('x'))).toBe('""');
    expect(a.csvCell({ k: 'v"' })).toBe('"{""k"":""v\\""""}"');
    expect(a.csvRow(['x', null, 1])).toBe('"x","","1"');
    // Audit JSON read through Prisma may hold a bigint: it becomes a string, not a throw (m-7).
    expect(a.csvCell({ amountTiyin: 12n, list: [1n] })).toBe(
      '"{""amountTiyin"":""12"",""list"":[""1""]}"',
    );
  });

  it('defuses formula starts after whitespace, full-width forms, tab and CR', () => {
    for (const cell of ['=SUM(A1)', '+1', '-1', '@x', '  =1', '　=1', '＝1', '＋1', '－1', '＠x']) {
      expect(a.csvCell(cell), cell).toBe(`"'${cell}"`);
    }
    expect(a.csvCell('\tx')).toBe('"\'\tx"');
    expect(a.csvCell('\rx')).toBe('"\'\rx"');
    expect(a.csvCell('safe = 1')).toBe('"safe = 1"');
    expect(a.csvCell(['=1'])).toBe('"[""=1""]"');
  });
});
