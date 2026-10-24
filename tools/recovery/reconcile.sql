-- Run only on the isolated restored database, after comparison with backup inventory.
do $$
begin
 if exists(select 1 from public.credit_accounts c left join auth.users u on u.id=c.user_id where u.id is null or c.balance<0) then raise exception 'invalid_credit_owner_or_balance'; end if;
 if exists(select 1 from public.overture_operations o left join public.usage_holds h using(user_id,receipt) where h.receipt is null or h.amount<>o.amount) then raise exception 'operation_hold_mismatch'; end if;
 if exists(select 1 from public.overture_operations o left join public.credit_receipts r using(user_id,receipt) where o.status='complete' and (r.receipt is null or r.amount<>o.amount)) then raise exception 'completed_receipt_mismatch'; end if;
 if exists(select 1 from public.workspace_states w left join auth.users u on u.id=w.user_id where u.id is null) then raise exception 'orphan_workspace'; end if;
 if exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='private' and c.relkind='r' and (not c.relrowsecurity or not c.relforcerowsecurity)) then raise exception 'private_rls_missing'; end if;
end $$;
