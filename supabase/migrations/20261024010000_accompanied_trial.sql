-- Trial remains dormant on a fresh database. Enable only on dedicated Supabase Test.
alter table private.overture_settings add column trial_segment boolean not null default false;
alter table private.overture_settings add column revision text not null default 'regional-baseline';
alter table public.overture_operations add column revision text not null default 'regional-baseline';

-- Categories only; never guesses staffing, legal independence or a commercial need.
create function private.overture_target(f jsonb) returns text language sql immutable set search_path='' as $$
 select case
 when f#>>'{properties,operating_status}'='permanently_closed' then 'exclude'
 when coalesce(f#>>'{properties,basic_category}','')='' and coalesce(f#>>'{properties,taxonomy,primary}','')='' and coalesce(jsonb_array_length(f#>'{properties,taxonomy,hierarchy}'),0)=0 then 'review'
 when exists(select 1 from jsonb_array_elements_text(jsonb_build_array(f#>>'{properties,basic_category}',f#>>'{properties,taxonomy,primary}')||coalesce(f#>'{properties,taxonomy,hierarchy}','[]'::jsonb)) c where c in ('restaurant','cafe','coffee_shop','fast_food_restaurant')) then 'include'
 else 'exclude' end
$$;
revoke all on function private.overture_target(jsonb) from public,anon,authenticated;

create table private.overture_snapshots (
 revision text primary key, release text not null, imported_at timestamptz not null,
 trial_segment boolean not null, row_count integer not null, checksum text not null,
 places jsonb not null, reviews jsonb not null, created_at timestamptz not null default now()
);
alter table private.overture_snapshots enable row level security;
alter table private.overture_snapshots force row level security;
revoke all on private.overture_snapshots from public,anon,authenticated;

-- A complete immutable snapshot; no user/workspace/credit table is copied or replaced.
create function public.overture_snapshot(p_revision text) returns jsonb language plpgsql security definer set search_path='' set statement_timeout='30s' as $$
declare rows jsonb; rev jsonb; cfg private.overture_settings%rowtype;
begin
 if p_revision !~ '^[a-z0-9-]{3,60}$' then raise exception 'revision_invalide'; end if;
 perform pg_advisory_xact_lock(718423);
 select * into cfg from private.overture_settings where singleton for update;
 if not cfg.complete then raise exception 'catalogue_incomplet'; end if;
 select jsonb_agg(to_jsonb(p) order by p.city,p.id) into rows from private.overture_places p where release=cfg.release;
 select coalesce(jsonb_agg(to_jsonb(r) order by r.id),'[]'::jsonb) into rev from private.overture_review r;
 if jsonb_array_length(rows)<>cfg.expected_count then raise exception 'compte_incorrect'; end if;
 insert into private.overture_snapshots(revision,release,imported_at,trial_segment,row_count,checksum,places,reviews)
 values(p_revision,cfg.release,cfg.imported_at,cfg.trial_segment,jsonb_array_length(rows),md5(rows::text||rev::text),rows,rev);
 return jsonb_build_object('revision',p_revision,'rows',jsonb_array_length(rows),'checksum',md5(rows::text||rev::text));
end $$;

-- Transactional activation/rollback; same pinned upstream release may have a new filtering policy.
-- A staged copy is validated before replacing the index. Old receipts retain their stored results.
create function public.overture_activate(p_revision text) returns jsonb language plpgsql security definer set search_path='' set statement_timeout='30s' as $$
declare snap private.overture_snapshots%rowtype;
begin
 perform pg_advisory_xact_lock(718423);
 perform 1 from private.overture_settings where singleton for update;
 select * into snap from private.overture_snapshots where revision=p_revision;
 if not found then raise exception 'revision_inconnue'; end if;
 if snap.row_count<>jsonb_array_length(snap.places) or snap.checksum<>md5(snap.places::text||snap.reviews::text) then raise exception 'snapshot_invalide'; end if;
 delete from private.overture_places;
 insert into private.overture_places select * from jsonb_populate_recordset(null::private.overture_places,snap.places);
 delete from private.overture_review;
 insert into private.overture_review select * from jsonb_populate_recordset(null::private.overture_review,snap.reviews);
 update private.overture_settings set revision=snap.revision,release=snap.release,imported_at=snap.imported_at,trial_segment=snap.trial_segment,complete=true where singleton;
 delete from private.overture_cache;
 return jsonb_build_object('revision',snap.revision,'rows',snap.row_count,'checksum',snap.checksum);
end $$;

-- Explicit retention: cache max 24h physically; 10min validity is enforced at query time.
-- Result bodies retained >=90 days; afterwards compacted, never remove receipts or account data.
create function public.overture_maintain() returns jsonb language plpgsql security definer set search_path='' set statement_timeout='15s' as $$
declare uid uuid; n integer; compacted integer;
begin
 for uid in select distinct user_id from public.overture_operations where status='reserved' and expires_at<=clock_timestamp() order by user_id loop
   perform private.overture_expire(uid);
 end loop;
 delete from private.overture_cache where created_at<clock_timestamp()-interval '24 hours';
 get diagnostics n=row_count;
 update public.overture_operations set result=(result-'features')||jsonb_build_object('features','[]'::jsonb,'recovery_expired',true,'reason','result_body_retention_90_days')
 where status<>'reserved' and created_at<clock_timestamp()-interval '90 days' and result ? 'features' and not coalesce((result->>'recovery_expired')::boolean,false);
 get diagnostics compacted=row_count;
 return jsonb_build_object('cache_removed',n,'results_compacted',compacted,'receipt_metadata_retained',true,'workspace_untouched',true);
end $$;
revoke all on function public.overture_snapshot(text),public.overture_activate(text),public.overture_maintain() from public,anon,authenticated;
grant execute on function public.overture_snapshot(text),public.overture_activate(text),public.overture_maintain() to service_role;

create or replace function public.overture_begin(p_receipt text,p_city text,p_sector text,p_quantity integer)
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
  if cfg.trial_segment and p_sector<>'restauration' then raise exception 'segment_essai_restauration'; end if;
  cost:=5+ceil(p_quantity/10.0)::integer;
  select count(*) into active from public.usage_holds where user_id=uid and status='open';
  if acc.searches_used+active>=10 then raise exception 'quota_mensuel'; end if;
  if acc.balance<cost then raise exception 'credits_insuffisants'; end if;
  insert into public.usage_holds(user_id,receipt,amount,label) values(uid,p_receipt,cost,'Recherche');
  insert into public.overture_operations(user_id,receipt,city,sector,quantity,release,amount,status,expires_at,revision)
    values(uid,p_receipt,p_city,p_sector,p_quantity,cfg.release,cost,'reserved',clock_timestamp()+interval '60 seconds',cfg.revision);
  update public.credit_accounts set balance=balance-cost where user_id=uid returning * into acc;
  return jsonb_build_object('status','reserved','amount',cost,'balance',acc.balance,'searches_used',acc.searches_used);
end $$;


create or replace function public.overture_execute(p_receipt text) returns jsonb language plpgsql security definer set search_path='' set statement_timeout='3s' set lock_timeout='2s' as $$
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
    if not cfg.enabled or cfg.release<>op.release or cfg.revision<>op.revision or cfg.imported_at is null then raise exception 'catalogue_indisponible'; end if;
    if not cfg.complete then
      v_result:=jsonb_build_object('state','partial','reason','catalogue_incomplet','features','[]'::jsonb);
    else
      cache_key:=concat_ws(':',op.release,cfg.imported_at::text,op.city,op.sector,op.quantity,cfg.revision,'policy2');
      select c.features,c.created_at into features,cache_at from private.overture_cache c where c.key=cache_key and c.created_at>clock_timestamp()-interval '10 minutes';
      hit:=found;
      if not hit then
        select lat,lon into clat,clon from (values ('montreal',45.5017,-73.5673),('laval',45.6066,-73.7124),('quebec',46.8139,-71.208)) as centres(city,lat,lon) where city=op.city;
        with bounded as (
          select p.*,6371008.8*2*asin(least(1.0,sqrt(power(sin(radians(p.lat-clat)/2),2)+cos(radians(clat))*cos(radians(p.lat))*power(sin(radians(p.lon-clon)/2),2)))) as metres
          from private.overture_places p where p.release=op.release and p.city=op.city and p.sectors @> array[op.sector]
            and p.lat between clat-0.021 and clat+0.021 and p.lon between clon-0.031 and clon+0.031
            and (not cfg.trial_segment or private.overture_target(p.original)<>'exclude')
            and not exists(select 1 from private.overture_review r where r.id=p.id and r.status='exclude')
        ), ranked as (
          select *,row_number() over(partition by duplicate_key order by metres,id) as duplicate_rank from bounded where metres<=2200
        ), limited as (
          select original,id,metres from ranked where duplicate_rank=1 order by metres,id limit op.quantity
        ) select coalesce(jsonb_agg(jsonb_build_object('feature',l.original,'review',coalesce((select jsonb_build_object('status',r.status,'reason',r.reason,'evidence',r.evidence) from private.overture_review r where r.id=l.id),case when cfg.trial_segment and private.overture_target(l.original)='review' then jsonb_build_object('status','review','reason','Catégorie non renseignée : appartenance au segment à confirmer') else 'null'::jsonb end)) order by l.metres,l.id),'[]'::jsonb) into features from limited l;
        cache_at:=clock_timestamp();
        insert into private.overture_cache(key,features,created_at) values(cache_key,features,cache_at)
          on conflict(key) do update set features=excluded.features,created_at=excluded.created_at;
      end if;
      v_result:=jsonb_build_object('state',case when jsonb_array_length(features)>0 then 'complete' else 'valid_empty' end,
        'features',features,'revision',cfg.revision,'release',op.release,'catalogue_at',cfg.imported_at,'cache_at',cache_at,'cache_hit',hit,'maximum',op.quantity,'radius_m',2200);
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

