import { useEffect, useState } from 'react';
import { LoadingState, ErrorState } from '../../components/ui';
import { AuditLogTable } from '../../components/admin';
import { fetchCompanyActivity } from '../../services/companyAdminService';
import type { AuditLogEntry } from '@nexus/shared';

type ListState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; entries: AuditLogEntry[] };

// Company Admin > Activity — GET /admin/company/activity, org-scoped
// audit log (mandatory orgId filter, not overridable — companyAdmin.ts's
// own comment on why this differs from Super Admin's optional-orgId
// /audit-log).
export function CompanyActivity() {
  const [state, setState] = useState<ListState>({ status: 'loading' });

  function load() {
    setState({ status: 'loading' });
    fetchCompanyActivity({ limit: 50 })
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
      <AuditLogTable entries={state.entries} emptyDescription="Administrative actions on this company will show up here." />
    </div>
  );
}
