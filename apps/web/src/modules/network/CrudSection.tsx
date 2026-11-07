import { useEffect, useState } from 'react';
import { Card, Button, Modal, LoadingState, ErrorState, useToast } from '../../components/ui';
import { RelationshipTable, RelationshipForm, type FieldSchema, type TableColumn } from '../../components/network';
import { ApiError } from '../../services/apiClient';

export interface CrudSectionProps<T extends { id: string }> {
  title: string;
  columns: TableColumn<T>[];
  schema: FieldSchema<T>[];
  fetchList: () => Promise<T[]>;
  // Loose input type for the same reason RelationshipForm's onSubmit is
  // — see that file's comment. Each module file casts to its entity's
  // real *Input type when calling its actual service function.
  createItem: (input: Record<string, unknown>) => Promise<T>;
  updateItem: (id: string, input: Record<string, unknown>) => Promise<T>;
  // Only Partnerships has a real archive endpoint (routes/network.ts) —
  // omitted for State Network / Org Database, which is why this isn't a
  // required prop.
  archiveItem?: (id: string) => Promise<T>;
  isLeader: boolean;
  newLabel: string;
  emptyTitle: string;
  // UI Rehaul polish pass — same opt-in row tint RelationshipTable/Table
  // now support; CrudSection itself is generic over T and has no notion
  // of "stale follow-up", so it's the caller's job to decide (Partnerships/
  // Org Database pass one keyed on their own followUpDate field; State
  // Network has no such field and simply doesn't pass this prop).
  rowClassName?: (row: T) => string | undefined;
}

type ModalState<T> = { mode: 'create' } | { mode: 'edit'; row: T } | null;

// PRD §8.3 — the generic "list + create + edit" page every Network
// subsection instantiates once with its own schema/columns/service
// functions, rather than three near-identical page components. This is
// the same "only abstract what's actually repeated" call the backend
// migration made about network_cos/partnerships/org_contacts, applied
// one layer up at the page level.
export function CrudSection<T extends { id: string }>({
  title,
  columns,
  schema,
  fetchList,
  createItem,
  updateItem,
  archiveItem,
  isLeader,
  newLabel,
  emptyTitle,
  rowClassName,
}: CrudSectionProps<T>) {
  const { show } = useToast();
  const [state, setState] = useState<
    { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; rows: T[] }
  >({ status: 'loading' });
  const [modal, setModal] = useState<ModalState<T>>(null);
  const [saving, setSaving] = useState(false);

  function load() {
    setState({ status: 'loading' });
    fetchList()
      .then((rows) => setState({ status: 'ready', rows }))
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : 'Something went wrong.';
        setState({ status: 'error', message });
      });
  }

  useEffect(load, []);

  function errorMessage(err: unknown): string {
    if (err instanceof ApiError) return err.message;
    return err instanceof Error ? err.message : 'Something went wrong.';
  }

  async function handleCreate(values: Record<string, unknown>) {
    setSaving(true);
    try {
      await createItem(values);
      show('Created.', 'success');
      setModal(null);
      load();
    } catch (err) {
      show(errorMessage(err), 'danger');
    } finally {
      setSaving(false);
    }
  }

  async function handleUpdate(id: string, values: Record<string, unknown>) {
    setSaving(true);
    try {
      await updateItem(id, values);
      show('Saved.', 'success');
      setModal(null);
      load();
    } catch (err) {
      show(errorMessage(err), 'danger');
    } finally {
      setSaving(false);
    }
  }

  async function handleArchive(id: string) {
    if (!archiveItem) return;
    setSaving(true);
    try {
      await archiveItem(id);
      show('Archived.', 'success');
      setModal(null);
      load();
    } catch (err) {
      show(errorMessage(err), 'danger');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="nx-dashboard-overview">
      <div className="nx-app-main__header" style={{ padding: 0, marginBottom: 16 }}>
        <h1>{title}</h1>
        <Button size="sm" onClick={() => setModal({ mode: 'create' })}>
          {newLabel}
        </Button>
      </div>

      <Card>
        {state.status === 'loading' && <LoadingState label={`Loading ${title.toLowerCase()}…`} />}
        {state.status === 'error' && (
          <ErrorState title={`Couldn't load ${title.toLowerCase()}`} description={state.message} onRetry={load} />
        )}
        {state.status === 'ready' && (
          <RelationshipTable
            columns={columns}
            rows={state.rows}
            rowKey={(row) => row.id}
            onRowClick={(row) => setModal({ mode: 'edit', row })}
            emptyTitle={emptyTitle}
            rowClassName={rowClassName}
          />
        )}
      </Card>

      <Modal
        open={modal !== null}
        onClose={() => setModal(null)}
        title={modal?.mode === 'create' ? newLabel : 'Edit'}
      >
        {modal && (
          <RelationshipForm<T>
            schema={schema}
            mode={modal.mode}
            initialValues={modal.mode === 'edit' ? modal.row : {}}
            isLeader={isLeader}
            saving={saving}
            onCancel={() => setModal(null)}
            onSubmit={(values) =>
              modal.mode === 'create' ? handleCreate(values) : handleUpdate(modal.row.id, values)
            }
            extraActions={
              modal.mode === 'edit' && archiveItem ? (
                <Button
                  type="button"
                  variant="danger"
                  size="sm"
                  disabled={saving}
                  onClick={() => handleArchive(modal.row.id)}
                >
                  Archive
                </Button>
              ) : undefined
            }
          />
        )}
      </Modal>
    </div>
  );
}
