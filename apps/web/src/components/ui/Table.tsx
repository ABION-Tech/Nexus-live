import type { ReactNode } from 'react';

export interface TableColumn<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
}

export interface TableProps<T> {
  columns: TableColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  // UI Rehaul polish pass — lets a caller tint a whole row (e.g.
  // "nx-table__row--overdue") the way index.html's task/data tables
  // always did, without every caller reaching into raw <tr> markup
  // itself. Optional: callers with no status-aware rows (most Network
  // CrudSection usages) simply don't pass it.
  rowClassName?: (row: T) => string | undefined;
}

// Plain, non-sortable table for static lists (e.g. checklist rows). For
// sortable/filterable large lists (Team Tasks, Analytics) use DataGrid.
export function Table<T>({ columns, rows, rowKey, onRowClick, rowClassName }: TableProps<T>) {
  return (
    <table className="nx-table">
      <thead>
        <tr>{columns.map((c) => <th key={c.key}>{c.header}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr
            key={rowKey(row)}
            className={[onRowClick ? 'nx-table__row--clickable' : '', rowClassName?.(row) ?? ''].filter(Boolean).join(' ') || undefined}
            onClick={onRowClick ? () => onRowClick(row) : undefined}
          >
            {columns.map((c) => <td key={c.key} data-label={typeof c.header === 'string' ? c.header : undefined}>{c.render(row)}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
