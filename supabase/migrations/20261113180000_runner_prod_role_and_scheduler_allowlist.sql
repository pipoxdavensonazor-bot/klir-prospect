-- Exploitation Prod de la file de recherche (feu vert Philippe, 13 nov., cartes pt93s712 / pt93s719).
-- 1. Rôle de connexion runner Prod klir_job_runner_prod : LOGIN, NOINHERIT, membre de
--    klir_job_runner seulement, aucun droit de table ni de facturation. AUCUN mot de passe
--    ici : il est posé à part (SCRAM) sur le projet qui l'utilise. Sans mot de passe, le rôle
--    ne peut pas s'authentifier (cas du projet Test, qui garde klir_job_connect_test).
-- 2. private.diagnose_search_job_connection() : requise par le runner ; définie ici aussi
--    parce que la Prod n'applique pas 20261107233000_search_job_connect_test.
-- 3. Planificateur : le refus codé en dur de l'URL Prod devient une liste blanche des deux
--    runners (Test, Prod). Rien n'est appelé tant que enabled=false ou jobs_enabled=false.
-- Ne touche ni jobs_enabled, ni soldes, ni reçus, ni configuration du planificateur.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'klir_job_runner_prod') then
    create role klir_job_runner_prod login noinherit nosuperuser nocreatedb nocreaterole nobypassrls noreplication;
  else
    alter role klir_job_runner_prod login noinherit nosuperuser nocreatedb nocreaterole nobypassrls noreplication;
  end if;
end
$$;

grant klir_job_runner to klir_job_runner_prod;

do $$
begin
  if current_database() = 'postgres' then
    grant connect on database postgres to klir_job_runner_prod;
  end if;
end
$$;

revoke all on all tables in schema public from klir_job_runner_prod;
revoke all on all tables in schema private from klir_job_runner_prod;
revoke all on all sequences in schema public from klir_job_runner_prod;
revoke all on function public.reserve_usage(text, integer, text) from klir_job_runner_prod;
revoke all on function public.settle_usage(text, text) from klir_job_runner_prod;
revoke all on function public.enqueue_search_job(text, jsonb) from klir_job_runner_prod;
revoke all on function public.cancel_search_job(uuid) from klir_job_runner_prod;

comment on role klir_job_runner_prod is
  'Connexion runner Prod. LOGIN sans secret dans le dépôt (SCRAM posé à part). NOINHERIT. Membre de klir_job_runner seulement.';

create or replace function private.diagnose_search_job_connection()
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

revoke all on function private.diagnose_search_job_connection() from PUBLIC, anon, authenticated;
grant execute on function private.diagnose_search_job_connection() to klir_job_runner;

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
  -- Libère les réservations expirées même moteur éteint (pur SQL, aucun appel HTTP) :
  -- sans cela, une recherche jamais réclamée garde ses crédits bloqués
  -- jusqu'au prochain cycle du runner, qui n'a lieu que si jobs_enabled.
  perform private.expire_due_search_jobs();

  select s.* into cfg
  from private.search_scheduler_settings as s
  where s.singleton
  for update;

  if not found or not cfg.enabled or cfg.runner_url is null or cfg.gateway_key is null then
    return 'inactif';
  end if;
  -- Liste blanche : seulement le runner de l'un des deux projets KlirProspect.
  if cfg.runner_url not in (
    'https://pwakjxjjxswdjsapsbxn.supabase.co/functions/v1/search-job-runner',
    'https://cbklwmjudobqwbkbxqgy.supabase.co/functions/v1/search-job-runner'
  ) then
    outcome := 'projet_refuse';
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
  foreach r in array array['klir_job_api', 'klir_job_runner', 'klir_job_connect_test', 'klir_job_runner_prod'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on function private.search_scheduler_tick() from %I', r);
    end if;
  end loop;
end
$$;

comment on function private.search_scheduler_tick() is
  'Planificateur : libère d''abord les réservations expirées (SQL seul), puis au plus un appel pg_net vers le search-job-runner d''un projet de la liste blanche, seulement si enabled, jobs_enabled et une recherche ouverte attend.';
