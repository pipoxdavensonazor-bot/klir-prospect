-- Connexion Test du runner. Fichier nouveau : ne pas réécrire les migrations déjà appliquées.
-- Le rôle peut ouvrir une session. Il n'a pas de mot de passe ici.
-- NOINHERIT : les droits de klir_job_runner n'existent qu'après SET LOCAL ROLE.
-- Aucun droit de table, aucun droit de facturation. jobs_enabled n'est pas modifié.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'klir_job_connect_test') then
    create role klir_job_connect_test login noinherit nosuperuser nocreatedb nocreaterole nobypassrls;
  else
    alter role klir_job_connect_test login noinherit nosuperuser nocreatedb nocreaterole nobypassrls;
  end if;
end
$$;

grant klir_job_runner to klir_job_connect_test;

do $$
begin
  if current_database() = 'postgres' then
    grant connect on database postgres to klir_job_connect_test;
  end if;
end
$$;

revoke all on all tables in schema public from klir_job_connect_test;
revoke all on all tables in schema private from klir_job_connect_test;
revoke all on all sequences in schema public from klir_job_connect_test;
revoke all on function public.reserve_usage(text, integer, text) from klir_job_connect_test;
revoke all on function public.settle_usage(text, text) from klir_job_connect_test;
revoke all on function public.enqueue_search_job(text, jsonb) from klir_job_connect_test;
revoke all on function public.cancel_search_job(uuid) from klir_job_connect_test;

-- Lecture seule du drapeau. Le rôle runner n'a pas de droit de table,
-- et search_jobs_enabled reste réservée à klir_job_api.
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

revoke all on function private.diagnose_search_job_connection() from PUBLIC, public, anon, authenticated;
grant execute on function private.diagnose_search_job_connection() to klir_job_runner;

comment on role klir_job_connect_test is
  'Connexion Test du runner. LOGIN sans secret dans le dépôt. NOINHERIT. Membre de klir_job_runner seulement.';
comment on function private.diagnose_search_job_connection() is
  'Lit seulement jobs_enabled. Réservée à klir_job_runner. Ne réclame ni ne règle aucun job.';
