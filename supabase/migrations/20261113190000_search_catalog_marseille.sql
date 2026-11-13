-- Ajout de Marseille au catalogue (feu vert t106u « Marseille »).
-- Élargit la liste blanche des villes de private.search_catalog_places et de
-- private.search_catalog_lookup. Les six villes existantes ne changent pas.
-- Aucune ligne écrite ici : le chargement des fiches se fait à part, par lots.
-- Ne touche ni jobs_enabled, ni crédits, ni prix.

alter table private.search_catalog_places
  drop constraint if exists search_catalog_places_city_chk;
alter table private.search_catalog_places
  add constraint search_catalog_places_city_chk
    check (city_key in ('montréal', 'laval', 'québec', 'toronto', 'paris', 'lyon', 'marseille'));

comment on table private.search_catalog_places is
  'Fiches Overture Places des sept centres (six d''origine + Marseille), une ligne par lieu. Lecture runner seulement.';

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
     or p_city_key not in ('montréal', 'laval', 'québec', 'toronto', 'paris', 'lyon', 'marseille') then
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
