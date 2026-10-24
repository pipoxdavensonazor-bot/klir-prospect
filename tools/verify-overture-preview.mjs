// Disposable QA accounts, dedicated test project only. No secrets in reports.
import assert from 'node:assert/strict';
import { readFile,writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
const dir=new URL('../../verification/',import.meta.url);
const cfg=JSON.parse(await readFile(new URL('.supabase-test-admin.json',dir),'utf8'));
assert.equal(cfg.url,'https://pwakjxjjxswdjsapsbxn.supabase.co');
const accountFile=new URL('.overture-qa-accounts.json',dir);
const reportFile=new URL('overture-benchmark/hosted-tests.json',dir);
const adminHeaders={apikey:cfg.key,Authorization:'Bearer '+cfg.key,'Content-Type':'application/json'};
async function call(path,body,token,method='POST',extraHeaders={}){
  const headers=token?{apikey:cfg.publishable,Authorization:'Bearer '+token,'Content-Type':'application/json'}:adminHeaders;
  const start=performance.now();
  const response=await fetch(cfg.url+path,{method,headers:{...headers,...extraHeaders},body:body==null?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
  const data=await response.json().catch(()=>null);
  return {status:response.status,ok:response.ok,data,ms:performance.now()-start};
}
async function rpc(name,body,token){return call('/rest/v1/rpc/'+name,body,token);}
const receipt=()=> 'debit_'+randomBytes(12).toString('hex');
async function login(a){const r=await call('/auth/v1/token?grant_type=password',{email:a.email,password:a.password},null);assert.equal(r.ok,true,JSON.stringify(r.data));return r.data.access_token;}
if(process.argv[2]==='setup'){
  let accounts;try{accounts=JSON.parse(await readFile(accountFile,'utf8'));}catch{}
  if(!accounts){
    accounts=[];
    for(const letter of ['a','b']){
      const a={email:`qa-overture-${letter}-20261023@example.invalid`,password:'Qa8!'+randomBytes(24).toString('base64url')};
      const r=await call('/auth/v1/admin/users',{email:a.email,password:a.password,email_confirm:true,user_metadata:{display_name:'TEST QA Overture '+letter.toUpperCase()}});
      assert.equal(r.ok,true,JSON.stringify(r.data));a.id=r.data.id;accounts.push(a);
      await writeFile(accountFile,JSON.stringify(accounts));
    }
  }
  const enabled=await rpc('overture_admin',{p_action:'enable'});assert.equal(enabled.ok,true,JSON.stringify(enabled.data));
  console.log(JSON.stringify({testProject:'pwakjxjjxswdjsapsbxn',qaAccounts:accounts.length,metrics:enabled.data}));
}else if(process.argv[2]==='coverage'){
  const accounts=JSON.parse(await readFile(accountFile,'utf8'));
  const tokens=await Promise.all(accounts.map(login));
  const observations=[];
  await rpc('overture_admin',{p_action:'clear_cache'});
  for(const phase of ['cold','warm','warm-repeat']){
    // Only disposable QA ledgers; production/user ledgers are never reset.
    for(const account of accounts){
      const reset=await call('/rest/v1/credit_accounts?user_id=eq.'+account.id,{balance:200,searches_used:0},null,'PATCH');assert.ok(reset.ok);
    }
    const cases=['montreal','laval','quebec'].flatMap(city=>['restauration','construction','sante'].map(sector=>({city,sector})));
    const wave=await Promise.all(cases.map(async(c,index)=>{
      const token=tokens[index%2],id=receipt(),started=performance.now();
      const begin=await rpc('overture_begin',{p_receipt:id,p_city:c.city,p_sector:c.sector,p_quantity:40},token);assert.ok(begin.ok,JSON.stringify(begin.data));
      const run=await rpc('overture_execute',{p_receipt:id},token);assert.ok(run.ok,JSON.stringify(run.data));
      const r=run.data;assert.equal(r.state,'complete');assert.ok(r.features.length<=40);
      assert.ok(!r.features.some(row=>['f7d4ae7d-7c80-45d2-bdcd-3722a8be2cc6','438d9378-8f63-494e-95d4-d91c2569d69a'].includes(row.feature.id)));
      return {...c,phase,state:r.state,count:r.features.length,cache_hit:r.cache_hit,server_ms:r.server_ms,execute_http_ms:run.ms,total_api_ms:performance.now()-started,
        response_json_bytes:Buffer.byteLength(JSON.stringify(r)),review_flagged:r.features.filter(x=>x.review).length,
        websites:r.features.filter(x=>x.feature.properties.websites?.length).length,phones:r.features.filter(x=>x.feature.properties.phones?.length).length,emails:r.features.filter(x=>x.feature.properties.emails?.length).length};
    }));
    observations.push(...wave);console.log(phase,JSON.stringify(wave));
  }
  const metrics=await rpc('overture_admin',{p_action:'metrics'});
  await writeFile(new URL('overture-benchmark/hosted-coverage.json',dir),JSON.stringify({recordedAt:new Date().toISOString(),simultaneous:9,observations,metrics:metrics.data,
    limits:'Three waves, nine concurrent API searches each. QA account balances/quotas reset only between these disposable benchmark waves. Cold means application cache cleared, not PostgreSQL/OS cache. Server_ms includes lock waits. response_json_bytes is serialized response size, not wire/egress bytes. No robust p95 or long-duration load claim.'},null,2));
}else if(process.argv[2]==='workspace'){
  const accounts=JSON.parse(await readFile(accountFile,'utf8'));
  const tokens=await Promise.all(accounts.map(login));
  const own=await Promise.all(tokens.map(t=>call('/rest/v1/workspace_states?select=user_id,payload',null,t,'GET')));
  assert.ok(own.every((r,i)=>r.ok&&r.data.length===1&&r.data[0].user_id===accounts[i].id));
  const payloads=own.map(r=>r.data[0].payload);
  assert.equal(payloads[0].crm.length,1);assert.equal(payloads[1].crm.length,1);
  assert.ok(payloads[0].crm[0].nextAction.includes('Contrôle A'));
  assert.ok(payloads[1].crm[0].nextAction.includes('Contrôle B'));
  assert.ok(payloads[0].crm[0].log.some(n=>n.t.includes('TEST QA A')));
  assert.ok(payloads[1].crm[0].log.some(n=>n.t.includes('TEST QA B')));
  const cross=await call('/rest/v1/workspace_states?select=payload&user_id=eq.'+accounts[1].id,null,tokens[0],'GET');
  assert.deepEqual(cross.data,[]);
  const spoof=await call('/rest/v1/workspace_states?on_conflict=user_id',{user_id:accounts[1].id,schema_version:1,payload:payloads[1]},tokens[0],'POST',{Prefer:'resolution=merge-duplicates,return=representation'});assert.equal(spoof.status,403);
  const originalChecks=[];
  for(const [i,payload] of payloads.entries()){
    const prospect=payload.prospects.find(p=>p.id===payload.crm[0].prospectId);
    const original=JSON.parse(Buffer.from(prospect.overture_payload_b64,'base64').toString('utf8'));
    const city=i===0?'montreal':'laval';
    const snapshot=JSON.parse(await readFile(new URL('overture-benchmark/'+city+'.geojson',dir),'utf8'));
    assert.deepEqual(original,snapshot.features.find(f=>f.id===prospect.overture_id));
    originalChecks.push({account:i,id:prospect.overture_id,exactOriginalAfterCloudSave:true});
  }
  const report=JSON.parse(await readFile(reportFile,'utf8'));
  report.results.push({name:'workspace_direct_isolation_and_cloud_persistence',passed:true,ownRows:own.map(r=>r.data.length),crmCounts:payloads.map(p=>p.crm.length),searchCounts:payloads.map(p=>p.searches.length),otherWorkspaceRead:cross.data.length,spoofedWrite:spoof.status,originalChecks});
  await writeFile(reportFile,JSON.stringify(report,null,2));console.log(JSON.stringify(report.results.at(-1)));
}else if(process.argv[2]==='expiry'){
  const accounts=JSON.parse(await readFile(accountFile,'utf8'));
  const pending=JSON.parse(await readFile(new URL('.overture-expiry-case.json',dir),'utf8'));
  assert.ok(Date.now()-Date.parse(pending.started)>61000,'Wait for actual server expiry');
  const token=await login(accounts[0]);
  const before=await call('/rest/v1/credit_accounts?select=balance&user_id=eq.'+accounts[0].id,null,token,'GET');
  const after=await rpc('overture_account',{},token);
  const replay=await rpc('overture_execute',{p_receipt:pending.receipt},token);
  assert.equal(after.data.balance,before.data[0].balance+9);
  assert.equal(replay.data.reason,'reservation_expired');
  const report=JSON.parse(await readFile(reportFile,'utf8'));
  report.results.push({name:'actual_expiry_refund',passed:true,elapsedSeconds:(Date.now()-Date.parse(pending.started))/1000,before:before.data[0].balance,after:after.data.balance,reason:replay.data.reason});
  await writeFile(reportFile,JSON.stringify(report,null,2));
  console.log(JSON.stringify(report.results.at(-1)));
}else if(process.argv[2]==='fixture'){
  const accounts=JSON.parse(await readFile(accountFile,'utf8'));
  const token=await login(accounts[1]);
  const state=process.argv[3];
  if(state==='reserve-error'){
    const id=receipt(); const reserved=await rpc('overture_begin',{p_receipt:id,p_city:'laval',p_sector:'construction',p_quantity:40},token);
    assert.ok(reserved.ok);await writeFile(new URL('.overture-error-receipt.json',dir),JSON.stringify({receipt:id}));console.log('reserved error fixture');
  }else{
    const id=state==='error'?JSON.parse(await readFile(new URL('.overture-error-receipt.json',dir),'utf8')).receipt:receipt();
    if(state!=='error')assert.ok((await rpc('overture_begin',{p_receipt:id,p_city:'laval',p_sector:'construction',p_quantity:40},token)).ok);
    const result=await rpc('overture_execute',{p_receipt:id},token);
    assert.equal(result.data.state,state);assert.equal(result.data.charged,0);
    const report=JSON.parse(await readFile(reportFile,'utf8'));
    report.results.push({name:'controlled_hosted_'+state,passed:true,charged:result.data.charged,balance:result.data.balance,features:result.data.features.length});
    await writeFile(reportFile,JSON.stringify(report,null,2));console.log(JSON.stringify(report.results.at(-1)));
  }
}else{
  const accounts=JSON.parse(await readFile(accountFile,'utf8'));assert.equal(accounts.length,2);
  const tokens=await Promise.all(accounts.map(login));
  const [a,b]=tokens;
  async function reset(i){const r=await call('/rest/v1/credit_accounts?user_id=eq.'+accounts[i].id,{balance:200,searches_used:0},null,'PATCH');assert.ok(r.ok);}
  await reset(0);await reset(1);
  const results=[];
  const check=(name,data)=>{results.push({name,...data});console.log(name,JSON.stringify(data));};
  const params={p_city:'quebec',p_sector:'construction',p_quantity:40};
  const id=receipt();
  const begins=await Promise.all([1,2].map(()=>rpc('overture_begin',{...params,p_receipt:id},a)));
  assert.ok(begins.every(r=>r.ok&&r.data.balance===191&&r.data.amount===9));
  const finishes=await Promise.all([1,2,3].map(()=>rpc('overture_execute',{p_receipt:id},a)));
  assert.ok(finishes.every(r=>r.ok&&r.data.state==='complete'&&r.data.balance===191&&r.data.searches_used===1));
  assert.ok(finishes.every(r=>!r.data.features.some(x=>x.feature.id==='f7d4ae7d-7c80-45d2-bdcd-3722a8be2cc6')));
  check('double_begin_concurrent_execute_and_retry',{passed:true,charged:9,searches:1,counts:finishes.map(r=>r.data.features.length)});
  const cross=await rpc('overture_execute',{p_receipt:id},b);assert.ok(!cross.ok);
  const privateRead=await call('/rest/v1/overture_places?select=*',null,a,'GET');assert.ok(!privateRead.ok);
  const change=await call('/rest/v1/overture_operations?receipt=eq.'+id,{status:'complete',amount:0},a,'PATCH');assert.ok(!change.ok);
  const legacy=await rpc('reserve_usage',{p_receipt:receipt(),p_amount:6,p_label:'Recherche'},a);assert.ok(!legacy.ok);
  const forged=await rpc('overture_begin',{...params,p_receipt:receipt(),p_amount:0,p_outcome:'complete'},a);assert.ok(!forged.ok);
  check('direct_isolation_and_forgery',{passed:true,crossReceipt:cross.status,privateCatalogue:privateRead.status,forgedUpdate:change.status,legacyClientLedger:legacy.status,forgedCostOutcome:forged.status});
  const expired=receipt(); await rpc('overture_begin',{...params,p_receipt:expired},a);
  await writeFile(new URL('.overture-expiry-case.json',dir),JSON.stringify({receipt:expired,started:new Date().toISOString(),user:accounts[0].id,balanceBefore:191}));
  check('interrupted_before_execution',{receipt:expired,reservationExpiresAfterSeconds:60,settlement:'pending real expiry observation'});
  // Independent users, two concurrent searches each; cache cleared between cold and warm wave.
  await rpc('overture_admin',{p_action:'clear_cache'});
  const timings=[];
  for(const temperature of ['cold','warm','warm-repeat']){
    const wave=await Promise.all(tokens.flatMap((token,i)=>[0,1].map(async j=>{
      const op=receipt(),p={p_receipt:op,p_city:['montreal','laval'][j],p_sector:'restauration',p_quantity:40};
      const start=performance.now();const begin=await rpc('overture_begin',p,token);assert.ok(begin.ok,JSON.stringify(begin.data));
      const run=await rpc('overture_execute',{p_receipt:op},token);assert.ok(run.ok,JSON.stringify(run.data));assert.equal(run.data.state,'complete');
      return {temperature,account:i,city:p.p_city,begin_ms:begin.ms,execute_http_ms:run.ms,server_ms:run.data.server_ms,cache_hit:run.data.cache_hit,end_to_end_api_ms:performance.now()-start,count:run.data.features.length};
    })));
    timings.push(...wave);
  }
  check('parallel_searches',{passed:true,simultaneous:4,observations:timings});
  const metrics=await rpc('overture_admin',{p_action:'metrics'});
  await writeFile(reportFile,JSON.stringify({recordedAt:new Date().toISOString(),results,metrics:metrics.data,limits:'API timing only, not browser user time. Cold means application cache cleared; Postgres/OS caches uncontrolled. No p95.'},null,2));
}
