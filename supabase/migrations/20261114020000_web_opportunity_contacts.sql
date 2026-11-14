-- Signaux « opportunité web » (feu vert Philippe t120u, 13 nov. 2026).
-- Le catalogue garde le premier site web et le premier téléphone publiés par
-- Overture (2026-10-21.0) dans private.search_catalog_contacts ; les signaux et le score sont calculés à l'affichage
-- (src/web-signals.js), sans colonne jsonb ni copie lourde.
-- Aucun coût en crédits ajouté. jobs_enabled n'est pas modifié.

-- Table à part (insertions seules, pas de réécriture des 80 000 lignes du
-- catalogue) : seules les fiches avec un site ou un téléphone y figurent.
create table if not exists private.search_catalog_contacts (
  city_key text not null,
  id text not null,
  website text,
  phone text,
  primary key (city_key, id),
  constraint search_catalog_contacts_place_fk
    foreign key (city_key, id) references private.search_catalog_places (city_key, id) on delete cascade,
  constraint search_catalog_contacts_website_chk
    check (website is null or (length(website) <= 300 and website ~* '^https?://')),
  constraint search_catalog_contacts_phone_chk
    check (phone is null or length(phone) <= 40),
  constraint search_catalog_contacts_some_chk
    check (website is not null or phone is not null)
);

comment on table private.search_catalog_contacts is
  'Premier site web et premier téléphone publiés par Overture 2026-10-21.0, par lieu du catalogue. Lecture runner seulement, via fonction bornée.';

revoke all on table private.search_catalog_contacts
  from public, anon, authenticated, klir_job_api, klir_job_runner;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'klir_job_connect_test') then
    execute 'revoke all on table private.search_catalog_contacts from klir_job_connect_test';
  end if;
end
$$;
alter table private.search_catalog_contacts enable row level security;
alter table private.search_catalog_contacts force row level security;

create or replace function private.search_catalog_lookup_contacts(
  p_city_key text,
  p_industry text,
  p_quantity integer
)
returns table (
  gers_id text,
  name text,
  basic_category text,
  licenses jsonb,
  release text,
  website text,
  phone text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit integer;
  v_tokens text[];
  v_industry text;
begin
  if p_city_key is null
     or p_city_key not in ('montréal', 'laval', 'québec', 'toronto', 'paris', 'lyon', 'marseille') then
    return;
  end if;
  v_limit := least(40, greatest(0, coalesce(p_quantity, 10)));
  if v_limit = 0 then
    return;
  end if;
  v_industry := coalesce(p_industry, 'all');
  v_tokens := private.search_catalog_industry_tokens(v_industry);
  return query
  select p.id, p.name, p.basic_category, to_jsonb(p.licenses), p.release, c.website, c.phone
  from private.search_catalog_places p
  left join private.search_catalog_contacts c on c.city_key = p.city_key and c.id = p.id
  where p.city_key = p_city_key
    and (
      v_industry = 'all'
      or (v_tokens is not null and cardinality(v_tokens) > 0 and p.category_tokens && v_tokens)
    )
  order by p.id
  limit v_limit;
end;
$$;

revoke all on function private.search_catalog_lookup_contacts(text, text, integer)
  from public, anon, authenticated, klir_job_api;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'klir_job_connect_test') then
    execute 'revoke all on function private.search_catalog_lookup_contacts(text, text, integer) from klir_job_connect_test';
  end if;
end
$$;
grant execute on function private.search_catalog_lookup_contacts(text, text, integer) to klir_job_runner;

comment on function private.search_catalog_lookup_contacts(text, text, integer) is
  'Comme search_catalog_lookup, avec le site web et le téléphone publiés. Plafond 40.';

-- Fiches de résultats du propriétaire : contact_fields=true marque les fiches
-- dont le site et le téléphone ont été lus (les anciennes restent « inconnu »).
alter table public.search_job_places
  add column if not exists website text,
  add column if not exists phone text,
  add column if not exists contact_fields boolean not null default false;

alter table public.search_job_places
  drop constraint if exists search_job_places_website_chk,
  add constraint search_job_places_website_chk
    check (website is null or (length(website) <= 300 and website ~* '^https?://')),
  drop constraint if exists search_job_places_phone_chk,
  add constraint search_job_places_phone_chk
    check (phone is null or length(phone) <= 40);

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
  v_website text;
  v_phone text;
  v_contacts boolean;
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
    v_contacts := coalesce((item ->> 'contactFields')::boolean, false);
    v_website := nullif(btrim(coalesce(item ->> 'website', '')), '');
    if v_website is not null and (length(v_website) > 300 or v_website !~* '^https?://') then
      v_website := null;
    end if;
    v_phone := nullif(left(btrim(coalesce(item ->> 'phone', '')), 40), '');
    insert into public.search_job_places (job_id, user_id, name, basic_category, release, contacts_verified, website, phone, contact_fields)
    values (
      existing.id,
      existing.user_id,
      place_name,
      left(btrim(coalesce(item ->> 'basicCategory', '')), 80),
      left(btrim(coalesce(item ->> 'release', '')), 40),
      false,
      v_website,
      v_phone,
      v_contacts
    );
    inserted := inserted + 1;
  end loop;

  return jsonb_build_object('recorded', inserted, 'replayed', false);
end;
$$;

revoke all on function private.record_search_places(uuid, jsonb) from public, anon, authenticated;
grant execute on function private.record_search_places(uuid, jsonb) to klir_job_runner;
