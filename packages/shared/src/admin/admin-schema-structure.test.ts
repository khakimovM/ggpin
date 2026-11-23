// Structural checks over EVERY admin schema exported from the barrel, so a new schema is covered
// without touching this file: requests are strict, money is the money shape, lists stop at 100,
// responses carry no secret-named field.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { SignedTiyinStringSchema, TiyinStringSchema } from '../money-schemas';
import * as admin from './index';
import {
  AdminAdjustAmountSchema,
  NonZeroSignedTiyinStringSchema,
  PositiveTiyinStringSchema,
} from './admin-common-schemas';
import { AdminMinMarginTiyinSchema } from './admin-catalog-schemas';

type Visit = (schema: z.ZodType, key: string | null, path: string) => void;

/** Unwraps optional / nullable / default to the schema that holds the value. */
function leaf(schema: z.ZodType): z.ZodType {
  if (
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodNullable ||
    schema instanceof z.ZodDefault
  ) {
    return leaf(schema.unwrap() as z.ZodType);
  }
  return schema;
}

/** Narrows to an object whose shape is typed (the bare `instanceof` leaves the shape `any`). */
const isObject = (schema: z.ZodType): schema is z.ZodObject<Record<string, z.ZodType>> =>
  schema instanceof z.ZodObject;

/** Depth-first walk through objects, arrays, unions, records and the wrappers `leaf` removes. */
function walk(schema: z.ZodType, visit: Visit, key: string | null = null, path = '$'): void {
  visit(schema, key, path);
  const inner = leaf(schema);
  if (inner !== schema) return walk(inner, visit, key, path);
  if (isObject(inner)) {
    for (const [k, child] of Object.entries(inner.shape)) {
      walk(child, visit, k, `${path}.${k}`);
    }
  } else if (inner instanceof z.ZodArray) {
    walk(inner.element as z.ZodType, visit, key, `${path}[]`);
  } else if (inner instanceof z.ZodUnion) {
    (inner.options as readonly z.ZodType[]).forEach((option, i) =>
      walk(option, visit, key, `${path}|${String(i)}`),
    );
  } else if (inner instanceof z.ZodRecord) {
    walk(inner.valueType as z.ZodType, visit, key, `${path}{}`);
  }
  // A pipe is a leaf: the money shapes are pipes (string -> refined string) and no admin object
  // lives inside one, so descending would only re-visit the halves of a money field.
}

const exported = Object.entries(admin).flatMap(([name, value]): [string, z.ZodType][] =>
  value instanceof z.ZodType ? [[name, value]] : [],
);
const named = (suffix: RegExp) => exported.filter(([name]) => suffix.test(name));
const requests = named(/(Body|Query|Params)Schema$/);
const responses = named(/ResponseSchema$/);

describe('admin schema registry', () => {
  it('finds the request and response schemas of every group', () => {
    expect(requests.length).toBeGreaterThanOrEqual(40);
    expect(responses.length).toBeGreaterThanOrEqual(40);
  });
});

describe('admin requests are strict', () => {
  it.each(requests)('%s rejects unknown keys at every level', (_name, schema) => {
    walk(schema, (node, _key, path) => {
      const inner = leaf(node);
      if (!(inner instanceof z.ZodObject)) return;
      expect(inner._zod.def.catchall, path).toBeInstanceOf(z.ZodNever);
    });
  });

  it('takes the resolve proof strictly per kind, without reason and without the CLI-only kind', () => {
    const proof = admin.AdminResolveProofSchema;
    expect(proof.safeParse({ kind: 'MANUAL', evidence: 'chek bor' }).success).toBe(true);
    expect(proof.safeParse({ kind: 'MANUAL', evidence: 'x', reason: 'boshqa' }).success).toBe(
      false,
    );
    expect(proof.safeParse({ kind: 'MANUAL', evidence: 'x', junk: { deep: 1 } }).success).toBe(
      false,
    );
    expect(proof.safeParse({ kind: 'MANUAL', evidence: 'x'.repeat(1001) }).success).toBe(false);
    expect(proof.safeParse({ kind: 'TON_TX', anything: 'x' }).success).toBe(false);
    expect(proof.safeParse({ kind: 'TON_UNMATCHED_RESOLVED' }).success).toBe(false);
  });
});

describe('admin responses are strict objects', () => {
  it.each(responses)('%s has no open object', (_name, schema) => {
    walk(schema, (node, _key, path) => {
      const inner = leaf(node);
      if (inner instanceof z.ZodObject)
        expect(inner._zod.def.catchall, path).toBeInstanceOf(z.ZodNever);
    });
  });
});

// Every money-named leaf must behave like a minor-unit decimal string: a JSON number, a fraction,
// padding or a leading zero is refused; unsigned units (NanoTon, MicroUsdt, Minor) refuse a sign.
const moneyLeafProblems = (node: z.ZodType, signed: boolean): string[] => {
  const problems: string[] = [];
  for (const bad of [1, '1.5', '01', ' 5', '1e3', '']) {
    if (node.safeParse(bad).success) problems.push(`accepts ${JSON.stringify(bad)}`);
  }
  if (!signed && node.safeParse('-1').success) problems.push('accepts -1');
  if (!node.safeParse('1').success) problems.push('refuses 1');
  return problems;
};

