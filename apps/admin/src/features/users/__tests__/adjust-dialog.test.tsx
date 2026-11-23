// CR-2: a tick in the adjustment preview holds the set id it was given for; a preview with another
// set (new top-ups or orders since) shows the box unticked again. The API module is faked.
import { AdminAdjustPreviewResponseSchema } from '@repo/shared';
import { fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminContext } from '../../../app/admin-context';
import { meFixture } from '../../../lib/api/mock/fixtures';
import { USERS } from '../../../lib/api/mock/fixtures-users';
import { userDetailView } from '../../../lib/api/mock/mock-views';
import { getAdjustPreview } from '../../../lib/api/writes-users';
import { renderAdmin } from '../../../test/render';
import { tickedFor } from '../adjust-model';
import { AdjustWalletDialog } from '../AdjustWalletDialog';

vi.mock('../../../lib/api/writes-users', () => ({
  adjustWallet: vi.fn(),
  getAdjustPreview: vi.fn(),
}));
vi.mock('../../../lib/api/confirmations', () => ({ requestConfirmation: vi.fn() }));

function previewWith(recentSet: string) {
  return AdminAdjustPreviewResponseSchema.parse({
    balanceTiyin: '8540000',
    newBalanceTiyin: '23540000',
    otpRequired: false,
    otpReason: null,
    recentAutoTopups: [
      { paymentId: 'mkpay000001', amountTiyin: '10000000', confirmedAt: '2026-11-17T08:30:00Z' },
    ],
    confirmOverrideSet: recentSet,
    openOrders: [],
    confirmOpenOrdersSet: null,
    manualCreditToday: { usedTiyin: '0', capTiyin: '500000000' },
  });
}

afterEach(() => {
  vi.mocked(getAdjustPreview).mockReset();
});

describe('tickedFor', () => {
  it('covers the set only while its id is unchanged', () => {
    expect(tickedFor('a1b2c3d4e5f6', 'a1b2c3d4e5f6')).toBe(true);
    expect(tickedFor('a1b2c3d4e5f6', 'b1b2c3d4e5f6')).toBe(false);
    expect(tickedFor(null, 'a1b2c3d4e5f6')).toBe(false);
    expect(tickedFor('a1b2c3d4e5f6', null)).toBe(false);
    expect(tickedFor('a1b2c3d4e5f6', undefined)).toBe(false);
  });
});

describe('AdjustWalletDialog (CR-2)', () => {
  it('a preview with another set id shows the recent top-ups box unticked again', async () => {
    const row = USERS[0];
    if (row === undefined) throw new Error('fixture');
    vi.mocked(getAdjustPreview).mockImplementation((_userId, amount) =>
      Promise.resolve(previewWith(amount === '15000000' ? 'a1b2c3d4e5f6' : 'b1b2c3d4e5f6')),
    );
    renderAdmin(
      <AdminContext.Provider value={meFixture('OWNER', new Date('2026-11-17T09:00:00Z'))}>
        <AdjustWalletDialog
          user={userDetailView(row, 'OWNER')}
          name="@sardor_r"
          open
          onOpenChange={vi.fn()}
        />
      </AdminContext.Provider>,
    );
    const amount = screen.getByRole('textbox', { name: /^Summa$/ });
    fireEvent.change(amount, { target: { value: '150 000' } });
    const box = await screen.findByRole('checkbox', { name: /to‘ldirishlarni ko‘rdim/ });
    fireEvent.click(box);
    expect(box).toBeChecked();
    fireEvent.change(amount, { target: { value: '200 000' } });
    await vi.waitFor(() =>
      expect(vi.mocked(getAdjustPreview)).toHaveBeenCalledWith(
        row.id,
        '20000000',
        expect.anything(),
      ),
    );
    await vi.waitFor(() =>
      expect(screen.getByRole('checkbox', { name: /to‘ldirishlarni ko‘rdim/ })).not.toBeChecked(),
    );
  });

  it('another amount with the same set id keeps the tick (R-7)', async () => {
    const row = USERS[0];
    if (row === undefined) throw new Error('fixture');
    vi.mocked(getAdjustPreview).mockResolvedValue(previewWith('a1b2c3d4e5f6'));
    renderAdmin(
      <AdminContext.Provider value={meFixture('OWNER', new Date('2026-11-17T09:00:00Z'))}>
        <AdjustWalletDialog
          user={userDetailView(row, 'OWNER')}
          name="@sardor_r"
          open
          onOpenChange={vi.fn()}
        />
      </AdminContext.Provider>,
    );
    const amount = screen.getByRole('textbox', { name: /^Summa$/ });
    fireEvent.change(amount, { target: { value: '150 000' } });
    fireEvent.click(await screen.findByRole('checkbox', { name: /to‘ldirishlarni ko‘rdim/ }));
    fireEvent.change(amount, { target: { value: '200 000' } });
    await vi.waitFor(() =>
      expect(vi.mocked(getAdjustPreview)).toHaveBeenCalledWith(
        row.id,
        '20000000',
        expect.anything(),
      ),
    );
    // Once the new preview is shown (same set id), the box is still ticked.
    await vi.waitFor(() =>
      expect(screen.getByRole('checkbox', { name: /to‘ldirishlarni ko‘rdim/ })).toBeChecked(),
    );
  });
});
