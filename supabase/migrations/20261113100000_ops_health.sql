-- Surveillance : un seul point de lecture agrégé, sans donnée personnelle.
-- Lecture seule (STABLE, aucun INSERT/UPDATE), appelable par la clé anon publique
-- pour qu'un job GitHub Actions planifié puisse le lire sans secret serveur.
-- Retourne uniquement des booléens, des compteurs et des horodatages.

create or replace function public.klir_ops_health()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  result jsonb;
  sched_enabled boolean;
  sched_last timestamptz;
  sched_outcome text;
  http_errors integer;
begin
  -- Planificateur : optionnel (migration 20261113090000), lu seulement s'il existe.
  if pg_catalog.to_regclass('private.search_scheduler_settings') is not null then
    execute 'select enabled, last_called_at from private.search_scheduler_settings limit 1'
      into sched_enabled, sched_last;
    execute 'select outcome from private.search_scheduler_runs order by ran_at desc limit 1'
      into sched_outcome;
  end if;

  -- Réponses HTTP non 2xx du runner appelé par pg_net (rétention pg_net ~6 h).
  if pg_catalog.to_regclass('net._http_response') is not null then
    execute $q$
      select count(*)::int from net._http_response
      where created > pg_catalog.now() - interval '1 hour'
        and (status_code is null or status_code not between 200 and 299)
    $q$ into http_errors;
  end if;

  select pg_catalog.jsonb_build_object(
    'checked_at', pg_catalog.now(),
    'jobs_enabled', (select s.jobs_enabled from private.search_job_settings s limit 1),
    'queued_over_15m', (select count(*)::int from public.search_jobs j
        where j.status = 'queued' and j.created_at < pg_catalog.now() - interval '15 minutes'),
    'running_over_15m', (select count(*)::int from public.search_jobs j
        where j.status = 'running' and j.updated_at < pg_catalog.now() - interval '15 minutes'),
    'open_reservations_expired', (select count(*)::int from public.search_jobs j
        where j.ledger_status = 'open' and j.reserved_until < pg_catalog.now()),
    'scheduler_enabled', sched_enabled,
    'scheduler_last_call', sched_last,
    'scheduler_last_outcome', sched_outcome,
    'runner_http_errors_1h', http_errors
  ) into result;
  return result;
end;
$$;

revoke all on function public.klir_ops_health() from public;
grant execute on function public.klir_ops_health() to anon, authenticated, service_role;

comment on function public.klir_ops_health() is
  'Surveillance lecture seule : compteurs agrégés (jobs bloqués, réservations échues, planificateur). Aucune donnée personnelle.';
