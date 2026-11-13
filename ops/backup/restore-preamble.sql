-- Prépare une base PostgreSQL 17 locale VIDE à recevoir un dump KlirProspect.
do $$
begin
  if exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
             where c.relkind = 'r' and n.nspname in ('public','private','auth')) then
    raise exception 'restore-preamble: base cible non vide, arrêt';
  end if;
end $$;
-- Rôles Supabase et rôles applicatifs recréés NOLOGIN (aucun mot de passe).
do $$
declare r text;
begin
  foreach r in array array['anon','authenticated','service_role','authenticator','supabase_admin',
    'supabase_auth_admin','supabase_storage_admin','supabase_realtime_admin','supabase_replication_admin',
    'supabase_read_only_user','supabase_etl_admin','dashboard_user','pgbouncer',
    'klir_job_api','klir_job_runner','klir_job_connect_test']
  loop
    if not exists (select 1 from pg_roles where rolname = r) then
      execute format('create role %I nologin', r);
    end if;
  end loop;
end $$;
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists "uuid-ossp" with schema extensions;
