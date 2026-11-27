import { StaleOrderStateError } from '@repo/db';
import {
  ORDER,
  NOW,
  THRESHOLD,
  TON_TX,
  deadlock,
  detail,
  input,
  setup,
} from './order-review.harness';

// OrderReviewService without a database: the order of the checks (channel, proof, I-8, owner code)
// before any transaction, the deadlock retry of the whole transaction, and the replay of a lost race.

describe('OrderReviewService', () => {
  it('refuses any process that is not the CLI before reading a row (OWNER_REQUIRED)', async () => {
    for (const channel of [undefined, 'HTTP', 'ADMIN', 'CLI', { kind: 'CLI' }]) {
      const s = setup({ channel });
      await expect(s.service.resolve(input())).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        details: { field: 'actor', reason: 'OWNER_REQUIRED' },
      });
      expect(s.repo.detail).not.toHaveBeenCalled();
      expect(s.repo.transaction).not.toHaveBeenCalled();
    }
  });

  it('refuses a missing, malformed or wrong-direction proof, or another reason, before any write', async () => {
    const s = setup();
    for (const [proof, to, reason] of [
      [undefined, 'DELIVERED', 'INVALID'],
      [{ kind: 'TON_TX' }, 'DELIVERED', 'INVALID'],
      [TON_TX, 'FAILED', 'WRONG_KIND'],
      [{ ...TON_TX, reason: 'something else' }, 'DELIVERED', 'REASON_DIFFERS'],
    ] as const) {
      await expect(s.service.resolve(input({ proof, to }))).rejects.toMatchObject({
        details: { field: 'proof', reason },
      });
    }
    expect(s.repo.transaction).not.toHaveBeenCalled();
  });

  it('MANUAL needs the re-typed total and a verified code: without them nothing is opened', async () => {
    const manual = { kind: 'MANUAL', evidence: 'receipt' };
    const s = setup({ otpVerified: false });
    await expect(
      s.service.resolve(input({ proof: manual, confirmAmountTiyin: 550_000n })),
    ).rejects.toMatchObject({ details: { field: 'otp', reason: 'OTP_REQUIRED' } });
    await expect(s.service.resolve(input({ proof: manual }))).rejects.toMatchObject({
      details: { field: 'confirmAmountTiyin' },
    });
    expect(s.repo.transaction).not.toHaveBeenCalled();

    const ok = setup({ otpVerified: true });
    const done = await ok.service.resolve(
      input({ proof: manual, confirmAmountTiyin: 550_000n, otp: { challengeId: 'c', code: '1' } }),
    );
    expect(done.applied).toBe(true);
    expect(ok.repo.resolve).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        resolver: expect.objectContaining({
          kind: 'operator',
          type: 'CLI',
          otpVerified: true,
        }) as unknown,
      }),
    );
  });

  it('a chain proof needs no code at or below the threshold, and does above it', async () => {
    const below = setup();
    expect((await below.service.preview(input())).needsOtp).toBe(false);
    const above = setup();
    above.repo.detail.mockResolvedValue(detail('NEEDS_REVIEW', THRESHOLD + 1n));
    expect((await above.service.preview(input())).needsOtp).toBe(true);
    await expect(above.service.resolve(input())).rejects.toMatchObject({
      details: { field: 'confirmAmountTiyin' },
    });
    expect(above.repo.transaction).not.toHaveBeenCalled();
  });

  it('a deadlock runs the whole transaction again (at most 3 times), then gives up', async () => {
    const once = setup();
    once.repo.resolve.mockRejectedValueOnce(deadlock());
    expect((await once.service.resolve(input())).applied).toBe(true);
    expect(once.repo.transaction).toHaveBeenCalledTimes(2);

    const always = setup();
    always.repo.resolve.mockRejectedValue(deadlock());
    await expect(always.service.resolve(input())).rejects.toThrow('deadlock');
    expect(always.repo.transaction).toHaveBeenCalledTimes(3);
    expect(always.effects.afterResolve).not.toHaveBeenCalled();
  });

  it('a lost race replays the earlier resolution (same exit and proof kind) and writes nothing', async () => {
    const s = setup();
    s.repo.resolve.mockRejectedValue(new StaleOrderStateError(ORDER, 'NEEDS_REVIEW'));
    s.repo.detail
      .mockResolvedValueOnce(detail('NEEDS_REVIEW'))
      .mockResolvedValue(detail('DELIVERED'));
    const done = await s.service.resolve(input());
    expect(done).toMatchObject({ applied: false, auditId: 'audit0', refundTiyin: null });
    expect(s.effects.afterResolve).toHaveBeenCalledWith(
      expect.objectContaining({ auditId: 'audit0', refunded: false }),
    );

    // Resolved the other way earlier: refused, never "applied".
    const other = setup({ status: 'REFUNDED' });
    other.repo.resolution.mockResolvedValue({
      auditId: 'audit0',
      auditAt: NOW,
      to: 'FAILED',
      proofKind: 'TON_NOT_SENT',
      compromisedTransferId: null,
    });
    await expect(other.service.resolve(input())).rejects.toMatchObject({
      details: { field: 'order', reason: 'NOT_IN_REVIEW' },
    });
  });

  it('I-8: MANUAL delivery whose transfer never left is refused without the confirmation, even under lock', async () => {
    const manual = { kind: 'MANUAL', evidence: 'receipt' };
    const s = setup({ otpVerified: true });
    s.repo.detail.mockResolvedValue({
      ...detail(),
      attempts: [{ status: 'UNKNOWN', response: {}, tonTransfer: { id: 't', status: 'EXPIRED' } }],
    });
    const asked = input({ proof: manual, confirmAmountTiyin: 550_000n });
    await expect(s.service.resolve(asked)).rejects.toMatchObject({
      details: { reason: 'OUTSIDE_SYSTEM_CONFIRMATION_REQUIRED' },
    });
    expect(s.repo.transaction).not.toHaveBeenCalled();
    expect((await s.service.preview(asked)).otpFlags).toBe('delivered-outside-system');

    // The preview saw a confirmed transfer, the locked rows one that never left: rolled back.
    const raced = setup({ otpVerified: true });
    raced.repo.notSentTransfers.mockResolvedValue(1);
    await expect(raced.service.resolve(asked)).rejects.toMatchObject({
      details: { reason: 'OUTSIDE_SYSTEM_CONFIRMATION_REQUIRED' },
    });
    expect(raced.effects.afterResolve).not.toHaveBeenCalled();
  });
});
