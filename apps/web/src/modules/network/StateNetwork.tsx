import { Badge } from '../../components/ui';
import { statusTone, formatStatusLabel, type FieldSchema, type TableColumn } from '../../components/network';
import { CrudSection } from './CrudSection';
import {
  createNetworkCos,
  fetchNetworkCos,
  updateNetworkCos,
  type CosInput,
} from '../../services/networkService';
import type { CurrentUser } from '../../services/authService';
import type { NetworkCos } from '@nexus/shared';

const COS_STATUS_OPTIONS = ['not_started', 'acknowledged', 'in_progress', 'follow_up_needed', 'active'].map(
  (value) => ({ value, label: formatStatusLabel(value) }),
);

const COLUMNS: TableColumn<NetworkCos>[] = [
  { key: 'state', header: 'State', render: (r) => r.state },
  { key: 'admin', header: 'Admin', render: (r) => r.adminName ?? '—' },
  {
    key: 'status',
    header: 'Status',
    render: (r) => <Badge tone={statusTone(r.status)}>{formatStatusLabel(r.status)}</Badge>,
  },
  { key: 'whatsapp', header: 'WhatsApp group', render: (r) => (r.whatsappGroupCreated ? 'Yes' : 'No') },
  {
    key: 'lastReport',
    header: 'Last report',
    render: (r) => (r.lastReportDate ? new Date(r.lastReportDate).toLocaleDateString() : '—'),
  },
];

// `state` is the table's natural ID (0008_network.sql: unique(org_id,
// state)) and PATCH /network/cos/:id doesn't accept changing it —
// createOnly here, not just convention, matches a real backend
// constraint.
const SCHEMA: FieldSchema<NetworkCos>[] = [
  { key: 'state', label: 'State', type: 'text', required: true, createOnly: true },
  { key: 'adminName', label: 'Admin name', type: 'text' },
  { key: 'adminPhone', label: 'Admin phone', type: 'tel' },
  { key: 'adminEmail', label: 'Admin email', type: 'email' },
  { key: 'whatsappGroupCreated', label: 'WhatsApp group created', type: 'checkbox' },
  { key: 'membersCount', label: 'Members count', type: 'number' },
  { key: 'status', label: 'Status', type: 'select', options: COS_STATUS_OPTIONS },
  { key: 'lastReportDate', label: 'Last report date', type: 'date' },
  { key: 'notes', label: 'Notes', type: 'textarea' },
];

// PRD §7.2 03 NETWORK → State Network (← MVP '2. COS'). No per-row owner
// (0008_network.sql) — `user` isn't threaded into field defaults or an
// own-record filter the way Partnerships/Org Database use it; it only
// affects whether leader-only fields would render disabled, and this
// table has none. Kept as a prop anyway for the same reason App.tsx
// passes `user` to all three network modules uniformly, not because
// this one specifically needs it yet.
export function StateNetwork({ user }: { user: CurrentUser }) {
  return (
    <CrudSection<NetworkCos>
      title="State Network"
      columns={COLUMNS}
      schema={SCHEMA}
      fetchList={() => fetchNetworkCos()}
      createItem={(input) => createNetworkCos(input as unknown as CosInput)}
      updateItem={(id, input) => updateNetworkCos(id, input as Partial<CosInput>)}
      isLeader={user.role === 'leader'}
      newLabel="New state contact"
      emptyTitle="No state contacts yet"
    />
  );
}
