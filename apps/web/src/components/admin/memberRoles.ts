// Session 53 — role labels/help shared by the people & access screens.
import type { MemberRole } from '@nexus/shared';

export const MEMBER_ROLE_LABELS: Record<MemberRole, string> = {
  leader: 'Leader',
  team_member: 'Team member',
  intern: 'Intern',
};

export const MEMBER_ROLE_HELP: Record<MemberRole, string> = {
  leader: 'Full access to everything in this organization, including people and roles.',
  team_member: 'Standard access. Extra permissions can be granted one by one.',
  intern: 'Limited access. Extra permissions can be granted one by one.',
};

export function memberRoleOptions(allowLeader = true) {
  return (Object.keys(MEMBER_ROLE_LABELS) as MemberRole[])
    .filter((r) => allowLeader || r !== 'leader')
    .map((r) => ({ value: r, label: MEMBER_ROLE_LABELS[r] }));
}
