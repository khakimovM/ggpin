// Second review round (phase 9 S1 fix 2): refund mode binding (M-3 / N3), the one binding
// function (m-4), the confirmRate error (m-5), MANUAL proof text (N4), the audit export limit
// (N6), the OTP error paths (N7) and blank-looking admin names (N9).
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import * as a from './index';

const REASON = 'Mijoz pulni qaytarishni so‘radi';
const HASH = 'b'.repeat(64);
const ok = (schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown) =>
  schema.safeParse(value).success;

const refundConfirm = (mode: 'FULL' | 'PARTIAL', extra: Record<string, unknown> = {}) =>
  a.AdminConfirmationBodySchema.parse({
    action: 'orders.refund',
    targetId: 'ord_1',
    amountTiyin: '550000',
    mode,
    ...extra,
  });

const binding = (body: a.AdminConfirmationBody, serverFlags: readonly string[] = []) =>
  a.adminConfirmationBinding({ body, serverFlags, adminId: 'adm_1', sessionId: 'ses_1' });

describe('refund mode (M-3 / N3)', () => {
  it('takes amountTiyin only in PARTIAL and the mode always', () => {
    const body = a.AdminOrderRefundBodySchema;
    expect(ok(body, { mode: 'FULL', reason: REASON })).toBe(true);
    expect(ok(body, { mode: 'FULL', reason: REASON, returnTxHash: HASH })).toBe(true);
    expect(ok(body, { mode: 'FULL', reason: REASON, amountTiyin: '1' })).toBe(false);
    expect(ok(body, { mode: 'PARTIAL', reason: REASON, amountTiyin: '1' })).toBe(true);
    expect(ok(body, { mode: 'PARTIAL', reason: REASON })).toBe(false);
    expect(ok(body, { reason: REASON, amountTiyin: '1' })).toBe(false);
    expect(ok(body, { mode: 'FULL', reason: REASON, returnTxHash: HASH.toUpperCase() })).toBe(
      false,
    );
  });

  it('binds the mode and the return hash: a partial refund of the remainder is not a full one', async () => {
    const full = await binding(refundConfirm('FULL'));
    expect(await binding(refundConfirm('PARTIAL'))).not.toBe(full);
    expect(await binding(refundConfirm('FULL', { returnTxHash: HASH }))).not.toBe(full);
    expect(
      ok(a.AdminConfirmationBodySchema, {
        action: 'orders.refund',
        targetId: 'o',
        amountTiyin: '1',
      }),
    ).toBe(false);
  });
});

describe('adminConfirmationBinding (m-4)', () => {
  const body = refundConfirm('FULL');

  it('is sha256 of [canonical(body), sorted flags, adminId, sessionId]', async () => {
    const input = { body, serverFlags: ['B', 'A'], adminId: 'adm_1', sessionId: 'ses_1' };
    const text = a.adminConfirmationBindingText(input);
    expect(text).toBe(
      JSON.stringify([a.adminConfirmationCanonical(body), ['A', 'B'], 'adm_1', 'ses_1']),
    );
    expect(await a.adminConfirmationBinding(input)).toBe(
      createHash('sha256').update(text).digest('hex'),
    );
  });

  it('ignores the flag order and changes with every bound value', async () => {
    const base = await binding(body, ['JUMP', 'OVERRIDE']);
    expect(await binding(body, ['OVERRIDE', 'JUMP'])).toBe(base);
    expect(await binding(body, ['JUMP'])).not.toBe(base);
    const other = (adminId: string, sessionId: string) =>
      a.adminConfirmationBinding({ body, serverFlags: ['JUMP', 'OVERRIDE'], adminId, sessionId });
    expect(await other('adm_2', 'ses_1')).not.toBe(base);
    expect(await other('adm_1', 'ses_2')).not.toBe(base);
    expect(
      await binding(refundConfirm('FULL', { amountTiyin: '550001' }), ['JUMP', 'OVERRIDE']),
    ).not.toBe(base);
  });
});

describe('admin field errors (m-5, N7)', () => {
  it('keeps AMOUNT_MISMATCH for money and names the rate mismatch on its own', () => {
    expect(a.adminOtpHttpError('AMOUNT_MISMATCH')).toMatchObject({
      field: { path: 'confirmAmountTiyin' },
    });
    expect(a.ADMIN_RATE_MISMATCH_ERROR).toEqual({
      status: 400,
      code: 'VALIDATION_ERROR',
      field: { path: 'confirmRate', code: 'RATE_MISMATCH' },
    });
    expect(a.ADMIN_OTP_NOT_REQUIRED_ERROR.field).toEqual({
      path: 'action',
      code: 'OTP_NOT_REQUIRED',
    });
    expect(a.ADMIN_FIELD_ERROR_CODES).toContain('RATE_MISMATCH');
    expect(Object.isFrozen(a.ADMIN_FIELD_ERROR_CODES)).toBe(true);
  });
});

describe('MANUAL and FRAGMENT_STATUS proof text (N4)', () => {
  const manual = (evidence: string) => ok(a.AdminResolveProofSchema, { kind: 'MANUAL', evidence });
  const fragment = (requestRef: string) =>
    ok(a.AdminResolveProofSchema, {
      kind: 'FRAGMENT_STATUS',
      requestRef,
      status: 'DONE',
      observedAt: '2026-11-16T10:00:00.000Z',
    });

  it('accepts one visible line and refuses bidi, zero-width, separators and newlines', () => {
    expect(manual('Fragment tarixida bor, skrinshot #12')).toBe(true);
    expect(fragment('req-42')).toBe(true);
    for (const bad of ['a‮b', 'a​b', 'a b', 'a b', 'a\nb', 'a\u0000b', '   ']) {
      expect(manual(bad), JSON.stringify(bad)).toBe(false);
      expect(fragment(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('audit export limit (N6)', () => {
  it('takes plain digits only', () => {
    const limit = (value: unknown) => a.AdminAuditExportQuerySchema.safeParse({ limit: value });
    expect(limit('25').data?.limit).toBe(25);
    expect(a.AdminAuditExportQuerySchema.parse({}).limit).toBe(a.AUDIT_EXPORT_MAX_ROWS);
    for (const bad of ['0', ' 5', '1e3', '0x10', '', '05', '-1', 5]) {
      expect(limit(bad).success, String(bad)).toBe(false);
    }
  });
});

describe('admin name (N9)', () => {
  it('needs a letter or digit and refuses blank-looking characters', () => {
    expect(ok(a.AdminNameSchema, 'Aziz')).toBe(true);
    expect(ok(a.AdminNameSchema, 'Оператор 2')).toBe(true);
    expect(ok(a.AdminNameSchema, '7')).toBe(true);
    for (const bad of ['ㅤ', 'ᅟ', 'ᅠ', 'ﾠ', '⠀', 'Azizㅤ', '---', '...']) {
      expect(ok(a.AdminNameSchema, bad), JSON.stringify(bad)).toBe(false);
    }
  });
});
