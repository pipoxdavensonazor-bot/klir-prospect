\set ON_ERROR_STOP on
do $$ begin
 if (select count(*) from auth.users)<>2 then raise exception 'fixture_users'; end if;
 if (select sum(balance) from public.credit_accounts)<>391 then raise exception 'fixture_balances'; end if;
 if (select count(*) from public.credit_receipts)<>1 then raise exception 'fixture_receipts'; end if;
 if not exists(select 1 from public.workspace_states where payload->'crm'->0->>'next_action'='2030-01-01') then raise exception 'fixture_crm'; end if;
 if not exists(select 1 from pg_class where oid='public.workspace_states'::regclass and relrowsecurity and relforcerowsecurity) then raise exception 'fixture_rls'; end if;
 if has_table_privilege('klir_socket_fixture','public.credit_accounts','UPDATE') then raise exception 'fixture_grants'; end if;
end $$;
set role klir_socket_fixture;
set klir.fixture_user='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
do $$ begin
 if (select count(*) from public.workspace_states)<>1 then raise exception 'fixture_isolation_a'; end if;
 begin
  insert into public.workspace_states values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','{}');
  raise exception 'fixture_cross_write_accepted';
 exception when insufficient_privilege then null;
 end;
end $$;
set klir.fixture_user='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
do $$ begin
 if (select count(*) from public.workspace_states)<>1 then raise exception 'fixture_isolation_b'; end if;
 if exists(select 1 from public.workspace_states where payload->'crm'->0->>'name'='Synthetic A') then raise exception 'fixture_cross_read'; end if;
end $$;
reset role;
do $$ begin
 begin
  insert into public.credit_receipts values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','synthetic_receipt',9);
  raise exception 'fixture_duplicate_receipt_accepted';
 exception when unique_violation then null;
 end;
end $$;
select 'SYNTHETIC_SOCKET_RESTORE_PASS';
