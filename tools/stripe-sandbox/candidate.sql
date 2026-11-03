-- Bac à sable isolé. Même règles que la migration 20261103010000, plus la table
-- de crédits minimale quand les migrations précédentes ne sont pas chargées.
create table if not exists public.credit_accounts (
  user_id uuid primary key references auth.users(id),
  balance integer not null default 0,
  usage_period text not null,
  searches_used integer not null default 0,
  updated_at timestamptz not null default now()
);
grant select on public.credit_accounts to service_role;
-- Prévisualisation Test uniquement. Ne pas appliquer sur la production
-- cbklwmjudobqwbkbxqgy. Les fonctions restent réservées à service_role :
-- le navigateur ne choisit ni le prix, ni les crédits, ni l'activation.
-- L'achat reste fermé tant que la fonction n'est pas déployée avec des clés sk_test_.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table private.stripe_test_orders (
  id uuid primary key,
  user_id uuid not null references auth.users(id),
  session_id text unique check (session_id is null or session_id ~ '^cs_test_[A-Za-z0-9_]+$'),
  checkout_url text check (checkout_url is null or checkout_url ~ '^https://checkout\.stripe\.com/'),
  payment_intent text unique check (payment_intent is null or payment_intent ~ '^pi_test_[A-Za-z0-9_]+$'),
  offer_id text not null check (offer_id = 'klirprospect-pilot-demo'),
  amount_minor bigint not null check (amount_minor = 4900),
  currency text not null check (currency = 'cad'),
  credits integer not null check (credits = 90),
  duration_days integer not null check (duration_days = 30),
  status text not null default 'pending' check (status in ('pending', 'paid', 'refunded')),
  refund_shortfall integer not null default 0 check (refund_shortfall >= 0),
  activated_at timestamptz,
  expires_at timestamptz
);

create unique index stripe_test_one_pending_order
  on private.stripe_test_orders (user_id)
  where status = 'pending';

create table private.stripe_test_events (
  event_id text primary key check (event_id ~ '^evt_[A-Za-z0-9_]+$'),
  order_id uuid not null references private.stripe_test_orders(id),
  event_type text not null check (event_type in ('paid', 'refunded')),
  created_at timestamptz not null default clock_timestamp()
);

create table private.stripe_test_entitlements (
  order_id uuid primary key references private.stripe_test_orders(id),
  user_id uuid not null references auth.users(id),
  credits integer not null check (credits = 90),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  revoked_at timestamptz,
  check (ends_at > starts_at)
);

revoke all on private.stripe_test_orders, private.stripe_test_events, private.stripe_test_entitlements from public, anon, authenticated;

create function private.stripe_test_apply_paid(p_order uuid, p_session text, p_event text, p_payment_intent text default null)
returns text language plpgsql security definer set search_path = '' as $$
declare o private.stripe_test_orders%rowtype; prior private.stripe_test_events%rowtype; started timestamptz;
begin
  if p_payment_intent is not null and p_payment_intent !~ '^pi_test_[A-Za-z0-9_]+$' then
    raise exception 'payment_intent_invalid';
  end if;
  select * into o from private.stripe_test_orders where id = p_order and session_id = p_session for update;
  if not found then raise exception 'order_not_found'; end if;
  insert into private.stripe_test_events(event_id, order_id, event_type) values (p_event, p_order, 'paid') on conflict do nothing;
  if not found then
    select * into prior from private.stripe_test_events where event_id = p_event;
    if prior.order_id <> p_order or prior.event_type <> 'paid' then raise exception 'event_mismatch'; end if;
    return 'duplicate';
  end if;
  if o.status = 'paid' then return 'duplicate'; end if;
  if o.status <> 'pending' then raise exception 'order_not_pending'; end if;
  started := clock_timestamp();
  update private.stripe_test_orders
    set status = 'paid', activated_at = started, expires_at = started + make_interval(days => o.duration_days),
        payment_intent = coalesce(p_payment_intent, payment_intent)
    where id = p_order;
  insert into private.stripe_test_entitlements(order_id, user_id, credits, starts_at, ends_at)
    values (p_order, o.user_id, o.credits, started, started + make_interval(days => o.duration_days));
  insert into public.credit_accounts(user_id, balance, usage_period, searches_used)
    values (o.user_id, 0, to_char(clock_timestamp() at time zone 'America/Toronto', 'YYYY-MM'), 0)
    on conflict (user_id) do nothing;
  update public.credit_accounts set balance = balance + o.credits where user_id = o.user_id;
  return 'applied';
end $$;

create function private.stripe_test_refund_full(p_order uuid, p_event text, p_refunded_minor bigint)
returns text language plpgsql security definer set search_path = '' as $$
declare
  o private.stripe_test_orders%rowtype;
  prior private.stripe_test_events%rowtype;
  bal integer;
  shortfall integer := 0;
