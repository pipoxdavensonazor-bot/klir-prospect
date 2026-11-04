import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

test('la provenance originale Overture survit au nettoyage du compte sans enrichissement',async()=>{
  const sandbox={TextEncoder,TextDecoder,btoa,atob,console};sandbox.window=sandbox;
  vm.createContext(sandbox);
  for(const file of ['security.js','data.js','overture.js'])vm.runInContext(await readFile(new URL('../src/'+file,import.meta.url),'utf8'),sandbox);
  const f={id:'published-id',type:'Feature',geometry:{type:'Point',coordinates:[-73.56,45.5]},properties:{names:{primary:'Café A & B'},version:2,websites:['https://example.org/a?b=1&c=2','https://example.org/other'],phones:['111','222'],sources:[{record_id:'a&b',license:'CC0-1.0',property:'/names'}]}};
  const mapped=sandbox.KlirOverture.mapRow({feature:f,review:{status:'review'}},'restauration',{release:'2026-10-21.0',state:'complete'});
  assert.equal(mapped.public_email,'');assert.equal(mapped.phone,'');assert.equal(mapped.website,'');assert.equal(mapped.employee_range,null);
  const persisted=sandbox.KlirSecurity.cleanState({prospects:[mapped]});
  const decoded=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(persisted.prospects[0].overture_payload_b64),c=>c.charCodeAt(0))));
  assert.deepEqual(decoded,f);
});

test('un candidat Overture sans audit ne reçoit pas une opportunité commerciale présumée',async()=>{
  const sandbox={KlirStore:{S:{searches:[]}},console};sandbox.window=sandbox;
  vm.createContext(sandbox);
  vm.runInContext(await readFile(new URL('../src/opportunity.js',import.meta.url),'utf8'),sandbox);
  const p={overture_id:'published',dq:100,conf:100,company_name:'Site absent',signals:[],opp_score:99};
  sandbox.OppEngine.ensure(p);
  assert.equal(p.opp_score,null);assert.equal(p.opp_priority,'INSUFFICIENT');
  sandbox.OppEngine.ensure(p);assert.equal(p.opp_score,null);
});
