import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

const root = new URL("../supabase/migrations/", import.meta.url);
const beforeFiles = [
  "20261006004359_create_profiles_and_rls.sql",
  "20261011221500_credit_ledger.sql",
  "20261022130000_enforce_reserved_search_quota.sql",
  "20261105014500_admin_role.sql",
  "20261107190000_search_jobs.sql"
];
const ledgerFile = "20261107201000_search_job_ledger.sql";
const runtimeFile = "20261107220000_search_job_runner_role.sql";
const ada = "11111111-1111-4111-8111-111111111111";

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
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin;
  end if;
end
$$;
grant usage on schema public to anon, authenticated, service_role;
grant usage on schema auth to anon, authenticated, service_role;
`;

async function sql(name) {
  return readFile(new URL(name, root), "utf8");
}

async function grantees(query, name) {
  const result = await query(`
    select coalesce(role_name.rolname, 'PUBLIC') as grantee
    from pg_proc as proc
    join pg_namespace as namespace on namespace.oid = proc.pronamespace
    join lateral aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) as entry on true
    left join pg_roles as role_name on role_name.oid = entry.grantee
    where namespace.nspname = 'public'
      and proc.proname = $1
      and entry.privilege_type = 'EXECUTE'
    order by 1
  `, [name]);
  return result.rows.map((row) => row.grantee).join(",");
}

const harden = `
revoke all on function public.reserve_usage(text, integer, text) from public, anon, authenticated;
revoke all on function public.settle_usage(text, text) from public, anon, authenticated;
grant execute on function public.reserve_usage(text, integer, text) to service_role;
grant execute on function public.settle_usage(text, text) to service_role;
`;

async function prepare(exec) {
  await exec(stub);
  for (const file of beforeFiles) await exec(await sql(file));
  await exec(`
    insert into auth.users (id, email) values ('${ada}', 'ada@example.invalid')
  `);
  await exec(harden);
}

test("la migration runtime n'accorde pas reserve_usage ni settle_usage", async (t) => {
  try {
    await access(new URL(runtimeFile, root));
  } catch {
    t.skip("Fichier runtime absent de cette branche. Le contrôle s'exécute sur la branche qui le contient.");
    return;
  }
  const text = await sql(runtimeFile);
  assert.doesNotMatch(text, /grant execute on function public\.settle_usage/i);
  assert.doesNotMatch(text, /grant execute on function public\.reserve_usage/i);
  assert.match(text, /revoke all on function public\.settle_usage\(text, text\) from klir_job_api, klir_job_runner/);
  assert.match(text, /nologin/);
  assert.doesNotMatch(text, /\blogin\b/i);
});

test("une base durcie garde ses ACL de facturation après C, et le reçu ancien passe par service_role", async () => {
  const db = new PGlite();
  await prepare((text) => db.exec(text));
  const before = {
    reserve: await grantees((text, params) => db.query(text, params), "reserve_usage"),
    settle: await grantees((text, params) => db.query(text, params), "settle_usage"),
    admin: await grantees((text, params) => db.query(text, params), "is_admin")
  };
  assert.equal(before.settle.includes("authenticated"), false);
  assert.equal(before.reserve.includes("authenticated"), false);
  assert.equal(before.settle.includes("service_role"), true);
  assert.equal(before.admin.includes("authenticated"), true);

  await db.exec(await sql(ledgerFile));
  await db.exec("update private.search_job_settings set jobs_enabled = true");

  const after = {
    reserve: await grantees((text, params) => db.query(text, params), "reserve_usage"),
    settle: await grantees((text, params) => db.query(text, params), "settle_usage"),
    admin: await grantees((text, params) => db.query(text, params), "is_admin")
  };
  assert.equal(after.reserve, before.reserve);
  assert.equal(after.settle, before.settle);
  assert.equal(after.admin, before.admin);
  for (const role of ["authenticated", "anon", "public"]) {
    for (const fn of ["public.reserve_usage(text, integer, text)", "public.settle_usage(text, text)"]) {
      const privilege = await db.query("select has_function_privilege($1, $2, 'execute') as allowed", [role, fn]);
      assert.equal(privilege.rows[0].allowed, false, `${role} ${fn}`);
    }
  }

  const classic = `debit_${"ab".repeat(12)}`;
  await db.exec("reset role");
  await db.exec(`select set_config('request.jwt.claim.sub', '${ada}', false)`);
  await db.exec("set role service_role");
  const reserved = await db.query("select public.reserve_usage($1, 6, 'Recherche') as row", [classic]);
  assert.equal(reserved.rows[0].row.status, "open");
  const settled = await db.query("select public.settle_usage($1, 'complete') as row", [classic]);
  assert.equal(settled.rows[0].row.status, "complete");
  const replay = await db.query("select public.settle_usage($1, 'complete') as row", [classic]);
  assert.equal(replay.rows[0].row.searches_used, settled.rows[0].row.searches_used);

  await db.exec("reset role");
  await db.exec(`select set_config('request.jwt.claim.sub', '${ada}', false)`);
  await db.exec("set role authenticated");
  await assert.rejects(
    db.query("select public.settle_usage($1, 'release')", [classic]),
    /permission denied/i
  );
  await assert.rejects(
    db.query("select public.reserve_usage($1, 6, 'Recherche')", [`debit_${"cd".repeat(12)}`]),
    /permission denied/i
  );
  const queued = await db.query(
    "select public.enqueue_search_job($1, $2::jsonb) as row",
    ["acl-job-0001", JSON.stringify({ place_status: "supported", cityKey: "laval", quantity: 10 })]
  );
  assert.equal(queued.rows[0].row.created, true);
  assert.equal(queued.rows[0].row.ledger_status, "open");
});

test("PostgreSQL durci : C ne rouvre pas la facturation, expiration et règlement ne se croisent qu'une fois", { timeout: 60_000 }, async (t) => {
  let pg;
  try {
    pg = await import("pg");
  } catch {
    t.skip("Module pg absent. Le contrôle multi-connexion n'a pas été exécuté.");
    return;
  }
  const admin = new pg.default.Client({ host: "/var/run/postgresql", database: "postgres" });
  try {
    await admin.connect();
  } catch (error) {
    t.skip(`PostgreSQL local indisponible (${error.code || "connexion"}). Le contrôle multi-connexion n'a pas été exécuté.`);
    return;
  }
  const who = await admin.query("select rolsuper from pg_roles where rolname = current_user");
  if (who.rows[0].rolsuper !== true) {
    await admin.end();
    t.skip("Le rôle du socket n'est pas propriétaire. Le contrôle multi-connexion n'a pas été exécuté.");
    return;
  }
  const name = `klir_acl_${process.pid.toString(16).slice(0, 6)}`;
  await admin.query(`create database ${name}`);
  const db = new pg.default.Client({ host: "/var/run/postgresql", database: name });
  const other = new pg.default.Client({ host: "/var/run/postgresql", database: name });
  try {
    await db.connect();
    await other.connect();
    await prepare((text) => db.query(text));
    const before = await grantees((text, params) => db.query(text, params), "settle_usage");
    await db.query(await sql(ledgerFile));
    await db.query("update private.search_job_settings set jobs_enabled = true");
    const after = await grantees((text, params) => db.query(text, params), "settle_usage");
    assert.equal(after, before);
    assert.equal(after.includes("authenticated"), false);
    assert.equal(after.includes("service_role"), true);
    try {
      await access(new URL(runtimeFile, root));
      const { splitSql } = await import("../tools/search-job-local-db.mjs");
      for (const statement of splitSql(await sql(runtimeFile))) await db.query(statement);
      const afterRuntime = await grantees((text, params) => db.query(text, params), "settle_usage");
      const reserveRuntime = await grantees((text, params) => db.query(text, params), "reserve_usage");
      assert.equal(afterRuntime, before);
      assert.equal(reserveRuntime.includes("authenticated"), false);
      assert.equal(reserveRuntime.includes("service_role"), true);
      const runner = await db.query("select rolcanlogin, rolsuper from pg_roles where rolname = 'klir_job_runner'");
      assert.equal(runner.rows[0].rolcanlogin, false);
      assert.equal(runner.rows[0].rolsuper, false);
    } catch (error) {
      if (error && error.code === "ENOENT") {
        /* branche C : pas de migration runtime */
      } else {
        throw error;
      }
    }

    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [ada]);
    await db.query("set role authenticated");
    const created = await db.query(
      "select public.enqueue_search_job($1, $2::jsonb) as row",
      ["acl-pg-expire", JSON.stringify({ place_status: "supported", cityKey: "laval", quantity: 10 })]
    );
    assert.equal(created.rows[0].row.created, true);
    await assert.rejects(
      db.query("select public.settle_usage($1, 'release')", [`debit_${"ef".repeat(12)}`]),
      /permission denied/i
    );
    await db.query("reset role");
    await db.query("update public.search_jobs set reserved_until = now() - interval '1 minute' where id = $1", [created.rows[0].row.id]);
    await db.query("begin");
    await db.query("select private.reconcile_search_job($1::uuid)", [created.rows[0].row.id]);
    const waiting = other.query("select private.record_search_collection($1::uuid, 'complete', 1)", [created.rows[0].row.id]);
    let settled = false;
    const tracked = waiting.finally(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(settled, false, "la seconde connexion n'a pas attendu le verrou");
    await db.query("commit");
    await assert.rejects(tracked, /job_clos/);
    const account = await db.query("select balance from public.credit_accounts where user_id = $1", [ada]);
    assert.equal(account.rows[0].balance, 200);
    const replay = await db.query("select private.reconcile_search_job($1::uuid) as row", [created.rows[0].row.id]);
    assert.equal(replay.rows[0].row.replayed, true);
    assert.equal(account.rows[0].balance, 200);
  } finally {
    try { await db.query("rollback"); } catch { /* pas de transaction */ }
    await db.end().catch(() => {});
    await other.end().catch(() => {});
    await admin.query(`drop database if exists ${name} with (force)`);
    await admin.end();
  }
});
