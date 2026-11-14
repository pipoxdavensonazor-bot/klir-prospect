import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const dir = new URL("../supabase/migrations/", import.meta.url);
const PROD_SKIP = new Set(["20261103010000_stripe_test_preview.sql", "20261107233000_search_job_connect_test.sql"]);
const files = (await readdir(dir)).filter((f) => f.endsWith(".sql") && !PROD_SKIP.has(f)).sort();
const lift = await readFile(new URL("20261114010000_lift_monthly_search_cap.sql", dir), "utf8");

async function boot() {
  const db = new PGlite();
  await db.exec(`create schema auth; create table auth.users(id uuid primary key,raw_user_meta_data jsonb);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create role anon; create role authenticated; create role service_role;
    grant usage on schema public,auth to authenticated,anon;`);
  for (const f of files) {
    try { await db.exec(await readFile(new URL(f, dir), "utf8")); }
    catch (error) { throw new Error(`${f}: ${error.message}`); }
  }
  return db;
}
const one = async (db, sql, params) => (await db.query(sql, params)).rows[0];
const rid = (i) => "debit_" + i.toString(16).padStart(24, "0");
const ada = "11111111-1111-1111-1111-111111111111";
const bea = "22222222-2222-2222-2222-222222222222";

test("la migration ne contient plus de plafond mensuel fixe", () => {
  assert.doesNotMatch(lift, /quota_mensuel/);
  assert.doesNotMatch(lift, />=\s*10\b/);
  assert.match(lift, /per_hour integer not null default 30/);
  assert.match(lift, /per_day integer not null default 200/);
});

test("limites lues à un seul endroit : pas de plafond mensuel, 30/heure, 200/jour", async () => {
  const db = await boot();
  try {
    assert.deepEqual((await one(db, "select private.search_limits() v")).v, { monthly_cap: null, per_hour: 30, per_day: 200 });
    for (const fn of ["private.search_limits()", "private.check_search_rate(uuid)"]) {
      assert.equal((await one(db, "select has_function_privilege('authenticated', $1::regprocedure, 'execute') ok", [fn])).ok, false, fn);
    }
    assert.equal((await one(db, "select has_function_privilege('authenticated', 'public.reserve_usage(text,integer,text)'::regprocedure, 'execute') ok")).ok, false);
    assert.equal((await one(db, "select has_table_privilege('authenticated', 'private.search_rate_limits', 'select') ok")).ok, false);
  } finally { await db.close(); }
});

test("plus de 10 recherches complètes dans le mois : seul le solde limite", async () => {
  const db = await boot();
  try {
    await db.query("insert into auth.users(id,raw_user_meta_data) values ($1,'{}'),($2,'{}')", [ada, bea]);
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [ada]);
    for (let i = 1; i <= 15; i++) {
      await db.query("select public.reserve_usage($1,6,'Recherche')", [rid(i)]);
      await db.query("select private.apply_usage_outcome($1,$2,'complete')", [ada, rid(i)]);
    }
    const acc = await one(db, "select balance, searches_used from public.credit_accounts where user_id=$1", [ada]);
    assert.deepEqual(acc, { balance: 200 - 15 * 6, searches_used: 15 });
    // Ancienne réservation au-delà de 10 confirmations : se confirme maintenant.
    await db.query("update public.credit_accounts set balance=12 where user_id=$1", [ada]);
    await db.query("select public.reserve_usage($1,6,'Recherche')", [rid(16)]);
    await db.query("select public.reserve_usage($1,6,'Recherche')", [rid(17)]);
    await assert.rejects(db.query("select public.reserve_usage($1,6,'Recherche')", [rid(18)]), /credits_insuffisants/);
    // L'autre compte reste indépendant.
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [bea]);
    const other = await one(db, "select public.reserve_usage($1,6,'Recherche') v", [rid(1)]);
    assert.equal(other.v.balance, 194);
  } finally { await db.close(); }
});

test("garde-fou anti-abus : 30 par heure glissante, 200 par jour glissant, réglables", async () => {
  const db = await boot();
  try {
    await db.query("insert into auth.users(id,raw_user_meta_data) values ($1,'{}')", [ada]);
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [ada]);
    await db.query("update public.credit_accounts set balance=100000 where user_id=$1", [ada]).catch(() => {});
    await db.query("insert into public.credit_accounts(user_id,balance,usage_period,searches_used) values ($1,100000,private.toronto_period(),0) on conflict (user_id) do update set balance=100000", [ada]);
    for (let i = 1; i <= 30; i++) {
      await db.query("select public.reserve_usage($1,6,'Recherche')", [rid(i)]);
      if (i % 2) await db.query("select private.apply_usage_outcome($1,$2,'release')", [ada, rid(i)]);
    }
    await assert.rejects(db.query("select public.reserve_usage($1,6,'Recherche')", [rid(31)]), /limite_recherches_heure/);
    assert.equal((await one(db, "select count(*)::int n from public.usage_holds where user_id=$1", [ada])).n, 30);
    // Vieillir ces réservations de 2 h : l'heure est libre, le jour compte toujours.
    await db.query("update public.usage_holds set created_at=now()-interval '2 hours' where user_id=$1", [ada]);
    await db.query("update private.search_rate_limits set per_day=31");
    await db.query("select public.reserve_usage($1,6,'Recherche')", [rid(31)]);
    await assert.rejects(db.query("select public.reserve_usage($1,6,'Recherche')", [rid(32)]), /limite_recherches_jour/);
    // Au-delà de 24 h, plus rien ne compte.
    await db.query("update public.usage_holds set created_at=now()-interval '25 hours' where user_id=$1", [ada]);
    await db.query("select public.reserve_usage($1,6,'Recherche')", [rid(32)]);
    await assert.rejects(db.query("update private.search_rate_limits set per_hour=50, per_day=40"), /search_rate_limits_order/);
  } finally { await db.close(); }
});
