// Dedicated disposable QA account only. Two real Auth sessions; no user workspace touched.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
const dir=new URL('../../verification/',import.meta.url);
const raw=await (await fetch('https://codex-pilot-readiness.klirprospect.klirline.ca/config.js')).text();const cfg=JSON.parse(raw.match(/=(\{.*\});/)[1]);assert.equal(cfg.supabaseUrl,'https://pwakjxjjxswdjsapsbxn.supabase.co');
const qa=JSON.parse(await readFile(new URL('.overture-qa-accounts.json',dir),'utf8'))[0];assert.match(qa.email,/^qa-overture-a-.*@example.invalid$/);
async function call(path,body,token,method='POST'){
 const r=await fetch(cfg.supabaseUrl+path,{method,headers:{apikey:cfg.supabasePublishableKey,'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:body==null?undefined:JSON.stringify(body),signal:AbortSignal.timeout(20000)});return {status:r.status,ok:r.ok,data:await r.json()};
}
async function login(){const r=await call('/auth/v1/token?grant_type=password',{email:qa.email,password:qa.password});assert.ok(r.ok);return r.data.access_token;}
const tokens=await Promise.all([login(),login()]);assert.notEqual(tokens[0],tokens[1]);
const read=async()=>{const r=await call('/rest/v1/workspace_states?select=payload,revision',null,tokens[0],'GET');assert.ok(r.ok);return r.data[0];};
const original=await read();assert.ok(original.payload.crm.length);await writeFile(new URL('.workspace-cas-baseline-private.json',dir),JSON.stringify(original));
const variants=['A','B'].map(letter=>{const p=structuredClone(original.payload);p.crm[0].nextAction='TEST concurrence '+letter+' — aucun contact';p.crm[0].log.push({t:'Note : TEST concurrence '+letter,at:'fixture contrôlée'});return p;});
let report={qa_only:true,two_auth_sessions:true};let expectedWinner=null;
try{
 const results=await Promise.all(tokens.map((t,i)=>call('/rest/v1/rpc/workspace_save',{p_expected_revision:original.revision,p_payload:variants[i]},t)));
 assert.equal(results.filter(r=>r.ok).length,1);const winner=results.findIndex(r=>r.ok),loser=1-winner;expectedWinner=variants[winner];assert.equal(results[loser].data.code,'PT409');
 const after=await read();assert.equal(after.payload.crm[0].nextAction,variants[winner].crm[0].nextAction);assert.equal(variants[loser].crm[0].log.at(-1).t,'Note : TEST concurrence '+['A','B'][loser]);
 const duplicate=await call('/rest/v1/rpc/workspace_save',{p_expected_revision:original.revision,p_payload:variants[winner]},tokens[winner]);assert.ok(duplicate.ok);assert.equal(duplicate.data.replayed,true);
 const tooLarge=await call('/rest/v1/rpc/workspace_save',{p_expected_revision:after.revision,p_payload:{large:Array.from({length:490},()=> 'x'.repeat(4900))}},tokens[0]);assert.equal(tooLarge.data.message,'payload_too_large');assert.equal((await read()).revision,after.revision);
 const bypass=await call('/rest/v1/workspace_states?user_id=eq.'+qa.id,{payload:{}},tokens[0],'PATCH');assert.equal(bypass.status,403);
 report={...report,one_write_accepted:true,other_write_rejected:results[loser].status,conflict_sqlstate:'PT409',winner_note_action_retained:true,loser_payload_retained_in_test:true,identical_retry_replayed:true,oversize_rejected_without_mutation:true,direct_write_bypass_denied:true};
}finally{
 if(!expectedWinner){const possible=await read();const candidate=variants.find(v=>JSON.stringify(v)===JSON.stringify(possible.payload));if(candidate)expectedWinner=candidate;}
 if(expectedWinner){const now=await read();assert.deepEqual(now.payload,expectedWinner,'External QA changes detected; refusing to overwrite.');const restored=await call('/rest/v1/rpc/workspace_save',{p_expected_revision:now.revision,p_payload:original.payload},tokens[0]);assert.ok(restored.ok);assert.deepEqual((await read()).payload,original.payload);report.fixture_restored_exactly=true;}
}
report.recordedAt=new Date().toISOString();await writeFile(new URL('overture-benchmark/workspace-cas-hosted.json',dir),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
