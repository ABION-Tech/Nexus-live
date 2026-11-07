// PRD §7.2 04 PEOPLE → Leave. Backs routes/leave.ts. Table already existed
// (0009_remaining_entities.sql); 0013 only added `decision_note`. Modeled
// directly on approvalService.ts's "propose → decide" shape — a leave
// request is a smaller, non-dependency-having version of the same
// pending/approved/rejected lifecycle pending_ai_tasks already has.
import { withOrgContext } from '../db.js';
import type { LeaveListQuery, LeaveRequest, LeaveStatus } from '@nexus/shared';

interface LeaveRequestRow {
  id: string;
  org_id: string;
  user_id: string;
  start_date: Date;
  end_date: Date;
  reason: string | null;
  status: LeaveStatus;
  approved_by_user_id: string | null;
  decision_note: string | null;
  decided_at: Date | null;
  created_at: Date;
}

function toDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function toLeaveRequest(row: LeaveRequestRow): LeaveRequest {
  return {
    id: row.id,
    orgId: row.org_id,
    userId: row.user_id,
    startDate: toDateOnly(row.start_date),
    endDate: toDateOnly(row.end_date),
    reason: row.reason ?? undefined,
    status: row.status,
    approvedByUserId: row.approved_by_user_id ?? undefined,
    decisionNote: row.decision_note ?? undefined,
    decidedAt: row.decided_at?.toISOString(),
    createdAt: row.created_at.toISOString(),
  };
}

export class LeaveError extends Error {
  constructor(
    public code: 'not_found' | 'already_decided' | 'invalid_range',
    message: string
  ) {
    super(message);
    this.name = 'LeaveError';
  }
}

export async function listLeaveRequests(orgId: string, query: LeaveListQuery): Promise<LeaveRequest[]> {
  return withOrgContext(orgId, async (client) => {
    const conditions = ['org_id = $1'];
    const params: unknown[] = [orgId];
    if (query.userId) {
      params.push(query.userId);
      conditions.push(`user_id = $${params.length}`);
    }
    if (query.status) {
      params.push(query.status);
      conditions.push(`status = $${params.length}`);
    }
    const { rows } = await client.query<LeaveRequestRow>(
      `select * from leave_requests where ${conditions.join(' and ')} order by created_at desc`,
      params
    );
    return rows.map(toLeaveRequest);
  });
}

export async function getLeaveRequestById(orgId: string, id: string): Promise<LeaveRequest | null> {
  return withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<LeaveRequestRow>(
      `select * from leave_requests where org_id = $1 and id = $2`,
      [orgId, id]
    );
    return rows[0] ? toLeaveRequest(rows[0]) : null;
  });
}

export function isOwnLeaveRequest(request: LeaveRequest, userId: string): boolean {
  return request.userId === userId;
}

export interface CreateLeaveInput {
  userId: string;
  startDate: string;
  endDate: string;
  reason?: string;
}

export async function createLeaveRequest(orgId: string, input: CreateLeaveInput): Promise<LeaveRequest> {
  if (input.startDate > input.endDate) {
    throw new LeaveError('invalid_range', 'startDate must not be after endDate.');
  }
  return withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<LeaveRequestRow>(
      `insert into leave_requests (org_id, user_id, start_date, end_date, reason)
       values ($1, $2, $3, $4, $5)
       returning *`,
      [orgId, input.userId, input.startDate, input.endDate, input.reason ?? null]
    );
    return toLeaveRequest(rows[0]!);
  });
}

/** Approve or reject a pending request. Unlike pending_ai_tasks, leave
 * requests have no dependency graph — this is a flat status transition,
 * guarded only against deciding something twice. */
export async function decideLeaveRequest(
  orgId: string,
  id: string,
  decision: Extract<LeaveStatus, 'approved' | 'rejected'>,
  approverUserId: string,
  note?: string
): Promise<LeaveRequest> {
  return withOrgContext(orgId, async (client) => {
    const existing = await client.query<LeaveRequestRow>(
      `select * from leave_requests where org_id = $1 and id = $2`,
      [orgId, id]
    );
    if (existing.rows.length === 0) throw new LeaveError('not_found', 'Leave request not found.');
    if (existing.rows[0]!.status !== 'pending') {
      throw new LeaveError('already_decided', `This request was already ${existing.rows[0]!.status}.`);
    }

    const { rows } = await client.query<LeaveRequestRow>(
      `update leave_requests
          set status = $3, approved_by_user_id = $4, decision_note = $5, decided_at = now()
        where org_id = $1 and id = $2
        returning *`,
      [orgId, id, decision, approverUserId, note ?? null]
    );
    return toLeaveRequest(rows[0]!);
  });
}

/** Cancels a still-pending request. Route layer decides who's allowed to
 * call this (requester on their own pending request, or a `leave.delete`
 * grant) — this just enforces the state machine (can't cancel something
 * already decided). */
export async function cancelLeaveRequest(orgId: string, id: string): Promise<LeaveRequest> {
  return withOrgContext(orgId, async (client) => {
    const existing = await client.query<LeaveRequestRow>(
      `select * from leave_requests where org_id = $1 and id = $2`,
      [orgId, id]
    );
    if (existing.rows.length === 0) throw new LeaveError('not_found', 'Leave request not found.');
    if (existing.rows[0]!.status !== 'pending') {
      throw new LeaveError('already_decided', `This request was already ${existing.rows[0]!.status} and can no longer be cancelled.`);
    }
    const { rows } = await client.query<LeaveRequestRow>(
      `delete from leave_requests where org_id = $1 and id = $2 returning *`,
      [orgId, id]
    );
    return toLeaveRequest(rows[0]!);
  });
}
