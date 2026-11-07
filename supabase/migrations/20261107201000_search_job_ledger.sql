-- Lot C. Fichier seulement : ne pas appliquer sur Test ni Prod.
-- jobs_enabled n'est pas allumé. Le client ne peut pas régler un job v2.
-- Le grand livre existant reste le seul solde. L'ancien reserve/settle
-- continue pour les reçus qui ne sont pas liés à un job.

alter table public.search_jobs
  add column if not exists ledger_receipt text,
  add column if not exists ledger_amount integer,
  add column if not exists ledger_status text not null default 'none',
  add column if not exists collection_outcome text,
  add column if not exists result_count integer,
  add column if not exists reserved_until timestamptz;

alter table public.search_jobs
  drop constraint if exists search_jobs_ledger_status,
  drop constraint if exists search_jobs_collection_outcome,
  drop constraint if exists search_jobs_ledger_amount,
  drop constraint if exists search_jobs_result_count,
  drop constraint if exists search_jobs_receipt_shape;

alter table public.search_jobs
  add constraint search_jobs_ledger_status check (ledger_status in ('none', 'open', 'complete', 'released')),
  add constraint search_jobs_collection_outcome check (collection_outcome is null or collection_outcome in ('complete', 'empty', 'partial', 'failed')),
  add constraint search_jobs_ledger_amount check (ledger_amount is null or ledger_amount > 0),
  add constraint search_jobs_result_count check (result_count is null or result_count >= 0),
  add constraint search_jobs_receipt_shape check (ledger_receipt is null or ledger_receipt ~ '^debit_[0-9a-f]{24}$');

