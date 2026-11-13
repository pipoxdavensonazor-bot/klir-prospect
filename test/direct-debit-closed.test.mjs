import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const migration = await readFile(new URL("../supabase/migrations/20261113160000_revoke_direct_debit_rpcs.sql", import.meta.url), "utf8");
const auth = await readFile(new URL("../src/auth.js", import.meta.url), "utf8");
const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");

test("la migration ferme les RPC de débit direct sans rien rouvrir", () => {
  for (const fn of ["reserve_usage", "settle_usage", "overture_begin", "overture_execute"]) {
    assert.match(migration, new RegExp(`revoke execute on function public\\.${fn}\\([^)]*\\) from public, anon, authenticated`), fn);
  }
  assert.doesNotMatch(migration, /\bgrant\b/i);
  assert.doesNotMatch(migration, /jobs_enabled\s*=\s*true|update public\.credit_accounts|eyJ|sb_secret/);
});

test("le navigateur ne connaît plus que la file serveur pour rechercher", () => {
  assert.doesNotMatch(auth, /rpc\("(reserve_usage|settle_usage|overture_begin|overture_execute)"/);
  assert.doesNotMatch(auth, /searchOverture|reserveUsage|settleUsage/);
  assert.match(auth, /functions\.invoke\("search-jobs"/);
  assert.match(auth, /from\("search_job_places"\)/);
  assert.match(auth, /place_status: "supported"/);
  assert.doesNotMatch(app, /reserveServerUsage|settleServerUsage|runOvertureSearch|KlirSources\.osm\.search\(/);
});

test("toutes migrations appliquées : authenticated ne peut plus débiter directement, la file reste ouverte", async () => {
  const db = new PGlite();
  await db.exec(`create schema auth; create table auth.users(id uuid primary key,raw_user_meta_data jsonb);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create role anon; create role authenticated; create role service_role;
    grant usage on schema public,auth to authenticated,anon;`);
  const dir = new URL("../supabase/migrations/", import.meta.url);
  for (const f of (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort()) {
    await db.exec(await readFile(new URL(f, dir), "utf8"));
  }
  const can = async (signature) => (await db.query(
    "select has_function_privilege('authenticated', $1::regprocedure, 'execute') as ok", [signature]
  )).rows[0].ok;
  for (const signature of ["public.reserve_usage(text,integer,text)", "public.settle_usage(text,text)", "public.overture_begin(text,text,text,integer)", "public.overture_execute(text)"]) {
    assert.equal(await can(signature), false, signature);
  }
  assert.equal(await can("public.enqueue_search_job(text,jsonb)"), true);
  assert.equal(await can("public.read_credit_account()"), true);
});
