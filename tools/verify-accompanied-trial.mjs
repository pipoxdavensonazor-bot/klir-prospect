// Targeted trial checks only: fixed segment, three allowed circles, receipt replay.
// Credentials remain outside the repository. Never uses a service key.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash,randomBytes} from 'node:crypto';
const dir=new URL('../../verification/',import.meta.url);
const text=await (await fetch('https://codex-pilot-readiness.klirprospect.klirline.ca/config.js')).text();
const cfg=JSON.parse(text.match(/=(\{.*\});/)[1]);
assert.equal(cfg.supabaseUrl,'https://pwakjxjjxswdjsapsbxn.supabase.co');assert.equal(cfg.environment,'preview');
const accounts=JSON.parse(await readFile(new URL('.overture-qa-accounts.json',dir),'utf8'));
async function call(path,body,token,method='POST'){
 const r=await fetch(cfg.supabaseUrl+path,{method,headers:{apikey:cfg.supabasePublishableKey,'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:body==null?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
 return {status:r.status,data:await r.json()};
}
const tokens=await Promise.all(accounts.map(async a=>{const r=await call('/auth/v1/token?grant_type=password',{email:a.email,password:a.password});assert.equal(r.status,200);return r.data.access_token;}));
const rpc=(name,body,token)=>call('/rest/v1/rpc/'+name,body,token);
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const workspaces=await Promise.all(tokens.map(t=>call('/rest/v1/workspace_states?select=payload',null,t,'GET')));
const before=await rpc('overture_account',{},tokens[0]);
const denied=await rpc('overture_begin',{p_receipt:'debit_'+randomBytes(12).toString('hex'),p_city:'montreal',p_sector:'sante',p_quantity:10},tokens[0]);
assert.equal(denied.status,400);assert.match(denied.data.message,/segment_essai/);
assert.equal((await rpc('overture_account',{},tokens[0])).data.balance,before.data.balance);
const old=await call('/rest/v1/overture_operations?status=eq.complete&order=created_at.asc&limit=1',null,tokens[0],'GET');assert.equal(old.status,200);assert.ok(old.data.length);
const replay=await rpc('overture_execute',{p_receipt:old.data[0].receipt},tokens[0]);assert.equal(replay.status,200);assert.equal(replay.data.replayed,true);assert.equal(hash(replay.data.features),hash(old.data[0].result.features));
assert.equal((await rpc('overture_account',{},tokens[0])).data.balance,before.data.balance);
const observations=[];
for(const city of ['montreal','laval','quebec']){
 const receipt='debit_'+randomBytes(12).toString('hex');
 const begin=await rpc('overture_begin',{p_receipt:receipt,p_city:city,p_sector:'restauration',p_quantity:10},tokens[1]);assert.equal(begin.status,200,JSON.stringify(begin.data));
 const run=await rpc('overture_execute',{p_receipt:receipt},tokens[1]);assert.equal(run.status,200);assert.equal(run.data.state,'complete');assert.equal(run.data.revision,'trial-restaurants-v2');
 for(const row of run.data.features){const p=row.feature.properties;const cats=[p.basic_category,p.taxonomy?.primary,...(p.taxonomy?.hierarchy||[])].filter(Boolean);
 assert.ok(cats.some(c=>['restaurant','cafe','coffee_shop','fast_food_restaurant'].includes(c))||(!cats.length&&row.review?.status==='review'));
 assert.notEqual(p.operating_status,'permanently_closed');}
 observations.push({city,count:run.data.features.length,review_annotations:run.data.features.filter(r=>r.review).length,revision:run.data.revision,charged:run.data.charged});
}
const after=await Promise.all(tokens.map(t=>call('/rest/v1/workspace_states?select=payload',null,t,'GET')));
assert.equal(hash(after.map(x=>x.data)),hash(workspaces.map(x=>x.data)));
const privateRead=await call('/rest/v1/overture_snapshot_places?select=*',null,tokens[0],'GET');assert.ok([403,404].includes(privateRead.status));
const report={recordedAt:new Date().toISOString(),testProject:'pwakjxjjxswdjsapsbxn',purpose:'Targeted regression of explicit restaurant segment, not a general benchmark',other_sector_rejected:true,rejection_no_debit:true,old_receipt_replayed_exact_features:true,replay_no_debit:true,workspaces_unchanged:true,private_snapshot_not_exposed:true,observations};
await writeFile(new URL('overture-benchmark/accompanied-trial-api.json',dir),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
