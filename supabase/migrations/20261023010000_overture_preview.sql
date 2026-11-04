-- Dormant by default. Enable only on the dedicated test project after import.
create table private.overture_settings (
  singleton boolean primary key default true check(singleton),
  enabled boolean not null default false,
  release text not null default '2026-10-21.0',
  complete boolean not null default false,
  imported_at timestamptz,
  expected_count integer not null default 25127
);
insert into private.overture_settings(singleton) values(true);
create table private.overture_places (
  release text not null,
  city text not null check(city in ('montreal','laval','quebec')),
  id text not null,
  lat double precision not null check(lat between -90 and 90),
  lon double precision not null check(lon between -180 and 180),
  sectors text[] not null,
  duplicate_key text not null,
  original jsonb not null,
  primary key(release,city,id)
);
create index overture_place_city_sector on private.overture_places(release,city);
create index overture_place_sectors on private.overture_places using gin(sectors);
create index overture_place_coordinates on private.overture_places(city,lat,lon);
create table private.overture_review (
  id text primary key, status text not null check(status in ('exclude','review')),
  reason text not null, evidence jsonb not null default '[]', reviewed_at timestamptz not null default now()
);
insert into private.overture_review(id,status,reason) values
('f7d4ae7d-7c80-45d2-bdcd-3722a8be2cc6','exclude','Point à Québec, adresse publiée à Gatineau : conflit confirmé non résolu'),
('934cc21c-f9d0-476a-9f15-5edf3dc36af8','review','Identité/activité actuelle non résolue'),
('e6c900ee-da6e-4898-be59-73a20413e046','review','Autre marque à la même adresse : ne pas fusionner');
create table private.overture_cache (
  key text primary key, features jsonb not null, created_at timestamptz not null default now()
);
create table public.overture_operations (
  user_id uuid not null references auth.users(id) on delete cascade,
  receipt text not null,
  city text not null, sector text not null, quantity integer not null,
  release text not null, amount integer not null,
  status text not null check(status in ('reserved','complete','released')),
  created_at timestamptz not null default now(), expires_at timestamptz not null,
  result jsonb, primary key(user_id,receipt),
  foreign key(user_id,receipt) references public.usage_holds(user_id,receipt) on delete cascade
);
create index overture_operations_expiry on public.overture_operations(user_id,expires_at) where status='reserved';
alter table public.overture_operations enable row level security;
alter table public.overture_operations force row level security;
revoke all on public.overture_operations from public,anon,authenticated;
grant select on public.overture_operations to authenticated;
create policy overture_operations_own on public.overture_operations for select to authenticated using(user_id=(select auth.uid()));
revoke all on all tables in schema private from public,anon,authenticated;
alter table private.overture_settings enable row level security;
alter table private.overture_settings force row level security;
alter table private.overture_places enable row level security;
alter table private.overture_places force row level security;
alter table private.overture_review enable row level security;
alter table private.overture_review force row level security;
alter table private.overture_cache enable row level security;
alter table private.overture_cache force row level security;

create function private.overture_expire(uid uuid) returns void language plpgsql security definer set search_path='' as $$
declare refund integer;
begin
  -- Every path takes account lock before operation/hold locks.
  perform 1 from public.credit_accounts where user_id=uid for update;
  with expired as (
    update public.overture_operations set status='released',result=jsonb_build_object('state','error','reason','reservation_expired','features','[]'::jsonb)
    where user_id=uid and status='reserved' and expires_at<=clock_timestamp() returning receipt,amount
  ), released as (
    update public.usage_holds h set status='released' from expired e
    where h.user_id=uid and h.receipt=e.receipt and h.status='open' returning e.amount
  ) select coalesce(sum(amount),0) into refund from released;
  update public.credit_accounts set balance=balance+refund where user_id=uid and refund>0;
end $$;
revoke all on function private.overture_expire(uuid) from public,anon,authenticated;

create function public.overture_account() returns jsonb language plpgsql security definer set search_path='' as $$
begin
  if auth.uid() is null then raise exception 'session_requise'; end if;
  perform private.overture_expire(auth.uid());
  return public.read_credit_account();
end $$;

create function public.overture_begin(p_receipt text,p_city text,p_sector text,p_quantity integer)
returns jsonb language plpgsql security definer set search_path='' set statement_timeout='3s' set lock_timeout='2s' as $$
declare uid uuid:=auth.uid(); cfg private.overture_settings%rowtype; op public.overture_operations%rowtype;
  acc public.credit_accounts%rowtype; cost integer; active integer;
