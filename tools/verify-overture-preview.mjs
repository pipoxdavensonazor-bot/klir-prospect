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
async function call(path,body,token,method='POST'){
  const headers=token?{apikey:cfg.publishable,Authorization:'Bearer '+token,'Content-Type':'application/json'}:adminHeaders;
  const start=performance.now();
  const response=await fetch(cfg.url+path,{method,headers,body:body==null?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
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
