import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const root = new URL("../supabase/migrations/", import.meta.url);
const fixFile = "20261113150000_release_expired_reservations_engine_off.sql";
const files = [
  "20261006004359_create_profiles_and_rls.sql",
  "20261011221500_credit_ledger.sql",
  "20261022130000_enforce_reserved_search_quota.sql",
  "20261105014500_admin_role.sql",
  "20261107190000_search_jobs.sql",
  "20261107201000_search_job_ledger.sql",
  "20261107220000_search_job_runner_role.sql",
  "20261107233000_search_job_connect_test.sql",
  "20261108170000_search_job_places.sql",
  "20261113090000_search_job_scheduler.sql",
  fixFile
];
const sql = {};
for (const file of files) sql[file] = await readFile(new URL(file, root), "utf8");
const ada = "11111111-1111-4111-8111-111111111111";

const stub = `
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key, email text, raw_user_meta_data jsonb);
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end
$$;
grant usage on schema public to anon, authenticated;
grant usage on schema auth to anon, authenticated;
create schema if not exists vault;
create table vault.decrypted_secrets (name text primary key, decrypted_secret text);
create schema if not exists net;
create table net.calls (id bigint generated always as identity primary key, url text, body jsonb, headers jsonb);
create function net.http_post(url text, body jsonb, headers jsonb, timeout_milliseconds integer)
returns bigint language sql as $$
  insert into net.calls (url, body, headers) values (url, body, headers) returning id
$$;
`;

async function database() {
  const db = new PGlite();
  await db.exec(stub);
  for (const file of files) await db.exec(sql[file]);
  await db.exec(`insert into auth.users (id, email) values ('${ada}', 'ada@example.invalid')`);
  return db;
}

async function balance(db) {
  return (await db.query("select balance from public.credit_accounts where user_id = $1", [ada])).rows[0].balance;
}

test("le correctif ne touche ni jobs_enabled ni secret", () => {
  const fix = sql[fixFile];
  assert.doesNotMatch(fix, /jobs_enabled\s*=\s*true/);
  assert.doesNotMatch(fix, /update private\.search_job_settings/);
  assert.doesNotMatch(fix, /eyJ|sb_secret|sb_publishable|service_role/);
  assert.match(fix, /perform private\.expire_due_search_jobs\(\);/);
});

test("moteur éteint : une réservation expirée est libérée au tick, sans appel réseau", async () => {
  const db = await database();
  await db.exec("update private.search_job_settings set jobs_enabled = true");
  await db.exec(`select set_config('request.jwt.claim.sub', '${ada}', false)`);
  await db.exec("set role authenticated");
  await db.query("select public.enqueue_search_job($1, $2::jsonb)", [
    "expiry-laval-0001",
    JSON.stringify({ place_status: "supported", cityKey: "laval", quantity: 40 })
  ]);
  await db.exec("reset role");
  await db.exec("update private.search_job_settings set jobs_enabled = false");
  const reserved = await balance(db);
  // Réservation encore valide : rien ne bouge.
  assert.equal((await db.query("select private.search_scheduler_tick() as o")).rows[0].o, "inactif");
  assert.equal(await balance(db), reserved);
  await db.exec("update public.search_jobs set reserved_until = now() - interval '1 minute'");
  assert.equal((await db.query("select private.search_scheduler_tick() as o")).rows[0].o, "inactif");
  const job = (await db.query("select status, ledger_status, last_error from public.search_jobs")).rows[0];
  assert.deepEqual(job, { status: "failed", ledger_status: "released", last_error: "reservation_expired" });
  assert.equal(await balance(db), reserved + 9);
  assert.equal((await db.query("select status from public.usage_holds")).rows[0].status, "released");
  assert.equal((await db.query("select count(*)::int as n from net.calls")).rows[0].n, 0);
  // Rejouable : un second tick ne rembourse pas deux fois.
  await db.query("select private.search_scheduler_tick()");
  assert.equal(await balance(db), reserved + 9);
});
