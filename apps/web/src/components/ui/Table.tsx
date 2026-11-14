import { useEffect, useRef, useState, type ReactNode } from 'react';

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
  /** Session 58 — like every table in the original HTML app: a toolbar with
   * Export CSV and Cols (show / hide columns, remembered on this device).
   * The name is the CSV file name and the key the column choice is kept
   * under. Omit for small static lists. */
  exportName?: string;
  /** Shown at the left of the toolbar. */
  title?: ReactNode;
  /** Extra controls in the toolbar (sort, etc.). */
  toolbar?: ReactNode;
  /** Column keys hidden until the person turns them on. */
  defaultHidden?: string[];
}

function loadHidden(name: string | undefined, fallback: string[]): string[] {
  if (!name) return fallback;
  try {
    const v = localStorage.getItem(`nx-cols:${name}`);
    return v ? (JSON.parse(v) as string[]) : fallback;
  } catch {
    return fallback;
  }
}

function csvCell(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}

// Plain, non-sortable table for static lists (e.g. checklist rows). For
// sortable/filterable large lists (Team Tasks, Analytics) use DataGrid.
export function Table<T>({ columns, rows, rowKey, onRowClick, rowClassName, exportName, title, toolbar, defaultHidden = [] }: TableProps<T>) {
  const [hidden, setHidden] = useState<string[]>(() => loadHidden(exportName, defaultHidden));
  const [colsOpen, setColsOpen] = useState(false);
  const tableRef = useRef<HTMLTableElement>(null);
  const colsRef = useRef<HTMLDivElement>(null);
  const shown = columns.filter((c) => !hidden.includes(c.key));

  useEffect(() => {
    if (!exportName) return;
    try {
      localStorage.setItem(`nx-cols:${exportName}`, JSON.stringify(hidden));
    } catch {
      /* private window: the choice just isn't remembered */
    }
  }, [exportName, hidden]);

  useEffect(() => {
    if (!colsOpen) return;
    const close = (e: MouseEvent) => colsRef.current && !colsRef.current.contains(e.target as Node) && setColsOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [colsOpen]);

  // The CSV is what's on screen: the visible columns, each cell's text.
  function exportCsv() {
    const table = tableRef.current;
    if (!table) return;
    const lines = Array.from(table.rows).map((tr) => Array.from(tr.cells).map((td) => csvCell(td.innerText)).join(','));
    const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${exportName} ${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  const table = (
    <table className="nx-table" ref={tableRef}>
      <thead>
        <tr>{shown.map((c) => <th key={c.key}>{c.header}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr
            key={rowKey(row)}
            className={[onRowClick ? 'nx-table__row--clickable' : '', rowClassName?.(row) ?? ''].filter(Boolean).join(' ') || undefined}
            onClick={onRowClick ? () => onRowClick(row) : undefined}
          >
            {shown.map((c) => <td key={c.key} data-label={typeof c.header === 'string' ? c.header : undefined}>{c.render(row)}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  );

  if (!exportName) return table;

  return (
    <div className="nx-tablebox">
      <div className="nx-tablebox__bar">
        <div className="nx-tablebox__title">{title}</div>
        <div className="nx-tablebox__tools">
          {toolbar}
          <button type="button" className="nx-chipbtn" onClick={exportCsv} disabled={rows.length === 0}>
            Export CSV
          </button>
          <div className="nx-tablebox__cols" ref={colsRef}>
            <button type="button" className="nx-chipbtn" aria-expanded={colsOpen} onClick={() => setColsOpen((o) => !o)}>
              Cols ▾
            </button>
            {colsOpen && (
              <div className="nx-tablebox__menu" role="menu">
                {columns.map((c) => (
                  <label key={c.key} className="nx-tablebox__opt">
                    <input
                      type="checkbox"
                      checked={!hidden.includes(c.key)}
                      disabled={!hidden.includes(c.key) && shown.length === 1}
                      onChange={(e) => setHidden((h) => (e.target.checked ? h.filter((k) => k !== c.key) : [...h, c.key]))}
                    />
                    {c.header}
                  </label>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="nx-tablebox__scroll">{table}</div>
    </div>
  );
}
