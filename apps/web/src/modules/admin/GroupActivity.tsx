import { useEffect, useState } from 'react';
import { LoadingState, ErrorState } from '../../components/ui';
import { AuditLogTable } from '../../components/admin';
import { fetchGroupActivity } from '../../services/groupAdminService';
import type { AuditLogEntry } from '@nexus/shared';

type ListState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; entries: AuditLogEntry[] };

// Group Admin > Activity — GET /admin/group/activity (added this
// session; the Session 6 dashboard shell names this tab but the
// Session 41 backend pass only shipped Companies + Analytics). Scoped
// to this group's own org id, mandatory server-side — same audit
// surface Company Admin's own Activity tab uses.
export function GroupActivity() {
  const [state, setState] = useState<ListState>({ status: 'loading' });

  function load() {
    setState({ status: 'loading' });
    fetchGroupActivity({ limit: 50 })
      .then((entries) => setState({ status: 'ready', entries }))
      .catch((err: unknown) => {
        setState({ status: 'error', message: err instanceof Error ? err.message : 'Something went wrong.' });
      });
  }

  useEffect(load, []);

  if (state.status === 'loading') return <LoadingState label="Loading activity…" />;
  if (state.status === 'error') return <ErrorState title="Couldn't load activity" description={state.message} onRetry={load} />;

  return (
    <div className="nx-page nx-view-enter">
      <h2>Activity</h2>
      <AuditLogTable entries={state.entries} emptyDescription="Administrative actions on this group will show up here." />
    </div>
  );
}
