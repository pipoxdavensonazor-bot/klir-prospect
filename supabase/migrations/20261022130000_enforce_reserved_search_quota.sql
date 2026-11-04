-- Une réservation ouverte occupe une place jusqu’à sa confirmation ou libération.
-- Les transactions du même compte restent sérialisées par le verrou du compte.
create index if not exists usage_holds_open_by_user
on public.usage_holds (user_id) where status = 'open';

create or replace function public.reserve_usage(p_receipt text, p_amount integer, p_label text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  period text := private.toronto_period();
  account public.credit_accounts%rowtype;
  hold public.usage_holds%rowtype;
  open_count integer;
begin
  if uid is null then
    raise exception 'session_requise';
  end if;
  if p_receipt !~ '^(debit|radar)_[0-9a-f]{24}$' then
    raise exception 'recu_invalide';
  end if;
  if p_label = 'Recherche' then
    if p_receipt !~ '^debit_' or p_amount < 6 or p_amount > 55 then
      raise exception 'montant_invalide';
    end if;
  elsif p_label = 'Scan Radar' then
    if p_receipt !~ '^radar_' or p_amount <> 5 then
      raise exception 'montant_invalide';
    end if;
  else
    raise exception 'montant_invalide';
  end if;

  insert into public.credit_accounts (user_id, balance, usage_period, searches_used)
  values (uid, 200, period, 0)
  on conflict (user_id) do nothing;

  select * into account
  from public.credit_accounts
  where user_id = uid
  for update;

  if account.usage_period is distinct from period then
    update public.credit_accounts
    set usage_period = period, searches_used = 0
    where user_id = uid
    returning * into account;
  end if;

  select * into hold
  from public.usage_holds
  where user_id = uid and receipt = p_receipt;

  if found then
    if hold.status = 'open' and hold.amount = p_amount and hold.label = p_label then
      return jsonb_build_object('balance', account.balance, 'searches_used', account.searches_used, 'status', 'open');
    end if;
    raise exception 'recu_invalide';
  end if;

  select count(*) into open_count
  from public.usage_holds
  where user_id = uid and status = 'open';

  if account.searches_used + open_count >= 10 then
    raise exception 'quota_mensuel';
  end if;
  if account.balance < p_amount then
    raise exception 'credits_insuffisants';
  end if;

  update public.credit_accounts
  set balance = account.balance - p_amount
  where user_id = uid
  returning * into account;

  insert into public.usage_holds (user_id, receipt, amount, label, status)
  values (uid, p_receipt, p_amount, p_label, 'open');

  return jsonb_build_object('balance', account.balance, 'searches_used', account.searches_used, 'status', 'open');
end;
$$;

create or replace function public.settle_usage(p_receipt text, p_outcome text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  period text := private.toronto_period();
  account public.credit_accounts%rowtype;
  hold public.usage_holds%rowtype;
begin
  if uid is null then
    raise exception 'session_requise';
  end if;
  if p_outcome is null or p_outcome not in ('complete', 'release') then
    raise exception 'recu_invalide';
  end if;

  select * into hold
  from public.usage_holds
  where user_id = uid and receipt = p_receipt
  for update;

  if not found then
    raise exception 'recu_invalide';
  end if;

  select * into account
  from public.credit_accounts
  where user_id = uid
  for update;

  if account.usage_period is distinct from period then
    update public.credit_accounts
    set usage_period = period, searches_used = 0
    where user_id = uid
    returning * into account;
  end if;

  if p_outcome = 'complete' then
    if hold.status = 'complete' then
      return jsonb_build_object('balance', account.balance, 'searches_used', account.searches_used, 'status', 'complete');
    end if;
    if hold.status <> 'open' then
      raise exception 'recu_invalide';
    end if;
    if account.searches_used >= 10 then
      raise exception 'quota_mensuel';
    end if;
    update public.usage_holds
    set status = 'complete'
    where user_id = uid and receipt = p_receipt;
    update public.credit_accounts
    set searches_used = account.searches_used + 1
    where user_id = uid
    returning * into account;
    insert into public.credit_receipts (user_id, receipt, amount, label)
    values (uid, p_receipt, hold.amount, hold.label);
    return jsonb_build_object('balance', account.balance, 'searches_used', account.searches_used, 'status', 'complete');
  end if;

  if hold.status = 'released' then
    return jsonb_build_object('balance', account.balance, 'searches_used', account.searches_used, 'status', 'released');
  end if;
  if hold.status <> 'open' then
    raise exception 'recu_invalide';
  end if;

  update public.credit_accounts
  set balance = account.balance + hold.amount
  where user_id = uid
  returning * into account;
  update public.usage_holds
  set status = 'released'
  where user_id = uid and receipt = p_receipt;
  return jsonb_build_object('balance', account.balance, 'searches_used', account.searches_used, 'status', 'released');
end;
$$;

revoke all on function public.reserve_usage(text, integer, text) from public, anon;
revoke all on function public.settle_usage(text, text) from public, anon;
grant execute on function public.reserve_usage(text, integer, text) to authenticated;
grant execute on function public.settle_usage(text, text) to authenticated;
