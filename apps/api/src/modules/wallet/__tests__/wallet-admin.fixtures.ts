import type { LedgerEntry, Payment } from '@repo/db';
import type { OwnerOtpVerifier } from '../../../common/admin/owner-otp/owner-otp.verifier';
import type { Clock } from '../../../common/clock/clock';
import type { AppConfig } from '../../../config/config.module';
import { WalletAdminService } from '../wallet-admin.service';
import type { WalletCache } from '../wallet-cache';
import type { WalletFrozenAlert } from '../wallet-frozen-alert';
import type { WalletRepository } from '../wallet.repository';

export const THRESHOLD = 100_000_000n;
export const OPERATOR = { operator: 'aziz', ip: '203.0.113.7' };
export const NOW = new Date('2026-11-05T09:00:00.000Z');
/** ADMIN_MANUAL_CREDIT_DAILY_CAP_TIYIN's default (5 000 000 so'm). */
export const MANUAL_CAP = 500_000_000n;

export function entry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    id: 'e-topup',
    userId: 'u1',
    kind: 'TOPUP',
    amountTiyin: 2_000_000n,
    refType: 'PAYMENT',
    refId: 'p1',
    note: null,
    createdAt: NOW,
    ...overrides,
  };
}

export function setup(balance = 1_000_000n) {
  const repo = {
    // The panel's raw reads in the tx (codeless budget, own account) find nothing by default.
    transaction: jest.fn((fn: (tx: object) => Promise<unknown>) =>
      fn({
        $queryRaw: jest.fn().mockResolvedValue([]),
        $executeRaw: jest.fn().mockResolvedValue(0),
      }),
    ),
    lock: jest.fn().mockResolvedValue(undefined),
    balance: jest.fn().mockResolvedValue(balance),
    appendEntry: jest.fn().mockResolvedValue({ id: 'e-new' }),
    createAudit: jest.fn().mockResolvedValue({ id: 'audit-1' }),
    findAudit: jest.fn().mockResolvedValue(null),
    findAuditByTarget: jest.fn().mockResolvedValue(null),
    findEntry: jest.fn().mockResolvedValue(null),
    findPayment: jest.fn(),
    cancelConfirmedPayment: jest.fn().mockResolvedValue(true),
    freezePurchases: jest.fn().mockResolvedValue(true),
    isPurchaseFrozen: jest.fn().mockResolvedValue(false),
    // No automatic P2P top-up in the last 48 h unless a test says so (S9 F-L1).
    recentAutoTopups: jest.fn().mockResolvedValue([]),
    // No open order unless a test says so (I-5, S7a).
    openOrders: jest.fn().mockResolvedValue([]),
    // The daily cap of money created by hand (S6): nothing given by hand yet today.
    lockManualCredits: jest.fn().mockResolvedValue(undefined),
    manualCreditTotalSince: jest.fn().mockResolvedValue(0n),
    // The panel's codeless budget (S6 fix): not passed unless a test says so.
    codelessFlags: jest.fn().mockResolvedValue([]),
    userExists: jest.fn().mockResolvedValue(true),
    isAdminsOwnUser: jest.fn().mockResolvedValue(false),
    findEntryUnlocked: jest.fn(),
  };
  // The unlocked pre-read answers like the locked one (tests set findEntry only).
  repo.findEntryUnlocked.mockImplementation(
    (key: unknown) => repo.findEntry(undefined, key) as Promise<unknown>,
  );
  const cache = { invalidate: jest.fn().mockResolvedValue(undefined) };
  const alert = { raise: jest.fn().mockResolvedValue(undefined) };
  const config = {
    ADMIN_CONFIRM_THRESHOLD_TIYIN: THRESHOLD,
    ADMIN_MANUAL_CREDIT_DAILY_CAP_TIYIN: MANUAL_CAP,
  } as unknown as AppConfig;
  const clock: Clock = { now: () => NOW };
  // A given code counts as verified here; the real checks are OwnerOtpVerifier's (own e2e).
  const otp = {
    verifyIfGiven: jest.fn((answer: unknown) => Promise.resolve(answer !== undefined)),
  };
  const service = new WalletAdminService(
    repo as unknown as WalletRepository,
    cache as unknown as WalletCache,
    alert as unknown as WalletFrozenAlert,
    otp as unknown as OwnerOtpVerifier,
    config,
    clock,
  );
  return { service, repo, cache, alert, otp };
}

export function payment(overrides: Partial<Payment> = {}): Payment {
  return {
    id: 'p1',
    userId: 'u1',
    status: 'CONFIRMED',
    amountTiyin: 2_000_000n,
    ...overrides,
  } as Payment;
}

export function entryByKind(map: Partial<Record<'TOPUP' | 'TOPUP_REVERSAL', LedgerEntry>>) {
  return (_tx: unknown, key: { kind: 'TOPUP' | 'TOPUP_REVERSAL' }) =>
    Promise.resolve(map[key.kind] ?? null);
}

/** The data of the first createAudit call, typed as a plain record for assertions. */
export function auditDataOf(repo: { createAudit: jest.Mock }): Record<string, unknown> {
  const call = repo.createAudit.mock.calls[0] as unknown[] | undefined;
  const data = call?.[1];
  if (typeof data !== 'object' || data === null) throw new Error('createAudit was not called');
  return data as Record<string, unknown>;
}
