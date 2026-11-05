import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Button } from '../Button';

describe('Button', () => {
  it('renders a type=button by default so it never submits a form by accident', () => {
    render(<Button>Sotib olish</Button>);
    expect(screen.getByRole('button', { name: 'Sotib olish' })).toHaveAttribute('type', 'button');
  });

  it('while loading it is aria-busy and aria-disabled, ignores clicks and keeps focus', async () => {
    const onClick = vi.fn();
    const { rerender } = render(<Button onClick={onClick}>To‘lash</Button>);
    const button = screen.getByRole('button', { name: 'To‘lash' });
    button.focus();
    rerender(
      <Button loading onClick={onClick}>
        To‘lash
      </Button>,
    );
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button).toHaveAttribute('aria-disabled', 'true');
    // Not natively disabled: a disabled button would drop focus in the middle of a submit.
    expect(button).not.toBeDisabled();
    expect(button).toHaveFocus();
    await userEvent.click(button);
    await userEvent.keyboard('{Enter}');
    expect(onClick).not.toHaveBeenCalled();
  });

  it('a loading submit button does not submit the form again', async () => {
    const onSubmit = vi.fn((event: { preventDefault: () => void }) => event.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <Button type="submit" loading>
          To‘lash
        </Button>
      </form>,
    );
    await userEvent.click(screen.getByRole('button'));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('is not busy when idle', () => {
    render(<Button>Tarix</Button>);
    expect(screen.getByRole('button')).not.toHaveAttribute('aria-busy');
  });

  it('does not call onClick when disabled', async () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Tarix
      </Button>,
    );
    await userEvent.click(screen.getByRole('button'));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('calls onClick once per click and is reachable with the keyboard', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Tarix</Button>);
    await userEvent.tab();
    expect(screen.getByRole('button')).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('never forces a single line, so long Russian labels can wrap', () => {
    render(<Button>Пополнить на 37 050 сум и купить</Button>);
    const classes = screen.getByRole('button').className;
    expect(classes).not.toContain('whitespace-nowrap');
    expect(classes).toContain('text-balance');
  });

  it('can render as a link with the button styles', () => {
    render(
      <Button asChild>
        <a href="/store">Do‘kon</a>
      </Button>,
    );
    const link = screen.getByRole('link', { name: 'Do‘kon' });
    expect(link).toHaveAttribute('href', '/store');
    expect(link.className).toContain('bg-primary');
  });
});

describe('Button asChild', () => {
  it('a disabled link announces aria-disabled and swallows the click', () => {
    const onClick = vi.fn();
    render(
      <Button asChild disabled onClick={onClick}>
        <a href="/store">Do‘kon</a>
      </Button>,
    );
    const link = screen.getByRole('link', { name: 'Do‘kon' });
    expect(link).toHaveAttribute('aria-disabled', 'true');
    expect(link).not.toHaveAttribute('aria-busy');
    const notPrevented = fireEvent.click(link);
    expect(notPrevented).toBe(false); // preventDefault: the browser would not navigate
    expect(onClick).not.toHaveBeenCalled();
  });

  it('a loading link is aria-busy and aria-disabled', () => {
    render(
      <Button asChild loading>
        <a href="/store">Do‘kon</a>
      </Button>,
    );
    const link = screen.getByRole('link', { name: 'Do‘kon' });
    expect(link).toHaveAttribute('aria-busy', 'true');
    expect(link).toHaveAttribute('aria-disabled', 'true');
  });

  it('an enabled link passes the click through', async () => {
    const onClick = vi.fn((event: { preventDefault: () => void }) => event.preventDefault());
    render(
      <Button asChild onClick={onClick}>
        <a href="/store">Do‘kon</a>
      </Button>,
    );
    await userEvent.click(screen.getByRole('link'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('a link child own onClick does not run while the button is disabled or loading', async () => {
    const childClick = vi.fn();
    const buttonClick = vi.fn();
    const { rerender } = render(
      <Button asChild disabled onClick={buttonClick}>
        <a href="/store" onClick={childClick}>
          Do‘kon
        </a>
      </Button>,
    );
    await userEvent.click(screen.getByRole('link'));
    rerender(
      <Button asChild loading onClick={buttonClick}>
        <a href="/store" onClick={childClick}>
          Do‘kon
        </a>
      </Button>,
    );
    await userEvent.click(screen.getByRole('link'));
    expect(childClick).not.toHaveBeenCalled();
    expect(buttonClick).not.toHaveBeenCalled();
  });

  it('an enabled link runs its own onClick once, then the button onClick', async () => {
    const order: string[] = [];
    render(
      <Button asChild onClick={() => order.push('button')}>
        <a
          href="/store"
          onClick={(event) => {
            event.preventDefault();
            order.push('child');
          }}
        >
          Do‘kon
        </a>
      </Button>,
    );
    await userEvent.click(screen.getByRole('link'));
    expect(order).toEqual(['child', 'button']);
  });
});

describe('Button loading look', () => {
  it('keeps the primary fill at .92 opacity with no hover or press colour shift', () => {
    render(<Button loading>To‘lash</Button>);
    const classes = screen.getByRole('button').className;
    expect(classes).toContain('bg-primary');
    expect(classes).toContain('aria-busy:opacity-[.92]');
    expect(classes).toContain('aria-busy:hover:bg-primary');
    expect(classes).toContain('aria-busy:active:bg-primary');
    expect(classes).not.toContain('disabled:bg-muted aria-busy');
  });
});
