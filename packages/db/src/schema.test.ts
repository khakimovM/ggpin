import { readFileSync } from 'node:fs';
import { ORDER_STATUSES } from '@repo/shared';
import { describe, expect, it } from 'vitest';
import { OrderStatus } from './index.js';

// Schema-level guarantees that need no database. The behavioural counterparts (constraints
// actually firing) live in test/*.e2e.test.ts.
const schema = readFileSync(new URL('../prisma/schema.prisma', import.meta.url), 'utf8');

function modelBlocks(): Map<string, string> {
  const blocks = new Map<string, string>();
  for (const match of schema.matchAll(/^model (\w+) \{\n([\s\S]*?)^\}/gm)) {
    const [, name, body] = match;
    if (name !== undefined && body !== undefined) blocks.set(name, body);
  }
  return blocks;
}

const fieldNames = (body: string): string[] =>
  body
    .split('\n')
    .map((line) => line.trim().split(/\s+/)[0])
    .filter((name): name is string => name !== undefined && /^[a-z]\w*$/.test(name));

describe('schema.prisma', () => {
  it('OrderStatus enum equals ORDER_STATUSES from @repo/shared (same members, same order)', () => {
    expect(Object.values(OrderStatus)).toEqual([...ORDER_STATUSES]);
  });

  it('parses every model', () => {
    expect(modelBlocks().size).toBeGreaterThanOrEqual(29);
  });

  it.each(['LedgerEntry', 'CoinEntry', 'AuditLog', 'OrderEvent'])(
    'append-only %s has no updatedAt',
    (model) => {
      const body = modelBlocks().get(model);
      expect(body).toBeDefined();
      expect(fieldNames(body ?? '')).not.toContain('updatedAt');
    },
  );

  it('every model has createdAt (rules/20-database-prisma.md)', () => {
    for (const [name, body] of modelBlocks()) {
      expect(fieldNames(body), name).toContain('createdAt');
    }
  });

  it('Order keeps the FX snapshot id with an FK and an index', () => {
    const order = modelBlocks().get('Order') ?? '';
    expect(order).toMatch(/fxRateId\s+String\s/);
    expect(order).toContain('fields: [fxRateId], references: [id], onDelete: Restrict');
    expect(order).toContain('@@index([fxRateId])');
  });

  it('uses no Decimal or Float column anywhere (money is BigInt minor units)', () => {
    expect(schema).not.toMatch(/^\s+\w+\s+(Decimal|Float)\b/m);
  });

  it('declares the idempotency uniques', () => {
    const models = modelBlocks();
    const expectations: Record<string, string> = {
      Payment: '@@unique([provider, providerTxnId])',
      Order: '@@unique([userId, idempotencyKey])',
      PaymentIntent: '@@unique([userId, idempotencyKey])',
      FulfillmentAttempt: '@@unique([orderId, attemptNo])',
      LedgerEntry: '@@unique([refType, refId, kind])',
      CoinEntry: '@@unique([refType, refId, kind])',
    };
    for (const [model, unique] of Object.entries(expectations)) {
      expect(models.get(model), model).toContain(unique);
    }
  });

  it('FulfillmentAttempt: one external payout (tx hash / supplier order id) per attempt', () => {
    const body = modelBlocks().get('FulfillmentAttempt') ?? '';
    expect(body).toContain('@@unique([adapter, externalRef])');
    // lookups by externalRef alone (reconciler, tx hash from the chain) still need this index
    expect(body).toContain('@@index([externalRef])');
  });

  it('never uses onDelete: SetNull, and cascades only on credential tables', () => {
    expect(schema).not.toContain('onDelete: SetNull');
    const cascading = [...modelBlocks()]
      .filter(([, body]) => body.includes('onDelete: Cascade'))
      .map(([name]) => name)
      .sort();
    expect(cascading).toEqual(['AdminSession', 'WebSession']);
  });
});
