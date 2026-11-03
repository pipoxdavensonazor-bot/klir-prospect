import test from 'node:test';
import assert from 'node:assert/strict';
import {createStripeTestWebhook} from '../supabase/functions/_shared/stripe-test-candidate.mjs';

function fixture(overrides={}) {
  const event={id:'evt_fixture',livemode:false,type:'checkout.session.completed',data:{object:{id:'cs_test_fixture'}}};
  const session={id:'cs_test_fixture',livemode:false,mode:'payment',status:'complete',payment_status:'paid',amount_total:4900,currency:'cad',payment_intent:'pi_test_fixture'};
  const order={id:'order_fixture',sessionId:session.id,userId:'user_fixture',offerId:'offer_fixture',amountMinor:4900,currency:'cad'};
  const applied=new Set();let calls=0,retrievals=0;
  const deps={
    verifySignature:async(_raw,signature)=>{if(signature!=='valid-fixture')throw new Error('private');return event;},
    retrieveSession:async()=>{retrievals++;return session;},findOrder:async()=>order,
    applyPaidAtomically:async({orderId})=>{calls++;if(applied.has(orderId))return {outcome:'duplicate'};applied.add(orderId);return {outcome:'applied'};},
    ...overrides
  };
  return {event,session,order,handler:createStripeTestWebhook(deps),applied,get calls(){return calls;},get retrievals(){return retrievals;}};
}
const invoke=(f,signature='valid-fixture')=>f.handler({rawBody:'synthetic-event-only',signature});

test('notification non authentifiée ou mode réel ne déclenche aucune activation',async()=>{
  const f=fixture();assert.equal((await invoke(f,'invalid')).status,400);assert.equal(f.retrievals,0);
  f.event.livemode=true;assert.equal((await invoke(f)).status,400);assert.equal(f.calls,0);
});
test('paiement confirmé, doublon et notifications concurrentes utilisent le contrat atomique',async()=>{
  const f=fixture();const results=await Promise.all([invoke(f),invoke(f)]);
  assert.deepEqual(results.map(x=>x.outcome).sort(),['applied','duplicate']);assert.equal(f.applied.size,1);
  f.event.id='evt_second_fixture';assert.equal((await invoke(f)).outcome,'duplicate');
});
test('paiement refusé, en attente, interrompu ou session inconnue ne donnent aucun accès',async()=>{
  const f=fixture();for(const status of ['unpaid','no_payment_required']){f.session.payment_status=status;assert.equal((await invoke(f)).outcome,'not_paid');}
  f.session.payment_status='paid';f.session.status='open';assert.equal((await invoke(f)).outcome,'not_paid');
  f.event.type='checkout.session.async_payment_failed';assert.equal((await invoke(f)).outcome,'not_fulfilled');assert.equal(f.calls,0);
});
test('montant, devise ou compte sans commande serveur ne sont pas acceptés',async()=>{
  const f=fixture();f.session.amount_total++;assert.equal((await invoke(f)).outcome,'order_mismatch');
  f.session.amount_total--;f.session.currency='usd';assert.equal((await invoke(f)).outcome,'order_mismatch');
  f.session.currency='cad';f.order.userId='';assert.equal((await invoke(f)).outcome,'order_mismatch');assert.equal(f.calls,0);
});
test('panne du registre renvoie une erreur permettant une nouvelle tentative',async()=>{
  const f=fixture({applyPaidAtomically:async()=>{throw new Error('sensitive-fixture');}});
  assert.deepEqual(await invoke(f),{status:503,outcome:'retry_required'});
});
test('remboursements et litiges restent à rapprocher, jamais acquittés silencieusement',async()=>{
  const f=fixture();
  for(const type of ['charge.refunded','charge.refund.updated','refund.created','refund.updated','refund.failed','charge.dispute.created','charge.dispute.closed']){
    f.event.type=type;assert.deepEqual(await invoke(f),{status:503,outcome:'reconciliation_required'});
  }
  assert.equal(f.calls,0);
});
test('un remboursement intégral révoque une fois, un montant partiel non',async()=>{
  const refunds=[];
  const f=fixture({
    findRefundOrder:async()=>({id:'order_fixture',paymentIntent:'pi_test_fixture',amountMinor:4900}),
    applyRefundAtomically:async(request)=>{refunds.push(request);return refunds.length===1?{outcome:'applied'}:{outcome:'duplicate'};}
  });
  f.event.type='charge.refunded';
  f.event.data.object={payment_intent:'pi_test_fixture',amount_refunded:4900};
  assert.equal((await invoke(f)).outcome,'applied');
  f.event.id='evt_refund_again';
  assert.equal((await invoke(f)).outcome,'duplicate');
  f.event.data.object.amount_refunded=1000;
  assert.equal((await invoke(f)).outcome,'reconciliation_required');
  assert.equal(refunds.length,2);
  assert.equal(f.calls,0);
});