begin
  if uid is null then raise exception 'session_requise'; end if;
  select * into cfg from private.overture_settings where singleton;
  if not cfg.enabled then raise exception 'pilote_desactive'; end if;
  if p_receipt is null or p_receipt !~ '^debit_[0-9a-f]{24}$' then raise exception 'recu_invalide'; end if;
  if p_city is null or p_city not in ('montreal','laval','quebec') or p_sector is null or p_sector not in ('restauration','construction','sante')
    or p_quantity is null or p_quantity<1 or p_quantity>40 then raise exception 'perimetre_invalide'; end if;
  perform public.read_credit_account();
  perform private.overture_expire(uid);
  select * into acc from public.credit_accounts where user_id=uid for update;
  select * into op from public.overture_operations where user_id=uid and receipt=p_receipt;
  if found then
    if op.city<>p_city or op.sector<>p_sector or op.quantity<>p_quantity then raise exception 'recu_parametres_differents'; end if;
    return jsonb_build_object('status',op.status,'amount',op.amount,'balance',acc.balance,'searches_used',acc.searches_used);
  end if;
  cost:=5+ceil(p_quantity/10.0)::integer;
  select count(*) into active from public.usage_holds where user_id=uid and status='open';
  if acc.searches_used+active>=10 then raise exception 'quota_mensuel'; end if;
  if acc.balance<cost then raise exception 'credits_insuffisants'; end if;
  insert into public.usage_holds(user_id,receipt,amount,label) values(uid,p_receipt,cost,'Recherche');
  insert into public.overture_operations(user_id,receipt,city,sector,quantity,release,amount,status,expires_at)
    values(uid,p_receipt,p_city,p_sector,p_quantity,cfg.release,cost,'reserved',clock_timestamp()+interval '60 seconds');
  update public.credit_accounts set balance=balance-cost where user_id=uid returning * into acc;
  return jsonb_build_object('status','reserved','amount',cost,'balance',acc.balance,'searches_used',acc.searches_used);
end $$;

create function public.overture_execute(p_receipt text) returns jsonb language plpgsql security definer set search_path='' set statement_timeout='3s' set lock_timeout='2s' as $$
declare uid uuid:=auth.uid(); op public.overture_operations%rowtype; cfg private.overture_settings%rowtype;
  acc public.credit_accounts%rowtype; v_result jsonb; features jsonb; cache_at timestamptz; hit boolean:=false;
  started timestamptz:=clock_timestamp(); cache_key text; clat double precision; clon double precision;
begin
  if uid is null then raise exception 'session_requise'; end if;
  perform 1 from public.credit_accounts where user_id=uid for update;
  perform private.overture_expire(uid);
  select * into op from public.overture_operations where user_id=uid and receipt=p_receipt for update;
  if not found then raise exception 'recu_invalide'; end if;
  if op.status<>'reserved' then
    select * into acc from public.credit_accounts where user_id=uid;
    return op.result||jsonb_build_object('balance',acc.balance,'searches_used',acc.searches_used,'replayed',true);
  end if;
  begin
    select * into cfg from private.overture_settings where singleton;
    if not cfg.enabled or cfg.release<>op.release or cfg.imported_at is null then raise exception 'catalogue_indisponible'; end if;
    if not cfg.complete then
      v_result:=jsonb_build_object('state','partial','reason','catalogue_incomplet','features','[]'::jsonb);
    else
      cache_key:=concat_ws(':',op.release,cfg.imported_at::text,op.city,op.sector,op.quantity,'policy1');
      select c.features,c.created_at into features,cache_at from private.overture_cache c where c.key=cache_key and c.created_at>clock_timestamp()-interval '10 minutes';
      hit:=found;
      if not hit then
        select lat,lon into clat,clon from (values ('montreal',45.5017,-73.5673),('laval',45.6066,-73.7124),('quebec',46.8139,-71.208)) as centres(city,lat,lon) where city=op.city;
        with bounded as (
          select p.*,6371008.8*2*asin(least(1.0,sqrt(power(sin(radians(p.lat-clat)/2),2)+cos(radians(clat))*cos(radians(p.lat))*power(sin(radians(p.lon-clon)/2),2)))) as metres
          from private.overture_places p where p.release=op.release and p.city=op.city and p.sectors @> array[op.sector]
            and p.lat between clat-0.021 and clat+0.021 and p.lon between clon-0.031 and clon+0.031
            and not exists(select 1 from private.overture_review r where r.id=p.id and r.status='exclude')
        ), ranked as (
          select *,row_number() over(partition by duplicate_key order by metres,id) as duplicate_rank from bounded where metres<=2200
        ), limited as (
          select original,id,metres from ranked where duplicate_rank=1 order by metres,id limit op.quantity
        ) select coalesce(jsonb_agg(jsonb_build_object('feature',l.original,'review',coalesce((select jsonb_build_object('status',r.status,'reason',r.reason) from private.overture_review r where r.id=l.id),'null'::jsonb)) order by l.metres,l.id),'[]'::jsonb) into features from limited l;
        cache_at:=clock_timestamp();
        insert into private.overture_cache(key,features,created_at) values(cache_key,features,cache_at)
          on conflict(key) do update set features=excluded.features,created_at=excluded.created_at;
      end if;
      v_result:=jsonb_build_object('state',case when jsonb_array_length(features)>0 then 'complete' else 'valid_empty' end,
        'features',features,'release',op.release,'catalogue_at',cfg.imported_at,'cache_at',cache_at,'cache_hit',hit,'maximum',op.quantity,'radius_m',2200);
    end if;
  exception when query_canceled or others then
    v_result:=jsonb_build_object('state','error','reason','collecte_echouee','features','[]'::jsonb);
  end;
  if v_result->>'state'='complete' then
    update public.usage_holds set status='complete' where user_id=uid and receipt=p_receipt;
    insert into public.credit_receipts(user_id,receipt,amount,label) values(uid,p_receipt,op.amount,'Recherche');
    update public.credit_accounts set searches_used=searches_used+1 where user_id=uid;
    update public.overture_operations set status='complete' where user_id=uid and receipt=p_receipt;
  else
    update public.usage_holds set status='released' where user_id=uid and receipt=p_receipt;
    update public.credit_accounts set balance=balance+op.amount where user_id=uid;
    update public.overture_operations set status='released' where user_id=uid and receipt=p_receipt;
  end if;
  select * into acc from public.credit_accounts where user_id=uid;
  v_result:=v_result||jsonb_build_object('balance',acc.balance,'searches_used',acc.searches_used,'charged',case when v_result->>'state'='complete' then op.amount else 0 end,
    'server_ms',extract(epoch from clock_timestamp()-started)*1000,'receipt',p_receipt);
  update public.overture_operations set result=v_result where user_id=uid and receipt=p_receipt;
  return v_result;
