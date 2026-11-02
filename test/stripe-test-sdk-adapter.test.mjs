import test from 'node:test';
import assert from 'node:assert/strict';
import {createStripeTestSdkAdapter,STRIPE_TEST_API_VERSION} from '../supabase/functions/_shared/stripe-test-sdk-adapter.mjs';

function sdkFixture() {
  const calls=[];
  class FakeStripe {
    static createSubtleCryptoProvider(){return 'synthetic-crypto';}
    constructor(key,options){
      calls.push(['constructor',key,options]);
      this.webhooks={constructEventAsync:async(...args)=>{calls.push(['verify',...args]);return {livemode:false};}};
      this.checkout={sessions:{retrieve:async id=>{calls.push(['retrieve',id]);return {id};}}};
    }
  }
  return {FakeStripe,calls};
}

test('refuse toute clé réelle ou configuration incomplète sans divulguer le secret',()=>{
  const {FakeStripe}=sdkFixture();
  for(const key of ['sk_live_doNotPrint','rk_live_doNotPrint','',null]){
    assert.throws(()=>createStripeTestSdkAdapter({Stripe:FakeStripe,testSecretKey:key,webhookSecret:'whsec_fixture'}),
      error=>error.message==='Stripe test configuration unavailable'&&!error.message.includes('doNotPrint'));
  }
  assert.throws(()=>createStripeTestSdkAdapter({Stripe:FakeStripe,testSecretKey:'sk_test_fixture',webhookSecret:''}),/configuration unavailable/);
});

test('transmet le corps brut au SDK simulé et accepte seulement une session de test',async()=>{
  const {FakeStripe,calls}=sdkFixture();
  const adapter=createStripeTestSdkAdapter({Stripe:FakeStripe,testSecretKey:'sk_test_fixture',webhookSecret:'whsec_fixture'});
  const raw=' {"synthetic": true}\n';
  await adapter.verifySignature(raw,'signature-fictive');
  assert.equal(calls[0][2].apiVersion,STRIPE_TEST_API_VERSION);
  assert.deepEqual(calls[1],['verify',raw,'signature-fictive','whsec_fixture',undefined,'synthetic-crypto']);
  assert.equal((await adapter.retrieveSession('cs_test_fixture')).id,'cs_test_fixture');
  assert.throws(()=>adapter.retrieveSession('cs_live_fixture'),/Invalid test session/);
});
