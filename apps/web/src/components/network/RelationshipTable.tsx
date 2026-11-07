import { Table, type TableColumn } from '../ui/Table';
import { EmptyState } from '../ui/EmptyState';

export type { TableColumn };

export interface RelationshipTableProps<T> {
  columns: TableColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  emptyTitle?: string;
  emptyDescription?: string;
  rowClassName?: (row: T) => string | undefined;
}

// PRD §8.3's "RelationshipTable" — every Network subsection (State
// Network, Partnerships, Org Database) lists rows the same way (click a
// row to edit), so this exists to keep that convention and the
// empty-state copy in one place rather than three copies of the same
// "table or EmptyState" branch in each module file. The generic `Table`
// primitive (components/ui/Table.tsx) already handles rendering and the
// row-click affordance itself — this just owns the "nothing to show yet"
// fallback on top of it.
export function RelationshipTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  emptyTitle = 'Nothing here yet',
  emptyDescription,
  rowClassName,
}: RelationshipTableProps<T>) {
  if (rows.length === 0) {
    return <EmptyState title={emptyTitle} description={emptyDescription} />;
  }
  return <Table columns={columns} rows={rows} rowKey={rowKey} onRowClick={onRowClick} rowClassName={rowClassName} />;
}
