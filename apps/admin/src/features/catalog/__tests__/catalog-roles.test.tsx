import type { AdminRole } from '@repo/shared';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminContext } from '../../../app/admin-context';
import { meFixture } from '../../../lib/api/mock/fixtures';
import { PRODUCTS, productDetailFixture } from '../../../lib/api/mock/fixtures-catalog';
import { renderAdmin } from '../../../test/render';
import { ProductEditForm } from '../ProductEditForm';
import { ProductReorder } from '../ProductReorder';
import { RouteTable } from '../RouteTable';
import { SkuTable } from '../SkuTable';

const writes = vi.hoisted(() => ({ updateProduct: vi.fn() }));
vi.mock('../../../lib/api/writes-catalog', async (original) => ({
  ...(await original<typeof import('../../../lib/api/writes-catalog')>()),
  updateProduct: writes.updateProduct,
}));

function fixture() {
  const found = productDetailFixture('mkprod000001');
  if (found === undefined) throw new Error('fixture');
  return found;
}
const product = fixture();

function renderAs(role: AdminRole) {
  renderAdmin(
    <MemoryRouter>
      <AdminContext.Provider value={meFixture(role, new Date())}>
        <ProductReorder
          products={PRODUCTS}
          visible={null}
          categoryName={() => 'Telegram'}
          canReorder={role === 'OWNER'}
          canToggle={role === 'OWNER'}
        />
        <SkuTable
          product={product}
          selectedId={null}
          onSelect={() => {}}
          canCreate={role === 'OWNER'}
          canEdit={role === 'OWNER'}
        />
        <RouteTable product={product} editable={role === 'OWNER'} />
      </AdminContext.Provider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  writes.updateProduct.mockReset();
});

describe('catalog controls by role (UX only; the API decides)', () => {
  it('OWNER: switches, arrows, SKU add/edit, route settings', () => {
    renderAs('OWNER');
    expect(screen.getAllByRole('switch')).toHaveLength(PRODUCTS.length);
    expect(screen.getByRole('button', { name: 'Telegram Premium: yuqoriga' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'SKU qo‘shish' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '50 ⭐: tahrirlash' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'FRAGMENT: sozlash' })).toBeInTheDocument();
  });

  it('OPERATOR: read-only — no switch, arrow, add, edit or route button', () => {
    renderAs('OPERATOR');
    expect(screen.queryAllByRole('switch')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /yuqoriga|pastga/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /SKU qo‘shish|tahrirlash|sozlash/ })).toBeNull();
    expect(screen.getByText('Faqat ko‘rish: katalogni faqat ega o‘zgartiradi')).toBeInTheDocument();
  });

  it('Alt+↑ moves the focused row and announces its place', () => {
    renderAs('OWNER');
    const row = document.getElementById('product-row-mkprod000002');
    if (row === null) throw new Error('row');
    fireEvent.keyDown(row, { key: 'ArrowUp', altKey: true });
    const list = screen.getByRole('list', { name: 'Mahsulotlar' });
    const names = within(list)
      .getAllByRole('link')
      .map((link) => link.textContent);
    expect(names.slice(0, 2)).toEqual(['Telegram Premium', 'Telegram Stars']);
    expect(screen.getByText('Telegram Premium: 1-o‘rin')).toBeInTheDocument();
  });
});

describe('product editor save', () => {
  it('two clicks on save send one request with only the changed field', async () => {
    let release: () => void = () => {};
    writes.updateProduct.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ auditId: 'mkaud', applied: true, product });
        }),
    );
    renderAdmin(
      <AdminContext.Provider value={meFixture('OWNER', new Date())}>
        <ProductEditForm product={product} />
      </AdminContext.Provider>,
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'Nomi' }), {
      target: { value: 'Telegram Yulduzlari' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Saqlash' }));
    const dialog = screen.getByRole('dialog', { name: 'Mahsulotni saqlash' });
    fireEvent.change(within(dialog).getByRole('textbox'), {
      target: { value: 'Nomni yangilash: tekshiruv' },
    });
    const form = within(dialog).getByRole('button', { name: 'Saqlash' }).closest('form');
    if (form === null) throw new Error('form');
    act(() => {
      fireEvent.submit(form);
      fireEvent.submit(form);
    });
    expect(writes.updateProduct).toHaveBeenCalledTimes(1);
    expect(writes.updateProduct.mock.calls[0]?.[1]).toEqual({
      nameUz: 'Telegram Yulduzlari',
      reason: 'Nomni yangilash: tekshiruv',
    });
    await act(() => {
      release();
      return Promise.resolve();
    });
  });
});
