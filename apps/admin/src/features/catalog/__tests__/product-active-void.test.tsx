// S8b A2 on the key void (9B-3): the switch keeps its own registry entry (`<id>-active`), but its
// audit row, and so the void's `targetId`, name the product itself (docs/04).
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminContext } from '../../../app/admin-context';
import { ApiError } from '../../../lib/api/errors';
import { meFixture } from '../../../lib/api/mock/fixtures';
import { PRODUCTS } from '../../../lib/api/mock/fixtures-catalog';
import { updateProduct } from '../../../lib/api/writes-catalog';
import { voidWriteKey } from '../../../lib/api/writes-keys';
import { renderAdmin } from '../../../test/render';
import { voidAnswer } from '../../../test/void-answer';
import { ProductActiveDialog } from '../ProductActiveDialog';

vi.mock('../../../lib/api/writes-keys', () => ({ voidWriteKey: vi.fn() }));
vi.mock('../../../lib/api/writes-catalog', () => ({ updateProduct: vi.fn() }));

const me = meFixture('OWNER', new Date('2026-11-24T09:00:00Z'));

afterEach(() => {
  vi.mocked(voidWriteKey).mockReset();
  vi.mocked(updateProduct).mockReset();
  window.sessionStorage.clear();
});

describe('the product switch and the key void', { timeout: 30_000 }, () => {
  it('voids with the product id, never the registry target `-active`', async () => {
    const product = PRODUCTS[0];
    if (product === undefined) throw new Error('fixture');
    vi.mocked(updateProduct).mockRejectedValueOnce(new ApiError({ status: 0, code: 'NETWORK' }));
    vi.mocked(voidWriteKey).mockImplementationOnce((body) =>
      voidAnswer(me.admin.id, body, 'APPLIED', 'PRODUCT_UPDATE'),
    );
    const onOpenChange = vi.fn();
    renderAdmin(
      <AdminContext.Provider value={me}>
        <ProductActiveDialog product={product} open onOpenChange={onOpenChange} />
      </AdminContext.Provider>,
    );
    fireEvent.change(screen.getByRole('textbox', { name: /Sabab/ }), {
      target: { value: 'Yetkazib beruvchi to‘xtadi' },
    });
    fireEvent.submit(
      screen.getByRole('textbox', { name: /Sabab/ }).closest('form') ?? document.body,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Natijani aniqlash' }));
    await waitFor(() => expect(voidWriteKey).toHaveBeenCalled());
    expect(vi.mocked(voidWriteKey).mock.calls[0]?.[0]).toMatchObject({
      action: 'catalog.productUpdate',
      targetId: product.id,
    });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(await screen.findByText(/Audit yozuvi:/)).toBeInTheDocument();
  });
});
