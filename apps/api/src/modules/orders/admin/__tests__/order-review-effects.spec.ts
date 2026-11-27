import { EFFECTS_REPLAY_MAX_AGE_MS } from '../order-review.service';
import { HEX, NOW, detail, input, setup } from './order-review.harness';

// OrderReviewService, fix round of S10: the audit acknowledgement (L-4), the recorded bounce
// (CR M2), the replay window of the effects (CR i1, L-5) and the security alert (CR M3).

describe('OrderReviewService (effects and proofs)', () => {
  it('audit L-4: the confirmed I-8 is passed on to the audit row as an acknowledgement', async () => {
    const manual = { kind: 'MANUAL', evidence: 'receipt' };
    const s = setup({ otpVerified: true });
    s.repo.detail.mockResolvedValue({
      ...detail(),
      attempts: [{ status: 'UNKNOWN', response: {}, tonTransfer: { id: 't', status: 'EXPIRED' } }],
    });
    s.repo.notSentTransfers.mockResolvedValue(1); // the locked rows agree: TON never left
    await s.service.resolve(
      input({ proof: manual, confirmAmountTiyin: 550_000n, confirmOutsideSystem: true }),
    );
    expect(s.repo.resolve).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ acknowledgements: ['DELIVERED_OUTSIDE_SYSTEM'] }),
    );
    // Without the flag nothing is acknowledged.
    const plain = setup();
    await plain.service.resolve(input());
    expect(plain.repo.resolve).toHaveBeenCalledWith(
      {},
      expect.not.objectContaining({ acknowledgements: expect.anything() as unknown }),
    );
  });

  it('re-review N4: the flag where I-8 does not apply is refused, never stored', async () => {
    // A chain proof (or a transfer that left): refused before any transaction.
    const chain = setup();
    await expect(
      chain.service.resolve(input({ confirmOutsideSystem: true })),
    ).rejects.toMatchObject({
      details: { field: 'confirmOutsideSystem', reason: 'OUTSIDE_SYSTEM_NOT_APPLICABLE' },
    });
    expect(chain.repo.transaction).not.toHaveBeenCalled();

    // The preview saw a transfer that never left; the locked rows say it did: the acknowledgement
    // written inside the transaction is rolled back by the refusal, and no effect is queued.
    const manual = { kind: 'MANUAL', evidence: 'receipt' };
    const raced = setup({ otpVerified: true });
    raced.repo.detail.mockResolvedValue({
      ...detail(),
      attempts: [{ status: 'UNKNOWN', response: {}, tonTransfer: { id: 't', status: 'EXPIRED' } }],
    });
    raced.repo.notSentTransfers.mockResolvedValue(0);
    const asked = input({
      proof: manual,
      confirmAmountTiyin: 550_000n,
      confirmOutsideSystem: true,
    });
    await expect(raced.service.resolve(asked)).rejects.toMatchObject({
      details: { field: 'confirmOutsideSystem', reason: 'OUTSIDE_SYSTEM_NOT_APPLICABLE' },
    });
    expect(raced.repo.transaction).toHaveBeenCalledTimes(1);
    expect(raced.effects.afterResolve).not.toHaveBeenCalled();
  });

  it('CR M2: a TON_BOUNCED proof that differs from the bounce the worker recorded opens nothing', async () => {
    const bounce = {
      txHash: HEX,
      txLt: '10',
      returnTxHash: 'b'.repeat(64),
      returnLt: '16',
      returnedNanoTon: '230000000',
    };
    const s = setup({ otpVerified: true });
    s.repo.detail.mockResolvedValue({
      ...detail('NEEDS_REVIEW'),
      attempts: [
        {
          status: 'UNKNOWN',
          response: { ton: { bounce } },
          tonTransfer: { id: 'ckt0000000000000000000001', status: 'BOUNCED' },
        },
      ],
    });
    const proof = {
      kind: 'TON_BOUNCED',
      transferId: 'ckt0000000000000000000001',
      ...bounce,
      returnTxHash: 'c'.repeat(64),
    };
    await expect(
      s.service.resolve(input({ to: 'FAILED', proof, confirmAmountTiyin: 550_000n })),
    ).rejects.toMatchObject({ details: { field: 'proof', reason: 'BOUNCE_FACTS_MISMATCH' } });
    expect(s.repo.transaction).not.toHaveBeenCalled();
    expect(s.otp.verifyIfGiven).not.toHaveBeenCalled();
  });

  it('CR i1 / audit L-5: a replay queues the effects again only inside the dedupe window', async () => {
    const inside = setup({ status: 'DELIVERED' });
    inside.repo.resolution.mockResolvedValue({
      auditId: 'audit0',
      auditAt: new Date(NOW.getTime() - EFFECTS_REPLAY_MAX_AGE_MS),
      to: 'DELIVERED',
      proofKind: 'TON_TX',
      compromisedTransferId: 'ckt0000000000000000000009',
    });
    const again = await inside.service.resolve(input());
    expect(again.effects).not.toBeNull();
    expect(inside.effects.afterResolve).toHaveBeenCalledWith(
      expect.objectContaining({ compromisedTransferId: 'ckt0000000000000000000009' }),
    );

    const outside = setup({ status: 'DELIVERED' });
    outside.repo.resolution.mockResolvedValue({
      auditId: 'audit0',
      auditAt: new Date(NOW.getTime() - EFFECTS_REPLAY_MAX_AGE_MS - 1),
      to: 'DELIVERED',
      proofKind: 'TON_TX',
      compromisedTransferId: 'ckt0000000000000000000009',
    });
    const late = await outside.service.resolve(input());
    expect(late).toMatchObject({ applied: false, auditId: 'audit0', effects: null });
    expect(outside.effects.afterResolve).not.toHaveBeenCalled();
  });

  it('a TON_UNMATCHED_RESOLVED NOT_SENT finding asks for no security alert', async () => {
    const s = setup({ otpVerified: true });
    s.repo.resolve.mockResolvedValue({
      result: {
        to: 'FAILED',
        userId: 'u1',
        refund: null,
        closedAttemptIds: ['a1'],
        securityAlert: null,
      },
      auditId: 'audit1',
    });
    s.repo.detail.mockResolvedValue({
      ...detail(),
      attempts: [
        {
          status: 'UNKNOWN',
          response: {},
          tonTransfer: { id: 'ckt0000000000000000000001', status: 'CONSUMED_UNMATCHED' },
        },
      ],
    });
    const proof = {
      kind: 'TON_UNMATCHED_RESOLVED',
      transferId: 'ckt0000000000000000000001',
      finding: 'NOT_SENT',
      consumingTxHash: HEX,
    };
    await s.service.resolve(
      input({
        to: 'FAILED',
        proof,
        reason: 'the seqno was used by a transfer that moved nothing',
        confirmAmountTiyin: 550_000n,
      }),
    );
    expect(s.effects.afterResolve).toHaveBeenCalledWith(
      expect.objectContaining({ compromisedTransferId: null }),
    );
  });

  it('L-4: a replay whose order cannot be read passes userId null (no wallet key for "")', async () => {
    const s = setup({ status: 'DELIVERED' });
    s.repo.detail.mockResolvedValueOnce(detail('DELIVERED')).mockResolvedValue(null);
    const done = await s.service.resolve(input());
    expect(done).toMatchObject({ applied: false, auditId: 'audit0' });
    expect(s.effects.afterResolve).toHaveBeenCalledWith(
      expect.objectContaining({ auditId: 'audit0', userId: null }),
    );
  });
});