begin
  select * into o from private.stripe_test_orders where id = p_order for update;
  if not found or o.status not in ('paid', 'refunded') then raise exception 'order_not_paid'; end if;
  if p_refunded_minor is null or p_refunded_minor <> o.amount_minor then raise exception 'refund_needs_review'; end if;
  insert into private.stripe_test_events(event_id, order_id, event_type) values (p_event, p_order, 'refunded') on conflict do nothing;
  if not found then
    select * into prior from private.stripe_test_events where event_id = p_event;
    if prior.order_id <> p_order or prior.event_type <> 'refunded' then raise exception 'event_mismatch'; end if;
    if o.refund_shortfall > 0 then return 'review'; end if;
    return 'duplicate';
  end if;
  if o.status = 'refunded' then
    if o.refund_shortfall > 0 then return 'review'; end if;
    return 'duplicate';
  end if;
  select balance into bal from public.credit_accounts where user_id = o.user_id for update;
  if not found then raise exception 'refund_needs_review'; end if;
  if bal < o.credits then
    shortfall := o.credits - bal;
    update public.credit_accounts set balance = 0 where user_id = o.user_id;
  else
    update public.credit_accounts set balance = balance - o.credits where user_id = o.user_id;
  end if;
  update private.stripe_test_orders set status = 'refunded', refund_shortfall = shortfall where id = p_order;
  update private.stripe_test_entitlements set revoked_at = clock_timestamp() where order_id = p_order and revoked_at is null;
  if shortfall > 0 then return 'review'; end if;
  return 'applied';
end $$;

create function public.stripe_test_begin_order(p_user uuid, p_order uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare existing private.stripe_test_orders%rowtype;
begin
  if p_user is null or p_order is null then raise exception 'session_requise'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(p_user::text)::bigint);
  select * into existing from private.stripe_test_orders
    where user_id = p_user and status = 'pending' and offer_id = 'klirprospect-pilot-demo'
    order by id for update;
  if found then
    return jsonb_build_object('order_id', existing.id, 'session_id', existing.session_id, 'url', existing.checkout_url);
  end if;
  insert into private.stripe_test_orders(id, user_id, offer_id, amount_minor, currency, credits, duration_days)
    values (p_order, p_user, 'klirprospect-pilot-demo', 4900, 'cad', 90, 30);
  return jsonb_build_object('order_id', p_order, 'session_id', null, 'url', null);
end $$;

create function public.stripe_test_attach_session(p_order uuid, p_user uuid, p_session text, p_url text)
returns text language plpgsql security definer set search_path = '' as $$
declare o private.stripe_test_orders%rowtype;
begin
  if p_session !~ '^cs_test_[A-Za-z0-9_]+$' or p_url !~ '^https://checkout\.stripe\.com/' then
    raise exception 'invalid_session';
  end if;
  select * into o from private.stripe_test_orders where id = p_order and user_id = p_user for update;
  if not found or o.status <> 'pending' or o.amount_minor <> 4900 or o.currency <> 'cad' or o.credits <> 90 then
    raise exception 'order_mismatch';
  end if;
  if o.session_id is not null then
    if o.session_id = p_session then return 'duplicate'; end if;
    raise exception 'order_mismatch';
  end if;
  update private.stripe_test_orders set session_id = p_session, checkout_url = p_url where id = p_order;
  return 'attached';
end $$;

create function public.stripe_test_find_order(p_session text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare o private.stripe_test_orders%rowtype;
begin
  select * into o from private.stripe_test_orders where session_id = p_session;
  if not found then return null; end if;
  return jsonb_build_object(
    'id', o.id, 'user_id', o.user_id, 'session_id', o.session_id, 'offer_id', o.offer_id,
    'amount_minor', o.amount_minor, 'currency', o.currency, 'payment_intent', o.payment_intent
  );
end $$;

create function public.stripe_test_find_refund(p_payment_intent text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare o private.stripe_test_orders%rowtype;
begin
  select * into o from private.stripe_test_orders where payment_intent = p_payment_intent;
  if not found then return null; end if;
  return jsonb_build_object('id', o.id, 'payment_intent', o.payment_intent, 'amount_minor', o.amount_minor);
end $$;

create function public.stripe_test_read_access(p_user uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare bal integer; used integer; active boolean;
begin
  select balance, searches_used into bal, used from public.credit_accounts where user_id = p_user;
  select exists (
    select 1 from private.stripe_test_entitlements
    where user_id = p_user and revoked_at is null and starts_at <= clock_timestamp() and ends_at > clock_timestamp()
  ) into active;
  return jsonb_build_object('active', active, 'balance', bal, 'searches_used', used);
end $$;

create function public.stripe_test_apply_paid(p_order uuid, p_session text, p_event text, p_payment_intent text default null)
returns text language sql security definer set search_path = '' as $$
  select private.stripe_test_apply_paid(p_order, p_session, p_event, p_payment_intent);
$$;

create function public.stripe_test_refund_full(p_order uuid, p_event text, p_refunded_minor bigint)
returns text language sql security definer set search_path = '' as $$
  select private.stripe_test_refund_full(p_order, p_event, p_refunded_minor);
$$;

revoke all on function private.stripe_test_apply_paid(uuid, text, text, text), private.stripe_test_refund_full(uuid, text, bigint) from public, anon, authenticated;
revoke all on function public.stripe_test_apply_paid(uuid, text, text, text), public.stripe_test_refund_full(uuid, text, bigint) from public, anon, authenticated;
revoke all on function public.stripe_test_begin_order(uuid, uuid), public.stripe_test_attach_session(uuid, uuid, text, text),
  public.stripe_test_find_order(text), public.stripe_test_find_refund(text), public.stripe_test_read_access(uuid) from public, anon, authenticated;
grant usage on schema private to service_role;
grant execute on function private.stripe_test_apply_paid(uuid, text, text, text), private.stripe_test_refund_full(uuid, text, bigint) to service_role;
grant execute on function public.stripe_test_apply_paid(uuid, text, text, text), public.stripe_test_refund_full(uuid, text, bigint) to service_role;
grant execute on function public.stripe_test_begin_order(uuid, uuid), public.stripe_test_attach_session(uuid, uuid, text, text),
  public.stripe_test_find_order(text), public.stripe_test_find_refund(text), public.stripe_test_read_access(uuid) to service_role;
