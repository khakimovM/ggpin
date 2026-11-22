import { ADMIN_ROLES, type AdminRole } from '@repo/shared';
import { screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminContext } from '../../../app/admin-context';
import { bankMessageFixture } from '../../../lib/api/mock/fixtures-payments';
import { meFixture } from '../../../lib/api/mock/fixtures';
import { renderAdmin } from '../../../test/render';
import { AdminsPage } from '../../admins/AdminsPage';
import { AuditPage } from '../../audit/AuditPage';
import { DashboardPage } from '../../dashboard/DashboardPage';
import { FragmentPage } from '../../infra/FragmentPage';
import { WalletPage } from '../../infra/WalletPage';
import { BankMessageView } from '../../payments/BankMessageView';
import { SectionGate } from '../SectionGate';

function asRole(role: AdminRole, ui: ReactNode) {
  return renderAdmin(
    <MemoryRouter>
      <AdminContext.Provider value={meFixture(role, new Date('2026-11-17T09:00:00Z'))}>
        {ui}
      </AdminContext.Provider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('what each role sees', () => {
  it('a section the role may not read shows the lock state, not the screen', () => {
    for (const role of ADMIN_ROLES) {
      const { unmount } = asRole(
        role,
        <SectionGate permission="admins.read" title="Adminlar">
          <p>ekran</p>
        </SectionGate>,
      );
      if (role === 'OWNER') {
        expect(screen.getByText('ekran')).toBeInTheDocument();
      } else {
        expect(screen.queryByText('ekran')).toBeNull();
        expect(
          screen.getByRole('heading', { name: 'Bu bo‘lim faqat OWNER uchun' }),
        ).toBeInTheDocument();
        expect(screen.getByText(`Sizning rolingiz: ${role}`)).toBeInTheDocument();
      }
      unmount();
    }
  });

  it('SUPPORT sees the dashboard lock (no dashboard.read)', () => {
    asRole(
      'SUPPORT',
      <SectionGate permission="dashboard.read" title="Dashboard">
        <p>ekran</p>
      </SectionGate>,
    );
    expect(screen.getByRole('heading', { name: /OWNER .+ OPERATOR uchun$/ })).toBeInTheDocument();
  });

  it('a locked screen sends no request at all (R-16): no query is even created', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const locked: [AdminRole, ReactNode][] = [
      ['SUPPORT', <DashboardPage key="d" />],
      ['OPERATOR', <AdminsPage key="a" />],
      ['SUPPORT', <WalletPage key="w" />],
      ['SUPPORT', <FragmentPage key="f" />],
      ['SUPPORT', <AuditPage key="au" />],
    ];
    for (const [role, ui] of locked) {
      const { queryClient, unmount } = asRole(role, ui);
      expect(screen.getByText(`Sizning rolingiz: ${role}`)).toBeInTheDocument();
      expect(queryClient.getQueryCache().getAll()).toEqual([]);
      unmount();
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('only OWNER gets the audit CSV export button', () => {
    const owner = asRole('OWNER', <AuditPage />);
    expect(screen.getByRole('button', { name: 'CSV eksport' })).toBeInTheDocument();
    owner.unmount();
    asRole('OPERATOR', <AuditPage />);
    expect(screen.getByRole('heading', { name: 'Audit log' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'CSV eksport' })).toBeNull();
  });

  it('the raw bank text is a plain text node for OWNER and a notice for the others', () => {
    const id = 'mkmsg000008';
    const owner = asRole('OWNER', <BankMessageView message={bankMessageFixture(id, 'OWNER')} />);
    const raw = screen.getByLabelText('Xabar matni');
    // The fixture holds markup on purpose: it must arrive as text, never as an element.
    expect(raw.textContent).toContain('<b>Diqqat</b>');
    expect(raw.querySelector('b')).toBeNull();
    owner.unmount();
    asRole('OPERATOR', <BankMessageView message={bankMessageFixture(id, 'OPERATOR')} />);
    expect(screen.queryByLabelText('Xabar matni')).toBeNull();
    expect(
      screen.getByText('Bank xabarining asl matni faqat OWNER uchun ko‘rinadi.'),
    ).toBeInTheDocument();
    expect(screen.getAllByText('Faqat OWNER').length).toBeGreaterThan(0);
  });

  it('OWNER with a purged text and no parsed balance sees "deleted" / "—", never "OWNER only"', () => {
    const purged = {
      ...bankMessageFixture('mkmsg000001', 'OWNER'),
      text: null,
      balanceAfterTiyin: null,
      channel: null,
    };
    asRole('OWNER', <BankMessageView message={purged} />);
    expect(screen.getByText('Xabar matni o‘chirilgan.')).toBeInTheDocument();
    expect(screen.queryByText('Faqat OWNER')).toBeNull();
    expect(screen.queryByText('Bank xabarining asl matni faqat OWNER uchun ko‘rinadi.')).toBeNull();
    expect(screen.queryByLabelText('Xabar matni')).toBeNull();
  });
});
