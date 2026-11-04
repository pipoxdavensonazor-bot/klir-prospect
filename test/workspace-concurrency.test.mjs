import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
test('deux sessions : conflit explicite, reprise identique, 2 Mo et isolation',async()=>{
 const db=new PGlite();const uid='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',other='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
 try{
 await db.exec(`create schema auth;create table auth.users(id uuid primary key,raw_user_meta_data jsonb);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;create role anon;create role authenticated;create role service_role;grant usage on schema public,auth to authenticated,anon;`);
 for(const f of (await readdir(new URL('../supabase/migrations/',import.meta.url))).filter(f=>f.endsWith('.sql')).sort())await db.exec(await readFile(new URL('../supabase/migrations/'+f,import.meta.url),'utf8'));
 await db.query('insert into auth.users values($1,$3),($2,$3)',[uid,other,{}]);await db.query("select set_config('request.jwt.claim.sub',$1,false)",[uid]);await db.exec('set role authenticated');
 const save=async(version,payload)=>(await db.query('select public.workspace_save($1,$2) value',[version,payload])).rows[0].value;
 const original={crm:[{id:'same',nextAction:'original',log:[{t:'Note : originale'}]}]};const initial=await save(0,original);assert.equal(initial.revision,1);
 const sessionA=structuredClone(original),sessionB=structuredClone(original);
 sessionA.crm[0].nextAction='Action A';sessionA.crm[0].log.push({t:'Note : A'});
 sessionB.crm[0].nextAction='Action B';sessionB.crm[0].log.push({t:'Note : B'});
 const a=await save(1,sessionA);assert.equal(a.revision,2);
 await assert.rejects(save(1,sessionB),/workspace_conflict/);
 assert.equal((await db.query('select payload from public.workspace_states')).rows[0].payload.crm[0].nextAction,'Action A');
 assert.equal(sessionB.crm[0].log.at(-1).t,'Note : B');
 assert.equal((await save(1,sessionA)).replayed,true); // lost response does not duplicate a write
 await assert.rejects(save(2,{large:Array.from({length:490},()=> 'x'.repeat(4900))}),/payload_too_large/);
 assert.equal((await db.query('select revision from public.workspace_states')).rows[0].revision,2);
 await assert.rejects(db.query('update public.workspace_states set payload=$1',[sessionB]),/permission denied/);
 await db.query("select set_config('request.jwt.claim.sub',$1,false)",[other]);assert.equal((await db.query('select * from public.workspace_states')).rows.length,0);
 }finally{await db.close();}
});
