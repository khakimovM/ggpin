import type { AdminAuditRow } from '@repo/shared';
import { fireEvent, screen } from '@testing-library/react';
import { Undo2 } from 'lucide-react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminContext } from '../../../app/admin-context';
import { listAudit } from '../../../lib/api/people';
import {
  adminActionId,
  beginAttempt,
  markActionOutcomeUnknown,
  pendingAction,
} from '../../../lib/idempotency';
import { expectedAuditId } from '../../../lib/idempotency-outcome';
import { meFixture } from '../../../lib/api/mock/fixtures';
import { renderAdmin } from '../../../test/render';
import { ReasonDialog } from '../ReasonDialog';

vi.mock('../../../lib/api/people', () => ({ listAudit: vi.fn() }));
const audit = vi.mocked(listAudit);

const me = meFixture('OWNER', new Date('2026-11-17T09:00:00Z'));
const T0 = Date.parse('2026-11-17T09:00:00Z');
/** performance.now() at T0: the monotonic clock of this tab (SA-2). */
const M0 = 1_000;
let seq = 0;

/** One page of the audit log as the API returns it. */
function page(ids: string[]): Awaited<ReturnType<typeof listAudit>> {
  const items: AdminAuditRow[] = ids.map((id) => ({
    id,
    createdAt: new Date(T0).toISOString(),
    actor: { type: 'ADMIN', id: me.admin.id, name: me.admin.name },
    action: 'PAYMENT_REVERSE',
    targetType: 'Payment',
    targetId: 'x',
    before: null,
    after: null,
    reason: null,
    ip: null,
  }));
  return { items, meta: { page: 1, limit: 100, total: items.length } };
}

/** An action whose last attempt (sent at T0) has an unknown outcome. */
function unknownAction() {
  seq += 1;
  const action = adminActionId(me.admin.id, 'payments.reverse', `outcome_${seq}`);
  vi.spyOn(Date, 'now').mockReturnValue(T0);
  vi.spyOn(performance, 'now').mockReturnValue(M0);
  const { key, attempt } = beginAttempt(action);
  markActionOutcomeUnknown(action, key, {
    reason: 'Pul bank orqali qaytdi',
    conflict: false,
    attempt,
  });
  return { action, key };
}

function renderAt(
  now: number,
  action: ReturnType<typeof unknownAction>['action'],
  found = vi.fn(),
  mono = M0 + (now - T0),
  submit: () => Promise<void> = () => Promise.resolve(),
) {
  vi.spyOn(Date, 'now').mockReturnValue(now);
  vi.spyOn(performance, 'now').mockReturnValue(mono);
  const onOpenChange = vi.fn();
  renderAdmin(
    <AdminContext.Provider value={me}>
      <ReasonDialog
        action={action}
        open
        onOpenChange={onOpenChange}
        title="Qaytarish"
        icon={Undo2}
        submitLabel="Qaytarish"
        actor={{ name: me.admin.name, role: me.admin.role }}
        onOutcomeFound={found}
        onSubmit={submit}
      />
    </AdminContext.Provider>,
  );
  return { found, onOpenChange };
}

afterEach(() => {
  vi.restoreAllMocks();
  audit.mockReset();
});

