-- Packs de crédits réservés aux forfaits payants.
-- 1. billing_status n'expose plus les liens de paiement des packs à un compte
--    Gratuit (blocage au moment du paiement : le lien n'est jamais remis).
-- 2. Webhook : un pack payé par un compte Gratuit (lien copié, ancien onglet)
--    est quand même crédité, sans remboursement automatique, et marqué
--    « pack_granted_review » dans private.stripe_events pour revue manuelle.
-- Seule la branche pack de stripe_handle_event change (copie conforme sinon).

create or replace function private.stripe_handle_event(p_event jsonb)
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
      -- Le client a payé : on crédite toujours, sans remboursement automatique.
      -- Achat hors forfait payant : résultat « pack_granted_review » consigné
      -- dans private.stripe_events pour revue manuelle.
      select * into acc from private.billing_accounts where user_id = uid;
      granted := private.billing_grant_pack(uid, 'pack:' || (obj ->> 'id'), offer.credits, offer.offer_key);
      if granted is null then return 'duplicate'; end if;
      return case when coalesce(acc.tier, 'gratuit') = 'gratuit' then 'pack_granted_review' else 'pack_granted' end;
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


create or replace function public.billing_status()
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
  perform private.expire_credit_lots(uid);
  perform private.billing_refill(uid);
  select * into acc from private.billing_accounts where user_id = uid;
  select * into st from private.billing_settings where id;
  select balance into bal from public.credit_accounts where user_id = uid;
  select credits into alloc from private.billing_offers where offer_key = acc.offer_key and mode = coalesce(st.mode, 'test');
  if coalesce(st.checkout_enabled, false) then
    select coalesce(jsonb_agg(jsonb_build_object(
      'offer', o.offer_key, 'tier', o.tier, 'kind', o.kind, 'interval', o.billing_interval,
      'amount_minor', o.amount_minor, 'credits', o.credits, 'url', o.payment_link_url) order by o.amount_minor), '[]'::jsonb)
      into offers from private.billing_offers o
     where o.mode = st.mode and (o.kind <> 'pack' or coalesce(acc.tier, 'gratuit') <> 'gratuit');
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

revoke all on function private.stripe_handle_event(jsonb) from public, anon, authenticated;
revoke all on function public.billing_status() from public, anon;
grant execute on function public.billing_status() to authenticated;
