import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Package, ShoppingBag } from 'lucide-react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { Dialog } from '../Dialog';
import { Sidebar } from '../Sidebar';

function DialogHarness({ dismissible = true }: { dismissible?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Ochish</button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Buyurtmani bekor qilish"
        description="#10293 · 1 255 000 so‘m"
        tone="danger"
        closeLabel="Yopish"
        dismissible={dismissible}
        footer={<button onClick={() => setOpen(false)}>Bekor</button>}
      >
        <textarea aria-label="Sabab" />
      </Dialog>
    </>
  );
}

describe('Dialog', () => {
  it('opens as a named, described modal and returns focus to the opener on close', async () => {
    const user = userEvent.setup();
    render(<DialogHarness />);
    const opener = screen.getByRole('button', { name: 'Ochish' });
    await user.click(opener);
    const dialog = await screen.findByRole('dialog', { name: 'Buyurtmani bekor qilish' });
    expect(dialog).toHaveAccessibleDescription('#10293 · 1 255 000 so‘m');
    expect(dialog.className).toContain('border-t-danger');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(opener).toHaveFocus();
  });

  it('cannot be dismissed while a request is in flight', async () => {
    const user = userEvent.setup();
    render(<DialogHarness dismissible={false} />);
    await user.click(screen.getByRole('button', { name: 'Ochish' }));
    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Yopish' })).toBeDisabled();
  });
});

describe('Sidebar', () => {
  const groups = [
    {
      id: 'main',
      title: 'Asosiy',
      items: [
        { id: 'orders', label: 'Buyurtmalar', icon: ShoppingBag, href: '/orders' },
        {
          id: 'products',
          label: 'Mahsulotlar',
          icon: Package,
          href: '/products',
          badge: { text: '3', tone: 'danger' as const },
        },
      ],
    },
  ];

  it('renders a named navigation whose links keep their labels on the icon rail', () => {
    render(
      <Sidebar
        label="Admin menyu"
        header={<span>logo</span>}
        groups={groups}
        currentId="orders"
        renderLink={({ children, ...props }) => <a {...props}>{children}</a>}
      />,
    );
    const nav = screen.getByRole('navigation', { name: 'Admin menyu' });
    expect(nav).toBeInTheDocument();
    const current = screen.getByRole('link', { name: 'Buyurtmalar' });
    expect(current).toHaveAttribute('aria-current', 'page');
    expect(current).toHaveAttribute('href', '/orders');
    expect(screen.getByRole('link', { name: /Mahsulotlar/ })).not.toHaveAttribute('aria-current');
    expect(screen.getByText('3')).toBeInTheDocument();
  });
});
