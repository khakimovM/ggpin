import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { SiteMobileMenu } from '../SiteMobileMenu';

const ITEMS = [
  { href: '/#products', label: 'Mahsulotlar' },
  { href: '/#how-it-works', label: 'Qanday ishlaydi' },
  { href: '/#faq', label: 'Savollar' },
];

function renderMenu(telegram: { href: string; label: string } | null = null) {
  return render(
    <div>
      <button type="button">outside</button>
      <SiteMobileMenu
        className="flex"
        menuLabel="Menyu"
        items={ITEMS}
        login={{ href: '/login', label: 'Kirish' }}
        telegram={telegram}
        languageLabel="Til"
        langSwitch={<span>switch</span>}
      />
    </div>,
  );
}

const toggle = () => screen.getByRole('button', { name: 'Menyu' });

describe('SiteMobileMenu', () => {
  it('starts closed: the toggle says so and the links are not reachable', () => {
    renderMenu();
    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('link', { name: 'Mahsulotlar' })).toBeNull();
    // "Kirish" stays in the bar.
    expect(screen.getByRole('link', { name: 'Kirish' })).toHaveAttribute('href', '/login');
  });

  it('opens on click and shows the sections', async () => {
    renderMenu();
    await userEvent.click(toggle());
    expect(toggle()).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('link', { name: 'Mahsulotlar' })).toHaveAttribute('href', '/#products');
    expect(screen.getByRole('link', { name: 'Savollar' })).toHaveAttribute('href', '/#faq');
    expect(screen.getByText('switch')).toBeVisible();
  });

  it('the toggle controls the panel it opens', async () => {
    renderMenu();
    await userEvent.click(toggle());
    const id = toggle().getAttribute('aria-controls');
    expect(id).not.toBeNull();
    expect(document.getElementById(id ?? '')).toContainElement(
      screen.getByRole('link', { name: 'Savollar' }),
    );
  });

  it('closes on a second click', async () => {
    renderMenu();
    await userEvent.click(toggle());
    await userEvent.click(toggle());
    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('link', { name: 'Savollar' })).toBeNull();
  });

  it('Escape closes it and gives the focus back to the button', async () => {
    renderMenu();
    await userEvent.click(toggle());
    screen.getByRole('link', { name: 'Savollar' }).focus();
    await userEvent.keyboard('{Escape}');
    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
    expect(toggle()).toHaveFocus();
  });

  it('Escape does nothing while it is closed (the key stays free for the page)', async () => {
    renderMenu();
    screen.getByRole('button', { name: 'outside' }).focus();
    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: 'outside' })).toHaveFocus();
  });

  it('following a link closes it', async () => {
    renderMenu();
    await userEvent.click(toggle());
    // jsdom does not navigate; the click handler is what is under test.
    await userEvent.click(screen.getByRole('link', { name: 'Qanday ishlaydi' }));
    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
  });

  it('a press outside closes it, a press inside does not', async () => {
    renderMenu();
    await userEvent.click(toggle());
    fireEvent.pointerDown(screen.getByText('Til'));
    expect(toggle()).toHaveAttribute('aria-expanded', 'true');
    fireEvent.pointerDown(screen.getByRole('button', { name: 'outside' }));
    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
  });

  it('the Telegram button opens the bot in a new tab, safely', async () => {
    renderMenu({ href: 'https://t.me/ggpin_bot', label: 'Telegramʼda ochish' });
    await userEvent.click(toggle());
    const link = screen.getByRole('link', { name: 'Telegramʼda ochish' });
    expect(link).toHaveAttribute('href', 'https://t.me/ggpin_bot');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('without a bot link there is no Telegram button', async () => {
    renderMenu(null);
    await userEvent.click(toggle());
    expect(screen.queryByRole('link', { name: /Telegram/ })).toBeNull();
  });
});
