import type { NumberedAttemptRow } from '@repo/shared';
import { cliChannelForCliModule } from '../operator-channel';
import type { OrderAdminEffects } from '../order-admin-effects';
import type { AuditInput, OrderAdminRepository } from '../order-admin.repository';
import { OrderRetryService, assertRetryAuditShape } from '../order-retry.service';

// The release audit row is parsed with the shared OrderRetryAuditSchema BEFORE it is written
// (phase 5 S9b fix round, audit L-2): the worker reads it with the same schema, so a row it could
// not read is never written and the order is never released without it.

const ORDER = 'ckorder0000000000000000001';
const INPUT = { orderId: ORDER, reason: 'checked twice', operator: 'aziz', osUser: 'ops' };

function serviceWith(attempts: NumberedAttemptRow[]) {
  const createAudit = jest.fn((_tx: unknown, _data: AuditInput) => Promise.resolve({ id: 'a1' }));
  const release = jest.fn(() => Promise.resolve({ eventId: 'e1' }));
  const repo = {
    transaction: <T>(fn: (tx: unknown) => Promise<T>) => fn({}),
    lockOrder: () => Promise.resolve({ status: 'HELD', statusReason: 'ADAPTER_ERROR' }),
    lastEvent: () => Promise.resolve(null),
    attemptErrors: () => Promise.resolve(attempts),
    createAudit,
    release,
  };
  const effects = {
    requeue: () => Promise.resolve('QUEUED'),
    adminAction: () => Promise.resolve(true),
  };
  const service = new OrderRetryService(
    repo as unknown as OrderAdminRepository,
    effects as unknown as OrderAdminEffects,
    cliChannelForCliModule(),
  );
  return { service, createAudit, release };
}

describe('OrderRetryService: the release row in the shared shape', () => {
  it('writes maxAttemptNo (the highest number) and the CLI / OWNER actor', async () => {
    const { service, createAudit } = serviceWith([
      { attemptNo: 4, error: 'TON_EXPIRED' },
      { attemptNo: 6, error: 'LOW_BALANCE' },
    ]);
    await expect(service.retry(INPUT)).resolves.toMatchObject({ applied: true, attemptsUsed: 1 });
    expect(createAudit).toHaveBeenCalledTimes(1);
    const data = createAudit.mock.calls[0]?.[1];
    expect(data?.before).toMatchObject({ maxAttemptNo: 6 });
    expect(data?.after).toMatchObject({ actor: { type: 'CLI', role: 'OWNER' } });
  });

  it('a row the schema refuses (a fractional attempt number) is not written, nothing released', async () => {
    const { service, createAudit, release } = serviceWith([{ attemptNo: 1.5, error: null }]);
    await expect(service.retry(INPUT)).rejects.toThrow('OrderRetryAuditSchema');
    expect(createAudit).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it('assertRetryAuditShape: the shared shape only', () => {
    const actor = { type: 'CLI', role: 'OWNER' };
    expect(() => assertRetryAuditShape({ maxAttemptNo: 0 }, { actor })).not.toThrow();
    expect(() => assertRetryAuditShape({ maxAttemptNo: -1 }, { actor })).toThrow();
    expect(() => assertRetryAuditShape({ maxAttemptNo: 2 }, {})).toThrow();
    const unknownRole = { actor: { type: 'CLI', role: 'ROOT' } };
    expect(() => assertRetryAuditShape({ maxAttemptNo: 2 }, unknownRole)).toThrow();
  });
});
