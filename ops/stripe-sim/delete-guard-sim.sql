\set ON_ERROR_STOP 1
begin;
insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000','11111111-2222-4333-8444-555555555556','authenticated','authenticated','sim-del@example.invalid', now(), now());
select set_config('request.jwt.claims','{"sub":"11111111-2222-4333-8444-555555555556","role":"authenticated"}', true);
select 'gratuit' as cas, x->>'tier' tier, x->>'status' status, x->>'cancel_at_period_end' cancel from (select public.billing_status() x) s;
select private.stripe_handle_event(jsonb_build_object('id','evt_d1','type','checkout.session.completed','livemode',true,'created',extract(epoch from now())::bigint,
  'data',jsonb_build_object('object',jsonb_build_object('id','cs_d1','payment_status','paid',
  'payment_link',(select payment_link_id from private.billing_offers where offer_key='starter_month' and mode='live'),
  'client_reference_id','11111111-2222-4333-8444-555555555556','customer','cus_d','subscription','sub_d','invoice','in_d1')))) as outcome;
select 'starter actif' as cas, x->>'tier' tier, x->>'status' status, x->>'cancel_at_period_end' cancel from (select public.billing_status() x) s;
update private.stripe_subscriptions set cancel_at_period_end = true where subscription_id='sub_d';
select private.billing_sync_tier('11111111-2222-4333-8444-555555555556');
select 'starter annulé fin de période' as cas, x->>'tier' tier, x->>'status' status, x->>'cancel_at_period_end' cancel from (select public.billing_status() x) s;
rollback;
