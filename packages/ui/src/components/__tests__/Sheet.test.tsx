import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Sheet } from '../Sheet';

function Harness({ onBack, closeLabel }: { onBack?: () => void; closeLabel?: string }) {
  const [open, setOpen] = useState(false);
  const back = onBack ? { onBack, backLabel: 'Orqaga' } : {};
  return (
    <>
      <button onClick={() => setOpen(true)}>Ochish</button>
      <Sheet
        open={open}
        onOpenChange={setOpen}
        title="Buyurtmani tasdiqlang"
        description="Qabul qiluvchini tekshiring"
        {...back}
        closeLabel={closeLabel}
        footer={<button>To‘lash</button>}
      >
        <input aria-label="Promokod" />
      </Sheet>
    </>
  );
}

async function openSheet() {
  await userEvent.click(screen.getByRole('button', { name: 'Ochish' }));
  return screen.findByRole('dialog', { name: 'Buyurtmani tasdiqlang' });
}

describe('Sheet accessibility contract', () => {
  it('onBack without backLabel does not compile: an unnamed icon button is an error', () => {
    const never = () => {
      return (
        // @ts-expect-error onBack needs backLabel
        <Sheet open onOpenChange={() => undefined} title="x" onBack={() => undefined}>
          x
        </Sheet>
      );
    };
    expect(never).toBeTypeOf('function');
  });
});

describe('Sheet', () => {
  it('opens as a named, described modal dialog', async () => {
    render(<Harness />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const dialog = await openSheet();
    expect(dialog).toHaveAccessibleDescription('Qabul qiluvchini tekshiring');
  });

  it('slides up from below normally, but only fades under reduced motion', async () => {
    const { unmount } = render(<Harness />);
    await userEvent.click(screen.getByRole('button', { name: 'Ochish' }));
    // Read the starting frame straight after mount, before the spring has moved.
    expect(screen.getByRole('dialog').style.transform).toContain('translateY');
    unmount();

    document.documentElement.dataset.reduced = 'true';
    render(<Harness />);
    await userEvent.click(screen.getByRole('button', { name: 'Ochish' }));
    expect(screen.getByRole('dialog').style.transform).not.toContain('translateY');
  });

  it('closes on Escape', async () => {
    render(<Harness />);
    await openSheet();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('closes when the overlay is pressed', async () => {
    render(<Harness />);
    await openSheet();
    await userEvent.click(screen.getByTestId('sheet-overlay'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('keeps keyboard focus inside while open', async () => {
    render(<Harness closeLabel="Yopish" />);
    const dialog = await openSheet();
    await userEvent.tab();
    for (let press = 0; press < 8; press += 1) {
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
      await userEvent.tab();
    }
  });

  it('restores focus to the opener after closing', async () => {
    render(<Harness />);
    await openSheet();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // Radix hands focus back on the next tick after the content unmounts.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Ochish' })).toHaveFocus());
  });

  it('shows a back button only when onBack is given and calls it', async () => {
    const onBack = vi.fn();
    const { unmount } = render(<Harness />);
    await openSheet();
    expect(screen.queryByRole('button', { name: 'Orqaga' })).not.toBeInTheDocument();
    unmount();

    render(<Harness onBack={onBack} />);
    await openSheet();
    await userEvent.click(screen.getByRole('button', { name: 'Orqaga' }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('closes from the close button', async () => {
    render(<Harness closeLabel="Yopish" />);
    await openSheet();
    await userEvent.click(screen.getByRole('button', { name: 'Yopish' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});
