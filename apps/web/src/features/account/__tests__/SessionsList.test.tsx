import type { SessionItem } from '@repo/shared';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listSessions, revokeSession } from '../../../lib/api/auth';
import { ApiError } from '../../../lib/api/errors';
import { renderApp } from '../../auth/__tests__/test-utils';
import { SessionsList } from '../SessionsList';

vi.mock('../../../lib/api/auth', () => ({ listSessions: vi.fn(), revokeSession: vi.fn() }));

const mockList = vi.mocked(listSessions);
const mockRevoke = vi.mocked(revokeSession);

const CHROME_WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const SAFARI_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

const CURRENT: SessionItem = {
  id: 's-current',
  userAgent: CHROME_WINDOWS,
  ipMasked: '203.0.113.x',
  createdAt: '2026-11-01T10:00:00.000Z',
  lastUsedAt: '2026-11-06T10:00:00.000Z',
  current: true,
};
const OTHER: SessionItem = {
  id: 's-iphone',
  userAgent: SAFARI_IPHONE,
  ipMasked: '198.51.100.x',
  createdAt: '2026-10-20T10:00:00.000Z',
  lastUsedAt: '2026-11-04T09:30:00.000Z',
  current: false,
};

afterEach(() => vi.clearAllMocks());

describe('SessionsList', () => {
  it('loading: a busy skeleton under the title', () => {
    mockList.mockReturnValue(new Promise(() => undefined));
    const { container } = renderApp(<SessionsList />);
    expect(screen.getByRole('heading', { name: 'Faol sessiyalar' })).toBeInTheDocument();
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it('success: devices, the current one marked and without an end button', async () => {
    mockList.mockResolvedValue([CURRENT, OTHER]);
    renderApp(<SessionsList />);
    const rows = await screen.findAllByRole('listitem');
    expect(rows).toHaveLength(2);

    const current = within(rows[0] as HTMLElement);
    expect(current.getByText('Chrome · Windows')).toBeInTheDocument();
    expect(current.getByText('Bu qurilma')).toBeInTheDocument();
    expect(current.getByText(/203\.0\.113\.x · hozir faol/)).toBeInTheDocument();
    expect(current.queryByRole('button')).not.toBeInTheDocument();

    const other = within(rows[1] as HTMLElement);
    expect(other.getByText('Safari · iOS')).toBeInTheDocument();
    expect(other.getByText(/198\.51\.100\.x · /)).toBeInTheDocument();
    expect(other.getByRole('button', { name: 'Safari · iOS sessiyasini yakunlash' })).toBeVisible();
  });

  it('Russian text, and a device with no recognisable user agent', async () => {
    mockList.mockResolvedValue([{ ...CURRENT, userAgent: null, ipMasked: null }]);
    renderApp(<SessionsList />, { locale: 'ru' });
    expect(await screen.findByText('Неизвестное устройство')).toBeInTheDocument();
    expect(screen.getByText('Это устройство')).toBeInTheDocument();
    expect(screen.getByText('активен сейчас')).toBeInTheDocument();
  });

  it('ending another device calls the API with its id and refreshes the list', async () => {
    mockList.mockResolvedValueOnce([CURRENT, OTHER]).mockResolvedValueOnce([CURRENT]);
    mockRevoke.mockResolvedValue(undefined);
    renderApp(<SessionsList />);
    fireEvent.click(await screen.findByRole('button', { name: /sessiyasini yakunlash/ }));

    await waitFor(() => expect(mockRevoke).toHaveBeenCalledExactlyOnceWith('s-iphone'));
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(1));
    expect(mockList).toHaveBeenCalledTimes(2);
  });

  it('a failed end shows an error and keeps the device listed', async () => {
    mockList.mockResolvedValue([CURRENT, OTHER]);
    mockRevoke.mockRejectedValue(new ApiError({ status: 500, code: 'INTERNAL_ERROR' }));
    renderApp(<SessionsList />);
    fireEvent.click(await screen.findByRole('button', { name: /sessiyasini yakunlash/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Sessiyani yakunlab bo‘lmadi');
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('error: a message and a retry that asks again', async () => {
    mockList
      .mockRejectedValueOnce(new ApiError({ status: 0, code: 'NETWORK' }))
      .mockResolvedValueOnce([CURRENT]);
    renderApp(<SessionsList />);
    expect(await screen.findByText('Sessiyalarni yuklab bo‘lmadi')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Qayta urinish' }));
    expect(await screen.findByText('Chrome · Windows')).toBeInTheDocument();
  });

  it('empty: a message and an action', async () => {
    mockList.mockResolvedValue([]);
    renderApp(<SessionsList />);
    expect(await screen.findByText('Faol sessiyalar yo‘q')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Qayta urinish' })).toBeInTheDocument();
  });
});

describe('a session that is already gone', () => {
  it('ending it (404) counts as done: no error, the list is refreshed', async () => {
    mockList.mockResolvedValueOnce([CURRENT, OTHER]).mockResolvedValueOnce([CURRENT]);
    mockRevoke.mockRejectedValue(new ApiError({ status: 404, code: 'NOT_FOUND' }));
    renderApp(<SessionsList />);
    fireEvent.click(await screen.findByRole('button', { name: /sessiyasini yakunlash/ }));

    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(1));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(mockList).toHaveBeenCalledTimes(2);
  });
});

describe('"Boshqa barcha sessiyalarni yakunlash"', () => {
  const THIRD: SessionItem = { ...OTHER, id: 's-mac', ipMasked: '192.0.2.x' };
  const endAll = () => screen.getByRole('button', { name: 'Boshqa barcha sessiyalarni yakunlash' });

  it('is not shown when this is the only device', async () => {
    mockList.mockResolvedValue([CURRENT]);
    renderApp(<SessionsList />);
    await screen.findByText('Chrome · Windows');
    expect(
      screen.queryByRole('button', { name: 'Boshqa barcha sessiyalarni yakunlash' }),
    ).not.toBeInTheDocument();
  });

  it('ends every other device one after another, then refreshes the list', async () => {
    mockList.mockResolvedValueOnce([CURRENT, OTHER, THIRD]).mockResolvedValueOnce([CURRENT]);
    const order: string[] = [];
    let release: () => void = () => undefined;
    mockRevoke.mockImplementation((id) => {
      order.push(`start ${id}`);
      return new Promise<void>((resolve) => {
        release = () => {
          order.push(`end ${id}`);
          resolve();
        };
      });
    });
    renderApp(<SessionsList />);
    await screen.findAllByRole('listitem');
    fireEvent.click(endAll());

    // Only the first request is out; the button is busy and nothing else can be started.
    await waitFor(() => expect(order).toEqual(['start s-iphone']));
    expect(endAll()).toBeDisabled();
    expect(endAll()).toHaveAttribute('aria-busy', 'true');
    expect(screen.getAllByRole('button', { name: /sessiyasini yakunlash/ })[0]).toBeDisabled();

    release();
    await waitFor(() => expect(order).toEqual(['start s-iphone', 'end s-iphone', 'start s-mac']));
    release();
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(1));
    expect(mockRevoke).toHaveBeenCalledTimes(2);
    expect(mockRevoke).not.toHaveBeenCalledWith('s-current');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Boshqa barcha sessiyalarni yakunlash' }),
    ).not.toBeInTheDocument();
  });

  it('a 404 on one of them is success and the rest still go', async () => {
    mockList.mockResolvedValueOnce([CURRENT, OTHER, THIRD]).mockResolvedValueOnce([CURRENT]);
    mockRevoke
      .mockRejectedValueOnce(new ApiError({ status: 404, code: 'NOT_FOUND' }))
      .mockResolvedValueOnce(undefined);
    renderApp(<SessionsList />);
    await screen.findAllByRole('listitem');
    fireEvent.click(endAll());

    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(1));
    expect(mockRevoke.mock.calls.map(([id]) => id)).toEqual(['s-iphone', 's-mac']);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('a real failure stops the rest, shows an error with a retry, and refreshes the list', async () => {
    mockList
      .mockResolvedValueOnce([CURRENT, OTHER, THIRD])
      .mockResolvedValueOnce([CURRENT, THIRD])
      .mockResolvedValueOnce([CURRENT]);
    mockRevoke
      .mockResolvedValueOnce(undefined) // s-iphone ends
      .mockRejectedValueOnce(new ApiError({ status: 500, code: 'INTERNAL_ERROR' })); // s-mac fails
    renderApp(<SessionsList />);
    await screen.findAllByRole('listitem');
    fireEvent.click(endAll());

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Baʼzi sessiyalarni yakunlab bo‘lmadi',
    );
    expect(mockRevoke.mock.calls.map(([id]) => id)).toEqual(['s-iphone', 's-mac']);
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(2)); // refreshed

    // Retry goes through what is left.
    mockRevoke.mockResolvedValueOnce(undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Qayta urinish' }));
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(1));
    expect(mockRevoke.mock.calls.map(([id]) => id)).toEqual(['s-iphone', 's-mac', 's-mac']);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('Russian label', async () => {
    mockList.mockResolvedValue([CURRENT, OTHER]);
    renderApp(<SessionsList />, { locale: 'ru' });
    expect(
      await screen.findByRole('button', { name: 'Завершить все остальные сеансы' }),
    ).toBeInTheDocument();
  });
});
