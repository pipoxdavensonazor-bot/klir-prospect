-- Lot B. Fichier seulement : ne pas appliquer sur Test ni Prod depuis cette PR.
-- jobs_enabled reste false. Aucun débit de crédit. Aucun appel fournisseur.
-- Le client authentifié lit ses jobs. Il ne les écrit pas directement.
-- private.admins et public.is_admin() ne donnent pas accès aux jobs d'autrui.

create table if not exists private.search_job_settings (
  singleton boolean primary key default true check (singleton),
  jobs_enabled boolean not null default false,
  max_attempts integer not null default 3 check (max_attempts between 1 and 5),
  rate_limit_per_minute integer not null default 6 check (rate_limit_per_minute between 1 and 30)
);

insert into private.search_job_settings (singleton, jobs_enabled)
values (true, false)
on conflict (singleton) do nothing;

revoke all on table private.search_job_settings from public, anon, authenticated;

create table if not exists public.search_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  idempotency_key text not null check (char_length(idempotency_key) between 8 and 80),
  status text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  attempt integer not null default 0 check (attempt >= 0 and attempt <= 5),
  progress integer not null default 0 check (progress between 0 and 100),
  place_status text not null check (place_status = 'supported'),
  payload jsonb not null,
  last_error text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, idempotency_key),
  constraint search_jobs_payload_object check (jsonb_typeof(payload) = 'object'),
  constraint search_jobs_payload_size check (octet_length(payload::text) <= 8192)
);

alter table public.search_jobs enable row level security;
alter table public.search_jobs force row level security;

revoke all on table public.search_jobs from public, anon, authenticated;
grant select on table public.search_jobs to authenticated;

create policy search_jobs_select_own
on public.search_jobs
for select
to authenticated
using ((select auth.uid()) = user_id);

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

  select job.*
    into existing
  from public.search_jobs as job
  where job.user_id = uid
    and job.idempotency_key = p_key;
  if found then
    return jsonb_build_object(
      'id', existing.id,
      'status', existing.status,
      'attempt', existing.attempt,
      'progress', existing.progress,
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

  insert into public.search_jobs (user_id, idempotency_key, payload, place_status)
  values (uid, p_key, p_payload, 'supported')
  returning * into created;

  return jsonb_build_object(
    'id', created.id,
    'status', created.status,
    'attempt', created.attempt,
    'progress', created.progress,
    'created', true
  );
end;
$$;

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
    and job.user_id = uid;
  if not found then
    raise exception 'job_not_found' using errcode = '42501';
  end if;

  if existing.status in ('queued', 'running') then
    update public.search_jobs as job
    set status = 'cancelled',
        updated_at = pg_catalog.now()
    where job.id = existing.id
    returning * into existing;
  end if;

  return jsonb_build_object(
    'id', existing.id,
    'status', existing.status,
    'attempt', existing.attempt,
    'progress', existing.progress,
    'created', false
  );
end;
$$;

revoke all on function public.enqueue_search_job(text, jsonb) from public, anon;
revoke all on function public.cancel_search_job(uuid) from public, anon;
grant execute on function public.enqueue_search_job(text, jsonb) to authenticated;
grant execute on function public.cancel_search_job(uuid) to authenticated;

comment on table private.search_job_settings is
  'Drapeau serveur des jobs de recherche. jobs_enabled est false tant que le lot C n''a pas de règlement de crédits.';
comment on table public.search_jobs is
  'File durable des recherches. Lecture limitée au propriétaire. Pas un débit de crédits.';
comment on function public.enqueue_search_job(text, jsonb) is
  'Refuse si le drapeau est éteint, si le lieu n''est pas supported, ou si le plafond minute est atteint. La même clé renvoie le job existant.';
comment on function public.cancel_search_job(uuid) is
  'Annule un job queued ou running du compte appelant. Un job d''un autre compte est introuvable.';
