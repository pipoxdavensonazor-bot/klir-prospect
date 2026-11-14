-- Facturation KlirProspect : forfaits Starter / Pro / Équipe, packs de crédits,
-- recharge mensuelle du palier Gratuit, webhooks Stripe (feu vert Philippe t121).
--
-- Principes :
--  * Le navigateur ne choisit ni le prix, ni les crédits, ni le palier. Il ne
--    reçoit que les liens de paiement Stripe et ajoute son propre identifiant
--    (client_reference_id). Les crédits viennent seulement d'un événement Stripe
--    signé (HMAC-SHA256 vérifié ici, secret dans Supabase Vault).
--  * Chaque attribution de crédits a une clé unique (facture, session, mois) :
--    un événement rejoué ou reçu deux fois ne crédite jamais deux fois.
--  * Aucune attribution ne retire de crédits. Le report des paliers payants est
--    plafonné à 2 fois l'allocation mensuelle (+ packs achetés depuis 12 mois).
--  * Gratuit : 200 crédits à l'inscription (déjà en place), puis le solde est
--    remonté à 50 au début de chaque mois (pas de report).
--  * Le mode (test / live), l'ouverture du paiement et les liens sont des
--    données de configuration (private.billing_settings / billing_offers),
--    remplies séparément dans chaque projet, jamais par ce fichier.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table private.billing_settings (
  id boolean primary key default true check (id),
  project text not null check (project in ('test', 'prod')),
  mode text not null default 'test' check (mode in ('test', 'live')),
  checkout_enabled boolean not null default false,
  portal_url text check (portal_url is null or portal_url ~ '^https://billing\.stripe\.com/p/login/[A-Za-z0-9_]+$'),
  updated_at timestamptz not null default now()
);

create table private.billing_offers (
  offer_key text not null check (offer_key in (
    'starter_month', 'starter_year', 'pro_month', 'pro_year', 'equipe_month', 'equipe_year', 'pack_500', 'pack_2000')),
  mode text not null check (mode in ('test', 'live')),
  tier text check (tier in ('starter', 'pro', 'equipe')),
  kind text not null check (kind in ('subscription', 'pack')),
  billing_interval text check (billing_interval in ('month', 'year')),
  amount_minor integer not null check (amount_minor > 0),
  credits integer not null check (credits > 0),
  stripe_price_id text not null unique check (stripe_price_id ~ '^price_[A-Za-z0-9]+$'),
  payment_link_id text not null unique check (payment_link_id ~ '^plink_[A-Za-z0-9]+$'),
  payment_link_url text not null check (payment_link_url ~ '^https://buy\.stripe\.com/[A-Za-z0-9_]+$'),
  primary key (offer_key, mode),
  check ((kind = 'pack') = (tier is null)),
  check ((kind = 'pack') = (billing_interval is null))
);

create table private.billing_accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  tier text not null default 'gratuit' check (tier in ('gratuit', 'starter', 'pro', 'equipe')),
  offer_key text,
  stripe_customer_id text,
  stripe_subscription_id text,
  subscription_status text,
  cancel_at_period_end boolean not null default false,
  current_period_end timestamptz,
  next_refill_at timestamptz,
  period_granted integer not null default 0 check (period_granted >= 0),
  updated_at timestamptz not null default now()
);