describe('OutcomeCheck ("Yangi amal sifatida boshlash", Q1 = A)', () => {
  it('finds the row by the expected audit id: the dialog closes and the key is settled', async () => {
    const { action, key } = unknownAction();
    const id = await expectedAuditId(me.admin.id, key);
    audit.mockResolvedValue(page([id]));
    const { found, onOpenChange } = renderAt(T0 + 5_000, action);
    fireEvent.click(screen.getByRole('button', { name: 'Bajarilganini tekshirish' }));
    await vi.waitFor(() => expect(found).toHaveBeenCalled());
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(pendingAction(action)).toBeNull();
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: me.admin.id, targetId: `outcome_${seq}` }),
    );
  });

  it('not found within 60 s: waits, no new key is offered', async () => {
    const { action, key } = unknownAction();
    audit.mockResolvedValue(page([]));
    renderAt(T0 + 10_000, action);
    fireEvent.click(screen.getByRole('button', { name: 'Bajarilganini tekshirish' }));
    expect(await screen.findByText(/soniyadan keyin yana tekshiring/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Yangi amal sifatida boshlash' })).toBeNull();
    expect(pendingAction(action)?.key).toBe(key);
  });

  it('not found after 60 s: "start as a new action" replaces the key', async () => {
    const { action, key } = unknownAction();
    audit.mockResolvedValue(page([]));
    renderAt(T0 + 61_000, action);
    fireEvent.click(screen.getByRole('button', { name: 'Bajarilganini tekshirish' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Yangi amal sifatida boshlash' }));
    const next = pendingAction(action);
    expect(next?.key).not.toBe(key);
    expect(next).toMatchObject({ unknown: false, conflict: false });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('a wall clock jumped forward does not open it early: the monotonic clock still says 10 s (SA-2)', async () => {
    const { action, key } = unknownAction();
    audit.mockResolvedValue(page([]));
    renderAt(T0 + 61_000, action, vi.fn(), M0 + 10_000);
    fireEvent.click(screen.getByRole('button', { name: 'Bajarilganini tekshirish' }));
    expect(await screen.findByText(/soniyadan keyin yana tekshiring/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Yangi amal sifatida boshlash' })).toBeNull();
    expect(pendingAction(action)?.key).toBe(key);
  });

  it('a "not found" made before a resend with the same key gives no new key (R-1)', async () => {
    const { action, key } = unknownAction();
    audit.mockResolvedValue(page([]));
    // The resend fails without an answer: its outcome is unknown too (the server may have run it).
    const resend = vi.fn(() => Promise.reject(new Error('network')));
    renderAt(T0 + 61_000, action, vi.fn(), M0 + 61_000, resend);
    fireEvent.click(screen.getByRole('button', { name: 'Bajarilganini tekshirish' }));
    await screen.findByRole('button', { name: 'Yangi amal sifatida boshlash' });
    // The admin does not start anew: they send the form again with the same key.
    vi.spyOn(Date, 'now').mockReturnValue(T0 + 62_000);
    vi.spyOn(performance, 'now').mockReturnValue(M0 + 62_000);
    fireEvent.click(screen.getByRole('button', { name: 'Qaytarish' }));
    await vi.waitFor(() =>
      expect(resend).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: key })),
    );
    // The failure is shown once the resend settled (marked unknown, not in flight).
    await screen.findByRole('alert');
    // 61 s after the resend: the old verdict must not open a new key without a new search.
    vi.spyOn(Date, 'now').mockReturnValue(T0 + 123_000);
    vi.spyOn(performance, 'now').mockReturnValue(M0 + 123_000);
    const stale = screen.queryByRole('button', { name: 'Yangi amal sifatida boshlash' });
    if (stale !== null) fireEvent.click(stale);
    expect(pendingAction(action)?.key).toBe(key);
    expect(screen.getByRole('button', { name: 'Bajarilganini tekshirish' })).toBeInTheDocument();
    // A fresh search after the resend is what may offer a new key.
    fireEvent.click(screen.getByRole('button', { name: 'Bajarilganini tekshirish' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Yangi amal sifatida boshlash' }));
    expect(pendingAction(action)?.key).not.toBe(key);
  });

  it('a failed search says so and never offers a new key', async () => {
    const { action } = unknownAction();
    audit.mockRejectedValue(new Error('500'));
    renderAt(T0 + 61_000, action);
    fireEvent.click(screen.getByRole('button', { name: 'Bajarilganini tekshirish' }));
    expect(
      await screen.findByText('Tekshirib bo‘lmadi. Qayta urinib ko‘ring.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Yangi amal sifatida boshlash' })).toBeNull();
  });
});
