import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

test('catalogue privé, recherche bornée et règlement serveur idempotent', async () => {
  const db = new PGlite();
  const uid='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', other='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  try {
    await db.exec(`create schema auth; create table auth.users(id uuid primary key,raw_user_meta_data jsonb);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create role anon; create role authenticated; create role service_role;
      grant usage on schema public,auth to authenticated,anon;`);
    for(const f of (await readdir(new URL('../supabase/migrations/',import.meta.url))).filter(f=>f.endsWith('.sql')).sort())
      await db.exec(await readFile(new URL('../supabase/migrations/'+f,import.meta.url),'utf8'));
    await db.query('insert into auth.users values($1,$3),($2,$3)',[uid,other,{}]);
    await db.exec("update private.overture_settings set enabled=true,complete=true,imported_at=now()");
    const feature={type:'Feature',id:'good',geometry:{type:'Point',coordinates:[-73.5673,45.5017]},properties:{names:{primary:'Published'},sources:[{license:'CC0-1.0',record_id:'original'}]}};
    await db.query("insert into private.overture_places values('2026-10-21.0','montreal','good',45.5017,-73.5673,ARRAY['construction'],'good',$1)",[feature]);
    await db.exec("insert into private.overture_places select release,city,'f7d4ae7d-7c80-45d2-bdcd-3722a8be2cc6',lat,lon,sectors,'bad',original from private.overture_places");
    await db.query("select set_config('request.jwt.claim.sub',$1,false)",[uid]);
    await db.exec('set role authenticated');
    await assert.rejects(db.query('insert into public.workspace_states(user_id,payload) values($1,$2)',[other,{}]),/workspace_owner_mismatch/);
    const rpc=async(name,params=[]) => (await db.query(`select public.${name}(${params.map((_,i)=>'$'+(i+1)).join(',')}) as value`,params)).rows[0].value;
    const receipt=n=>'debit_'+n.toString(16).padStart(24,'0');
    await assert.rejects(rpc('overture_begin',[receipt(1),'montreal','construction',41]),/perimetre_invalide/);
    await assert.rejects(db.query('select * from private.overture_places'),/permission denied/);
    const start=await rpc('overture_begin',[receipt(1),'montreal','construction',40]);
    assert.equal(start.amount,9); assert.equal(start.balance,191);
    assert.equal((await rpc('overture_begin',[receipt(1),'montreal','construction',40])).balance,191);
    await assert.rejects(rpc('overture_begin',[receipt(1),'laval','construction',40]),/parametres_differents/);
    const result=await rpc('overture_execute',[receipt(1)]);
    assert.equal(result.state,'complete'); assert.equal(result.features.length,1); assert.equal(result.charged,9);
    assert.equal(result.features[0].feature.properties.sources[0].record_id,'original');
    assert.equal((await rpc('overture_execute',[receipt(1)])).searches_used,1);
    await rpc('overture_begin',[receipt(2),'laval','construction',40]);
    const empty=await rpc('overture_execute',[receipt(2)]);
    assert.equal(empty.state,'valid_empty'); assert.equal(empty.balance,191); assert.equal(empty.charged,0);
    await rpc('overture_begin',[receipt(3),'montreal','construction',40]);
    await db.exec('reset role; update private.overture_settings set complete=false; set role authenticated');
    assert.equal((await rpc('overture_execute',[receipt(3)])).state,'partial');
    await db.exec('reset role; update private.overture_settings set complete=true; set role authenticated');
    await rpc('overture_begin',[receipt(4),'montreal','construction',40]);
    await db.exec("reset role; update public.overture_operations set expires_at=now()-interval '1 second' where status='reserved'; set role authenticated");
    assert.equal((await rpc('overture_account')).balance,191);
    assert.equal((await rpc('overture_execute',[receipt(4)])).reason,'reservation_expired');
    await rpc('overture_begin',[receipt(5),'montreal','construction',40]);
    await db.exec('reset role; update private.overture_settings set enabled=false; set role authenticated');
    assert.equal((await rpc('overture_execute',[receipt(5)])).state,'error');
    assert.equal((await rpc('overture_account')).balance,191);
    await db.query("select set_config('request.jwt.claim.sub',$1,false)",[other]);
    assert.equal((await db.query('select * from public.overture_operations')).rows.length,0);
    await assert.rejects(rpc('overture_execute',[receipt(1)]),/recu_invalide/);
    await assert.rejects(rpc('overture_admin',['enable',{}]),/permission denied/);
  } finally { await db.close(); }
});
