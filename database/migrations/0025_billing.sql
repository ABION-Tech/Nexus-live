-- 0025_billing.sql
-- Session 47 (SESSION_47_SCOPE_BILLING.md) — billing & plan enforcement,
-- built against the answers given for that doc's §3 open questions:
--   1. Guest-invite gate: absorbed here (routes/guests.ts wired this
--      session, not deferred).
--   2. Seat definition: ALL org_memberships roles count, including
--      guest and intern — not just leader/team_member.
--   3. Billing attachment: either a Group or a Company can hold its own
--      `org_billing` row and bill independently. A company with no row
--      of its own (or an explicit free/inactive one) inherits from its
--      parent group's row when that row has `cascades_to_children`.
--   4. Enforcement scope: seat cap, AI usage cap, storage cap, plus a
--      general feature-flag mechanism (`hasFeature`) — not just the
--      guest-invite gate.
--
-- `organizations.plan` (0016) is left in place as a legacy column —
-- same "old column stays nullable/unwritten, new code owns the new
-- columns" precedent `proof_link` established (see SESSION_LOG). Nothing
-- in this migration or the service layer built on top of it writes to
-- `plan` again; `org_billing.tier` is the new source of truth. Not
-- dropped: routes/admin/superAdmin.ts's existing PATCH /organizations/:id
-- plan-change path and its audit-log action name stay valid and inert
-- rather than a breaking removal in the same session that adds the real
-- system next to it.
--
-- Explicitly OUT of scope for this migration/session (per the scoping
-- doc's own §3.5 and §3.7, still genuinely unscoped):
--   - Real NGN prices — BILLING_TIERS (packages/shared) ships with
--     placeholder numbers, flagged there as placeholders.
--   - Usage-based overage *billing* (invoicing someone extra NGN for
--     going over their AI-usage allotment mid-cycle) — this migration
--     and the service layer enforce a hard cap (reject the action) at
--     the limit instead. A metered-overage invoicing engine is its own
--     design pass, not built here, so as not to repeat the mistake
--     Session 31 avoided (building against guessed schema).
--   - Proration math on plan changes — Super Admin's manual tier-set
--     path (below) takes effect immediately, no proration computed.

-- ---------------------------------------------------------------------
-- org_billing — one row per org that has ever had its own billing
-- config (not one row per org overall; an org with no row is simply
-- "free, no Paystack link, no cascade" by omission — same "absence
-- means not yet, no sentinel values" principle this codebase already
-- follows for other statuses, per DECISIONS.md).
-- ---------------------------------------------------------------------
create table org_billing (
  id                          uuid primary key default gen_random_uuid(),
  org_id                      uuid not null unique references organizations(id) on delete cascade,

  tier                        text not null default 'free' check (tier in ('free', 'starter', 'pro')),

  -- Separate from `tier` deliberately (mirrors the scoping doc's own
  -- §2 sketch): a `past_due` org keeps its paid `tier`'s access during
  -- the grace period — losing access the moment a charge fails would
  -- contradict "grace period, then mandatory manual review" (§1).
  billing_status              text not null default 'active'
                                check (billing_status in ('active', 'past_due', 'pending_review', 'suspended')),

  -- Cached seat count, all org_memberships roles (open question #2:
  -- "all roles including guests"). Recomputed by billingService on
  -- every membership-affecting write (invite accept, guest create,
  -- membership revoke) rather than read live on every request — a
  -- seat-limit check happens on the hot path of every invite/guest
  -- creation, and org_memberships COUNT(*) is cheap but not free.
  seat_count                  integer not null default 0,

  -- Only meaningful when org_type = 'group' (app-layer enforced, same
  -- "cheap check, no trigger for a v1 table" reasoning 0006 already
  -- used for group/company parentage). When true, a child company with
  -- no paid `org_billing` row of its own inherits this row's tier —
  -- open question #3's "Either" answer, resolved at read time by
  -- billingService.resolveEffectiveBilling, not by copying data down.
  cascades_to_children         boolean not null default false,

  paystack_customer_code       text,
  paystack_subscription_code   text,
  paystack_plan_code           text,

  current_period_start         timestamptz,
  current_period_end           timestamptz,

  -- Set the moment a charge fails; cleared the moment a charge
  -- succeeds. Null = no active grace period. The grace-period sweep
  -- (automationJobs.ts's dailyBillingGraceCheck, below) only acts on
  -- rows where this is in the past AND billing_status = 'past_due'.
  grace_period_ends_at         timestamptz,

  last_payment_at              timestamptz,

  -- Free-text note left by whichever Super Admin resolved a
  -- pending_review row (comp'd, retried and cleared, manually
  -- downgraded, etc.) — open question #6's "what does surfacing to
  -- Super Admin look like" resolved here as a filter on this table
  -- rather than a separate queue table (billing_status = 'pending_review'
  -- IS the queue; SuperOrganizations.tsx can filter on it, per the
  -- scoping doc's own suggestion).
  review_note                  text,
  reviewed_by_user_id          uuid references users(id),
  reviewed_at                  timestamptz,

  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now()
);

create index idx_org_billing_status on org_billing(billing_status);
create index idx_org_billing_grace on org_billing(billing_status, grace_period_ends_at)
  where billing_status = 'past_due';

-- Mirrors organizations' own tenant_isolation policy (0006, widened
-- 0016) exactly: an org sees its own billing row, or its parent group's
-- (needed for cascade resolution — a company must be able to read the
-- group's row to know it inherits from it), or — the reverse — a group
-- sees its direct children's rows (needed for a Group Admin billing
-- overview later; not built this session, but the read path costs
-- nothing to open now and avoids a second RLS-widening migration when
-- it is).
alter table org_billing enable row level security;
alter table org_billing force row level security;

create policy tenant_isolation on org_billing
  using (
    org_id = current_setting('app.current_org_id', true)::uuid
    or org_id = (select parent_org_id from organizations where id = current_setting('app.current_org_id', true)::uuid)
    or (select parent_org_id from organizations where id = org_billing.org_id) = current_setting('app.current_org_id', true)::uuid
  );

grant select, insert, update on org_billing to nexus_app;

-- ---------------------------------------------------------------------
-- billing_events — idempotent Paystack webhook landing table. Written
-- before any org context can be established (the webhook caller has no
-- NEXUS session — same class of endpoint as calendarWebhook.ts), so
-- inserts go through a nexus_bootstrap-owned function (below), same
-- "identity step, never the privileged action itself" shape 0012/0024's
-- cross-org functions already use. `org_id` starts null and is filled
-- in once the event is resolved to an org (mirrors audit_log's own
-- nullable-org_id-for-platform-rows pattern, 0016) — a webhook body
-- Paystack sends for a customer code this database doesn't recognize
-- (e.g. a stale test-mode event) is still recorded, just org-less and
-- flagged unprocessed, not silently dropped.
-- ---------------------------------------------------------------------
create table billing_events (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid references organizations(id),
  provider            text not null default 'paystack' check (provider = 'paystack'), -- one provider (§1: Paystack) — narrow on purpose, matches ai_usage's narrow feature check() rather than an open text column for a set of one
  event_type          text not null, -- Paystack's own event name: charge.success, subscription.disable, invoice.payment_failed, subscription.not_renew, etc.
  provider_event_id   text not null, -- Paystack event payload has no single canonical event id in all cases; billingWebhookService derives a stable one (reference + event type) — see that file's own comment
  payload             jsonb not null,
  processed           boolean not null default false,
  processed_at        timestamptz,
  error_message        text,
  created_at          timestamptz not null default now(),
  unique (provider, provider_event_id)
);

create index idx_billing_events_org on billing_events(org_id);
create index idx_billing_events_unprocessed on billing_events(processed) where not processed;

-- org_id nullable, same audit_log carve-out: a null-org row simply never
-- matches this policy and is invisible to any org-scoped query, by
-- construction. Super Admin's own cross-org read of unresolved events
-- (for manual reconciliation) goes through a bootstrap function, not
-- this policy, same as searchAuditLog's platform read path.
alter table billing_events enable row level security;
alter table billing_events force row level security;

create policy tenant_isolation on billing_events
  using (org_id = current_setting('app.current_org_id', true)::uuid);

grant select on billing_events to nexus_app;

-- ---------------------------------------------------------------------
-- billing_invoices — payment history, always org-scoped by the time a
-- row is written (org resolution happens before this insert, inside
-- billingWebhookService, same ordering calendarSyncService's
-- incrementalSync already follows: resolve org_id first, then
-- withOrgContext for everything after). Amount in kobo (Paystack's own
-- lowest-denomination unit for NGN — the API returns/accepts kobo
-- natively, so storing the same unit avoids a conversion at every read
-- and write).
-- ---------------------------------------------------------------------
create table billing_invoices (
  id                    uuid primary key default gen_random_uuid(),
  org_id                uuid not null references organizations(id),
  paystack_reference    text not null,
  amount_kobo           bigint not null,
  currency              text not null default 'NGN',
  status                text not null check (status in ('success', 'failed', 'pending')),
  paid_at               timestamptz,
  billing_event_id      uuid references billing_events(id),
  created_at            timestamptz not null default now(),
  unique (org_id, paystack_reference)
);

create index idx_billing_invoices_org on billing_invoices(org_id, created_at desc);

alter table billing_invoices enable row level security;
alter table billing_invoices force row level security;

create policy tenant_isolation on billing_invoices
  using (org_id = current_setting('app.current_org_id', true)::uuid);

grant select, insert on billing_invoices to nexus_app;

-- ---------------------------------------------------------------------
-- Cross-org functions — same nexus_bootstrap SECURITY DEFINER shape as
-- 0012/0019/0020/0024's own (find_subscription_by_channel_id,
-- search_organizations, create_organization_row,
-- list_orgs_with_automation_enabled). Table-level grants to
-- nexus_bootstrap are required in addition to BYPASSRLS, same "RLS-
-- bypass and privilege grants are independent checks" lesson 0020's own
-- header spells out and 0024's real live-run bug confirmed again.
-- ---------------------------------------------------------------------
grant select, insert, update on org_billing to nexus_bootstrap;
grant select, insert, update on billing_events to nexus_bootstrap;
grant select, insert on billing_invoices to nexus_bootstrap;
grant select on organizations to nexus_bootstrap; -- already granted by 0019, restated here for this file's own self-containedness

-- find_org_billing_by_customer_code / _by_subscription_code — Paystack
-- webhook resolution, no org context yet. Mirrors
-- resolveSubscriptionByChannelId's exact reasoning (calendarSyncService.ts):
-- this is the one cross-org lookup a webhook needs before any org-scoped
-- write can happen at all.
create or replace function find_org_billing_by_customer_code(p_customer_code text)
returns org_billing
language sql
security definer
set search_path = public
as $$
  select * from org_billing where paystack_customer_code = p_customer_code limit 1;
$$;

alter function find_org_billing_by_customer_code(text) owner to nexus_bootstrap;
revoke all on function find_org_billing_by_customer_code(text) from public;
grant execute on function find_org_billing_by_customer_code(text) to nexus_app;

create or replace function find_org_billing_by_subscription_code(p_subscription_code text)
returns org_billing
language sql
security definer
set search_path = public
as $$
  select * from org_billing where paystack_subscription_code = p_subscription_code limit 1;
$$;

alter function find_org_billing_by_subscription_code(text) owner to nexus_bootstrap;
revoke all on function find_org_billing_by_subscription_code(text) from public;
grant execute on function find_org_billing_by_subscription_code(text) to nexus_app;

-- record_billing_event — the one write a webhook handler makes before
-- an org_id is necessarily known (payload is recorded first, resolved/
-- processed second — see billingWebhookService.ts's own ordering
-- comment: never let a parsing/lookup failure mean an incoming Paystack
-- event was never durably recorded at all). ON CONFLICT DO NOTHING on
-- the (provider, provider_event_id) unique constraint makes a Paystack
-- retry of the same event a safe no-op rather than a 500 — Paystack
-- webhooks are at-least-once delivery, same "ack fast, dedupe on our
-- side" posture routes/calendarWebhook.ts already takes for Google.
create or replace function record_billing_event(
  p_org_id uuid,
  p_event_type text,
  p_provider_event_id text,
  p_payload jsonb
)
returns billing_events
language sql
security definer
set search_path = public
as $$
  insert into billing_events (org_id, event_type, provider_event_id, payload)
  values (p_org_id, p_event_type, p_provider_event_id, p_payload)
  on conflict (provider, provider_event_id) do update set provider_event_id = excluded.provider_event_id
  returning *;
$$;

alter function record_billing_event(uuid, text, text, jsonb) owner to nexus_bootstrap;
revoke all on function record_billing_event(uuid, text, text, jsonb) from public;
grant execute on function record_billing_event(uuid, text, text, jsonb) to nexus_app;

-- mark_billing_event_processed — separate from the insert above so a
-- webhook handler that fails partway through applying an event (e.g. the
-- org_billing update throws) leaves the event row correctly marked
-- unprocessed with its error, rather than the insert itself needing to
-- know the outcome of work that hasn't happened yet.
create or replace function mark_billing_event_processed(
  p_id uuid,
  p_success boolean,
  p_error_message text
)
returns void
language sql
security definer
set search_path = public
as $$
  update billing_events
     set processed = p_success,
         processed_at = case when p_success then now() else processed_at end,
         error_message = p_error_message
   where id = p_id;
$$;

alter function mark_billing_event_processed(uuid, boolean, text) owner to nexus_bootstrap;
revoke all on function mark_billing_event_processed(uuid, boolean, text) from public;
grant execute on function mark_billing_event_processed(uuid, boolean, text) to nexus_app;

-- upsert_org_billing_for_webhook — the one cross-org write a webhook
-- handler makes to org_billing once an org_id has been resolved. A
-- plain insert-or-update through withOrgContext(orgId, ...) would also
-- satisfy org_billing's own RLS policy (org_id = current_org_id), same
-- as organizationService's platform-admin writes already do for
-- organizations — but a webhook handler has no natural "session" to
-- open a request-scoped transaction against, and the coalesce-null-
-- means-unchanged shape here exactly mirrors update_organization_row's
-- (0020) own partial-patch convention, so this stays consistent with
-- that established pattern rather than introducing a second write style
-- for the same table.
create or replace function upsert_org_billing_for_webhook(
  p_org_id uuid,
  p_tier text,
  p_billing_status text,
  p_paystack_customer_code text,
  p_paystack_subscription_code text,
  p_paystack_plan_code text,
  p_current_period_start timestamptz,
  p_current_period_end timestamptz,
  p_grace_period_ends_at timestamptz,
  p_last_payment_at timestamptz,
  p_clear_grace_period boolean
)
returns org_billing
language plpgsql
security definer
set search_path = public
as $$
declare
  result org_billing;
begin
  insert into org_billing (org_id, tier, billing_status, paystack_customer_code, paystack_subscription_code,
                            paystack_plan_code, current_period_start, current_period_end, grace_period_ends_at, last_payment_at)
  values (p_org_id, coalesce(p_tier, 'free'), coalesce(p_billing_status, 'active'), p_paystack_customer_code,
          p_paystack_subscription_code, p_paystack_plan_code, p_current_period_start, p_current_period_end,
          p_grace_period_ends_at, p_last_payment_at)
  on conflict (org_id) do update
    set tier                        = coalesce(p_tier, org_billing.tier),
        billing_status               = coalesce(p_billing_status, org_billing.billing_status),
        paystack_customer_code       = coalesce(p_paystack_customer_code, org_billing.paystack_customer_code),
        paystack_subscription_code   = coalesce(p_paystack_subscription_code, org_billing.paystack_subscription_code),
        paystack_plan_code           = coalesce(p_paystack_plan_code, org_billing.paystack_plan_code),
        current_period_start         = coalesce(p_current_period_start, org_billing.current_period_start),
        current_period_end           = coalesce(p_current_period_end, org_billing.current_period_end),
        grace_period_ends_at         = case when p_clear_grace_period then null else coalesce(p_grace_period_ends_at, org_billing.grace_period_ends_at) end,
        last_payment_at              = coalesce(p_last_payment_at, org_billing.last_payment_at),
        updated_at                   = now()
  returning * into result;

  return result;
end;
$$;

alter function upsert_org_billing_for_webhook(uuid, text, text, text, text, text, timestamptz, timestamptz, timestamptz, timestamptz, boolean)
  owner to nexus_bootstrap;
revoke all on function upsert_org_billing_for_webhook(uuid, text, text, text, text, text, timestamptz, timestamptz, timestamptz, timestamptz, boolean)
  from public;
grant execute on function upsert_org_billing_for_webhook(uuid, text, text, text, text, text, timestamptz, timestamptz, timestamptz, timestamptz, boolean)
  to nexus_app;

-- list_billing_past_due_for_grace_check — same shape as
-- list_orgs_with_automation_enabled (0024): the daily grace-period sweep
-- (automationJobs.ts's dailyBillingGraceCheck) has no single org_id to
-- scope to, so it needs one cross-org dispatch read before re-entering
-- withOrgContext per row for the actual state transition.
create or replace function list_billing_past_due_for_grace_check()
returns table (org_id uuid, grace_period_ends_at timestamptz)
language sql
security definer
set search_path = public
as $$
  select org_id, grace_period_ends_at
    from org_billing
   where billing_status = 'past_due'
     and grace_period_ends_at is not null
     and grace_period_ends_at < now();
$$;

alter function list_billing_past_due_for_grace_check() owner to nexus_bootstrap;
revoke all on function list_billing_past_due_for_grace_check() from public;
grant execute on function list_billing_past_due_for_grace_check() to nexus_app;

-- list_billing_pending_review / resolve_billing_review — the Super
-- Admin review-queue backend (§1's "grace period, then mandatory manual
-- Super Admin review" decision; open question #6's "surfacing to Super
-- Admin" resolved as a filter on billing_status = 'pending_review', per
-- this file's own earlier comment on `review_note`). Same
-- nexus_bootstrap SECURITY DEFINER shape as every other cross-org
-- function in this migration — Super Admin has no single org_id to SET
-- LOCAL for a query that spans every org by definition.
create or replace function list_billing_pending_review()
returns table (
  org_id uuid,
  org_name text,
  tier text,
  billing_status text,
  grace_period_ends_at timestamptz,
  review_note text,
  updated_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  select b.org_id, o.name, b.tier, b.billing_status, b.grace_period_ends_at, b.review_note, b.updated_at
    from org_billing b
    join organizations o on o.id = b.org_id
   where b.billing_status = 'pending_review'
   order by b.updated_at asc;
$$;

alter function list_billing_pending_review() owner to nexus_bootstrap;
revoke all on function list_billing_pending_review() from public;
grant execute on function list_billing_pending_review() to nexus_app;

-- resolve_billing_review — the one write Super Admin makes to close out
-- a pending_review row. p_new_tier/p_new_status let a resolution be any
-- of: comp'd back onto their existing paid tier (retry succeeded outside
-- the webhook path — active, same tier), manually downgraded (active,
-- 'free'), or manually suspended (suspended, tier unchanged) — same
-- "Super Admin can override what the automated path decided" posture
-- 0020's own update_organization_row already establishes for org
-- metadata. grace_period_ends_at is always cleared on resolution — a
-- resolved row has no more pending grace window regardless of which way
-- it was resolved.
create or replace function resolve_billing_review(
  p_org_id uuid,
  p_new_tier text,
  p_new_status text,
  p_note text,
  p_reviewed_by_user_id uuid
)
returns org_billing
language plpgsql
security definer
set search_path = public
as $$
declare
  result org_billing;
begin
  update org_billing
     set tier = coalesce(p_new_tier, tier),
         billing_status = coalesce(p_new_status, billing_status),
         grace_period_ends_at = null,
         review_note = p_note,
         reviewed_by_user_id = p_reviewed_by_user_id,
         reviewed_at = now(),
         updated_at = now()
   where org_id = p_org_id
  returning * into result;

  return result;
end;
$$;

alter function resolve_billing_review(uuid, text, text, text, uuid) owner to nexus_bootstrap;
revoke all on function resolve_billing_review(uuid, text, text, text, uuid) from public;
grant execute on function resolve_billing_review(uuid, text, text, text, uuid) to nexus_app;
