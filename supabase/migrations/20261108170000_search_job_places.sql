-- Fiches visibles par le propriétaire du job seulement.
-- jobs_enabled n'est pas modifié. Le client ne peut pas écrire ces lignes.

create table if not exists public.search_job_places (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.search_jobs (id) on delete cascade,
  user_id uuid not null,
  name text not null check (char_length(name) between 1 and 160),
  basic_category text not null default '' check (char_length(basic_category) <= 80),
  release text not null default '' check (char_length(release) <= 40),
  contacts_verified boolean not null default false check (contacts_verified = false),
  created_at timestamptz not null default now()
);

alter table public.search_job_places enable row level security;
alter table public.search_job_places force row level security;

revoke all on table public.search_job_places from public, anon, authenticated;
grant select on table public.search_job_places to authenticated;

create policy search_job_places_select_own
on public.search_job_places
for select
to authenticated
using ((select auth.uid()) = user_id);

create or replace function private.record_search_places(p_job_id uuid, p_places jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing public.search_jobs;
  item jsonb;
  inserted integer := 0;
  place_name text;
begin
  if p_places is null or jsonb_typeof(p_places) <> 'array' or jsonb_array_length(p_places) > 40 then
    raise exception 'places_invalides' using errcode = '22023';
  end if;

  select job.*
    into existing
  from public.search_jobs as job
  where job.id = p_job_id
  for update;
  if not found then
    raise exception 'job_not_found' using errcode = '42501';
  end if;
  if exists (
    select 1 from public.search_job_places as place where place.job_id = existing.id
  ) then
    return jsonb_build_object('recorded', 0, 'replayed', true);
  end if;

  for item in select value from jsonb_array_elements(p_places)
  loop
    place_name := left(btrim(coalesce(item ->> 'name', '')), 160);
    if place_name = '' then
      continue;
    end if;
    insert into public.search_job_places (job_id, user_id, name, basic_category, release, contacts_verified)
    values (
      existing.id,
      existing.user_id,
      place_name,
      left(btrim(coalesce(item ->> 'basicCategory', '')), 80),
      left(btrim(coalesce(item ->> 'release', '')), 40),
      false
    );
    inserted := inserted + 1;
  end loop;

  return jsonb_build_object('recorded', inserted, 'replayed', false);
end;
$$;

revoke all on function private.record_search_places(uuid, jsonb) from public, anon, authenticated;
grant execute on function private.record_search_places(uuid, jsonb) to klir_job_runner;
