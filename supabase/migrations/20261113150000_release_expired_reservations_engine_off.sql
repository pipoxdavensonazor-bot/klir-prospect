-- Correctif proposé (NON appliqué) : libération des réservations expirées moteur éteint.
-- Constat Test du 13 nov. : deux recherches du 8 nov. (9 + 9 crédits) sont restées
-- queued/open bien après reserved_until, car private.expire_due_search_jobs() n'est
-- appelée que par le runner, qui ne tourne que moteur allumé.
-- Ce correctif l'appelle aussi à chaque tick pg_cron (chaque minute), avant toute garde.
-- Ne touche ni jobs_enabled, ni secret, ni configuration ; aucun appel réseau ajouté.

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
  'Planificateur : libère d''abord les réservations expirées (SQL seul), puis au plus un appel pg_net vers search-job-runner par intervalle, seulement si jobs_enabled et une recherche ouverte attend.';
