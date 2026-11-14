import { useEffect, useMemo, useState } from 'react';
import { Badge } from '../../components/ui';
import { statusTone, formatStatusLabel, followUpRowClassName, type FieldSchema, type TableColumn } from '../../components/network';
import { CrudSection } from './CrudSection';
import {
  createOrgContact,
  fetchOrgContacts,
  updateOrgContact,
  type OrgContactInput,
} from '../../services/networkService';
import { fetchPeople } from '../../services/peopleService';
import type { CurrentUser } from '../../services/authService';
import type { OrgContact, Person } from '@nexus/shared';

const LETTER_STATUS_OPTIONS = ['not_sent', 'sent', 'acknowledged'].map((value) => ({
  value,
  label: formatStatusLabel(value),
}));
const ONBOARDING_STATUS_OPTIONS = ['pending', 'in_progress', 'active', 'declined'].map((value) => ({
  value,
  label: formatStatusLabel(value),
}));

// Session 58: position, email, phone, state, staff size and contact
// owner, as on the original HTML app's Org Database.
const buildColumns = (names: Map<string, string>): TableColumn<OrgContact>[] => [
  { key: 'visitorName', header: 'Visitor', render: (r) => <span className="nx-task"><b>{r.visitorName}</b>{r.position && <span className="nx-cell-dim">{r.position}</span>}</span> },
  { key: 'companyOrg', header: 'Organisation', render: (r) => r.companyOrg ?? '—' },
  { key: 'email', header: 'Email', render: (r) => (r.email ? <a className="nx-link" href={`mailto:${r.email}`} onClick={(e) => e.stopPropagation()}>{r.email}</a> : '—') },
  { key: 'phone', header: 'Phone', render: (r) => (r.phone ? <a className="nx-link" href={`tel:${r.phone}`} onClick={(e) => e.stopPropagation()}>{r.phone}</a> : '—') },
  { key: 'state', header: 'State', render: (r) => r.state ?? '—' },
  { key: 'staff', header: 'Staff', render: (r) => r.staffSize ?? '—' },
  { key: 'owner', header: 'Owner', render: (r) => (r.contactOwnerUserId ? names.get(r.contactOwnerUserId) ?? '—' : '—') },
  {
    key: 'letterStatus',
    header: 'Letter',
    render: (r) => <Badge tone={statusTone(r.letterStatus)}>{formatStatusLabel(r.letterStatus)}</Badge>,
  },
  {
    key: 'onboardingStatus',
    header: 'Onboarding',
    render: (r) => <Badge tone={statusTone(r.onboardingStatus)}>{formatStatusLabel(r.onboardingStatus)}</Badge>,
  },
  {
    key: 'dateVisited',
    header: 'Visited',
    render: (r) => (r.dateVisited ? new Date(r.dateVisited).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'),
  },
];

// Unlike Partnerships, routes/network.ts doesn't strip any field from a
// non-leader's own-record org_contacts update — no `leaderOnly` fields
// here, matching that backend behavior rather than inventing a
// restriction the API doesn't actually enforce. `contactOwnerUserId` is
// NOT leader-only for that same reason (contrast Partnerships'
// assignedToUserId, which is). `peopleOptions` is threaded in from the
// component below, same as Partnerships.tsx, since it depends on the
// async /people fetch.
function buildSchema(peopleOptions: { value: string; label: string }[]): FieldSchema<OrgContact>[] {
  return [
    { key: 'visitorName', label: 'Visitor name', type: 'text', required: true },
    { key: 'contactOwnerUserId', label: 'Contact owner', type: 'select', options: peopleOptions },
    { key: 'position', label: 'Position', type: 'text' },
    { key: 'companyOrg', label: 'Company / organisation', type: 'text' },
    { key: 'email', label: 'Email', type: 'email' },
    { key: 'phone', label: 'Phone', type: 'tel' },
    { key: 'state', label: 'State', type: 'text' },
    { key: 'staffSize', label: 'Staff size', type: 'text' },
    { key: 'dateVisited', label: 'Date visited', type: 'date' },
    { key: 'letterStatus', label: 'Letter status', type: 'select', options: LETTER_STATUS_OPTIONS },
    { key: 'onboardingStatus', label: 'Onboarding status', type: 'select', options: ONBOARDING_STATUS_OPTIONS },
    { key: 'whatsappAdded', label: 'Added to WhatsApp', type: 'checkbox' },
    { key: 'followUpDate', label: 'Follow-up date', type: 'date' },
    { key: 'notes', label: 'Notes', type: 'textarea' },
  ];
}

// PRD §7.2 03 NETWORK → Org Database (← MVP '4. Org Database'). Was
// missing the same picker wiring Partnerships.tsx has (Session 15) — the
// /people endpoint existed but this module never actually called it, so
// contactOwnerUserId had no way to be set except by hand-editing a raw
// user-id string, and wasn't even in the schema at all. Same degrade-to-
// empty behavior on fetch failure as Partnerships — the picker just
// renders with nothing to choose rather than blocking the page.
// No archive endpoint exists for org_contacts in routes/network.ts
// either, so — unlike Partnerships — this CrudSection gets no
// `archiveItem` prop at all.
export function OrgDatabase({ user }: { user: CurrentUser }) {
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
  const columns = useMemo(() => buildColumns(new Map(people.map((p) => [p.id, p.name]))), [people]);

  return (
    <CrudSection<OrgContact>
      title="Org Database"
      columns={columns}
      defaultHidden={['staff']}
      schema={schema}
      fetchList={() => fetchOrgContacts()}
      createItem={(input) => createOrgContact(input as unknown as OrgContactInput)}
      updateItem={(id, input) => updateOrgContact(id, input as Partial<OrgContactInput>)}
      isLeader={user.role === 'leader'}
      newLabel="New contact"
      emptyTitle="No org contacts yet"
      rowClassName={(row) => followUpRowClassName(row.followUpDate)}
    />
  );
}
