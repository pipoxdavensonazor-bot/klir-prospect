-- Sonde locale des six centres, lue seulement par le rôle du runner.
-- jobs_enabled n'est pas modifié. Aucun droit pour anon, authenticated ou PUBLIC.

create table if not exists private.search_pilot_snapshot (
  singleton boolean primary key default true check (singleton),
  document jsonb not null
);

revoke all on table private.search_pilot_snapshot from public, anon, authenticated;

create or replace function private.pilot_snapshot()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select document
  from private.search_pilot_snapshot
  where singleton
$$;

revoke all on function private.pilot_snapshot() from public, anon, authenticated;
grant execute on function private.pilot_snapshot() to klir_job_runner;
