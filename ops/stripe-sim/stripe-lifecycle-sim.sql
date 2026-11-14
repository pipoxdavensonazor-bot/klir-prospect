-- Simulation isolée (base restaurée locale, jamais Test/Prod) du cycle de facturation KlirProspect.
-- Appelle private.stripe_handle_event avec des événements Stripe synthétiques (livemode = mode de la base).
\set ON_ERROR_STOP 1
\pset format aligned
begin;
insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000','11111111-2222-4333-8444-555555555555','authenticated','authenticated','sim-a3@example.invalid', now(), now());
create temp table sim_log(step int, label text, outcome text, tier text, status text, cancel boolean, balance int);
create or replace function pg_temp.snap(p_step int, p_label text, p_outcome text) returns void language sql as $$
  insert into sim_log select p_step, p_label, p_outcome, b.tier, b.subscription_status, b.cancel_at_period_end,
    (select balance from public.credit_accounts where user_id='11111111-2222-4333-8444-555555555555')
  from private.billing_accounts b where b.user_id='11111111-2222-4333-8444-555555555555'
  union all select p_step, p_label, p_outcome, null, null, null, null
  where not exists (select 1 from private.billing_accounts where user_id='11111111-2222-4333-8444-555555555555');
$$;
do $$
declare
  u text := '11111111-2222-4333-8444-555555555555';
  link text := (select payment_link_id from private.billing_offers where offer_key='starter_month' and mode='live');
  price text := (select stripe_price_id from private.billing_offers where offer_key='starter_month' and mode='live');
  now_s bigint := extract(epoch from now())::bigint;
  o text;
  ev jsonb;
begin
  -- 1. Premier paiement (Payment Link Starter)
  ev := jsonb_build_object('id','evt_sim1','type','checkout.session.completed','livemode',true,'created',now_s,
    'data',jsonb_build_object('object',jsonb_build_object('id','cs_sim1','payment_status','paid','payment_link',link,
      'client_reference_id',u,'customer','cus_sim','subscription','sub_sim','invoice','in_sim1')));
  o := private.stripe_handle_event(ev); perform pg_temp.snap(1,'checkout.session.completed (Starter)',o);
  -- 2. invoice.paid du même premier paiement (doit être doublon)
  ev := jsonb_build_object('id','evt_sim2','type','invoice.paid','livemode',true,'created',now_s,
    'data',jsonb_build_object('object',jsonb_build_object('id','in_sim1','subscription','sub_sim','billing_reason','subscription_create','amount_paid',1900,
      'lines',jsonb_build_object('data',jsonb_build_array(jsonb_build_object('amount',1900,'price',jsonb_build_object('id',price),
        'period',jsonb_build_object('start',now_s,'end',now_s+2592000)))))));
  o := private.stripe_handle_event(ev); perform pg_temp.snap(2,'invoice.paid premier paiement (doublon attendu)',o);
  -- 3. Renouvellement mensuel
  ev := jsonb_set(jsonb_set(jsonb_set(ev,'{id}','"evt_sim3"'),'{data,object,id}','"in_sim2"'),'{data,object,billing_reason}','"subscription_cycle"');
  o := private.stripe_handle_event(ev); perform pg_temp.snap(3,'invoice.paid subscription_cycle (renouvellement)',o);
  -- 4. Rejeu du renouvellement
  o := private.stripe_handle_event(ev); perform pg_temp.snap(4,'invoice.paid rejoué (même facture)',o);
  -- 5. Échec de paiement : invoice.payment_failed puis abonnement past_due
  o := private.stripe_handle_event(jsonb_build_object('id','evt_sim5','type','invoice.payment_failed','livemode',true,'created',now_s,
    'data',jsonb_build_object('object',jsonb_build_object('id','in_sim3','subscription','sub_sim'))));
  perform pg_temp.snap(5,'invoice.payment_failed',o);
  ev := jsonb_build_object('id','evt_sim6','type','customer.subscription.updated','livemode',true,'created',now_s,
    'data',jsonb_build_object('object',jsonb_build_object('id','sub_sim','status','past_due','cancel_at_period_end',false,
      'items',jsonb_build_object('data',jsonb_build_array(jsonb_build_object('price',jsonb_build_object('id',price),'current_period_end',now_s+2592000))))));
  o := private.stripe_handle_event(ev); perform pg_temp.snap(6,'customer.subscription.updated past_due',o);
  -- 7. Paiement rétabli puis annulation demandée dans le portail (fin de période)
  ev := jsonb_set(jsonb_set(jsonb_set(ev,'{id}','"evt_sim7"'),'{data,object,status}','"active"'),'{data,object,cancel_at_period_end}','true');
  o := private.stripe_handle_event(ev); perform pg_temp.snap(7,'customer.subscription.updated cancel_at_period_end',o);
  -- 8. Fin de période : abonnement supprimé
  ev := jsonb_set(jsonb_set(ev,'{id}','"evt_sim8"'),'{type}','"customer.subscription.deleted"');
  o := private.stripe_handle_event(ev); perform pg_temp.snap(8,'customer.subscription.deleted',o);
  -- 9. Remboursement
  o := private.stripe_handle_event(jsonb_build_object('id','evt_sim9','type','charge.refunded','livemode',true,'created',now_s,
    'data',jsonb_build_object('object',jsonb_build_object('id','ch_sim','amount_refunded',1900))));
  perform pg_temp.snap(9,'charge.refunded',o);
  -- 10-13. Isolation : événements d'un autre produit Klirline sur le même compte Stripe
  o := private.stripe_handle_event(jsonb_build_object('id','evt_sim10','type','checkout.session.completed','livemode',true,'created',now_s,
    'data',jsonb_build_object('object',jsonb_build_object('id','cs_other','payment_status','paid','payment_link','plink_AutreProduitKlirline',
      'client_reference_id',u,'customer','cus_other','subscription','sub_other','invoice','in_other'))));
  perform pg_temp.snap(10,'autre produit : checkout.session.completed',o);
  o := private.stripe_handle_event(jsonb_build_object('id','evt_sim11','type','invoice.paid','livemode',true,'created',now_s,
    'data',jsonb_build_object('object',jsonb_build_object('id','in_other','subscription','sub_other','billing_reason','subscription_cycle',
      'parent',jsonb_build_object('subscription_details',jsonb_build_object('metadata',jsonb_build_object('project','klirmarket')))))));
  perform pg_temp.snap(11,'autre produit : invoice.paid',o);
  o := private.stripe_handle_event(jsonb_build_object('id','evt_sim12','type','customer.subscription.deleted','livemode',true,'created',now_s,
    'data',jsonb_build_object('object',jsonb_build_object('id','sub_other','status','canceled'))));
  perform pg_temp.snap(12,'autre produit : customer.subscription.deleted',o);
  o := private.stripe_handle_event(jsonb_build_object('id','evt_sim13','type','checkout.session.completed','livemode',false,'created',now_s,
    'data',jsonb_build_object('object',jsonb_build_object('id','cs_test','payment_status','paid','payment_link',link,'client_reference_id',u))));
  perform pg_temp.snap(13,'événement mode test sur base live',o);
end $$;
select * from sim_log order by step;
select reason, offer_key, requested, credits, balance_after from private.credit_grants where user_id='11111111-2222-4333-8444-555555555555' order by created_at;
rollback;
