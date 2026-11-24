// Tests for the S5 re-review fixes that had none (M-3): R-3, R-6 (+ M-1), R-7 (+ M-4), R-13.
import type { AdminSessionListResponse } from '@repo/shared';
import { fireEvent, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminContext } from '../../../app/admin-context';
import { listAdminSessions } from '../../../lib/api/reads';
import { meFixture } from '../../../lib/api/mock/fixtures';
import { dashboardFixture } from '../../../lib/api/mock/fixtures-dashboard';
import { ADMINS, adminSessionsFixture } from '../../../lib/api/mock/fixtures-ops';
import { renderAdmin } from '../../../test/render';
import { AdminSessions } from '../../admins/AdminSessions';
import { AuditDrawer } from '../../audit/AuditDrawer';
import { DashboardCharts } from '../../dashboard/DashboardCharts';
import { ReconExamples } from '../../recon/ReconExamples';

vi.mock('../../../lib/api/reads', () => ({ listAdminSessions: vi.fn() }));
const sessions = vi.mocked(listAdminSessions);

afterEach(() => {
  sessions.mockReset();
});

describe('R-3: the dashboard chart on "today"', () => {
  it('explains the daily chart instead of saying there is no data', () => {
    renderAdmin(<DashboardCharts charts={dashboardFixture('today', false).charts} today />);
    expect(
      screen.getByText('Kunlik grafik uchun «7 kun» yoki «30 kun»ni tanlang'),
    ).toBeInTheDocument();
  });
});

describe('R-6 / M-1: the audit drawer opened by ?entry=', () => {
  const props = { entry: undefined, open: true, onClose: () => {} };

  it('shows a skeleton while the list loads, not "not on page"', () => {
    renderAdmin(<AuditDrawer {...props} loading />);
    expect(screen.getByRole('status', { name: 'Yuklanmoqda…' })).toBeInTheDocument();
    expect(screen.queryByText(/joriy sahifada yo‘q/)).toBeNull();
  });

  it('a failed load says so and retries (M-1)', () => {
    const onRetry = vi.fn();
    renderAdmin(<AuditDrawer {...props} loading={false} loadFailed onRetry={onRetry} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Maʼlumotni yuklab bo‘lmadi');
    expect(screen.queryByText(/joriy sahifada yo‘q/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Qayta urinish' }));
    expect(onRetry).toHaveBeenCalled();
  });

  it('after a successful load, a missing entry is "not on page"', () => {
    renderAdmin(<AuditDrawer {...props} loading={false} />);
    expect(screen.getByText(/joriy sahifada yo‘q/)).toBeInTheDocument();
  });
});

describe('R-7 / M-4: admin sessions with a partial failure', () => {
  it('keeps the rows, warns once everything settled, and retries only the failed admin', async () => {
    const owner = ADMINS[0]?.id ?? '';
    let fail = true;
    sessions.mockImplementation((adminId: string): Promise<AdminSessionListResponse> => {
      if (adminId !== owner && fail) return Promise.reject(new Error('boom'));
      return Promise.resolve(adminSessionsFixture(adminId));
    });
    // S9b: the section has row actions now, so it reads the signed-in admin (as under <RequireAdmin>).
    renderAdmin(
      <AdminContext.Provider value={meFixture('OWNER', new Date())}>
        <AdminSessions admins={ADMINS} />
      </AdminContext.Provider>,
    );
    expect(
      await screen.findByText(
        'Ayrim adminlarning sessiyalarini yuklab bo‘lmadi — ro‘yxat to‘liq emas.',
      ),
    ).toBeInTheDocument();
    expect(screen.getAllByText('Aziz O.').length).toBeGreaterThan(0);
    expect(screen.queryByRole('status', { name: 'Yuklanmoqda…' })).toBeNull();
    fail = false;
    const calls = sessions.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Qayta urinish' }));
    await vi.waitFor(() => expect(screen.queryByText(/ro‘yxat to‘liq emas/)).toBeNull());
    const retried = sessions.mock.calls.slice(calls).map(([adminId]) => adminId);
    expect(retried).not.toContain(owner);
    expect(screen.getAllByText('Aziz O.').length).toBeGreaterThan(0);
  });
});

function Where() {
  const location = useLocation();
  return <output data-testid="where">{`${location.pathname}${location.search}`}</output>;
}

describe('R-13: reconcile example ids are links', () => {
  it('a bank message id opens ?message= on this screen; a review id links to payments', () => {
    renderAdmin(
      <MemoryRouter initialEntries={['/recon']}>
        <ReconExamples code="creditUnaccounted" ids={['mkmsg000007']} />
        <ReconExamples code="reviewOpenOver24h" ids={['mkrev000002']} />
        <ReconExamples code="pendingPastGrace" ids={['mkint000009']} />
        <Where />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'mkmsg000007' }));
    expect(screen.getByTestId('where')).toHaveTextContent('/recon?message=mkmsg000007');
    expect(screen.getByRole('link', { name: 'mkrev000002' })).toHaveAttribute(
      'href',
      '/payments?review=mkrev000002',
    );
    expect(screen.queryByRole('link', { name: 'mkint000009' })).toBeNull();
  });
});
