-- Session 60 (C-05) — Paystack retries were applied again every time.
--
-- record_billing_event (0025) upserts on (provider, provider_event_id) and
-- returns the row whether it was new or not, and the webhook service then
-- applied the event regardless. So the "dedupe" recorded duplicates but
-- never stopped them: a retried invoice.payment_failed pushed the grace
-- period back each time, and a late retry of an old charge.success could
-- re-activate a subscription that had since been cancelled.
--
-- claim_billing_event records the event (or finds the earlier delivery)
-- and atomically claims it for processing. Only one caller ever gets
-- claimed = true for an event — unless an earlier attempt failed
-- (processed = false) and its claim is more than 5 minutes old, in which
-- case a later Paystack retry may try again.
alter table billing_events add column if not exists processing_started_at timestamptz;

create or replace function claim_billing_event(
  p_org_id uuid,
  p_event_type text,
  p_provider_event_id text,
  p_payload jsonb
)
returns table (id uuid, is_new boolean, claimed boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_new boolean := false;
  v_claimed uuid;
begin
  insert into billing_events (org_id, event_type, provider_event_id, payload)
  values (p_org_id, p_event_type, p_provider_event_id, p_payload)
  on conflict (provider, provider_event_id) do nothing
  returning billing_events.id into v_id;

  if v_id is not null then
    v_new := true;
  else
    select e.id into v_id from billing_events e
     where e.provider = 'paystack' and e.provider_event_id = p_provider_event_id;
  end if;

  update billing_events e set processing_started_at = now()
   where e.id = v_id
     and not e.processed
     and (e.processing_started_at is null or e.processing_started_at < now() - interval '5 minutes')
  returning e.id into v_claimed;

  return query select v_id, v_new, v_claimed is not null;
end;
$$;

alter function claim_billing_event(uuid, text, text, jsonb) owner to nexus_bootstrap;
revoke all on function claim_billing_event(uuid, text, text, jsonb) from public;
grant execute on function claim_billing_event(uuid, text, text, jsonb) to nexus_app;
