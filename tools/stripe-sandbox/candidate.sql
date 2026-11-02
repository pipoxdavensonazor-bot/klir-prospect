-- FICTITIOUS SANDBOX CANDIDATE ONLY. Not a migration, never deploy as-is.
-- Stripe verification and order creation happen in a trusted server adapter;
-- this file does not enable sales, spend credits, or gate Overture searches.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table private.stripe_test_orders (
  id uuid primary key,
  user_id uuid not null references auth.users(id),
  session_id text not null unique check (session_id ~ '^cs_test_[A-Za-z0-9_]+$'),
  offer_id text not null,
  amount_minor bigint not null check(amount_minor > 0),
  currency text not null check(currency ~ '^[a-z]{3}$'),
  credits integer not null check(credits > 0),
  duration_days integer not null check(duration_days between 1 and 365),
  status text not null default 'pending' check(status in ('pending','paid','refunded')),
  activated_at timestamptz,
  expires_at timestamptz
);

create table private.stripe_test_events (
  event_id text primary key check(event_id ~ '^evt_[A-Za-z0-9_]+$'),
  order_id uuid not null references private.stripe_test_orders(id),
  event_type text not null check(event_type in ('paid','refunded')),
  created_at timestamptz not null default clock_timestamp()
);

create table private.stripe_test_entitlements (
  order_id uuid primary key references private.stripe_test_orders(id),
  user_id uuid not null references auth.users(id),
  credits integer not null check(credits > 0),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  revoked_at timestamptz,
  check(ends_at > starts_at)
);

revoke all on private.stripe_test_orders, private.stripe_test_events, private.stripe_test_entitlements from public, anon, authenticated;

create function private.stripe_test_apply_paid(p_order uuid, p_session text, p_event text)
returns text language plpgsql security definer set search_path='' as $$
declare o private.stripe_test_orders%rowtype; prior private.stripe_test_events%rowtype; started timestamptz;
begin
  select * into o from private.stripe_test_orders where id=p_order and session_id=p_session for update;
  if not found then raise exception 'order_not_found'; end if;
  insert into private.stripe_test_events(event_id,order_id,event_type) values(p_event,p_order,'paid') on conflict do nothing;
  if not found then
    select * into prior from private.stripe_test_events where event_id=p_event;
    if prior.order_id<>p_order or prior.event_type<>'paid' then raise exception 'event_mismatch'; end if;
    return 'duplicate';
  end if;
  if o.status='paid' then return 'duplicate'; end if;
  if o.status<>'pending' then raise exception 'order_not_pending'; end if;
  started:=clock_timestamp();
  update private.stripe_test_orders set status='paid',activated_at=started,expires_at=started+make_interval(days=>o.duration_days) where id=p_order;
  insert into private.stripe_test_entitlements(order_id,user_id,credits,starts_at,ends_at)
    values(p_order,o.user_id,o.credits,started,started+make_interval(days=>o.duration_days));
  return 'applied';
end $$;

create function private.stripe_test_refund_full(p_order uuid, p_event text, p_refunded_minor bigint)
returns text language plpgsql security definer set search_path='' as $$
declare o private.stripe_test_orders%rowtype; prior private.stripe_test_events%rowtype;
begin
  select * into o from private.stripe_test_orders where id=p_order for update;
  if not found or o.status not in ('paid','refunded') then raise exception 'order_not_paid'; end if;
  if p_refunded_minor is null or p_refunded_minor<>o.amount_minor then raise exception 'refund_needs_review'; end if;
  insert into private.stripe_test_events(event_id,order_id,event_type) values(p_event,p_order,'refunded') on conflict do nothing;
  if not found then
    select * into prior from private.stripe_test_events where event_id=p_event;
    if prior.order_id<>p_order or prior.event_type<>'refunded' then raise exception 'event_mismatch'; end if;
    return 'duplicate';
  end if;
  if o.status='refunded' then return 'duplicate'; end if;
  update private.stripe_test_orders set status='refunded' where id=p_order;
  update private.stripe_test_entitlements set revoked_at=clock_timestamp() where order_id=p_order;
  return 'applied';
end $$;

revoke all on function private.stripe_test_apply_paid(uuid,text,text),private.stripe_test_refund_full(uuid,text,bigint) from public,anon,authenticated;
grant usage on schema private to service_role;
grant execute on function private.stripe_test_apply_paid(uuid,text,text),private.stripe_test_refund_full(uuid,text,bigint) to service_role;
