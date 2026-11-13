-- Réclamation d'un seul job de test, explicitement approuvé pour l'exercice.
-- Fichier nouveau, jamais appliqué : il peut encore être réécrit avant revue.
--
-- Garanties :
--  * seule une ligne de private.search_test_job_approvals autorise un job ;
--    l'approbation est nominative (job + propriétaire), datée et bornée à 24 h ;
--  * le navigateur ne peut ni lire ni écrire cette table (RLS forcée, aucun droit) ;
--  * la fonction ne touche que la ligne ciblée : pas de parcours de file,
--    pas d'expiration d'autres jobs, aucune écriture si le job ciblé est expiré ;
--  * seule la session de connexion Test (klir_job_connect_test -> klir_job_runner)
--    peut l'exécuter ; jobs_enabled n'est pas modifié.

create table if not exists private.search_test_job_approvals (
  job_id uuid primary key references public.search_jobs (id) on delete cascade,
  user_id uuid not null,
  exercise text not null,
  approved_at timestamptz not null default pg_catalog.now(),
  approved_until timestamptz not null,
  constraint search_test_job_approvals_exercise_check
    check (pg_catalog.length(pg_catalog.btrim(exercise)) between 3 and 80),
  constraint search_test_job_approvals_window_check
    check (approved_until > approved_at and approved_until <= approved_at + interval '24 hours')
);

alter table private.search_test_job_approvals enable row level security;
alter table private.search_test_job_approvals force row level security;

revoke all on table private.search_test_job_approvals
  from public, anon, authenticated, klir_job_api, klir_job_runner;
-- Rôle de connexion Test absent en Prod : révocation seulement s'il existe.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'klir_job_connect_test') then
    execute 'revoke all on table private.search_test_job_approvals from klir_job_connect_test';
  end if;
end
$$;

create or replace function private.claim_authorized_test_job(p_job_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  approval private.search_test_job_approvals;
  existing public.search_jobs;
  eligible boolean;
begin
  -- Seule la connexion Test du runner peut cibler un job.
  if session_user::text <> 'klir_job_connect_test'
     or not pg_catalog.pg_has_role(session_user, 'klir_job_runner', 'MEMBER') then
    raise exception 'role_non_autorise' using errcode = '42501';
  end if;

  if p_job_id is null then
    raise exception 'cible_invalide' using errcode = '22023';
  end if;

  -- L'approbation est lue avant le job : un id non approuvé ne révèle rien.
  select approval_row.*
    into approval
  from private.search_test_job_approvals as approval_row
  where approval_row.job_id = p_job_id;
  if not found then
    raise exception 'job_non_autorise' using errcode = '42501';
  end if;
  if approval.approved_until <= pg_catalog.now() then
    raise exception 'autorisation_expiree' using errcode = '42501';
  end if;

  -- Verrou sur cette seule ligne.
  select job.*
    into existing
  from public.search_jobs as job
  where job.id = p_job_id
  for update;
  if not found then
    raise exception 'job_not_found' using errcode = '42501';
  end if;
  if existing.user_id is distinct from approval.user_id then
    raise exception 'job_non_autorise' using errcode = '42501';
  end if;

  -- Un job en file dont la réservation est échue n'est ni réclamé ni expiré ici.
  -- Aucune écriture : l'expiration reste le travail du cycle normal.
  if existing.status = 'queued'
     and existing.collection_outcome is null
     and existing.reserved_until is not null
     and existing.reserved_until <= pg_catalog.now() then
    raise exception 'job_expire' using errcode = '42501';
  end if;

  eligible := existing.ledger_status = 'open'
    and (
      (
        existing.collection_outcome is null
        and (
          (
            existing.status = 'queued'
            and (existing.reserved_until is null or existing.reserved_until > pg_catalog.now())
          )
          or (
            existing.status = 'running'
            and (existing.claim_until is null or existing.claim_until < pg_catalog.now())
          )
        )
      )
      or (
        existing.status = 'running'
        and existing.collection_outcome is not null
      )
    );
  if not eligible then
    raise exception 'job_clos' using errcode = '42501';
  end if;

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
  where job.id = existing.id
  returning * into existing;

  return jsonb_build_array(jsonb_build_object(
    'id', existing.id,
    'payload', existing.payload,
    'attempt', existing.attempt,
    'status', existing.status,
    'ledger_status', existing.ledger_status,
    'collection_outcome', existing.collection_outcome,
    'result_count', existing.result_count
  ));
end;
$$;

revoke all on function private.claim_authorized_test_job(uuid)
  from PUBLIC, public, anon, authenticated, klir_job_api;
grant execute on function private.claim_authorized_test_job(uuid) to klir_job_runner;

comment on table private.search_test_job_approvals is
  'Jobs approuvés un par un pour un exercice Test (job, propriétaire, fenêtre <= 24 h). Écriture réservée au propriétaire des migrations.';
comment on function private.claim_authorized_test_job(uuid) is
  'Réclame uniquement ce job approuvé, depuis la connexion Test du runner. Ne parcourt pas la file et n''expire aucun autre job.';
