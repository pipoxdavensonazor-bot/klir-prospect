-- Rôle d'exploitation des jobs. Fichier seulement : ne pas appliquer sur Test ni Prod.
-- Le propriétaire de cette migration n'est pas le rôle qui exécute la file.
-- klir_job_api et klir_job_runner sont NOLOGIN : pas de connexion distante, pas de secret.
-- jobs_enabled n'est pas modifié.

alter table public.search_jobs
  add column if not exists claim_until timestamptz;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'klir_job_api') then
    create role klir_job_api nologin noinherit nosuperuser nocreatedb nocreaterole;
  else
    alter role klir_job_api nologin noinherit nosuperuser nocreatedb nocreaterole;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'klir_job_runner') then
    create role klir_job_runner nologin noinherit nosuperuser nocreatedb nocreaterole;
  else
    alter role klir_job_runner nologin noinherit nosuperuser nocreatedb nocreaterole;
  end if;
end
$$;

create or replace function public.search_jobs_enabled()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select settings.jobs_enabled
    from private.search_job_settings as settings
    where settings.singleton
  ), false)
$$;

create or replace function public.read_search_job(p_job_id uuid)
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
  if p_job_id is null then
    return null;
  end if;

  select job.*
    into existing
  from public.search_jobs as job
  where job.id = p_job_id
    and job.user_id = uid;
  if not found then
    return null;
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

create or replace function private.claim_search_jobs(p_limit integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  claimed jsonb;
begin
  if p_limit is null or p_limit < 1 or p_limit > 8 then
    raise exception 'limite_invalide' using errcode = '22023';
  end if;

  with picked as (
    select job.id
    from public.search_jobs as job
    where job.ledger_status = 'open'
      and (
        (
          job.collection_outcome is null
          and (
            (
              job.status = 'queued'
              and (job.reserved_until is null or job.reserved_until > pg_catalog.now())
            )
            or (
              job.status = 'running'
              and (job.claim_until is null or job.claim_until < pg_catalog.now())
            )
          )
        )
        or (
          job.status = 'running'
          and job.collection_outcome is not null
        )
      )
    order by job.created_at
    for update skip locked
    limit p_limit
  ),
  updated as (
    update public.search_jobs as job
    set status = 'running',
        attempt = case
          when job.collection_outcome is null then job.attempt + 1
          else job.attempt
        end,
        claim_until = case
          when job.collection_outcome is null then pg_catalog.now() + interval '30 seconds'
          else job.claim_until
        end,
        updated_at = pg_catalog.now()
    from picked
    where job.id = picked.id
    returning
      job.id,
      job.payload,
      job.attempt,
      job.status,
      job.ledger_status,
      job.collection_outcome,
      job.result_count
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', updated.id,
    'payload', updated.payload,
    'attempt', updated.attempt,
    'status', updated.status,
    'ledger_status', updated.ledger_status,
    'collection_outcome', updated.collection_outcome,
    'result_count', updated.result_count
  )), '[]'::jsonb)
  into claimed
  from updated;

  return claimed;
end;
$$;

create or replace function private.release_search_job_claim(p_job_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing public.search_jobs;
begin
  select job.*
    into existing
  from public.search_jobs as job
  where job.id = p_job_id
  for update;
  if not found then
    raise exception 'job_not_found' using errcode = '42501';
  end if;
  if existing.status = 'running'
     and existing.collection_outcome is null
     and existing.ledger_status = 'open' then
    update public.search_jobs as job
    set claim_until = pg_catalog.now() - interval '1 second',
        updated_at = pg_catalog.now()
    where job.id = existing.id
    returning * into existing;
  end if;
  return jsonb_build_object('id', existing.id, 'status', existing.status, 'ledger_status', existing.ledger_status);
end;
$$;

create or replace function private.expire_due_search_jobs()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  job_id uuid;
  count_expired integer := 0;
begin
  for job_id in
    select job.id
    from public.search_jobs as job
    where job.status = 'queued'
      and job.collection_outcome is null
      and job.ledger_status = 'open'
      and job.reserved_until is not null
      and job.reserved_until < pg_catalog.now()
    order by job.created_at
    for update skip locked
  loop
    perform private.reconcile_search_job(job_id);
    count_expired := count_expired + 1;
  end loop;
  return jsonb_build_object('expired', count_expired);
end;
$$;

revoke all on function public.search_jobs_enabled() from PUBLIC, public, anon, authenticated;
revoke all on function public.read_search_job(uuid) from PUBLIC, public, anon, authenticated;
revoke all on function private.claim_search_jobs(integer) from PUBLIC, public, anon, authenticated;
revoke all on function private.release_search_job_claim(uuid) from PUBLIC, public, anon, authenticated;
revoke all on function private.expire_due_search_jobs() from PUBLIC, public, anon, authenticated;
revoke all on function private.record_search_collection(uuid, text, integer) from PUBLIC, public, anon, authenticated;
revoke all on function private.reconcile_search_job(uuid) from PUBLIC, public, anon, authenticated;
revoke all on function private.apply_usage_outcome(uuid, text, text) from PUBLIC, public, anon, authenticated;

grant execute on function public.search_jobs_enabled() to klir_job_api;
grant execute on function public.read_search_job(uuid) to klir_job_api;
grant execute on function public.enqueue_search_job(text, jsonb) to klir_job_api;
grant execute on function public.cancel_search_job(uuid) to klir_job_api;

grant usage on schema private to klir_job_runner;
grant execute on function private.claim_search_jobs(integer) to klir_job_runner;
grant execute on function private.release_search_job_claim(uuid) to klir_job_runner;
grant execute on function private.expire_due_search_jobs() to klir_job_runner;
grant execute on function private.record_search_collection(uuid, text, integer) to klir_job_runner;
grant execute on function private.reconcile_search_job(uuid) to klir_job_runner;

revoke all on function private.apply_usage_outcome(uuid, text, text) from klir_job_api, klir_job_runner;
revoke all on function private.claim_search_jobs(integer) from klir_job_api;
revoke all on function private.release_search_job_claim(uuid) from klir_job_api;
revoke all on function private.expire_due_search_jobs() from klir_job_api;
revoke all on function private.record_search_collection(uuid, text, integer) from klir_job_api;
revoke all on function private.reconcile_search_job(uuid) from klir_job_api;
revoke all on function public.enqueue_search_job(text, jsonb) from klir_job_runner;
revoke all on function public.cancel_search_job(uuid) from klir_job_runner;
revoke all on function public.reserve_usage(text, integer, text) from klir_job_api, klir_job_runner;
revoke all on function public.settle_usage(text, text) from klir_job_api, klir_job_runner;

revoke all on all tables in schema public from klir_job_api, klir_job_runner;
revoke all on all tables in schema private from klir_job_api, klir_job_runner;
revoke all on all sequences in schema public from klir_job_api, klir_job_runner;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'klir_job_connect') then
    grant klir_job_api to klir_job_connect;
    grant klir_job_runner to klir_job_connect;
  end if;
end
$$;

comment on role klir_job_api is
  'Entrée HTTP locale des jobs. NOLOGIN. Enqueue, lecture et annulation seulement.';
comment on role klir_job_runner is
  'Reprise de la file. NOLOGIN. Claim, collecte et réconciliation. Pas le propriétaire des migrations.';
comment on function private.claim_search_jobs(integer) is
  'Prend des jobs ouverts avec SKIP LOCKED. N''allume pas jobs_enabled et ne règle pas le crédit.';
