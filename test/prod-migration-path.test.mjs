import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const dir = new URL("../supabase/migrations/", import.meta.url);
const all = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
const PROD_SKIP = new Set(["20261103010000_stripe_test_preview.sql", "20261107233000_search_job_connect_test.sql"]);
const roleFile = "20261113180000_runner_prod_role_and_scheduler_allowlist.sql";

async function boot(files) {
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

test("le fichier du rôle Prod ne contient aucun mot de passe", async () => {
  const text = await readFile(new URL(roleFile, dir), "utf8");
  assert.doesNotMatch(text, /password|scram-sha|encrypted/i);
  assert.match(text, /create role klir_job_runner_prod login noinherit/);
});

test("parcours Prod : toutes les migrations sans connect_test ni stripe_test passent", async () => {
  const db = await boot(all.filter((f) => !PROD_SKIP.has(f)));
  assert.equal((await one(db, "select count(*)::int n from pg_roles where rolname='klir_job_connect_test'")).n, 0);
  const role = await one(db, "select rolcanlogin, rolinherit, rolsuper, rolbypassrls, rolpassword is null as nopw from pg_authid where rolname='klir_job_runner_prod'");
  assert.deepEqual(role, { rolcanlogin: true, rolinherit: false, rolsuper: false, rolbypassrls: false, nopw: true });
  assert.equal((await one(db, "select pg_has_role('klir_job_runner_prod','klir_job_runner','MEMBER') ok")).ok, true);
  // Droits minimaux : rien en direct, seulement via SET ROLE klir_job_runner.
  for (const [obj, kind] of [["public.credit_accounts", "table"], ["public.search_jobs", "table"], ["private.search_catalog_places", "table"]]) {
    assert.equal((await one(db, `select has_table_privilege('klir_job_runner_prod', $1, 'select') ok`, [obj])).ok, false, obj);
  }
  for (const fn of ["public.reserve_usage(text,integer,text)", "public.settle_usage(text,text)", "public.enqueue_search_job(text,jsonb)"]) {
    assert.equal((await one(db, "select has_function_privilege('klir_job_runner_prod', $1::regprocedure, 'execute') ok", [fn])).ok, false, fn);
  }
  assert.equal((await one(db, "select has_function_privilege('klir_job_runner', 'private.diagnose_search_job_connection()'::regprocedure, 'execute') ok")).ok, true);
  assert.equal((await one(db, "select has_function_privilege('authenticated', 'private.diagnose_search_job_connection()'::regprocedure, 'execute') ok")).ok, false);
  assert.equal((await one(db, "select private.diagnose_search_job_connection() v")).v, false);
  // Le parcours ciblé Test reste inutilisable en Prod : seule la session klir_job_connect_test passe.
  const claim = await one(db, "select pg_get_functiondef('private.claim_authorized_test_job(uuid)'::regprocedure) d");
  assert.match(claim.d, /session_user::text <> 'klir_job_connect_test'/);
});

test("planificateur : liste blanche des deux runners, inactif moteur éteint", async () => {
  const db = await boot(all.filter((f) => !PROD_SKIP.has(f)));
  const tick = async () => (await one(db, "select private.search_scheduler_tick() o")).o;
  assert.equal(await tick(), "inactif");
  const key = "x".repeat(40);
  await db.query("update private.search_scheduler_settings set enabled=true, runner_url=$1, gateway_key=$2", ["https://cbklwmjudobqwbkbxqgy.supabase.co/functions/v1/search-job-runner", key]);
  assert.equal((await one(db, "select jobs_enabled from private.search_job_settings")).jobs_enabled, false);
  assert.equal(await tick(), "moteur_off");
  await db.query("update private.search_scheduler_settings set runner_url=$1", ["https://pwakjxjjxswdjsapsbxn.supabase.co/functions/v1/search-job-runner"]);
  assert.equal(await tick(), "moteur_off");
  await db.query("update private.search_scheduler_settings set runner_url=$1", ["https://abcdefghijklmnopqrst.supabase.co/functions/v1/search-job-runner"]);
  assert.equal(await tick(), "projet_refuse");
  const src = await one(db, "select pg_get_functiondef('private.search_scheduler_tick()'::regprocedure) d");
  assert.doesNotMatch(src.d, /production_refusee/);
});

test("parcours Test : toutes les migrations passent, connect_test garde ses révocations", async () => {
  const db = await boot(all);
  assert.equal((await one(db, "select has_table_privilege('klir_job_connect_test','private.search_catalog_places','select') ok")).ok, false);
  assert.equal((await one(db, "select has_function_privilege('klir_job_connect_test','private.search_catalog_lookup(text,text,integer)'::regprocedure,'execute') ok")).ok, false);
});
