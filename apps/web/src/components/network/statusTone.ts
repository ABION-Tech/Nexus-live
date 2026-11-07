import type { BadgeTone } from '../ui/Badge';

// One helper covering every status enum the Network domain has
// (NetworkCosStatus, PartnershipStatus, DocumentStatus, LetterStatus,
// OnboardingStatus) rather than a StatusBadge-style component per enum —
// StatusBadge itself (components/ui/StatusBadge.tsx) is hardcoded to
// TaskStatus specifically and isn't reusable here. The value sets don't
// fully overlap, but their *meaning* does: "not started yet" reads
// neutral, "actively moving" reads info, "done/good outcome" reads
// success, "needs attention" reads warning, "closed out negatively"
// reads danger — so this maps by meaning by matching a small set of
// canonical strings, not by table.
const TONE_BY_STATUS: Record<string, BadgeTone> = {
  not_started: 'neutral',
  not_sent: 'neutral',
  pending: 'neutral',
  na: 'neutral',

  acknowledged: 'info',
  sent: 'info',
  in_progress: 'info',
  in_discussion: 'info',
  draft_sent: 'info',
  under_review: 'info',

  active: 'success',
  signed: 'success',

  follow_up_needed: 'warning',
  negotiating: 'warning',
  cold: 'warning',

  declined: 'danger',
};

export function statusTone(status: string): BadgeTone {
  return TONE_BY_STATUS[status] ?? 'neutral';
}

// snake_case → "Title Case" for display — every Network status value is
// snake_case at the wire level (matches the Postgres check constraints
// in 0008_network.sql directly), so one generic formatter covers all of
// them instead of a label map per enum.
export function formatStatusLabel(status: string): string {
  return status
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

// UI Rehaul polish pass — index.html's .stale-tag idiom (d2/d5/d7 tiers)
// applied at row level via Table/RelationshipTable's rowClassName, for
// any Network entity with a followUpDate (Partnerships, Org Database;
// State Network has no such field and doesn't use this). Reuses the
// same three CSS tiers Work's task rows use (overdue/at-risk/done isn't
// meaningful here, so this only ever returns overdue or at-risk) rather
// than inventing a fourth tint just for follow-up dates.
export function followUpRowClassName(followUpDate?: string): string | undefined {
  if (!followUpDate) return undefined;
  const dueMs = new Date(followUpDate).getTime() - Date.now();
  if (dueMs < 0) return 'nx-table__row--overdue';
  if (dueMs < 48 * 60 * 60 * 1000) return 'nx-table__row--at-risk';
  return undefined;
}
