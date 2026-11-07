import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { createSearchJobLedger } from "../supabase/functions/_shared/search-job-ledger.mjs";

const root = new URL("../supabase/migrations/", import.meta.url);
const files = [
  "20261006004359_create_profiles_and_rls.sql",
  "20261011221500_credit_ledger.sql",
  "20261022130000_enforce_reserved_search_quota.sql",
  "20261105014500_admin_role.sql",
  "20261107190000_search_jobs.sql",
  "20261107201000_search_job_ledger.sql"
];
const sql = {};
for (const file of files) sql[file] = await readFile(new URL(file, root), "utf8");
const ledgerSql = sql["20261107201000_search_job_ledger.sql"];

const ada = "11111111-1111-4111-8111-111111111111";
const ced = "33333333-3333-4333-8333-333333333333";
const bea = "22222222-2222-4222-8222-222222222222";

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

function payload(quantity = 10) {
  return JSON.stringify({ place_status: "supported", cityKey: "laval", quantity });
}

async function database() {
  const db = new PGlite();
  await db.exec(stub);
  for (const file of files) await db.exec(sql[file]);
  await db.exec(`
    insert into auth.users (id, email) values
      ('${ada}', 'ada@example.invalid'),
      ('${ced}', 'ced@example.invalid'),
      ('${bea}', 'contact@klirline.ca')
  `);
  await db.exec(`insert into private.admins (user_id) values ('${bea}') on conflict (user_id) do nothing`);
  await db.exec("update private.search_job_settings set jobs_enabled = true");
  return db;
}

async function asUser(db, id) {
  await db.exec("reset role");
  await db.exec(`select set_config('request.jwt.claim.sub', '${id}', false)`);
  await db.exec("set role authenticated");
}

async function account(db, id) {
  await db.exec("reset role");
  const row = await db.query("select balance, searches_used from public.credit_accounts where user_id = $1", [id]);
  return row.rows[0];
}

async function enqueue(db, key, quantity = 10) {
  const row = await db.query("select public.enqueue_search_job($1, $2::jsonb) as row", [key, payload(quantity)]);
  return row.rows[0].row;
}