create or replace function private.apply_usage_outcome(p_user uuid, p_receipt text, p_outcome text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  period text := private.toronto_period();
  account public.credit_accounts%rowtype;
  hold public.usage_holds%rowtype;
begin
  if p_user is null then
    raise exception 'session_requise';
  end if;
  if p_outcome is null or p_outcome not in ('complete', 'release') then
    raise exception 'recu_invalide';
  end if;

  select * into hold
  from public.usage_holds
  where user_id = p_user and receipt = p_receipt
  for update;

  if not found then
    raise exception 'recu_invalide';
  end if;

  select * into account
  from public.credit_accounts
  where user_id = p_user
  for update;

  if account.usage_period is distinct from period then
    update public.credit_accounts
    set usage_period = period, searches_used = 0
    where user_id = p_user
    returning * into account;
  end if;

  if p_outcome = 'complete' then
    if hold.status = 'complete' then
      return jsonb_build_object('balance', account.balance, 'searches_used', account.searches_used, 'status', 'complete');
    end if;
    if hold.status <> 'open' then
      raise exception 'recu_invalide';
    end if;
    if account.searches_used >= 10 then
      raise exception 'quota_mensuel';
    end if;
    update public.usage_holds
    set status = 'complete'
    where user_id = p_user and receipt = p_receipt;
    update public.credit_accounts
    set searches_used = account.searches_used + 1
    where user_id = p_user
    returning * into account;
    insert into public.credit_receipts (user_id, receipt, amount, label)
    values (p_user, p_receipt, hold.amount, hold.label);
    return jsonb_build_object('balance', account.balance, 'searches_used', account.searches_used, 'status', 'complete');
  end if;

  if hold.status = 'released' then
    return jsonb_build_object('balance', account.balance, 'searches_used', account.searches_used, 'status', 'released');
  end if;
  if hold.status <> 'open' then
    raise exception 'recu_invalide';
  end if;

  update public.credit_accounts
  set balance = account.balance + hold.amount
  where user_id = p_user
  returning * into account;
  update public.usage_holds
  set status = 'released'
  where user_id = p_user and receipt = p_receipt;
  return jsonb_build_object('balance', account.balance, 'searches_used', account.searches_used, 'status', 'released');
end;
$$;

revoke all on function private.apply_usage_outcome(uuid, text, text) from public, anon, authenticated;

create or replace function public.settle_usage(p_receipt text, p_outcome text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'session_requise';
  end if;
  if exists (
    select 1
    from public.search_jobs
    where user_id = uid
      and ledger_receipt = p_receipt
  ) then
    raise exception 'reglement_serveur_requis';
  end if;
  return private.apply_usage_outcome(uid, p_receipt, p_outcome);
end;
$$;

revoke all on function public.settle_usage(text, text) from public, anon;
grant execute on function public.settle_usage(text, text) to authenticated;

create or replace function public.enqueue_search_job(p_key text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid;
  enabled boolean;
  limit_per_minute integer;
  existing public.search_jobs;
  recent integer;
  created public.search_jobs;
  quantity integer;
  amount integer;
  receipt text;
  reserved jsonb;
begin
  uid := auth.uid();
  if uid is null then
    raise exception 'authentication_required' using errcode = '42501';
  end if;

  select settings.jobs_enabled, settings.rate_limit_per_minute
    into enabled, limit_per_minute
  from private.search_job_settings as settings
  where settings.singleton;

  if coalesce(enabled, false) is not true then
    raise exception 'jobs_disabled' using errcode = '42501';
  end if;
  if p_key is null or char_length(p_key) < 8 or char_length(p_key) > 80 then
    raise exception 'idempotency_key_invalide' using errcode = '22023';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' or p_payload ->> 'place_status' is distinct from 'supported' then
    raise exception 'place_rejected' using errcode = '22023';
  end if;
  if octet_length(p_payload::text) > 8192 then
    raise exception 'payload_trop_grand' using errcode = '22023';
  end if;
  if (p_payload ->> 'quantity') is null or (p_payload ->> 'quantity') !~ '^[0-9]+$' then
    raise exception 'quantite_invalide' using errcode = '22023';
  end if;
  quantity := (p_payload ->> 'quantity')::integer;
  if quantity < 10 or quantity > 40 then
    raise exception 'quantite_invalide' using errcode = '22023';
  end if;
  amount := 5 + cast(ceil(quantity / 10.0) as integer);

  select job.*
    into existing
  from public.search_jobs as job
  where job.user_id = uid
    and job.idempotency_key = p_key
  for update;
  if found then
    return jsonb_build_object(
      'id', existing.id,
      'status', existing.status,
      'attempt', existing.attempt,
      'progress', existing.progress,
      'ledger_status', existing.ledger_status,
      'created', false
    );
  end if;

  select count(*)
    into recent
  from public.search_jobs as job
  where job.user_id = uid
    and job.created_at > pg_catalog.now() - interval '1 minute';
  if recent >= coalesce(limit_per_minute, 6) then
    raise exception 'rate_limited' using errcode = '53400';
  end if;

  receipt := 'debit_' || substr(md5(uid::text || ':' || p_key), 1, 24);
  reserved := public.reserve_usage(receipt, amount, 'Recherche');

  insert into public.search_jobs (
    user_id, idempotency_key, payload, place_status,
    ledger_receipt, ledger_amount, ledger_status, reserved_until
  )
  values (
    uid, p_key, p_payload, 'supported',
    receipt, amount, 'open', pg_catalog.now() + interval '15 minutes'
  )
  returning * into created;

  return jsonb_build_object(
    'id', created.id,
    'status', created.status,
    'attempt', created.attempt,
    'progress', created.progress,
    'ledger_status', created.ledger_status,
    'balance', reserved -> 'balance',
    'created', true
  );
end;
$$;

revoke all on function public.enqueue_search_job(text, jsonb) from public, anon;
grant execute on function public.enqueue_search_job(text, jsonb) to authenticated;

create or replace function public.cancel_search_job(p_job_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid;
  existing public.search_jobs;
begin
  uid := auth.uid();
  if uid is null then
    raise exception 'authentication_required' using errcode = '42501';
  end if;

  select job.*
    into existing
  from public.search_jobs as job
  where job.id = p_job_id
    and job.user_id = uid
  for update;
  if not found then
    raise exception 'job_not_found' using errcode = '42501';
  end if;

  if existing.status in ('queued', 'running') then
    if existing.ledger_status = 'open' and existing.ledger_receipt is not null then
      perform private.apply_usage_outcome(uid, existing.ledger_receipt, 'release');
    end if;
    update public.search_jobs as job
    set status = 'cancelled',
        ledger_status = case when job.ledger_status = 'open' then 'released' else job.ledger_status end,
        last_error = 'cancelled',
        updated_at = pg_catalog.now()
    where job.id = existing.id
    returning * into existing;
  end if;

  return jsonb_build_object(
    'id', existing.id,
    'status', existing.status,
    'attempt', existing.attempt,
    'progress', existing.progress,
    'ledger_status', existing.ledger_status,
    'created', false
  );
end;
$$;

revoke all on function public.cancel_search_job(uuid) from public, anon;
grant execute on function public.cancel_search_job(uuid) to authenticated;

create or replace function private.record_search_collection(p_job_id uuid, p_outcome text, p_count integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing public.search_jobs;
begin
  if p_outcome is null or p_outcome not in ('complete', 'empty', 'partial', 'failed') then
    raise exception 'issue_invalide' using errcode = '22023';
  end if;
  if p_count is null or p_count < 0 or (p_outcome = 'complete' and p_count < 1) or (p_outcome <> 'complete' and p_count <> 0) then
    raise exception 'issue_invalide' using errcode = '22023';
  end if;

  select job.*
    into existing
  from public.search_jobs as job
  where job.id = p_job_id
  for update;
  if not found then
    raise exception 'job_not_found' using errcode = '42501';
  end if;
  if existing.collection_outcome is not null
     and existing.collection_outcome = p_outcome
     and existing.result_count = p_count then
    return jsonb_build_object('id', existing.id, 'collection_outcome', existing.collection_outcome, 'result_count', existing.result_count, 'recorded', false);
  end if;
  if existing.ledger_status = 'complete' then
    raise exception 'deja_regle' using errcode = '42501';
  end if;
  if existing.ledger_status <> 'open' or existing.status not in ('queued', 'running') then
    raise exception 'job_clos' using errcode = '42501';
  end if;
  if existing.collection_outcome is not null then
    raise exception 'collection_figee' using errcode = '42501';
  end if;
  update public.search_jobs as job
  set collection_outcome = p_outcome,
      result_count = p_count,
      status = 'running',
      progress = 80,
      updated_at = pg_catalog.now()
  where job.id = existing.id
  returning * into existing;

  return jsonb_build_object(
    'id', existing.id,
    'collection_outcome', existing.collection_outcome,
    'result_count', existing.result_count,
    'ledger_status', existing.ledger_status,
    'recorded', true
  );
end;
$$;

create or replace function private.reconcile_search_job(p_job_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing public.search_jobs;
  money jsonb;
  terminal text;
begin
  select job.*
    into existing
  from public.search_jobs as job
  where job.id = p_job_id
  for update;
  if not found then
    raise exception 'job_not_found' using errcode = '42501';
  end if;

  if existing.ledger_status in ('complete', 'released') then
    return jsonb_build_object(
      'id', existing.id,
      'status', existing.status,
      'ledger_status', existing.ledger_status,
      'replayed', true
    );
  end if;

  if existing.status = 'queued'
     and existing.collection_outcome is null
     and existing.reserved_until is not null
     and existing.reserved_until < pg_catalog.now() then
    if existing.ledger_status = 'open' and existing.ledger_receipt is not null then
      perform private.apply_usage_outcome(existing.user_id, existing.ledger_receipt, 'release');
    end if;
    update public.search_jobs as job
    set status = 'failed',
        ledger_status = 'released',
        last_error = 'reservation_expired',
        progress = 100,
        updated_at = pg_catalog.now()
    where job.id = existing.id
    returning * into existing;
    return jsonb_build_object('id', existing.id, 'status', existing.status, 'ledger_status', existing.ledger_status, 'last_error', existing.last_error, 'replayed', false);
  end if;

  if existing.collection_outcome is null then
    return jsonb_build_object('id', existing.id, 'status', existing.status, 'ledger_status', existing.ledger_status, 'waiting', true);
  end if;

  if existing.collection_outcome = 'complete' and coalesce(existing.result_count, 0) > 0 then
    money := private.apply_usage_outcome(existing.user_id, existing.ledger_receipt, 'complete');
    terminal := 'succeeded';
  else
    money := private.apply_usage_outcome(existing.user_id, existing.ledger_receipt, 'release');
    terminal := 'failed';
  end if;

  update public.search_jobs as job
  set status = terminal,
      ledger_status = money ->> 'status',
      last_error = case when terminal = 'succeeded' then '' else existing.collection_outcome end,
      progress = 100,
      updated_at = pg_catalog.now()
  where job.id = existing.id
  returning * into existing;

  return jsonb_build_object(
    'id', existing.id,
    'status', existing.status,
    'ledger_status', existing.ledger_status,
    'balance', money -> 'balance',
    'searches_used', money -> 'searches_used',
    'replayed', false
  );
end;
$$;

revoke all on function private.apply_usage_outcome(uuid, text, text) from PUBLIC;
revoke all on function private.record_search_collection(uuid, text, integer) from PUBLIC;
revoke all on function private.reconcile_search_job(uuid) from PUBLIC;
revoke all on function private.record_search_collection(uuid, text, integer) from public, anon, authenticated;
revoke all on function private.reconcile_search_job(uuid) from public, anon, authenticated;

comment on function private.reconcile_search_job(uuid) is
  'Règle ou libère le reçu du job. Réservé au rôle du serveur. Idempotent. jobs_enabled n''est pas modifié.';
comment on function public.settle_usage(text, text) is
  'Règle un reçu du parcours actuel. Refuse un reçu lié à un job v2 : seul le serveur le règle.';
