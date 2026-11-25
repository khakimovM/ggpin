import { cliChannelForCliModule } from '../operator-channel';
import { OrderReviewService, type ResolveInput } from '../order-review.service';
import type { OrderAdminEffects } from '../order-admin-effects';
import type { OrderAdminRepository } from '../order-admin.repository';
import type { OwnerOtpVerifier } from '../../../../common/admin/owner-otp/owner-otp.verifier';
import type { AppConfig } from '../../../../config/config.module';

// OrderReviewService with its collaborators mocked (no database), for the review specs.

export const ORDER = 'ckorder0000000000000000001';
export const HEX = 'a'.repeat(64);
export const WALLET = `0:${'b'.repeat(64)}`;
export const THRESHOLD = 100_000_000n;

export const TON_TX = {
  kind: 'TON_TX',
  extMsgHash: HEX,
  walletAddress: WALLET,
  txHash: HEX,
  lt: '7',
};

export function detail(status = 'NEEDS_REVIEW', priceTiyin = 550_000n) {
  return {
    id: ORDER,
    number: 7,
    status,
    priceTiyin,
    discountTiyin: 0n,
    userId: 'u1',
    attempts: [{ status: 'UNKNOWN', response: {}, tonTransfer: { id: 't1', status: 'CONFIRMED' } }],
  };
}

export const deadlock = () =>
  Object.assign(new Error('deadlock detected (40P01)'), { code: 'P2034' });

export const NOW = new Date('2026-11-15T10:00:00.000Z');

export function setup(options: { channel?: unknown; otpVerified?: boolean; status?: string } = {}) {
  const resolve = jest.fn().mockResolvedValue({
    result: { to: 'DELIVERED', userId: 'u1', refund: null, closedAttemptIds: ['a1'] },
    auditId: 'audit1',
  });
  const repo = {
    detail: jest.fn().mockResolvedValue(detail(options.status)),
    transaction: jest.fn((work: (tx: unknown) => Promise<unknown>) => work({})),
    resolve,
    notSentTransfers: jest.fn().mockResolvedValue(0),
    resolution: jest.fn().mockResolvedValue({
      auditId: 'audit0',
      auditAt: new Date(NOW.getTime() - 60_000),
      to: 'DELIVERED',
      proofKind: 'TON_TX',
      compromisedTransferId: null,
    }),
  };
  const otp = { verifyIfGiven: jest.fn().mockResolvedValue(options.otpVerified ?? false) };
  const report = { customerNotified: true, adminAction: true, reviewResolved: true };
  const effects = { afterResolve: jest.fn().mockResolvedValue({ ...report, securityAlert: null }) };
  const service = new OrderReviewService(
    repo as unknown as OrderAdminRepository,
    otp as unknown as OwnerOtpVerifier,
    effects as unknown as OrderAdminEffects,
    { ADMIN_CONFIRM_THRESHOLD_TIYIN: THRESHOLD } as AppConfig,
    { now: () => NOW },
    ('channel' in options ? options.channel : cliChannelForCliModule()) as ReturnType<
      typeof cliChannelForCliModule
    >,
  );
  return { service, repo, otp, effects };
}

export const input = (overrides: Partial<ResolveInput> = {}): ResolveInput => ({
  orderId: ORDER,
  to: 'DELIVERED',
  proof: TON_TX,
  reason: 'found it in the wallet history',
  operator: 'aziz',
  confirmOutsideSystem: false,
  ...overrides,
});