create table private.stripe_subscriptions (
  subscription_id text primary key check (subscription_id ~ '^sub_[A-Za-z0-9]+$'),
  user_id uuid not null references auth.users(id) on delete cascade,
  customer_id text,
  offer_key text not null,
  status text not null,
  cancel_at_period_end boolean not null default false,
  current_period_end timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index stripe_subscriptions_user on private.stripe_subscriptions (user_id);

create table private.stripe_events (
  event_id text primary key check (event_id ~ '^evt_[A-Za-z0-9]+$'),
  event_type text not null,
  livemode boolean not null,
  outcome text not null,
  received_at timestamptz not null default now()
);

create table private.credit_grants (
  grant_key text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  reason text not null check (reason in ('plan', 'upgrade', 'pack', 'free_refill')),
  offer_key text,
  requested integer not null check (requested >= 0),
  credits integer not null check (credits >= 0),
  balance_after integer not null check (balance_after >= 0),
  created_at timestamptz not null default now()
);
create index credit_grants_user on private.credit_grants (user_id, created_at desc);

revoke all on private.billing_settings, private.billing_offers, private.billing_accounts,
  private.stripe_subscriptions, private.stripe_events, private.credit_grants
  from public, anon, authenticated;

-- HMAC-SHA256 en SQL pur (sha256 intégré à PostgreSQL), sans dépendance pgcrypto.
create function private.hmac_sha256(p_key bytea, p_message bytea)
returns bytea language plpgsql immutable strict set search_path = '' as $$
declare
  k bytea := p_key;
  ipad bytea;
  opad bytea;
  i integer;
begin
  if length(k) > 64 then k := pg_catalog.sha256(k); end if;
  k := k || pg_catalog.decode(pg_catalog.repeat('00', 64 - length(k)), 'hex');
  ipad := k; opad := k;
  for i in 0..63 loop
    ipad := pg_catalog.set_byte(ipad, i, pg_catalog.get_byte(k, i) # 54);
    opad := pg_catalog.set_byte(opad, i, pg_catalog.get_byte(k, i) # 92);
  end loop;
  return pg_catalog.sha256(opad || pg_catalog.sha256(ipad || p_message));
end $$;

-- Secret de signature Stripe : Supabase Vault, nom par mode. Jamais renvoyé.
create function private.stripe_webhook_secret(p_livemode boolean)
returns text language plpgsql stable security definer set search_path = '' as $$
declare s text;
begin
  select decrypted_secret into s from vault.decrypted_secrets
   where name = case when p_livemode then 'klirprospect_stripe_webhook_live' else 'klirprospect_stripe_webhook_test' end
   limit 1;
  return s;
end $$;

-- En-tête Stripe-Signature : t=<horodatage>,v1=<hex>[,v1=...]. Tolérance 5 minutes.
create function private.stripe_signature_ok(p_raw text, p_header text, p_secret text, p_now timestamptz default now())
returns boolean language plpgsql stable set search_path = '' as $$
declare
  ts text;
  expected text;
begin
  if p_secret is null or p_secret = '' or p_header is null or p_raw is null then return false; end if;
  ts := (pg_catalog.regexp_match(p_header, '(?:^|,)\s*t=([0-9]{9,11})(?:,|$)'))[1];
  if ts is null then return false; end if;
  if abs(extract(epoch from p_now) - ts::bigint) > 300 then return false; end if;
  expected := pg_catalog.encode(private.hmac_sha256(
    pg_catalog.convert_to(p_secret, 'UTF8'),
    pg_catalog.convert_to(ts || '.' || p_raw, 'UTF8')), 'hex');
  return exists (
    select 1 from pg_catalog.regexp_matches(p_header, '(?:^|,)\s*v1=([0-9a-f]{64})', 'g') as m(v)
     where m.v[1] = expected);
end $$;

create function private.billing_next_month_start(p_at timestamptz default now())
returns timestamptz language plpgsql stable set search_path = '' as $$
begin
  return (pg_catalog.date_trunc('month', p_at at time zone 'America/Toronto') + interval '1 month') at time zone 'America/Toronto';
end $$;

create function private.billing_tier_rank(p_tier text)
returns integer language plpgsql immutable set search_path = '' as $$
begin
  return case p_tier when 'equipe' then 3 when 'pro' then 2 when 'starter' then 1 else 0 end;
end $$;

create function private.billing_ensure_account(p_user uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into public.credit_accounts (user_id, balance, usage_period, searches_used)
  values (p_user, 200, private.toronto_period(), 0)
  on conflict (user_id) do nothing;
  insert into private.billing_accounts (user_id, tier, next_refill_at)
  values (p_user, 'gratuit', private.billing_next_month_start())
  on conflict (user_id) do nothing;
end $$;

-- Crédits d'un palier payant : report plafonné à 2 × allocation (+ packs des
-- 12 derniers mois). Ne retire jamais de crédits. Clé unique = une seule fois.
create function private.billing_grant_plan(p_user uuid, p_key text, p_allocation integer, p_reason text, p_offer text)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  bal integer;
  packs integer;
  cap integer;
  target integer;
begin
  if exists (select 1 from private.credit_grants where grant_key = p_key) then return null; end if;
  perform private.billing_ensure_account(p_user);
  select balance into bal from public.credit_accounts where user_id = p_user for update;
  select coalesce(sum(credits), 0) into packs from private.credit_grants
   where user_id = p_user and reason = 'pack' and created_at > now() - interval '365 days';
  cap := 2 * p_allocation + packs;
  target := greatest(bal, least(bal + p_allocation, cap));
  insert into private.credit_grants (grant_key, user_id, reason, offer_key, requested, credits, balance_after)
  values (p_key, p_user, p_reason, p_offer, p_allocation, target - bal, target)
  on conflict (grant_key) do nothing;
  if not found then return null; end if;
  if target > bal then
    update public.credit_accounts set balance = target where user_id = p_user;
  end if;
  return target - bal;
end $$;

create function private.billing_grant_pack(p_user uuid, p_key text, p_credits integer, p_offer text)
returns integer language plpgsql security definer set search_path = '' as $$
declare bal integer;
begin
  perform private.billing_ensure_account(p_user);
  select balance into bal from public.credit_accounts where user_id = p_user for update;
  insert into private.credit_grants (grant_key, user_id, reason, offer_key, requested, credits, balance_after)
  values (p_key, p_user, 'pack', p_offer, p_credits, p_credits, bal + p_credits)
  on conflict (grant_key) do nothing;
  if not found then return null; end if;
  update public.credit_accounts set balance = bal + p_credits where user_id = p_user;
  return p_credits;
end $$;

-- Palier du compte = meilleur abonnement actif ; sinon Gratuit.
create function private.billing_sync_tier(p_user uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare
  s record;
  acc private.billing_accounts%rowtype;
  st private.billing_settings%rowtype;
begin
  perform private.billing_ensure_account(p_user);
  select * into st from private.billing_settings where id;
  select * into acc from private.billing_accounts where user_id = p_user for update;
  select ss.*, o.tier as o_tier into s
    from private.stripe_subscriptions ss
    join private.billing_offers o on o.offer_key = ss.offer_key and o.mode = coalesce(st.mode, 'test')
   where ss.user_id = p_user and ss.status in ('active', 'trialing', 'past_due')
   order by private.billing_tier_rank(o.tier) desc, ss.updated_at desc
   limit 1;
  if found then
    update private.billing_accounts set
      tier = s.o_tier, offer_key = s.offer_key, stripe_subscription_id = s.subscription_id,
      subscription_status = s.status, cancel_at_period_end = s.cancel_at_period_end,
      current_period_end = s.current_period_end,
      stripe_customer_id = coalesce(s.customer_id, stripe_customer_id), updated_at = now()
    where user_id = p_user;
    return s.o_tier;
  end if;
  update private.billing_accounts set
    tier = 'gratuit', offer_key = null, stripe_subscription_id = null, subscription_status = null,
    cancel_at_period_end = false, current_period_end = null, period_granted = 0,
    next_refill_at = case when acc.tier = 'gratuit' then next_refill_at else private.billing_next_month_start() end,
    updated_at = now()
  where user_id = p_user;
  return 'gratuit';
end $$;

-- Traitement d'un événement Stripe déjà authentifié.
create function private.stripe_handle_event(p_event jsonb)
returns text language plpgsql security definer set search_path = '' as $$
declare
  st private.billing_settings%rowtype;
  obj jsonb := p_event -> 'data' -> 'object';
  etype text := p_event ->> 'type';
  offer private.billing_offers%rowtype;
  sub private.stripe_subscriptions%rowtype;
  acc private.billing_accounts%rowtype;
  uid uuid;
  sub_id text;
  line jsonb;
  price_id text;
  reason text;
  granted integer;
  diff integer;
  period_end timestamptz;
  period_start timestamptz;
begin
  select * into st from private.billing_settings where id;
  if not found then return 'ignored_not_configured'; end if;
  if (p_event ->> 'livemode')::boolean is distinct from (st.mode = 'live') then return 'ignored_mode'; end if;

  if etype = 'checkout.session.completed' then
    if coalesce(obj ->> 'payment_status', '') not in ('paid', 'no_payment_required') then return 'ignored_unpaid'; end if;
    select * into offer from private.billing_offers where payment_link_id = obj ->> 'payment_link' and mode = st.mode;
    if not found then return 'ignored_foreign_link'; end if;
    if coalesce(obj ->> 'client_reference_id', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      return 'ignored_no_user';
    end if;
    uid := (obj ->> 'client_reference_id')::uuid;
    if not exists (select 1 from auth.users where id = uid) then return 'ignored_unknown_user'; end if;
    perform private.billing_ensure_account(uid);
    update private.billing_accounts set stripe_customer_id = coalesce(obj ->> 'customer', stripe_customer_id), updated_at = now()
     where user_id = uid;
    if offer.kind = 'pack' then
      granted := private.billing_grant_pack(uid, 'pack:' || (obj ->> 'id'), offer.credits, offer.offer_key);
      return case when granted is null then 'duplicate' else 'pack_granted' end;
    end if;
    sub_id := obj ->> 'subscription';
    if sub_id is null then return 'ignored_no_subscription'; end if;
    insert into private.stripe_subscriptions (subscription_id, user_id, customer_id, offer_key, status)
    values (sub_id, uid, obj ->> 'customer', offer.offer_key, 'active')
    on conflict (subscription_id) do nothing;
    perform private.billing_sync_tier(uid);
    granted := private.billing_grant_plan(uid, 'invoice:' || coalesce(obj ->> 'invoice', obj ->> 'id'), offer.credits, 'plan', offer.offer_key);
    update private.billing_accounts set
      period_granted = case when granted is null then period_granted else offer.credits end,
      next_refill_at = case when offer.billing_interval = 'year' and granted is not null then now() + interval '1 month'
                            when offer.billing_interval = 'year' then next_refill_at else null end
     where user_id = uid;
    return case when granted is null then 'duplicate' else 'subscription_started' end;

  elsif etype = 'invoice.paid' then
    sub_id := coalesce(obj ->> 'subscription', obj #>> '{parent,subscription_details,subscription}');
    if sub_id is null then return 'ignored_no_subscription'; end if;
    select * into sub from private.stripe_subscriptions where subscription_id = sub_id;
    if not found then
      -- Stripe envoie souvent invoice.paid avant checkout.session.completed :
      -- pour un abonnement de CE projet, on demande une nouvelle livraison
      -- (HTTP 500) pendant une heure afin d'enregistrer la période ; la session
      -- attribue les crédits de cette facture (même clé), jamais deux fois.
      if coalesce(obj #>> '{parent,subscription_details,metadata,project}', obj #>> '{subscription_details,metadata,project}') = st.project
         and coalesce((p_event ->> 'created')::bigint, 0) > extract(epoch from now()) - 3600 then
        raise exception 'reessayer_plus_tard';
      end if;
      return 'ignored_unknown_subscription';
    end if;
    select e.value into line from jsonb_array_elements(coalesce(obj #> '{lines,data}', '[]'::jsonb)) as e(value)
     order by coalesce((e.value ->> 'amount')::bigint, 0) desc limit 1;
    price_id := coalesce(line #>> '{price,id}', line #>> '{pricing,price_details,price}', line #>> '{plan,id}');
    select * into offer from private.billing_offers where stripe_price_id = price_id and mode = st.mode and kind = 'subscription';
    if not found then return 'ignored_unknown_price'; end if;
    period_end := to_timestamp((line #>> '{period,end}')::bigint);
    period_start := to_timestamp((line #>> '{period,start}')::bigint);
    update private.stripe_subscriptions set offer_key = offer.offer_key,
      current_period_end = coalesce(period_end, current_period_end), updated_at = now()
     where subscription_id = sub_id;
    perform private.billing_sync_tier(sub.user_id);
    reason := obj ->> 'billing_reason';
    if reason in ('subscription_create', 'subscription_cycle') then
      granted := private.billing_grant_plan(sub.user_id, 'invoice:' || (obj ->> 'id'), offer.credits, 'plan', offer.offer_key);
      if granted is null then return 'duplicate'; end if;
      update private.billing_accounts set period_granted = offer.credits,
        next_refill_at = case when offer.billing_interval = 'year' then coalesce(period_start, now()) + interval '1 month' else null end
       where user_id = sub.user_id;
      return 'plan_granted';
    elsif reason = 'subscription_update' then
      if coalesce((obj ->> 'amount_paid')::bigint, 0) <= 0 then return 'ignored_no_charge'; end if;
      select * into acc from private.billing_accounts where user_id = sub.user_id;
      diff := offer.credits - coalesce(acc.period_granted, 0);
      if diff <= 0 then return 'ignored_no_upgrade'; end if;
      granted := private.billing_grant_plan(sub.user_id, 'invoice:' || (obj ->> 'id'), diff, 'upgrade', offer.offer_key);
      if granted is null then return 'duplicate'; end if;
      update private.billing_accounts set period_granted = offer.credits,
        next_refill_at = case when offer.billing_interval = 'year' then now() + interval '1 month' else null end
       where user_id = sub.user_id;
      return 'upgrade_granted';
    end if;
    return 'ignored_reason';

  elsif etype in ('customer.subscription.updated', 'customer.subscription.deleted') then
    sub_id := obj ->> 'id';
    select * into sub from private.stripe_subscriptions where subscription_id = sub_id;
    if not found then
      if obj #>> '{metadata,project}' = st.project
         and coalesce((p_event ->> 'created')::bigint, 0) > extract(epoch from now()) - 3600 then
        raise exception 'reessayer_plus_tard';
      end if;
      return 'ignored_unknown_subscription';
    end if;
    price_id := coalesce(obj #>> '{items,data,0,price,id}', obj #>> '{plan,id}');
    select * into offer from private.billing_offers where stripe_price_id = price_id and mode = st.mode and kind = 'subscription';
    update private.stripe_subscriptions set
      status = case when etype = 'customer.subscription.deleted' then 'canceled' else coalesce(obj ->> 'status', status) end,
      cancel_at_period_end = coalesce((obj ->> 'cancel_at_period_end')::boolean, false),
      current_period_end = coalesce(to_timestamp(coalesce(obj ->> 'current_period_end', obj #>> '{items,data,0,current_period_end}')::bigint), current_period_end),
      offer_key = coalesce(offer.offer_key, offer_key),
      updated_at = now()
     where subscription_id = sub_id;
    return 'tier_' || private.billing_sync_tier(sub.user_id);

  elsif etype = 'charge.refunded' then
    return 'logged_refund_manual_review';
  end if;
  return 'ignored_type';
end $$;

-- Point d'entrée de la fonction Edge stripe-webhook. Appelable avec la clé
-- publique : rien n'est accepté sans signature Stripe valide.
create function public.stripe_webhook_ingest(p_raw text, p_signature text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  evt jsonb;
  outcome text;
begin
  if p_raw is null or length(p_raw) > 1000000 then raise exception 'charge_invalide'; end if;
  begin
    evt := p_raw::jsonb;
  exception when others then
    raise exception 'signature_invalide';
  end;
  if not private.stripe_signature_ok(p_raw, p_signature, private.stripe_webhook_secret(coalesce((evt ->> 'livemode')::boolean, false))) then
    raise exception 'signature_invalide';
  end if;
  if coalesce(evt ->> 'id', '') !~ '^evt_[A-Za-z0-9]+$' then raise exception 'evenement_invalide'; end if;
  perform 1 from private.stripe_events where event_id = evt ->> 'id';
  if found then
    return jsonb_build_object('outcome', 'duplicate_event');
  end if;
  outcome := private.stripe_handle_event(evt);
  insert into private.stripe_events (event_id, event_type, livemode, outcome)
  values (evt ->> 'id', coalesce(evt ->> 'type', '?'), coalesce((evt ->> 'livemode')::boolean, false), outcome)
  on conflict (event_id) do nothing;
  return jsonb_build_object('outcome', outcome);
end $$;

-- Recharge paresseuse : Gratuit remonté à 50 chaque mois ; annuel = allocation
-- mensuelle versée chaque mois de la période payée.
create function private.billing_refill(p_user uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  acc private.billing_accounts%rowtype;
  st private.billing_settings%rowtype;
  offer private.billing_offers%rowtype;
  bal integer;
  n integer := 0;
begin
  perform private.billing_ensure_account(p_user);
  select * into st from private.billing_settings where id;
  select * into acc from private.billing_accounts where user_id = p_user for update;
  if acc.next_refill_at is null or acc.next_refill_at > now() then return; end if;
  if acc.tier = 'gratuit' then
    select balance into bal from public.credit_accounts where user_id = p_user for update;
    insert into private.credit_grants (grant_key, user_id, reason, requested, credits, balance_after)
    values ('free:' || p_user || ':' || private.toronto_period(), p_user, 'free_refill', 50, greatest(0, 50 - bal), greatest(bal, 50))
    on conflict (grant_key) do nothing;
    if found and bal < 50 then
      update public.credit_accounts set balance = 50 where user_id = p_user;
    end if;
    update private.billing_accounts set next_refill_at = private.billing_next_month_start(), updated_at = now() where user_id = p_user;
    return;
  end if;
  select * into offer from private.billing_offers where offer_key = acc.offer_key and mode = coalesce(st.mode, 'test');
  if not found or offer.billing_interval <> 'year' then return; end if;
  while acc.next_refill_at <= now() and (acc.current_period_end is null or acc.next_refill_at < acc.current_period_end) and n < 13 loop
    perform private.billing_grant_plan(p_user, 'annual:' || acc.stripe_subscription_id || ':' || to_char(acc.next_refill_at at time zone 'UTC', 'YYYY-MM-DD'),
      offer.credits, 'plan', offer.offer_key);
    acc.next_refill_at := acc.next_refill_at + interval '1 month';
    n := n + 1;
  end loop;
  update private.billing_accounts set next_refill_at = acc.next_refill_at, updated_at = now() where user_id = p_user;
end $$;

-- Lecture du compte (navigateur) : palier, solde, état de l'abonnement et,
-- si le paiement est ouvert, les liens de paiement du mode configuré.
create function public.billing_status()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  acc private.billing_accounts%rowtype;
  st private.billing_settings%rowtype;
  bal integer;
  offers jsonb := '[]'::jsonb;
  alloc integer;
begin
  if uid is null then raise exception 'session_requise'; end if;
  perform private.billing_refill(uid);
  select * into acc from private.billing_accounts where user_id = uid;
  select * into st from private.billing_settings where id;
  select balance into bal from public.credit_accounts where user_id = uid;
  select credits into alloc from private.billing_offers where offer_key = acc.offer_key and mode = coalesce(st.mode, 'test');
  if coalesce(st.checkout_enabled, false) then
    select coalesce(jsonb_agg(jsonb_build_object(
      'offer', o.offer_key, 'tier', o.tier, 'kind', o.kind, 'interval', o.billing_interval,
      'amount_minor', o.amount_minor, 'credits', o.credits, 'url', o.payment_link_url) order by o.amount_minor), '[]'::jsonb)
      into offers from private.billing_offers o where o.mode = st.mode;
  end if;
  return jsonb_build_object(
    'tier', acc.tier,
    'offer', acc.offer_key,
    'status', acc.subscription_status,
    'cancel_at_period_end', acc.cancel_at_period_end,
    'current_period_end', acc.current_period_end,
    'monthly_credits', case when acc.tier = 'gratuit' then 50 else alloc end,
    'next_refill_at', acc.next_refill_at,
    'balance', bal,
    'mode', coalesce(st.mode, 'test'),
    'checkout_enabled', coalesce(st.checkout_enabled, false),
    'portal_url', case when coalesce(st.checkout_enabled, false) then st.portal_url end,
    'offers', offers);
end $$;

revoke all on function private.hmac_sha256(bytea, bytea), private.stripe_webhook_secret(boolean),
  private.stripe_signature_ok(text, text, text, timestamptz), private.billing_next_month_start(timestamptz),
  private.billing_tier_rank(text), private.billing_ensure_account(uuid),
  private.billing_grant_plan(uuid, text, integer, text, text), private.billing_grant_pack(uuid, text, integer, text),
  private.billing_sync_tier(uuid), private.stripe_handle_event(jsonb), private.billing_refill(uuid)
  from public, anon, authenticated;
revoke all on function public.stripe_webhook_ingest(text, text), public.billing_status() from public, anon, authenticated;
grant execute on function public.stripe_webhook_ingest(text, text) to anon, service_role;
grant execute on function public.billing_status() to authenticated;
