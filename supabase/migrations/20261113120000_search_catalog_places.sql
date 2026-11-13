-- Catalogue ligne par ligne, lu seulement par le rôle du runner via une
-- fonction bornée (LIMIT). Aucun agrégat du document jsonb.
-- jobs_enabled n'est pas modifié. Aucun droit pour anon, authenticated ou PUBLIC.

create table if not exists private.search_catalog_places (
  city_key text not null,
  id text not null,
  name text not null,
  basic_category text not null default '',
  category_tokens text[] not null default '{}',
  locality text not null default '',
  country text not null default '',
  latitude double precision not null,
  longitude double precision not null,
  sources jsonb not null default '[]'::jsonb,
  licenses text[] not null default '{}',
  release text not null,
  primary key (city_key, id),
  constraint search_catalog_places_city_chk
    check (city_key in ('montréal', 'laval', 'québec', 'toronto', 'paris', 'lyon')),
  constraint search_catalog_places_release_chk
    check (release = '2026-10-21.0'),
  constraint search_catalog_places_lat_chk
    check (latitude >= -90 and latitude <= 90),
  constraint search_catalog_places_lon_chk
    check (longitude >= -180 and longitude <= 180)
);

create index if not exists search_catalog_places_city_category_idx
  on private.search_catalog_places (city_key, basic_category);

create index if not exists search_catalog_places_category_tokens_idx
  on private.search_catalog_places using gin (category_tokens);

comment on table private.search_catalog_places is
  'Fiches Overture Places des six centres, une ligne par lieu. Lecture runner seulement.';

revoke all on table private.search_catalog_places
  from public, anon, authenticated, klir_job_api, klir_job_runner;
-- Rôle de connexion Test absent en Prod : révocation seulement s'il existe.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'klir_job_connect_test') then
    execute 'revoke all on table private.search_catalog_places from klir_job_connect_test';
  end if;
end
$$;

alter table private.search_catalog_places enable row level security;
alter table private.search_catalog_places force row level security;

create or replace function private.search_catalog_industry_tokens(p_industry text)
returns text[]
language sql
immutable
security definer
set search_path = ''
as $$
  select case p_industry
    when 'restauration' then array[
      'food_and_drink', 'restaurant', 'casual_eatery', 'cafe', 'coffee_shop', 'bar',
      'pub', 'bakery', 'fast_food_restaurant', 'pizzeria', 'dessert_shop',
      'ice_cream_shop', 'meal_takeaway', 'tea_room', 'bistro', 'brasserie'
    ]::text[]
    when 'construction' then array[
      'building_or_construction_service', 'contractor', 'general_contractor',
      'plumbing', 'electrician', 'roofing', 'painting', 'masonry_contractor',
      'flooring_contractor', 'carpentry', 'construction', 'hvac'
    ]::text[]
    when 'commerce' then array[
      'shopping', 'fashion_and_apparel_store', 'grocery_store', 'food_and_beverage_store',
      'electronics_store', 'hardware_home_and_garden_store', 'specialty_store',
      'shopping_mall', 'books_music_and_video_store', 'convenience_store',
      'supermarket', 'flowers_and_gifts_store', 'sporting_goods_store',
      'department_store'
    ]::text[]
    when 'immobilier' then array['real_estate_service', 'real_estate', 'property_management']::text[]
    when 'sante' then array[
      'health_care', 'outpatient_care_facility', 'dental_clinic', 'dentist',
      'general_dentistry', 'physician', 'pharmacy', 'hospital', 'physical_therapy',
      'primary_care_or_general_clinic', 'wellness_service'
    ]::text[]
    when 'technologie' then array['technical_service', 'software', 'it_service', 'computer_service', 'web_service']::text[]
    when 'finance' then array['financial_service', 'bank_or_credit_union', 'insurance', 'accounting', 'investment_service']::text[]
    when 'services' then array[
      'professional_service', 'attorney_or_law_firm', 'home_service',
      'design_service', 'event_or_party_service', 'legal_service'
    ]::text[]
    when 'all' then null
    else array[]::text[]
  end
