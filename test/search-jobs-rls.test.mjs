import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { createSearchJobStore } from "../supabase/functions/_shared/search-job-store.mjs";

const root = new URL("../supabase/migrations/", import.meta.url);
const profilesSql = await readFile(new URL("20261006004359_create_profiles_and_rls.sql", root), "utf8");
const adminSql = await readFile(new URL("20261105014500_admin_role.sql", root), "utf8");
const jobsSql = await readFile(new URL("20261107190000_search_jobs.sql", root), "utf8");

const ada = "11111111-1111-4111-8111-111111111111";
const bea = "22222222-2222-4222-8222-222222222222";
const payload = JSON.stringify({ place_status: "supported", cityKey: "laval" });

const stub = `
create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key,
  email text,
  raw_user_meta_data jsonb
);
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
end
$$;
grant usage on schema public to anon, authenticated;
grant usage on schema auth to anon, authenticated;
`;

async function database() {
  const db = new PGlite();
  await db.exec(stub);
  await db.exec(profilesSql);
  await db.exec(adminSql);
  await db.exec(jobsSql);
  await db.exec(`insert into auth.users (id, email) values ('${ada}', 'ada@example.invalid'), ('${bea}', 'contact@klirline.ca')`);
  return db;
}

async function asUser(db, id) {
  await db.exec("reset role");
  await db.exec(`select set_config('request.jwt.claim.sub', '${id}', false)`);
  await db.exec("set role authenticated");
}

test("le drapeau serveur est éteint et la migration ne débite rien", async () => {
  assert.match(jobsSql, /jobs_enabled boolean not null default false/);
  assert.doesNotMatch(jobsSql, /reserve_usage|settle_usage|overpass|service_role|secret/i);
  assert.match(jobsSql, /revoke all on table public\.search_jobs from public, anon, authenticated/);
  assert.match(jobsSql, /grant select on table public\.search_jobs to authenticated/);
  assert.doesNotMatch(jobsSql, /grant\s+(insert|update|delete|all)\s+on table public\.search_jobs/i);
  const db = await database();
  const flag = await db.query("select jobs_enabled from private.search_job_settings");
  assert.equal(flag.rows[0].jobs_enabled, false);
});

test("anon est refusé, A et B sont isolés, et l'admin ne lit pas le job d'autrui", async () => {
  const db = await database();
  await db.exec("set role anon");
  await assert.rejects(db.query("select id from public.search_jobs"), /permission denied/i);
  await assert.rejects(
    db.query("select public.enqueue_search_job($1, $2::jsonb)", ["receipt-job-1", payload]),
    /permission denied/i
  );

  await asUser(db, ada);
  await assert.rejects(
    db.query("select public.enqueue_search_job($1, $2::jsonb)", ["receipt-job-1", payload]),
    /jobs_disabled/
  );
  await db.exec("reset role");
  await db.exec("update private.search_job_settings set jobs_enabled = true, rate_limit_per_minute = 2");
  await asUser(db, ada);
  const created = await db.query("select public.enqueue_search_job($1, $2::jsonb) as row", ["receipt-job-1", payload]);
  assert.equal(created.rows[0].row.created, true);
  assert.equal(created.rows[0].row.status, "queued");
  const same = await db.query("select public.enqueue_search_job($1, $2::jsonb) as row", ["receipt-job-1", payload]);
  assert.equal(same.rows[0].row.created, false);
  assert.equal(same.rows[0].row.id, created.rows[0].row.id);
  const visible = await db.query("select id, user_id from public.search_jobs");
  assert.equal(visible.rows.length, 1);
  await assert.rejects(
    db.exec(`update public.search_jobs set status = 'succeeded' where id = '${created.rows[0].row.id}'`),
    /permission denied/i
  );
  await assert.rejects(
    db.query("select public.enqueue_search_job($1, $2::jsonb)", ["receipt-job-2", JSON.stringify({ place_status: "unsupported" })]),
    /place_rejected/
  );

  await db.exec("reset role");
  await db.exec(`insert into private.admins (user_id) values ('${bea}') on conflict (user_id) do nothing`);
  await asUser(db, bea);
  const foreign = await db.query("select id from public.search_jobs");
  assert.equal(foreign.rows.length, 0);
  const admin = await db.query("select public.is_admin() as admin");
  assert.equal(admin.rows[0].admin, true);
  await assert.rejects(
    db.query("select public.cancel_search_job($1::uuid)", [created.rows[0].row.id]),
    /job_not_found/
  );

  await asUser(db, ada);
  const cancelled = await db.query("select public.cancel_search_job($1::uuid) as row", [created.rows[0].row.id]);
  assert.equal(cancelled.rows[0].row.status, "cancelled");
  const again = await db.query("select public.cancel_search_job($1::uuid) as row", [created.rows[0].row.id]);
  assert.equal(again.rows[0].row.status, "cancelled");
  assert.equal(again.rows[0].row.id, cancelled.rows[0].row.id);
});

test("le port SQL enqueue et annule via une requête injectée", async () => {
  const db = await database();
  await db.exec("update private.search_job_settings set jobs_enabled = true");
  await asUser(db, ada);
  const store = createSearchJobStore((sql, params) => db.query(sql, params));
  const created = await store.enqueue("receipt-port-1", { place_status: "supported", cityKey: "laval" });
  assert.equal(created.created, true);
  const again = await store.enqueue("receipt-port-1", { place_status: "supported", cityKey: "laval" });
  assert.equal(again.created, false);
  assert.equal(again.id, created.id);
  const own = await store.readOwn();
  assert.equal(own.length, 1);
  const cancelled = await store.cancel(created.id);
  assert.equal(cancelled.status, "cancelled");
  await asUser(db, bea);
  const foreign = await store.readOwn();
  assert.equal(foreign.length, 0);
});

test("le plafond minute refuse une deuxième clé sans dupliquer la première", async () => {
  const db = await database();
  await db.exec("update private.search_job_settings set jobs_enabled = true, rate_limit_per_minute = 1");
  await asUser(db, ada);
  await db.query("select public.enqueue_search_job($1, $2::jsonb)", ["receipt-job-1", payload]);
  await db.query("select public.enqueue_search_job($1, $2::jsonb)", ["receipt-job-1", payload]);
  await assert.rejects(
    db.query("select public.enqueue_search_job($1, $2::jsonb)", ["receipt-job-2", payload]),
    /rate_limited/
  );
  await db.exec("reset role");
  const rows = await db.query("select count(*)::int as n from public.search_jobs");
  assert.equal(rows.rows[0].n, 1);
});
