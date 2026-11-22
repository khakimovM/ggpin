import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TrendingUp } from 'lucide-react';
import { describe, expect, it, vi } from 'vitest';
import { AreaChart } from '../AreaChart';
import { BarChart } from '../BarChart';
import { DataTable, type DataTableColumn } from '../DataTable';
import { DonutChart } from '../DonutChart';
import { Drawer } from '../Drawer';
import { KpiCard } from '../KpiCard';
import { TablePager } from '../TablePager';

interface Row {
  id: string;
  name: string;
}

const columns: DataTableColumn<Row>[] = [
  { id: 'id', header: 'ID', cell: (row) => <a href={`/x/${row.id}`}>{row.id}</a> },
  { id: 'name', header: 'Nom', cell: (row) => row.name, align: 'end' },
];
const rows: Row[] = [
  { id: 'a', name: 'Alpha' },
  { id: 'b', name: 'Beta' },
];

function table(state: 'loading' | 'error' | 'empty' | 'data', onRowClick?: (row: Row) => void) {
  return render(
    <DataTable
      label="Ro‘yxat"
      columns={columns}
      rows={rows}
      rowKey={(row) => row.id}
      state={state}
      loadingLabel="Yuklanmoqda"
      empty={<p>Bo‘sh</p>}
      error={<p>Xato</p>}
      onRowClick={onRowClick}
    />,
  );
}

describe('DataTable', () => {
  it('keeps the header in every state and swaps only the body', () => {
    for (const state of ['loading', 'error', 'empty', 'data'] as const) {
      const { unmount } = table(state);
      const grid = screen.getByRole('table', { name: 'Ro‘yxat' });
      expect(within(grid).getAllByRole('columnheader')).toHaveLength(2);
      expect(grid).toHaveAttribute('aria-busy', String(state === 'loading'));
      unmount();
    }
  });

  it('shows skeleton rows and a status text while loading', () => {
    table('loading');
    expect(screen.getByRole('status')).toHaveTextContent('Yuklanmoqda');
    expect(screen.queryByText('Alpha')).toBeNull();
  });

  it('shows the empty and error content instead of rows', () => {
    const empty = table('empty');
    expect(screen.getByText('Bo‘sh')).toBeInTheDocument();
    expect(screen.queryByText('Alpha')).toBeNull();
    empty.unmount();
    table('error');
    expect(screen.getByText('Xato')).toBeInTheDocument();
  });

  it('a row press calls back, a press on the row link does not double it', async () => {
    const onRowClick = vi.fn();
    table('data', onRowClick);
    await userEvent.click(screen.getByText('Beta'));
    expect(onRowClick).toHaveBeenCalledWith(rows[1]);
    onRowClick.mockClear();
    const link = screen.getByRole('link', { name: 'a' });
    link.addEventListener('click', (event) => event.preventDefault());
    await userEvent.click(link);
    expect(onRowClick).not.toHaveBeenCalled();
  });
});

describe('TablePager', () => {
  it('disables the steps that lead nowhere', async () => {
    const onNext = vi.fn();
    render(
      <TablePager
        summary="Jami 12 tadan 1–10"
        previousLabel="Oldingi"
        nextLabel="Keyingi"
        onPrevious={vi.fn()}
        onNext={onNext}
        hasPrevious={false}
        hasNext
      />,
    );
    expect(screen.getByRole('button', { name: 'Oldingi' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Keyingi' }));
    expect(onNext).toHaveBeenCalledOnce();
  });
});

describe('Drawer', () => {
  it('is a labelled dialog that closes from its button', async () => {
    const onOpenChange = vi.fn();
    render(
      <Drawer open onOpenChange={onOpenChange} title="pi_8f40" closeLabel="Yopish">
        <p>Tafsilot</p>
      </Drawer>,
    );
    expect(screen.getByRole('dialog', { name: 'pi_8f40' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Yopish' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe('dashboard figures', () => {
  it('KpiCard shows the label, value and unit', () => {
    render(<KpiCard label="Aylanma" icon={TrendingUp} tone={1} value="48 200 000" unit=" so‘m" />);
    expect(screen.getByText('Aylanma')).toBeInTheDocument();
    expect(screen.getByText('48 200 000')).toHaveTextContent('48 200 000 so‘m');
  });

  it('charts are labelled pictures and clamp their ratios', () => {
    const { container } = render(
      <>
        <AreaChart
          label="Aylanma"
          series={[{ id: 'r', ratios: [0, 0.5, 2, -1], tone: 1 }]}
          yLabels={['10', '5', '0']}
          xLabels={['a', 'b']}
        />
        <DonutChart
          label="Ulush"
          total="3"
          totalCaption="buyurtma"
          slices={[{ id: 'x', label: 'Stars', ratio: 1, share: '100%', tone: 2 }]}
        />
        <BarChart
          label="Bank"
          rows={[{ id: 'h', label: 'Humo', value: '1', ratio: 1.5, tone: 1 }]}
        />
      </>,
    );
    expect(screen.getByRole('img', { name: 'Aylanma' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Ulush' })).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Bank' })).toHaveTextContent('Humo');
    const line = container.querySelector('path[fill="none"]');
    // 2 clamps to the top (y 0), -1 to the axis (y 180).
    expect(line?.getAttribute('d')).toBe('M0.0 180.0 L200.0 90.0 L400.0 0.0 L600.0 180.0');
    const bar = container.querySelector('li span.block');
    expect(bar?.getAttribute('style')).toContain('width: 100%');
  });
});
