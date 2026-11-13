-- Empreinte comparable source/restauration : comptes, soldes, jobs, fiches, RLS, droits.
-- Sortie : un seul JSON (compteurs + md5), aucune donnée personnelle en clair.
set timezone = 'UTC';
select jsonb_pretty(jsonb_build_object(
  'tables', (select jsonb_object_agg(n.nspname||'.'||c.relname, (xpath('/row/c/text()',
      query_to_xml(format('select count(*) as c from %I.%I', n.nspname, c.relname), false, true, '')))[1]::text::int)
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where c.relkind='r' and (n.nspname in ('public','private') or (n.nspname='auth' and c.relname in ('users','identities')))),
  'md5_credit_accounts', (select md5(coalesce(string_agg(x::text, '|' order by x::text),'')) from public.credit_accounts x),
  'md5_usage_holds', (select md5(coalesce(string_agg(x::text, '|' order by x::text),'')) from public.usage_holds x),
  'md5_credit_receipts', (select md5(coalesce(string_agg(x::text, '|' order by x::text),'')) from public.credit_receipts x),
  'md5_search_jobs', (select md5(coalesce(string_agg(x::text, '|' order by x::text),'')) from public.search_jobs x),
  'md5_search_job_places', (select md5(coalesce(string_agg(x::text, '|' order by x::text),'')) from public.search_job_places x),
  'md5_profiles', (select md5(coalesce(string_agg(x::text, '|' order by x::text),'')) from public.profiles x),
  'md5_workspace_states', (select md5(coalesce(string_agg(x::text, '|' order by x::text),'')) from public.workspace_states x),
  'md5_auth_users_ids', (select md5(coalesce(string_agg(id::text, '|' order by id),'')) from auth.users),
  'sum_balance', (select sum(balance) from public.credit_accounts),
  'jobs_enabled', (select jobs_enabled from private.search_job_settings),
  'rls', (select jsonb_object_agg(n.nspname||'.'||c.relname, case when c.relforcerowsecurity then 'force' when c.relrowsecurity then 'on' else 'off' end)
    from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='r' and n.nspname in ('public','private')),
  'policies', (select md5(string_agg(schemaname||'.'||tablename||'.'||policyname||':'||cmd||':'||array_to_string(roles,','), '|' order by schemaname, tablename, policyname)) from pg_policies where schemaname in ('public','private')),
  'policy_count', (select count(*) from pg_policies where schemaname in ('public','private')),
  'exec_reserve_settle_authenticated', (select jsonb_object_agg(p.proname, has_function_privilege('authenticated', p.oid, 'execute'))
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('reserve_usage','settle_usage'))
));
