-- Réclamation d'un seul job de test. La liste des comptes autorisés
-- n'est pas writable par le navigateur. jobs_enabled n'est pas modifié.

create table if not exists private.search_test_subjects (
  user_id uuid primary key
);

revoke all on table private.search_test_subjects from public, anon, authenticated, klir_job_api, klir_job_runner;

create or replace function private.claim_authorized_test_job(p_job_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing public.search_jobs;
  eligible boolean;
begin
  if p_job_id is null then
    raise exception 'cible_invalide' using errcode = '22023';
  end if;

  select job.*
    into existing
  from public.search_jobs as job
  where job.id = p_job_id
  for update;
  if not found then
    raise exception 'job_not_found' using errcode = '42501';
  end if;
  if not exists (
    select 1
    from private.search_test_subjects as subject
    where subject.user_id = existing.user_id
  ) then
    raise exception 'job_non_autorise' using errcode = '42501';
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

revoke all on function private.claim_authorized_test_job(uuid) from public, anon, authenticated, klir_job_api;
grant execute on function private.claim_authorized_test_job(uuid) to klir_job_runner;

comment on table private.search_test_subjects is
  'Comptes dont un job peut être réclamé par identifiant. Écriture réservée au propriétaire des migrations.';
comment on function private.claim_authorized_test_job(uuid) is
  'Réclame uniquement ce job, et seulement si son compte est dans private.search_test_subjects. Ne parcourt pas la file.';
