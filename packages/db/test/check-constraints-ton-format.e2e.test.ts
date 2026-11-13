import { RAW_TON_ADDRESS_PATTERN, TON_HASH_PATTERN } from '@repo/shared';
import { describe, expect, it } from 'vitest';
import type { Prisma } from '../src/index';
import { expectCheck } from './check-helpers';
import { db } from './client';

// Audit M2 / N6: one spelling per TON account and per hash, stored raw. The other CHECKs and the
// partial uniques of TonTransfer are in check-constraints-ton-transfer.e2e.test.ts.

let counter = 0;
const next = (): number => ++counter;
const hex64 = (n: number): string => n.toString(16).padStart(64, '0');
const raw = (n: number): string => `0:${hex64(n)}`;

/** Input for a new transfer: SIGNED, the only status a transfer is born with. */
function transfer(
  overrides: Partial<Prisma.TonTransferUncheckedCreateInput> = {},
): Prisma.TonTransferUncheckedCreateInput {
  const n = next();
  return {
    purpose: 'SELFTEST',
    network: 'testnet',
    walletAddress: raw(1),
    seqno: n,
    validUntil: new Date('2026-11-11T10:01:00.000Z'),
    toAddress: raw(2),
    amountNanoTon: 1_000_000_000n,
    payloadHash: hex64(3),
    extMsgHash: hex64(1000 + n),
    bocBase64: 'te6cc',
    status: 'SIGNED',
    ...overrides,
  };
}

describe('address and hash formats (audit M2)', () => {
  it('only the raw address form is stored: one spelling per account', async () => {
    // The same account, three spellings: the raw form is the only one accepted.
    const spellings = [
      '0:abababababababababababababababababababababababababababababababab',
      'EQCrq6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq8Uk',
      'UQCrq6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq5jh',
    ];
    await db.tonTransfer.create({ data: transfer({ walletAddress: spellings[0] ?? '' }) });
    for (const walletAddress of spellings.slice(1)) {
      await expectCheck(
        db.tonTransfer.create({ data: transfer({ walletAddress }) }),
        'TonTransfer_address_format_check',
      );
    }
  });

  it('refuses a wallet or destination that is not <workchain>:<64 lowercase hex>', async () => {
    const bad = [
      '',
      '0:' + 'a'.repeat(63),
      '0:' + 'a'.repeat(65),
      '0:' + 'A'.repeat(64),
      'x:' + 'a'.repeat(64),
      '0:' + 'g'.repeat(64),
      '1234:' + 'a'.repeat(64),
      ' 0:' + 'a'.repeat(64),
    ];
    for (const value of bad) {
      await expectCheck(
        db.tonTransfer.create({ data: transfer({ walletAddress: value }) }),
        'TonTransfer_address_format_check',
      );
      await expectCheck(
        db.tonTransfer.create({ data: transfer({ toAddress: value }) }),
        'TonTransfer_address_format_check',
      );
    }
    for (const ok of ['-1:' + 'a'.repeat(64), '0:' + '0'.repeat(64)]) {
      await db.tonTransfer.create({ data: transfer({ walletAddress: ok }) });
    }
  });

  it('N6: the workchain is 0 or -1 literally; 00, 000, -0, +0, 01 and -01 spell the same chains and are refused', async () => {
    const same = 'ab'.repeat(32);
    await db.tonTransfer.create({ data: transfer({ walletAddress: `0:${same}` }) });
    for (const workchain of ['00', '000', '-0', '+0', '01', '-01', '-00', '2', '-2']) {
      await expectCheck(
        db.tonTransfer.create({ data: transfer({ walletAddress: `${workchain}:${same}` }) }),
        'TonTransfer_address_format_check',
      );
      await expectCheck(
        db.tonTransfer.create({ data: transfer({ toAddress: `${workchain}:${same}` }) }),
        'TonTransfer_address_format_check',
      );
    }
  });

  it('the SQL address and hash patterns are the ones @repo/shared exports (no drift)', async () => {
    const rows = await db.$queryRaw<{ def: string }[]>`
      SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c
      WHERE c.conname IN ('TonTransfer_address_format_check', 'TonTransfer_hash_format_check')`;
    const defs = rows.map((r) => r.def).join(' ');
    expect(defs).toContain(RAW_TON_ADDRESS_PATTERN.source);
    expect(defs).toContain(TON_HASH_PATTERN.source);
  });

  it('refuses a message, payload or transaction hash that is not 64 lowercase hex', async () => {
    for (const bad of ['', 'abc', 'A'.repeat(64), 'g'.repeat(64), 'a'.repeat(65), 'ext-1']) {
      await expectCheck(
        db.tonTransfer.create({ data: transfer({ extMsgHash: bad }) }),
        'TonTransfer_hash_format_check',
      );
      await expectCheck(
        db.tonTransfer.create({ data: transfer({ payloadHash: bad }) }),
        'TonTransfer_hash_format_check',
      );
      const row = await db.tonTransfer.create({
        data: transfer({ walletAddress: raw(60 + next()) }),
      });
      await expectCheck(
        db.tonTransfer.update({
          where: { id: row.id },
          data: { status: 'CONFIRMED', txHash: bad, txLt: 1n },
        }),
        'TonTransfer_hash_format_check',
      );
    }
  });
});