const MONEY_SHAPES = new Set<z.ZodType>([
  TiyinStringSchema,
  SignedTiyinStringSchema,
  PositiveTiyinStringSchema,
  NonZeroSignedTiyinStringSchema,
  AdminAdjustAmountSchema,
  // The tiyin string with the owner's 100 mln so‘m ceiling (S8a fix, 2026-11-22).
  AdminMinMarginTiyinSchema,
]);

describe('admin money fields', () => {
  it.each(exported)('%s carries money only as the tiyin string shapes', (_name, schema) => {
    walk(schema, (node, key, path) => {
      if (key === null || node !== leaf(node)) return;
      if (/Tiyin$/.test(key)) {
        expect(MONEY_SHAPES.has(node), path).toBe(true);
        expect(moneyLeafProblems(node, true), path).toEqual([]);
      }
      if (/(NanoTon|MicroUsdt|Minor)$/.test(key)) {
        expect(moneyLeafProblems(node, false), path).toEqual([]);
      }
    });
  });

  it('refuses negative, fractional, numeric and padded amounts in a request', () => {
    const base = { reason: 'Mijoz pulni qaytarishni so‘radi', mode: 'PARTIAL' };
    for (const bad of ['-1', '1.5', '01', ' 5', '', '1e3', 100]) {
      expect(
        admin.AdminOrderRefundBodySchema.safeParse({ ...base, amountTiyin: bad }).success,
        String(bad),
      ).toBe(false);
      expect(
        admin.AdminCardLimitBodySchema.safeParse({ ...base, receiveLimitTiyin: bad }).success,
      ).toBe(false);
    }
    expect(admin.AdminOrderRefundBodySchema.safeParse({ ...base, amountTiyin: '0' }).success).toBe(
      false,
    );
    expect(
      admin.AdminOrderRefundBodySchema.safeParse({ ...base, amountTiyin: '550000' }).success,
    ).toBe(true);
    expect(
      admin.AdminOrderCancelBodySchema.safeParse({ ...base, confirmAmountTiyin: '-550000' })
        .success,
    ).toBe(false);
  });

  it('takes a signed, non-zero adjustment and a signed confirmation for it only', () => {
    const base = { reason: 'Bank tomonidan tasdiqlangan qaytarish' };
    const ok = (amountTiyin: string, confirmAmountTiyin?: string) =>
      admin.AdminAdjustWalletBodySchema.safeParse({
        ...base,
        amountTiyin,
        ...(confirmAmountTiyin === undefined ? {} : { confirmAmountTiyin }),
      }).success;
    expect(ok('-550000', '-550000')).toBe(true);
    expect(ok('550000')).toBe(true);
    expect(ok('0')).toBe(false);
    expect(ok('-0')).toBe(false);
    expect(ok('1.5')).toBe(false);
  });
});

describe('admin list limits', () => {
  const pageQueries = requests.filter(
    ([name, schema]) =>
      name.endsWith('QuerySchema') && name !== 'AdminAuditExportQuerySchema' && hasLimit(schema),
  );

  function hasLimit(schema: z.ZodType): boolean {
    let found = false;
    walk(schema, (_node, key) => {
      if (key === 'limit') found = true;
    });
    return found;
  }

  const limitIssue = (schema: z.ZodType, limit: string): boolean => {
    const result = schema.safeParse({ limit });
    return !result.success && result.error.issues.some((issue) => issue.path.join('.') === 'limit');
  };

  it('covers the paginated lists', () => {
    expect(pageQueries.length).toBeGreaterThanOrEqual(10);
  });

  it.each(pageQueries)('%s refuses limit 101 and accepts 100', (_name, schema) => {
    expect(limitIssue(schema, '101')).toBe(true);
    expect(limitIssue(schema, '100')).toBe(false);
    expect(limitIssue(schema, '0')).toBe(true);
  });

  it('caps the CSV export at 10 000 rows', () => {
    expect(admin.AdminAuditExportQuerySchema.safeParse({ limit: '10000' }).success).toBe(true);
    expect(admin.AdminAuditExportQuerySchema.safeParse({ limit: '10001' }).success).toBe(false);
  });
});

// Response keys that would carry a secret: the SAME classification as the audit redactor
// (admin-audit-keys.ts, review M-2 / N2), so the two can never drift apart.
// A response may still carry four such names on purpose, each pinned to its one place:
const RESPONSE_EXCEPTIONS: ReadonlySet<string> = new Set([
  'AdminMeResponseSchema $.session', // the caller's own session metadata (expiry), no token
  'AdminConfirmationResponseSchema $.challengeId', // the step-up handle, useless without the code
  'AdminUserDetailResponseSchema $.referralCode', // the public invite code the user shares
  'AdminAdjustPreviewResponseSchema $.otpReason', // why a code would be asked (an enum), no code
]);

describe('admin responses carry no secret', () => {
  it.each(responses)('%s has no secret-named field', (name, schema) => {
    walk(schema, (_node, key, path) => {
      if (key === null || RESPONSE_EXCEPTIONS.has(`${name} ${path}`)) return;
      expect(admin.isAuditSecretKey(key), path).toBe(false);
    });
  });

  it('never asks for a full card number', () => {
    for (const [name, schema] of requests) {
      walk(schema, (_node, key) => {
        if (key !== null) expect(['pan', 'cardNumber'], name).not.toContain(key);
      });
    }
  });
});
