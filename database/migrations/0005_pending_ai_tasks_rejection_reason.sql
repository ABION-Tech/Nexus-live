-- 0005_pending_ai_tasks_rejection_reason.sql
-- PRD §6.4.1: `POST /api/v1/approvals/:id/reject → reject with optional
-- reason`. 0001_init.sql's `pending_ai_tasks` had a `status` enum
-- covering the decision itself but nowhere to record *why* — needed
-- before the approvals routes could implement the documented contract.

alter table pending_ai_tasks add column rejection_reason text;
