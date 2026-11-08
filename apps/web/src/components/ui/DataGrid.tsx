import { useMemo, useState } from 'react';
import type { TableColumn } from './Table';
import { EmptyState } from './EmptyState';

export interface DataGridColumn<T> extends TableColumn<T> {
  sortValue?: (row: T) => string | number;
}

export interface DataGridProps<T> {
  columns: DataGridColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  emptyLabel?: string;
  rowClassName?: (row: T) => string | undefined;
}

// Sortable table for the high-traffic list views (Team Tasks, Follow-Ups,
// Analytics — PRD §17.1 Phase D). Client-side sort only; pagination and
// server-side filtering land once the corresponding API endpoints exist
// (PRD §13.4 pagination enforcement) — see SESSION_LOG.
export function DataGrid<T>({ columns, rows, rowKey, emptyLabel = 'No records yet.', rowClassName }: DataGridProps<T>) {
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [asc, setAsc] = useState(true);

  const sorted = useMemo(() => {
    const col = columns.find((c) => c.key === sortKey);
    if (!col?.sortValue) return rows;
    const copy = [...rows];
    copy.sort((a, b) => {
      const av = col.sortValue!(a);
      const bv = col.sortValue!(b);
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      return asc ? cmp : -cmp;
    });
    return copy;
  }, [rows, columns, sortKey, asc]);

  const toggleSort = (key: string) => {
    if (sortKey === key) setAsc((v) => !v);
    else { setSortKey(key); setAsc(true); }
  };

  if (rows.length === 0) return <EmptyState title={emptyLabel} />;

  return (
    <table className="nx-table">
      <thead>
        <tr>
          {columns.map((c) => (
            <th
              key={c.key}
              className={c.sortValue ? 'nx-th--sortable' : ''}
              onClick={() => c.sortValue && toggleSort(c.key)}
            >
              {c.header}{sortKey === c.key ? (asc ? ' ↑' : ' ↓') : ''}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {sorted.map((row) => (
          <tr key={rowKey(row)} className={rowClassName?.(row)}>
            {columns.map((c) => <td key={c.key} data-label={typeof c.header === 'string' ? c.header : undefined}>{c.render(row)}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
