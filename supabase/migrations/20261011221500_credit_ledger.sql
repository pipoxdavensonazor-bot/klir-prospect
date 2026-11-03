-- Registre de crédits du compte. Le solde et le quota ne sont pas modifiables
-- par le navigateur : seule une fonction du compte peut réserver puis confirmer.

create table public.credit_accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  balance integer not null default 200,
  usage_period text not null,
  searches_used integer not null default 0,
  updated_at timestamptz not null default now(),
  constraint credit_accounts_balance_nonnegative check (balance >= 0),
  constraint credit_accounts_searches_nonnegative check (searches_used >= 0),
  constraint credit_accounts_period_shape check (usage_period ~ '^[0-9]{4}-[0-9]{2}$')
);

create table public.usage_holds (
  user_id uuid not null references auth.users(id) on delete cascade,
  receipt text not null,
  amount integer not null,
  label text not null,
  status text not null default 'open',
  created_at timestamptz not null default now(),
  primary key (user_id, receipt),
  constraint usage_holds_amount_positive check (amount > 0),
  constraint usage_holds_label_known check (label in ('Recherche', 'Scan Radar')),
  constraint usage_holds_status_known check (status in ('open', 'complete', 'released')),
  constraint usage_holds_receipt_shape check (receipt ~ '^(debit|radar)_[0-9a-f]{24}$')
);

create table public.credit_receipts (
  user_id uuid not null references auth.users(id) on delete cascade,
  receipt text not null,
  amount integer not null,
  label text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, receipt),
  constraint credit_receipts_amount_positive check (amount > 0)
);

alter table public.credit_accounts enable row level security;
alter table public.usage_holds enable row level security;
alter table public.credit_receipts enable row level security;
alter table public.credit_accounts force row level security;
alter table public.usage_holds force row level security;
alter table public.credit_receipts force row level security;

revoke all on table public.credit_accounts, public.usage_holds, public.credit_receipts from anon, authenticated;
grant select on table public.credit_accounts, public.usage_holds, public.credit_receipts to authenticated;

create policy "credit_accounts_select_own"
on public.credit_accounts
for select
to authenticated
using ((select auth.uid()) = user_id);

create policy "usage_holds_select_own"
on public.usage_holds
for select
to authenticated
using ((select auth.uid()) = user_id);

create policy "credit_receipts_select_own"
on public.credit_receipts
for select
to authenticated
using ((select auth.uid()) = user_id);

create trigger credit_accounts_set_updated_at
before update on public.credit_accounts
for each row execute function private.set_updated_at();

create or replace function private.toronto_period()
returns text
language sql
stable
set search_path = ''
as $$
  select to_char(now() at time zone 'America/Toronto', 'YYYY-MM')
$$;

create or replace function private.handle_new_credit_account()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.credit_accounts (user_id, balance, usage_period, searches_used)
  values (new.id, 200, private.toronto_period(), 0)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

revoke all on function private.handle_new_credit_account() from public, anon, authenticated;
revoke all on function private.toronto_period() from public, anon, authenticated;

create trigger on_auth_user_created_credits
after insert on auth.users
for each row execute function private.handle_new_credit_account();

insert into public.credit_accounts (user_id, balance, usage_period, searches_used)
select id, 200, private.toronto_period(), 0
from auth.users
on conflict (user_id) do nothing;

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

  if account.searches_used >= 10 then
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
  account public.credit_accounts%rowtype;
  hold public.usage_holds%rowtype;
begin
  if uid is null then
    raise exception 'session_requise';
  end if;
  if p_outcome not in ('complete', 'release') then
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

  if p_outcome = 'complete' then
    if hold.status = 'complete' then
      return jsonb_build_object('balance', account.balance, 'searches_used', account.searches_used, 'status', 'complete');
    end if;
    if hold.status <> 'open' then
      raise exception 'recu_invalide';
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

create or replace function public.read_credit_account()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  period text := private.toronto_period();
  account public.credit_accounts%rowtype;
begin
  if uid is null then
    raise exception 'session_requise';
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

  return jsonb_build_object(
    'balance', account.balance,
    'searches_used', account.searches_used,
    'usage_period', account.usage_period
  );
end;
$$;

revoke all on function public.reserve_usage(text, integer, text) from public, anon;
revoke all on function public.settle_usage(text, text) from public, anon;
revoke all on function public.read_credit_account() from public, anon;
grant execute on function public.reserve_usage(text, integer, text) to authenticated;
grant execute on function public.settle_usage(text, text) to authenticated;
grant execute on function public.read_credit_account() to authenticated;