end $$;

-- Import/admin entry points are never available to the browser roles.
create function public.overture_import(p_city text,p_release text,p_rows jsonb) returns integer language plpgsql security definer set search_path='' set statement_timeout='15s' as $$
declare n integer;
begin
  if p_city not in ('montreal','laval','quebec') or p_release<>'2026-10-21.0' or jsonb_array_length(p_rows)>250 then raise exception 'import_invalide'; end if;
  if (select enabled from private.overture_settings where singleton) then raise exception 'desactiver_avant_import'; end if;
  insert into private.overture_places(release,city,id,lat,lon,sectors,duplicate_key,original)
  select p_release,p_city,j->'original'->>'id',(j->'original'->'geometry'->'coordinates'->>1)::double precision,
    (j->'original'->'geometry'->'coordinates'->>0)::double precision,array(select jsonb_array_elements_text(j->'sectors')),j->>'duplicate_key',j->'original'
  from jsonb_array_elements(p_rows) j on conflict(release,city,id) do nothing;
  get diagnostics n=row_count; return n;
end $$;
create function public.overture_admin(p_action text,p_payload jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare n integer; bytes bigint;
begin
  if p_action='finalize' then
    select count(*) into n from private.overture_places where release='2026-10-21.0';
    if n<>25127 or (select count(distinct city) from private.overture_places)<>3 then raise exception 'import_incomplet'; end if;
    update private.overture_settings set complete=true,imported_at=clock_timestamp() where singleton;
    analyze private.overture_places;
  elsif p_action='enable' then
    if not (select complete from private.overture_settings where singleton) then raise exception 'import_incomplet'; end if;
    update private.overture_settings set enabled=true where singleton;
    revoke execute on function public.reserve_usage(text,integer,text),public.settle_usage(text,text) from authenticated;
  elsif p_action='disable' then
    update private.overture_settings set enabled=false where singleton;
    grant execute on function public.reserve_usage(text,integer,text),public.settle_usage(text,text) to authenticated;
  elsif p_action='clear_cache' then
    delete from private.overture_cache;
  elsif p_action<>'metrics' then raise exception 'action_invalide'; end if;
  return jsonb_build_object('database_bytes',pg_database_size(current_database()),'catalogue_bytes',pg_total_relation_size('private.overture_places'),
    'cache_bytes',pg_total_relation_size('private.overture_cache'),'operations_bytes',pg_total_relation_size('public.overture_operations'),
    'rows',(select count(*) from private.overture_places),'settings',(select to_jsonb(s) from private.overture_settings s));
end $$;
revoke all on function public.overture_import(text,text,jsonb),public.overture_admin(text,jsonb) from public,anon,authenticated;
grant execute on function public.overture_import(text,text,jsonb),public.overture_admin(text,jsonb) to service_role;
revoke all on function public.overture_begin(text,text,text,integer),public.overture_execute(text),public.overture_account() from public,anon;
grant execute on function public.overture_begin(text,text,text,integer),public.overture_execute(text),public.overture_account() to authenticated;
