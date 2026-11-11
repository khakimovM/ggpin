import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderApp } from '../../auth/__tests__/test-utils';
import { PayFinal } from '../PayFinal';
import { PayPage } from '../PayPage';

const mocks = vi.hoisted(() => ({
  token: null as string | null,
  done: false,
  env: {
    NEXT_PUBLIC_API_URL: 'http://localhost:5000/api/v1',
    NEXT_PUBLIC_SITE_URL: 'http://localhost:3000',
    NEXT_PUBLIC_BOT_USERNAME: 'ggpin_bot',
    NEXT_PUBLIC_API_MOCKS: [] as string[],
    NEXT_PUBLIC_SUPPORT_URL: 'https://t.me/ggpin_support',
  },
}));
vi.mock('../../../env', () => ({ env: mocks.env }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => '/pay/cm3intent1',
}));
vi.mock('../pay-token', () => ({
  usePayToken: () => mocks.token,
  usePayDone: () => mocks.done,
  markPayDone: vi.fn(),
  clearPayToken: vi.fn(),
  rememberPayExpiry: vi.fn(),
}));

beforeEach(() => {
  mocks.token = null;
  mocks.done = false;
  mocks.env.NEXT_PUBLIC_SUPPORT_URL = 'https://t.me/ggpin_support';
});

describe('PayPage with no usable token', () => {
  it('says the link is no good, tells where to start again, and offers support', () => {
    renderApp(<PayPage intentId="cm3intent1" />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'Havola eskirgan yoki noto‘g‘ri',
    );
    expect(screen.getByText(/Sahifani qayta ochish/)).toBeInTheDocument();
    expect(screen.getByText(/yordamga yozing/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Yordamga yozish/ })).toHaveAttribute(
      'href',
      'https://t.me/ggpin_support',
    );
  });

  it('with no support link configured, support leads to our own bot', () => {
    mocks.env.NEXT_PUBLIC_SUPPORT_URL = '';
    renderApp(<PayPage intentId="cm3intent1" />);
    expect(screen.getByRole('link', { name: /Yordamga yozish/ })).toHaveAttribute(
      'href',
      'https://t.me/ggpin_bot',
    );
  });

  it('a finished request on record: a neutral screen, nothing of it, a way back to the bot', () => {
    mocks.done = true;
    renderApp(<PayPage intentId="cm3intent1" />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Bu so‘rov yakunlangan');
    expect(screen.getByText(/Mini Appʼda yoki botda/)).toBeInTheDocument();
    expect(screen.queryByText(/Havola eskirgan/)).toBeNull();
    expect(screen.queryByText(/so‘m/)).toBeNull();
    expect(screen.getByRole('link', { name: 'Botga qaytish' })).toHaveAttribute(
      'href',
      'https://t.me/ggpin_bot',
    );
  });

  it('the same in Russian', () => {
    renderApp(<PayPage intentId="cm3intent1" />, { locale: 'ru' });
    expect(screen.getByText(/Открыть страницу снова/)).toBeInTheDocument();
    expect(screen.getByText(/напишите в поддержку/)).toBeInTheDocument();
  });
});

describe('PayFinal', () => {
  it('credited shows whose account was topped up', () => {
    renderApp(
      <PayFinal kind="credited" creditedText="+50 347 so‘m" ownerHint="S***r" actions={null} />,
    );
    expect(screen.getByText('Hisob: S***r')).toBeInTheDocument();
  });

  it('cancelled says what to do about money already sent', () => {
    renderApp(<PayFinal kind="cancelled" actions={null} />);
    expect(screen.getByText(/pulni allaqachon o‘tkazgan/)).toBeInTheDocument();
  });

  it('inside a dialog the heading is an h2', () => {
    renderApp(<PayFinal kind="expired" heading="h2" actions={null} />);
    expect(screen.getByRole('heading', { level: 2 })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
  });
});
