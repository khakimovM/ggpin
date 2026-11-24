import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AdminContext } from '../../../app/admin-context';
import { meFixture } from '../../../lib/api/mock/fixtures';
import { productDetailFixture } from '../../../lib/api/mock/fixtures-catalog';
import { orderDetailFixture } from '../../../lib/api/mock/fixtures-orders';
import { renderAdmin } from '../../../test/render';
import { OrderHistory } from '../../orders/OrderSections';
import { activeTargetOf } from '../ProductActiveDialog';
import { SkuEditDialog } from '../SkuEditDialog';

function product() {
  const found = productDetailFixture('mkprod000001');
  if (found === undefined) throw new Error('fixture');
  return found;
}

function order() {
  const found = orderDetailFixture('mkord000001');
  if (found === undefined) throw new Error('fixture');
  return found;
}

describe('S8b review fixes', () => {
  it('A2: the switch keeps its own registry entry, apart from the editor', () => {
    expect(activeTargetOf('mkprod000001')).toBe('mkprod000001-active');
    expect(activeTargetOf('mkprod000001')).not.toBe('mkprod000001');
  });

  it('A5: a new package opens without errors; leaving an empty field shows its error', () => {
    renderAdmin(
      <AdminContext.Provider value={meFixture('OWNER', new Date())}>
        <SkuEditDialog product={product()} sku={null} open onOpenChange={() => {}} />
      </AdminContext.Provider>,
    );
    const dialog = screen.getByRole('dialog', { name: 'Yangi SKU' });
    const label = within(dialog).getByRole('textbox', { name: 'Nomi (uz)' });
    expect(label).toHaveAttribute('aria-invalid', 'false');
    expect(within(dialog).queryByText('To‘ldirish shart')).toBeNull();
    fireEvent.blur(label);
    expect(label).toHaveAttribute('aria-invalid', 'true');
  });

  it('A4: a changed quantity hides the live price of the old quantity', () => {
    const sku = product().skus[1];
    if (sku === undefined) throw new Error('fixture');
    renderAdmin(
      <AdminContext.Provider value={meFixture('OWNER', new Date())}>
        <SkuEditDialog product={product()} sku={sku} open onOpenChange={() => {}} />
      </AdminContext.Provider>,
    );
    const dialog = screen.getByRole('dialog', { name: 'SKUʼni tahrirlash' });
    expect(within(dialog).getByText(/Jonli narx/)).toBeInTheDocument();
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Miqdor' }), {
      target: { value: '120' },
    });
    expect(within(dialog).getByText(/Miqdor o‘zgarmoqda/)).toBeInTheDocument();
    expect(within(dialog).queryByText(/Jonli narx/)).toBeNull();
  });

  it('A7: an unknown reason code keeps the code; an admin note stays as written', () => {
    const base = order();
    const first = base.events[0];
    if (first === undefined) throw new Error('fixture');
    const events = ['SOMETHING_NEW', 'TEST', 'LOW_BALANCE'].map((note) => ({ ...first, note }));
    renderAdmin(<OrderHistory order={{ ...base, events }} />);
    expect(screen.getByText('SOMETHING_NEW').tagName).toBe('CODE');
    expect(screen.getByText(/· TEST$/)).toBeInTheDocument();
    expect(screen.queryByText(/LOW_BALANCE/)).toBeNull();
  });
});
