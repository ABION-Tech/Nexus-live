import { useEffect, useMemo, useState } from 'react';
import { Badge } from '../../components/ui';
import { statusTone, formatStatusLabel, followUpRowClassName, type FieldSchema, type TableColumn } from '../../components/network';
import { CrudSection } from './CrudSection';
import {
  archivePartnership,
  createPartnership,
  fetchPartnerships,
  updatePartnership,
  type PartnershipInput,
} from '../../services/networkService';
import { fetchPeople } from '../../services/peopleService';
import type { CurrentUser } from '../../services/authService';
import type { Partnership, Person } from '@nexus/shared';

const CURRENT_STATUS_OPTIONS = ['not_started', 'in_discussion', 'negotiating', 'cold', 'active', 'declined'].map(
  (value) => ({ value, label: formatStatusLabel(value) }),
);
const DOCUMENT_STATUS_OPTIONS = ['not_started', 'draft_sent', 'under_review', 'signed', 'na'].map((value) => ({
  value,
  label: formatStatusLabel(value),
}));

const COLUMNS: TableColumn<Partnership>[] = [
  { key: 'organisation', header: 'Organisation', render: (r) => r.organisation },
  { key: 'contact', header: 'Contact', render: (r) => r.contactName ?? '—' },
  {
    key: 'currentStatus',
    header: 'Status',
    render: (r) => <Badge tone={statusTone(r.currentStatus)}>{formatStatusLabel(r.currentStatus)}</Badge>,
  },
  {
    key: 'documentStatus',
    header: 'Document',
    render: (r) => <Badge tone={statusTone(r.documentStatus)}>{formatStatusLabel(r.documentStatus)}</Badge>,
  },
  {
    key: 'followUpDate',
    header: 'Follow-up',
    render: (r) => (r.followUpDate ? new Date(r.followUpDate).toLocaleDateString() : '—'),
  },
];

// `documentStatus` AND `assignedToUserId` are both leader-only per
// routes/network.ts's updatePartnership handler (mirrors the MVP's
// enforceLeaderOnlyFields for '3. Partnerships' — Assigned To was always
// leader-only there too, this isn't a new restriction, just newly
// representable now that a picker exists). `peopleOptions` is threaded in
// from the component below rather than module-level, since it depends on
// the async /people fetch.
function buildSchema(peopleOptions: { value: string; label: string }[]): FieldSchema<Partnership>[] {
  return [
    { key: 'organisation', label: 'Organisation', type: 'text', required: true },
    { key: 'assignedToUserId', label: 'Assigned to', type: 'select', options: peopleOptions, leaderOnly: true },
    { key: 'contactName', label: 'Contact name', type: 'text' },
    { key: 'contactEmail', label: 'Contact email', type: 'email' },
    { key: 'category', label: 'Category', type: 'text' },
    { key: 'currentStatus', label: 'Status', type: 'select', options: CURRENT_STATUS_OPTIONS },
    { key: 'documentStatus', label: 'Document status', type: 'select', options: DOCUMENT_STATUS_OPTIONS, leaderOnly: true },
    { key: 'lastContactDate', label: 'Last contact date', type: 'date' },
    { key: 'followUpDate', label: 'Follow-up date', type: 'date' },
    { key: 'remarks', label: 'Remarks', type: 'textarea' },
  ];
}

// PRD §7.2 03 NETWORK → Partnerships (← MVP '3. Partnerships'). Has a
// per-row owner (assignedToUserId) — previously left out of SCHEMA
// entirely because there was no People/team-members list endpoint to
// populate a picker from (Session 15). That endpoint now exists
// (routes/people.ts), so this loads the org roster once on mount and
// renders a real "Assigned to" picker instead of a raw user-id text
// field. A fetch failure here degrades to an empty options list (picker
// still renders, just with nothing to choose) rather than blocking the
// whole page — assignedToUserId is leader-only and optional, so an
// empty picker on a bad network blip is a minor inconvenience, not a
// broken screen.
export function Partnerships({ user }: { user: CurrentUser }) {
  const [people, setPeople] = useState<Person[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetchPeople()
      .then((rows) => { if (!cancelled) setPeople(rows); })
      .catch(() => { /* picker just renders empty — see comment above */ });
    return () => { cancelled = true; };
  }, []);

  const peopleOptions = useMemo(() => people.map((p) => ({ value: p.id, label: p.name })), [people]);
  const schema = useMemo(() => buildSchema(peopleOptions), [peopleOptions]);

  return (
    <CrudSection<Partnership>
      title="Partnerships"
      columns={COLUMNS}
      schema={schema}
      fetchList={() => fetchPartnerships()}
      createItem={(input) => createPartnership(input as unknown as PartnershipInput)}
      updateItem={(id, input) => updatePartnership(id, input as Partial<PartnershipInput>)}
      archiveItem={archivePartnership}
      isLeader={user.role === 'leader'}
      newLabel="New partnership"
      emptyTitle="No partnerships yet"
      rowClassName={(row) => followUpRowClassName(row.followUpDate)}
    />
  );
}
