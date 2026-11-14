-- Levée du plafond fixe de 10 recherches par mois (feu vert Philippe, 13 nov. 2026).
-- Les crédits deviennent la vraie limite. Un garde-fou anti-abus reste en place :
-- au plus N réservations de recherche/radar par heure glissante et par jour glissant
-- et par compte. Les valeurs se règlent à un seul endroit : private.search_rate_limits.
-- searches_used reste un compteur d'usage du mois (statistique), sans plafond.
-- Toute réservation compte (ouverte, confirmée ou libérée) : c'est une limite de tentatives.

create table if not exists private.search_rate_limits (
  singleton boolean primary key default true check (singleton),
  per_hour integer not null default 30 check (per_hour between 1 and 1000),
  per_day integer not null default 200 check (per_day between 1 and 10000),
  updated_at timestamptz not null default now(),
  constraint search_rate_limits_order check (per_hour <= per_day)
);
insert into private.search_rate_limits (singleton) values (true) on conflict (singleton) do nothing;
revoke all on table private.search_rate_limits from public, anon, authenticated;

create index if not exists usage_holds_user_created_idx on public.usage_holds (user_id, created_at);

create or replace function private.search_limits()
returns jsonb
language sql
stable
security definer
set search_path to ''
as $$
  select jsonb_build_object('monthly_cap', null, 'per_hour', l.per_hour, 'per_day', l.per_day)
  from private.search_rate_limits l where l.singleton
$$;
revoke all on function private.search_limits() from public, anon, authenticated;

create or replace function private.check_search_rate(p_user uuid)
returns void
language plpgsql
security definer
set search_path to ''
as $$
declare lim private.search_rate_limits%rowtype; n_hour integer; n_day integer;
begin
  select * into lim from private.search_rate_limits where singleton;
  if not found then raise exception 'limite_non_configuree'; end if;
  select count(*) filter (where created_at > now() - interval '1 hour'), count(*)
    into n_hour, n_day
  from public.usage_holds
  where user_id = p_user and created_at > now() - interval '1 day';
  if n_hour >= lim.per_hour then raise exception 'limite_recherches_heure'; end if;
  if n_day >= lim.per_day then raise exception 'limite_recherches_jour'; end if;
end
$$;
revoke all on function private.check_search_rate(uuid) from public, anon, authenticated;

CREATE OR REPLACE FUNCTION private.apply_usage_outcome(p_user uuid, p_receipt text, p_outcome text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  period text := private.toronto_period();
  account public.credit_accounts%rowtype;
  hold public.usage_holds%rowtype;
begin
  if p_user is null then
    raise exception 'session_requise';
  end if;
  if p_outcome is null or p_outcome not in ('complete', 'release') then
    raise exception 'recu_invalide';
  end if;

  select * into hold
  from public.usage_holds
  where user_id = p_user and receipt = p_receipt
  for update;

  if not found then
    raise exception 'recu_invalide';
  end if;

  select * into account
  from public.credit_accounts
  where user_id = p_user
  for update;

  if account.usage_period is distinct from period then
    update public.credit_accounts
    set usage_period = period, searches_used = 0
    where user_id = p_user
    returning * into account;
  end if;

  if p_outcome = 'complete' then
    if hold.status = 'complete' then
      return jsonb_build_object('balance', account.balance, 'searches_used', account.searches_used, 'status', 'complete');
    end if;
    if hold.status <> 'open' then
      raise exception 'recu_invalide';
    end if;
    update public.usage_holds
    set status = 'complete'
    where user_id = p_user and receipt = p_receipt;
    update public.credit_accounts
    set searches_used = account.searches_used + 1
    where user_id = p_user
    returning * into account;
    insert into public.credit_receipts (user_id, receipt, amount, label)
    values (p_user, p_receipt, hold.amount, hold.label);
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
  where user_id = p_user
  returning * into account;
  update public.usage_holds
  set status = 'released'
  where user_id = p_user and receipt = p_receipt;
  return jsonb_build_object('balance', account.balance, 'searches_used', account.searches_used, 'status', 'released');
end;
$function$;

CREATE OR REPLACE FUNCTION public.reserve_usage(p_receipt text, p_amount integer, p_label text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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

  -- Plus de plafond mensuel fixe : le solde de crédits est la vraie limite.
  -- Garde-fou anti-abus seulement (private.search_rate_limits).
  perform private.check_search_rate(uid);
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
$function$;

do $do$
begin
  -- overture_begin n'existe que si le pilote Overture a été migré.
  if to_regprocedure('public.overture_begin(text,text,text,integer)') is not null then
    execute $ob$CREATE OR REPLACE FUNCTION public.overture_begin(p_receipt text, p_city text, p_sector text, p_quantity integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET statement_timeout TO '3s'
 SET lock_timeout TO '2s'
AS $function$
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
  perform private.check_search_rate(uid);
  if acc.balance<cost then raise exception 'credits_insuffisants'; end if;
  insert into public.usage_holds(user_id,receipt,amount,label) values(uid,p_receipt,cost,'Recherche');
  insert into public.overture_operations(user_id,receipt,city,sector,quantity,release,amount,status,expires_at,revision)
    values(uid,p_receipt,p_city,p_sector,p_quantity,cfg.release,cost,'reserved',clock_timestamp()+interval '60 seconds',cfg.revision);
  update public.credit_accounts set balance=balance-cost where user_id=uid returning * into acc;
  return jsonb_build_object('status','reserved','amount',cost,'balance',acc.balance,'searches_used',acc.searches_used);
end $function$
$ob$;
  end if;
end
$do$;

-- CREATE OR REPLACE garde les droits existants ; on réaffirme la fermeture des RPC directs.
revoke execute on function public.reserve_usage(text, integer, text) from public, anon, authenticated;
revoke all on function private.apply_usage_outcome(uuid, text, text) from public, anon, authenticated;