test("la migration C n'allume pas le drapeau et ne donne pas le règlement au client", () => {
  assert.match(ledgerSql, /jobs_enabled n'est pas allumé/);
  assert.doesNotMatch(ledgerSql, /set jobs_enabled = true/);
  assert.match(ledgerSql, /revoke all on function private\.reconcile_search_job\(uuid\) from public, anon, authenticated/);
  assert.match(ledgerSql, /reglement_serveur_requis/);
  assert.doesNotMatch(ledgerSql, /grant execute on function private\.reconcile_search_job/i);
});

test("deux comptes, l'admin et anon restent isolés, et le reçu v2 n'est pas réglé par le client", async () => {
  const db = await database();
  const flag = await db.query("select jobs_enabled from private.search_job_settings");
  assert.equal(flag.rows[0].jobs_enabled, true);

  await db.exec("reset role");
  await db.exec("update private.search_job_settings set jobs_enabled = false");
  await asUser(db, ada);
  await assert.rejects(enqueue(db, "receipt-c-0001"), /jobs_disabled/);
  await db.exec("reset role");
  await db.exec("update private.search_job_settings set jobs_enabled = true");

  await db.exec("set role anon");
  await assert.rejects(enqueue(db, "receipt-c-0001"), /permission denied/i);
  await assert.rejects(
    db.query("select private.reconcile_search_job($1::uuid)", ["11111111-1111-4111-8111-111111111111"]),
    /permission denied/i
  );

  await asUser(db, ada);
  const created = await enqueue(db, "receipt-c-0001", 10);
  assert.equal(created.created, true);
  assert.equal(created.ledger_status, "open");
  assert.equal(created.balance, 194);
  const replay = await enqueue(db, "receipt-c-0001", 10);
  assert.equal(replay.created, false);
  assert.equal(replay.id, created.id);
  let adaAccount = await account(db, ada);
  assert.equal(adaAccount.balance, 194);
  assert.equal(adaAccount.searches_used, 0);

  await asUser(db, ada);
  const receipt = await db.query("select ledger_receipt from public.search_jobs where id = $1", [created.id]);
  await assert.rejects(
    db.query("select public.settle_usage($1, 'complete')", [receipt.rows[0].ledger_receipt]),
    /reglement_serveur_requis/
  );
  await assert.rejects(
    db.query("select private.reconcile_search_job($1::uuid)", [created.id]),
    /permission denied/i
  );
  await assert.rejects(
    db.exec(`update public.search_jobs set status = 'succeeded' where id = '${created.id}'`),
    /permission denied/i
  );
  adaAccount = await account(db, ada);
  assert.equal(adaAccount.balance, 194);
  assert.equal(adaAccount.searches_used, 0);

  await asUser(db, ced);
  const hidden = await db.query("select id from public.search_jobs");
  assert.equal(hidden.rows.length, 0);
  await assert.rejects(
    db.query("select public.cancel_search_job($1::uuid)", [created.id]),
    /job_not_found/
  );

  await asUser(db, bea);
  const admin = await db.query("select public.is_admin() as admin");
  assert.equal(admin.rows[0].admin, true);
  const adminView = await db.query("select id from public.search_jobs");
  assert.equal(adminView.rows.length, 0);
  await assert.rejects(
    db.query("select public.cancel_search_job($1::uuid)", [created.id]),
    /job_not_found/
  );
  adaAccount = await account(db, ada);
  assert.equal(adaAccount.balance, 194);
});

test("réservation, collecte, règlement idempotent, vide, partiel, annulation et expiration", async () => {
  const db = await database();
  const ledger = createSearchJobLedger((text, params) => db.query(text, params));

  await asUser(db, ada);
  const success = await enqueue(db, "receipt-c-success", 30);
  assert.equal(success.balance, 192);
  await db.exec("reset role");
  const recorded = await ledger.record(success.id, "complete", 4);
  assert.equal(recorded.recorded, true);
  assert.equal(recorded.ledger_status, "open");
  let mid = await account(db, ada);
  assert.equal(mid.balance, 192);
  assert.equal(mid.searches_used, 0);
  const settled = await ledger.reconcile(success.id);
  assert.equal(settled.status, "succeeded");
  assert.equal(settled.ledger_status, "complete");
  assert.equal(settled.searches_used, 1);
  assert.equal(settled.balance, 192);
  const again = await ledger.reconcile(success.id);
  assert.equal(again.replayed, true);
  const after = await account(db, ada);
  assert.equal(after.balance, 192);
  assert.equal(after.searches_used, 1);
  const receipts = await db.query("select count(*)::int as n from public.credit_receipts where user_id = $1", [ada]);
  assert.equal(receipts.rows[0].n, 1);
  await assert.rejects(ledger.record(success.id, "empty", 0), /deja_regle|collection_figee/);

  await asUser(db, ada);
  const empty = await enqueue(db, "receipt-c-empty", 10);
  await db.exec("reset role");
  await ledger.record(empty.id, "empty", 0);
  const released = await ledger.reconcile(empty.id);
  assert.equal(released.ledger_status, "released");
  const emptyAgain = await ledger.reconcile(empty.id);
  assert.equal(emptyAgain.replayed, true);
  let now = await account(db, ada);
  assert.equal(now.balance, 192);
  assert.equal(now.searches_used, 1);

  await asUser(db, ada);
  const partial = await enqueue(db, "receipt-c-partial", 10);
  await db.exec("reset role");
  await ledger.record(partial.id, "partial", 0);
  await ledger.reconcile(partial.id);
  now = await account(db, ada);
  assert.equal(now.balance, 192);
  assert.equal(now.searches_used, 1);

  await asUser(db, ada);
  const crashed = await enqueue(db, "receipt-c-crash", 10);
  await db.exec("reset role");
  await ledger.record(crashed.id, "failed", 0);
  now = await account(db, ada);
  assert.equal(now.balance, 186);
  await ledger.reconcile(crashed.id);
  await ledger.reconcile(crashed.id);
  now = await account(db, ada);
  assert.equal(now.balance, 192);
  assert.equal(now.searches_used, 1);

  await asUser(db, ada);
  const live = await enqueue(db, "receipt-c-cancel", 10);
  const cancelled = await db.query("select public.cancel_search_job($1::uuid) as row", [live.id]);
  assert.equal(cancelled.rows[0].row.status, "cancelled");
  assert.equal(cancelled.rows[0].row.ledger_status, "released");
  const cancelAgain = await db.query("select public.cancel_search_job($1::uuid) as row", [live.id]);
  assert.equal(cancelAgain.rows[0].row.ledger_status, "released");
  now = await account(db, ada);
  assert.equal(now.balance, 192);

  await asUser(db, ada);
  const stale = await enqueue(db, "receipt-c-expire", 10);
  now = await account(db, ada);
  assert.equal(now.balance, 186);
  await db.exec("reset role");
  await db.exec(`update public.search_jobs set reserved_until = now() - interval '1 minute' where id = '${stale.id}'`);
  const expired = await ledger.reconcile(stale.id);
  assert.equal(expired.status, "failed");
  assert.equal(expired.last_error, "reservation_expired");
  const expiredAgain = await ledger.reconcile(stale.id);
  assert.equal(expiredAgain.replayed, true);
  now = await account(db, ada);
  assert.equal(now.balance, 192);
  assert.equal(now.searches_used, 1);
  assert.ok(now.balance >= 0);
});

test("un second job ne passe pas le solde sous zéro et l'ancien reçu reste réglable", async () => {
  const db = await database();
  await db.exec("reset role");
  await db.exec(`update public.credit_accounts set balance = 6 where user_id = '${ada}'`);
  await asUser(db, ada);
  const first = await enqueue(db, "receipt-c-tight", 10);
  assert.equal(first.balance, 0);
  await assert.rejects(enqueue(db, "receipt-c-tight-2", 10), /credits_insuffisants/);
  const jobs = await db.query("select count(*)::int as n from public.search_jobs");
  assert.equal(jobs.rows[0].n, 1);
  const tight = await account(db, ada);
  assert.equal(tight.balance, 0);
  assert.ok(tight.balance >= 0);

  const classic = "debit_" + "ab".repeat(12);
  await asUser(db, ada);
  await db.exec("reset role");
  await db.exec(`update public.credit_accounts set balance = 20 where user_id = '${ada}'`);
  await asUser(db, ada);
  const reserved = await db.query("select public.reserve_usage($1, 6, 'Recherche') as row", [classic]);
  assert.equal(reserved.rows[0].row.status, "open");
  const settled = await db.query("select public.settle_usage($1, 'complete') as row", [classic]);
  assert.equal(settled.rows[0].row.status, "complete");
  const repeated = await db.query("select public.settle_usage($1, 'complete') as row", [classic]);
  assert.equal(repeated.rows[0].row.searches_used, settled.rows[0].row.searches_used);
  const finalAccount = await account(db, ada);
  assert.equal(finalAccount.balance, 14);
  assert.ok(finalAccount.balance >= 0);
});