$$;

revoke all on function private.search_catalog_industry_tokens(text)
  from public, anon, authenticated, klir_job_api, klir_job_runner;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'klir_job_connect_test') then
    execute 'revoke all on function private.search_catalog_industry_tokens(text) from klir_job_connect_test';
  end if;
end
$$;

create or replace function private.search_catalog_lookup(
  p_city_key text,
  p_industry text,
  p_quantity integer
)
returns table (
  gers_id text,
  name text,
  basic_category text,
  licenses jsonb,
  release text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit integer;
  v_tokens text[];
  v_has_catalog boolean;
  v_industry text;
begin
  if p_city_key is null
     or p_city_key not in ('montréal', 'laval', 'québec', 'toronto', 'paris', 'lyon') then
    return;
  end if;
  v_limit := least(40, greatest(0, coalesce(p_quantity, 10)));
  if v_limit = 0 then
    return;
  end if;
  v_industry := coalesce(p_industry, 'all');
  v_tokens := private.search_catalog_industry_tokens(v_industry);

  select exists (select 1 from private.search_catalog_places limit 1) into v_has_catalog;

  if v_has_catalog then
    return query
    select
      p.id,
      p.name,
      p.basic_category,
      to_jsonb(p.licenses),
      p.release
    from private.search_catalog_places p
    where p.city_key = p_city_key
      and (
        v_industry = 'all'
        or (v_tokens is not null and cardinality(v_tokens) > 0 and p.category_tokens && v_tokens)
      )
    order by p.id
    limit v_limit;
    return;
  end if;

  -- Repli : une seule ville, LIMIT, jamais d'agrégat du document entier.
  return query
  with city as (
    select elem as doc
    from private.search_pilot_snapshot s
    cross join lateral jsonb_array_elements(coalesce(s.document->'cities', '[]'::jsonb)) elem
    where s.singleton is true
      and elem->>'key' = p_city_key
    limit 1
  ),
  feats as (
    select feat
    from city
    cross join lateral jsonb_array_elements(coalesce(city.doc->'features', '[]'::jsonb)) feat
    limit 80
  )
  select
    feat->>'id',
    coalesce(feat #>> '{properties,names,primary}', ''),
    coalesce(
      feat #>> '{properties,basic_category}',
      feat #>> '{properties,taxonomy,primary}',
      ''
    ),
    coalesce((
      select jsonb_agg(distinct lic)
      from (
        select src->>'license' as lic
        from jsonb_array_elements(coalesce(feat->'properties'->'sources', '[]'::jsonb)) src
        where src->>'license' is not null and src->>'license' <> ''
      ) licenses
    ), '[]'::jsonb),
    coalesce(nullif(feat #>> '{properties,release}', ''), '2026-10-21.0')
  from feats
  where feat->>'id' is not null
    and coalesce(feat #>> '{properties,names,primary}', '') <> ''
    and (
      v_industry = 'all'
      or (
        cardinality(v_tokens) > 0
        and (
          coalesce(feat #>> '{properties,basic_category}', '') = any (v_tokens)
          or coalesce(feat #>> '{properties,taxonomy,primary}', '') = any (v_tokens)
          or exists (
            select 1
            from jsonb_array_elements_text(coalesce(feat #> '{properties,taxonomy,hierarchy}', '[]'::jsonb)) token
            where token = any (v_tokens)
          )
        )
      )
    )
  order by feat->>'id'
  limit v_limit;
end;
$$;

revoke all on function private.search_catalog_lookup(text, text, integer)
  from public, anon, authenticated, klir_job_api;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'klir_job_connect_test') then
    execute 'revoke all on function private.search_catalog_lookup(text, text, integer) from klir_job_connect_test';
  end if;
end
$$;
grant execute on function private.search_catalog_lookup(text, text, integer) to klir_job_runner;

comment on function private.search_catalog_lookup(text, text, integer) is
  'Lecture bornée (plafond 40) du catalogue. Si la table est vide, repli sur une ville de l''instantané sonde, sans agrégat.';
