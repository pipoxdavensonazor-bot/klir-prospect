-- Row snapshots avoid aggregating the whole catalogue into a single large JSON value.
create table private.overture_snapshot_places (
 revision text not null references private.overture_snapshots(revision),
 release text not null, city text not null, id text not null,
 lat double precision not null, lon double precision not null,
 sectors text[] not null, duplicate_key text not null, original jsonb not null,
 primary key(revision,city,id)
);
alter table private.overture_snapshot_places enable row level security;
alter table private.overture_snapshot_places force row level security;
revoke all on private.overture_snapshot_places from public,anon,authenticated;
create or replace function public.overture_snapshot(p_revision text) returns jsonb language plpgsql security definer set search_path='' set statement_timeout='30s' as $$
declare rev jsonb; cfg private.overture_settings%rowtype; n integer; checksum text;
begin
 if p_revision !~ '^[a-z0-9-]{3,60}$' then raise exception 'revision_invalide'; end if;
 perform pg_advisory_xact_lock(718423);
 select * into cfg from private.overture_settings where singleton for update;
 if not cfg.complete then raise exception 'catalogue_incomplet'; end if;
 select count(*) into n from private.overture_places where release=cfg.release;
 if n<>cfg.expected_count then raise exception 'compte_incorrect'; end if;
 select coalesce(jsonb_agg(to_jsonb(r) order by r.id),'[]'::jsonb) into rev from private.overture_review r;
 select md5(string_agg(md5(to_jsonb(p)::text),'' order by p.city,p.id)||rev::text) into checksum from private.overture_places p where release=cfg.release;
 insert into private.overture_snapshots(revision,release,imported_at,trial_segment,row_count,checksum,places,reviews)
 values(p_revision,cfg.release,cfg.imported_at,cfg.trial_segment,n,checksum,'[]',rev);
 insert into private.overture_snapshot_places select p_revision,p.* from private.overture_places p where release=cfg.release;
 return jsonb_build_object('revision',p_revision,'rows',n,'checksum',checksum);
end $$;
create or replace function public.overture_activate(p_revision text) returns jsonb language plpgsql security definer set search_path='' set statement_timeout='30s' as $$
declare snap private.overture_snapshots%rowtype; checksum text; n integer;
begin
 perform pg_advisory_xact_lock(718423);
 perform 1 from private.overture_settings where singleton for update;
 select * into snap from private.overture_snapshots where revision=p_revision;
 if not found then raise exception 'revision_inconnue'; end if;
 select count(*),md5(string_agg(md5((to_jsonb(p)-'revision')::text),'' order by p.city,p.id)||snap.reviews::text) into n,checksum from private.overture_snapshot_places p where revision=p_revision;
 if n<>snap.row_count or checksum<>snap.checksum then raise exception 'snapshot_invalide'; end if;
 delete from private.overture_places;
 insert into private.overture_places select release,city,id,lat,lon,sectors,duplicate_key,original from private.overture_snapshot_places where revision=p_revision;
 delete from private.overture_review;
 insert into private.overture_review select * from jsonb_populate_recordset(null::private.overture_review,snap.reviews);
 update private.overture_settings set revision=snap.revision,release=snap.release,imported_at=snap.imported_at,trial_segment=snap.trial_segment,complete=true where singleton;
 delete from private.overture_cache;
 return jsonb_build_object('revision',snap.revision,'rows',n,'checksum',checksum);
end $$;
