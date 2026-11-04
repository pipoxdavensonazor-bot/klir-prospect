-- Read-only inventory. Execute only after selecting KlirProspect Test in the dashboard.
select jsonb_build_object(
 'recorded_at',clock_timestamp(),'database_bytes',pg_database_size(current_database()),
 'relations',(select jsonb_agg(jsonb_build_object('schema',s.schemaname,'table',s.relname,'total_bytes',pg_total_relation_size(s.relid),'heap_bytes',pg_relation_size(s.relid),'index_bytes',pg_indexes_size(s.relid),'estimated_dead_rows',s.n_dead_tup) order by pg_total_relation_size(s.relid) desc) from pg_stat_user_tables s where s.schemaname in ('public','private')),
 'expired_cache_rows',(select count(*) from private.overture_cache where created_at<clock_timestamp()-interval '24 hours'),
 'expired_cache_logical_bytes',(select coalesce(sum(pg_column_size(features)),0) from private.overture_cache where created_at<clock_timestamp()-interval '24 hours'),
 'old_result_rows',(select count(*) from public.overture_operations where created_at<clock_timestamp()-interval '90 days' and status<>'reserved'),
 'workspace_count',(select count(*) from public.workspace_states),
 'max_workspace_bytes',(select coalesce(max(octet_length(payload::text)),0) from public.workspace_states),
 'workspace_payload_fingerprint',(select md5(coalesce(string_agg(md5(payload::text),'' order by user_id),'')) from public.workspace_states),
 'catalogue_revision',(select revision from private.overture_settings),
 'snapshots',(select jsonb_agg(jsonb_build_object('revision',revision,'row_count',row_count,'created_at',created_at)) from private.overture_snapshots)
) as inventory;
