-- Planificateur des recherches (projet Test d'abord).
-- pg_cron appelle chaque minute private.search_scheduler_tick(). La fonction
-- n'émet un appel HTTP (pg_net) vers search-job-runner que si :
--   * le planificateur est explicitement activé et configuré (désactivé par défaut) ;
--   * private.search_job_settings.jobs_enabled est vrai ;
--   * le dernier appel date d'au moins min_interval_seconds (débit borné) ;
--   * une recherche ouverte attend (file ou réservation échue à expirer) ;
--   * le secret serveur dédié est présent dans Vault.
-- Le runner réclame au plus une recherche par appel, expire les réservations
-- échues, et revérifie jobs_enabled dans sa propre transaction.
-- Cette migration ne change pas jobs_enabled, ne pose aucun secret ni URL :
-- la configuration se fait à part, projet par projet.

create table if not exists private.search_scheduler_settings (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default false,
  runner_url text check (
    runner_url is null
    or runner_url ~ '^https://[a-z0-9]{20}\.supabase\.co/functions/v1/search-job-runner$'
  ),
  gateway_key text check (gateway_key is null or length(gateway_key) between 20 and 2048),
  min_interval_seconds integer not null default 55 check (min_interval_seconds between 30 and 3600),
  last_called_at timestamptz
);

insert into private.search_scheduler_settings (singleton) values (true)
on conflict (singleton) do nothing;

create table if not exists private.search_scheduler_runs (
  id bigint generated always as identity primary key,
  ran_at timestamptz not null default pg_catalog.now(),
  outcome text not null,
  request_id bigint
);

alter table private.search_scheduler_settings enable row level security;
alter table private.search_scheduler_settings force row level security;
alter table private.search_scheduler_runs enable row level security;
alter table private.search_scheduler_runs force row level security;

revoke all on table private.search_scheduler_settings from public, anon, authenticated;
revoke all on table private.search_scheduler_runs from public, anon, authenticated;
do $$
declare
  r text;
begin
  foreach r in array array['klir_job_api', 'klir_job_runner', 'klir_job_connect_test'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on table private.search_scheduler_settings from %I', r);
      execute format('revoke all on table private.search_scheduler_runs from %I', r);
    end if;
  end loop;
end
$$;

create or replace function private.search_scheduler_tick()
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  cfg private.search_scheduler_settings;
  enabled_flag boolean;
  secret text;
  outcome text;
  request bigint;
begin
  select s.* into cfg
  from private.search_scheduler_settings as s
  where s.singleton
  for update;

  if not found or not cfg.enabled or cfg.runner_url is null or cfg.gateway_key is null then
    return 'inactif';
  end if;
  if cfg.runner_url like '%cbklwmjudobqwbkbxqgy%' then
    outcome := 'production_refusee';
  else
    select s.jobs_enabled into enabled_flag
    from private.search_job_settings as s
    where s.singleton;
    if enabled_flag is distinct from true then
      return 'moteur_off';
    end if;
    if cfg.last_called_at is not null
       and cfg.last_called_at > pg_catalog.now() - pg_catalog.make_interval(secs => cfg.min_interval_seconds) then
      return 'debit';
    end if;
    if not exists (
      select 1
      from public.search_jobs as job
      where job.ledger_status = 'open'
        and job.status in ('queued', 'running')
    ) then
      return 'file_vide';
    end if;
    select d.decrypted_secret into secret
    from vault.decrypted_secrets as d
    where d.name = 'klir_job_scheduler_secret'
    limit 1;
    if secret is null or length(secret) < 32 then
      outcome := 'secret_absent';
    else
      select net.http_post(
        url := cfg.runner_url,
        body := jsonb_build_object('action', 'scheduled'),
        headers := jsonb_build_object(
          'content-type', 'application/json',
          'authorization', 'Bearer ' || cfg.gateway_key,
          'x-klir-scheduler', secret
        ),
        timeout_milliseconds := 25000
      ) into request;
      update private.search_scheduler_settings as s
      set last_called_at = pg_catalog.now()
      where s.singleton;
      outcome := 'appel';
    end if;
  end if;

  insert into private.search_scheduler_runs (outcome, request_id) values (outcome, request);
  delete from private.search_scheduler_runs as r where r.ran_at < pg_catalog.now() - interval '7 days';
  return outcome;
end;
$$;

revoke all on function private.search_scheduler_tick() from public, anon, authenticated;
do $$
declare
  r text;
begin
  foreach r in array array['klir_job_api', 'klir_job_runner', 'klir_job_connect_test'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on function private.search_scheduler_tick() from %I', r);
    end if;
  end loop;
end
$$;

comment on function private.search_scheduler_tick() is
  'Planificateur : au plus un appel pg_net vers search-job-runner par intervalle, seulement si jobs_enabled et une recherche ouverte attend.';

-- pg_cron et pg_net : créés seulement si la plateforme les propose (Supabase).
-- Le job cron existe toujours ; il ne fait rien tant que la configuration est inactive.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_net')
     and exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_net with schema extensions;
    create extension if not exists pg_cron with schema pg_catalog;
    perform cron.unschedule(jobid) from cron.job where jobname = 'klir-search-scheduler';
    perform cron.schedule('klir-search-scheduler', '* * * * *', 'select private.search_scheduler_tick()');
  end if;
end
$$;
